# BlockKart Agent Terrain Editing Paradigm

Status: active direction as of 2026-05-02.

This document replaces blind terrain parameter tuning with an agent-facing
editing method inspired by production terrain tools. The goal is not to build a
human UI. The goal is to make the agent edit terrain the way a terrain artist
would think: layered, masked, stroke-based, and visually reviewed.

## Research Notes

Mature terrain editors share the same underlying workflow:

- Unreal Landscape sculpting exposes recognizable edit operations such as
  sculpt, smooth, flatten, ramp, erosion, hydro erosion, and noise. The artist
  chooses a brush, controls strength/falloff, applies a stroke, and reviews the
  landform in the real viewport.
- Unreal Landscape Splines use curves to place roads and paths, then reserve or
  deform terrain around those curves. Roads are therefore terrain-edit drivers,
  not decorative meshes floating above a heightfield.
- Unity Terrain works through height tools such as raise/lower, paint height,
  smooth height, and stamp terrain, with brush size/opacity/falloff controlling
  the affected area.
- Houdini HeightFields treat terrain as height and mask volumes. Artists build
  large forms first, derive masks from features, then run procedural passes such
  as noise, terrace, and erosion under those masks.

The shared lesson for BlockKart: terrain editing must be a sequence of named
operations over named regions. A pass is not "change some numbers"; it is "apply
this operation to this mask to create this visible form, then review from fixed
views."

Source links:

- Unreal Landscape Sculpt Mode:
  https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-sculpt-mode-in-unreal-engine?application_version=5.6
- Unreal Landscape Splines:
  https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-splines-in-unreal-engine?application_version=5.6
- Unity Terrain Raise/Lower:
  https://docs.unity3d.com/Manual/terrain-RaiseLowerTerrain.html
- Unity Terrain Smooth Height:
  https://docs.unity3d.com/Manual/terrain-SmoothHeight.html
- Unity Terrain Stamp:
  https://docs.unity3d.com/Manual/terrain-StampTerrain.html
- Houdini HeightField Erode:
  https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode.html
- Houdini HeightField Mask by Feature:
  https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_maskbyfeature.html

## Core Model

The agent edits terrain through five concepts:

1. Layer
2. Mask
3. Operation
4. Stroke
5. Review

Layer means the semantic terrain contribution, not a renderer texture layer:
base world relief, road cut, hill mass, valley cut, slope cleanup, and surface
detail are separate editable layers.

Mask means the region allowed to change: road corridor, inside loop, left
highland, right highland, far ridge, foreground basin, or a local brush ellipse.
Every edit must name its mask.

Operation means the terrain tool being simulated: raise, lower, flatten, smooth,
ramp, ridge, valley, stamp, erode, terrace, or noise.

Stroke means the operation parameters: center, orientation, length, width,
height, falloff, strength, and blend mode. In BlockKart this is expressed as
recipe entries or named generator terms, not by dragging a mouse.

Review means a real BlockKart runner screenshot from the fixed camera set. A
heightmap preview can explain the edit, but it cannot accept the edit.

## Edit Order

The agent should edit in this order until the terrain reads correctly:

1. Base Form
   Build the map-scale silhouette: outer hills, inner basin, far ridge, and
   foreground elevation. This establishes "hills first, road second."

2. Road Cut
   Treat the closed track as a spline mask. Cut or shelf terrain near the road,
   raise banks outside the road, and keep the road physically embedded.

3. Valley And Ridge Composition
   Add broad valleys, ridge backs, and rolling lobes that cross or wrap around
   the road. Avoid long parallel ditches that merely trace the asphalt.

4. Cleanup
   Smooth accidental spikes, flatten only intentional shelves, and reduce forms
   that read like walls instead of hills.

5. Surface Detail
   Add erosion, terrace, facet, and small noise only after the big terrain shape
   is readable. Detail must support the landform, not hide a weak one.

Water, vegetation, rocks, fences, buildings, and props remain locked out until
the base terrain composition is close enough in the fixed terrain views.

## Edit Intent Template

Before modifying terrain data, the agent writes an edit intent in its working
notes or commit summary:

- Problem: what the screenshot shows wrong.
- Target View: which fixed camera proves the problem.
- Mask: the region that may change.
- Operation: the simulated terrain tool.
- Stroke: center/orientation/size/height/falloff.
- Expected Visual Result: what should visibly change.
- Rollback Condition: what would mean the edit made the terrain worse.

If an edit cannot be stated in this form, it is probably random parameter
tuning and should not be made.

## BlockKart Operation Mapping

Current recipe and generator terms should map to terrain-editor operations:

- `macroTerrain.rollingWaves`, `broadBasins`, `localRelief`: base form, large
  raise/lower/noise strokes.
- `corridor.roadProfile`: road spline cut, shoulder shelf, bank raise, ditch
  lower, and road-edge blend.
- `landforms.kind = radial_mound`: stamp or raise brush.
- `landforms.kind = radial_valley`: soft lower brush.
- `landforms.kind = oriented_hill`: ridge or ramp stroke.
- `landforms.kind = oriented_valley`: valley cut or drainage stroke.
- Future named terms should add explicit cleanup operations: smooth mask,
  flatten shelf, terrace slope, erode channel, and clamp wall slope.

The recipe should stay readable as an edit log. If many landforms are added
only to compensate for a missing operation, add the named operation instead.

## Iteration Rule

One terrain iteration may touch at most two semantic layers unless the agent is
doing a documented reset. This keeps visual cause and effect legible.

Preferred iteration shape:

1. State the edit intent.
2. Modify one or two recipe/generator terms.
3. Run a fast terrain pass.
4. Capture real runner views.
5. Compare against the concept target and diagnose the next mismatch.
6. Run a full pass only when the fast pass moves the landform in the right
   direction.

The agent should not advance to material, water, vegetation, or prop work while
the panorama still reads as a flat plain with roadside trenches.

## Acceptance Gates

The terrain pass is not accepted until these fixed views agree:

- Panorama: the whole closed-loop map reads as rolling hills around a lower
  inner basin.
- Approach Cut: the road sits inside shaped terrain, with banks and shoulders
  visible on both sides.
- Inner Basin: the loop interior is a real valley or rolling depression, not a
  flat field.
- Ridge Profile: side and far highlands form broad hill masses instead of thin
  walls.

Only after these gates pass should BlockKart start the next phase: terrain
materials, then water/vegetation/rocks/props.
