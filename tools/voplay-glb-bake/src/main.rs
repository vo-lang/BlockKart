use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsStr,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use voplay_import_gltf::{
    GltfAlphaMode, GltfImportConfig, GltfImportPlan, GltfMeshArtifact, import,
    materialize_meshes,
};
use voplay_render_3d::{
    MeshArtifact3d, MeshArtifact3dConfig, MeshDescriptor, encode_mesh_artifact_3d,
};

const MATERIAL_ID_BASE: u64 = 20_000;
const MESH_ID_BASE: u64 = 30_000;
const MAX_MESH_ARTIFACT_BYTES: usize = 900 * 1024;

#[derive(Default)]
struct CombinedMesh {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    texcoords: Vec<[f32; 2]>,
    indices: Vec<u32>,
}

struct BakedMesh {
    id: u64,
    material: usize,
    file_name: String,
    casts_shadow: bool,
    receives_shadow: bool,
}

#[derive(Clone, Copy)]
struct Bounds {
    min: [f32; 3],
    max: [f32; 3],
}

impl Default for Bounds {
    fn default() -> Self {
        Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        }
    }
}

impl Bounds {
    fn include(&mut self, point: [f32; 3]) {
        for axis in 0..3 {
            self.min[axis] = self.min[axis].min(point[axis]);
            self.max[axis] = self.max[axis].max(point[axis]);
        }
    }

    fn milli(self) -> [i64; 6] {
        [
            (self.min[0] * 1_000.0).floor() as i64,
            (self.min[1] * 1_000.0).floor() as i64,
            (self.min[2] * 1_000.0).floor() as i64,
            (self.max[0] * 1_000.0).ceil() as i64,
            (self.max[1] * 1_000.0).ceil() as i64,
            (self.max[2] * 1_000.0).ceil() as i64,
        ]
    }
}

fn multiply(left: [i64; 16], right: [i64; 16]) -> Result<[i64; 16], String> {
    let mut result = [0_i64; 16];
    for row in 0..4 {
        for column in 0..4 {
            let value = (0..4).fold(0_i128, |sum, index| {
                sum.saturating_add(
                    i128::from(left[row * 4 + index])
                        .saturating_mul(i128::from(right[index * 4 + column])),
                )
            }) / 1_000;
            result[row * 4 + column] =
                i64::try_from(value).map_err(|_| "matrix overflow".to_owned())?;
        }
    }
    Ok(result)
}

fn identity() -> [i64; 16] {
    [
        1_000, 0, 0, 0, 0, 1_000, 0, 0, 0, 0, 1_000, 0, 0, 0, 0, 1_000,
    ]
}

fn transform_point(matrix: [i64; 16], point: [f32; 3]) -> [f32; 3] {
    let matrix = matrix.map(|value| value as f32 / 1_000.0);
    [
        matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3],
        matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7],
        matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11],
    ]
}

fn transform_normal(matrix: [i64; 16], normal: [f32; 3]) -> [f32; 3] {
    let a = matrix[0] as f64 / 1_000.0;
    let b = matrix[1] as f64 / 1_000.0;
    let c = matrix[2] as f64 / 1_000.0;
    let d = matrix[4] as f64 / 1_000.0;
    let e = matrix[5] as f64 / 1_000.0;
    let f = matrix[6] as f64 / 1_000.0;
    let g = matrix[8] as f64 / 1_000.0;
    let h = matrix[9] as f64 / 1_000.0;
    let i = matrix[10] as f64 / 1_000.0;
    let determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if determinant.abs() < 1.0e-12 {
        return normal;
    }
    let inverse = [
        (e * i - f * h) / determinant,
        (c * h - b * i) / determinant,
        (b * f - c * e) / determinant,
        (f * g - d * i) / determinant,
        (a * i - c * g) / determinant,
        (c * d - a * f) / determinant,
        (d * h - e * g) / determinant,
        (b * g - a * h) / determinant,
        (a * e - b * d) / determinant,
    ];
    let x = inverse[0] * normal[0] as f64
        + inverse[3] * normal[1] as f64
        + inverse[6] * normal[2] as f64;
    let y = inverse[1] * normal[0] as f64
        + inverse[4] * normal[1] as f64
        + inverse[7] * normal[2] as f64;
    let z = inverse[2] * normal[0] as f64
        + inverse[5] * normal[1] as f64
        + inverse[8] * normal[2] as f64;
    let length = (x * x + y * y + z * z).sqrt().max(1.0e-12);
    [(x / length) as f32, (y / length) as f32, (z / length) as f32]
}

