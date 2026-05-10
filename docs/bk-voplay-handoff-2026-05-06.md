# BlockKart / voplay Handoff - 2026-05-06

This note summarizes the current BlockKart (BK) + voplay state for the next programmer.

## Goal

BK is being pushed toward the provided concept image: a low-poly kart scene with readable road shape, painted dirt shoulders, dense impressionistic roadside meadow, strong trees, flowers, rocks, fences, and a clean performance profile.

The engineering direction is:

1. Put clean reusable capabilities in voplay.
2. Keep BK as level/game content using those capabilities.
3. Runtime should load prepared assets. It should not generate terrain meshes at runtime.
4. Tooling may generate GLB/bin/texture/map/pack assets offline.

## Current Runtime Shape

BK uses `assets/blockkart.vpak` at runtime.

The main map manifest is:

- `assets/maps/primitive_track/blockkart.map.json`

The generator for this manifest and its generated terrain/road/primitive assets is:

- `tools/generate_primitive_terrain.mjs`

The packer is:

- `tools/pack_primitive_assets.vo`

Runtime flow in BK:

- `primitive_world.vo` calls `PrepareMapWithAssets(...)`.
- Track terrain is spawned through `scene3d.SpawnPreparedMapTrackMeshTerrain(...)`.
- Road, curb, grime, line, dash, and creek meshes are spawned through `scene3d.SpawnPreparedMapMesh(...)`.
- Roadside meadow primitives are spawned through `scene3d.SpawnPreparedMapPrimitiveLayersWithAssets(...)`.

## Code Tour

BK entry and game loop:

- `main.vo`: starts `voplay.Run(...)` with `NewPlayState()`.
- `play_state.vo`: owns the state lifecycle. It creates `World`, forwards fixed update, update, draw, and debug toggles.
- `world.vo`: owns the 3D scene, player vehicle, camera, loaded asset pack, track result, HUD stats, update loop, draw loop, and cleanup.
- `blocks.vo`: calls `buildPrimitiveLevel()`. This is the current BK level path.
- `gameplay.vo`: collectibles, checkpoints, boost pads, moving obstacles, race progress, respawn/restart.
- `theme.vo`: lighting/theme colors and HUD drawing.
- `touch_controls.vo`: mobile/touch driving UI.

BK primitive level and visuals:

- `primitive_world.vo`: the main file for the current track/world content.
- `newBlockKartPrimitiveScene(...)`: creates primitive shape/material registries and static/dynamic primitive layers.
- `buildPrimitiveLevel()`: prepares the map, creates the `Track`, spawns terrain, road visuals, physics, scenery, gameplay, and builds primitive layers.
- `preparePrimitiveMapAsset()`: loads `assets/maps/primitive_track/blockkart.map.json` through `scene3d.PrepareMapWithAssets`.
- `spawnPrimitiveTrackTerrain(...)`: uses `scene3d.SpawnPreparedMapTrackMeshTerrain(...)` for `lowpoly_terrain`.
- `addContinuousPrimitiveRoadVisuals(...)`: uses `scene3d.SpawnPreparedMapMesh(...)` for road meshes from the map.
- `addPrimitiveRoadsideMicroDetails(...)`: loads `roadside_meadow` through `SpawnPreparedMapPrimitiveLayersWithAssets`.
- `addPrimitiveTerrainGroves`, `addPrimitiveHeroRoadsideClusters`, `addPrimitiveTreeAtWorld`, etc.: hand-authored primitive scenery on top of generated map assets.
- `spawnPrimitiveTrackPhysics(...)`: builds physics boxes for the road. Visual road mesh is not the physics source.
- `spawnPrimitiveKartVisuals(...)`: builds the kart from primitive parts instead of GLB meshes.

BK generated asset pipeline:

