from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from config import settings

STATUS_QUEUED = 10
STATUS_RUNNING = 20
STATUS_FAILED = 30
STATUS_COMPLETED = 40

STATUS_TEXT = {
    STATUS_QUEUED: "QUEUED",
    STATUS_RUNNING: "RUNNING",
    STATUS_FAILED: "FAILED",
    STATUS_COMPLETED: "COMPLETED",
}

STAGE_UPLOAD = "upload"
STAGE_DONE = "done"

_DEFAULT_STAGE_ORDER = [
    STAGE_UPLOAD,
    "features",
    "matching",
    "sparse",
    "dense",
    "mesh",
    "texture",
    "glb",
    "tiles",
    STAGE_DONE,
]

def _now_iso() -> str:
    return datetime.now(UTC).isoformat()

def _state_path(uuid: str) -> Path:
    return settings.INDOOR_WORKSPACE_DIR / uuid / "state.json"

def _manifest_path(uuid: str) -> Path:
    return settings.INDOOR_WORKSPACE_DIR / uuid / "manifest.json"

def _upload_dir(uuid: str) -> Path:
    return settings.INDOOR_UPLOAD_DIR / uuid / "images"

def _workspace_dir(uuid: str) -> Path:
    return settings.INDOOR_WORKSPACE_DIR / uuid

def _output_dir(uuid: str) -> Path:
    return settings.INDOOR_OUTPUT_DIR / uuid

def _log_path(uuid: str) -> Path:
    return settings.INDOOR_LOG_DIR / f"{uuid}.log"

def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}

def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def _merge_task(uuid: str) -> dict[str, Any]:
    manifest = _read_json(_manifest_path(uuid))
    state = _read_json(_state_path(uuid))
    merged = {
        "uuid": uuid,
        "pipeline": "indoor",
        "status": STATUS_QUEUED,
        "status_text": STATUS_TEXT[STATUS_QUEUED],
        "stage": STAGE_UPLOAD,
        "progress": 0.0,
    }
    merged.update(manifest)
    merged.update(state)
    status = int(merged.get("status") or STATUS_QUEUED)
    merged["status"] = status
    merged["status_text"] = STATUS_TEXT.get(status, "UNKNOWN")
    return merged

def _task_uuids() -> list[str]:
    if not settings.INDOOR_WORKSPACE_DIR.exists():
        return []
    return sorted(
        {
            path.parent.name
            for path in settings.INDOOR_WORKSPACE_DIR.glob("*/manifest.json")
        }
    )

def _sort_key(task: dict[str, Any]) -> tuple[float, str]:
    raw = task.get("date_created")
    if isinstance(raw, (int, float)):
        return (float(raw), task["uuid"])
    return (0.0, task["uuid"])

def _safe_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None

def _validate_capture_date(value: str | None) -> str | None:
    value = _safe_text(value)
    if value is None:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(400, "capture_date YYYY-MM-DD formatında olmalı") from exc
    return value

def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True

def _patch_state(uuid: str, **updates: Any) -> dict[str, Any]:
    current = _merge_task(uuid)
    current.update(updates)
    current["status_text"] = STATUS_TEXT.get(int(current.get("status") or STATUS_QUEUED), "UNKNOWN")
    current["pipeline"] = "indoor"
    _write_json(_state_path(uuid), current)
    return current

def _task_exists(uuid: str) -> bool:
    return _manifest_path(uuid).exists() or _state_path(uuid).exists()

def _docker_compose_command(uuid: str) -> list[str]:
    docker = shutil.which("docker") or shutil.which("docker.exe")
    if not docker:
        raise RuntimeError("docker komutu bulunamadı")

    manifest_rel = _manifest_path(uuid).relative_to(settings.PROJECT_DIR).as_posix()
    return [
        docker,
        "compose",
        "--profile",
        "indoor",
        "-f",
        str(settings.DOCKER_DIR / "docker-compose.yml"),
        "run",
        "--rm",
        "-T",
        "indoor-recon",
        "python3",
        "/app/scripts/run_indoor_job.py",
        f"/workspace/{manifest_rel}",
    ]

def _reconcile_running_tasks() -> None:
    changed = False
    for uuid in _task_uuids():
        task = _merge_task(uuid)
        if task.get("status") != STATUS_RUNNING:
            continue
        if _pid_alive(int(task.get("launcher_pid") or 0)):
            return
        if task.get("finished_at"):
            continue
        tileset = _output_dir(uuid) / "tiles" / "tileset.json"
        if tileset.exists():
            _patch_state(
                uuid,
                status=STATUS_COMPLETED,
                stage=STAGE_DONE,
                progress=100.0,
                finished_at=_now_iso(),
                error_summary=None,
            )
        else:
            _patch_state(
                uuid,
                status=STATUS_FAILED,
                stage=task.get("stage") or "failed",
                finished_at=_now_iso(),
                error_summary=task.get("error_summary") or "Indoor runner beklenmedik şekilde durdu",
            )
        changed = True
    if changed:
        return

