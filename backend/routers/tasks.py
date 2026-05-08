"""ODM task'larını yöneten REST router.

Frontend buradaki uçları çağırarak:
  * yeni bir ODM görevi başlatır (drone fotoğraflarını yükler)
  * mevcut görevlerin listesini ve durumunu çeker
  * tamamlanan görevin orthophoto / point cloud çıktısını indirir
NodeODM container'ı Docker'da koşar; biz sadece HTTP üzerinden konuşuruz.
"""
from __future__ import annotations

import io
import json
import math
import shutil
import struct
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from config import settings
from nodeodm_client import NodeODMError, client as odm

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

_USE_CASES = {"construction", "heritage", "generic", "museum"}
_DATA_SOURCES = {"drone", "phone", "open_source"}
_MUSEUM_FIELDS = (
    "museum_name",
    "historical_period",
    "museum_summary",
    "featured_artifacts",
    "visitor_notes",
    "museum_address",
    "visiting_hours",
    "ticket_access",
    "collection_theme",
    "curator_contact",
)


# --------------------------------------------------------------------- #
# Şemalar
# --------------------------------------------------------------------- #
class TaskSummary(BaseModel):
    uuid: str
    name: str | None = None
    status: int | None = None
    status_text: str | None = None
    progress: float | None = None
    images_count: int | None = None
    date_created: int | None = None
    use_case: str | None = None
    data_source: str | None = None
    location: str | None = None
    capture_date: str | None = None
    description: str | None = None
    museum_name: str | None = None
    historical_period: str | None = None
    museum_summary: str | None = None
    featured_artifacts: str | None = None
    visitor_notes: str | None = None
    museum_address: str | None = None
    visiting_hours: str | None = None
    ticket_access: str | None = None
    collection_theme: str | None = None
    curator_contact: str | None = None


class TaskCreated(BaseModel):
    uuid: str
    images_uploaded: int


class TaskMetadataUpdate(BaseModel):
    name: str | None = None
    use_case: str | None = None
    data_source: str | None = None
    location: str | None = None
    capture_date: str | None = None
    description: str | None = None
    museum_name: str | None = None
    historical_period: str | None = None
    museum_summary: str | None = None
    featured_artifacts: str | None = None
    visitor_notes: str | None = None
    museum_address: str | None = None
    visiting_hours: str | None = None
    ticket_access: str | None = None
    collection_theme: str | None = None
    curator_contact: str | None = None


# NodeODM status code'larını okunaklı hale getir
# https://github.com/OpenDroneMap/NodeODM/blob/master/libs/statusCodes.js
_STATUS_TEXT = {
    10: "QUEUED",
    20: "RUNNING",
    30: "FAILED",
    40: "COMPLETED",
    50: "CANCELED",
}


def _museum_metadata_values(metadata: dict[str, Any]) -> dict[str, Any]:
    return {field: metadata.get(field) for field in _MUSEUM_FIELDS}


def _summarize(info: dict[str, Any]) -> TaskSummary:
    status = info.get("status") or {}
    code = status.get("code") if isinstance(status, dict) else status
    metadata = _read_metadata(info.get("uuid", ""))
    return TaskSummary(
        uuid=info.get("uuid", ""),
        name=metadata.get("name") or info.get("name"),
        status=code,
        status_text=_STATUS_TEXT.get(code, "UNKNOWN") if code is not None else None,
        progress=info.get("progress"),
        images_count=info.get("imagesCount"),
        date_created=info.get("dateCreated"),
        use_case=metadata.get("use_case"),
        data_source=metadata.get("data_source"),
        location=metadata.get("location"),
        capture_date=metadata.get("capture_date"),
        description=metadata.get("description"),
        **_museum_metadata_values(metadata),
    )


def _metadata_dir() -> Path:
    return settings.UPLOAD_DIR / "_projects"


def _metadata_path(uuid: str) -> Path:
    return _metadata_dir() / f"{uuid}.json"


def _read_metadata(uuid: str) -> dict[str, Any]:
    if not uuid:
        return {}
    path = _metadata_path(uuid)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_metadata(uuid: str, metadata: dict[str, Any]) -> None:
    meta_dir = _metadata_dir()
    meta_dir.mkdir(parents=True, exist_ok=True)
    _metadata_path(uuid).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _output_dir_exists(uuid: str) -> bool:
    return _output_dir(uuid).is_dir()


def _local_output_uuids() -> list[str]:
    if not settings.OUTPUT_DIR.exists():
        return []
    return sorted(
        path.name for path in settings.OUTPUT_DIR.iterdir()
        if path.is_dir()
    )


def _local_task_summary(uuid: str) -> TaskSummary | None:
    if not _output_dir_exists(uuid):
        return None

    metadata = _read_metadata(uuid)
    output_dir = _output_dir(uuid)
    try:
        date_created = int(metadata.get("date_created") or output_dir.stat().st_mtime)
    except OSError:
        date_created = None

    return TaskSummary(
        uuid=uuid,
        name=metadata.get("name"),
        status=40,
        status_text="COMPLETED",
        progress=100.0,
        images_count=metadata.get("images_count"),
        date_created=date_created,
        use_case=metadata.get("use_case"),
        data_source=metadata.get("data_source"),
        location=metadata.get("location"),
        capture_date=metadata.get("capture_date"),
        description=metadata.get("description"),
        **_museum_metadata_values(metadata),
    )


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _validate_choice(value: str | None, allowed: set[str], field_name: str) -> str | None:
    if value is None:
        return None
    if value not in allowed:
        allowed_text = ", ".join(sorted(allowed))
        raise HTTPException(400, f"Geçersiz {field_name}: {value}. Beklenen: {allowed_text}")
    return value


def _validate_capture_date(value: str | None) -> str | None:
    value = _clean_optional(value)
    if value is None:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(400, "capture_date YYYY-MM-DD formatında olmalı") from exc
    return value


def _safe_storage_name(value: str) -> str:
    clean = value.strip().replace("\\", "_").replace("/", "_")
    return clean or datetime.utcnow().strftime("task_%Y%m%d_%H%M%S")


def _normalize_task_metadata(
    *,
    name: str | None,
    use_case: str | None,
    data_source: str | None,
    location: str | None,
    capture_date: str | None,
    description: str | None,
    museum_name: str | None,
    historical_period: str | None,
    museum_summary: str | None,
    featured_artifacts: str | None,
    visitor_notes: str | None,
    museum_address: str | None,
    visiting_hours: str | None,
    ticket_access: str | None,
    collection_theme: str | None,
    curator_contact: str | None,
) -> dict[str, Any]:
    normalized_use_case = _validate_choice(_clean_optional(use_case), _USE_CASES, "use_case")
    museum_metadata = {
        "museum_name": _clean_optional(museum_name),
        "historical_period": _clean_optional(historical_period),
        "museum_summary": _clean_optional(museum_summary),
        "featured_artifacts": _clean_optional(featured_artifacts),
        "visitor_notes": _clean_optional(visitor_notes),
        "museum_address": _clean_optional(museum_address),
        "visiting_hours": _clean_optional(visiting_hours),
        "ticket_access": _clean_optional(ticket_access),
        "collection_theme": _clean_optional(collection_theme),
        "curator_contact": _clean_optional(curator_contact),
    }
    if normalized_use_case != "museum":
        museum_metadata = {field: None for field in _MUSEUM_FIELDS}
    return {
        "name": _clean_optional(name),
        "use_case": normalized_use_case,
        "data_source": _validate_choice(_clean_optional(data_source), _DATA_SOURCES, "data_source"),
        "location": _clean_optional(location),
        "capture_date": _validate_capture_date(capture_date),
        "description": _clean_optional(description),
        **museum_metadata,
    }