- `tools/terrain_heightfield_spec.mjs`: source functions for terrain height, track points, terrain context, splat weights.
- `tools/generate_primitive_terrain.mjs`: generates heightmap, splat map, terrain textures, terrain GLBs, road GLBs, `roadside_primitives.bin`, and `blockkart.map.json`.
- `tools/paint_terrain_textures.mjs`: paints/source-bakes terrain/effect textures used by the generator. Run this if the generator complains about missing painted source or grass card atlas.
- `tools/pack_primitive_assets.vo`: packs map dependencies and runtime extras into `assets/blockkart.vpak`.

voplay scene/map code:

- `voplay/scene3d/map.vo`: map JSON schema, validation, dependency collection, prepared asset loading, prepared map spawn APIs.
- `voplay/scene3d/mesh_terrain.vo`: GLB mesh terrain + height-grid probe support, including track terrain integration and terrain LOD models.
- `voplay/scene3d/terrain.vo`: heightmap terrain path, height source metadata, terrain cull radius derivation.
- `voplay/scene3d/draw.vo`: retained Entity rendering, Entity LOD choice, Entity distance/frustum culling, render stats.
- `voplay/scene3d/primitive_layers.vo`: primitive layer flushing, static chunk cache, chunk visibility toggling, primitive culling/stats.
- `voplay/scene3d/culling.vo`: shared AABB distance/radius helpers.
- `voplay/tests/main.vo`: contracts for prepared map, terrain, primitive layers, culling, and LOD.

## voplay Map / Level Work

Key files:

- `voplay/scene3d/map.vo`
- `voplay/scene3d/mesh_terrain.vo`
- `voplay/scene3d/terrain.vo`
- `voplay/scene3d/draw.vo`
- `voplay/scene3d/primitive_layers.vo`
- `voplay/scene3d/culling.vo`

Map support now includes:

- `MapMesh.material`
- `MapMesh.pickMode`
- `MapMesh.lodLevels`
- `MapMesh.cullDistance`
- `MapMesh.cullRadius`
- `MapMesh.frustumCull`
- `MapMeshTerrain.material`
- `MapMeshTerrain.pickMode`
- `MapMeshTerrain.lodLevels`
- `MapMeshTerrain.cullDistance`
- `MapMeshTerrain.cullRadius`
- `MapMeshTerrain.frustumCull`

Prepared map APIs:

- `PrepareMapWithAssets`
- `SpawnPreparedMapWithAssets`
- `SpawnPreparedMapMesh`
- `SpawnPreparedMapMeshTerrain`
- `SpawnPreparedMapTrackMeshTerrain`
- `SpawnPreparedMapPrimitiveLayersWithAssets`

Important behavior:

- `LoadMapWithAssets` now prepares first, then spawns prepared data.
- Prepared spawn consumes already loaded heightmap/model/texture/primitive bytes where applicable.
- Mesh terrain LOD models are loaded during prepare and passed to Entity LOD.
- Public prepared APIs validate missing prepared LODs with explicit errors instead of panicking.

## Terrain Assets

BK terrain is a tool-generated low-poly GLB plus a height-grid binary for gameplay height sampling.

Current generated terrain assets:

- `lowpoly_terrain.glb`: main terrain, about 21632 triangles.
- `lowpoly_terrain_lod.glb`: LOD terrain, about 5408 triangles.
- `lowpoly_terrain_height_grid.bin`: height probe grid, currently 257x257.
- `terrain_splat_large.png`: splat control.
- `grass_texture.png`, `meadow_texture.png`, `dirt_texture.png`, `rock_texture.png`, plus normals and MR maps.

The map declares:

- `meshTerrains[lowpoly_terrain].model = lowpoly_terrain.glb`
- `meshTerrains[lowpoly_terrain].lodLevels[0] = lowpoly_terrain_lod.glb` at distance 520
- `meshTerrains[lowpoly_terrain].heightGrid = lowpoly_terrain_height_grid.bin`

Runtime does not create the terrain mesh. It loads the generated GLB and the generated height-grid data.

## Road Assets

The road is generated as static GLB meshes:

