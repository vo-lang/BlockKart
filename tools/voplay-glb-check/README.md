# Voplay GLB check

This tiny executable runs the same `voplay-import-gltf` boundary used by the
engine, then materializes every mesh primitive. It catches unsupported glTF
extensions, malformed buffers, invalid accessors and primitive failures before
an art export is packaged into BlockKart.

From this directory:

```sh
cargo run --quiet -- ../../art/exports/blockkart_alpine_golden_scene_v13.glb
```

The command exits non-zero when Voplay rejects either the document or its mesh
payload.
