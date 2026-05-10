# BlockKart Terrain Capture Views

Status: active supporting review note as of 2026-05-02.

This is not a roadmap. It defines fixed BlockKart review views for generated
terrain so procedural terrain passes can be judged from stable cameras instead
of whatever angle happened to be open.

This file defines the fixed screenshot set used to judge terrain progress. The goal is to compare terrain passes from stable views, not from whatever camera angle happened to be open.

## Capture Rules

- Use the normal BlockKart runner and renderer path.
- Capture at `1440x900` unless a task explicitly needs another viewport.
- Keep HUD/debug state consistent within a comparison set.
- Save milestone captures under `docs/images/` using this pattern:
  - `terrain-m0-start.png`
  - `terrain-m1-start.png`
  - `terrain-m1-first-bend.png`
  - `terrain-m1-road-edge.png`
  - `terrain-m1-overlook.png`
- Save the current agent-loop captures under these stable names:
  - `terrain-agent-latest-panorama.png`
  - `terrain-agent-latest-approach-cut.png`
  - `terrain-agent-latest-inner-basin.png`
  - `terrain-agent-latest-ridge-profile.png`
- Keep failed experiments outside `docs/images/` unless they are useful review artifacts.

## Required Views

### Panorama

Purpose: judge the whole terrain composition against the closed-loop concept.

Expected content:

- the complete closed-loop road
- outer left/right/far highlands
- lower inner basin
- broad foreground elevation
- enough distance visibility to see the terrain silhouette

Current source:

- F6 terrain capture view 1

### Approach Cut

Purpose: judge whether the road is embedded in shaped land.

Expected content:

- foreground road
- cut shoulders and raised banks on both sides
- visible slope faces
- rolling terrain beyond the road edge

Current source:

- F6 terrain capture view 2

### Inner Basin

Purpose: judge whether the loop interior is a real valley or rolling basin.

Expected content:

- inside-loop lower terrain
- valley depth separate from the road cut
- surrounding hills wrapping the basin

Current source:

- F6 terrain capture view 3

### Ridge Profile

Purpose: judge whether side and far terrain read as broad hill masses.

Expected content:

- side/highland profile
- far ridge and foreground roll
- no long parallel roadside trench dominating the view

Current source:

- F6 terrain capture view 4

### Material Debug

Purpose: prove terrain material identity through voplay debug modes.

Expected captures:

- lit
- albedo
- normal
- roughness
- shadow or direct light when lighting is being tuned

Current source:

- F4 cycles render debug modes

## Near-Term Tooling Need

M0 can start with the F6 terrain capture views. Later milestones should add either:

- a terrain capture camera mode in BlockKart, or
- a browser capture script that can drive fixed camera/input states deterministically.

The first accepted terrain milestone should not rely on memory or hand-picked lucky angles.

## Deprecated Views

Older captures named start, first-bend, road-edge, and overlook are preserved as
historical artifacts only. The active terrain-shape loop uses panorama,
approach-cut, inner-basin, and ridge-profile because those views match the
current closed-loop terrain goal.