- `road_asphalt.glb`
- `road_shoulders.glb`
- `road_curbs.glb`
- `road_edge_lines.glb`
- `road_center_dashes.glb`
- `road_tire_grime.glb`
- `road_edge_grime.glb`

The map owns material, culling, and pick mode for these meshes. BK no longer manually fetches those model IDs and builds ad hoc entity descriptors.

Current road culling in BK is distance based. The road assets are still large continuous meshes, so frustum culling is not very useful yet. The right next step is to split road and terrain into map chunks if we want real per-section culling.

## Primitive Layer / Meadow

BK roadside meadow is currently a baked primitive layer:

- Source: `assets/maps/primitive_track/roadside_primitives.bin`
- Map layer: `roadside_meadow`
- Runtime layer: `primitive.ScatterStatic`

Conceptually, a primitive layer is a low-cost instance system:

- few shapes/materials
- many instance transforms
- chunked spatially
- suitable for grass cards, flowers, stones, roadside clutter

The current meadow is still visually not close enough to the concept. It has the older impressionistic billboard/card style restored, but the global scene still reads too uniformly green. Future visual work should continue on meadow composition, density bands, grass card size, color variation, and road/shoulder transitions through offline generation of `roadside_primitives.bin`.

## Culling And LOD

Entity culling:

- Implemented in `scene3d/draw.vo`.
- Uses `CullDistance`.
- Uses `FrustumCull` when enabled.
- Uses model AABB when available, otherwise a sphere fallback.
- `SceneRenderStats` reports `VisibleEntities`, `CulledEntities`, and `LodSwitchedEntities`.

Primitive layer culling:

- Implemented in `scene3d/primitive_layers.vo`.
- Static primitive layers are chunk culled in Vo before draw stream upload.
- First frame uploads only visible chunks.
- Previously uploaded chunks are toggled with `SetPrimitive3DChunkVisible`.
- This is chunk-level culling, not per-blade or per-instance culling for static layers.

BK current culling state:

- Meadow primitives: chunk culling is active.
- Ordinary small MapMesh objects: supported by voplay, but BK currently has few actual small MapMesh props because most small props are primitive instances.
- Large road/terrain meshes: distance and LOD are active; frustum chunk culling is not effective until those assets are split into chunks.

## Verification Commands

Known passing commands from the current state:

```sh
cd /Users/wuhao/code/github/volang
./d.py vo check /Users/wuhao/code/github/voplay
./d.py vo check /Users/wuhao/code/github/BlockKart
./d.py vo run /Users/wuhao/code/github/voplay/tests
```

## How To Run

Start or restart the Studio runner:

```sh
cd /Users/wuhao/code/github/volang
./d.py studio --runner /Users/wuhao/code/github/BlockKart
```

Then open or reload:

```text
http://localhost:5174/#/runner
```

If the runner is already open in the in-app browser, just reload the page after code/asset changes.

Stop Studio:

```sh
cd /Users/wuhao/code/github/volang
./d.py studio-stop
```

Basic compile checks:

```sh
cd /Users/wuhao/code/github/volang
./d.py vo check /Users/wuhao/code/github/voplay
./d.py vo check /Users/wuhao/code/github/BlockKart
```

Run voplay tests:

```sh
cd /Users/wuhao/code/github/volang
./d.py vo run /Users/wuhao/code/github/voplay/tests
```

Regenerate BK primitive terrain/map assets:

```sh
cd /Users/wuhao/code/github/BlockKart
node tools/generate_primitive_terrain.mjs
```

Repack runtime assets:

```sh
cd /Users/wuhao/code/github/BlockKart
/Users/wuhao/code/github/volang/target/debug/vo run tools/pack_primitive_assets.vo
```

Typical asset-edit loop:

```sh
cd /Users/wuhao/code/github/BlockKart
node tools/generate_primitive_terrain.mjs
/Users/wuhao/code/github/volang/target/debug/vo run tools/pack_primitive_assets.vo
cd /Users/wuhao/code/github/volang
./d.py vo check /Users/wuhao/code/github/BlockKart
```

Then reload the in-app runner.

