# BlockKart Voplay GLB bake

This tool converts the authored Blender GLB into the runtime artifacts consumed
by BlockKart:

```sh
cargo run --quiet -- \
  ../../art/exports/blockkart_alpine_golden_scene_v10.glb \
  ../../generated/golden_scene \
  ../../golden_scene_generated.vo
```

It imports through `voplay-import-gltf`, flattens the static node hierarchy,
removes the authored vehicle placeholders, preserves material batches, applies
normal transforms, and writes VMG1 meshes plus generated Vo descriptors.

Every material batch is split on triangle boundaries into artifacts no larger
than 900 KiB. This keeps the enclosing Voplay render asset packet below the
1 MiB target-island output limit. Sky, sun, water, and foam materials receive
appropriate shadow policies in the generated descriptors.
