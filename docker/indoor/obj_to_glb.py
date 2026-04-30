"""Convert a textured OBJ mesh to GLB with Blender."""
from __future__ import annotations

import sys
from pathlib import Path

import bpy


def _reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for item in list(block):
            block.remove(item)


def _import_obj(path: Path) -> None:
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=str(path))
        return
    bpy.ops.import_scene.obj(filepath=str(path))


def _export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_yup=True,
        use_selection=False,
    )


def main(argv: list[str]) -> int:
    if "--" not in argv:
        raise SystemExit("Usage: blender -b -P obj_to_glb.py -- <input.obj> <output.glb>")
    args = argv[argv.index("--") + 1 :]
    if len(args) != 2:
        raise SystemExit("Usage: blender -b -P obj_to_glb.py -- <input.obj> <output.glb>")

    input_path = Path(args[0]).resolve()
    output_path = Path(args[1]).resolve()
    if not input_path.exists():
        raise SystemExit(f"OBJ bulunamadi: {input_path}")

    _reset_scene()
    _import_obj(input_path)
    _export_glb(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
