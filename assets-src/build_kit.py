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

import bmesh
import bpy
from mathutils import Matrix, Vector

KIT = "kit"
SIGN_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf",
]  # falls back to Blender's Bfont
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


def glow(name, hexcol, strength=4.0):
    """Self-lit material (exports as glTF emissive), for the mine's blinking lamp."""
    m = mat(name, hexcol, 0.4)
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Emission Color"].default_value = (*srgb(hexcol), 1)
    b.inputs["Emission Strength"].default_value = strength
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


def spike(base, direction, r, h, material, sx=1.0, n=6):
    """White cone: base circle (radius r) centred at `base`, apex `h` along `direction`.
    `sx` squeezes the X axis so a non-uniformly scaled template (x by hx, y/z by hy) still reads round."""
    base, d = Vector(base), Vector(direction).normalized()
    u = d.cross(Vector((0, 0, 1)))
    if u.length < 1e-4:
        u = Vector((1, 0, 0))
    u.normalize()
    v = d.cross(u)
    ring = [base + (u * math.cos(a) + v * math.sin(a)) * r for a in (i / n * math.tau for i in range(n))]
    pts = ring + [base + d * h]
    pts = [Vector((base.x + (p.x - base.x) * sx, p.y, p.z)) for p in pts]
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in pts]
    for i in range(n):
        bm.faces.new((vs[i], vs[(i + 1) % n], vs[n]))
    bm.faces.new(vs[:n][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("spike")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("spike", me)
    bpy.context.scene.collection.objects.link(o)
    return _finish(o, material, False)


def limb(a, b, r0, r1, material, verts=8):
    """Tapered cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    rot = Vector((0, 0, 1)).rotation_difference(d).to_euler()
    return cyl((a + b) / 2, r0, d.length, material, verts, rot=rot, r2=r1)


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


# ── palette (sampled from Fart Together gameplay) ─────────────────────────────

M = {}


def palette():
    M.update(
        ring=mat("ring_cream", 0xF7DDB5, 0.45),
        ring_low=mat("ring_mint", 0x7ED9C4, 0.45),
        ring_stripe=mat("ring_trim", 0xF2A65E, 0.5),
        floor=mat("raft_floor", 0x8FD45A, 0.6),
        floor_line=mat("raft_floor_line", 0x64AE3C, 0.7),
        rope=mat("rope", 0xE23B3B, 0.7),
        white=mat("eye_white", 0xFFFFFF, 0.3),
        pupil=mat("pupil", 0x111111, 0.2),
        nostril=mat("nostril", 0x2A2030, 0.6),
        blush=mat("blush", 0xFF8FA3, 0.6),
        tooth=mat("tooth", 0xFFFBEA, 0.4),
        leaf=mat("leaf", 0x3E9E2E, 0.8),
        fern=mat("fern", 0xC9D93C, 0.7),
        grass=mat("grass", 0x7FCB45, 0.8),
        leaf_hi=mat("leaf_light", 0x63BE3A, 0.8),
        leaf_dk=mat("leaf_dark", 0x2D7A25, 0.8),
        rock=mat("rock", 0x9A9CA3, 0.9),
        rock_dk=mat("rock_dark", 0x76787F, 0.9),
        gold=mat("bamboo_gold", 0xEDB040, 0.45),
        gold_node=mat("bamboo_gold_joint", 0xC4801F, 0.5),
        gold_hi=mat("bamboo_gold_hi", 0xF8D070, 0.45),
        ribbon=mat("ribbon_pink", 0xF0509A, 0.5),
        gate_rope=mat("gate_rope", 0x9A6532, 0.9),
        sign=mat("sign_board", 0xE0502B, 0.6),
        sign_frame=mat("sign_frame", 0x8F2D24, 0.7),
        sign_trim=mat("sign_trim", 0x3FC0B2, 0.5),
        ink=mat("sign_ink", 0xFFD23F, 0.45),
        check_dark=mat("checker_dark", 0x2A2230, 0.6),
        check_light=mat("checker_light", 0xFFF3D9, 0.6),
        magenta=mat("hazard_purple", 0xA62FC0, 0.45),
        purple=mat("strip_purple", 0xA62FC0, 0.5),
        spike=mat("spike_white", 0xFFFDF4, 0.35),
        mint=mat("hazard_lime", 0x9AD64B, 0.45),
        hub=mat("hazard_hub", 0x5A5E66, 0.45),
        metal=mat("hazard_metal", 0x3C3F46, 0.5),
        accent=mat("hazard_yellow", 0xFFC93C, 0.45),
        cap=mat("hazard_orange", 0xF07A2E, 0.45),
        bumper=mat("bumper_pink", 0xF0509A, 0.45),
        trunk=mat("trunk_brown", 0x7A4A38, 0.9),
        bark=mat("log_bark", 0x9A6234, 0.85),
        bark_dk=mat("log_bark_dark", 0x6B4226, 0.9),
        iron=mat("mine_iron", 0x2B2D33, 0.35),
        lamp=glow("mine_lamp", 0x9CFF4A, 6.0),
        binding=mat("mace_binding", 0xF5A86E, 0.6),
    )


# ── raft + riders ──────────────────────────────────────────────────────────────

ANIMALS = [  # seat order: rear-left, rear-right, front-left, front-right, then extra animals
    ("capybara", 0xE8954F, 0xF4C38E),
    ("hippo", 0x4F8FD6, 0x9CC8F2),
    ("hippo", 0x8B7FB8, 0xC4B9E3),
    ("croc", 0x5DB548, 0xD8E67E),
    ("lobster", 0xE8463A, 0xF7A27B),  # rider_4: no seat of its own, picked in the wardrobe
]
# rider_4+ are wardrobe-only templates: the client hides them and clones them by look.
RIDER_SPOTS = SEATS + [(0.0, 0.0)]
RAFT_RADIUS = 2.1  # sim RAFT_RADIUS: outer edge of the ring
TUBE = 0.32  # ring tube radius
RING_R = RAFT_RADIUS - TUBE  # ring center line
RING_Z = 0.62  # top tube center
RIDER_Z = -0.45  # riders wade outside the ring, feet in the water
RIDER_SCALE = 1.7  # chunky riders that fill the deck, like Fart Together
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


def lobster(body, belly):
    parts = []
    seated_body(body, belly, parts, wide=0.95)
    for i in range(3):  # belly plates
        parts.append(tag(sphere((0.21, 0, 0.24 + i * 0.15), (0.15, 0.22, 0.06), belly, 14, 6), "body"))
    for i in range(3):  # tail segments trailing behind
        r = 1 - i * 0.18
        parts.append(tag(sphere((-0.32 - i * 0.14, 0, 0.2 - i * 0.05), (0.14 * r, 0.21 * r, 0.1 * r), body, 14, 8), "body"))
    for y in (0.09, 0, -0.09):  # tail fan
        parts.append(tag(sphere((-0.74, y, 0.08), (0.11, 0.07, 0.03), body, 10, 6), "body"))
    for s in (1, -1):  # a big claw at the end of each arm
        side = "arm_l" if s > 0 else "arm_r"
        y = s * SHOULDER[1] * 0.95
        parts.append(tag(sphere((0.15, y, 0.24), (0.13, 0.1, 0.16), body, 14, 10), side))
        for k in (1, -1):
            parts.append(tag(sphere((0.19, y + k * 0.045, 0.06), (0.045, 0.04, 0.11), body, 10, 8), side))
    parts.append(sphere((0.06, 0, 0.98), (0.26, 0.25, 0.23), body))
    parts.append(sphere((0.29, 0, 0.94), (0.12, 0.1, 0.08), body))  # snout
    for s in (1, -1):
        parts.append(limb((0.14, s * 0.1, 1.12), (0.18, s * 0.12, 1.3), 0.035, 0.028, body))  # eye stalks
        parts.append(sphere((0.18, s * 0.12, 1.33), (0.07, 0.07, 0.07), M["white"], 12, 8))
        parts.append(sphere((0.235, s * 0.12, 1.34), (0.035, 0.04, 0.04), M["pupil"], 10, 6))
        parts.append(limb((0.3, s * 0.05, 1.0), (0.08, s * 0.38, 1.62), 0.02, 0.008, body, 6))  # antennae
        parts.append(sphere((0.26, s * 0.2, 0.92), (0.04, 0.05, 0.03), M["blush"], 8, 6))
    return parts


def build_raft():
    """Round inflatable ring: cream tube on a mint tube, peach trim band, planked green floor."""
    lower = torus((0, 0, 0.22), RING_R + 0.02, TUBE, M["ring_low"], seg=48)
    upper = torus((0, 0, RING_Z), RING_R, TUBE, M["ring"], seg=48)
    stripe = torus((0, 0, RING_Z + 0.02), RING_R, TUBE + 0.018, M["ring_stripe"], scale=(1, 1, 0.4), seg=48, mseg=12)
    floor = cyl((0, 0, 0.32), RING_R + 0.05, 0.14, M["floor"], 48)
    parts = [lower, upper, stripe, floor]
    for k in range(-8, 9):  # plank seams along x, clipped to the floor circle
        y = k * 0.26
        half = RING_R * math.sqrt(max(0.0, 1 - (y / RING_R) ** 2)) - 0.05
        if half > 0.2:
            parts.append(box((0, y, 0.395), (half * 2, 0.025, 0.012), M["floor_line"]))
    for i in range(16):  # red rope handles on the lower ring
        a = i / 16 * math.tau + 0.2
        x, y = math.cos(a) * (RAFT_RADIUS + 0.02), math.sin(a) * (RAFT_RADIUS + 0.02)
        parts.append(torus((x, y, 0.22), 0.13, 0.035, M["rope"], rot=(math.pi / 2, 0, a + math.pi / 2), seg=12, mseg=5))
    raft = join("raft", parts)
    builders = {"hippo": hippo, "croc": croc, "capybara": capybara, "lobster": lobster}
    for i, ((sx, sy), (kind, body, belly)) in enumerate(zip(RIDER_SPOTS, ANIMALS)):
        mb = mat(f"rider_{i}", body, 0.55)
        ml = mat(f"rider_{i}_belly", belly, 0.6)
        parts = builders[kind](mb, ml)
        loc = Vector((sx, sy, RIDER_Z))  # the client moves riders around the deck
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


def build_spinner():
    """Purple spiked bar, 2 long on X, radius 1, with a hub post. Client scales (hx, hy, hy).

    Everything round is pre-squeezed in X by HY/HX = 0.4 / 4.5 (the pond spinner) so spikes and the
    hub read as circles after the non-uniform scale. Bar centre sits 0.6 above the origin plane."""
    sx, zc = 0.09, 0.6
    parts = [cyl((0, 0, zc), 1.0, 2.0, M["magenta"], 20, rot=(0, math.pi / 2, 0))]
    for x in (-1.0, 1.0):
        parts.append(cyl((x, 0, zc), 1.08, 0.07, M["mint"], 20, rot=(0, math.pi / 2, 0)))
    for i in range(8):
        x = -0.875 + i * 0.25
        for d in ((0, 1, 0), (0, -1, 0), (0, 0, 1)):
            parts.append(spike((x, d[1] * 0.92, zc + d[2] * 0.92), d, 0.3, 1.0, M["spike"], sx))
    hub = cyl((0, 0, zc), 1.5, 4.0, M["hub"], 20)
    hub.scale = (sx, 1, 1)
    cap = cyl((0, 0, zc + 2.02), 1.75, 0.1, M["mint"], 20)
    cap.scale = (sx, 1, 1)
    return join("spinner", parts + [hub, cap])


def build_sweeper():
    """Purple spiked arm, 2 long on +X, origin at the pivot end. Client scales (len/2, 1, 1).

    Round bits are pre-squeezed for a scale of ~4 (arm length ~8)."""
    sx, zc, r = 0.25, 0.45, 0.3
    parts = [cyl((1.0, 0, zc), r, 2.0, M["magenta"], 14, rot=(0, math.pi / 2, 0))]
    cap = cyl((0, 0, zc), 0.55, 0.9, M["mint"], 20)
    cap.scale = (sx, 1, 1)
    parts.append(cap)
    tip = cyl((1.97, 0, zc), r * 1.12, 0.06, M["mint"], 14, rot=(0, math.pi / 2, 0))
    parts.append(tip)
    for i in range(7):
        x = 0.4 + i * 0.25
        for d in ((0, 1, 0), (0, -1, 0), (0, 0, 1)):
            parts.append(spike((x, d[1] * r * 0.9, zc + d[2] * r * 0.9), d, 0.1, 0.3, M["spike"], sx))
    return join("sweeper", parts)


LOG_HALF = 2.4  # half-length of the rolling log; the client scales (hx / LOG_HALF, hy, hy)


def build_log():
    """Rolling spiked log for the `log` hazard: lies along X (±LOG_HALF), radius 1 with the spike
    tips, axis 0.6 above the water. Brown bark, golden rings on the end caps, lime bands, a
    yellow seam and rows of white spikes. The client rolls it about X as it travels."""
    zc, r = 0.6, 0.78
    along = (0, math.pi / 2, 0)  # turns a Z-axis primitive onto the X axis
    parts = [cyl((0, 0, zc), r, LOG_HALF * 2 - 0.2, M["bark"], 18, rot=along)]
    for sgn in (1, -1):
        x = sgn * (LOG_HALF - 0.1)
        parts.append(cyl((x, 0, zc), r + 0.02, 0.12, M["gold"], 18, rot=along))
        parts.append(cyl((x + sgn * 0.01, 0, zc), r * 0.7, 0.14, M["gold_node"], 16, rot=along))
        parts.append(cyl((x + sgn * 0.02, 0, zc), r * 0.42, 0.16, M["gold"], 14, rot=along))
        parts.append(cyl((x + sgn * 0.03, 0, zc), r * 0.14, 0.18, M["bark_dk"], 8, rot=along))
        parts.append(torus((sgn * 1.55, 0, zc), r + 0.02, 0.07, M["mint"], rot=along, seg=24, mseg=6))
    parts.append(torus((0, 0, zc), r + 0.01, 0.06, M["accent"], rot=along, seg=24, mseg=6))
    for row, x in enumerate((-1.9, -1.15, -0.5, 0.5, 1.15, 1.9)):  # rows of white spikes, each turned half a step
        for k in range(6):
            a = (k + 0.5 * (row % 2)) / 6 * math.tau
            d = (0, math.cos(a), math.sin(a))
            base = (x, d[1] * (r - 0.04), zc + d[2] * (r - 0.04))
            parts.append(spike(base, d, 0.15, 0.34, M["spike"], n=5))
    return join("log", parts)


def build_bumper():
    """Floating spiked ball for the `bumper` hazard: a purple float ring with a lime trim under a pink
    ball with a cartoon face (toward +X), ringed with white spikes. Radius 1 at the spike tips; the
    client scales it uniformly by the bumper's radius and pulses it."""
    parts = [torus((0, 0, 0.2), 0.74, 0.2, M["magenta"], seg=28, mseg=10)]
    parts.append(torus((0, 0, 0.36), 0.74, 0.05, M["mint"], seg=28, mseg=6))
    parts.append(sphere((0, 0, 0.78), (0.62, 0.62, 0.56), M["bumper"], 24, 14))
    for s in (1, -1):
        parts.append(sphere((0.5, s * 0.2, 0.92), (0.1, 0.12, 0.14), M["white"], 12, 8))
        parts.append(sphere((0.58, s * 0.2, 0.92), (0.05, 0.06, 0.08), M["pupil"], 10, 6))
    parts.append(sphere((0.54, 0, 0.66), (0.08, 0.22, 0.06), M["pupil"], 12, 6))  # grin
    for k in range(14):  # equator, leaving the face (toward +X) clear
        a = k / 14 * math.tau
        if math.cos(a) > 0.6:
            continue
        d = (math.cos(a), math.sin(a), 0)
        parts.append(spike((d[0] * 0.6, d[1] * 0.6, 0.78), d, 0.11, 0.4, M["spike"], n=5))
    for k in range(6):  # shoulders, tilted up
        a = (k + 0.5) / 6 * math.tau
        d = Vector((math.cos(a), math.sin(a), 1.0)).normalized()
        parts.append(spike(Vector((math.cos(a) * 0.4, math.sin(a) * 0.4, 1.12)), d, 0.09, 0.3, M["spike"], n=5))
    return join("bumper", parts)


HAMMER_ARM = 6.0  # = sim HAMMER_ARM: pivot to the centre of the smash zone
HAMMER_R = 1.2  # head drum radius: it rests on the water with its axle HAMMER_R up
HAMMER_HALF = 1.5  # head half-length across the arm; the client scales that axis by hy / HAMMER_HALF


def build_hammer():
    """Swinging mallet for the `hammer` hazard, modelled DOWN: the arm runs along +X from the axle
    at the origin (HAMMER_R above the water) to a spiked drum centred at x = HAMMER_ARM, its axis
    across the arm (Y). The client yaws it to the sim `rot` and raises it about the axle (Y)."""
    zc = HAMMER_R
    across = (math.pi / 2, 0, 0)  # turns a Z-axis primitive onto the Y axis
    along = (0, math.pi / 2, 0)
    parts = [cyl((0, 0, zc), 0.45, 1.6, M["hub"], 16, rot=across)]  # axle hub
    parts.append(cyl((HAMMER_ARM / 2, 0, zc), 0.28, HAMMER_ARM - 0.6, M["bark"], 12, rot=along))  # handle
    for x in (1.2, HAMMER_ARM - 1.6):
        parts.append(torus((x, 0, zc), 0.3, 0.07, M["mint"], rot=along, seg=16, mseg=6))
    parts.append(cyl((HAMMER_ARM, 0, zc), HAMMER_R - 0.25, HAMMER_HALF * 2, M["magenta"], 20, rot=across))
    for sgn in (1, -1):  # charcoal end caps
        parts.append(cyl((HAMMER_ARM, sgn * HAMMER_HALF, zc), HAMMER_R - 0.15, 0.18, M["metal"], 20, rot=across))
    parts.append(torus((HAMMER_ARM, 0, zc), HAMMER_R - 0.24, 0.07, M["mint"], rot=across, seg=24, mseg=6))
    for row, y in enumerate((-1.05, -0.35, 0.35, 1.05)):  # spikes all round the drum
        for k in range(8):
            a = (k + 0.5 * (row % 2)) / 8 * math.tau
            d = (math.cos(a), 0, math.sin(a))
            r = HAMMER_R - 0.27
            parts.append(spike((HAMMER_ARM + d[0] * r, y, zc + d[2] * r), d, 0.13, 0.3, M["spike"], n=5))
    return join("hammer", parts)


def build_hammer_post():
    """The bank post the hammer hangs from: a charcoal pillar with a lime cap; the axle sits HAMMER_R up."""
    parts = [box((0, 0, 0.9), (1.0, 2.2, 1.8), M["metal"], bevel=0.08)]
    parts.append(box((0, 0, 1.85), (1.15, 2.35, 0.14), M["mint"], bevel=0.04))
    for sgn in (1, -1):
        parts.append(cyl((0, sgn * 0.9, HAMMER_R), 0.3, 0.25, M["hub"], 12, rot=(math.pi / 2, 0, 0)))
    return join("hammer_post", parts)


def build_piston():
    """Punching block for the `piston` hazard: half-extents 1 x 1 (X out of the bank, Y along it),
    1.4 tall, charcoal with white spikes on its +X face. The client scales it (hx, hy, 1)."""
    sx = 0.8  # the template is usually scaled ~1.2 along X: keep the spikes round-ish
    parts = [box((0, 0, 0.7), (2.0, 2.0, 1.4), M["metal"], bevel=0.08)]
    parts.append(box((0.98, 0, 0.7), (0.12, 2.1, 1.5), M["mint"], bevel=0.03))
    parts.append(box((-0.7, 0, 1.42), (0.5, 1.7, 0.08), M["accent"]))
    for y in (-0.6, 0.0, 0.6):
        for z in (0.4, 1.0):
            parts.append(spike((1.02, y, z), (1, 0, 0), 0.17, 0.45, M["spike"], sx, n=5))
    return join("piston", parts)


def build_piston_rod():
    """The piston's ram: 1 m along -X from the origin, 0.7 up. The client stretches X to the bank."""
    parts = [cyl((-0.5, 0, 0.7), 0.3, 1.0, M["hub"], 12, rot=(0, math.pi / 2, 0))]
    return join("piston_rod", parts)


DROPGATE_HALF = 0.6  # bar half-thickness across it; the client scales that axis by hy / DROPGATE_HALF
DROPGATE_POST_H = 8.6  # tall enough for the bar raised DROPGATE_RAISE (client) plus its 1.5 m beam


def build_dropgate_bar():
    """Heavy spiked bar for the `dropgate` hazard: 2 m along X (the client scales it by hx, so round
    bits are pre-squeezed for hx ~7), DROPGATE_HALF either side in Y, origin at its spike tips. A charcoal
    iron-bound beam with lime bands, a yellow seam on both faces and a double row of white spikes
    pointing down. The client raises it by the gate's lift."""
    sx = 0.14
    parts = [box((0, 0, 1.05), (2.0, DROPGATE_HALF * 2, 1.0), M["metal"], bevel=0.06)]
    parts.append(box((0, 0, 0.56), (2.0, DROPGATE_HALF * 2 + 0.06, 0.12), M["iron"]))  # iron underside
    parts.append(box((0, 0, 1.58), (2.0, DROPGATE_HALF * 2 + 0.06, 0.1), M["iron"]))  # and top
    for sgn in (1, -1):
        parts.append(box((0, sgn * (DROPGATE_HALF + 0.02), 1.05), (1.9, 0.04, 0.1), M["accent"]))  # yellow seam
        parts.append(box((sgn * 0.99, 0, 1.05), (0.05, DROPGATE_HALF * 2 + 0.1, 1.12), M["hub"]))  # end caps
    for x in (-0.6, -0.2, 0.2, 0.6):
        parts.append(box((x, 0, 1.05), (0.04, DROPGATE_HALF * 2 + 0.08, 1.08), M["mint"]))
    for row, y in enumerate((-0.3, 0.3)):
        for i in range(15):
            x = -0.875 + i * 0.125 + (0.0625 if row else 0)
            if abs(x) > 0.93:
                continue
            parts.append(spike((x, y, 0.5), (0, 0, -1), 0.19, 0.5, M["spike"], sx, n=5))
    return join("dropgate_bar", parts)


def build_dropgate_post():
    """Bank post a drop gate's bar runs in: a charcoal pillar DROPGATE_POST_H tall with grey corners and
    lime bands, a yellow track on its +X face (toward the bar) and a lime cap on top."""
    h = DROPGATE_POST_H
    parts = [box((0, 0, h / 2), (1.0, 1.2, h), M["metal"], bevel=0.08)]
    for cx in (-0.5, 0.5):
        for cy in (-0.6, 0.6):
            parts.append(cyl((cx, cy, h / 2), 0.1, h, M["hub"], 8))
    for z in (0.4, h * 0.45, h - 0.3):
        parts.append(box((0, 0, z), (1.15, 1.35, 0.16), M["mint"], bevel=0.04))
    parts.append(box((0.52, 0, h / 2 + 0.3), (0.06, 0.3, h - 1.2), M["accent"]))  # the bar's track
    parts.append(box((0, 0, h + 0.15), (1.25, 1.45, 0.3), M["mint"], bevel=0.06))
    return join("dropgate_post", parts)


DOUBLEGATE_DOOR = 6.75  # door length, hinge to tip (canyon: halfWidth 7 - 0.25); the client scales X by hx / this
DOUBLEGATE_HALF = 0.45  # door half-thickness = sim hy
DOUBLEGATE_H = 3.4  # door height above the water


def build_doublegate_door():
    """One door of the `doublegate` hazard: a charcoal plate DOUBLEGATE_DOOR along +X from its hinge
    at the origin, 2 * DOUBLEGATE_HALF thick, DOUBLEGATE_H tall, rimmed in grey and studded with a
    grid of short white spikes on both faces. The client swings it about the hinge (Z)."""
    L, t, h = DOUBLEGATE_DOOR, DOUBLEGATE_HALF, DOUBLEGATE_H
    parts = [box((L / 2, 0, h / 2 - 0.15), (L, t * 2, h + 0.3), M["metal"], bevel=0.1)]
    for z in (0.12, h - 0.1):  # grey rails top and bottom
        parts.append(box((L / 2, 0, z), (L + 0.06, t * 2 + 0.08, 0.2), M["hub"], bevel=0.04))
    parts.append(box((L - 0.08, 0, h / 2), (0.2, t * 2 + 0.08, h), M["hub"], bevel=0.04))  # tip edge
    cols, rows = 7, 4
    for sgn in (1, -1):
        for r in range(rows):
            z = 0.65 + r * (h - 1.2) / (rows - 1)
            for c in range(cols):
                x = 0.75 + c * (L - 1.4) / (cols - 1)
                parts.append(spike((x, sgn * t, z), (0, sgn, 0), 0.2, 0.32, M["spike"], n=6))
    return join("doublegate_door", parts)


def build_doublegate_post():
    """Bank post a double gate's door hangs on: a charcoal pillar a bit taller than the door, its
    hinge barrel on the +X side at the origin, and an orange cap."""
    h = DOUBLEGATE_H + 0.5
    parts = [box((-0.35, 0, h / 2), (0.9, 1.3, h), M["metal"], bevel=0.08)]
    parts.append(cyl((0, 0, h / 2), 0.22, h, M["hub"], 12))  # hinge barrel
    parts.append(box((-0.35, 0, h + 0.18), (1.1, 1.5, 0.36), M["cap"], bevel=0.08))
    return join("doublegate_post", parts)


def build_mine():
    """Floating spiked mine for the `mine` hazard: a black iron ball riding low in the water, a lime
    band round its waist, white horns all round and a lime lamp on top that the client blinks (it
    looks for the `mine_lamp` material). Radius 1 at the horn tips; the client scales it by hx."""
    zc, r = 0.3, 0.6
    parts = [sphere((0, 0, zc), (r, r, r), M["iron"], 20, 12)]
    parts.append(torus((0, 0, zc), r + 0.01, 0.05, M["mint"], seg=28, mseg=6))
    parts.append(cyl((0, 0, zc + r + 0.08), 0.1, 0.2, M["iron"], 10))
    parts.append(sphere((0, 0, zc + r + 0.22), (0.15, 0.15, 0.15), M["lamp"], 12, 8))
    for ring, (elev, n) in enumerate(((0.0, 8), (0.75, 6))):
        for k in range(n):
            a = (k + 0.5 * ring) / n * math.tau
            d = Vector((math.cos(a) * math.cos(elev), math.sin(a) * math.cos(elev), math.sin(elev)))
            parts.append(spike(Vector((0, 0, zc)) + d * (r - 0.04), d, 0.1, 0.44, M["spike"], n=6))
    return join("mine", parts)


MACE_POST_H = 10.0  # gantry post height; the client stretches it (Z) to hang the beam over the swing
MACE_BEAM_HALF = 1.0  # beam half-length along X; the client scales X to reach post to post


def build_mace():
    """Bob of the `mace` hazard: a charcoal drum bristling with white cone spikes, bound with crossed
    peach straps, a magenta collar on top where the rope ties on. Origin at the bob's centre, radius
    1 at the spike tips; the client scales it by hx and hangs it from `mace_rope`."""
    r, h = 0.62, 1.2
    parts = [cyl((0, 0, 0), r, h, M["iron"], 16)]
    for z in (h / 2, -h / 2):
        parts.append(cyl((0, 0, z), r + 0.03, 0.1, M["metal"], 16))
    for k in range(4):  # crossed straps on four sides
        a = (k + 0.5) / 4 * math.tau
        for tilt in (0.75, -0.75):
            parts.append(box((math.cos(a) * (r + 0.02), math.sin(a) * (r + 0.02), 0), (0.06, 0.16, 1.45), M["binding"], rot=(tilt, 0, a)))
    for ring, z in enumerate((-0.3, 0.3)):  # two rings of side spikes
        for k in range(8):
            a = (k + 0.5 * ring) / 8 * math.tau
            d = (math.cos(a), math.sin(a), 0)
            parts.append(spike((d[0] * (r - 0.02), d[1] * (r - 0.02), z), d, 0.15, 0.4, M["spike"], n=6))
    for k in range(4):  # and a few out of the bottom
        a = k / 4 * math.tau
        parts.append(spike((math.cos(a) * 0.3, math.sin(a) * 0.3, -h / 2), (math.cos(a) * 0.4, math.sin(a) * 0.4, -1), 0.13, 0.42, M["spike"], n=6))
    parts.append(cyl((0, 0, h / 2 + 0.2), 0.3, 0.32, M["magenta"], 14))  # collar
    parts.append(torus((0, 0, h / 2 + 0.2), 0.31, 0.06, M["binding"], seg=20, mseg=6))
    parts.append(cyl((0, 0, h / 2 + 0.42), 0.16, 0.16, M["binding"], 10))
    return join("mace", parts)


def build_mace_rope():
    """The mace's rope: an orange rod hanging 1 m from its pivot at the origin down -Z. The client
    stretches it (Z) to the bob's collar and swings it about the stream axis."""
    parts = [cyl((0, 0, -0.5), 0.13, 1.0, M["cap"], 10)]
    return join("mace_rope", parts)


def build_mace_post():
    """Bank post of the mace's gantry: a charcoal pillar MACE_POST_H tall with lime bands and cap."""
    h = MACE_POST_H
    parts = [box((0, 0, h / 2), (0.9, 0.9, h), M["metal"], bevel=0.08)]
    for z in (0.4, h * 0.5, h - 0.4):
        parts.append(box((0, 0, z), (1.05, 1.05, 0.18), M["mint"], bevel=0.04))
    parts.append(box((0, 0, h + 0.15), (1.15, 1.15, 0.3), M["mint"], bevel=0.06))
    return join("mace_post", parts)


def build_mace_beam():
    """The gantry's crossbeam: 2 * MACE_BEAM_HALF along X, its top at the origin, a yellow stripe on
    each face. The client scales X so it spans post to post, and hangs the rope from its middle."""
    L = MACE_BEAM_HALF * 2
    parts = [box((0, 0, -0.35), (L, 0.7, 0.7), M["metal"])]
    for y in (0.36, -0.36):
        parts.append(box((0, y, -0.35), (L, 0.04, 0.18), M["accent"]))
    return join("mace_beam", parts)


BAMBOO_H = 8.5  # gate pole height; gates.ts hangs the crossbar at BAR_Z
BAR_Z = 7.4


def gold_pole(parts, length, r, rot, at):
    """Golden bamboo: segments with fatter joints. `at(t)` maps distance along the pole to a location."""
    seg = 1.4
    n = max(1, round(length / seg))
    step = length / n
    for i in range(n):
        parts.append(cyl(at((i + 0.5) * step), r * (1.0 - 0.015 * i), step - 0.04, M["gold"], 12, rot=rot))
        if i:
            parts.append(cyl(at(i * step), r * 1.22, 0.1, M["gold_node"], 12, rot=rot))
    return parts


def build_gate_post():
    parts = gold_pole([], BAMBOO_H, 0.24, (0, 0, 0), lambda t: (0, 0, t))
    parts.append(cyl((0, 0, BAMBOO_H), 0.3, 0.16, M["gold_node"], 12))
    parts.append(cyl((0, 0, BAMBOO_H + 0.085), 0.2, 0.02, M["gate_rope"], 12))  # hollow top
    for z in (BAR_Z - 0.2, BAR_Z + 0.15):  # rope lashing where the crossbar crosses
        parts.append(torus((0, 0, z), 0.3, 0.07, M["gate_rope"], seg=16, mseg=6))
    parts.append(cyl((0, 0, 0.1), 0.34, 0.2, M["gold_node"], 12))  # foot
    z = 0.75  # pink ribbon tied around the base
    parts.append(torus((0, 0, z), 0.27, 0.05, M["ribbon"], seg=16, mseg=6))
    parts.append(sphere((0.28, 0, z), (0.09, 0.09, 0.09), M["ribbon"], 8, 6))
    for s in (1, -1):
        loop = sphere((0.4, s * 0.2, z + 0.06), (0.17, 0.13, 0.07), M["ribbon"], 10, 6)
        loop.rotation_euler = (0, 0, s * 0.6)
        parts.append(loop)
        tail = sphere((0.34, s * 0.12, z - 0.2), (0.05, 0.03, 0.2), M["ribbon"], 8, 6)
        tail.rotation_euler = (s * -0.25, 0.15, 0)
        parts.append(tail)
    for i in range(6):  # flower-like ribbon splay on the ground
        a = i / 6 * math.tau
        petal = sphere((math.cos(a) * 0.45, math.sin(a) * 0.45, 0.2), (0.25, 0.11, 0.05), M["ribbon"], 8, 4)
        petal.rotation_euler = (0, 0, a)
        parts.append(petal)
    join("gate_post", parts)


def build_gate_bar():
    """Golden crossbar, 2 m on X centred at the origin. Client scales x by the gate half-width."""
    parts = [cyl((0, 0, 0), 0.24, 1.96, M["gold"], 12, rot=(0, math.pi / 2, 0))]
    for x in (-0.5, 0.0, 0.5):
        parts.append(cyl((x, 0, 0), 0.29, 0.03, M["gold_node"], 12, rot=(0, math.pi / 2, 0)))
    parts.append(cyl((0, 0, 0.05), 0.2, 1.9, M["gold_hi"], 6, rot=(0, math.pi / 2, 0)))
    parts[-1].scale = (1, 0.3, 0.2)
    return join("gate_bar", parts)


def fit_text(o, max_w, max_h):
    s = min(max_w / o.dimensions.x, max_h / o.dimensions.y)
    o.scale = (s, s, 1)


def build_sign(name, label, finish=False):
    """Red-orange board in a brick frame with teal trim and chunky yellow lettering on both faces,
    centred on the origin, 6.4 wide. Hangs from the crossbar by two ropes; tilted a few degrees."""
    board = [
        box((0, 0, 0), (6.4, 0.18, 1.6), M["sign_frame"], bevel=0.05),
        box((0, 0, 0), (6.0, 0.2, 1.2), M["sign_trim"], bevel=0.03),
        box((0, 0, 0), (5.8, 0.22, 1.0), M["sign"], bevel=0.03),
    ]
    if finish:
        for k in range(32):
            for z in (0.7, -0.7):
                m = M["check_dark"] if (k + (z > 0)) % 2 else M["check_light"]
                board.append(box((-3.1 + k * 0.2, 0, z), (0.2, 0.2, 0.2), m))
    font = next((f for f in SIGN_FONTS if os.path.exists(f)), None)
    for side in (1, -1):
        bpy.ops.object.text_add(location=(0, side * 0.2, 0), rotation=(math.pi / 2, 0, 0 if side < 0 else math.pi))
        t = bpy.context.object
        t.data.body = label
        if font:
            t.data.font = bpy.data.fonts.load(font, check_existing=True)
        t.data.align_x = "CENTER"
        t.data.align_y = "CENTER"
        t.data.size = 1.0
        t.data.extrude = 0.1
        t.data.bevel_depth = 0.015
        t.data.bevel_resolution = 0
        t.data.resolution_u = 3
        bpy.ops.object.convert(target="MESH")
        t = bpy.context.object
        fit_text(t, 5.3, 0.8)
        board.append(_finish(t, M["ink"], False))
    bpy.context.view_layer.update()
    tilt = Matrix.Rotation(-0.05, 4, "Y")
    for o in board:
        o.matrix_world = tilt @ o.matrix_world
    for x in (-2.3, 2.3):
        board.append(cyl((x, 0, 0.95), 0.045, 0.45, M["gate_rope"], 6))
    join(name, board)


def build_gate():
    build_gate_post()
    build_gate_bar()
    build_sign("gate_sign", "CHECKPOINT")
    build_sign("finish_sign", "FINISH", finish=True)
    build_sign("start_sign", "START")


def build_tree_round(name="tree_round"):
    """Puffy rounded tree: lumpy green crown on a curving brown trunk, ~4.4 high."""
    pts = [(0, 0, 0), (0.15, 0.05, 0.9), (-0.1, 0.0, 1.8), (0.2, -0.05, 2.6), (0.05, 0, 3.2)]
    parts = []
    for i in range(len(pts) - 1):
        parts.append(limb(pts[i], pts[i + 1], 0.3 - i * 0.045, 0.3 - (i + 1) * 0.045, M["trunk"], 8))
    parts.append(limb(pts[2], (-0.75, 0.2, 2.7), 0.1, 0.06, M["trunk"], 6))
    parts.append(limb(pts[3], (0.85, 0.1, 3.4), 0.1, 0.06, M["trunk"], 6))
    parts.append(cyl((0.05, 0, 0.05), 0.42, 0.2, M["trunk"], 8))
    blobs = [  # x, y, z, r, material
        (0.0, 0.0, 3.6, 1.15, "leaf"),
        (0.95, 0.2, 3.5, 0.85, "leaf"),
        (-0.9, -0.2, 3.45, 0.85, "leaf_dk"),
        (0.3, 0.85, 3.5, 0.8, "leaf"),
        (-0.3, -0.85, 3.6, 0.8, "leaf_dk"),
        (0.1, 0.1, 4.25, 0.95, "leaf_hi"),
        (0.7, -0.5, 4.0, 0.7, "leaf_hi"),
        (-0.65, 0.55, 4.0, 0.7, "leaf_hi"),
    ]
    for x, y, z, r, m in blobs:
        parts.append(ico((x, y, z), r, M[m], 2, scale=(1, 1, 0.88), smooth=False))
    return join(name, parts)


def build_bush():
    parts = []
    for x, y, r, m in ((0, 0, 0.9, "leaf"), (0.7, 0.3, 0.6, "leaf_hi"), (-0.6, 0.4, 0.65, "leaf"), (0.1, -0.6, 0.6, "leaf_dk"), (0, 0, 0.6, "leaf_hi")):
        parts.append(ico((x, y, r * 0.7 + (0.5 if r == 0.6 and x == 0 else 0)), r, M[m], 2, scale=(1, 1, 0.85)))
    return join("bush", parts)


def build_fern():
    """Fern rosette with a couple of grey boulders at its foot (the kit's rocks)."""
    parts = []
    for i in range(7):
        a = i / 7 * math.tau
        leaf = sphere((math.cos(a) * 0.45, math.sin(a) * 0.45, 0.3), (0.5, 0.12, 0.04), M["fern"], 8, 4, smooth=False)
        leaf.rotation_euler = (0, -0.5, a)
        parts.append(leaf)
    parts.append(sphere((0, 0, 0.1), (0.15, 0.15, 0.15), M["leaf"], 8, 4))
    parts.append(ico((0.85, -0.45, 0.22), 0.5, M["rock"], 1, scale=(1, 0.85, 0.7), smooth=False))
    parts.append(ico((0.55, 0.55, 0.12), 0.3, M["rock_dk"], 1, scale=(1, 0.9, 0.7), smooth=False))
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


def build_all():
    kit_collection()
    palette()
    made = [
        build_raft(),
        build_spinner(),
        build_sweeper(),
        build_log(),
        build_bumper(),
        build_hammer(),
        build_hammer_post(),
        build_piston(),
        build_piston_rod(),
        build_dropgate_bar(),
        build_dropgate_post(),
        build_doublegate_door(),
        build_doublegate_post(),
        build_mine(),
        build_mace(),
        build_mace_rope(),
        build_mace_post(),
        build_mace_beam(),
        build_tree_round(),
        build_bush(),
        build_fern(),
        build_grass(),
    ]
    build_gate()
    made += [bpy.data.objects[n] for n in ("gate_post", "gate_bar", "gate_sign", "finish_sign", "start_sign")]
    x = 0.0
    for o in made:
        o.location.x = x
        x += max(o.dimensions.x, 2) + 1.5
    return made


build_all()