def dispatch_next_queued() -> None:
    _reconcile_running_tasks()
    tasks = [_merge_task(uuid) for uuid in _task_uuids()]
    if any(task.get("status") == STATUS_RUNNING and _pid_alive(int(task.get("launcher_pid") or 0)) for task in tasks):
        return

    queued = [task for task in tasks if task.get("status") == STATUS_QUEUED]
    if not queued:
        return

    queued.sort(key=_sort_key)
    next_task = queued[0]
    uuid = next_task["uuid"]
    log_path = _log_path(uuid)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        command = _docker_compose_command(uuid)
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"[{_now_iso()}] dispatch: {' '.join(command)}\n")
            log_file.flush()
            process = subprocess.Popen(
                command,
                cwd=str(settings.PROJECT_DIR),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except (OSError, RuntimeError, ValueError) as exc:
        _patch_state(
            uuid,
            status=STATUS_QUEUED,
            stage=STAGE_UPLOAD,
            progress=0.0,
            dispatch_error=str(exc),
            error_summary=None,
        )
        return

    _patch_state(
        uuid,
        status=STATUS_RUNNING,
        stage=STAGE_UPLOAD,
        progress=max(float(next_task.get("progress") or 0.0), 3.0),
        launcher_pid=process.pid,
        started_at=next_task.get("started_at") or _now_iso(),
        dispatch_error=None,
        error_summary=None,
    )

async def create_task(
    *,
    images: list[UploadFile],
    name: str | None,
    location: str | None,
    capture_date: str | None,
    description: str | None,
    building_name: str | None,
    floor_label: str | None,
    space_label: str | None,
) -> dict[str, Any]:
    if not images:
        raise HTTPException(400, "En az bir fotoğraf gerekli")
    if len(images) < 15:
        raise HTTPException(400, "Indoor fotogrametri için en az 15 fotoğraf gerekli")

    task_name = _safe_text(name)
    if not task_name:
        raise HTTPException(400, "name zorunlu")

    capture_date = _validate_capture_date(capture_date)
    location = _safe_text(location)
    description = _safe_text(description)
    building_name = _safe_text(building_name)
    floor_label = _safe_text(floor_label)
    space_label = _safe_text(space_label)

    files: list[tuple[str, bytes]] = []
    for image in images:
        content = await image.read()
        if not content:
            continue
        files.append((image.filename or "image.jpg", content))
    if len(files) < 15:
        raise HTTPException(400, "Boş dosyalar çıkarıldığında en az 15 fotoğraf kalmalı")

    uuid = uuid4().hex
    upload_dir = _upload_dir(uuid)
    workspace_dir = _workspace_dir(uuid)
    output_dir = _output_dir(uuid)
    upload_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    _log_path(uuid).touch()

    for file_name, content in files:
        (upload_dir / file_name).write_bytes(content)

    created_at = _now_iso()
    timestamp = datetime.now(UTC).timestamp()
    manifest = {
        "uuid": uuid,
        "name": task_name,
        "images_count": len(files),
        "date_created": timestamp,
        "created_at": created_at,
        "location": location,
        "capture_date": capture_date,
        "description": description,
        "building_name": building_name,
        "floor_label": floor_label,
        "space_label": space_label,
        "pipeline": "indoor",
        "upload_dir": str(upload_dir),
        "workspace_dir": str(workspace_dir),
        "output_dir": str(output_dir),
        "log_path": str(_log_path(uuid)),
        "upload_dir_rel": upload_dir.relative_to(settings.PROJECT_DIR).as_posix(),
        "workspace_dir_rel": workspace_dir.relative_to(settings.PROJECT_DIR).as_posix(),
        "output_dir_rel": output_dir.relative_to(settings.PROJECT_DIR).as_posix(),
        "log_path_rel": _log_path(uuid).relative_to(settings.PROJECT_DIR).as_posix(),
        "stage_order": _DEFAULT_STAGE_ORDER,
    }
    state = {
        "uuid": uuid,
        "status": STATUS_QUEUED,
        "status_text": STATUS_TEXT[STATUS_QUEUED],
        "stage": STAGE_UPLOAD,
        "progress": 0.0,
        "started_at": None,
        "finished_at": None,
        "error_summary": None,
        "dispatch_error": None,
        "launcher_pid": None,
    }
    _write_json(_manifest_path(uuid), manifest)
    _write_json(_state_path(uuid), state)
    dispatch_next_queued()
    return {"uuid": uuid, "images_uploaded": len(files)}

def list_tasks() -> list[dict[str, Any]]:
    dispatch_next_queued()
    tasks = [_merge_task(uuid) for uuid in _task_uuids()]
    tasks.sort(key=_sort_key, reverse=True)
    return tasks

def get_task(uuid: str) -> dict[str, Any]:
    dispatch_next_queued()
    if not _task_exists(uuid):
        raise HTTPException(404, "Indoor task bulunamadı")
    return _merge_task(uuid)

def delete_task(uuid: str) -> dict[str, Any]:
    if not _task_exists(uuid):
        raise HTTPException(404, "Indoor task bulunamadı")
    task = _merge_task(uuid)
    if task.get("status") == STATUS_RUNNING and _pid_alive(int(task.get("launcher_pid") or 0)):
        raise HTTPException(409, "Çalışan indoor görev silinemez")

    shutil.rmtree(_upload_dir(uuid).parent, ignore_errors=True)
    shutil.rmtree(_workspace_dir(uuid), ignore_errors=True)
    shutil.rmtree(_output_dir(uuid), ignore_errors=True)
    _log_path(uuid).unlink(missing_ok=True)
    dispatch_next_queued()
    return {"status": "removed", "uuid": uuid}

def tileset_url(uuid: str) -> dict[str, str]:
    if not _task_exists(uuid):
        raise HTTPException(404, "Indoor task bulunamadı")
    path = _output_dir(uuid) / "tiles" / "tileset.json"
    if not path.exists():
        return {"url": ""}
    return {"url": f"/data/indoor/outputs/{uuid}/tiles/tileset.json"}

def read_log(uuid: str) -> str:
    if not _task_exists(uuid):
        raise HTTPException(404, "Indoor task bulunamadı")
    path = _log_path(uuid)
    if not path.exists():
        raise HTTPException(404, "Log bulunamadı")
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(500, f"Log okunamadı: {exc}") from exc
