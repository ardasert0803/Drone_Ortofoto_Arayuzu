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

_USE_CASES = {"construction", "heritage", "generic"}
_DATA_SOURCES = {"drone", "phone", "open_source"}


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


# --------------------------------------------------------------------- #
# Uçlar
# --------------------------------------------------------------------- #
@router.get("", response_model=list[TaskSummary])
async def list_tasks() -> list[TaskSummary]:
    """NodeODM'deki tüm task'ların özetini döner.
    NodeODM down olsa bile 500 atmaz — boş liste döner. (Health bar zaten
    durumun ne olduğunu kullanıcıya söylüyor.)
    """
    try:
        uuids = await odm.list_tasks()
    except NodeODMError as exc:
        # Sessizce boş liste — frontend "Henüz görev yok" gösterir
        print(f"[tasks] NodeODM erişilemez (boş liste dönüyor): {exc}")
        return []

    out: list[TaskSummary] = []
    for u in uuids:
        try:
            info = await odm.task_info(u)
            out.append(_summarize(info))
        except NodeODMError:
            # silinmiş veya hata vermiş bir task — atla
            continue
    # En yeniler üstte
    out.sort(key=lambda t: t.date_created or 0, reverse=True)
    return out


@router.get("/{uuid}", response_model=TaskSummary)
async def get_task(uuid: str) -> TaskSummary:
    try:
        info = await odm.task_info(uuid)
    except NodeODMError as exc:
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

    # Fotoğrafları belleğe oku (büyük setler için disk-temp kullanılabilir,
    # şimdilik sade tutuyoruz)
    files: list[tuple[str, bytes]] = []
    for img in images:
        content = await img.read()
        if not content:
            continue
        files.append((img.filename or "image.jpg", content))

    if not files:
        raise HTTPException(400, "Yüklenen fotoğraflar boş")

    # Yerel kopyasını da sakla — debugging ve timeline için faydalı
    nodeodm_task_name = task_name or datetime.utcnow().strftime("task_%Y%m%d_%H%M%S")
    local_dir = settings.UPLOAD_DIR / _safe_storage_name(nodeodm_task_name)
    local_dir.mkdir(parents=True, exist_ok=True)
    for fname, content in files:
        (local_dir / fname).write_bytes(content)

    # NodeODM'e gönder. Varsayılan options + 3D Tiles üretimi açık olsun.
    options = [
        {"name": "dsm", "value": True},
        {"name": "dtm", "value": True},
        # NodeODM'de 3D tiles üretimi: --3d-tiles bayrağı (sürüme göre)
        {"name": "3d-tiles", "value": True},
        {"name": "auto-boundary", "value": True},
    ]
    try:
        uuid = await odm.create_task(files, name=nodeodm_task_name, options=options)
    except NodeODMError as exc:
        raise HTTPException(502, f"NodeODM görev oluşturamadı: {exc}") from exc

    _write_metadata(
        uuid,
        {
          "use_case": use_case,
          "data_source": data_source,
          "location": location,
          "capture_date": capture_date,
          "description": description,
        },
    )

    return TaskCreated(uuid=uuid, images_uploaded=len(files))


@router.delete("/{uuid}")
async def delete_task(uuid: str) -> dict[str, str]:
    try:
        await odm.remove_task(uuid)
    except NodeODMError as exc:
        raise HTTPException(404, f"Task silinemedi: {exc}") from exc
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
    return _find_first(uuid, "ortho.png", "orthophoto.png")


def _find_tileset(uuid: str) -> Path | None:
    base_dir = _output_dir(uuid)
    direct = base_dir / "3d_tiles" / "tileset.json"
    if direct.exists():
        return direct
    matches = list(base_dir.rglob("tileset.json"))
    return matches[0] if matches else None


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
        return {"url": ""}
    rel = tileset.relative_to(settings.OUTPUT_DIR)
    return {"url": f"/data/outputs/{rel.as_posix()}"}


@router.get("/{uuid}/bounds")
async def bounds(uuid: str) -> dict[str, Any]:
    bbox = _bounds_bbox(uuid)
    if not bbox:
        raise HTTPException(404, "Sınır bilgisi bulunamadı")
    return {"bbox": bbox}
