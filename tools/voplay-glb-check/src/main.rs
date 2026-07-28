use std::{collections::BTreeMap, env, fs, path::PathBuf, process::ExitCode};

use voplay_import_gltf::{GltfImportConfig, import, materialize_meshes};

fn run() -> Result<(), String> {
    let source = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| "usage: blockkart-voplay-glb-check <scene.glb>".to_owned())?;
    let bytes = fs::read(&source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    let plan = import(&bytes, GltfImportConfig::default())
        .map_err(|error| format!("Voplay rejected {}: {error:?}", source.display()))?;
    let meshes = materialize_meshes(&plan, &BTreeMap::new())
        .map_err(|error| format!("Voplay could not materialize meshes: {error:?}"))?;
    let vertices = meshes.iter().map(|mesh| mesh.positions.len()).sum::<usize>();
    let triangles = meshes
        .iter()
        .map(|mesh| mesh.indices.len() / 3)
        .sum::<usize>();
    println!(
        "accepted by Voplay: scenes={} nodes={} meshes={} primitives={} materials={} cameras_in_source=preserved_by_glTF bytes={} materialized_vertices={} materialized_triangles={}",
        plan.summary.scenes,
        plan.summary.nodes,
        plan.summary.meshes,
        plan.summary.primitives,
        plan.summary.materials,
        bytes.len(),
        vertices,
        triangles,
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
