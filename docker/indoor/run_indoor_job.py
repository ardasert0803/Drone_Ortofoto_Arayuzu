"""Run the indoor COLMAP/OpenMVS reconstruction pipeline for one manifest."""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

STATUS_QUEUED = 10
STATUS_RUNNING = 20
STATUS_FAILED = 30
STATUS_COMPLETED = 40


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _project_root(manifest_path: Path) -> Path:
    if "/workspace/" in manifest_path.as_posix():
        return Path("/workspace")
    return manifest_path.parents[4] if len(manifest_path.parents) >= 5 else manifest_path.parent


def _resolve_path(manifest: dict[str, Any], key: str, fallback_key: str, project_root: Path) -> Path:
    rel = manifest.get(key)
    if rel:
        return (project_root / str(rel)).resolve()
    raw = manifest.get(fallback_key)
    if not raw:
        raise RuntimeError(f"Eksik manifest alani: {key} / {fallback_key}")
    return Path(str(raw)).resolve()


def _merge_state(state_path: Path, **updates: Any) -> dict[str, Any]:
    current = {}
    if state_path.exists():
        current = _load_json(state_path)
    current.update(updates)
    _write_json(state_path, current)
    return current


def _log(message: str) -> None:
    print(f"[{_now_iso()}] {message}", flush=True)


def _run(command: list[str], *, stage: str, progress: float, state_path: Path, cwd: Path | None = None) -> None:
    _merge_state(
        state_path,
        status=STATUS_RUNNING,
        status_text="RUNNING",
        stage=stage,
        progress=progress,
    )
    _log(f"{stage}: {' '.join(command)}")
    subprocess.run(command, check=True, cwd=str(cwd) if cwd else None)  # noqa: S603


def _copy_matching_files(source_dir: Path, destination_dir: Path, stems: Iterable[str]) -> None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    prefixes = {Path(stem).stem for stem in stems}
    for path in source_dir.iterdir():
        if not path.is_file():
            continue
        if any(path.name.startswith(prefix) for prefix in prefixes):
            shutil.copy2(path, destination_dir / path.name)


def _find_textured_obj(directory: Path) -> Path:
    candidates = sorted(directory.glob("*.obj"))
    if not candidates:
        raise RuntimeError("TextureMesh ciktisinda OBJ bulunamadi")
    preferred = [path for path in candidates if "texture" in path.stem.lower()]
    return preferred[-1] if preferred else candidates[-1]


def _write_minimal_glb(path: Path) -> None:
    positions = [
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    ]
    indices = [0, 1, 2]
    pos_blob = struct.pack("<9f", *positions)
    idx_blob = struct.pack("<3H", *indices)
    bin_blob = pos_blob + idx_blob
    while len(bin_blob) % 4:
        bin_blob += b"\x00"

    json_chunk = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_blob), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_blob), "byteLength": len(idx_blob), "target": 34963},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "max": [1.0, 1.0, 0.0],
                "min": [0.0, 0.0, 0.0],
            },
            {
                "bufferView": 1,
                "componentType": 5123,
                "count": 3,
                "type": "SCALAR",
                "max": [2],
                "min": [0],
            },
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
        "scene": 0,
    }
    json_blob = json.dumps(json_chunk, separators=(",", ":")).encode("utf-8")
    while len(json_blob) % 4:
        json_blob += b" "

    total_length = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, total_length))
        handle.write(struct.pack("<I4s", len(json_blob), b"JSON"))
        handle.write(json_blob)
        handle.write(struct.pack("<I4s", len(bin_blob), b"BIN\x00"))
        handle.write(bin_blob)


