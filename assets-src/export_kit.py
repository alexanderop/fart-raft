"""Exports the `kit` collection to public/models/kit.glb.

Run inside Blender after build_kit.py:
    exec(open("/path/to/assets-src/export_kit.py").read())
Top-level objects are laid out in a row for viewing; the export moves each to the origin
so the client can clone and place them directly, then restores the layout.
"""

import os

import bpy

OUT = os.path.join(os.path.dirname(bpy.data.filepath), "..", "public", "models", "kit.glb")

roots = [o for o in bpy.data.collections["kit"].objects if o.parent is None]
saved = {o.name: o.location.copy() for o in roots}
for o in roots:
    o.location = (0, 0, 0)

bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.collections["kit"].objects:
    o.select_set(True)
try:
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=False,
    )
finally:
    for o in roots:
        o.location = saved[o.name]
    bpy.ops.object.select_all(action="DESELECT")

print("exported", os.path.abspath(OUT), os.path.getsize(OUT), "bytes,", len(roots), "assets")