fn vehicle_node(name: Option<&str>) -> bool {
    let name = name.unwrap_or_default().to_ascii_lowercase();
    name.contains("hero blue gold kart")
        || name.contains("green rival")
        || name.contains("orange rival")
        || name.contains("purple rival")
}

fn collect_node(
    plan: &GltfImportPlan,
    artifacts: &BTreeMap<(usize, usize), &GltfMeshArtifact>,
    node_index: usize,
    parent: [i64; 16],
    inherited_skip: bool,
    groups: &mut BTreeMap<usize, CombinedMesh>,
    used_materials: &mut BTreeSet<usize>,
    bounds: &mut Bounds,
) -> Result<(), String> {
    let node = plan
        .nodes
        .get(node_index)
        .ok_or_else(|| format!("missing node {node_index}"))?;
    let skip = inherited_skip || vehicle_node(node.name.as_deref());
    let world = multiply(parent, node.local_matrix_milli)?;
    if !skip {
        if let Some(mesh_index) = node.mesh {
            for primitive in &plan.primitives {
                if primitive.mesh != mesh_index {
                    continue;
                }
                let artifact = artifacts
                    .get(&(primitive.mesh, primitive.primitive))
                    .ok_or_else(|| "missing materialized primitive".to_owned())?;
                let material = artifact.material.unwrap_or(0);
                used_materials.insert(material);
                let target = groups.entry(material).or_default();
                let vertex_base = u32::try_from(target.positions.len())
                    .map_err(|_| "vertex offset overflow".to_owned())?;
                for index in 0..artifact.positions.len() {
                    let position = transform_point(world, artifact.positions[index]);
                    let normal = transform_normal(world, artifact.normals[index]);
                    target.positions.push(position);
                    target.normals.push(normal);
                    target.texcoords.push(artifact.texcoords[index]);
                    bounds.include(position);
                }
                target.indices.extend(
                    artifact
                        .indices
                        .iter()
                        .map(|index| index.saturating_add(vertex_base)),
                );
            }
        }
    }
    for child in &node.children {
        collect_node(
            plan,
            artifacts,
            *child,
            world,
            skip,
            groups,
            used_materials,
            bounds,
        )?;
    }
    Ok(())
}

fn alpha_expression(alpha: GltfAlphaMode) -> (&'static str, u16) {
    match alpha {
        GltfAlphaMode::Opaque => ("render3d.AlphaOpaque", 0),
        GltfAlphaMode::Mask { cutoff_q16 } => ("render3d.AlphaMask", cutoff_q16),
        GltfAlphaMode::Blend => ("render3d.AlphaBlend", 0),
    }
}

fn shadow_policy(plan: &GltfImportPlan, material: usize) -> Result<(bool, bool), String> {
    let material = plan
        .materials
        .get(material)
        .ok_or_else(|| format!("missing material {material}"))?;
    let name = material.name.as_deref().unwrap_or_default().to_ascii_lowercase();
    if name.contains("sky") || name.contains("sun disc") {
        return Ok((false, false));
    }
    if name.contains("water") || name.contains("foam") || material.alpha == GltfAlphaMode::Blend {
        return Ok((false, true));
    }
    Ok((true, true))
}

fn estimated_mesh_artifact_bytes(vertices: usize, indices: usize) -> usize {
    128_usize
        .saturating_add(vertices.saturating_mul(32))
        .saturating_add(indices.saturating_mul(4))
}

