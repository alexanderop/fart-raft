"""Builds every game asset procedurally into the `kit` collection.

Run inside Blender (MCP or Text editor):
    exec(open("/path/to/assets-src/build_kit.py").read())
Rebuilds from scratch each run. Export with export_kit.py.

Axes: Blender X = sim forward (+x), Y = sim left (+y), Z = up. Origins sit at base center
on the water plane (z = 0) unless noted. The client relies on the names and sizes below.
"""

import math
import os
import random

import bpy
from mathutils import Matrix, Vector

KIT = "kit"
SIGN_FONT = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"  # falls back to Bfont
SEATS = [(-1.0, 0.8), (-1.0, -0.8), (1.0, 0.8), (1.0, -0.8)]

# ── scene helpers ──────────────────────────────────────────────────────────────


def srgb(h):
    """Hex sRGB → linear RGB tuple."""

    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(ch(h >> s & 255) for s in (16, 8, 0))


def mat(name, hexcol, rough=0.75):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0
    m.diffuse_color = (*srgb(hexcol), 1)
    return m


def kit_collection():
    col = bpy.data.collections.get(KIT)
    if col:
        for o in list(col.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        col = bpy.data.collections.new(KIT)
        bpy.context.scene.collection.children.link(col)
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)
    return col


def _finish(o, material, smooth):
    col = bpy.data.collections[KIT]
    for c in list(o.users_collection):
        c.objects.unlink(o)
    col.objects.link(o)
    if material:
        o.data.materials.append(material)
    for p in o.data.polygons:
        p.use_smooth = smooth
    return o


def sphere(loc, scale, material, seg=16, rings=10, smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1, location=loc)
    o = bpy.context.object
    o.scale = scale
    return _finish(o, material, smooth)


def ico(loc, r, material, sub=1, scale=(1, 1, 1), smooth=False):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = bpy.context.object
    o.scale = scale
    return _finish(o, material, smooth)


def cyl(loc, r, depth, material, verts=12, rot=(0, 0, 0), smooth=True, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc, rotation=rot)
    o = bpy.context.object
    o = _finish(o, material, smooth)
    for p in o.data.polygons:  # flat caps
        if len(p.vertices) > 4:
            p.use_smooth = False
    return o


def box(loc, size, material, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    o = _finish(o, material, False)
    if bevel:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(scale=True)
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return o


def torus(loc, major, minor, material, rot=(0, 0, 0), scale=(1, 1, 1), seg=32, mseg=10):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=seg, minor_segments=mseg, location=loc, rotation=rot
    )
    o = bpy.context.object
    o.scale = scale
    return _finish(o, material, True)