def _write_fallback_tileset(path: Path, model_name: str) -> None:
    payload = {
        "asset": {"version": "1.1"},
        "geometricError": 0,
        "root": {
            "boundingVolume": {
                "box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
            },
            "geometricError": 0,
            "refine": "ADD",
            "content": {"uri": model_name},
        },
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _run_mock_pipeline(output_dir: Path, manifest_path: Path, state_path: Path) -> None:
    mesh_dir = output_dir / "mesh"
    glb_dir = output_dir / "glb"
    tiles_dir = output_dir / "tiles"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    glb_dir.mkdir(parents=True, exist_ok=True)
    tiles_dir.mkdir(parents=True, exist_ok=True)

    _merge_state(state_path, status=STATUS_RUNNING, status_text="RUNNING", stage="mesh", progress=65.0)
    (mesh_dir / "mock_mesh.obj").write_text(
        "o MockMesh\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        encoding="utf-8",
    )
    time.sleep(0.1)

    _merge_state(state_path, status=STATUS_RUNNING, status_text="RUNNING", stage="glb", progress=82.0)
    glb_path = glb_dir / "indoor_model.glb"
    _write_minimal_glb(glb_path)
    shutil.copy2(glb_path, tiles_dir / glb_path.name)
    time.sleep(0.1)

    _merge_state(state_path, status=STATUS_RUNNING, status_text="RUNNING", stage="tiles", progress=94.0)
    _write_fallback_tileset(tiles_dir / "tileset.json", glb_path.name)
    shutil.copy2(manifest_path, output_dir / "manifest.json")


def _build_real_pipeline(manifest: dict[str, Any], manifest_path: Path, state_path: Path) -> None:
    project_root = _project_root(manifest_path)
    images_dir = _resolve_path(manifest, "upload_dir_rel", "upload_dir", project_root)
    workspace_dir = _resolve_path(manifest, "workspace_dir_rel", "workspace_dir", project_root)
    output_dir = _resolve_path(manifest, "output_dir_rel", "output_dir", project_root)

    recon_dir = workspace_dir / "recon"
    colmap_db = recon_dir / "colmap" / "database.db"
    sparse_dir = recon_dir / "sparse"
    dense_dir = recon_dir / "dense"
    mvs_dir = recon_dir / "openmvs"
    mesh_dir = output_dir / "mesh"
    glb_dir = output_dir / "glb"
    tiles_dir = output_dir / "tiles"
    recon_dir.mkdir(parents=True, exist_ok=True)
    sparse_dir.mkdir(parents=True, exist_ok=True)
    dense_dir.mkdir(parents=True, exist_ok=True)
    mvs_dir.mkdir(parents=True, exist_ok=True)
    mesh_dir.mkdir(parents=True, exist_ok=True)
    glb_dir.mkdir(parents=True, exist_ok=True)
    tiles_dir.mkdir(parents=True, exist_ok=True)

    _run(
        [
            "colmap",
            "feature_extractor",
            "--database_path",
            str(colmap_db),
            "--image_path",
            str(images_dir),
            "--ImageReader.single_camera",
            "1",
            "--SiftExtraction.use_gpu",
            "0",
        ],
        stage="features",
        progress=10.0,
        state_path=state_path,
    )
    _run(
        [
            "colmap",
            "exhaustive_matcher",
            "--database_path",
            str(colmap_db),
            "--SiftMatching.use_gpu",
            "0",
        ],
        stage="matching",
        progress=22.0,
        state_path=state_path,
    )
    _run(
        [
            "colmap",
            "mapper",
            "--database_path",
            str(colmap_db),
            "--image_path",
            str(images_dir),
            "--output_path",
            str(sparse_dir),
        ],
        stage="sparse",
        progress=34.0,
        state_path=state_path,
    )

    sparse_zero = sparse_dir / "0"
    if not sparse_zero.exists():
        raise RuntimeError("COLMAP sparse model uretmedi")

    _run(
        [
            "colmap",
            "image_undistorter",
            "--image_path",
            str(images_dir),
            "--input_path",
            str(sparse_zero),
            "--output_path",
            str(dense_dir),
            "--output_type",
            "COLMAP",
        ],
        stage="dense",
        progress=46.0,
        state_path=state_path,
    )
    _run(
        [
            "colmap",
            "patch_match_stereo",
            "--workspace_path",
            str(dense_dir),
            "--workspace_format",
            "COLMAP",
            "--PatchMatchStereo.geom_consistency",
            "true",
        ],
        stage="dense",
        progress=54.0,
        state_path=state_path,
    )
    _run(
        [
            "colmap",
            "stereo_fusion",
            "--workspace_path",
            str(dense_dir),
            "--workspace_format",
            "COLMAP",
            "--input_type",
            "geometric",
            "--output_path",
            str(dense_dir / "fused.ply"),
        ],
        stage="dense",
        progress=60.0,
        state_path=state_path,
    )

    _run(
        [
            "InterfaceCOLMAP",
            "-i",
            str(dense_dir),
            "-o",
            str(mvs_dir / "scene.mvs"),
        ],
        stage="mesh",
        progress=68.0,
        state_path=state_path,
    )
    _run(
        [
            "DensifyPointCloud",
            "-i",
            str(mvs_dir / "scene.mvs"),
            "-o",
            "scene_dense.mvs",
            "-w",
            str(mvs_dir),
        ],
        stage="mesh",
        progress=74.0,
        state_path=state_path,
    )
    _run(
        [
            "ReconstructMesh",
            "-i",
            str(mvs_dir / "scene_dense.mvs"),
            "-o",
            "scene_dense_mesh.mvs",
            "-w",
            str(mvs_dir),
        ],
        stage="mesh",
        progress=80.0,
        state_path=state_path,
    )
    _run(
        [
            "RefineMesh",
            "-i",
            str(mvs_dir / "scene_dense.mvs"),
            "-m",
            "scene_dense_mesh.ply",
            "-o",
            "scene_dense_mesh_refine.mvs",
            "-w",
            str(mvs_dir),
        ],
        stage="mesh",
        progress=86.0,
        state_path=state_path,
        cwd=mvs_dir,
    )
    _run(
        [
            "TextureMesh",
            "-i",
            str(mvs_dir / "scene_dense.mvs"),
            "-m",
            "scene_dense_mesh_refine.ply",
            "-o",
            "scene_dense_mesh_refine_texture.mvs",
            "-w",
            str(mvs_dir),
        ],
        stage="texture",
        progress=90.0,
        state_path=state_path,
        cwd=mvs_dir,
    )

    textured_obj = _find_textured_obj(mvs_dir)
    _copy_matching_files(mvs_dir, mesh_dir, [textured_obj.name])

    _run(
        [
            "blender",
            "-b",
            "-P",
            "/app/scripts/obj_to_glb.py",
            "--",
            str(textured_obj),
            str(glb_dir / "indoor_model.glb"),
        ],
        stage="glb",
        progress=94.0,
        state_path=state_path,
    )

    shutil.copy2(glb_dir / "indoor_model.glb", tiles_dir / "indoor_model.glb")
    tileset_json = tiles_dir / "tileset.json"
    try:
        _run(
            [
                "npx",
                "--yes",
                "3d-tiles-tools",
                "createTilesetJson",
                "-i",
                str(tiles_dir / "indoor_model.glb"),
                "-o",
                str(tileset_json),
            ],
            stage="tiles",
            progress=98.0,
            state_path=state_path,
        )
    except (OSError, subprocess.CalledProcessError):
        _log("3d-tiles-tools basarisiz oldu, fallback tileset.json yaziliyor")
        _write_fallback_tileset(tileset_json, "indoor_model.glb")

    shutil.copy2(manifest_path, output_dir / "manifest.json")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit("Usage: run_indoor_job.py <manifest.json>")

    manifest_path = Path(argv[1]).resolve()
    if not manifest_path.exists():
        raise SystemExit(f"Manifest bulunamadi: {manifest_path}")

    manifest = _load_json(manifest_path)
    state_path = manifest_path.with_name("state.json")
    output_dir = _resolve_path(manifest, "output_dir_rel", "output_dir", _project_root(manifest_path))
    output_dir.mkdir(parents=True, exist_ok=True)

    _merge_state(
        state_path,
        status=STATUS_RUNNING,
        status_text="RUNNING",
        stage="upload",
        progress=3.0,
        started_at=_load_json(state_path).get("started_at") or _now_iso(),
        error_summary=None,
        finished_at=None,
    )

    try:
        if os.getenv("INDOOR_RECON_MOCK", "0") == "1":
            _log("INDOOR_RECON_MOCK=1, placeholder pipeline calistiriliyor")
            _run_mock_pipeline(output_dir, manifest_path, state_path)
        else:
            _build_real_pipeline(manifest, manifest_path, state_path)
        _merge_state(
            state_path,
            status=STATUS_COMPLETED,
            status_text="COMPLETED",
            stage="done",
            progress=100.0,
            finished_at=_now_iso(),
            error_summary=None,
            launcher_pid=None,
        )
        _log("indoor pipeline tamamlandi")
        return 0
    except Exception as exc:  # noqa: BLE001
        _merge_state(
            state_path,
            status=STATUS_FAILED,
            status_text="FAILED",
            finished_at=_now_iso(),
            error_summary=str(exc),
            launcher_pid=None,
        )
        _log(f"pipeline basarisiz: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
