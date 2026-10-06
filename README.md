# OPERATION: BLACK VECTOR

A complete, playable first-person tactical shooter that runs entirely in a desktop
browser. Night infiltration of a fictional industrial facility ("the Kestrel Yard
logistics compound") owned by the fictional **Vektor Dynamics** cartel front, on the
fictional island of **San Mirela**. All factions, weapons, characters and the map are
original. Everything (geometry, textures, audio, animations) is generated
procedurally at boot — there are no external asset files, no backend, no login and
no build step.

Tech: HTML5 + CSS3 + ES-module JavaScript + Three.js (r160, vendored) + WebGL +
Web Audio API + Pointer Lock + Canvas 2D (procedural textures & HUD-free 2D work).

---

## 1. Setup & running

Requirements: any modern desktop browser with WebGL2 (Chrome/Edge/Firefox/Safari 16+).
No internet access needed after the files are on disk; no npm/build step.

The game uses ES modules, which browsers refuse to load from `file://`. Serve the
folder over plain HTTP — any static server works:

```bash
cd <project root>          # the folder containing index.html
python3 -m http.server 8123
# then open:  http://localhost:8123/index.html
```

Equivalent alternatives: `npx serve .`, `php -S localhost:8123`, or any web server
pointed at the folder. Click **CAMPAIGN** (mouse click also locks the pointer and
initialises audio, as required by browser autoplay policy).

### File layout

```
index.html                 screens + HUD markup, importmap, module bootstrap
style.css                  tactical UI styling (CSS variables, no frameworks)
assets/vendor/three.module.js   Three.js r160 (MIT), vendored for offline play
js/main.js                 entry point: preflight warnings, global error overlay
js/game.js                 Game class: state machine, settings, input, main loop,
                           hands-mode arbitration (gun / throwable / utility)
js/player.js               FPS controller: gait, stamina, lean, damage, snapshots
js/weapons.js              11 original weapons, models, ballistics, pickups
js/enemies.js              guard AI: FSM, perception, squad awareness, cover use
js/physics.js              AABB world grid, swept movement, raycasts, materials
js/world.js                7 map builders: geometry, doors, glass, lights, zones,
                           vehicles, crates and pickups placement
js/audio.js                procedural Web Audio: SFX synthesis, HRTF, zone reverb
js/particles.js            pooled VFX: tracers, impacts, muzzle flash, glass, smoke
js/missions.js             mission engine: 17 operations, seq/flow stages,
                           checkpoints, lockdown, range mode, map state feed
js/tacmap.js               live tactical map + HUD mini-map: fog of war, markers,
                           zoom/rotation, route lines (2D canvas, pooled)
js/vehicles.js             5 fictional vehicles: arcade physics, damage states,
                           AI routes, chase/driver cameras, trunk storage
js/throwables.js           throwable & utility framework: grenades, smoke, flash,
                           decoy, flare, sensor, medkit, breach charge
js/loadout.js              pre-mission loadout configuration + validity rules
js/progress.js             XP, ranks, medals, mission records, stats (localStorage)
js/ui.js                   HUD + menus: compass, toasts, hitmarkers, equipment
                           wheel, loadout panel, debrief, damage direction
```

---

## 2. Controls

| Action | Key / mouse |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint (hold, drains stamina) | `Shift` |
| Crouch (toggle) | `Ctrl` |
| Jump / handbrake (in vehicle) | `Space` |
| Lean left / right | `Z` / `X` |
| Fire / throw equipped item | left mouse |
| Aim down sights / alt-use (detonator, place charge) | right mouse |
| Reload / clear malfunction | `R` |
| Equip throwables (cycle) | `G` |
| Equipment wheel (hold, move mouse, release) | `Q` |
| Apply field dressing (hold) | `H` |
| Tactical map overlay (zoom: wheel, `Esc` closes) | `M` |
| Quick-select primary / secondary / throwable / utility | `1` `2` `3` `4` |
| Interact / hold-to-hack / board & exit vehicles | `F` |
| Vehicle camera (chase ⇄ driver view) | `C` |
| Pause | `Esc` |

Driving: `W`/`S` throttle & brake, `A`/`D` steer, `Space` handbrake, `Shift` boost
(sporty vehicles only). Steering sensitivity, steering inversion and chase-cam
distance are configurable under SETTINGS.

Movement is grounded and human-scale: walk 3.0 m/s, sprint 5.6 m/s, crouch 1.15 m/s,
jump apex ~0.6 m. Sprinting stamina drains (~17/s) and regenerates after a short
delay; firing while sprinting is not possible. Every gait makes noise that guards
can hear (radius depends on gait and surface).

---

## 3. Gameplay overview

**Theater select (CAMPAIGN button):** four battlefields, one operator:

| Battlefield | Theme | Flow |
|---|---|---|
| KESTREL YARD | night industrial facility | infiltrate: breach → warehouse → server hack → response → LZ |
| WHITEOUT RELAY | snow compound above the tree line | assault: breach loud → clear all hostiles → helipad LZ |
| DUSTBOWL CACHE | desert adobe compound in a dry wadi | infiltrate: wall gate → cache manifest hack → north gap → wadi LZ |
| GREYLINE DISTRICT | abandoned urban city block | infiltrate: checkpoint → bank record room → alley → service yard LZ |

Each battlefield is a hand-built procedural map with its own geometry, cover network,
patrol routes, spawn/surge tables, audio zones and objective text. Checkpoints,
death/restart and the lockdown timer work per mission (assault missions run without
a lockdown clock).

**White Mode (Settings → WHITE MODE):** a full daylight relight of any battlefield —
white sky, sun instead of moon, dimmed interior lamps, per-map day fog (snow becomes
a whiteout). HUD switches to a dark-on-light palette automatically. Preference is
persisted with the other settings.

**Campaign — Kestrel Yard (9-step flow):**
1. Night insertion on foot south of the fence line.
2. Breach through the cut in the fence.
3. Infiltrate the facility (warehouse, dock, offices, corridors).
4. Locate the server terminal in the upper server room.
5. Hold `F` for 8 s to download (hack progress bar; noise-free but time costs you).
6. Alarm: lockdown countdown (6 min), guards converge, reinforcements surge in.
7. Escape the office wing back through the warehouse.
8. Reach the extraction marker in the west yard (smoke flare lit); a second wave
   arrives at T−50 s.
9. Extract → debrief screen with stats. Letting the lockdown expire = mission failed.

**Training — weapons range:** three lanes of pop-up targets, infinite reserve ammo,
per-lane distances. Targets fall when hit and reset after 2.5 s.

**Checkpoints** are saved automatically at every objective change (localStorage key
`obv_checkpoint_v1`); death or failure offers *restart from checkpoint*, *restart
mission*, or *quit to menu*. Settings persist under `obv_settings_v1`.

### Weapons (original designs, full per-weapon stats)

| | VX-4 "Vandal" | MR-7 "Longlane" | P9 "Whisper" |
|---|---|---|---|
| Role | assault rifle | marksman rifle (projectile) | compact PDW, integral suppressor |
| Fire | auto 660 rpm | semi (0.5 s pause) | semi-fast (0.13 s) |
| Damage | 26 | 78 | 24 |
| Mag / reserve | 30 / 150 | 10 / 40 | 15 / 60 |
| ADS spread | 0.55° | 0.34° | 0.62° |
| Noise radius | 55 m | 85 m | 34 m (suppressed) |

Shot pipeline per trigger pull: state check → spread/bloom cone → hitscan ray
(MR-7 spawns a 260 m/s projectile with gravity drop) → world/door/glass/enemy
collision → surface material resolution → zone damage (head ×3.2–4, torso ×1,
arms ×0.7 + aim penalty, legs ×0.6 + mobility penalty) → impact feedback
(sparks/dust/glass per material, decal-free pooled particles) → hit reaction
(flinch, stagger, topple on death) → audio + tracer.

Feedback is deliberately blood-free: hits read through spark/dust bursts, tracers,
hitmarkers, directional damage indicators and enemy reactions.

### Enemy AI

Guards run a full state machine: `patrol → suspicious → investigate → combat
(engage / take cover / reposition / advance) → search`, plus death topple.
Perception combines a distance-limited view cone, line-of-sight checks against the
physics grid, and hearing (gunfire radius per weapon, footsteps per gait, glass,
doors). Knowledge is imperfect: they track a *last-known position*, lose you when
LOS breaks, and search probabilistically. Squad awareness: spotting you or hearing
combat raises local alertness and shares last-known positions; the alarm converts
the whole facility to converge/search behaviour and queues reinforcement surges.
Enemies use scored cover points, flank when you turtle, and advance when you don't.

---

## 3b. Realism package

Layered on top of the base simulation, in four stages. Everything below is
procedural, pooled, and dependency-free.

**Weapon handling.** Each weapon has a deterministic recoil signature — a
per-shot ramp curve plus a sine yaw component — so bursts climb and drift the
same way every time and can be learned and controlled. Bloom resets the
signature once it settles. Aimed fire adds breathing sway scaled by stamina,
overall health and arm injuries; suppression multiplies it.

**Terminal ballistics.** Damage falls off with range, and bullets penetrate by
material: glass passes at 85% damage, wood at 60% (one pass), concrete and
steel stop the round. Impacts leave pooled decals (64-entry ring buffer of
bullet holes and scorch marks) with material-specific sparks, dust and smoke.

**Malfunctions.** Sustained fire heats the weapon; above the heat thresholds a
round can fail to feed or fire. A dead trigger click latches the weapon until
you press `R` to tap-rack it (1.15 s, scaled by handling). The HUD reads
`MALFUNCTION — R TO CLEAR` or `RACKING BOLT`.

**Environment.** Night skies carry a 500-point star field and a moon disc with
halo, hidden in White Mode. Each battlefield runs its own weather — snow
assault has drifting snowfall, the desert a dust stream, the city block rain —
with a matching wind bed (brown noise through a lowpass, gust LFO). Volumetric
light shafts and 140 drifting dust motes sit under the facility lamps.

**Shootable lights.** Every lamp, pole light, hanging lamp and floodlight is
registered as a shootable sphere. Hitting one throws sparks, swaps the bulb to
a burnt material and kills the light for the rest of the mission; the bullet
keeps going.

**Camera shake.** Firing and nearby impacts kick the camera with an
exponentially decaying rotation jitter — the MR-7 kicks hardest.

**Enemy AI additions.** Guards throw frag grenades on a telegraphed wind-up
(radio callout, pulsing red danger ring at the predicted impact point, 2.6 s
fuse, scorch decal, radial falloff damage to both sides). Near-misses suppress:
rounds cracking past the player raise a suppression meter that muffles audio
through a master lowpass, widens ADS sway and shows `SUPPRESSED`. Enemies
suppress too — being shot at near a hostile doubles their dispersion and pins
them to cover. Every third guard carries a flashlight that fades on during
patrol at night and cuts out in combat. Contact triggers procedural radio
chatter lines.

**Morale.** A hostile below 25 health with no ally inside 12 m breaks: up close
they surrender (kneel, rifle hidden, excluded from `activeHostiles`), at range
they flee toward the farthest surge point and go to ground. Assault objectives
complete on `activeHostiles === 0`, so a broken squad counts as cleared.

**Tactical map.** `M` renders a top-down overlay built from the live collider
grid, colour-coded by material, with doors, items, objective, LZ, your position
and view cone, plus hostiles spotted in the last 6 seconds. The static layer is
cached to an offscreen canvas; only the dynamic layer redraws.

**Mobility and survival.** Mantling vaults ledges up to 1.28 m — a chest-height
probe rejects walls, a downward probe finds the ledge surface, and the move is
a 0.45 s eased arc that costs stamina. Armour plates start at 50 and absorb 65%
of incoming damage until shredded; crates restore +50. Holding `H` for 2.8 s
applies a field dressing: +28 health, arm and leg injuries cleared, 12 s
cooldown. A compass strip across the top shows cardinal ticks, the objective
bearing and its distance in metres.

---

## 4. Rendering / audio / performance notes

- **Quality tiers** (Settings): high / medium / low adjust pixel-ratio cap, draw
  distance (260/220/160 m), fog density, shadow-map sizes and particle budget.
  **Performance mode** forces low tier + reduced particles.
- Shadow casters: moon (directional, 2048/1536/1024) + 2 warehouse spot shadows on
  high/medium only; all other lights are shadow-free.
- Physics uses a uniform spatial hash grid (8 m cells) — movement, raycasts and LOS
  queries touch only neighbouring cells; typical frame queries < 10 colliders.
- Particles are fully pooled (tracers, impacts, glass, smoke, muzzle flash); the
  main loop allocates ~0 objects per frame (reused Vector3 temps everywhere).
- Frustum culling is on by default; viewmodels render in a depth-test-free pass.
- Audio is 100 % synthesised Web Audio (noise bursts + filtered oscillators +
  convolution reverb per zone: warehouse/room/corridor/outdoor impulse responses
  generated at boot). HRTF panners place every source; occlusion lowers volume and
  cuts high frequencies when LOS is blocked.
- Measured on a mid-range desktop GPU: 60 fps at 1080p high; the logic tick is
  clamped to 50 ms and decoupled from render hitches.

---

## 5. Known limitations (honest list)

- Procedural box/prism geometry: the world reads as stylised-realistic, not
  photogrammetry. Textures are Canvas-generated (concrete, metal, gravel, wood,
  rust, painted lines) at 256–512 px.
- No saved games beyond the single checkpoint slot and settings (by design, no
  backend).
- Enemy animation is procedural (limb swing, aim pose, topple) — no mocap rig.
- Vehicle props are static; doors are sliding/swing AABBs, no destruction beyond
  breakable glass panes.
- Headless/software-GL environments (CI, SwiftShader) render at ~1–30 fps; the game
  is GPU-bound as expected — use low tier + performance mode on weak hardware.
- Pointer Lock requires a user click and a non-embedded context; some browser
  iframes block it (the game shows a "click to re-capture" prompt and pauses).
- Water and a dynamic day/night cycle are out of scope; White Mode is a designed
  daylight relight, not a simulated sun cycle. Weather (snow/rain/dust + wind
  audio) is per-map and pooled, not a dynamic system.
- New battlefields are compact compared with Kestrel Yard by design (tighter
  combat spaces, fewer interiors) to keep frame rates high on integrated GPUs.

---

## 5b. THE EXPANSION — new battlefields, operations & meta layer

### New battlefields (total: 6 maps + training range)

| Map | Setting | Weather | Signature spaces |
|---|---|---|---|
| **KESTREL WORKS** (`industrial`) | Industrial complex | Rain (masks noise 28%) | Warehouse with slide-up gate & roof stairs, forge hall (furnace / hydraulic press / coolant tank), fenced generator yard, two-storey office block, container yard, pipe rack, water tower. Breach via main gate, east cut, or the service culvert. |
| **DRAVA OUTSKIRTS** (`rural`) | Rural valley | Fog (visibility cut — `fogMul` 2.4) | Dirt road with a bend, terraced hills with pines, wheat fields with fencing, four-house village + stone well, radio shack with antenna mast, barn + silo + pen farm, sandbag road checkpoint. |

Both maps carry practical lighting (sodium poles, hanging lamps, furnace glow),
audio reverb zones (warehouse / forge / office / barn / shack interiors), machine
ambience points, patrol routes, surge points, ammo crates and four intel
documents each.

### New operations (total: 10 missions) — multi-stage "seq" engine

| Mission | Map | Type | Flow |
|---|---|---|---|
| SANDGLASS RECON | desert | Recon | Three observation posts (west/east overwatch, north ridge) → extraction |
| COLD FORGE | industrial | Sabotage | Breach perimeter → **start auxiliary generator (unlocks the security door)** → enter forge hall → plant 3 charges (first one trips the alarm + QRF surge) → extraction |
| QUIET HARVEST | rural | Investigation | Reach the farm road → examine 3 evidence markers (burned truck, village well, shack porch) → pull frequency records → extraction |
| LOST SHEPHERD | rural | Rescue | Reach the village → speak to the survivor → **escort** (he follows, jogs to keep up) → extraction completes when he reaches the LZ |
| NIGHT WATCH | urban | Defense | Reach the bank → hold the record room → survive 150 s with timed waves → extraction |
| LAST LIGHT | snow | Extraction | Reach the helipad → hold 120 s against waves until the bird lands → board |

Every seq step saves a checkpoint, shows on the objective HUD + compass, and can
carry side-effects (`alarmOnDone`, reinforcement surges, lockdown countdown).

### NPCs & world events

* **Civilians** wander authored waypoints and flee gunfire, breaking glass and
  explosions (audio-driven, no HUD markers).
* **Escort contact** (the shepherd) switches to follow mode on interaction,
  eases into a jog when falling behind, and confirms extraction at the LZ with
  radio dialogue.
* **World-event director**: every ~55–130 s the world breathes — intercepted
  radio chatter (unique lines per map) or a distant firefight (spatial audio
  only; it never feeds the AI, so it changes nothing mechanically).

### Meta layer (progression, all localStorage)

* **XP & ranks**: RECRUIT → OPERATOR → SPECIALIST → VETERAN → FIELD EXPERT →
  ELITE (0 / 600 / 1600 / 3200 / 5400 / 8200 XP); rank tint applied to the
  weapon finish.
* **12 medals** (GHOST, PRECISION, SURVIVOR, SHARPSHOOTER, …) awarded on the
  post-mission **debrief** with a 0–100 performance rating, XP breakdown, rank
  progress bar and newly-earned unlocks.
* **STATISTICS** screen (missions, play time, accuracy, damage, stealth runs,
  best performance) and **INTELLIGENCE** screen (per-map found/remaining with
  labels — intel is never required to finish a mission).
* **Difficulty tiers**: RECRUIT / STANDARD / HARD / VETERAN — AI awareness,
  reaction, search pressure and player armor (75/50/35/25) scale; VETERAN
  disables checkpoints. No bullet sponges at any tier.
* **Unlock chain**: the four founding operations stay open; expansion
  operations unlock by completing the previous one (shown as locks in MENUS →
  MISSIONS with the requirement named).
* **Alert chip**: minimal HUD readout of squad state (UNAWARE → SUSPICIOUS →
  INVESTIGATING → SEARCHING → COMBAT → RECOVERING).

Tested headless end-to-end: Stage B suite **40/40** (all six new missions
played start-to-finish, NPC escort physics, generator→door chain, survive-wave
countdowns, legacy facility regression, day/night toggle) and meta smoke
**8/8** (badges, rank chip, difficulty persistence, debrief XP/medals, stats &
intel screens, REDEPLOY).

---

## 5c. THE MAJOR GAMEPLAY EXPANSION (Stage C) — tactical map, vehicles, arsenal, missions

Everything below was integrated into the existing codebase — no systems were
removed, and campaign saves from earlier versions stay compatible.

### Live tactical map — `js/tacmap.js` (new module)
A lightweight **2D canvas overlay** (`M`), not a second 3D world. It reads from a
single centralized mission/map state maintained by the mission engine:
* markers for player (position + facing cone), current/optional objectives,
  extraction point, mission vehicles, friendlies/NPCs, interactables and
  discovered intel — each with a distinct symbol and colour;
* **detection-gated enemy markers**: only KNOWN contacts appear, at approximate
  positions that update while the contact is observed and go stale/degrade when
  lost (KNOWN vs LIVE information distinction);
* **fog of war**: unexplored ground is dimmed; exploration permanently reveals
  terrain, but enemy information always expires;
* mouse-wheel **zoom** (player-centred), **player-up / north-up rotation**, and a
  **route selector** (PRIMARY → OPTIONAL → EXTRACTION) that draws a minimal
  tactical route line — no floating GPS arrow;
* live **HUD mini-map** with size / opacity / rotation settings;
* smoke grenades obscure map vision the same way they obscure AI vision.

### Vehicles — `js/vehicles.js` (new module)
Five original fictional designs: **SUV, utility truck, armored transport (APC),
pickup, tactical car**. Arcade-but-believable physics: per-type acceleration,
braking, steering, turn radius, mass, friction, terrain drag, suspension visuals
and wheel rotation; collision against world colliders (never through buildings —
vehicles use the same collision layers as the player plus a footprint query).
* board / exit with `F` (exit placement is probed so the player is never stuck);
* third-person chase cam (obstruction-aware) plus first-person driver cam (`C`);
* damage states NORMAL → DAMAGED → SEVERELY DAMAGED → DISABLED with smoke,
  sparks, performance loss; destruction force-exits the driver;
* AI vehicles follow predefined routes (escort convoy, patrol, civilian, parked);
* trunks act as weapon storage (interactables), synced to vehicle position;
* driving is tracked in stats (`driveDist`) and on the tactical map (the player
  marker becomes the vehicle marker).

### Arsenal & carryables — `js/throwables.js`, `js/loadout.js` (new modules), `js/weapons.js`
Eleven fictional weapons with distinct identities (fire rate, recoil, mag size,
reload, accuracy, weight, sound, spread/pellets): sidearms PX-9 / ST-12 /
Vektor P, shotgun VX-12, SMGs MPX-5 / CR-9, rifles VX-4 / RK-4 / SZ-8, precision
MR-7 / LB-9 — all gameplay-only, no real-world references.
* universal **throwable framework**: VX-FRAG (arc, fuse, radius, falloff),
  smoke, flashbang, decoy, signal flare, tactical sensor, medkit, plus a remote
  **breach charge** (place → activate → scripted effect → mission update);
* `G` equips throwables, left mouse throws, right mouse is the alt-use
  (detonator for the breach charge);
* hold-`Q` **equipment wheel** (PRIMARY / SECONDARY / THROWABLE / UTILITY /
  MISSION) with mouse selection;
* **pre-mission loadout configuration** on the theater-select screen with
  validity rules (no incompatible combinations);
* **weapon pickups and supply crates** on every map (`F` hold to search; some
  crates are empty); ammo HUD shows mag / reserve / **Σ total** and throwable +
  utility counts.

### Seven new operations (total: 17 missions)
* **CONVOY RUN** (rural, night) — reach the convoy, board the transport, drive
  the route, extract. *vehicle mission*
* **EXTRACTION RUN** (desert) — locate and drive the APC to the pickup. *vehicle*
* **RECOVERY** (snow) — salvage equipment from a wrecked SUV under weather. *vehicle*
* **ESCORT** (urban) — protect a manned truck along its route; destruction fails
  the mission; sustained alert causes scripted attrition. *vehicle*
* **NIGHT TRANSIT** (industrial) — stay inside the fence line, drive to the far
  gate, extract on foot. *vehicle*
* **CLOSE QUARTERS** (urban) — methodical room-clearing operation, stealth viable.
* **THE ARCHIVE** (facility) — breach charge entry, reach the terminal, extract.
The mission sequencer gained `board`, `drive` and `escort_veh` step kinds, a
per-mission `setup(g)` hook, and checkpoint-safe vehicle stages.

### New awards (total: 17 medals)
ROAD MASTER (drive ≥900 m), NAVIGATOR (drive + use the map), EXPLORER, TACTICIAN
(no alarm + ≥3 equipment categories used), FIELD OPERATOR (vehicle + throwable +
fog), DRIVER (vehicle mission, never abandoned), RECON SPECIALIST — alongside
the original twelve.

### Module layout additions
`js/tacmap.js`, `js/vehicles.js`, `js/throwables.js`, `js/loadout.js`;
map/vehicle/weapon/mission data stays inside `world.js`, `weapons.js` and
`missions.js` respectively. Pooled projectiles, instanced map rendering and LOD
kept the frame budget intact; the tactical map is a single 2D canvas.

### Acceptance testing
Every system has an automated headless suite (puppeteer, run against the dev
server): tactical map 13 checks, vehicles 15, arsenal/throwables/loadout 20,
missions/awards 11, cross-version regression 9, and the **16-step player
journey** 17 checks — 85/85 passing at release.

---

## 5d. STAGE D — RESPONSIVE, MOBILE, TABLET, TOUCH & MISSION OVERHAUL (v2.2)

The existing game (all Stage A/B/C systems intact) was made fully playable on
phones and tablets without rebuilding anything: one shared input architecture,
one mission system, one weapon system — desktop and touch produce the same
commands.

### Responsive design system (`style.css`)
- Fluid sizing via `clamp()`/viewport units + a full media-query ladder
  (≤480 phone, ≤900 tablet, landscape-phone, ≥1600 desktop-wide).
- `env(safe-area-inset-*)` padding on HUD corners, touch layer and bottom nav —
  notches and home indicators never cover controls.
- Every screen tested 320×568 … 1920×1080 (12 viewports × 10 screens): no
  horizontal overflow, no clipped/unreachable/overlapping/tiny-touch-target
  elements. Main menu: desktop keeps the cinematic layout, tablet condenses to a
  two-column grid, phones get a single scroll-free vertical stack + fixed bottom
  nav (HOME / MISSIONS / LOADOUT / INTEL / SETTINGS).
- All interactive targets ≥44×44 px; primary buttons larger.

### Portrait / rotation
- `#rotate-overlay` ("ROTATE DEVICE — LANDSCAPE RECOMMENDED") appears on phones
  in portrait during gameplay; the app never breaks in portrait (menus stay
  usable, HUD reflows). Orientation/resize/visualViewport changes recompute
  camera aspect, HUD, joysticks and map in-place — mission state survives.
- FULLSCREEN button in the menu + pause; degrades to a toast where unsupported.

### Touch controls (`js/touch.js` — new module)
- Left virtual joystick (movement, dead-zone, multitouch, return-to-center) on a
  dedicated left zone; right zone is a full-surface look/aim drag (no pointer
  lock needed). Zones are separate DOM surfaces so look drags never leak into
  buttons.
- Buttons: FIRE (hold = auto for automatics, tap = semi), AIM (hold or toggle,
  setting), RELOAD, JUMP, CROUCH (toggle), SPRINT (hold), GEAR (hold → weapon
  wheel, drag, release), MAP, PAUSE, contextual INTERACT (appears only when an
  interactable is targeted — prompt text mirrored on the button; shows
  "EXIT VEHICLE" while driving).
- Hybrid safety: compat mouse events after a touch are ignored (nothing
  double-fires); all `preventDefault` calls are `cancelable`-guarded.
- Weapon wheel on touch: hold GEAR → radial PRIMARY/SECONDARY/THROWABLE/UTILITY
  → drag → release selects. Verified in combat conditions by test.
- Haptics (throttled, `navigator.vibrate`, toggleable): shot, hit, damage,
  collision, objective, pickup, mission complete.

### Pickups & inventory limits (§19–21)
- Touch pickup card: WEAPON FOUND / name / class / mag / stock / CURRENT weapon
  summary + PICK UP or **SWAP** (when it would displace a slot occupant) or
  TAKE AMMO. Desktop shows the same data via the interaction prompt.
- Strict slots: one PRIMARY + one SECONDARY. Swapping **drops the displaced
  weapon** from the owned set — no unlimited arsenal.

### Unified input (`js/input.js` + `js/touch.js`)
TouchControls writes into the same `input` state object the keyboard/mouse use
(moveF/moveR/lookX/lookY/fire/aim/sprint/crouch/interact/wheel…), so gameplay
code is identical on every device. Desktop keeps pointer lock; touch never
requires it. Touch claims (e.g. sprint) only write while active, never fight
the keyboard.

### Responsive tactical map (gestures)
- Phone/tablet: near-fullscreen map canvas. PINCH zoom, TWO-FINGER pan, TAP a
  marker → details panel; TAP objective → distance/bearing; empty tap recenters;
  CLOSE button. `touch-action: none` isolates map gestures from FPS controls.
- North-up mode makes the projection deterministic; rotate-mode inverses pan
  correctly.

### Mission system overhaul (`js/missions.js`, `js/ui.js`, `index.html`)
- **Briefing screen** before every mission: name, LOCATION, TIME, WEATHER, TYPE,
  briefing text, PRIMARY + OPTIONAL objectives, REWARD, LOADOUT summary, START —
  fully readable on a 320 px phone.
- Current objective is always obvious: HUD shows objective + live `<dist> m ·
  <DIR> · [M] MAP`; sequential objectives reveal one at a time with
  "OBJECTIVE COMPLETE → NEW OBJECTIVE" non-blocking toasts (queued, so the
  second line never eats the first).
- Pause menu: OBJECTIVES panel (✓ done / ▶ current / ◇ next + distance) and
  EQUIPMENT panel (PRIMARY/SECONDARY/THROWABLE/UTILITY + ammo) on all devices.
- Mission browser: rich cards (difficulty, type, location, status, best time,
  intel, reward, lock state) with 10 category chips (ALL/CAMPAIGN/RECON/
  RECOVERY/INFILTRATION/ESCORT/EXTRACTION/DEFENSE/VEHICLE/CHALLENGE).
- Debrief: objectives ✓, performance (time/accuracy/damage/alerts/intel),
  awards, XP, unlocks — unchanged flow, reflowed for small screens.
- Subtitles mirror [COMMS]/[BRIEF]/objective lines (toggleable).

### Performance & device detection
- `game.device` = capability-based (coarse pointer + touch counts + UA hints):
  desktop / touch-laptop / tablet / phone. Touch ≠ phone.
- LOW/MEDIUM/HIGH presets + one-shot PERFORMANCE MODE suggestion on weak
  devices (menu-only, auto-dismisses after 12 s, never blocks anything).
  LOW cuts pixel ratio, shadows, particles, view distance and post effects.
- Touch settings: controls on/off, joystick size/opacity, look/aim sensitivity,
  button size/opacity, invert-Y, auto-sprint, auto-fire, aim mode (hold/toggle),
  aim assist OFF/LOW/MED/HIGH (subtle magnetic pull only while aiming),
  vibration, HUD scale.
- Accessibility: large text, high contrast, reduced motion (CSS + shake scale),
  shape-based (color-independent) objective markers, subtitles, HUD scale.
- Auto-suggest reload: dry magazine pulses the RELOAD button + one-shot toast.

### Acceptance testing (Stage D)
Four headless puppeteer suites, all green at release (52 checks):
`resp1` 13 (12-viewport × 10-screen matrix), `touch1` 18 (real CDP touch events:
nav → briefing → start, joystick movement/look, fire/aim/reload/jump/crouch/
sprint/interact, gear wheel, map pinch/pan/tap, pause, pickup SWAP with slot
verification, vehicle board/drive/exit by touch, rotation overlay, zero console
errors), `mission2` 12 (briefing content, objective HUD, toast sequence,
panels, categories, subtitles, fullscreen fallback, perf suggestion, resize
state-keeping, debrief), `regress2` 9 (desktop keyboard/mouse parity, nine maps
build clean, convoy E2E, checkpoint restart, white mode, save persistence).

---

## 6. Debugging

`window.OBV` exposes the live game (`OBV.game` internals: `state`, `player`,
`weapons`, `enemies`, `world`, `physics`, `missions`, `particles`, `audio`, `ui`,
`settings`, `renderer`, `scene`, `camera`) for console inspection and tuning.

---

## 7. Deploying to Vercel

The game is a zero-build static site, so Vercel hosts it as-is (`vercel.json`
included: no framework, no build step, static output, sensible cache headers).

Any of these three ways works:

1. **CLI:** unzip, then inside the folder run `npm i -g vercel && vercel deploy --prod`
   (first run asks for a project name; accept the defaults — build command *none*,
   output directory *root*).
2. **Dashboard:** go to `vercel.new`, choose *Add New… → Project*, import a Git
   repository containing this folder; Vercel auto-detects "Other" (static) and
   deploys on push.
3. **Drag & drop:** `vercel.com/new/deploy` (or the *Deployments → Add New → Folder*
   flow in the dashboard) and drop the unzipped folder.

The deployment URL then serves `index.html` at `/` — click CAMPAIGN and play.
Pointer Lock and Web Audio work normally on Vercel's HTTPS origin.
