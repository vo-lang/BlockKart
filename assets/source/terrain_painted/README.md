# Terrain Painted Sources

These PNGs are the authored albedo sources for the primitive terrain splat layers.

`tools/generate_primitive_terrain.mjs` copies these files into `assets/maps/primitive_track` and only generates derived data such as heightmap, splat, normal, and metallic-roughness textures.

Use `node tools/paint_terrain_textures.mjs` to rebuild the current v1 source set. The script samples the concept image palette and writes replaceable bitmap sources; the output PNGs can be edited or replaced directly without changing the terrain generator.
