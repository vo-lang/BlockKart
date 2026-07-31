# BlockKart Vehicle Acceptance Standard

Status: Active

This document is the release gate for BlockKart vehicle work. A change is an
improvement only when it preserves the lower gates and advances a measured
higher gate. Parameter changes without a recorded scenario result do not count
as handling progress.

## Coordinate and input contract

- Driver-left steering is positive inside the game and vehicle model.
- Driver-right steering is negative.
- Keyboard, gamepad, and touch device axes convert once at the input boundary.
- Positive vehicle yaw must appear as a left turn in the chase camera.
- Steering input, front-wheel angle, yaw rate, drift direction, camera lead,
  and visual wheel angle must agree on the same driver-visible direction.

## G0: correctness

All items are hard gates:

- `A`, left arrow, left stick, and touch-left turn the kart left.
- `D`, right arrow, right stick, and touch-right turn the kart right.
- No input can teleport position or heading.
- Fixed-step simulation remains deterministic at 60 Hz.
- The chase camera follows kart heading through the complete yaw range.
- Wheel contact does not penetrate the road by more than 20 mm in steady
  driving and does not visibly alternate above/below the road.
- Releasing steering converges toward zero without oscillation.

## G1: controllability

Measured on keyboard with assists enabled:

- Straight acceleration: lateral displacement stays within 0.35 m over 100 m.
- Constant-radius turn at 50 km/h: yaw rate reaches 90% of its steady value in
  0.12-0.30 s and has less than 8% overshoot.
- Slalom: five 16 m gates can be cleared without leaving the 8 m lane.
- Full steering reversal at 50 km/h changes yaw direction in 0.18-0.42 s with
  no single-tick heading jump above 0.06 rad.
- Braking from 80 km/h remains directionally stable and stops within 24-36 m.
- Grass excursion remains steerable and can return to the road within 3 s.
- A barrier impact cannot permanently trap the kart or rotate it by more than
  1.2 rad in one physics step.

## G2: game feel

- 0-60 km/h takes 2.4-3.2 s on asphalt.
- Normal top speed is 100-112 km/h; boost top speed is 125-140 km/h.
- At 60 km/h, full steering produces a controllable 0.65-1.05 g peak lateral
  acceleration before assists and tire saturation settle the vehicle.
- Body slip remains below 5 degrees in grip driving and becomes progressive
  through the 5-14 degree range during drift initiation.
- Countersteer can arrest a drift; releasing drift produces a readable,
  bounded grip recovery.
- Camera yaw lag stays within 0.04-0.11 rad in grip driving and 0.04-0.18 rad
  while drifting.
- Acceleration, braking, slip, curb contact, grass, boost, and collision each
  have distinct visual and audio feedback.

## G3: performance and presentation

Target device for the current web demo: Apple M1, 1280x720, Chrome/WebGPU.

- Simulation cadence: 60 fixed ticks per second.
- Steady-state present rate: 60 FPS.
- P95 frame time: at most 16.7 ms.
- P99 frame time: at most 20 ms.
- No frame above 50 ms during a 60 s steady-state driving capture.
- No managed-heap growth after scene warmup and steady-state admission.
- P99 bounded GC work at a frame boundary: at most 1 ms on the target device.
- Wheel, suspension, chassis, effects, camera, and HUD remain visually smooth
  at the acceptance frame rate.

## Canonical scenarios

Every vehicle-model change records before/after telemetry for:

1. `straight`: full throttle for 6 s, then full brake until stopped.
2. `circle-left`: 50 km/h target speed and 70% left steering for 8 s.
3. `circle-right`: mirrored `circle-left`.
4. `slalom`: alternating 65% steering every 0.75 s for 9 s.
5. `recovery`: road-to-grass excursion, countersteer, road re-entry.
6. `impact`: 55 km/h shallow-angle barrier contact and recovery.

Required telemetry:

- simulation tick and fixed delta;
- input steering, wheel angle, throttle, and brake;
- position, heading, forward/lateral velocity, and yaw rate;
- body/front/rear slip angle;
- longitudinal/lateral acceleration;
- tire force, axle normal load, surface friction, and road offset;
- suspension heave and four wheel compressions;
- camera heading error;
- present FPS, frame-time percentiles, managed growth, and GC-step timing.

## In-game deterministic runner

Press `B` to start the next isolated handling scenario. The runner cycles
through `straight`, `circle-left`, `circle-right`, and `slalom`, uses the
shipping vehicle controller at the shipping 60 Hz fixed step, and displays its
result in the F3 telemetry panel.

The result is a hard pass only when every scenario-specific threshold and the
per-tick heading-jump threshold pass. The failure mask is additive:

- `1`: acceleration; `2`: straight-line stability; `4`: braking;
- `8`: heading discontinuity; `16`: direction; `32`: steering response;
- `64`: grip slip; `128`: yaw overshoot; `256`: slalom reversal count.

Reference result for the current asphalt setup:

- 0-60 km/h: 150 ticks (2.50 s); 80-0 km/h: 28.68 m.
- Constant left/right: 7-tick yaw response, 7.1% overshoot, 0.034 rad peak slip.
- Slalom: passing reversal count and 0.059 rad peak slip.

## Playability gate

After G0-G2 pass:

- A first-time keyboard player can finish one lap within three attempts.
- At least 90% of a clean lap is spent on the road surface.
- The lap requires no automatic recovery during normal driving.
- The player can identify why the kart lost grip and can recover from a minor
  mistake without restarting.