async def _persist_uploads(
    images: list[UploadFile],
    local_dir: Path,
) -> list[tuple[str, Path]]:
    """UploadFile içeriklerini diske stream ederek kaydeder.

    Büyük foto setlerinde tüm dosyaları belleğe almak yerine, her dosya
    doğrudan kalıcı klasöre yazılır ve NodeODM'e buradan yüklenir.
    """
    stored_files: list[tuple[str, Path]] = []
    for index, img in enumerate(images, start=1):
        original_name = _clean_optional(img.filename) or f"image_{index:04d}.jpg"
        safe_name = _safe_storage_name(original_name)
        target = local_dir / safe_name

        with target.open("wb") as fh:
            while True:
                chunk = await img.read(1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
        await img.close()

        if target.stat().st_size == 0:
            target.unlink(missing_ok=True)
            continue

        stored_files.append((safe_name, target))

    return stored_files


# --------------------------------------------------------------------- #
# Uçlar
# --------------------------------------------------------------------- #
@router.get("", response_model=list[TaskSummary])
async def list_tasks() -> list[TaskSummary]:
    """NodeODM'deki tüm task'ların özetini döner.
    NodeODM down olsa bile 500 atmaz — boş liste döner. (Health bar zaten
    durumun ne olduğunu kullanıcıya söylüyor.)
    """
    out: list[TaskSummary] = []
    live_uuids: set[str] = set()

    try:
        uuids = await odm.list_tasks()
    except NodeODMError as exc:
        print(f"[tasks] NodeODM erişilemez, local fallback kullanılacak: {exc}")
    else:
        for u in uuids:
            try:
                info = await odm.task_info(u)
                out.append(_summarize(info))
                live_uuids.add(u)
            except NodeODMError:
                continue

    for uuid in _local_output_uuids():
        if uuid in live_uuids:
            continue
        summary = _local_task_summary(uuid)
        if summary:
            out.append(summary)

    # En yeniler üstte
    out.sort(key=lambda t: t.date_created or 0, reverse=True)
    return out


@router.get("/{uuid}", response_model=TaskSummary)
async def get_task(uuid: str) -> TaskSummary:
    try:
        info = await odm.task_info(uuid)
    except NodeODMError as exc:
        summary = _local_task_summary(uuid)
        if summary:
            return summary
        raise HTTPException(404, f"Task bulunamadı: {exc}") from exc
    return _summarize(info)


@router.post("", response_model=TaskCreated)
async def create_task(
    images: list[UploadFile] = File(..., description="Drone fotoğrafları (>=5)"),
    name: str | None = Form(None),
    use_case: str | None = Form(None),
    data_source: str | None = Form(None),
    location: str | None = Form(None),
    capture_date: str | None = Form(None),
    description: str | None = Form(None),
    museum_name: str | None = Form(None),
    historical_period: str | None = Form(None),
    museum_summary: str | None = Form(None),
    featured_artifacts: str | None = Form(None),
    visitor_notes: str | None = Form(None),
    museum_address: str | None = Form(None),
    visiting_hours: str | None = Form(None),
    ticket_access: str | None = Form(None),
    collection_theme: str | None = Form(None),
    curator_contact: str | None = Form(None),
) -> TaskCreated:
    """Yeni ODM görevi oluşturur ve fotoğrafları gönderir."""
    if not images:
        raise HTTPException(400, "En az bir fotoğraf gerekli")
    if len(images) < 5:
        raise HTTPException(
            400, "ODM stabil sonuç için en az 5 fotoğraf ister"
        )

    metadata_payload = _normalize_task_metadata(
        name=name,
        use_case=use_case,
        data_source=data_source,
        location=location,
        capture_date=capture_date,
        description=description,
        museum_name=museum_name,
        historical_period=historical_period,
        museum_summary=museum_summary,
        featured_artifacts=featured_artifacts,
        visitor_notes=visitor_notes,
        museum_address=museum_address,
        visiting_hours=visiting_hours,
        ticket_access=ticket_access,
        collection_theme=collection_theme,
        curator_contact=curator_contact,
    )
    task_name = metadata_payload["name"]

    # Yerel kopyasını da sakla — debugging ve timeline için faydalı
    nodeodm_task_name = task_name or datetime.utcnow().strftime("task_%Y%m%d_%H%M%S")
    local_dir = settings.UPLOAD_DIR / _safe_storage_name(nodeodm_task_name)
    local_dir.mkdir(parents=True, exist_ok=True)
    try:
        files = await _persist_uploads(images, local_dir)
    except OSError as exc:
        shutil.rmtree(local_dir, ignore_errors=True)
        raise HTTPException(500, f"Upload dosyalari yazilamadi: {exc}") from exc

    if not files:
        shutil.rmtree(local_dir, ignore_errors=True)
        raise HTTPException(400, "Yüklenen fotoğraflar boş")

    # Varsayılan drone profili: kaliteli ortofoto için full ODM pipeline.
    # Bu profil dense/OpenMVS aşamalarını korur; GPU mevcutsa bu aşamalarda
    # devreye girer. Cesium tarafında yine ana çıktı ortofotodur.
    options = [
        {"name": "auto-boundary", "value": True},
        {"name": "3d-tiles", "value": True},
        {"name": "orthophoto-png", "value": True},
        {"name": "build-overviews", "value": True},
        {"name": "feature-quality", "value": "high"},
        {"name": "pc-quality", "value": "high"},
        {"name": "orthophoto-resolution", "value": 2.0},
        {"name": "mesh-size", "value": 300000},
    ]
    try:
        uuid = await odm.create_task(files, name=nodeodm_task_name, options=options)
    except NodeODMError as exc:
        raise HTTPException(502, f"NodeODM görev oluşturamadı: {exc}") from exc

    _write_metadata(
        uuid,
        {
          **metadata_payload,
          "name": task_name or nodeodm_task_name,
          "images_count": len(files),
          "date_created": int(datetime.utcnow().timestamp()),
          "pipeline_profile": "quality_gpu",
          "local_upload_dir": str(local_dir),
        },
    )

    return TaskCreated(uuid=uuid, images_uploaded=len(files))


@router.put("/{uuid}", response_model=TaskSummary)
async def update_task(uuid: str, payload: TaskMetadataUpdate) -> TaskSummary:
    metadata = _read_metadata(uuid)
    local_exists = _output_dir_exists(uuid) or _metadata_path(uuid).exists()

    info: dict[str, Any] | None = None
    try:
        info = await odm.task_info(uuid)
    except NodeODMError as exc:
        if not local_exists:
            raise HTTPException(404, f"Task bulunamadı: {exc}") from exc

    existing_name = metadata.get("name") or (info or {}).get("name")
    existing_use_case = metadata.get("use_case")
    existing_data_source = metadata.get("data_source")
    existing_location = metadata.get("location")
    existing_capture_date = metadata.get("capture_date")
    existing_description = metadata.get("description")

    normalized = _normalize_task_metadata(
        name=payload.name if payload.name is not None else existing_name,
        use_case=payload.use_case if payload.use_case is not None else existing_use_case,
        data_source=payload.data_source if payload.data_source is not None else existing_data_source,
        location=payload.location if payload.location is not None else existing_location,
        capture_date=payload.capture_date if payload.capture_date is not None else existing_capture_date,
        description=payload.description if payload.description is not None else existing_description,
        museum_name=payload.museum_name if payload.museum_name is not None else metadata.get("museum_name"),
        historical_period=payload.historical_period if payload.historical_period is not None else metadata.get("historical_period"),
        museum_summary=payload.museum_summary if payload.museum_summary is not None else metadata.get("museum_summary"),
        featured_artifacts=payload.featured_artifacts if payload.featured_artifacts is not None else metadata.get("featured_artifacts"),
        visitor_notes=payload.visitor_notes if payload.visitor_notes is not None else metadata.get("visitor_notes"),
        museum_address=payload.museum_address if payload.museum_address is not None else metadata.get("museum_address"),
        visiting_hours=payload.visiting_hours if payload.visiting_hours is not None else metadata.get("visiting_hours"),
        ticket_access=payload.ticket_access if payload.ticket_access is not None else metadata.get("ticket_access"),
        collection_theme=payload.collection_theme if payload.collection_theme is not None else metadata.get("collection_theme"),
        curator_contact=payload.curator_contact if payload.curator_contact is not None else metadata.get("curator_contact"),
    )
    if not normalized["name"]:
        raise HTTPException(400, "Proje adi zorunlu")

    preserved: dict[str, Any] = {
        "images_count": metadata.get("images_count") or (info or {}).get("imagesCount"),
        "date_created": metadata.get("date_created") or (info or {}).get("dateCreated"),
        "pipeline_profile": metadata.get("pipeline_profile"),
        "local_upload_dir": metadata.get("local_upload_dir"),
    }
    _write_metadata(uuid, {**preserved, **normalized})

    if info is not None:
        return _summarize(info)
    summary = _local_task_summary(uuid)
    if summary:
        return summary
    raise HTTPException(404, "Task bulunamadı")


@router.delete("/{uuid}")
async def delete_task(uuid: str) -> dict[str, str]:
    metadata = _read_metadata(uuid)
    has_local_data = _output_dir_exists(uuid) or _metadata_path(uuid).exists()
    try:
        await odm.remove_task(uuid)
    except NodeODMError as exc:
        if not has_local_data:
            raise HTTPException(404, f"Task silinemedi: {exc}") from exc
    shutil.rmtree(_output_dir(uuid), ignore_errors=True)
    local_upload_dir = metadata.get("local_upload_dir")
    if isinstance(local_upload_dir, str) and local_upload_dir.strip():
        shutil.rmtree(Path(local_upload_dir), ignore_errors=True)
    _metadata_path(uuid).unlink(missing_ok=True)
    return {"status": "removed", "uuid": uuid}


# --------------------------------------------------------------------- #
# İndirme uçları — backend, NodeODM'den indirip diske kaydeder ve
# frontend'e statik dosya olarak servis eder.
# --------------------------------------------------------------------- #
def _output_path(uuid: str, asset: str) -> Path:
    return settings.OUTPUT_DIR / uuid / asset


def _output_dir(uuid: str) -> Path:
    return settings.OUTPUT_DIR / uuid


def _find_first(uuid: str, *patterns: str) -> Path | None:
    base_dir = _output_dir(uuid)
    for pattern in patterns:
        matches = sorted(base_dir.rglob(pattern))
        if matches:
            return matches[0]
    return None


def _find_orthophoto(uuid: str) -> Path | None:
    direct = _output_path(uuid, "orthophoto.tif")
    if direct.exists():
        return direct
    return _find_first(
        uuid,
        "odm_orthophoto.tif",
        "orthophoto.tif",
        "odm_orthophoto.original.tif",
    )


def _find_bounds_geojson(uuid: str) -> Path | None:
    return _find_first(
        uuid,
        "odm_georeferenced_model.bounds.geojson",
        "*.bounds.geojson",
    )


def _find_georeference_info(uuid: str) -> Path | None:
    return _find_first(uuid, "odm_georeferenced_model.info.json")


def _find_orthophoto_preview(uuid: str) -> Path | None:
    return _find_first(
        uuid,
        "ortho.png",
        "orthophoto.png",
        "odm_orthophoto.png",
    )


def _find_point_cloud(uuid: str) -> Path | None:
    return _find_first(
        uuid,
        "odm_georeferenced_model.laz",
        "georeferenced_model.laz",
        "odm_georeferenced_model.las",
        "georeferenced_model.las",
        "*.laz",
        "*.las",
    )


def _find_tileset(uuid: str) -> Path | None:
    base_dir = _output_dir(uuid)
    direct = base_dir / "3d_tiles" / "tileset.json"
    if direct.exists():
        return direct
    matches = list(base_dir.rglob("tileset.json"))
    return matches[0] if matches else None


def _extract_tiles_archive(uuid: str) -> Path | None:
    archive = _output_path(uuid, "3d_tiles.zip")
    if not archive.exists():
        return None

    target_dir = _output_dir(uuid) / "3d_tiles"
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        with ZipFile(archive, "r") as zf:
            zf.extractall(target_dir)
    except BadZipFile:
        return None
    except OSError as exc:
        print(f"[tasks] 3d tiles extraction failed ({uuid}): {exc!r}")
        return None

    tileset = target_dir / "tileset.json"
    return tileset if tileset.exists() else None


def _generate_tileset_fallback(uuid: str, force: bool = False) -> Path | None:
    point_cloud = _find_point_cloud(uuid)
    if not point_cloud or not point_cloud.exists():
        return None

    target_dir = _output_dir(uuid) / "3d_tiles"
    target_tileset = target_dir / "tileset.json"
    if target_tileset.exists() and not force:
        return target_tileset

    rel_input = point_cloud.relative_to(settings.OUTPUT_DIR)
    container_input = f"/data/{rel_input.as_posix()}"
    output_dir_name = "3d_tiles_py3dtiles" if force else "3d_tiles"
    container_output = f"/data/{uuid}/{output_dir_name}"
    temp_dir = _output_dir(uuid) / output_dir_name
    temp_tileset = temp_dir / "tileset.json"

    docker = shutil.which("docker") or shutil.which("docker.exe")
    commands: list[list[str]] = []
    if docker:
        commands.append([
            docker,
            "compose",
            "--profile",
            "tools",
            "run",
            "--rm",
            "py3dtiles",
            "py3dtiles",
            "convert",
            container_input,
            "--out",
            container_output,
        ])

    docker_compose = shutil.which("docker-compose") or shutil.which("docker-compose.exe")
    if docker_compose:
        commands.append([
            docker_compose,
            "--profile",
            "tools",
            "run",
            "--rm",
            "py3dtiles",
            "py3dtiles",
            "convert",
            container_input,
            "--out",
            container_output,
        ])

    if not commands:
        print(f"[tasks] py3dtiles fallback skipped ({uuid}): docker compose bulunamadi")
        return None

    work_dir = temp_dir if force else target_dir
    shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    last_error: Exception | None = None
    for command in commands:
        try:
            subprocess.run(
                command,
                cwd=settings.DOCKER_DIR,
                check=True,
                capture_output=True,
                text=True,
            )
            break
        except (OSError, subprocess.CalledProcessError) as exc:
            last_error = exc
    else:
        print(f"[tasks] py3dtiles fallback failed ({uuid}): {last_error!r}")
        if hasattr(last_error, "stderr") and last_error.stderr:
            print(f"[tasks] py3dtiles stderr: {last_error.stderr[:3000]}")
        if hasattr(last_error, "stdout") and last_error.stdout:
            print(f"[tasks] py3dtiles stdout: {last_error.stdout[:3000]}")
        return None

    if force:
        if not temp_tileset.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
            return None
        shutil.rmtree(target_dir, ignore_errors=True)
        temp_dir.rename(target_dir)
        return target_tileset

    return target_tileset if target_tileset.exists() else None


def _parse_odm_utm_origin(uuid: str) -> tuple[int, bool, float, float] | None:
    path = _find_first(uuid, "odm_georeferencing_model_geo.txt", "coords.txt")
    if not path or not path.exists():
        return None
    try:
        lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        return None
    if len(lines) < 2 or "UTM" not in lines[0]:
        return None
    try:
        zone_token = lines[0].split("UTM", 1)[1].strip().split()[0].upper()
        zone = int(zone_token[:-1])
        northern = zone_token.endswith("N")
        easting, northing = (float(part) for part in lines[1].split()[:2])
    except (IndexError, TypeError, ValueError):
        return None
    return zone, northern, easting, northing


def _utm_to_geodetic_radians(
    easting: float,
    northing: float,
    zone: int,
    northern: bool,
) -> tuple[float, float]:
    a = 6378137.0
    e2 = 0.00669437999014
    k0 = 0.9996
    e_prime_sq = e2 / (1.0 - e2)

    x = easting - 500000.0
    y = northing if northern else northing - 10000000.0
    m = y / k0
    mu = m / (a * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 ** 3 / 256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))

    fp = (
        mu
        + (3.0 * e1 / 2.0 - 27.0 * e1 ** 3 / 32.0) * math.sin(2.0 * mu)
        + (21.0 * e1 * e1 / 16.0 - 55.0 * e1 ** 4 / 32.0) * math.sin(4.0 * mu)
        + (151.0 * e1 ** 3 / 96.0) * math.sin(6.0 * mu)
        + (1097.0 * e1 ** 4 / 512.0) * math.sin(8.0 * mu)
    )

    sin_fp = math.sin(fp)
    cos_fp = math.cos(fp)
    tan_fp = math.tan(fp)
    c1 = e_prime_sq * cos_fp * cos_fp
    t1 = tan_fp * tan_fp
    n1 = a / math.sqrt(1.0 - e2 * sin_fp * sin_fp)
    r1 = a * (1.0 - e2) / (1.0 - e2 * sin_fp * sin_fp) ** 1.5
    d = x / (n1 * k0)
    lon0 = math.radians(zone * 6 - 183)

    lat = fp - (n1 * tan_fp / r1) * (
        d * d / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * e_prime_sq) * d ** 4 / 24.0
        + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 252.0 * e_prime_sq - 3.0 * c1 * c1) * d ** 6 / 720.0
    )
    lon = lon0 + (
        d
        - (1.0 + 2.0 * t1 + c1) * d ** 3 / 6.0
        + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * e_prime_sq + 24.0 * t1 * t1) * d ** 5 / 120.0
    ) / cos_fp
    return lat, lon