fn split_mesh_for_provider(mesh: &CombinedMesh) -> Result<Vec<CombinedMesh>, String> {
    if mesh.indices.len() % 3 != 0 {
        return Err("material batch indices are not triangles".to_owned());
    }
    let mut chunks = Vec::new();
    let mut chunk = CombinedMesh::default();
    let mut remap = BTreeMap::<u32, u32>::new();
    for triangle in mesh.indices.chunks_exact(3) {
        let additional_vertices = triangle
            .iter()
            .filter(|index| !remap.contains_key(index))
            .count();
        let next_bytes = estimated_mesh_artifact_bytes(
            chunk.positions.len().saturating_add(additional_vertices),
            chunk.indices.len().saturating_add(3),
        );
        if !chunk.indices.is_empty() && next_bytes > MAX_MESH_ARTIFACT_BYTES {
            chunks.push(std::mem::take(&mut chunk));
            remap.clear();
        }
        for source_index in triangle {
            let target_index = if let Some(index) = remap.get(source_index) {
                *index
            } else {
                let source_vertex = usize::try_from(*source_index)
                    .map_err(|_| "source vertex index overflow".to_owned())?;
                let position = *mesh
                    .positions
                    .get(source_vertex)
                    .ok_or_else(|| "source position is absent".to_owned())?;
                let normal = *mesh
                    .normals
                    .get(source_vertex)
                    .ok_or_else(|| "source normal is absent".to_owned())?;
                let texcoord = *mesh
                    .texcoords
                    .get(source_vertex)
                    .ok_or_else(|| "source texcoord is absent".to_owned())?;
                let target_index = u32::try_from(chunk.positions.len())
                    .map_err(|_| "chunk vertex index overflow".to_owned())?;
                chunk.positions.push(position);
                chunk.normals.push(normal);
                chunk.texcoords.push(texcoord);
                remap.insert(*source_index, target_index);
                target_index
            };
            chunk.indices.push(target_index);
        }
    }
    if !chunk.indices.is_empty() {
        chunks.push(chunk);
    }
    if chunks.is_empty() {
        return Err("material batch produced no mesh chunks".to_owned());
    }
    Ok(chunks)
}

fn generate_vo(
    plan: &GltfImportPlan,
    used_materials: &BTreeSet<usize>,
    baked_meshes: &[BakedMesh],
    bounds: Bounds,
) -> Result<String, String> {
    let mut source = String::from(
        "// Code generated by tools/voplay-glb-bake. DO NOT EDIT.\n\
         package main\n\n\
         import \"github.com/vo-lang/voplay/vo/render3d\"\n\n\
         type blockKartGoldenSceneMesh struct {\n\
         \tId uint64\n\
         \tMaterial uint64\n\
         \tPath string\n\
         \tCastsShadow bool\n\
         \tReceivesShadow bool\n\
         }\n\n",
    );
    source.push_str("func blockKartGoldenSceneMaterials() []render3d.Material {\n\treturn []render3d.Material{\n");
    for material_index in used_materials {
        let material = plan
            .materials
            .get(*material_index)
            .ok_or_else(|| format!("missing material {material_index}"))?;
        let id = MATERIAL_ID_BASE + *material_index as u64;
        let base = material.base_color.map(|value| u16::from(value) * 257);
        let (alpha, cutoff) = alpha_expression(material.alpha);
        writeln!(
            source,
            "\t\t{{Id: {id}, BaseColor: [4]uint16{{{}, {}, {}, {}}}, Metallic: {}, Roughness: {}, Emissive: [3]uint16{{{}, {}, {}}}, Alpha: {alpha}, AlphaCutoff: {cutoff}, DoubleSided: {}, Unlit: {}, Revision: 1}},",
            base[0],
            base[1],
            base[2],
            base[3],
            material.metallic_q16,
            material.roughness_q16,
            material.emissive_q16[0],
            material.emissive_q16[1],
            material.emissive_q16[2],
            material.double_sided,
            material.unlit,
        )
        .map_err(|_| "write generated material".to_owned())?;
    }
    source.push_str("\t}\n}\n\nfunc blockKartGoldenSceneMeshes() []blockKartGoldenSceneMesh {\n\treturn []blockKartGoldenSceneMesh{\n");
    for mesh in baked_meshes {
        let material_id = MATERIAL_ID_BASE + mesh.material as u64;
        let mesh_id = mesh.id;
        writeln!(
            source,
            "\t\t{{Id: {mesh_id}, Material: {material_id}, Path: \"generated/golden_scene/{}\", CastsShadow: {}, ReceivesShadow: {}}},",
            mesh.file_name,
            mesh.casts_shadow,
            mesh.receives_shadow,
        )
        .map_err(|_| "write generated mesh".to_owned())?;
    }
    let bounds = bounds.milli();
    write!(
        source,
        "\t}}\n}}\n\nfunc blockKartGoldenSceneBounds() [6]int64 {{\n\
         \treturn [6]int64{{{}, {}, {}, {}, {}, {}}}\n\
         }}\n",
        bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5],
    )
    .map_err(|_| "write generated bounds".to_owned())?;
    Ok(source)
}

