# BlockKart Model Rendering Target

This document defines the non-negotiable visual target for BlockKart model rendering. The goal is not "slightly better than now"; the goal is a polished stylized kart-racing scene where a single hero asset looks intentional, tactile, and production-worthy before we scale the approach to the whole track.

## North Star

BlockKart should render stylized kart-racing assets with the clarity, saturation, material separation, and lighting polish of a premium cartoon racing game.

The scene should read as:

- bright outdoor daylight
- clean toy-like but not flat
- saturated color without plastic mud
- soft, readable shadows
- clear material identity at a glance
- rounded, bevelled, chunky forms
- rich surface detail that supports the shape instead of noisy procedural dirt

The concept image in `docs/images/scenic-track-concept.png` is the current visual north star for composition, color, light mood, and asset richness.

## Hero Asset Bar

Before building a whole track, one hero asset must meet this bar in the runner:

1. **Shape Quality**
   - No raw cube-block look on visible hero surfaces.
   - All hard-surface props have bevels or rounded silhouettes where light should catch.
   - Small details exist at multiple scales: primary silhouette, secondary trim, small bolts/seams/edge accents.
   - Geometry is arranged as a designed object, not loose primitives.

2. **Material Identity**
   - Painted surfaces look like glossy cartoon paint or enamel, not flat yellow rectangles.
   - Rubber looks dark, soft, and slightly rough, not black plastic.
   - Metal has readable highlight response and separates from rubber.
   - Grass/leaf materials are lively but not noisy.
   - Asphalt has surface grain and directional wear but does not turn into visual static.

3. **Lighting**
   - A warm sun/key light creates readable form.
   - A cool sky/fill contribution keeps shadowed sides colorful, not black.
   - Contact shadows ground props to the terrain.
   - Shadow edges are stable and not jagged enough to distract.
   - Highlights on paint and metal are visible from the gameplay camera.

4. **Color Pipeline**
   - The renderer uses a consistent linear/sRGB workflow.
   - Tone mapping and exposure preserve bright stylized colors.
   - Saturation is intentional; colors should not wash out or become dull grey.
   - Texture colors in the game should resemble authored colors under neutral lighting.

5. **Material Pipeline**
   - glTF `baseColorTexture`, `normalTexture`, and `metallicRoughnessTexture` must work reliably.
   - Tangents must be present or generated correctly.
   - Normal maps must visibly affect lighting on a known test surface.
   - Roughness must visibly change highlight size/intensity on a known test surface.
   - Metallic must visibly change specular color/response on a known test surface.

6. **Debuggability**
   - The engine needs visual/debug modes for at least:
     - lit final
     - albedo/base color
     - world normal or tangent-space normal contribution
     - roughness
     - metallic
     - direct light only
     - ambient/fill only
     - shadow mask
   - Without these modes, visual iteration is guesswork and should not continue.

## Acceptance Tests

The hero asset is not accepted until all of these pass:

1. **Screenshot Test**
   - In runner at `1280x720`, the hero asset reads clearly from the default gameplay camera.
   - A cropped screenshot of the asset still shows separate paint, rubber, metal, grass/leaf, and asphalt/material base.

2. **Material Difference Test**
   - Painted, rubber, metal, grass/leaf, and asphalt surfaces can be identified without knowing the code.
   - Turning normal maps off must visibly flatten the test asset.
   - Turning roughness/metallic effects off must visibly reduce material separation.

3. **Lighting Test**
   - The asset has readable light side, shadow side, and contact shadow.
   - The same asset does not become black in shadow or overexposed in light.
   - The highlight on metal/paint is visible but not realistic-chrome.

4. **Concept Direction Test**
   - The asset should feel compatible with the concept image's world: clean, saturated, playful, high-quality.
   - It should not look like debug geometry, early WebGL sample art, or a procedural-noise test.

5. **Engine Capability Test**
   - The result must come through voplay's normal asset/render path.
   - No screenshot-only hacks.
   - No one-off browser-only shader hacks.
   - No bypassing the GLB/material pipeline.

## Implementation Order

### P0: Renderer Truth Serum

Build a material verification scene and debug views before making more assets.

Deliverables:

- debug view selector in voplay or BlockKart runner
- lit/albedo/normal/roughness/metallic/shadow/ambient modes
- one material test asset with known albedo, normal, roughness, and metallic values
- screenshot set saved under `docs/images/`

Exit criteria:

- We can prove whether normal/roughness/metallic are working visually.
- We can identify if the current weakness is asset authoring, lighting, shader math, or color pipeline.

Current implementation:

- voplay exposes `SetRenderDebug3D` and `scene3d.Scene.RenderDebugMode`.
- The mesh, skinned mesh, and terrain shaders support lit, albedo, normal, roughness, metallic, shadow, direct, and ambient debug output.
- BlockKart runner cycles the view with F4 and displays the active view label.
- Normal, roughness, and metallic debug proofs are saved at:
  - `docs/images/render-debug-normal.png`
  - `docs/images/render-debug-roughness.png`
  - `docs/images/render-debug-metallic.png`
  - `docs/images/render-debug-terrain-normal.png`
- The current BlockKart target exercises materials through the primitive scene, heightfield terrain splat layers, and low-poly kart meshes; the retired scenic showcase GLBs are no longer part of the runtime target.

### P1: Lighting And Color Foundation

Make the default outdoor scene look premium before adding more geometry.

Deliverables:

- tuned sun, sky/fill, ambient, fog, exposure, contrast, saturation
- stable contact shadows
- color pipeline audit for sRGB and linear sampling

Exit criteria:

- The material test asset has believable form and material separation in the default camera.
- Texture colors do not drift badly from authored colors.

Current implementation:

- voplay lighting profiles now carry `ShadowStrength`, and the mesh/skinned/terrain shaders soften shadow visibility with that value instead of treating shadows as a hard binary multiplier.
- voplay lighting profiles now carry sky/ground hemisphere ambient, and the mesh/skinned/terrain shaders use the surface normal to blend between them.
- voplay `MaterialDesc` now exposes engine-level `MetallicRoughness` texture override and `NormalScale`, matching the renderer's glTF PBR texture path instead of leaving roughness/metallic locked to source assets.
- voplay heightfield terrain now supports single-material normal and metallic-roughness textures, with `normalScale`, `roughness`, and `metallic` coming from the map/track terrain data.
- voplay terrain splat layers now use the same material path for layer albedo, normal, metallic-roughness, UV scale, and normal scale; BlockKart's primitive heightfield terrain exercises that path with grass, meadow, dirt, and rock layers.
- BlockKart keeps shadows enabled through the kart racing profile, with softened stylized contact shadows.
- Lit proof after the first shadow-strength pass is saved at `docs/images/render-p1-lit-shadow-strength.png`.
- Lit proof after the hemisphere ambient pass is saved at `docs/images/render-p1-hemisphere-ambient.png`.

### P2: Hero Asset Rebuild

Rebuild one hero trackside asset to the target bar.

Deliverables:

- bevelled/rounded geometry
- authored UVs with consistent texel density
- albedo/normal/metallic-roughness maps
- optional baked AO or vertex color AO if the renderer lacks AO

Exit criteria:

- The hero asset passes all acceptance tests above.

Current implementation:

- BlockKart now builds the target scene through primitive layers, heightfield terrain, generated road ribbons, and low-poly kart primitives instead of the retired scenic GLB prop package.
- The current runtime has no authored GLB scene assets; terrain, roadside detail, and kart visuals are built from heightfield terrain, generated road ribbons, and retained primitive layers.
- BlockKart exposes F5/F6 inspection cameras so terrain, grass, road edges, and primitive props can be judged through the normal runner instead of only from the racing chase camera.
- Current proof screenshots are saved at:
  - `docs/images/hero-marker-lit.png`
  - `docs/images/hero-marker-lit-lighting-pass.png`
  - `docs/images/hero-marker-inspection-camera.png`
  - `docs/images/hero-marker-albedo.png`
  - `docs/images/hero-marker-normal.png`
  - `docs/images/hero-marker-roughness.png`
  - `docs/images/hero-marker-metallic.png`
  - `docs/images/hero-marker-tire-closeup.png`
- BlockKart's outdoor lighting profile now uses a warmer stronger key light, a cooler fill light, brighter hemisphere ambient, softened shadows, and a modest exposure/contrast/saturation pass for the scenic slice.

Remaining gaps:

- The hero asset is now useful as a renderer proof, and the tire stack is the current detail benchmark for the rest of the prop kit.
- The material response is visible in debug modes, but the lit view still needs a dedicated close inspection composition for judging paint and metal highlights.
- The standalone showcase assets should become the reference target for the next asset-quality pass, rather than continuing to judge from a distant gameplay camera only.

### P3: Asset Kit

Only after the hero asset passes, expand into a reusable scene kit.

Deliverables:

- track signs
- curb modules
- tire walls
- grass tufts
- rocks
- trees
- barriers
- small architecture pieces

Exit criteria:

- Repeated assets stay performant and visually consistent from gameplay camera.

## What We Will Not Do

- We will not keep adding low-quality props hoping the scene improves.
- We will not accept "the texture applied" as success.
- We will not treat one noisy procedural texture as a material.
- We will not judge renderer quality without debug views.
- We will not call an asset done if it only looks acceptable in a tiny crop.
