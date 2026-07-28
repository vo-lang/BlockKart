"""Build and render the BlockKart alpine golden-scene art proof.

Run with:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --python tools/blender/build_golden_alpine_scene.py

The scene deliberately uses Eevee, linked modular meshes, modest geometry and
procedural materials so the result remains representative of a real-time game.
"""

from __future__ import annotations

import json
import math
import os
import random
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
BLEND_PATH = ROOT / "art/blender/blockkart_alpine_golden_scene_v9.blend"
RENDER_PATH = ROOT / "docs/images/blockkart-blender-golden-scene-v9.png"
REPORT_PATH = ROOT / "art/blender/blockkart_alpine_golden_scene_v9.json"
GLB_PATH = ROOT / "art/exports/blockkart_alpine_golden_scene_v9.glb"
SEED = 20260728
random.seed(SEED)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def collection(name: str) -> bpy.types.Collection:
    existing = bpy.data.collections.get(name)
    if existing is not None:
        return existing
    value = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(value)
    return value


def move_to_collection(obj: bpy.types.Object, target: bpy.types.Collection) -> None:
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    target.objects.link(obj)


def principled_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float = 0.55,
    metallic: float = 0.0,
    emission: tuple[float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if emission_input is not None:
            emission_input.default_value = (*emission, 1.0)
        strength_input = bsdf.inputs.get("Emission Strength")
        if strength_input is not None:
            strength_input.default_value = emission_strength
    return material


def procedural_surface_material(
    name: str,
    low: tuple[float, float, float, float],
    high: tuple[float, float, float, float],
    scale: float,
    detail: float,
    roughness: float,
    bump_strength: float,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    noise = nodes.new("ShaderNodeTexNoise")
    ramp = nodes.new("ShaderNodeValToRGB")
    bump = nodes.new("ShaderNodeBump")
    texture_coordinate = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = detail
    noise.inputs["Roughness"].default_value = 0.72
    ramp.color_ramp.elements[0].color = low
    ramp.color_ramp.elements[1].color = high
    bsdf.inputs["Roughness"].default_value = roughness
    bump.inputs["Strength"].default_value = bump_strength
    bump.inputs["Distance"].default_value = 0.24
    links.new(texture_coordinate.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def road_material() -> bpy.types.Material:
    material = bpy.data.materials.new("Road asphalt layered")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    coarse = nodes.new("ShaderNodeTexNoise")
    fine = nodes.new("ShaderNodeTexNoise")
    ramp = nodes.new("ShaderNodeValToRGB")
    bump = nodes.new("ShaderNodeBump")
    texture_coordinate = nodes.new("ShaderNodeTexCoord")
    coarse.inputs["Scale"].default_value = 3.2
    coarse.inputs["Detail"].default_value = 7.0
    coarse.inputs["Roughness"].default_value = 0.82
    fine.inputs["Scale"].default_value = 58.0
    fine.inputs["Detail"].default_value = 3.0
    ramp.color_ramp.elements[0].color = (0.018, 0.022, 0.028, 1.0)
    ramp.color_ramp.elements[1].color = (0.105, 0.118, 0.128, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.72
    bsdf.inputs["Metallic"].default_value = 0.02
    bump.inputs["Strength"].default_value = 0.34
    bump.inputs["Distance"].default_value = 0.08
    links.new(texture_coordinate.outputs["Generated"], coarse.inputs["Vector"])
    links.new(texture_coordinate.outputs["Generated"], fine.inputs["Vector"])
    links.new(coarse.outputs["Fac"], ramp.inputs["Fac"])
    links.new(fine.outputs["Fac"], bump.inputs["Height"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def water_material() -> bpy.types.Material:
    material = bpy.data.materials.new("Alpine water")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    noise = nodes.new("ShaderNodeTexNoise")
    bump = nodes.new("ShaderNodeBump")
    texture_coordinate = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.3, 8.0, 1.0)
    noise.inputs["Scale"].default_value = 3.6
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.68
    bump.inputs["Strength"].default_value = 0.5
    bump.inputs["Distance"].default_value = 0.16
    bsdf.inputs["Base Color"].default_value = (0.018, 0.36, 0.58, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.17
    bsdf.inputs["Metallic"].default_value = 0.18
    emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if emission_input is not None:
        emission_input.default_value = (0.015, 0.29, 0.48, 1.0)
    emission_strength = bsdf.inputs.get("Emission Strength")
    if emission_strength is not None:
        emission_strength.default_value = 0.22
    links.new(texture_coordinate.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return material


def waterfall_material() -> bpy.types.Material:
    material = bpy.data.materials.new("Layered waterfall surface")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    noise = nodes.new("ShaderNodeTexNoise")
    fine_noise = nodes.new("ShaderNodeTexNoise")
    ramp = nodes.new("ShaderNodeValToRGB")
    bump = nodes.new("ShaderNodeBump")
    texture_coordinate = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (5.5, 2.0, 14.0)
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 7.0
    noise.inputs["Roughness"].default_value = 0.76
    noise.inputs["Distortion"].default_value = 1.8
    fine_noise.inputs["Scale"].default_value = 28.0
    fine_noise.inputs["Detail"].default_value = 4.0
    ramp.color_ramp.elements[0].position = 0.22
    ramp.color_ramp.elements[0].color = (0.012, 0.18, 0.42, 1.0)
    middle = ramp.color_ramp.elements.new(0.48)
    middle.color = (0.02, 0.48, 0.76, 1.0)
    ramp.color_ramp.elements[-1].position = 0.74
    ramp.color_ramp.elements[-1].color = (0.82, 0.97, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.24
    bsdf.inputs["Metallic"].default_value = 0.08
    emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if emission_input is not None:
        links.new(ramp.outputs["Color"], emission_input)
    emission_strength = bsdf.inputs.get("Emission Strength")
    if emission_strength is not None:
        emission_strength.default_value = 0.12
    bump.inputs["Strength"].default_value = 0.42
    bump.inputs["Distance"].default_value = 0.12
    links.new(texture_coordinate.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    links.new(mapping.outputs["Vector"], fine_noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(fine_noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def create_box(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    material: bpy.types.Material,
    target: bpy.types.Collection,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    if bevel > 0:
        modifier = obj.modifiers.new("Weighted bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    move_to_collection(obj, target)
    return obj


def create_cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material: bpy.types.Material,
    target: bpy.types.Collection,
    vertices: int = 16,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    if bevel > 0:
        modifier = obj.modifiers.new("Edge softness", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    move_to_collection(obj, target)
    return obj


def create_uv_sphere(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    target: bpy.types.Collection,
    segments: int = 20,
    rings: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    move_to_collection(obj, target)
    return obj


def linked_instance(
    template: bpy.types.Object,
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    rotation_z: float,
    target: bpy.types.Collection,
) -> bpy.types.Object:
    obj = template.copy()
    obj.data = template.data
    obj.name = name
    obj.hide_render = False
    obj.hide_viewport = False
    obj.location = location
    obj.scale = scale
    obj.rotation_euler[2] = rotation_z
    target.objects.link(obj)
    return obj


def catmull_rom(
    p0: tuple[float, float, float],
    p1: tuple[float, float, float],
    p2: tuple[float, float, float],
    p3: tuple[float, float, float],
    t: float,
) -> tuple[float, float, float]:
    t2 = t * t
    t3 = t2 * t
    return tuple(
        0.5
        * (
            2.0 * p1[axis]
            + (-p0[axis] + p2[axis]) * t
            + (2.0 * p0[axis] - 5.0 * p1[axis] + 4.0 * p2[axis] - p3[axis]) * t2
            + (-p0[axis] + 3.0 * p1[axis] - 3.0 * p2[axis] + p3[axis]) * t3
        )
        for axis in range(3)
    )


ROAD_CONTROLS = [
    (0.0, -30.0, 0.0),
    (0.0, 0.0, 0.1),
    (2.0, 32.0, 1.0),
    (-6.0, 64.0, 2.8),
    (-31.0, 94.0, 5.8),
    (-50.0, 126.0, 9.5),
    (-45.0, 160.0, 14.5),
    (-22.0, 194.0, 19.0),
    (11.0, 226.0, 23.0),
    (42.0, 258.0, 27.0),
    (62.0, 292.0, 30.0),
    (150.0, 318.0, 32.0),
    (250.0, 275.0, 26.0),
    (285.0, 180.0, 18.0),
    (260.0, 70.0, 9.0),
    (190.0, -35.0, 3.0),
    (90.0, -80.0, 0.8),
]


def sample_road() -> list[tuple[float, float, float]]:
    result: list[tuple[float, float, float]] = []
    control_count = len(ROAD_CONTROLS)
    for index in range(control_count):
        for step in range(20):
            result.append(
                catmull_rom(
                    ROAD_CONTROLS[(index - 1) % control_count],
                    ROAD_CONTROLS[index],
                    ROAD_CONTROLS[(index + 1) % control_count],
                    ROAD_CONTROLS[(index + 2) % control_count],
                    step / 20.0,
                )
            )
    result.append(result[0])
    return result


ROAD_SAMPLES = sample_road()


def nearest_road(x: float, y: float) -> tuple[float, float]:
    best_distance = float("inf")
    best_height = 0.0
    for start, end in zip(ROAD_SAMPLES, ROAD_SAMPLES[1:]):
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        length_squared = dx * dx + dy * dy
        if length_squared <= 0.0001:
            continue
        along = max(0.0, min(1.0, ((x - start[0]) * dx + (y - start[1]) * dy) / length_squared))
        px = start[0] + dx * along
        py = start[1] + dy * along
        distance = math.hypot(x - px, y - py)
        if distance < best_distance:
            best_distance = distance
            best_height = start[2] + (end[2] - start[2]) * along
    return best_distance, best_height


def raw_terrain_height(x: float, y: float) -> float:
    side_rise = 0.00078 * x * x
    forward_rise = max(0.0, y) * 0.018
    large = math.sin(x * 0.032 + y * 0.018) * 2.5
    medium = math.sin(x * 0.091 - y * 0.044) * 0.8
    ridge_left = 10.0 * math.exp(-((x + 76.0) ** 2) / 1200.0) * (0.4 + max(0.0, y) / 260.0)
    ridge_right = 8.0 * math.exp(-((x - 82.0) ** 2) / 1350.0) * (0.5 + max(0.0, y) / 280.0)
    return side_rise + forward_rise + large + medium + ridge_left + ridge_right


def terrain_height(x: float, y: float) -> float:
    distance, road_z = nearest_road(x, y)
    natural = raw_terrain_height(x, y)
    if distance <= 9.0:
        return road_z - 0.34
    if distance >= 25.0:
        return natural
    blend = (distance - 9.0) / 16.0
    blend = blend * blend * (3.0 - 2.0 * blend)
    return (road_z - 0.34) * (1.0 - blend) + natural * blend


def create_terrain(
    material: bpy.types.Material,
    target: bpy.types.Collection,
) -> bpy.types.Object:
    x_segments = 164
    y_segments = 158
    x_min, x_max = -175.0, 320.0
    y_min, y_max = -105.0, 340.0
    vertices = []
    faces = []
    for yi in range(y_segments + 1):
        y = y_min + (y_max - y_min) * yi / y_segments
        for xi in range(x_segments + 1):
            x = x_min + (x_max - x_min) * xi / x_segments
            vertices.append((x, y, terrain_height(x, y)))
    stride = x_segments + 1
    for yi in range(y_segments):
        for xi in range(x_segments):
            a = yi * stride + xi
            faces.append((a, a + 1, a + stride + 1, a + stride))
    mesh = bpy.data.meshes.new("Golden valley terrain mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new("Golden valley terrain", mesh)
    target.objects.link(obj)
    return obj


def create_road(
    materials: list[bpy.types.Material],
    target: bpy.types.Collection,
) -> bpy.types.Object:
    offsets = [-8.4, -7.35, -6.25, 6.25, 7.35, 8.4]
    vertices = []
    faces = []
    face_materials = []
    for index, point in enumerate(ROAD_SAMPLES):
        previous = ROAD_SAMPLES[max(0, index - 1)]
        following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, index + 1)]
        tx = following[0] - previous[0]
        ty = following[1] - previous[1]
        length = max(0.001, math.hypot(tx, ty))
        right = (ty / length, -tx / length)
        for offset in offsets:
            vertices.append(
                (
                    point[0] + right[0] * offset,
                    point[1] + right[1] * offset,
                    point[2] + 0.035 + abs(offset) * 0.006,
                )
            )
    stride = len(offsets)
    for index in range(len(ROAD_SAMPLES) - 1):
        for band in range(stride - 1):
            a = index * stride + band
            faces.append((a, a + stride, a + stride + 1, a + 1))
            if band == 2:
                face_materials.append(0)
            elif band in (1, 3):
                face_materials.append(2 if (index // 4) % 2 == 0 else 3)
            else:
                face_materials.append(1)
    mesh = bpy.data.meshes.new("Golden S curve road mesh")
    mesh.from_pydata(vertices, [], faces)
    for material in materials:
        mesh.materials.append(material)
    for polygon, material_index in zip(mesh.polygons, face_materials):
        polygon.material_index = material_index
        polygon.use_smooth = True
    obj = bpy.data.objects.new("Golden S curve road", mesh)
    target.objects.link(obj)
    return obj


def create_rock_template(
    name: str,
    material: bpy.types.Material,
    target: bpy.types.Collection,
    seed: int,
) -> bpy.types.Object:
    rng = random.Random(seed)
    segments = 10
    rings = 5
    vertices = []
    faces = []
    for ring in range(rings + 1):
        polar = math.pi * ring / rings
        z = math.cos(polar) * 0.5
        radius = math.sin(polar) * 0.5
        for segment in range(segments):
            angle = math.tau * segment / segments
            noise = 0.78 + rng.random() * 0.34
            vertices.append(
                (
                    math.cos(angle) * radius * noise,
                    math.sin(angle) * radius * noise,
                    z * (0.86 + rng.random() * 0.24),
                )
            )
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            c = (ring + 1) * segments + (segment + 1) % segments
            d = (ring + 1) * segments + segment
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(f"{name} mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    obj.hide_render = True
    obj.hide_viewport = True
    target.objects.link(obj)
    return obj


def create_tree_template(
    name: str,
    trunk_material: bpy.types.Material,
    foliage_material: bpy.types.Material,
    target: bpy.types.Collection,
    seed: int,
) -> bpy.types.Object:
    rng = random.Random(seed)
    segments = 9
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    material_indices: list[int] = []

    def add_frustum(radius_bottom: float, radius_top: float, z_bottom: float, z_top: float, material: int):
        base = len(vertices)
        for z, radius in ((z_bottom, radius_bottom), (z_top, radius_top)):
            for segment in range(segments):
                angle = math.tau * segment / segments
                irregular = 0.92 + rng.random() * 0.16
                vertices.append((math.cos(angle) * radius * irregular, math.sin(angle) * radius * irregular, z))
        for segment in range(segments):
            a = base + segment
            b = base + (segment + 1) % segments
            c = base + segments + (segment + 1) % segments
            d = base + segments + segment
            faces.append((a, b, c, d))
            material_indices.append(material)

    add_frustum(0.28, 0.20, 0.0, 4.5, 0)
    for base_z, radius, height in (
        (0.8, 3.0, 3.2),
        (1.9, 2.75, 3.1),
        (3.0, 2.45, 3.0),
        (4.1, 2.1, 2.8),
        (5.1, 1.72, 2.6),
        (6.0, 1.30, 2.3),
    ):
        base = len(vertices)
        vertices.append((0.0, 0.0, base_z + height))
        for segment in range(segments):
            angle = math.tau * segment / segments
            irregular = 0.84 + rng.random() * 0.28
            vertices.append((math.cos(angle) * radius * irregular, math.sin(angle) * radius * irregular, base_z))
        for segment in range(segments):
            faces.append((base, base + 1 + (segment + 1) % segments, base + 1 + segment))
            material_indices.append(1)
    mesh = bpy.data.meshes.new(f"{name} mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(trunk_material)
    mesh.materials.append(foliage_material)
    for polygon, index in zip(mesh.polygons, material_indices):
        polygon.material_index = index
    obj = bpy.data.objects.new(name, mesh)
    obj.hide_render = True
    obj.hide_viewport = True
    target.objects.link(obj)
    return obj


def create_mountain(
    name: str,
    center: tuple[float, float, float],
    radius: float,
    height: float,
    rock_material: bpy.types.Material,
    snow_material: bpy.types.Material,
    target: bpy.types.Collection,
    seed: int,
) -> bpy.types.Object:
    rng = random.Random(seed)
    segments = 32
    rings = 13
    vertices = []
    faces = []
    material_indices = []
    for ring in range(rings + 1):
        along = ring / rings
        z = center[2] + height * along
        ring_radius = radius * (1.0 - along) ** 0.72
        for segment in range(segments):
            angle = math.tau * segment / segments
            ridge = (
                1.0
                + 0.12 * math.sin(angle * 3.0 + seed)
                + 0.07 * math.sin(angle * 7.0 - seed * 0.13)
                + rng.uniform(-0.045, 0.045)
            )
            terrace = math.sin(along * math.pi * 8.0 + angle * 2.0) * radius * 0.018
            vertices.append(
                (
                    center[0] + math.cos(angle) * (ring_radius * ridge + terrace),
                    center[1] + math.sin(angle) * (ring_radius * ridge + terrace) * 0.56,
                    z + rng.uniform(-0.016, 0.016) * height,
                )
            )
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            c = (ring + 1) * segments + (segment + 1) % segments
            d = (ring + 1) * segments + segment
            faces.append((a, b, c, d))
            snow_line = rings - 4 + int(1.25 * math.sin(segment * 0.9 + seed))
            material_indices.append(1 if ring >= snow_line else 0)
    mesh = bpy.data.meshes.new(f"{name} mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(rock_material)
    mesh.materials.append(snow_material)
    for polygon, index in zip(mesh.polygons, material_indices):
        polygon.material_index = index
        polygon.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    target.objects.link(obj)
    return obj


def create_cliff_wall(
    rock: bpy.types.Material,
    target: bpy.types.Collection,
) -> bpy.types.Object:
    rng = random.Random(8127)
    columns = 25
    rows = 8
    x_min, x_max = 3.0, 105.0
    base_z = 16.0
    vertices = []
    faces = []
    for row in range(rows + 1):
        along_z = row / rows
        for column in range(columns + 1):
            along_x = column / columns
            x = x_min + (x_max - x_min) * along_x
            crest = 64.0 + math.sin(column * 0.55) * 4.0 + math.sin(column * 1.7) * 1.8
            z = base_z + (crest - base_z) * along_z
            if 0 < row < rows:
                z += rng.uniform(-1.6, 1.6)
            y = 251.5 + math.sin(column * 0.9 + row * 0.7) * 2.0 + rng.uniform(-0.7, 0.7)
            if row == rows:
                y += rng.uniform(-2.0, 2.0)
            vertices.append((x, y, z))
    stride = columns + 1
    for row in range(rows):
        for column in range(columns):
            a = row * stride + column
            faces.append((a, a + 1, a + stride + 1, a + stride))
    mesh = bpy.data.meshes.new("Waterfall cliff wall mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(rock)
    for polygon in mesh.polygons:
        polygon.use_smooth = False
    obj = bpy.data.objects.new("Waterfall cliff wall", mesh)
    target.objects.link(obj)
    return obj


def create_stream(
    material: bpy.types.Material,
    foam_material: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    points = []
    for index in range(70):
        y = 42.0 + index * 2.9
        x = 38.0 + math.sin(index * 0.22) * 4.0 + max(0.0, y - 150.0) * 0.09
        z = terrain_height(x, y) + 0.12
        points.append((x, y, z))
    vertices = []
    faces = []
    for x, y, z in points:
        width = 4.1 + math.sin(y * 0.06) * 0.7
        vertices.extend(((x - width, y, z), (x + width, y, z)))
    for index in range(len(points) - 1):
        a = index * 2
        faces.append((a, a + 2, a + 3, a + 1))
    mesh = bpy.data.meshes.new("Creek water mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    creek = bpy.data.objects.new("Turquoise mountain creek", mesh)
    target.objects.link(creek)

    for index in range(7, len(points), 9):
        x, y, z = points[index]
        create_box(
            f"Creek foam {index}",
            (x, y, z + 0.08),
            (6.4, 0.35, 0.06),
            foam_material,
            target,
            rotation=(0.0, 0.0, math.sin(index) * 0.25),
            bevel=0.08,
        )


def create_waterfall(
    water: bpy.types.Material,
    foam: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    rng = random.Random(4407)
    columns = 18
    rows = 34
    vertices = []
    faces = []
    for row in range(rows + 1):
        along = row / rows
        z = 62.0 - along * 40.5
        center_x = 52.5 + math.sin(along * math.pi * 2.4) * (0.8 + along * 0.9)
        width = 10.0 + along * 5.8 + math.sin(along * math.pi * 5.0) * 0.7
        for column in range(columns + 1):
            across = column / columns
            edge = (across - 0.5) * width
            edge_falloff = abs(across - 0.5) * 2.0
            x = center_x + edge + math.sin(row * 0.48 + column * 0.9) * 0.14
            y = 245.2 - along * 2.8 + math.sin(along * 18.0 + across * 7.0) * 0.34
            y -= edge_falloff * 0.22
            vertices.append((x, y, z + rng.uniform(-0.08, 0.08)))
    stride = columns + 1
    for row in range(rows):
        for column in range(columns):
            a = row * stride + column
            faces.append((a, a + stride, a + stride + 1, a + 1))
    mesh = bpy.data.meshes.new("Continuous waterfall sheet mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(water)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    waterfall = bpy.data.objects.new("Continuous waterfall sheet", mesh)
    target.objects.link(waterfall)

    create_box(
        "Waterfall upper river",
        (52.0, 257.0, 62.2),
        (11.0, 19.0, 0.32),
        water,
        target,
        rotation=(math.radians(3.0), 0.0, 0.0),
        bevel=0.16,
    )

    for ledge_index, (x, z, width) in enumerate(
        ((48.0, 52.5, 5.0), (56.2, 45.0, 6.2), (50.5, 34.0, 7.0), (57.0, 27.5, 4.8))
    ):
        create_box(
            f"Waterfall rock ledge {ledge_index}",
            (x, 245.0, z + 0.2),
            (width, 3.0, 1.35),
            rock_material,
            target,
            rotation=(0.0, math.radians(math.sin(ledge_index) * 4.0), 0.0),
            bevel=0.28,
        )
        create_uv_sphere(
            f"Waterfall ledge foam {ledge_index}",
            (x, 243.15, z - 0.55),
            (width * 0.58, 0.78, 0.34),
            foam,
            target,
            segments=20,
            rings=8,
        )
    create_uv_sphere(
        "Waterfall impact foam",
        (52.0, 243.4, 21.8),
        (9.5, 2.8, 1.55),
        foam,
        target,
        segments=24,
        rings=12,
    )
    for mist_index in range(8):
        create_uv_sphere(
            f"Waterfall mist {mist_index}",
            (
                45.0 + mist_index * 1.8,
                242.0 - (mist_index % 3) * 0.5,
                22.6 + (mist_index % 4) * 0.8,
            ),
            (2.3, 1.0, 1.3),
            foam,
            target,
            segments=12,
            rings=7,
        )


def create_stone_bridge(
    stone: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    center_x, center_y, center_z = 41.0, 137.0, terrain_height(41.0, 137.0) + 3.2
    for index in range(15):
        angle = math.radians(15.0 + index * 10.7)
        x = center_x + math.cos(angle) * 8.5
        z = center_z + math.sin(angle) * 7.0
        create_box(
            f"Bridge arch stone {index:02d}",
            (x, center_y, z),
            (2.0, 5.8, 2.1),
            stone,
            target,
            rotation=(0.0, -angle + math.pi * 0.5, 0.0),
            bevel=0.22,
        )
    create_box(
        "Bridge deck",
        (center_x, center_y, center_z + 7.2),
        (22.0, 6.6, 1.3),
        stone,
        target,
        bevel=0.35,
    )
    for side in (-1.0, 1.0):
        for index in range(9):
            create_box(
                f"Bridge parapet {side} {index}",
                (center_x - 9.0 + index * 2.25, center_y + side * 2.85, center_z + 8.35),
                (1.8, 0.65, 1.1),
                stone,
                target,
                bevel=0.18,
            )


def create_lodge(
    wood: bpy.types.Material,
    plaster: bpy.types.Material,
    roof: bpy.types.Material,
    glass: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    x, y = 42.0, 121.0
    ground = terrain_height(x, y)
    create_box("Lodge stone foundation", (x, y, ground + 1.7), (28.0, 19.0, 3.4), wood, target, bevel=0.35)
    create_box("Lodge plaster floor", (x, y, ground + 7.0), (24.0, 17.0, 7.5), plaster, target, bevel=0.24)
    create_box("Lodge timber upper", (x, y, ground + 13.0), (21.0, 15.0, 5.8), wood, target, bevel=0.26)
    for side in (-1.0, 1.0):
        create_box(
            f"Lodge roof slope {side}",
            (x + side * 5.8, y, ground + 18.2),
            (15.0, 21.0, 1.2),
            roof,
            target,
            rotation=(0.0, side * math.radians(32.0), 0.0),
            bevel=0.25,
        )
    create_box("Lodge balcony deck", (x - 12.5, y - 1.0, ground + 11.0), (4.0, 17.0, 0.7), wood, target, bevel=0.16)
    for yi in (-6.0, -2.0, 2.0, 6.0):
        create_box("Lodge balcony rail", (x - 14.1, y + yi, ground + 12.2), (0.38, 0.38, 2.6), wood, target, bevel=0.08)
    create_box("Lodge balcony top rail", (x - 14.1, y, ground + 13.4), (0.38, 17.0, 0.42), wood, target, bevel=0.08)
    for floor_z in (ground + 7.3, ground + 13.4):
        for yi in (-5.0, 0.0, 5.0):
            create_box(
                "Lodge glowing window",
                (x - 12.18, y + yi, floor_z),
                (0.25, 2.8, 2.5),
                glass,
                target,
                bevel=0.08,
            )
    for z_offset in (4.0, 10.5, 16.0):
        create_box(
            f"Lodge horizontal timber {z_offset}",
            (x - 12.42, y, ground + z_offset),
            (0.34, 18.0, 0.42),
            wood,
            target,
            bevel=0.06,
        )
    for yi in (-7.5, -2.5, 2.5, 7.5):
        create_box(
            f"Lodge vertical timber {yi}",
            (x - 12.45, y + yi, ground + 8.8),
            (0.34, 0.42, 11.8),
            wood,
            target,
            bevel=0.06,
        )
    create_box(
        "Lodge front balcony deck",
        (x, y - 9.4, ground + 11.0),
        (22.0, 2.6, 0.7),
        wood,
        target,
        bevel=0.14,
    )
    for xi in (-9.2, -5.5, -1.8, 1.8, 5.5, 9.2):
        create_box(
            f"Lodge front balcony post {xi}",
            (x + xi, y - 10.5, ground + 12.25),
            (0.36, 0.36, 2.55),
            wood,
            target,
            bevel=0.07,
        )
    create_box(
        "Lodge front balcony rail",
        (x, y - 10.55, ground + 13.45),
        (22.0, 0.4, 0.4),
        wood,
        target,
        bevel=0.07,
    )
    for floor_z in (ground + 7.2, ground + 13.35):
        for xi in (-7.8, -2.6, 2.6, 7.8):
            create_box(
                "Lodge front glowing window",
                (x + xi, y - 8.62, floor_z),
                (2.7, 0.24, 2.45),
                glass,
                target,
                bevel=0.08,
            )
    for z_offset in (4.0, 10.4, 16.1):
        create_box(
            f"Lodge front horizontal timber {z_offset}",
            (x, y - 8.75, ground + z_offset),
            (24.0, 0.32, 0.42),
            wood,
            target,
            bevel=0.05,
        )
    for xi in (-10.0, -5.0, 0.0, 5.0, 10.0):
        create_box(
            f"Lodge front vertical timber {xi}",
            (x + xi, y - 8.78, ground + 8.7),
            (0.38, 0.32, 11.6),
            wood,
            target,
            bevel=0.05,
        )
    for side in (-1.0, 1.0):
        create_box(
            f"Lodge roof fascia {side}",
            (x + side * 11.3, y, ground + 17.2),
            (0.4, 22.0, 0.55),
            wood,
            target,
            rotation=(0.0, side * math.radians(32.0), 0.0),
            bevel=0.08,
        )
    create_cylinder("Lodge chimney", (x + 4.0, y + 2.0, ground + 21.5), 1.1, 7.0, stone_material, target, vertices=10, bevel=0.12)


def create_tent(
    name: str,
    location: tuple[float, float, float],
    fabric: bpy.types.Material,
    pole: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    x, y, z = location
    create_box(f"{name} canopy", (x, y, z + 3.6), (8.4, 6.4, 0.55), fabric, target, rotation=(0.0, math.radians(4.0), 0.0), bevel=0.2)
    for dx in (-3.6, 3.6):
        for dy in (-2.6, 2.6):
            create_cylinder(f"{name} pole", (x + dx, y + dy, z + 1.8), 0.1, 3.6, pole, target, vertices=8)


def create_pennant_line(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    materials: tuple[bpy.types.Material, ...],
    target: bpy.types.Collection,
) -> None:
    create_beam_between(f"{name} cable", start, end, 0.055, dark_material, target)
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = (end_vector - start_vector).normalized()
    for index in range(15):
        along = (index + 0.5) / 15.0
        center = start_vector.lerp(end_vector, along)
        center.z -= math.sin(along * math.pi) * 1.0
        half_width = 0.48
        vertices = [
            tuple(center - direction * half_width),
            tuple(center + direction * half_width),
            tuple(center + Vector((0.0, 0.0, -1.25))),
        ]
        mesh = bpy.data.meshes.new(f"{name} flag {index} mesh")
        mesh.from_pydata(vertices, [], [(0, 1, 2)])
        mesh.materials.append(materials[index % len(materials)])
        flag = bpy.data.objects.new(f"{name} flag {index}", mesh)
        target.objects.link(flag)


def create_person_template(
    name: str,
    body_material: bpy.types.Material,
    skin_material: bpy.types.Material,
    target: bpy.types.Collection,
) -> bpy.types.Object:
    person_collection = collection(f"{name} source collection")
    torso = create_cylinder(name, (0.0, 0.0, 0.9), 0.30, 1.4, body_material, person_collection, vertices=8)
    head = create_uv_sphere(f"{name} head", (0.0, 0.0, 1.85), (0.38, 0.38, 0.42), skin_material, person_collection, segments=12, rings=8)
    bpy.ops.object.select_all(action="DESELECT")
    torso.select_set(True)
    head.select_set(True)
    bpy.context.view_layer.objects.active = torso
    bpy.ops.object.join()
    torso.hide_render = True
    torso.hide_viewport = True
    move_to_collection(torso, target)
    return torso


def create_kart(
    name: str,
    location: tuple[float, float, float],
    yaw: float,
    body_material: bpy.types.Material,
    accent_material: bpy.types.Material,
    target: bpy.types.Collection,
    scale: float = 1.0,
) -> bpy.types.Object:
    root = bpy.data.objects.new(name, None)
    root.empty_display_size = 1.0
    root.location = location
    root.rotation_euler[2] = yaw
    root.scale = (scale, scale, scale)
    target.objects.link(root)

    chassis = create_box(f"{name} chassis", (0.0, 0.0, 0.58), (2.8, 4.35, 0.48), dark_material, target, bevel=0.22)
    body = create_box(f"{name} body", (0.0, 0.25, 0.88), (2.65, 3.55, 0.74), body_material, target, bevel=0.36)
    nose = create_uv_sphere(f"{name} nose", (0.0, 1.72, 0.78), (1.38, 1.34, 0.54), body_material, target)
    nose_accent = create_box(f"{name} nose accent", (0.0, 1.9, 1.18), (0.62, 1.28, 0.18), accent_material, target, bevel=0.12)
    cockpit = create_box(f"{name} cockpit", (0.0, -0.25, 1.35), (1.5, 1.62, 1.0), dark_material, target, bevel=0.28)
    spoiler = create_box(f"{name} spoiler", (0.0, -2.18, 1.62), (3.35, 0.38, 0.30), accent_material, target, bevel=0.12)
    spoiler_left = create_box(f"{name} spoiler left", (-1.38, -2.1, 1.26), (0.24, 0.38, 0.85), accent_material, target, bevel=0.08)
    spoiler_right = create_box(f"{name} spoiler right", (1.38, -2.1, 1.26), (0.24, 0.38, 0.85), accent_material, target, bevel=0.08)
    helmet = create_uv_sphere(f"{name} driver", (0.0, -0.15, 2.12), (0.62, 0.62, 0.68), helmet_material, target)
    visor = create_box(f"{name} visor", (0.0, 0.38, 2.16), (0.78, 0.18, 0.26), accent_material, target, bevel=0.1)
    engine = create_box(f"{name} rear engine", (0.0, -1.65, 0.92), (1.55, 0.75, 0.72), dark_material, target, bevel=0.2)
    rear_light_left = create_cylinder(
        f"{name} rear light left", (-0.72, -2.06, 0.94), 0.21, 0.18, accent_material, target,
        vertices=16, rotation=(math.pi * 0.5, 0.0, 0.0), bevel=0.04,
    )
    rear_light_right = create_cylinder(
        f"{name} rear light right", (0.72, -2.06, 0.94), 0.21, 0.18, accent_material, target,
        vertices=16, rotation=(math.pi * 0.5, 0.0, 0.0), bevel=0.04,
    )
    exhaust_left = create_cylinder(
        f"{name} exhaust left", (-0.78, -2.38, 0.54), 0.22, 0.72, dark_material, target,
        vertices=16, rotation=(math.pi * 0.5, 0.0, 0.0), bevel=0.06,
    )
    exhaust_right = create_cylinder(
        f"{name} exhaust right", (0.78, -2.38, 0.54), 0.22, 0.72, dark_material, target,
        vertices=16, rotation=(math.pi * 0.5, 0.0, 0.0), bevel=0.06,
    )
    for child in (
        chassis, body, nose, nose_accent, cockpit, spoiler, spoiler_left, spoiler_right,
        helmet, visor, engine, rear_light_left, rear_light_right, exhaust_left, exhaust_right,
    ):
        child.parent = root
    for x in (-1.5, 1.5):
        for y in (-1.42, 1.35):
            wheel = create_cylinder(
                f"{name} wheel",
                (x, y, 0.65),
                0.62,
                0.48,
                tire_material,
                target,
                vertices=18,
                rotation=(0.0, math.pi * 0.5, 0.0),
                bevel=0.08,
            )
            wheel.parent = root
            hub = create_cylinder(
                f"{name} wheel hub",
                (x, y, 0.65),
                0.28,
                0.53,
                accent_material,
                target,
                vertices=16,
                rotation=(0.0, math.pi * 0.5, 0.0),
                bevel=0.05,
            )
            hub.parent = root
    return root


def create_beam_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    thickness: float,
    material: bpy.types.Material,
    target: bpy.types.Collection,
) -> bpy.types.Object:
    start_vector = Vector(start)
    end_vector = Vector(end)
    midpoint = (start_vector + end_vector) * 0.5
    direction = end_vector - start_vector
    length = direction.length
    obj = create_box(
        name,
        midpoint,
        (thickness, thickness, length),
        material,
        target,
        bevel=thickness * 0.18,
    )
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def create_roadside_fences(
    wood: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    for side, start_index, end_index in ((-1.0, 22, 142), (1.0, 70, 158)):
        fence_points = []
        for point_index in range(start_index, end_index + 1, 6):
            point = ROAD_SAMPLES[point_index]
            previous = ROAD_SAMPLES[max(0, point_index - 1)]
            following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, point_index + 1)]
            tx, ty = following[0] - previous[0], following[1] - previous[1]
            length = max(0.001, math.hypot(tx, ty))
            x = point[0] + ty / length * 11.6 * side
            y = point[1] - tx / length * 11.6 * side
            ground = terrain_height(x, y)
            fence_points.append((x, y, ground))
            create_box(
                f"Fence post {side} {point_index}",
                (x, y, ground + 1.35),
                (0.42, 0.42, 2.7),
                wood,
                target,
                bevel=0.08,
            )
        for segment_index, (start, end) in enumerate(zip(fence_points, fence_points[1:])):
            for height in (0.92, 1.82):
                create_beam_between(
                    f"Fence rail {side} {segment_index} {height}",
                    (start[0], start[1], start[2] + height),
                    (end[0], end[1], end[2] + height),
                    0.26,
                    wood,
                    target,
                )


def create_skid_marks(
    material: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    for track_index, offset in enumerate((-1.1, 1.1)):
        vertices = []
        faces = []
        for point_index in range(8, 119):
            point = ROAD_SAMPLES[point_index]
            previous = ROAD_SAMPLES[max(0, point_index - 1)]
            following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, point_index + 1)]
            tx, ty = following[0] - previous[0], following[1] - previous[1]
            length = max(0.001, math.hypot(tx, ty))
            right_x, right_y = ty / length, -tx / length
            wobble = math.sin(point_index * 0.16 + track_index) * 0.18
            center_offset = offset + wobble
            half_width = 0.13
            for edge in (-half_width, half_width):
                total_offset = center_offset + edge
                vertices.append(
                    (
                        point[0] + right_x * total_offset,
                        point[1] + right_y * total_offset,
                        point[2] + 0.075,
                    )
                )
        for index in range(110):
            base = index * 2
            faces.append((base, base + 2, base + 3, base + 1))
        mesh = bpy.data.meshes.new(f"Skid track {track_index} mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(material)
        obj = bpy.data.objects.new(f"Skid track {track_index}", mesh)
        target.objects.link(obj)


def create_sky_dome(
    materials: tuple[bpy.types.Material, ...],
    target: bpy.types.Collection,
) -> bpy.types.Object:
    segments = 36
    rings = 16
    center = Vector((62.0, 116.0, 76.0))
    radius = Vector((880.0, 880.0, 560.0))
    vertices = []
    faces = []
    face_materials = []
    for ring in range(rings + 1):
        polar = math.pi * ring / rings
        ring_radius = math.sin(polar)
        for segment in range(segments):
            angle = math.tau * segment / segments
            vertices.append(
                (
                    center.x + math.cos(angle) * ring_radius * radius.x,
                    center.y + math.sin(angle) * ring_radius * radius.y,
                    center.z + math.cos(polar) * radius.z,
                )
            )
    for ring in range(rings):
        for segment in range(segments):
            following = (segment + 1) % segments
            faces.append(
                (
                    ring * segments + segment,
                    (ring + 1) * segments + segment,
                    (ring + 1) * segments + following,
                    ring * segments + following,
                )
            )
            normalized_height = ring / max(1, rings - 1)
            if normalized_height < 0.28:
                face_materials.append(0)
            elif normalized_height < 0.48:
                face_materials.append(1)
            else:
                face_materials.append(2)
    mesh = bpy.data.meshes.new("Layered alpine sky dome mesh")
    mesh.from_pydata(vertices, [], faces)
    for material in materials:
        mesh.materials.append(material)
    for polygon, material_index in zip(mesh.polygons, face_materials):
        polygon.material_index = material_index
        polygon.use_smooth = True
    obj = bpy.data.objects.new("Layered alpine sky dome", mesh)
    target.objects.link(obj)
    return obj


def create_start_gantry(
    dark: bpy.types.Material,
    gold: bpy.types.Material,
    cyan: bpy.types.Material,
    red: bpy.types.Material,
    white: bpy.types.Material,
    target: bpy.types.Collection,
) -> None:
    point_index = 38
    point = Vector(ROAD_SAMPLES[point_index])
    previous = Vector(ROAD_SAMPLES[point_index - 1])
    following = Vector(ROAD_SAMPLES[point_index + 1])
    tangent = (following - previous).normalized()
    right = Vector((tangent.y, -tangent.x, 0.0))
    ground = point.z
    left_post = point - right * 10.7
    right_post = point + right * 10.7
    for name, post in (("left", left_post), ("right", right_post)):
        create_box(
            f"Start gantry {name} foot",
            (post.x, post.y, ground + 0.45),
            (2.6, 2.6, 0.9),
            gold,
            target,
            rotation=(0.0, 0.0, math.atan2(tangent.y, tangent.x)),
            bevel=0.24,
        )
        create_box(
            f"Start gantry {name} tower",
            (post.x, post.y, ground + 4.65),
            (1.25, 1.25, 8.4),
            dark,
            target,
            rotation=(0.0, 0.0, math.atan2(tangent.y, tangent.x)),
            bevel=0.16,
        )
        create_box(
            f"Start gantry {name} cyan inset",
            (
                post.x - tangent.x * 0.66,
                post.y - tangent.y * 0.66,
                ground + 5.15,
            ),
            (0.18, 0.86, 5.6),
            cyan,
            target,
            rotation=(0.0, 0.0, math.atan2(tangent.y, tangent.x)),
            bevel=0.06,
        )
    create_beam_between(
        "Start gantry cross beam",
        (left_post.x, left_post.y, ground + 8.45),
        (right_post.x, right_post.y, ground + 8.45),
        0.78,
        dark,
        target,
    )
    create_beam_between(
        "Start gantry gold crown",
        (left_post.x, left_post.y, ground + 9.28),
        (right_post.x, right_post.y, ground + 9.28),
        0.16,
        gold,
        target,
    )
    for column in range(12):
        checker_material = white if column % 2 == 0 else dark
        center = point + right * ((column - 5.5) * 1.55) - tangent * 0.86
        create_box(
            f"Start checker {column:02d}",
            (center.x, center.y, ground + 8.46),
            (1.42, 0.22, 0.96),
            checker_material,
            target,
            rotation=(0.0, 0.0, math.atan2(tangent.y, tangent.x)),
            bevel=0.03,
        )
    for light_index in range(5):
        center = point + right * ((light_index - 2) * 1.65) - tangent * 1.06
        create_uv_sphere(
            f"Start signal {light_index}",
            (center.x, center.y, ground + 7.05),
            (0.48, 0.22, 0.48),
            red if light_index < 3 else gold,
            target,
            segments=12,
            rings=7,
        )
    for side in (-1.0, 1.0):
        mast = point + right * (side * 9.25)
        create_box(
            f"Start flag mast {side}",
            (mast.x, mast.y, ground + 11.05),
            (0.16, 0.16, 3.6),
            gold,
            target,
        )
        flag_center = mast + right * (-side * 1.2) + Vector((0.0, 0.0, 1.1))
        create_box(
            f"Start flag {side}",
            (flag_center.x, flag_center.y, ground + 11.05),
            (2.3, 0.12, 1.45),
            cyan if side < 0 else gold,
            target,
            rotation=(0.0, 0.0, math.atan2(tangent.y, tangent.x)),
            bevel=0.04,
        )


def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def begin_gltf_material_fallbacks(
    fallbacks: tuple[tuple[bpy.types.Material, tuple[float, float, float, float]], ...],
) -> list[tuple[bpy.types.Material, tuple[float, float, float, float], list[tuple[object, object]]]]:
    state = []
    for material, color in fallbacks:
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        base_color = bsdf.inputs.get("Base Color")
        if base_color is None:
            continue
        old_color = tuple(base_color.default_value)
        old_links = [
            (link.from_socket, link.to_socket)
            for link in material.node_tree.links
            if link.to_socket == base_color
        ]
        for link in list(material.node_tree.links):
            if link.to_socket == base_color:
                material.node_tree.links.remove(link)
        base_color.default_value = color
        state.append((material, old_color, old_links))
    return state


def restore_gltf_material_fallbacks(
    state: list[tuple[bpy.types.Material, tuple[float, float, float, float], list[tuple[object, object]]]],
) -> None:
    for material, old_color, old_links in state:
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        base_color = bsdf.inputs.get("Base Color")
        if base_color is None:
            continue
        base_color.default_value = old_color
        for from_socket, to_socket in old_links:
            material.node_tree.links.new(from_socket, to_socket)


clear_scene()

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.color_depth = "8"
scene.render.film_transparent = False
scene.render.fps = 60
scene.render.filepath = str(RENDER_PATH)
scene.render.use_file_extension = True
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    pass
scene.view_settings.exposure = 0.45

world = bpy.data.worlds.new("Alpine race day world")
scene.world = world
world.use_nodes = True
world_nodes = world.node_tree.nodes
world_links = world.node_tree.links
for node in list(world_nodes):
    world_nodes.remove(node)
world_output = world_nodes.new("ShaderNodeOutputWorld")
background = world_nodes.new("ShaderNodeBackground")
sky = world_nodes.new("ShaderNodeTexSky")
try:
    sky.sky_type = "HOSEK_WILKIE"
except TypeError:
    sky.sky_type = "SINGLE_SCATTERING"
sky.sun_elevation = math.radians(35.0)
sky.sun_rotation = math.radians(125.0)
sky.altitude = 1.2
sky.air_density = 1.0
if hasattr(sky, "turbidity"):
    sky.turbidity = 2.2
if hasattr(sky, "ground_albedo"):
    sky.ground_albedo = 0.24
if hasattr(sky, "dust_density"):
    sky.dust_density = 1.8
background.inputs["Strength"].default_value = 0.9
world_links.new(sky.outputs["Color"], background.inputs["Color"])
world_links.new(background.outputs["Background"], world_output.inputs["Surface"])

terrain_collection = collection("01 Terrain and road")
environment_collection = collection("02 Environment modules")
landmark_collection = collection("03 Landmarks")
race_collection = collection("04 Race dressing")
vehicle_collection = collection("05 Vehicles")
source_collection = collection("_Linked source meshes")

grass_material = procedural_surface_material(
    "Meadow grass",
    (0.035, 0.11, 0.018, 1.0),
    (0.13, 0.34, 0.045, 1.0),
    3.8,
    5.0,
    0.88,
    0.28,
)
asphalt_material = road_material()
shoulder_material = procedural_surface_material(
    "Road shoulder",
    (0.12, 0.07, 0.028, 1.0),
    (0.38, 0.25, 0.11, 1.0),
    5.5,
    5.0,
    0.92,
    0.35,
)
curb_red_material = principled_material("Curb red", (0.62, 0.018, 0.012, 1.0), 0.52)
curb_white_material = principled_material("Curb white", (0.82, 0.86, 0.84, 1.0), 0.5)
rock_material = procedural_surface_material(
    "Slate cliff",
    (0.040, 0.044, 0.050, 1.0),
    (0.19, 0.20, 0.21, 1.0),
    2.6,
    6.0,
    0.82,
    0.48,
)
stone_material = procedural_surface_material(
    "Bridge stone",
    (0.16, 0.14, 0.11, 1.0),
    (0.45, 0.43, 0.37, 1.0),
    4.0,
    5.0,
    0.85,
    0.38,
)
snow_material = principled_material("Mountain snow", (0.82, 0.91, 0.98, 1.0), 0.56)
cloud_material = principled_material("Sunlit alpine clouds", (0.94, 0.975, 1.0, 1.0), 0.92)
sky_zenith_material = principled_material(
    "Sky zenith",
    (0.018, 0.16, 0.48, 1.0),
    0.96,
    emission=(0.018, 0.16, 0.48),
    emission_strength=0.72,
)
sky_mid_material = principled_material(
    "Sky middle",
    (0.055, 0.32, 0.72, 1.0),
    0.96,
    emission=(0.055, 0.32, 0.72),
    emission_strength=0.68,
)
sky_horizon_material = principled_material(
    "Sky horizon",
    (0.36, 0.66, 0.88, 1.0),
    0.96,
    emission=(0.36, 0.66, 0.88),
    emission_strength=0.52,
)
sun_disc_material = principled_material(
    "Alpine sun disc",
    (1.0, 0.58, 0.10, 1.0),
    0.18,
    emission=(1.0, 0.28, 0.02),
    emission_strength=2.8,
)
trunk_material = principled_material("Pine trunk", (0.18, 0.075, 0.018, 1.0), 0.86)
pine_dark_material = principled_material("Pine forest dark", (0.008, 0.065, 0.021, 1.0), 0.78)
pine_light_material = principled_material("Pine forest light", (0.018, 0.135, 0.038, 1.0), 0.75)
water = water_material()
waterfall_surface = waterfall_material()
foam_material = principled_material(
    "Water foam",
    (0.92, 0.98, 1.0, 1.0),
    0.24,
    emission=(0.58, 0.82, 1.0),
    emission_strength=0.22,
)
wood_material = principled_material("Lodge timber", (0.22, 0.07, 0.018, 1.0), 0.68)
plaster_material = principled_material("Lodge plaster", (0.75, 0.65, 0.48, 1.0), 0.76)
roof_material = principled_material("Lodge red roof", (0.38, 0.025, 0.012, 1.0), 0.68)
glass_material = principled_material(
    "Warm lodge windows",
    (0.11, 0.19, 0.20, 1.0),
    0.18,
    metallic=0.2,
    emission=(1.0, 0.38, 0.05),
    emission_strength=0.95,
)
dark_material = principled_material("Race navy", (0.008, 0.018, 0.032, 1.0), 0.35, metallic=0.15)
gold_material = principled_material("Race gold", (0.95, 0.50, 0.035, 1.0), 0.27, metallic=0.58)
blue_material = principled_material("Hero blue", (0.015, 0.16, 0.62, 1.0), 0.24, metallic=0.34)
green_material = principled_material("Rival green", (0.015, 0.42, 0.10, 1.0), 0.3, metallic=0.18)
orange_material = principled_material("Rival orange", (0.95, 0.19, 0.015, 1.0), 0.28, metallic=0.22)
purple_material = principled_material("Rival purple", (0.31, 0.025, 0.62, 1.0), 0.28, metallic=0.25)
tire_material = principled_material("Kart tire", (0.006, 0.007, 0.009, 1.0), 0.7)
skid_material = principled_material("Rubber skid marks", (0.003, 0.004, 0.005, 1.0), 0.86)
helmet_material = principled_material("Driver helmet", (0.03, 0.06, 0.09, 1.0), 0.24, metallic=0.12)
banner_blue_material = principled_material("Festival cyan", (0.015, 0.35, 0.88, 1.0), 0.45)
banner_gold_material = principled_material("Festival gold", (1.0, 0.54, 0.03, 1.0), 0.43)
flower_gold_material = principled_material(
    "Golden flowers",
    (1.0, 0.46, 0.01, 1.0),
    0.46,
    emission=(0.6, 0.18, 0.0),
    emission_strength=0.25,
)
flower_blue_material = principled_material(
    "Blue flowers",
    (0.03, 0.35, 1.0, 1.0),
    0.46,
    emission=(0.0, 0.18, 0.62),
    emission_strength=0.2,
)
skin_material = principled_material("Spectator skin", (0.63, 0.28, 0.14, 1.0), 0.65)

create_sky_dome(
    (sky_zenith_material, sky_mid_material, sky_horizon_material),
    environment_collection,
)
create_uv_sphere(
    "Low geometry alpine sun",
    (-310.0, 610.0, 375.0),
    (34.0, 16.0, 34.0),
    sun_disc_material,
    environment_collection,
    segments=24,
    rings=12,
)
terrain = create_terrain(grass_material, terrain_collection)
road = create_road(
    [asphalt_material, shoulder_material, curb_red_material, curb_white_material],
    terrain_collection,
)
create_skid_marks(skid_material, race_collection)
create_roadside_fences(wood_material, race_collection)

create_stream(water, foam_material, landmark_collection)
create_cliff_wall(rock_material, environment_collection)
create_waterfall(waterfall_surface, foam_material, landmark_collection)
create_stone_bridge(stone_material, landmark_collection)
create_lodge(wood_material, plaster_material, roof_material, glass_material, landmark_collection)
create_start_gantry(
    dark_material,
    gold_material,
    banner_blue_material,
    curb_red_material,
    curb_white_material,
    race_collection,
)

for index, spec in enumerate(
    (
        ((-145.0, 345.0, 5.0), 86.0, 105.0),
        ((-62.0, 376.0, 8.0), 105.0, 142.0),
        ((40.0, 390.0, 10.0), 110.0, 158.0),
        ((142.0, 352.0, 4.0), 90.0, 122.0),
        ((220.0, 430.0, 0.0), 140.0, 185.0),
    )
):
    create_mountain(
        f"Layered alpine peak {index + 1}",
        spec[0],
        spec[1] * 0.74,
        spec[2] * 0.66,
        rock_material,
        snow_material,
        environment_collection,
        300 + index,
    )

for cloud_index, (center_x, center_y, center_z, cloud_scale) in enumerate(
    (
        (-104.0, 323.0, 132.0, 1.0),
        (82.0, 354.0, 165.0, 1.2),
        (178.0, 382.0, 124.0, 0.9),
    )
):
    for puff_index in range(7):
        angle = math.tau * puff_index / 7.0
        create_uv_sphere(
            f"Cloud {cloud_index} puff {puff_index}",
            (
                center_x + math.cos(angle) * 14.0 * cloud_scale,
                center_y + math.sin(angle) * 4.0,
                center_z + math.sin(angle * 1.7) * 5.5 + (puff_index % 2) * 4.0,
            ),
            (
                random.uniform(11.0, 20.0) * cloud_scale,
                random.uniform(4.0, 8.0) * cloud_scale,
                random.uniform(6.0, 11.0) * cloud_scale,
            ),
            cloud_material,
            environment_collection,
            segments=18,
            rings=10,
        )

rock_templates = [
    create_rock_template(f"Rock source {index}", rock_material, source_collection, 500 + index)
    for index in range(6)
]
for index in range(11):
    angle = math.tau * index / 11.0
    linked_instance(
        rock_templates[(index + 2) % len(rock_templates)],
        f"Waterfall basin rock {index:02d}",
        (
            52.0 + math.cos(angle) * random.uniform(8.0, 14.0),
            241.0 + math.sin(angle) * random.uniform(3.0, 7.0),
            21.0 + random.uniform(-1.0, 2.0),
        ),
        (
            random.uniform(3.0, 6.5),
            random.uniform(2.5, 5.0),
            random.uniform(2.0, 5.0),
        ),
        random.uniform(0.0, math.tau),
        environment_collection,
    )
cliff_groups = (
    (-82.0, 72.0, 14, 1.0),
    (82.0, 92.0, 13, 0.9),
    (-91.0, 165.0, 17, 1.2),
    (92.0, 206.0, 16, 1.1),
)
for group_index, (center_x, center_y, count, scale_base) in enumerate(cliff_groups):
    for index in range(count):
        x = center_x + random.uniform(-18.0, 18.0)
        y = center_y + random.uniform(-26.0, 28.0)
        z = terrain_height(x, y) + random.uniform(2.0, 10.0)
        scale = scale_base * random.uniform(9.0, 19.0)
        linked_instance(
            rock_templates[(group_index + index) % len(rock_templates)],
            f"Cliff mass {group_index:02d}-{index:02d}",
            (x, y, z),
            (scale * random.uniform(0.65, 1.15), scale * random.uniform(0.62, 1.0), scale * random.uniform(1.0, 1.8)),
            random.uniform(0.0, math.tau),
            environment_collection,
        )

tree_templates = [
    create_tree_template("Pine source dark A", trunk_material, pine_dark_material, source_collection, 700),
    create_tree_template("Pine source dark B", trunk_material, pine_dark_material, source_collection, 701),
    create_tree_template("Pine source light", trunk_material, pine_light_material, source_collection, 702),
]
shrub_templates = [
    create_rock_template("Shrub source dark", pine_dark_material, source_collection, 741),
    create_rock_template("Shrub source light", pine_light_material, source_collection, 742),
]
shrub_count = 0
for _ in range(135):
    x = random.uniform(-98.0, 102.0)
    y = random.uniform(8.0, 205.0)
    road_distance, _ = nearest_road(x, y)
    creek_distance = abs(x - (38.0 + max(0.0, y - 150.0) * 0.09))
    if road_distance < 13.5 or road_distance > 47.0 or creek_distance < 7.0:
        continue
    scale_x = random.uniform(1.4, 3.4)
    scale_y = random.uniform(1.2, 3.0)
    scale_z = random.uniform(0.8, 1.7)
    ground = terrain_height(x, y)
    linked_instance(
        random.choice(shrub_templates),
        f"Roadside shrub {shrub_count:03d}",
        (x, y, ground + scale_z * 0.38),
        (scale_x, scale_y, scale_z),
        random.uniform(0.0, math.tau),
        environment_collection,
    )
    shrub_count += 1

for index in range(36):
    point_index = random.randint(18, 132)
    point = ROAD_SAMPLES[point_index]
    previous = ROAD_SAMPLES[max(0, point_index - 1)]
    following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, point_index + 1)]
    tx, ty = following[0] - previous[0], following[1] - previous[1]
    length = max(0.001, math.hypot(tx, ty))
    side = -1.0 if index % 2 else 1.0
    offset = random.uniform(14.0, 25.0)
    x = point[0] + ty / length * offset * side
    y = point[1] - tx / length * offset * side
    ground = terrain_height(x, y)
    scale = random.uniform(1.4, 4.0)
    linked_instance(
        rock_templates[index % len(rock_templates)],
        f"Trackside rock {index:02d}",
        (x, y, ground + scale * 0.32),
        (scale * random.uniform(0.8, 1.3), scale, scale * random.uniform(0.7, 1.45)),
        random.uniform(0.0, math.tau),
        environment_collection,
    )

for index, point_index in enumerate(range(50, 111, 4)):
    point = ROAD_SAMPLES[point_index]
    previous = ROAD_SAMPLES[point_index - 1]
    following = ROAD_SAMPLES[point_index + 1]
    tx, ty = following[0] - previous[0], following[1] - previous[1]
    length = max(0.001, math.hypot(tx, ty))
    x = point[0] - ty / length * random.uniform(20.0, 25.0)
    y = point[1] + tx / length * random.uniform(20.0, 25.0)
    ground = terrain_height(x, y)
    linked_instance(
        rock_templates[(index + 3) % len(rock_templates)],
        f"Spectator terrace rock {index:02d}",
        (x, y, ground + 2.8),
        (
            random.uniform(6.0, 10.0),
            random.uniform(5.0, 8.0),
            random.uniform(7.0, 12.0),
        ),
        random.uniform(-0.35, 0.35),
        environment_collection,
    )

tree_count = 0
for _ in range(760):
    x = random.uniform(-168.0, 308.0)
    y = random.uniform(-96.0, 332.0)
    road_distance, _ = nearest_road(x, y)
    creek_distance = abs(x - (38.0 + max(0.0, y - 150.0) * 0.09))
    if road_distance < random.uniform(17.0, 24.0) or creek_distance < 8.0:
        continue
    z = terrain_height(x, y)
    distance_factor = 0.75 + max(0.0, y) / 500.0
    scale = random.uniform(0.72, 1.45) * distance_factor
    linked_instance(
        random.choice(tree_templates),
        f"Instanced pine {tree_count:03d}",
        (x, y, z),
        (scale, scale, scale * random.uniform(0.92, 1.18)),
        random.uniform(0.0, math.tau),
        environment_collection,
    )
    tree_count += 1

for index in range(110):
    y = random.uniform(22.0, 215.0)
    center_point = min(ROAD_SAMPLES, key=lambda point: abs(point[1] - y))
    tangent_index = ROAD_SAMPLES.index(center_point)
    previous = ROAD_SAMPLES[max(0, tangent_index - 1)]
    following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, tangent_index + 1)]
    tx, ty = following[0] - previous[0], following[1] - previous[1]
    length = max(0.001, math.hypot(tx, ty))
    side = -1.0 if index % 2 == 0 else 1.0
    offset = random.uniform(11.0, 16.0)
    x = center_point[0] + ty / length * offset * side + random.uniform(-2.0, 2.0)
    py = center_point[1] - tx / length * offset * side + random.uniform(-2.0, 2.0)
    z = terrain_height(x, py) + 0.22
    create_uv_sphere(
        f"Flower cluster {index:03d}",
        (x, py, z),
        (random.uniform(0.09, 0.18), random.uniform(0.09, 0.18), random.uniform(0.14, 0.28)),
        flower_gold_material if index % 3 else flower_blue_material,
        environment_collection,
        segments=8,
        rings=5,
    )

for index, (x, y, fabric) in enumerate(
    (
        (-37.0, 108.0, banner_blue_material),
        (-21.0, 115.0, banner_gold_material),
        (61.0, 112.0, banner_blue_material),
    )
):
    create_tent(
        f"Race tent {index + 1}",
        (x, y, terrain_height(x, y)),
        fabric,
        dark_material,
        race_collection,
    )

create_pennant_line(
    "Lodge festival pennants",
    (27.0, 106.0, terrain_height(27.0, 106.0) + 11.0),
    (64.0, 113.0, terrain_height(64.0, 113.0) + 12.0),
    (banner_blue_material, banner_gold_material, orange_material, green_material),
    race_collection,
)

person_templates = [
    create_person_template("Spectator blue", banner_blue_material, skin_material, source_collection),
    create_person_template("Spectator gold", banner_gold_material, skin_material, source_collection),
    create_person_template("Spectator orange", orange_material, skin_material, source_collection),
    create_person_template("Spectator green", green_material, skin_material, source_collection),
]
for index in range(82):
    if index < 48:
        x = 38.0 + (index % 8) * 2.0
        y = 105.0 + (index // 8) * 1.9
    else:
        x = -46.0 + (index % 7) * 2.0
        y = 104.0 + ((index - 48) // 7) * 2.0
    z = terrain_height(x, y)
    linked_instance(
        person_templates[index % len(person_templates)],
        f"Spectator {index:03d}",
        (x, y, z),
        (0.78, 0.78, 0.78),
        random.uniform(-0.4, 0.4),
        race_collection,
    )

for index in range(36):
    point = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, 34 + index * 2)]
    previous = ROAD_SAMPLES[max(0, 34 + index * 2 - 1)]
    following = ROAD_SAMPLES[min(len(ROAD_SAMPLES) - 1, 34 + index * 2 + 1)]
    tx, ty = following[0] - previous[0], following[1] - previous[1]
    length = max(0.001, math.hypot(tx, ty))
    side = -1.0
    x = point[0] + ty / length * 9.0 * side
    y = point[1] - tx / length * 9.0 * side
    create_cylinder(
        f"Safety tire {index:02d}",
        (x, y, point[2] + 0.62),
        0.62,
        0.45,
        (curb_red_material, curb_white_material, tire_material)[index % 3],
        race_collection,
        vertices=16,
        rotation=(0.0, math.pi * 0.5, math.atan2(ty, tx)),
    )

for index, point_index in enumerate((38, 58, 79, 103, 126)):
    point = ROAD_SAMPLES[point_index]
    previous = ROAD_SAMPLES[point_index - 1]
    following = ROAD_SAMPLES[point_index + 1]
    yaw = math.atan2(following[1] - previous[1], following[0] - previous[0])
    outward = Vector((math.sin(yaw), -math.cos(yaw), 0.0))
    sign_location = Vector(point) + outward * 11.5
    create_box(
        f"Chevron board {index}",
        (sign_location.x, sign_location.y, sign_location.z + 2.2),
        (5.8, 0.5, 3.2),
        gold_material,
        race_collection,
        rotation=(0.0, 0.0, yaw),
        bevel=0.18,
    )
    tangent = Vector((math.cos(yaw), math.sin(yaw), 0.0))
    road_facing = -outward
    for arrow_index, along in enumerate((-1.45, 0.0, 1.45)):
        center = sign_location + tangent * along + road_facing * 0.34 + Vector((0.0, 0.0, 2.2))
        tip = center + tangent * 0.48
        upper = center - tangent * 0.46 + Vector((0.0, 0.0, 0.68))
        lower = center - tangent * 0.46 - Vector((0.0, 0.0, 0.68))
        create_beam_between(
            f"Chevron dark upper {index}-{arrow_index}",
            upper,
            tip,
            0.28,
            dark_material,
            race_collection,
        )
        create_beam_between(
            f"Chevron dark lower {index}-{arrow_index}",
            lower,
            tip,
            0.28,
            dark_material,
            race_collection,
        )

hero_point = ROAD_SAMPLES[25]
hero_next = ROAD_SAMPLES[26]
hero_yaw = math.atan2(hero_next[1] - hero_point[1], hero_next[0] - hero_point[0]) - math.pi * 0.5
create_kart(
    "Hero blue gold kart",
    (hero_point[0], hero_point[1], hero_point[2] + 0.18),
    hero_yaw,
    blue_material,
    gold_material,
    vehicle_collection,
    scale=1.24,
)
for name, point_index, lateral, body_material in (
    ("Green rival", 48, 1.6, green_material),
    ("Orange rival", 63, -2.2, orange_material),
    ("Purple rival", 78, 0.8, purple_material),
):
    point = ROAD_SAMPLES[point_index]
    next_point = ROAD_SAMPLES[point_index + 1]
    dx, dy = next_point[0] - point[0], next_point[1] - point[1]
    length = max(0.001, math.hypot(dx, dy))
    create_kart(
        name,
        (
            point[0] + dy / length * lateral,
            point[1] - dx / length * lateral,
            point[2] + 0.18,
        ),
        math.atan2(dy, dx) - math.pi * 0.5,
        body_material,
        gold_material,
        vehicle_collection,
        scale=0.88,
    )

camera_data = bpy.data.cameras.new("Golden chase camera")
camera = bpy.data.objects.new("Golden chase camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (1.15, -10.8, 4.8)
camera_data.lens = 40.0
camera_data.sensor_width = 36.0
camera_data.clip_start = 0.08
camera_data.clip_end = 900.0
look_at(camera, (1.0, 60.0, 5.8))
scene.camera = camera

sun_data = bpy.data.lights.new("Warm alpine sun", "SUN")
sun_data.energy = 4.6
sun_data.angle = math.radians(2.0)
sun = bpy.data.objects.new("Warm alpine sun", sun_data)
sun.rotation_euler = (math.radians(38.0), math.radians(-22.0), math.radians(-132.0))
scene.collection.objects.link(sun)

fill_sun_data = bpy.data.lights.new("Blue mountain bounce", "SUN")
fill_sun_data.energy = 1.15
fill_sun_data.angle = math.radians(7.0)
fill_sun_data.color = (0.42, 0.62, 1.0)
fill_sun = bpy.data.objects.new("Blue mountain bounce", fill_sun_data)
fill_sun.rotation_euler = (math.radians(58.0), math.radians(12.0), math.radians(38.0))
scene.collection.objects.link(fill_sun)

area_data = bpy.data.lights.new("Cool sky fill", "AREA")
area_data.energy = 2200.0
area_data.color = (0.34, 0.56, 1.0)
area_data.shape = "DISK"
area_data.size = 45.0
area = bpy.data.objects.new("Cool sky fill", area_data)
area.location = (-18.0, 32.0, 46.0)
look_at(area, (0.0, 80.0, 0.0))
scene.collection.objects.link(area)

try:
    scene.use_nodes = True
    compositor_nodes = scene.node_tree.nodes
    compositor_links = scene.node_tree.links
    for node in list(compositor_nodes):
        compositor_nodes.remove(node)
    render_layers = compositor_nodes.new("CompositorNodeRLayers")
    glare = compositor_nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.15
    glare.size = 6
    glare.mix = -0.86
    composite = compositor_nodes.new("CompositorNodeComposite")
    compositor_links.new(render_layers.outputs["Image"], glare.inputs["Image"])
    compositor_links.new(glare.outputs["Image"], composite.inputs["Image"])
except (AttributeError, TypeError):
    pass

BLEND_PATH.parent.mkdir(parents=True, exist_ok=True)
RENDER_PATH.parent.mkdir(parents=True, exist_ok=True)
GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
gltf_material_state = begin_gltf_material_fallbacks(
    (
        (grass_material, (0.07, 0.24, 0.035, 1.0)),
        (asphalt_material, (0.052, 0.061, 0.072, 1.0)),
        (shoulder_material, (0.22, 0.14, 0.06, 1.0)),
        (rock_material, (0.13, 0.145, 0.16, 1.0)),
        (stone_material, (0.28, 0.25, 0.20, 1.0)),
        (waterfall_surface, (0.025, 0.42, 0.68, 1.0)),
    )
)
try:
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        check_existing=False,
        export_format="GLB",
        export_cameras=True,
        export_lights=False,
        use_visible=True,
        use_renderable=True,
        export_apply=True,
        export_animations=False,
        export_yup=True,
    )
finally:
    restore_gltf_material_fallbacks(gltf_material_state)
bpy.ops.render.render(write_still=True)

visible_meshes = [
    obj
    for obj in scene.objects
    if obj.type == "MESH" and not obj.hide_render
]
report = {
    "schema": "blockkart.blenderGoldenScene.v9",
    "seed": SEED,
    "blender": bpy.app.version_string,
    "renderer": scene.render.engine,
    "resolution": [scene.render.resolution_x, scene.render.resolution_y],
    "visibleMeshObjects": len(visible_meshes),
    "linkedPines": tree_count,
    "linkedShrubs": shrub_count,
    "vertices": sum(len(obj.data.vertices) for obj in visible_meshes),
    "polygons": sum(len(obj.data.polygons) for obj in visible_meshes),
    "blend": str(BLEND_PATH.relative_to(ROOT)),
    "glb": str(GLB_PATH.relative_to(ROOT)),
    "render": str(RENDER_PATH.relative_to(ROOT)),
}
REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