fn bake(source: &Path, output: &Path, vo_output: &Path) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|error| format!("read {}: {error}", source.display()))?;
    let plan = import(&bytes, GltfImportConfig::default())
        .map_err(|error| format!("Voplay import: {error:?}"))?;
    if !plan.images.is_empty() || !plan.textures.is_empty() {
        return Err("texture baking is required before textured GLB flattening".to_owned());
    }
    let materialized = materialize_meshes(&plan, &BTreeMap::new())
        .map_err(|error| format!("materialize meshes: {error:?}"))?;
    let artifacts = materialized
        .iter()
        .map(|artifact| ((artifact.mesh, artifact.primitive), artifact))
        .collect::<BTreeMap<_, _>>();
    let roots = plan
        .default_scene
        .and_then(|scene| plan.scenes.get(scene))
        .or_else(|| plan.scenes.first())
        .map(|scene| scene.roots.clone())
        .ok_or_else(|| "GLB has no scene roots".to_owned())?;
    let mut groups = BTreeMap::new();
    let mut used_materials = BTreeSet::new();
    let mut bounds = Bounds::default();
    for root in roots {
        collect_node(
            &plan,
            &artifacts,
            root,
            identity(),
            false,
            &mut groups,
            &mut used_materials,
            &mut bounds,
        )?;
    }
    fs::create_dir_all(output).map_err(|error| format!("create {}: {error}", output.display()))?;
    for entry in fs::read_dir(output).map_err(|error| format!("read {}: {error}", output.display()))? {
        let entry = entry.map_err(|error| format!("read generated mesh entry: {error}"))?;
        let path = entry.path();
        if path.extension() == Some(OsStr::new("vmg1")) {
            fs::remove_file(&path)
                .map_err(|error| format!("remove stale {}: {error}", path.display()))?;
        }
    }
    let mut baked_meshes = Vec::new();
    for (material, mesh) in &groups {
        let (casts_shadow, receives_shadow) = shadow_policy(&plan, *material)?;
        for (chunk_index, chunk) in split_mesh_for_provider(mesh)?.into_iter().enumerate() {
            let id = MESH_ID_BASE + baked_meshes.len() as u64;
            let artifact = MeshArtifact3d {
                descriptor: MeshDescriptor {
                    id,
                    vertex_count: chunk.positions.len() as u32,
                    index_count: chunk.indices.len() as u32,
                    skinned: false,
                },
                positions: chunk.positions,
                normals: chunk.normals,
                texcoords: chunk.texcoords,
                joints: None,
                weights: None,
                indices: chunk.indices,
            };
            let encoded = encode_mesh_artifact_3d(&artifact, MeshArtifact3dConfig::default())
                .map_err(|error| {
                    format!("encode material {material} chunk {chunk_index}: {error:?}")
                })?;
            if encoded.len() > MAX_MESH_ARTIFACT_BYTES {
                return Err(format!(
                    "material {material} chunk {chunk_index} is {} bytes, above provider budget",
                    encoded.len(),
                ));
            }
            let file_name = format!("material_{material:03}_chunk_{chunk_index:03}.vmg1");
            fs::write(output.join(&file_name), encoded).map_err(|error| {
                format!("write material {material} chunk {chunk_index}: {error}")
            })?;
            baked_meshes.push(BakedMesh {
                id,
                material: *material,
                file_name,
                casts_shadow,
                receives_shadow,
            });
        }
    }
    let vo = generate_vo(&plan, &used_materials, &baked_meshes, bounds)?;
    fs::write(vo_output, vo).map_err(|error| format!("write {}: {error}", vo_output.display()))?;
    println!(
        "baked for Voplay: source_nodes={} source_primitives={} static_material_batches={} provider_mesh_chunks={} bounds_milli={:?}",
        plan.summary.nodes,
        plan.summary.primitives,
        groups.len(),
        baked_meshes.len(),
        bounds.milli(),
    );
    Ok(())
}

fn main() {
    let arguments = env::args_os().skip(1).map(PathBuf::from).collect::<Vec<_>>();
    if arguments.len() != 3 {
        eprintln!(
            "usage: blockkart-voplay-glb-bake <source.glb> <output-directory> <generated.vo>"
        );
        std::process::exit(2);
    }
    if let Err(error) = bake(&arguments[0], &arguments[1], &arguments[2]) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