def _geodetic_to_ecef(lat_radians: float, lon_radians: float, height: float) -> tuple[float, float, float]:
    a = 6378137.0
    e2 = 0.00669437999014
    sin_phi = math.sin(lat_radians)
    cos_phi = math.cos(lat_radians)
    sin_lam = math.sin(lon_radians)
    cos_lam = math.cos(lon_radians)
    n_val = a / math.sqrt(1.0 - e2 * sin_phi * sin_phi)
    return (
        (n_val + height) * cos_phi * cos_lam,
        (n_val + height) * cos_phi * sin_lam,
        (n_val * (1.0 - e2) + height) * sin_phi,
    )


def _vector_norm(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    magnitude = math.sqrt(sum(component * component for component in vector))
    if magnitude == 0:
        raise ValueError("sifir uzunluklu vektor")
    return tuple(component / magnitude for component in vector)


def _vector_cross(
    left: tuple[float, float, float],
    right: tuple[float, float, float],
) -> tuple[float, float, float]:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _vector_dot(left: tuple[float, float, float], right: tuple[float, float, float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _glb_position_bounds(path: Path) -> tuple[list[float], list[float]] | None:
    try:
        with path.open("rb") as fh:
            magic, _version, _length = struct.unpack("<4sII", fh.read(12))
            if magic != b"glTF":
                return None
            chunk_length, chunk_type = struct.unpack("<I4s", fh.read(8))
            if chunk_type != b"JSON":
                return None
            payload = json.loads(fh.read(chunk_length).decode("utf-8"))
    except (OSError, ValueError, struct.error, UnicodeDecodeError, json.JSONDecodeError):
        return None

    mins = [float("inf"), float("inf"), float("inf")]
    maxs = [float("-inf"), float("-inf"), float("-inf")]
    found = False
    for mesh in payload.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            accessor_idx = ((primitive.get("attributes") or {}).get("POSITION"))
            if accessor_idx is None:
                continue
            try:
                accessor = payload["accessors"][accessor_idx]
                local_min = accessor["min"]
                local_max = accessor["max"]
            except (KeyError, IndexError, TypeError):
                continue
            if len(local_min) < 3 or len(local_max) < 3:
                continue
            found = True
            for idx in range(3):
                mins[idx] = min(mins[idx], float(local_min[idx]))
                maxs[idx] = max(maxs[idx], float(local_max[idx]))
    if not found or not all(math.isfinite(value) for value in mins + maxs):
        return None
    return mins, maxs


def _glb_rtc_center(path: Path) -> tuple[float, float, float] | None:
    try:
        with path.open("rb") as fh:
            magic, _version, _length = struct.unpack("<4sII", fh.read(12))
            if magic != b"glTF":
                return None
            chunk_length, chunk_type = struct.unpack("<I4s", fh.read(8))
            if chunk_type != b"JSON":
                return None
            payload = json.loads(fh.read(chunk_length).decode("utf-8"))
    except (OSError, ValueError, struct.error, UnicodeDecodeError, json.JSONDecodeError):
        return None

    center = (((payload.get("extensions") or {}).get("CESIUM_RTC") or {}).get("center"))
    if not isinstance(center, list) or len(center) < 3:
        return None
    try:
        values = tuple(float(center[idx]) for idx in range(3))
    except (TypeError, ValueError):
        return None
    return values if all(math.isfinite(value) for value in values) else None


def _read_glb_payload(path: Path) -> tuple[dict[str, Any], bytes] | None:
    try:
        with path.open("rb") as fh:
            magic, _version, length = struct.unpack("<4sII", fh.read(12))
            if magic != b"glTF":
                return None

            payload: dict[str, Any] | None = None
            binary = b""
            while fh.tell() < length:
                chunk_header = fh.read(8)
                if len(chunk_header) < 8:
                    return None
                chunk_length, chunk_type = struct.unpack("<I4s", chunk_header)
                chunk_data = fh.read(chunk_length)
                if len(chunk_data) != chunk_length:
                    return None
                if chunk_type == b"JSON":
                    payload = json.loads(chunk_data.decode("utf-8"))
                elif chunk_type == b"BIN\x00":
                    binary = chunk_data
    except (OSError, ValueError, struct.error, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if payload is None:
        return None
    return payload, binary


def _write_glb_payload(path: Path, payload: dict[str, Any], binary: bytes) -> None:
    json_chunk = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_chunk += b" " * ((4 - (len(json_chunk) % 4)) % 4)
    binary += b"\x00" * ((4 - (len(binary) % 4)) % 4)

    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary)
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    with temp_path.open("wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, total_length))
        fh.write(struct.pack("<I4s", len(json_chunk), b"JSON"))
        fh.write(json_chunk)
        fh.write(struct.pack("<I4s", len(binary), b"BIN\x00"))
        fh.write(binary)
    temp_path.replace(path)


def _clamp_glb_embedded_textures(path: Path, max_texture_size: int) -> list[tuple[int, tuple[int, int], tuple[int, int]]]:
    if max_texture_size <= 0 or not path.exists():
        return []

    parsed = _read_glb_payload(path)
    if not parsed:
        return []
    payload, binary = parsed

    try:
        from PIL import Image
    except ImportError:
        print(f"[tasks] Pillow bulunamadi, GLB texture clamp atlandi: {path}")
        return []
    Image.MAX_IMAGE_PIXELS = None

    images = payload.get("images")
    buffer_views = payload.get("bufferViews")
    buffers = payload.get("buffers")
    if not isinstance(images, list) or not isinstance(buffer_views, list) or not isinstance(buffers, list) or not buffers:
        return []

    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    replacements: dict[int, bytes] = {}
    resized: list[tuple[int, tuple[int, int], tuple[int, int]]] = []

    for image_index, image in enumerate(images):
        if not isinstance(image, dict):
            continue
        buffer_view_index = image.get("bufferView")
        mime_type = str(image.get("mimeType") or "").lower()
        if not isinstance(buffer_view_index, int) or mime_type not in {"image/jpeg", "image/png"}:
            continue
        if buffer_view_index < 0 or buffer_view_index >= len(buffer_views):
            continue

        buffer_view = buffer_views[buffer_view_index]
        if not isinstance(buffer_view, dict):
            continue
        byte_offset = int(buffer_view.get("byteOffset", 0) or 0)
        byte_length = int(buffer_view.get("byteLength", 0) or 0)
        if byte_length <= 0:
            continue
        image_bytes = binary[byte_offset:byte_offset + byte_length]
        if len(image_bytes) != byte_length:
            continue

        try:
            with Image.open(io.BytesIO(image_bytes)) as texture:
                width, height = texture.size
                if max(width, height) <= max_texture_size:
                    continue

                scale = max_texture_size / float(max(width, height))
                resized_size = (
                    max(1, int(round(width * scale))),
                    max(1, int(round(height * scale))),
                )
                texture = texture.resize(resized_size, resampling)

                encoded = io.BytesIO()
                if mime_type == "image/jpeg":
                    if texture.mode not in {"RGB", "L"}:
                        texture = texture.convert("RGB")
                    texture.save(encoded, format="JPEG", quality=90, optimize=True)
                else:
                    if texture.mode not in {"RGB", "RGBA", "L", "LA", "P"}:
                        texture = texture.convert("RGBA")
                    texture.save(encoded, format="PNG", optimize=True)

                replacements[buffer_view_index] = encoded.getvalue()
                resized.append((image_index, (width, height), resized_size))
        except Exception as exc:
            print(f"[tasks] Texture clamp basarisiz ({path.name}, image={image_index}): {exc!r}")

    if not replacements:
        return []

    rebuilt = bytearray()
    for index, buffer_view in enumerate(buffer_views):
        if not isinstance(buffer_view, dict):
            continue
        if rebuilt:
            rebuilt.extend(b"\x00" * ((4 - (len(rebuilt) % 4)) % 4))

        byte_offset = int(buffer_view.get("byteOffset", 0) or 0)
        byte_length = int(buffer_view.get("byteLength", 0) or 0)
        chunk = replacements.get(index, binary[byte_offset:byte_offset + byte_length])
        buffer_view["byteOffset"] = len(rebuilt)
        buffer_view["byteLength"] = len(chunk)
        rebuilt.extend(chunk)

    if isinstance(buffers[0], dict):
        buffers[0]["byteLength"] = len(rebuilt)

    _write_glb_payload(path, payload, bytes(rebuilt))
    print(
        f"[tasks] GLB texture clamp uygulandi: {path.name} "
        f"({', '.join(f'#{idx}:{old[0]}x{old[1]}->{new[0]}x{new[1]}' for idx, old, new in resized)})"
    )
    return resized


def _clamp_output_glbs(uuid: str) -> None:
    max_texture_size = settings.MAX_GLTF_TEXTURE_SIZE
    if max_texture_size <= 0:
        return

    candidates = [
        _output_dir(uuid) / "odm_texturing" / "odm_textured_model_geo.glb",
        _output_dir(uuid) / "3d_tiles" / "content.glb",
    ]
    for path in candidates:
        if path.exists():
            _clamp_glb_embedded_textures(path, max_texture_size)


def _odm_glb_world_axes(
    east_basis: tuple[float, float, float],
    north_basis: tuple[float, float, float],
    up_basis: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]:
    """ODM OBJ->GLB zinciri z-up veriyi koruyor; Cesium glTF'yi y-up varsayarak
    z-up tile frame'ine ceviriyor. Root transform'u buna gore kompanse et."""
    return (
        east_basis,
        tuple(-component for component in up_basis),
        north_basis,
    )


def _generate_tileset_from_glb(uuid: str) -> Path | None:
    """ODM textured model GLB'sinden minimal 3D Tiles 1.1 tileset.json üretir.

    py3dtiles Docker'ı olmadan çalışır; ODM'nin yazdığı UTM origin bilgisini
    kullanıp GLB'yi Cesium'a doğru dünya matrisinde yerleştirir.
    Gereksinimler: odm_textured_model_geo.glb + odm_georeferenced_model.info.json
    """
    source_glb = _find_first(uuid, "odm_textured_model_geo.glb")
    if not source_glb or not source_glb.exists():
        return None
    _clamp_glb_embedded_textures(source_glb, settings.MAX_GLTF_TEXTURE_SIZE)
    obj = _find_first(uuid, "odm_textured_model_geo.obj")

    info_path = _find_georeference_info(uuid)
    if not info_path or not info_path.exists():
        return None

    try:
        data = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    stats = data.get("stats") if isinstance(data, dict) else {}
    bbox_4326 = (((stats or {}).get("bbox") or {}).get("EPSG:4326") or {}).get("bbox")
    if not bbox_4326:
        return None

    try:
        west = float(bbox_4326["minx"])
        south = float(bbox_4326["miny"])
        east = float(bbox_4326["maxx"])
        north = float(bbox_4326["maxy"])
        min_h = float(bbox_4326.get("minz", 0))
        max_h = float(bbox_4326.get("maxz", 100))
    except (KeyError, TypeError, ValueError):
        return None

    glb_bounds = _glb_position_bounds(source_glb)
    rtc_center = _glb_rtc_center(source_glb) or (0.0, 0.0, 0.0)
    mins = maxs = None
    if glb_bounds:
        mins, maxs = glb_bounds
    elif obj and obj.exists():
        mins = [float("inf"), float("inf"), float("inf")]
        maxs = [float("-inf"), float("-inf"), float("-inf")]
        try:
            with obj.open("r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if not line.startswith("v "):
                        continue
                    parts = line.split()
                    if len(parts) < 4:
                        continue
                    values = [float(parts[1]), float(parts[2]), float(parts[3])]
                    for idx, value in enumerate(values):
                        mins[idx] = min(mins[idx], value)
                        maxs[idx] = max(maxs[idx], value)
        except OSError:
            return None
        if not all(math.isfinite(value) for value in mins + maxs):
            return None
    else:
        return None

    local_center = [(min_v + max_v) / 2 for min_v, max_v in zip(mins, maxs)]

    origin = _parse_odm_utm_origin(uuid)
    if origin:
        zone, northern, easting, northing = origin
        lat_c, lon_c = _utm_to_geodetic_radians(easting, northing, zone, northern)
        origin_ecef = _geodetic_to_ecef(lat_c, lon_c, 0.0)
        east_sample = _geodetic_to_ecef(*_utm_to_geodetic_radians(easting + 1.0, northing, zone, northern), 0.0)
        north_sample = _geodetic_to_ecef(*_utm_to_geodetic_radians(easting, northing + 1.0, zone, northern), 0.0)

        raw_x = tuple(sample - base for sample, base in zip(east_sample, origin_ecef))
        raw_y = tuple(sample - base for sample, base in zip(north_sample, origin_ecef))
        sin_phi = math.sin(lat_c)
        cos_phi = math.cos(lat_c)
        sin_lam = math.sin(lon_c)
        cos_lam = math.cos(lon_c)
        basis_z = (cos_phi * cos_lam, cos_phi * sin_lam, sin_phi)
        basis_x = _vector_norm(raw_x)
        basis_y = _vector_norm(_vector_cross(basis_z, basis_x))
        if _vector_dot(basis_y, raw_y) < 0.0:
            basis_y = tuple(-component for component in basis_y)
        basis_x = _vector_norm(_vector_cross(basis_y, basis_z))
        transform_basis_x, transform_basis_y, transform_basis_z = _odm_glb_world_axes(
            basis_x,
            basis_y,
            basis_z,
        )
        tx = origin_ecef[0] - (
            transform_basis_x[0] * rtc_center[0]
            + transform_basis_y[0] * rtc_center[1]
            + transform_basis_z[0] * rtc_center[2]
        )
        ty = origin_ecef[1] - (
            transform_basis_x[1] * rtc_center[0]
            + transform_basis_y[1] * rtc_center[1]
            + transform_basis_z[1] * rtc_center[2]
        )
        tz = origin_ecef[2] - (
            transform_basis_x[2] * rtc_center[0]
            + transform_basis_y[2] * rtc_center[1]
            + transform_basis_z[2] * rtc_center[2]
        )
    else:
        native_bbox = (((stats or {}).get("bbox") or {}).get("native") or {}).get("bbox") or {}
        native_avg: dict[str, float] = {}
        for item in (stats or {}).get("statistic") or []:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            average = item.get("average")
            if name in {"X", "Y", "Z"} and isinstance(average, (int, float)):
                native_avg[name] = float(average)

        lon_center = (west + east) / 2
        lat_center = (south + north) / 2
        alt_c = native_avg.get("Z", (min_h + max_h) / 2)

        try:
            native_min_x = float(native_bbox["minx"])
            native_max_x = float(native_bbox["maxx"])
            native_min_y = float(native_bbox["miny"])
            native_max_y = float(native_bbox["maxy"])
            if (
                "X" in native_avg
                and "Y" in native_avg
                and native_max_x > native_min_x
                and native_max_y > native_min_y
            ):
                x_ratio = (native_avg["X"] - native_min_x) / (native_max_x - native_min_x)
                y_ratio = (native_avg["Y"] - native_min_y) / (native_max_y - native_min_y)
                lon_center = west + x_ratio * (east - west)
                lat_center = south + y_ratio * (north - south)
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass

        lon_c = math.radians(lon_center)
        lat_c = math.radians(lat_center)
        sin_phi = math.sin(lat_c)
        cos_phi = math.cos(lat_c)
        sin_lam = math.sin(lon_c)
        cos_lam = math.cos(lon_c)
        center_ecef = _geodetic_to_ecef(lat_c, lon_c, alt_c)
        basis_x = (-sin_lam, cos_lam, 0.0)
        basis_y = (-sin_phi * cos_lam, -sin_phi * sin_lam, cos_phi)
        basis_z = (cos_phi * cos_lam, cos_phi * sin_lam, sin_phi)
        transform_basis_x, transform_basis_y, transform_basis_z = _odm_glb_world_axes(
            basis_x,
            basis_y,
            basis_z,
        )
        tx = center_ecef[0] - (
            transform_basis_x[0] * (rtc_center[0] + local_center[0])
            + transform_basis_y[0] * (rtc_center[1] + local_center[1])
            + transform_basis_z[0] * (rtc_center[2] + local_center[2])
        )
        ty = center_ecef[1] - (
            transform_basis_x[1] * (rtc_center[0] + local_center[0])
            + transform_basis_y[1] * (rtc_center[1] + local_center[1])
            + transform_basis_z[1] * (rtc_center[2] + local_center[2])
        )
        tz = center_ecef[2] - (
            transform_basis_x[2] * (rtc_center[0] + local_center[0])
            + transform_basis_y[2] * (rtc_center[1] + local_center[1])
            + transform_basis_z[2] * (rtc_center[2] + local_center[2])
        )

    basis_x = transform_basis_x
    basis_y = transform_basis_y
    basis_z = transform_basis_z

    # 4×4 sütun-öncelikli dönüşüm matrisi.
    # Kolonlar sırasıyla local X, local Y, local Z eksenlerinin dünyadaki yönleridir.
    transform = [
        basis_x[0], basis_x[1], basis_x[2], 0.0,
        basis_y[0], basis_y[1], basis_y[2], 0.0,
        basis_z[0], basis_z[1], basis_z[2], 0.0,
        tx,  ty,  tz,  1.0,
    ]

    target_dir = _output_dir(uuid) / "3d_tiles"
    target_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ODM'nin textured GLB'si zaten Z-up çalışıyor; içeriğe ekstra eksen
        # matrisi gömmek modeli 90° yanlış çevirip yüksekliği şişiriyor.
        shutil.copy2(source_glb, target_dir / "content.glb")
        glb_uri = "content.glb"
    except OSError:
        return None

    west_r, south_r = math.radians(west), math.radians(south)
    east_r, north_r = math.radians(east), math.radians(north)
    cos_lat = math.cos(math.radians((south + north) / 2.0))
    width_m  = abs(east - west)  * 111319.0 * abs(cos_lat)
    height_m = abs(north - south) * 111319.0
    geom_err = math.sqrt(width_m ** 2 + height_m ** 2)

    tileset = {
        "asset": {"version": "1.1"},
        "geometricError": round(geom_err, 2),
        "root": {
            "boundingVolume": {
                "region": [
                    round(west_r, 8), round(south_r, 8),
                    round(east_r, 8), round(north_r, 8),
                    round(min_h, 3),  round(max_h, 3),
                ],
            },
            "geometricError": round(geom_err / 2, 2),
            "refine": "ADD",
            "transform": [round(v, 8) for v in transform],
            "content": {"uri": glb_uri},
        },
    }

    tileset_path = target_dir / "tileset.json"
    tileset_path.write_text(json.dumps(tileset, indent=2), encoding="utf-8")
    print(f"[tasks] GLB tabanlı tileset.json üretildi: {tileset_path}")
    return tileset_path


def _tileset_looks_like_glb_fallback(path: Path | None) -> bool:
    if not path or not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    uri = (((data or {}).get("root") or {}).get("content") or {}).get("uri")
    if not isinstance(uri, str):
        return False
    uri = uri.strip().lower()
    return uri.endswith(".glb") or uri.endswith(".gltf")


def _glb_tileset_is_stale(uuid: str, tileset_path: Path | None) -> bool:
    if not tileset_path or not tileset_path.exists():
        return True

    content_glb = tileset_path.parent / "content.glb"
    if not content_glb.exists():
        return True

    source_glb = _find_first(uuid, "odm_textured_model_geo.glb")
    info_path = _find_georeference_info(uuid)
    origin_path = _find_first(uuid, "odm_georeferencing_model_geo.txt", "coords.txt")

    try:
        tileset_mtime = min(tileset_path.stat().st_mtime_ns, content_glb.stat().st_mtime_ns)
    except OSError:
        return True

    for dependency in (source_glb, info_path, origin_path):
        if not dependency or not dependency.exists():
            continue
        try:
            if dependency.stat().st_mtime_ns > tileset_mtime:
                return True
        except OSError:
            return True
    return False


def _ensure_best_tileset(uuid: str) -> Path | None:
    existing = _find_tileset(uuid)
    if existing and not _tileset_looks_like_glb_fallback(existing):
        return existing

    archive_tileset = _extract_tiles_archive(uuid)
    if archive_tileset and not _tileset_looks_like_glb_fallback(archive_tileset):
        return archive_tileset

    if existing and _tileset_looks_like_glb_fallback(existing):
        _clamp_output_glbs(uuid)
        if not _glb_tileset_is_stale(uuid, existing):
            return existing
        regenerated = _generate_tileset_from_glb(uuid)
        if regenerated:
            return regenerated

    pointcloud_tileset = _generate_tileset_fallback(uuid)
    if pointcloud_tileset:
        return pointcloud_tileset

    if existing:
        return existing
    if archive_tileset:
        return archive_tileset
    return _generate_tileset_from_glb(uuid)


def _ensure_orthophoto_alias(uuid: str) -> Path | None:
    source = _find_orthophoto(uuid)
    if not source or not source.exists():
        return None

    target = _output_path(uuid, "orthophoto.tif")
    if source == target:
        return target
    if target.exists():
        target.unlink()
    shutil.copy2(source, target)
    return target


def _to_wsl_path(path: Path) -> str | None:
    raw = path.as_posix()
    if raw.startswith("/mnt/"):
        return raw
    if len(raw) >= 3 and raw[1:3] == ":/":
        drive = raw[0].lower()
        return f"/mnt/{drive}/{raw[3:]}"
    return None


def _ensure_orthophoto_tiles(uuid: str) -> Path | None:
    orthophoto = _ensure_orthophoto_alias(uuid)
    if not orthophoto:
        return None

    tiles_dir = _output_path(uuid, "orthophoto_tiles")
    tilemap = tiles_dir / "tilemapresource.xml"
    if tilemap.exists():
        return tiles_dir

    tiles_dir.mkdir(parents=True, exist_ok=True)
    tool = shutil.which("gdal2tiles.py") or shutil.which("gdal2tiles")
    command: list[str] | None = None
    copy_back_command: list[str] | None = None
    if tool:
        command = [tool, "-w", "none", str(orthophoto), str(tiles_dir)]
    else:
        docker = shutil.which("docker") or shutil.which("docker.exe")
        if docker:
            container_tiles = f"/var/www/data/{uuid}/orthophoto_tiles"
            command = [
                docker,
                "exec",
                "sc-nodeodm",
                "sh",
                "-lc",
                (
                    f"rm -rf {container_tiles} && "
                    f"mkdir -p {container_tiles} && "
                    f"gdal2tiles.py -w none "
                    f"/var/www/data/{uuid}/odm_orthophoto/odm_orthophoto.tif "
                    f"{container_tiles}"
                ),
            ]
            copy_back_command = [
                docker,
                "cp",
                f"sc-nodeodm:{container_tiles}/.",
                str(tiles_dir),
            ]
        else:
            wsl = shutil.which("wsl.exe")
            orthophoto_wsl = _to_wsl_path(orthophoto)
            tiles_wsl = _to_wsl_path(tiles_dir)
            if wsl and orthophoto_wsl and tiles_wsl:
                command = [wsl, "gdal2tiles.py", "-w", "none", orthophoto_wsl, tiles_wsl]
    if not command:
        return None

    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
        if copy_back_command:
            subprocess.run(
                copy_back_command,
                check=True,
                capture_output=True,
                text=True,
            )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"[tasks] orthophoto tile generation failed ({uuid}): {exc!r}")
        return None

    return tiles_dir if tilemap.exists() else None


def _extract_bbox_from_geometry(geometry: dict[str, Any], coords: list[list[float]]) -> None:
    values = geometry.get("coordinates")
    if values is None:
        return

    def walk(node: Any) -> None:
        if not isinstance(node, list):
            return
        if len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
            coords.append([float(node[0]), float(node[1])])
            return
        for item in node:
            walk(item)

    walk(values)


def _bounds_bbox(uuid: str) -> list[float] | None:
    info_path = _find_georeference_info(uuid)
    if info_path and info_path.exists():
        try:
            data = json.loads(info_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        stats = data.get("stats") if isinstance(data, dict) else {}
        epsg_4326 = (((stats or {}).get("bbox") or {}).get("EPSG:4326") or {}).get("bbox")
        if isinstance(epsg_4326, dict):
            bbox = [
                epsg_4326.get("minx"),
                epsg_4326.get("miny"),
                epsg_4326.get("maxx"),
                epsg_4326.get("maxy"),
            ]
            if all(isinstance(value, (int, float)) for value in bbox):
                return [float(value) for value in bbox]

    path = _find_bounds_geojson(uuid)
    if not path or not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    coords: list[list[float]] = []
    if data.get("type") == "FeatureCollection":
        for feature in data.get("features") or []:
            geometry = feature.get("geometry")
            if isinstance(geometry, dict):
                _extract_bbox_from_geometry(geometry, coords)
    elif data.get("type") == "Feature":
        geometry = data.get("geometry")
        if isinstance(geometry, dict):
            _extract_bbox_from_geometry(geometry, coords)
    elif isinstance(data, dict):
        _extract_bbox_from_geometry(data, coords)

    if not coords:
        return None

    longitudes = [p[0] for p in coords]
    latitudes = [p[1] for p in coords]
    if any(abs(value) > 180 for value in longitudes) or any(abs(value) > 90 for value in latitudes):
        return None
    return [
        min(longitudes),
        min(latitudes),
        max(longitudes),
        max(latitudes),
    ]


@router.post("/{uuid}/fetch")
async def fetch_outputs(uuid: str) -> dict[str, Any]:
    """Tamamlanan task'ın çıktılarını NodeODM'den indirip yerele kopyalar."""
    info = await odm.task_info(uuid)
    status = (info.get("status") or {}).get("code")
    if status != 40:
        raise HTTPException(
            409,
            f"Task henüz tamamlanmadı (status={_STATUS_TEXT.get(status)})",
        )

    base_dir = _output_dir(uuid)
    base_dir.mkdir(parents=True, exist_ok=True)

    archive = _output_path(uuid, "all.zip")
    try:
        await odm.download_asset(uuid, "all.zip", archive)
    except NodeODMError as exc:
        raise HTTPException(502, f"NodeODM çıktıları indirilemedi: {exc}") from exc

    try:
        with ZipFile(archive, "r") as zf:
            zf.extractall(base_dir)
    except BadZipFile as exc:
        raise HTTPException(502, "NodeODM all.zip geçerli bir zip değil") from exc

    _clamp_output_glbs(uuid)
    orthophoto = _ensure_orthophoto_alias(uuid)
    orthophoto_tiles = _ensure_orthophoto_tiles(uuid)
    orthophoto_preview = _find_orthophoto_preview(uuid)
    tileset = _ensure_best_tileset(uuid)
    bounds = _bounds_bbox(uuid)

    fetched: dict[str, Any] = {
        "all.zip": str(archive.relative_to(settings.OUTPUT_DIR.parent)),
        "orthophoto": str(orthophoto.relative_to(settings.OUTPUT_DIR)) if orthophoto else None,
        "orthophoto_tiles": str(orthophoto_tiles.relative_to(settings.OUTPUT_DIR)) if orthophoto_tiles else None,
        "orthophoto_preview": str(orthophoto_preview.relative_to(settings.OUTPUT_DIR)) if orthophoto_preview else None,
        "tileset": str(tileset.relative_to(settings.OUTPUT_DIR)) if tileset else None,
        "bounds": bounds,
    }
    return {"uuid": uuid, "fetched": fetched}


@router.get("/{uuid}/orthophoto/url")
async def orthophoto_url(uuid: str) -> dict[str, Any]:
    """Yerelde kayıtlı ortofotoyu HTTP yolu olarak döner."""
    p = _ensure_orthophoto_alias(uuid)
    if not p or not p.exists():
        raise HTTPException(404, "Ortofoto henüz indirilmemiş — /fetch çağır")
    preview = _find_orthophoto_preview(uuid)
    payload: dict[str, Any] = {"url": f"/data/outputs/{uuid}/orthophoto.tif"}
    if preview:
        rel = preview.relative_to(settings.OUTPUT_DIR)
        payload["preview_url"] = f"/data/outputs/{rel.as_posix()}"
    bbox = _bounds_bbox(uuid)
    if bbox:
        payload["bbox"] = bbox
    return payload


@router.get("/{uuid}/tileset/url")
async def tileset_url(uuid: str) -> dict[str, str]:
    tileset = _ensure_best_tileset(uuid)
    if not tileset:
        return {"url": ""}
    rel = tileset.relative_to(settings.OUTPUT_DIR)
    try:
        version = int(tileset.stat().st_mtime_ns)
        try:
            data = json.loads(tileset.read_text(encoding="utf-8"))
            content_uri = (((data or {}).get("root") or {}).get("content") or {}).get("uri")
            if isinstance(content_uri, str) and content_uri.strip():
                content_path = (tileset.parent / content_uri).resolve()
                if content_path.exists():
                    version = max(version, int(content_path.stat().st_mtime_ns))
        except (OSError, json.JSONDecodeError):
            pass
    except OSError:
        version = 0
    return {"url": f"/data/outputs/{rel.as_posix()}?v={version}"}


@router.get("/{uuid}/bounds")
async def bounds(uuid: str) -> dict[str, Any]:
    bbox = _bounds_bbox(uuid)
    if not bbox:
        raise HTTPException(404, "Sınır bilgisi bulunamadı")
    return {"bbox": bbox}
