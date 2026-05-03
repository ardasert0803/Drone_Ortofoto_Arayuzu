"""ODM task'larını yöneten REST router.

Frontend buradaki uçları çağırarak:
  * yeni bir ODM görevi başlatır (drone fotoğraflarını yükler)
  * mevcut görevlerin listesini ve durumunu çeker
  * tamamlanan görevin orthophoto / point cloud çıktısını indirir
NodeODM container'ı Docker'da koşar; biz sadece HTTP üzerinden konuşuruz.
"""
from __future__ import annotations

import json
import shutil
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
        name=info.get("name"),
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

    task_name = _clean_optional(name)
    use_case = _validate_choice(_clean_optional(use_case), _USE_CASES, "use_case")
    data_source = _validate_choice(
        _clean_optional(data_source), _DATA_SOURCES, "data_source"
    )
    location = _clean_optional(location)
    capture_date = _validate_capture_date(capture_date)
    description = _clean_optional(description)
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
          "name": nodeodm_task_name,
          "images_count": len(files),
          "date_created": int(datetime.utcnow().timestamp()),
          "use_case": use_case,
          "data_source": data_source,
          "location": location,
          "capture_date": capture_date,
          "description": description,
          **museum_metadata,
          "pipeline_profile": "quality_gpu",
          "local_upload_dir": str(local_dir),
        },
    )

    return TaskCreated(uuid=uuid, images_uploaded=len(files))


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


def _generate_tileset_fallback(uuid: str) -> Path | None:
    point_cloud = _find_point_cloud(uuid)
    if not point_cloud or not point_cloud.exists():
        return None

    target_dir = _output_dir(uuid) / "3d_tiles"
    target_tileset = target_dir / "tileset.json"
    if target_tileset.exists():
        return target_tileset

    rel_input = point_cloud.relative_to(settings.OUTPUT_DIR)
    container_input = f"/data/{rel_input.as_posix()}"
    container_output = f"/data/{uuid}/3d_tiles"

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

    shutil.rmtree(target_dir, ignore_errors=True)
    target_dir.mkdir(parents=True, exist_ok=True)

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
        return None

    return target_tileset if target_tileset.exists() else None


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

    orthophoto = _ensure_orthophoto_alias(uuid)
    orthophoto_tiles = _ensure_orthophoto_tiles(uuid)
    orthophoto_preview = _find_orthophoto_preview(uuid)
    tileset = _find_tileset(uuid)
    if not tileset:
        tileset = _extract_tiles_archive(uuid)
    if not tileset:
        tileset = _generate_tileset_fallback(uuid)
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
    tileset = _find_tileset(uuid)
    if not tileset:
        tileset = _extract_tiles_archive(uuid)
    if not tileset:
        tileset = _generate_tileset_fallback(uuid)
    if not tileset:
        return {"url": ""}
    rel = tileset.relative_to(settings.OUTPUT_DIR)
    return {"url": f"/data/outputs/{rel.as_posix()}"}


@router.get("/{uuid}/bounds")
async def bounds(uuid: str) -> dict[str, Any]:
    bbox = _bounds_bbox(uuid)
    if not bbox:
        raise HTTPException(404, "Sınır bilgisi bulunamadı")
    return {"bbox": bbox}
