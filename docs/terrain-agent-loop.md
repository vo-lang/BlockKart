# BlockKart Agent Terrain Loop

Status: active direction as of 2026-05-02.

This replaces the human-facing terrain editor plan. BlockKart does not need a
terrain UI right now. It needs an agent-facing optimization loop that can move
the generated heightmap toward the concept target through repeated visual
passes.

The active editing philosophy lives in
`docs/terrain-agent-editing-paradigm.md`. That document is the contract for how
terrain edits are chosen. This file defines the build/capture/review loop that
executes those edits.

## Rule

The loop is accepted only when it uses real BlockKart runner screenshots. A
heightmap, contour map, SVG plan, or generated review board can guide the next
edit, but none of those artifacts proves visual progress by itself.

## Deprecated Approach

The old approach of adding arbitrary mounds, valleys, and generator constants
until a screenshot looks different is deprecated. It produced visible movement
but not enough control. A terrain pass must now be phrased as a terrain-editor
operation over a named mask, with an expected visual result before the data is
changed.

## Loop

1. Write an edit intent using the template in
   `docs/terrain-agent-editing-paradigm.md`:
   - problem
   - target view
   - mask
   - operation
   - stroke
   - expected visual result
   - rollback condition
2. Edit the terrain source data:
   - `terrain/recipes/primitive_concept_v1.json`
   - named generator terms in `tools/terrain_heightfield_spec.mjs` only when
     the recipe cannot express the needed change yet
3. Run:
   - quick iteration: `node tools/agent_terrain_loop.mjs pass --fast`
   - full asset pass: `node tools/agent_terrain_loop.mjs pass`
4. Start the normal runner and capture fixed terrain views from the real game:
   - `docs/images/terrain-agent-latest-panorama.png`
   - `docs/images/terrain-agent-latest-approach-cut.png`
   - `docs/images/terrain-agent-latest-inner-basin.png`
   - `docs/images/terrain-agent-latest-ridge-profile.png`
   - in the in-app browser Node REPL:
     `const { captureTerrainViews } = await import('/Users/wuhao/code/github/BlockKart/tools/capture_terrain_views.iab.mjs'); await captureTerrainViews(tab, { display });`
5. Run:
   - `node tools/agent_terrain_loop.mjs review`
6. Inspect:
   - `docs/images/terrain-agent-review-board.svg`
   - `docs/terrain-agent-diagnostics.json`
7. Make the next edit based on the visible mismatch against:
   - `docs/images/terrain-closed-loop-concept-v1.png`

## Edit Pass Order

The agent must work from large forms to small forms:

1. Base form: whole-map hills, inner basin, far ridge, and foreground elevation.
2. Road cut: closed-track spline corridor, shoulders, shelves, and banks.
3. Valley/ridge composition: broad forms that cross or wrap the track.
4. Cleanup: smoothing, intentional flattening, slope control, and wall removal.
5. Surface detail: erosion/noise/terrace only after the terrain reads correctly.

Water, vegetation, rocks, fences, and landmarks are out of scope until these
terrain gates pass in the real runner views.

## What The Agent Edits

The recipe is the primary edit surface. It describes:

- track shape and spawn straight
- hero segment start, center, and end
- road corridor profile: shoulder drop, ditch, cut face, near hill, outer hill
- landform features: creek valleys, cut slopes, ridges, overlook mound, broad
  meadow hills, and soft valleys
- material intent for splat generation

The generator is the secondary edit surface. It should change only when the
recipe lacks an expressive primitive for the desired terrain form.

Edits should map to terrain-editor operations:

- raise/lower/stamp: `radial_mound`, `radial_valley`, broad basins, and waves
- ridge/valley/ramp: `oriented_hill` and `oriented_valley`
- road spline cut: `corridor.roadProfile`
- noise/erosion/facet: `macroTerrain.localRelief`, horizon facets, and future
  named detail passes
- cleanup: future smooth/flatten/terrace masks, added only when a screenshot
  shows a clear need

## What The Agent Reviews

The first glance should answer these questions:

- Panorama: does the whole map read as hills first, with a visible closed loop?
- Approach Cut: does the road look carved into land, or pasted on top?
- Inner Basin: does the loop interior read as lower terrain instead of a flat
  field?
- Ridge Profile: do the left/right/far sides read as broad hill masses instead
  of thin walls or roadside ditches?

The numeric diagnostics are only a guardrail. They tell the agent whether the
heightmap has enough range and cross-road elevation difference before spending
time on a full visual pass.

## Current Gap

`tools/agent_terrain_loop.mjs` now handles build, diagnostics, capture target
manifests, and review board generation. `tools/capture_terrain_views.iab.mjs`
contains the reusable in-app browser capture step, so a terrain pass no longer
needs hand-written screenshot code every time. The shell tool intentionally does
not try to control the in-app browser directly; the capture module is imported
from the Browser Use Node REPL after the runner is available.

Use `--fast` for most hill-shape experiments. It writes a 257px heightmap,
512px splat, lighter contours, and skips the PNG review board. Use a full pass
before judging final terrain quality in the runner.

## Non-Goals

- no human-facing terrain editor
- no drag UI
- no smoke view
- no accepting contour images as visual proof
- no separate demo route that is not the normal BlockKart runner