Typical voplay-code-edit loop:

```sh
cd /Users/wuhao/code/github/volang
./d.py vo check /Users/wuhao/code/github/voplay
./d.py vo run /Users/wuhao/code/github/voplay/tests
./d.py vo check /Users/wuhao/code/github/BlockKart
```

Current in-app smoke check after the latest changes:

- canvas appears
- scene loads
- no browser error logs

Useful runtime controls:

- `W`: gas
- `S`: brake/reverse
- `A/D`: steer
- `Space`: drift
- `Shift`: boost
- `R`: restart
- `F3`: stats/debug overlay
- `F4`: material/render debug view
- `F5`: inspect
- `F6`: terrain/capture camera cycle, if bound in the current build

## How To Make Common Changes

Change terrain height/road-adjacent landform:

1. Edit `tools/terrain_heightfield_spec.mjs`.
2. Run `node tools/generate_primitive_terrain.mjs`.
3. Repack `assets/blockkart.vpak`.
4. Reload runner and inspect fixed views.

Change terrain/road/creek mesh material, culling, pick mode, or LOD:

1. Prefer editing `tools/generate_primitive_terrain.mjs`, because it regenerates `blockkart.map.json`.
2. For a quick test, edit `assets/maps/primitive_track/blockkart.map.json` directly.
3. Repack `assets/blockkart.vpak`.
4. Reload runner.

Change grass/meadow/flowers/stones:

1. Edit the baked primitive generation logic in `tools/generate_primitive_terrain.mjs`.
2. Regenerate `roadside_primitives.bin`.
3. Repack `assets/blockkart.vpak`.
4. Reload runner and compare screenshots.

Change runtime scenic primitives:

1. Edit `primitive_world.vo`.
2. Run `./d.py vo check /Users/wuhao/code/github/BlockKart`.
3. Reload runner.

Change voplay culling/LOD/map behavior:

1. Edit the relevant `voplay/scene3d/*.vo` files.
2. Add or update tests in `voplay/tests/main.vo`.
3. Run voplay check and tests.
4. Run BK check.

When changing generated assets, remember that Studio usually sees the runtime pack, not just loose files. Repack before judging the runner.

## Known Gaps

1. Road and terrain are still too monolithic for strong frustum culling.
   - Split road meshes and terrain mesh into spatial chunks in the offline generator.
   - Represent those chunks as multiple `MapMesh` or `MapMeshTerrain` entries with `frustumCull: true`.

2. Meadow still needs visual work.
   - The current grass cards are not yet concept-quality.
   - Improve offline baked primitive distribution, larger readable cards, color variation, and clear grass-over-dirt edges.

3. Whole scene still reads too uniformly green.
   - Add broader value/color variation in terrain materials and primitive distribution.
   - Concept image has clear dirt, grass, road, rock, flower, and tree mass separation.

4. Tree scale and composition need another pass.
   - Earlier feedback was that trees were too small.
   - Current scene has larger trees, but composition should be compared against concept screenshots.

5. LOD policy is basic.
   - Entity LOD switches by camera distance.
   - Terrain LOD exists now.
   - Future chunked terrain/road should get per-chunk LOD distances.

## Suggested Next Steps

1. Split `lowpoly_terrain.glb` and road GLBs into spatial chunks in `tools/generate_primitive_terrain.mjs`.
2. Update `blockkart.map.json` generation so chunk entries use `frustumCull: true`, sane `cullRadius`, and LOD where needed.
3. Keep `roadside_primitives.bin` as the main meadow path, but improve generation aesthetics instead of adding runtime mesh generation.
4. Capture before/after in-app screenshots after each visual pass.
5. Run the three verification commands and repack `assets/blockkart.vpak` after asset changes.

## Do Not Reintroduce

- Runtime terrain mesh generation in BK.
- Per-grass independent Entity or mesh objects.
- BK-specific manual unpacking of prepared map payloads when a voplay prepared map API can own it.
- Hidden fallback/try logic for missing required visual assets.