def join(name, parts, parent=None, location=(0, 0, 0)):
    """Bake transforms, join parts into one mesh object named `name` with origin at `location`."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(parts) > 1:
        bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    o.data.name = name
    o.data.transform(Matrix.Translation(-Vector(location)))
    o.location = location
    if parent:
        o.parent = parent
        o.location = Vector(location) - parent.location
    o.select_set(False)
    return o


# ── palette (sampled from the Fart Together key art) ───────────────────────────

M = {}


def palette():
    M.update(
        ring=mat("ring_peach", 0xF6B26B, 0.45),
        ring_low=mat("ring_cyan", 0x38C6E8, 0.45),
        ring_stripe=mat("ring_cream", 0xFFF1D6, 0.5),
        floor=mat("raft_floor", 0xF2D2A2, 0.6),
        rope=mat("rope", 0xE9D3A0, 0.95),
        white=mat("eye_white", 0xFFFFFF, 0.3),
        pupil=mat("pupil", 0x111111, 0.2),
        nostril=mat("nostril", 0x2A2030, 0.6),
        blush=mat("blush", 0xFF8FA3, 0.6),
        tooth=mat("tooth", 0xFFFBEA, 0.4),
        bamboo=mat("bamboo", 0x7CC444, 0.5),
        bamboo_node=mat("bamboo_node", 0x4E9A2A, 0.5),
        bamboo_hi=mat("bamboo_hi", 0xA6DD62, 0.5),
        rock=mat("rock", 0x5E5F66, 0.9),
        rock_hi=mat("rock_top", 0x7C7D85, 0.9),
        bark=mat("bark", 0x6B4A3A, 0.9),
        leaf=mat("leaf", 0x3E9E2E, 0.8),
        leaf_hi=mat("leaf_light", 0x63BE3A, 0.8),
        leaf_dk=mat("leaf_dark", 0x2D7A25, 0.8),
        fern=mat("fern", 0xC9D93C, 0.7),
        grass=mat("grass", 0x7FCB45, 0.8),
        lily=mat("lily", 0x3FA34A, 0.6),
        petal=mat("petal", 0xF59AB0, 0.6),
        petal_c=mat("petal_center", 0xFFD65C, 0.6),
        cattail=mat("cattail", 0x7A4B2A, 0.9),
        post=mat("post_pink", 0xF27FB8, 0.5),
        bulb=mat("bulb", 0xFFF6E0, 0.2),
        sign=mat("sign_board", 0xFFF3D9, 0.7),
        sign_frame=mat("sign_frame", 0xF27FB8, 0.5),
        ink=mat("sign_ink", 0x2E7D4F, 0.6),
        ink_finish=mat("sign_ink_finish", 0xE0457B, 0.6),
        check_dark=mat("checker_dark", 0x222222, 0.6),
        spin_a=mat("spinner_pink", 0xF0609E, 0.45),
        spin_b=mat("spinner_white", 0xFFF6EE, 0.45),
        spin_cap=mat("spinner_cap", 0xFFC93C, 0.45),
    )


# ── raft + riders ──────────────────────────────────────────────────────────────

ANIMALS = [  # seat order: rear-left, rear-right, front-left, front-right
    ("capybara", 0xE8954F, 0xF4C38E),
    ("hippo", 0x4F8FD6, 0x9CC8F2),
    ("hippo", 0x8B7FB8, 0xC4B9E3),
    ("croc", 0x5DB548, 0xD8E67E),
]
RING_Z = 0.62  # top tube center
RIDER_Z = 0.86  # riders sit on the rim
RIDER_INSET = 0.75  # pull riders onto the ring tube (sim seats sit near its outer edge)
RIDER_SCALE = 1.3  # read well from the chase camera
NECK = (0.05, 0.0, 0.78)  # head pivot, rider space before RIDER_SCALE
SHOULDER = (0.12, 0.3, 0.64)  # arm pivot (mirrored in y)


def eyes(x, z, spread, r, parts, look=0.06):
    for s in (1, -1):
        parts.append(sphere((x, s * spread, z), (r, r, r), M["white"], 12, 8))
        parts.append(sphere((x + r * 0.75, s * spread, z + r * 0.15), (r * 0.5, r * 0.55, r * 0.55), M["pupil"], 10, 6))


def tag(o, part):
    o["part"] = part
    return o


def seated_body(body, belly, parts, wide=1.0):
    """Body parts are tagged so build_raft can split body / head / arms into animatable pieces."""
    parts.append(tag(sphere((0, 0, 0.4), (0.36 * wide, 0.34 * wide, 0.42), body), "body"))
    parts.append(tag(sphere((0.13, 0, 0.36), (0.26, 0.26 * wide, 0.32), belly), "body"))
    for s in (1, -1):
        parts.append(tag(sphere((0.28, s * 0.16, 0.1), (0.17, 0.11, 0.1), body, 12, 8), "body"))  # feet
        arm = sphere((0.12, s * SHOULDER[1] * wide, 0.5), (0.09, 0.08, 0.17), body, 12, 8)
        parts.append(tag(arm, "arm_l" if s > 0 else "arm_r"))


def hippo(body, belly):
    parts = []
    seated_body(body, belly, parts, wide=1.1)
    parts.append(sphere((0.04, 0, 0.98), (0.3, 0.3, 0.26), body))
    parts.append(sphere((0.26, 0, 0.86), (0.27, 0.33, 0.2), belly))
    for s in (1, -1):
        parts.append(sphere((0.49, s * 0.11, 0.93), (0.03, 0.04, 0.03), M["nostril"], 8, 6))
        parts.append(sphere((-0.04, s * 0.22, 1.2), (0.05, 0.07, 0.07), body, 10, 6))  # ears
        parts.append(box((0.47, s * 0.08, 0.72), (0.05, 0.06, 0.07), M["tooth"]))
        parts.append(sphere((0.24, s * 0.26, 0.98), (0.04, 0.06, 0.03), M["blush"], 8, 6))
    eyes(0.14, 1.16, 0.13, 0.085, parts)
    return parts


def croc(body, belly):
    parts = []
    seated_body(body, belly, parts)
    parts.append(sphere((0.02, 0, 0.98), (0.26, 0.25, 0.22), body))
    parts.append(sphere((0.34, 0, 0.9), (0.42, 0.21, 0.12), body))  # upper jaw
    parts.append(sphere((0.3, 0, 0.8), (0.36, 0.19, 0.08), belly))  # lower jaw
    for s in (1, -1):
        parts.append(sphere((0.09, s * 0.12, 1.12), (0.1, 0.1, 0.09), body, 12, 8))  # eye bumps
        parts.append(sphere((0.7, s * 0.06, 0.98), (0.04, 0.04, 0.03), body, 8, 6))
        for i in range(4):  # teeth
            parts.append(cyl((0.38 + i * 0.09, s * 0.17, 0.83), 0.025, 0.06, M["tooth"], 5, rot=(math.pi, 0, 0), r2=0.0))
    eyes(0.15, 1.15, 0.12, 0.075, parts)
    for i in range(5):  # back ridge
        z = 0.28 + i * 0.15
        ridge = cyl((-0.34 + i * 0.012, 0, z), 0.06, 0.14, belly, 4, rot=(0, -math.pi / 2, 0), r2=0.0, smooth=False)
        parts.append(tag(ridge, "body"))
    return parts


def capybara(body, belly):
    parts = []
    seated_body(body, belly, parts, wide=1.05)
    parts.append(sphere((0.1, 0, 0.98), (0.3, 0.25, 0.25), body))
    parts.append(sphere((0.34, 0, 0.92), (0.22, 0.21, 0.19), body))
    parts.append(sphere((0.52, 0, 0.96), (0.06, 0.12, 0.08), M["nostril"], 10, 6))
    for s in (1, -1):
        parts.append(sphere((-0.02, s * 0.18, 1.2), (0.05, 0.06, 0.06), M["nostril"], 10, 6))
        parts.append(sphere((0.3, s * 0.2, 0.92), (0.04, 0.05, 0.03), M["blush"], 8, 6))
    eyes(0.3, 1.08, 0.15, 0.06, parts)
    parts.append(sphere((0.0, 0.0, 1.24), (0.1, 0.08, 0.06), belly, 10, 6))  # tuft
    return parts


def build_raft():
    lower = torus((0, 0, 0.22), 1.12, 0.3, M["ring_low"], scale=(1, 0.8, 1))
    upper = torus((0, 0, RING_Z), 1.1, 0.3, M["ring"], scale=(1, 0.8, 1))
    stripe = torus((0, 0, RING_Z + 0.02), 1.1, 0.305, M["ring_stripe"], scale=(1, 0.8, 0.25), mseg=12)
    floor = cyl((0, 0, 0.32), 1.15, 0.14, M["floor"], 32)
    floor.scale = (1, 0.8, 1)
    parts = [lower, upper, stripe, floor]
    for i in range(10):  # rope handles on the lower ring
        a = i / 10 * math.tau + 0.3
        x, y = math.cos(a) * 1.42, math.sin(a) * 1.42 * 0.8
        parts.append(torus((x, y, 0.22), 0.11, 0.025, M["rope"], rot=(math.pi / 2, 0, a + math.pi / 2), seg=12, mseg=5))
    raft = join("raft", parts)
    builders = {"hippo": hippo, "croc": croc, "capybara": capybara}
    for i, ((sx, sy), (kind, body, belly)) in enumerate(zip(SEATS, ANIMALS)):
        mb = mat(f"rider_{i}", body, 0.55)
        ml = mat(f"rider_{i}_belly", belly, 0.6)
        parts = builders[kind](mb, ml)
        loc = Vector((sx * RIDER_INSET, sy * RIDER_INSET, RIDER_Z))
        for p in parts:
            p.location = loc + p.location * RIDER_SCALE
            p.scale *= RIDER_SCALE
        groups = {"body": [], "head": [], "arm_l": [], "arm_r": []}
        for p in parts:
            groups[p.get("part", "head")].append(p)
        # rider_i (body, pivot on the seat) → rider_i_head (pivot at neck), rider_i_arm_l/r (pivot at shoulder)
        rider = join(f"rider_{i}", groups["body"], parent=raft, location=loc)
        join(f"rider_{i}_head", groups["head"], parent=rider, location=loc + Vector(NECK) * RIDER_SCALE)
        for side, sgn in (("arm_l", 1), ("arm_r", -1)):
            pivot = Vector((SHOULDER[0], sgn * SHOULDER[1], SHOULDER[2])) * RIDER_SCALE
            join(f"rider_{i}_{side}", groups[side], parent=rider, location=loc + pivot)
    return raft


# ── environment ────────────────────────────────────────────────────────────────


def build_rim():
    """Bamboo tube lining every bank. 2 m along X, tiled by the client."""
    r, z = 0.35, 0.35
    parts = [cyl((0, 0, z), r, 2.0, M["bamboo"], 14, rot=(0, math.pi / 2, 0))]
    for x in (-0.98, 0.98):
        parts.append(cyl((x, 0, z), r * 1.07, 0.06, M["bamboo_node"], 14, rot=(0, math.pi / 2, 0)))
    parts.append(cyl((0, 0, z + r * 0.62), r * 0.45, 1.8, M["bamboo_hi"], 10, rot=(0, math.pi / 2, 0)))
    parts[-1].scale = (1, 1, 0.35)
    return join("rim", parts)


def build_rock(name="rock", seed=1):
    """Grey columnar rock, footprint 2 x 2, ~2 high."""
    rnd = random.Random(seed)
    parts = []
    cols = [(-0.35, 0.3, 1.0, 1.9), (0.35, 0.25, 0.9, 1.5), (0.0, -0.4, 1.0, 1.2), (-0.45, -0.35, 0.7, 0.9), (0.45, -0.3, 0.7, 0.8)]
    for x, y, w, h in cols:
        rot = (rnd.uniform(-0.08, 0.08), rnd.uniform(-0.08, 0.08), rnd.uniform(0, 1.2))
        o = cyl((x, y, h / 2 - 0.2), w * 0.55, h + 0.4, M["rock"], 6, rot=rot, smooth=False, r2=w * 0.45)
        parts.append(o)
        top = cyl((x, y, h + 0.0), w * 0.46, 0.06, M["rock_hi"], 6, rot=rot, smooth=False)
        parts.append(top)
    return join(name, parts)


def build_spinner():
    """Candy-striped log, 2 long on X, radius 1, centred at origin. Client scales (hx, hy, hy)."""
    parts = []
    n = 8
    for i in range(n):
        x = -1 + (i + 0.5) * 2 / n
        parts.append(cyl((x, 0, 0), 1.0, 2 / n, M["spin_a"] if i % 2 else M["spin_b"], 16, rot=(0, math.pi / 2, 0)))
    for x in (-1.0, 1.0):
        parts.append(sphere((x, 0, 0), (0.12, 0.85, 0.85), M["spin_cap"], 16, 8))
    parts.append(cyl((0, 0, 0), 0.5, 2.4, M["spin_cap"], 12))  # hub
    return join("spinner", parts)


def build_gate():
    parts = [cyl((0, 0, 2.5), 0.22, 5.0, M["post"], 12)]
    for i in range(9):
        a = i * 1.7
        parts.append(sphere((math.cos(a) * 0.22, math.sin(a) * 0.22, 0.5 + i * 0.5), (0.09, 0.09, 0.09), M["bulb"], 8, 6))
    parts.append(sphere((0, 0, 5.1), (0.35, 0.35, 0.35), M["bulb"]))
    join("gate_post", parts)
    for name, label, ink in (("gate_sign", "CHECKPOINT", M["ink"]), ("finish_sign", "FINISH", M["ink_finish"])):
        board = [box((0, 0, 0), (6.0, 0.18, 1.2), M["sign"], bevel=0.05)]
        board.append(box((0, 0, 0), (6.25, 0.14, 1.45), M["sign_frame"], bevel=0.06))
        if name == "finish_sign":
            for k in range(12):  # checker trim along the top
                board.append(box((-2.75 + k * 0.5, 0, 0.82), (0.5, 0.16, 0.25), M["check_dark"] if k % 2 else M["bulb"]))
        for side in (1, -1):
            bpy.ops.object.text_add(location=(0, side * 0.1, 0), rotation=(math.pi / 2, 0, 0 if side < 0 else math.pi))
            t = bpy.context.object
            t.data.body = label
            if os.path.exists(SIGN_FONT):
                t.data.font = bpy.data.fonts.load(SIGN_FONT, check_existing=True)
            t.data.align_x = "CENTER"
            t.data.align_y = "CENTER"
            t.data.size = 0.85 if label == "FINISH" else 0.72
            t.data.extrude = 0.02
            bpy.ops.object.convert(target="MESH")
            board.append(_finish(bpy.context.object, ink, False))
        join(name, board)


def build_tree(name, seed, tall):
    rnd = random.Random(seed)
    h = 3.6 if tall else 2.4
    parts = [cyl((0, 0, h / 2), 0.22, h, M["bark"], 8, r2=0.14)]
    parts.append(cyl((0.25, 0, h * 0.62), 0.07, 1.0, M["bark"], 6, rot=(0, 0.8, 0)))
    blobs = 7 if tall else 6
    for i in range(blobs):
        a = i / blobs * math.tau
        rr = rnd.uniform(0.5, 0.9) if i else 0
        z = h + rnd.uniform(-0.2, 0.7)
        r = rnd.uniform(0.7, 1.0) * (1.0 if tall else 1.25)
        m = M["leaf_hi"] if z > h + 0.35 else M["leaf"]
        parts.append(ico((math.cos(a) * rr, math.sin(a) * rr, z), r, m, 2, scale=(1, 1, 0.8), smooth=False))
    parts.append(ico((0, 0, h + 1.0), 0.8, M["leaf_hi"], 2, scale=(1, 1, 0.75)))
    if tall:  # second, lower canopy tier like the key art
        for i in range(4):
            a = i / 4 * math.tau + 0.4
            parts.append(ico((math.cos(a) * 0.9, math.sin(a) * 0.9, h * 0.62), 0.55, M["leaf_dk"], 2, scale=(1, 1, 0.7)))
    return join(name, parts)


def build_bush():
    parts = []
    for x, y, r, m in ((0, 0, 0.9, "leaf"), (0.7, 0.3, 0.6, "leaf_hi"), (-0.6, 0.4, 0.65, "leaf"), (0.1, -0.6, 0.6, "leaf_dk"), (0, 0, 0.6, "leaf_hi")):
        parts.append(ico((x, y, r * 0.7 + (0.5 if r == 0.6 and x == 0 else 0)), r, M[m], 2, scale=(1, 1, 0.85)))
    return join("bush", parts)


def build_bamboo():
    parts = []
    for x, y, h in ((0, 0, 3.2), (0.3, 0.15, 2.6), (-0.15, 0.3, 2.9), (0.2, -0.25, 2.2)):
        parts.append(cyl((x, y, h / 2), 0.09, h, M["bamboo"], 8))
        for k in range(1, int(h / 0.7) + 1):
            parts.append(cyl((x, y, k * 0.7), 0.1, 0.05, M["bamboo_node"], 8))
        parts.append(cyl((x + 0.15, y, h * 0.8), 0.12, 0.02, M["leaf_hi"], 4, rot=(0, 0.5, 0.4), smooth=False))
    return join("bamboo", parts)


def build_reeds():
    rnd = random.Random(4)
    parts = []
    for i in range(6):
        x, y = rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3)
        h = rnd.uniform(1.0, 1.6)
        tilt = (rnd.uniform(-0.12, 0.12), rnd.uniform(-0.12, 0.12), 0)
        parts.append(cyl((x, y, h / 2), 0.025, h, M["grass"], 5, rot=tilt))
        if i % 2 == 0:
            parts.append(cyl((x + tilt[1] * h, y - tilt[0] * h, h), 0.06, 0.3, M["cattail"], 8, rot=tilt))
    for i in range(5):
        a = i / 5 * math.tau
        parts.append(cyl((math.cos(a) * 0.15, math.sin(a) * 0.15, 0.45), 0.08, 0.9, M["grass"], 3, rot=(math.sin(a) * 0.3, -math.cos(a) * 0.3, a), smooth=False, r2=0.0))
    return join("reeds", parts)


def build_fern():
    parts = []
    for i in range(7):
        a = i / 7 * math.tau
        leaf = sphere((math.cos(a) * 0.45, math.sin(a) * 0.45, 0.3), (0.5, 0.12, 0.04), M["fern"], 8, 4, smooth=False)
        leaf.rotation_euler = (0, -0.5, a)
        parts.append(leaf)
    parts.append(sphere((0, 0, 0.1), (0.15, 0.15, 0.15), M["leaf"], 8, 4))
    return join("fern", parts)


def build_grass():
    rnd = random.Random(9)
    parts = []
    for i in range(7):
        a = rnd.uniform(0, math.tau)
        rr = rnd.uniform(0, 0.15)
        h = rnd.uniform(0.35, 0.6)
        parts.append(cyl((math.cos(a) * rr, math.sin(a) * rr, h / 2), 0.05, h, M["grass"], 3, rot=(rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), a), smooth=False, r2=0.0))
    return join("grass", parts)


def build_lily():
    pad = cyl((0, 0, 0.02), 0.6, 0.04, M["lily"], 16)
    for v in pad.data.vertices:  # notch
        if v.co.x > 0.3 and abs(v.co.y) < 0.25:
            v.co.x *= 0.15
    parts = [pad]
    for i in range(6):
        a = i / 6 * math.tau
        p = sphere((math.cos(a) * 0.12, math.sin(a) * 0.12, 0.12), (0.14, 0.07, 0.1), M["petal"], 8, 4)
        p.rotation_euler = (0, -0.6, a)
        parts.append(p)
    parts.append(sphere((0, 0, 0.12), (0.06, 0.06, 0.05), M["petal_c"], 8, 4))
    return join("lily", parts)


# ── build everything, laid out in a row for viewing (export zeroes positions) ──


def build_all():
    kit_collection()
    palette()
    made = [
        build_raft(),
        build_rim(),
        build_rock(),
        build_spinner(),
        build_tree("tree_a", 3, True),
        build_tree("tree_b", 8, False),
        build_bush(),
        build_bamboo(),
        build_reeds(),
        build_fern(),
        build_grass(),
        build_lily(),
    ]
    build_gate()
    made += [bpy.data.objects[n] for n in ("gate_post", "gate_sign", "finish_sign")]
    x = 0.0
    for o in made:
        o.location.x = x
        x += max(o.dimensions.x, 2) + 1.5
    return made


build_all()
