/**
 * missions.js
 * Objective / stage system, checkpoints and mission flow.
 *
 * Facility mission flow:
 *   approach → enter → locate (hack terminal) → escape (alarm response)
 *   → extract (reach the LZ) → complete
 * A silent-alarm lockdown timer runs from the moment the download finishes;
 * failing to extract in time fails the mission.
 *
 * Checkpoints are written to localStorage at every stage transition together
 * with a player snapshot (position, health, ammo) so death can roll the run
 * back without reloading the world.
 */

import * as THREE from 'three';

const CP_KEY = 'obv_checkpoint_v1';

const _seqV = new THREE.Vector3();
const _seqV2 = new THREE.Vector3();

export const STAGE_INFO = {
  approach: {
    text: 'INFILTRATE THE FACILITY',
    sub: 'Move to the cut in the fence line — south perimeter',
  },
  enter: {
    text: 'ENTER THE MAIN WAREHOUSE',
    sub: 'Get inside the facility — main roll-up entrance or side door',
  },
  locate: {
    text: 'LOCATE THE TARGET DATA',
    sub: 'Search the office wing — look for a server room, upper floor',
  },
  escape: {
    text: 'SURVIVE THE RESPONSE',
    sub: 'The download tripped a silent alarm — push through to the loading bay',
  },
  extract: {
    text: 'REACH EXTRACTION',
    sub: 'LZ marked with green lights — south-west yard',
  },
  complete: { text: 'MISSION COMPLETE', sub: '' },
};

export const MISSION_DEFS = {
  facility: {
    map: 'facility', flow: 'infil', title: 'KESTREL YARD', tag: 'NIGHT · INFILTRATION',
    type: 'infiltration', parTime: 420, objectivesTotal: 5, optionals: ['ghost', 'intel', 'par'],
    stages: STAGE_INFO,
    toasts: { breach: 'INFILTRATION POINT REACHED', enter: 'INSIDE THE FACILITY', dock: 'LOADING BAY REACHED' },
    rally: [15, -34], surge: [4, 6], lockdown: 360,
  },
  snow: {
    map: 'snow', flow: 'assault', title: 'WHITEOUT RELAY', tag: 'SNOW · ASSAULT',
    type: 'assault', parTime: 480, objectivesTotal: 3, optionals: ['intel', 'light', 'par'],
    stages: {
      approach: { text: 'BREACH THE RELAY PERIMETER', sub: 'Snow line south — the gate stands open, move quietly' },
      clear: { text: 'CLEAR THE COMPOUND', sub: 'Eliminate every hostile — relay building, fuel tanks, mast' },
      extract: { text: 'REACH THE HELIPAD LZ', sub: 'West pad, green beacons — the bird is inbound' },
      complete: { text: 'MISSION COMPLETE', sub: '' },
    },
    toasts: { breach: 'PERIMETER BREACHED — THEY KNOW', enter: 'COMPOUND ALERT' },
    rally: [0, -8], surge: [3, 5], lockdown: 0,
  },
  desert: {
    map: 'desert', flow: 'infil', title: 'DUSTBOWL CACHE', tag: 'NIGHT · INFILTRATION',
    type: 'infiltration', parTime: 400, objectivesTotal: 5, optionals: ['ghost', 'intel', 'par', 'marksman'],
    stages: {
      approach: { text: 'APPROACH THE COMPOUND', sub: 'Adobe wall gate, south side — watch the watchtower' },
      enter: { text: 'ENTER THE COMPOUND', sub: 'Inside the wall — keep between the buildings' },
      locate: { text: 'DOWNLOAD THE CACHE MANIFEST', sub: 'Cache house interior — terminal in the west room' },
      escape: { text: 'PUSH TO THE NORTH GAP', sub: 'The download tripped the alarm — move before they converge' },
      extract: { text: 'REACH EXTRACTION', sub: 'North-east wadi — green beacons' },
      complete: { text: 'MISSION COMPLETE', sub: '' },
    },
    toasts: { breach: 'GATE REACHED', enter: 'INSIDE THE COMPOUND', dock: 'NORTH GAP REACHED' },
    rally: [-6, -10], surge: [4, 6], lockdown: 300,
  },
  urban: {
    map: 'urban', flow: 'infil', title: 'GREYLINE DISTRICT', tag: 'NIGHT · INFILTRATION',
    type: 'infiltration', parTime: 420, objectivesTotal: 5, optionals: ['ghost', 'intel', 'light'],
    stages: {
      approach: { text: 'PASS THE WEST CHECKPOINT', sub: 'Sandbagged checkpoint on the street — through or around' },
      enter: { text: 'ENTER THE BANK', sub: 'Ground floor — double doors off the north sidewalk' },
      locate: { text: 'DOWNLOAD THE RECORD ARCHIVE', sub: 'Record room, back west corner of the bank' },
      escape: { text: 'CROSS THE ALLEY', sub: 'Alarm is live — cut between the bank and the apartments' },
      extract: { text: 'REACH EXTRACTION', sub: 'Service yard behind the shop row — green beacons' },
      complete: { text: 'MISSION COMPLETE', sub: '' },
    },
    toasts: { breach: 'CHECKPOINT CLEARED', enter: 'INSIDE THE BANK', dock: 'ALLEY TRAVERSED' },
    rally: [-14, -12], surge: [4, 6], lockdown: 330,
  },
  // ---- expansion operations (generic multi-stage engine) ----
  recon_desert: {
    map: 'desert', flow: 'seq', title: 'SANDGLASS RECON', tag: 'DESERT · RECON',
    type: 'recon', parTime: 420, objectivesTotal: 6, optionals: ['ghost', 'intel', 'par'],
    seq: [
      { id: 'reach_w', kind: 'reach', pos: [-24, 30], r: 3, text: 'REACH WESTERN OVERWATCH', sub: 'Rock shelf west of the gate — stay off the road' },
      { id: 'obs_a', kind: 'interact', target: 'obs_a', text: 'GLASS THE COMPOUND — WEST', sub: 'Hold F at the observation post' },
      { id: 'reach_e', kind: 'reach', pos: [24, 30], r: 3, text: 'REACH EASTERN OVERWATCH', sub: 'Mirror position east of the wall' },
      { id: 'obs_b', kind: 'interact', target: 'obs_b', text: 'GLASS THE COMPOUND — EAST', sub: 'Hold F at the observation post' },
      { id: 'obs_c', kind: 'interact', target: 'obs_c', text: 'GLASS THE CACHE HOUSE', sub: 'North ridge post — inside the wall, move quiet' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'North-east wadi — green beacons' },
    ],
  },
  sabotage_industrial: {
    map: 'industrial', flow: 'seq', title: 'COLD FORGE', tag: 'INDUSTRIAL · SABOTAGE',
    type: 'sabotage', parTime: 560, objectivesTotal: 7, optionals: ['intel', 'par', 'marksman'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'REACH THE WORKS PERIMETER', sub: 'South fence — main gate, east cut, or the service culvert' },
      { id: 'power', kind: 'interact', target: 'generator', text: 'RESTORE AUXILIARY POWER', sub: 'Generator yard, east side — it unlocks the security door' },
      { id: 'enter_forge', kind: 'reach', pos: [0, -24], r: 6, text: 'ENTER THE FORGE HALL', sub: 'Through the security door — north hall' },
      { id: 'c1', kind: 'interact', target: 'charge_1', text: 'PLANT CHARGE — COOLANT LINE', sub: 'Coolant manifold, east side of the hall', alarmOnDone: true, surge: [3, 1] },
      { id: 'c2', kind: 'interact', target: 'charge_2', text: 'PLANT CHARGE — PRESS FEED', sub: 'Hydraulic press, west bay' },
      { id: 'c3', kind: 'interact', target: 'charge_3', text: 'PLANT CHARGE — FURNACE BUS', sub: 'Main furnace bus bar — this brings the works down' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'South-west field beyond the fence — green beacons' },
    ],
  },
  investigate_rural: {
    map: 'rural', flow: 'seq', title: 'QUIET HARVEST', tag: 'OUTSKIRTS · INVESTIGATION',
    type: 'investigation', parTime: 480, objectivesTotal: 4, optionals: ['ghost', 'intel', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'REACH THE FARM ROAD', sub: 'Follow the dirt road north from the tree line' },
      { id: 'ev', kind: 'collect', n: 3, text: 'EXAMINE THE EVIDENCE', sub: 'Three markers: burned truck, village well, shack porch' },
      { id: 'radio', kind: 'interact', target: 'radio_records', text: 'PULL THE FREQUENCY RECORDS', sub: 'Radio shack console north of the village' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'South road bend — green beacons' },
    ],
  },
  rescue_rural: {
    map: 'rural', flow: 'seq', title: 'LOST SHEPHERD', tag: 'OUTSKIRTS · RESCUE',
    type: 'rescue', parTime: 560, objectivesTotal: 4, optionals: ['light', 'intel', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'REACH THE VILLAGE', sub: 'Four houses off the farm road — the shepherd is hiding in one' },
      { id: 'contact', kind: 'interact', target: 'npc_contact', text: 'LOCATE THE SURVIVOR', sub: 'Speak to the shepherd — he moves once you make contact' },
      { id: 'escort', kind: 'escort', text: 'ESCORT HIM TO EXTRACTION', sub: 'Walk him to the south road bend — keep him close' },
      { id: 'extract', kind: 'extract', text: 'CONFIRM EXTRACTION', sub: 'Stand on the LZ with the survivor secured' },
    ],
  },
  defense_urban: {
    map: 'urban', flow: 'seq', title: 'NIGHT WATCH', tag: 'CITY · DEFENSE',
    type: 'defense', parTime: 600, objectivesTotal: 4, optionals: ['light', 'marksman', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'REACH THE BANK APPROACH', sub: 'Past the west checkpoint — get to the bank' },
      { id: 'hold_pos', kind: 'reach', pos: [-14, -12], r: 6, text: 'HOLD THE RECORD ROOM', sub: 'Defend the archive terminal inside the bank' },
      { id: 'survive', kind: 'survive', t: 150, waves: [[15, 2, 1], [60, 3, 1], [105, 3, 2]], text: 'DEFEND FOR 150 SECONDS', sub: 'Waves inbound from the street — use doors and pillars' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'Service yard behind the shop row — green beacons' },
    ],
  },
  // ---- C4: vehicle operations + weapon-focused operations ----
  convoy_rural: {
    map: 'rural', flow: 'seq', title: 'CONVOY RUN', tag: 'OUTSKIRTS · TRANSPORT',
    type: 'transport', vehicle: true, parTime: 540, objectivesTotal: 4, optionals: ['intel', 'par'],
    seq: [
      { id: 'reach_farm', kind: 'reach', pos: [-6, -20], r: 8, text: 'REACH THE FARM YARD', sub: 'The hauler is parked between the barn and the shed' },
      { id: 'board', kind: 'board', veh: 'farm_pickup', text: 'BOARD THE HAULER', sub: 'Keys are in it — hold F at the driver door' },
      { id: 'deliver', kind: 'drive', veh: 'farm_pickup', pos: [2, 44], r: 10, text: 'RUN THE SUPPLY ROUTE', sub: 'South down the farm road to the crossroads drop — stay in the truck' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'South road bend — green beacons' },
    ],
  },
  extract_desert: {
    map: 'desert', flow: 'seq', title: 'ARMORED EXTRACTION', tag: 'DESERT · VEHICLE',
    type: 'transport', vehicle: true, parTime: 480, objectivesTotal: 3, optionals: ['ghost', 'par'],
    seq: [
      { id: 'reach_lz', kind: 'reach', pos: [24, 32], r: 10, text: 'REACH THE CACHE LZ', sub: 'The Bulwark is parked at the north-east wadi beacons' },
      { id: 'board', kind: 'board', veh: 'extract_apc', text: 'BOARD THE BULWARK', sub: 'Armored transport — hold F at the driver hatch' },
      { id: 'rally', kind: 'drive', veh: 'extract_apc', pos: [46, 52], r: 12, text: 'DRIVE TO THE RALLY POINT', sub: 'South-east corner of the basin — take the open ground' },
    ],
  },
  recovery_snow: {
    map: 'snow', flow: 'seq', title: 'COLD RECOVERY', tag: 'SNOW · RECOVERY',
    type: 'recovery', vehicle: true, parTime: 480, objectivesTotal: 4, optionals: ['intel', 'par'],
    seq: [
      { id: 'reach_wreck', kind: 'reach', pos: [12, -14], r: 6, text: 'LOCATE THE ABANDONED SCOUT', sub: 'East treeline — the SV-2 went down short of the relay' },
      { id: 'board', kind: 'board', veh: 'snow_wreck', text: 'GET IT MOVING', sub: 'She is badly hurt — baby the throttle. Hold F to climb in' },
      { id: 'recover', kind: 'drive', veh: 'snow_wreck', pos: [-26, 12], r: 10, text: 'RECOVER THE SCOUT TO BASE', sub: 'Back to the west helipad — do not lose her en route' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'Step out and confirm on the pad' },
    ],
  },
  escort_urban: {
    map: 'urban', flow: 'seq', title: 'SUPPLY ESCORT', tag: 'CITY · ESCORT',
    type: 'escort', vehicle: true, parTime: 600, objectivesTotal: 3, optionals: ['marksman', 'par'],
    setup: (g) => {
      const v = g.vehicles.byTag('escort_truck');
      if (!v) return;
      const V3 = v.pos.constructor;
      v.route = [new V3(-8, 0, 9.5), new V3(24, 0, 9.5), new V3(44, 0, 9.5)];
      v.driver = null;            // waits for the player to reach it (escort step starts the engine)
      v.routeIdx = 0;
      v.heading = -Math.PI / 2;
      v.hp = v.def.hp;
    },
    seq: [
      { id: 'reach_truck', kind: 'reach', pos: [-44, 9.5], r: 8, text: 'REACH THE SUPPLY TRUCK', sub: 'West end of the street — the driver waits for your signal' },
      { id: 'escort', kind: 'escort_veh', veh: 'escort_truck', pos: [44, 9.5], r: 8, text: 'ESCORT THE TRUCK EAST', sub: 'It rolls the street to the east checkpoint — keep hostiles off it' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'Service yard behind the shop row — green beacons' },
    ],
  },
  transit_industrial: {
    map: 'industrial', flow: 'seq', title: 'NIGHT TRANSIT', tag: 'INDUSTRIAL · NIGHT DRIVE',
    type: 'transport', vehicle: true, parTime: 540, objectivesTotal: 5, optionals: ['ghost', 'intel', 'par'],
    seq: [
      { id: 'reach_yard', kind: 'reach', pos: [4, 34], r: 8, text: 'REACH THE SOUTH APRON', sub: 'The utility truck is loaded and parked on the apron' },
      { id: 'board', kind: 'board', veh: 'transit_truck', text: 'BOARD THE UT-6', sub: 'Hold F at the driver door — lights off, engine quiet' },
      { id: 'yard', kind: 'drive', veh: 'transit_truck', pos: [-18, 38], r: 10, text: 'CROSS THE YARD', sub: 'West along the apron toward the container line' },
      { id: 'park', kind: 'drive', veh: 'transit_truck', pos: [-38, 46], r: 12, text: 'PARK AT THE WEST STOCK YARD', sub: 'Kill the engine near the beacon stack' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION ON FOOT', sub: 'Through the fence cut to the south-west field — green beacons' },
    ],
  },
  cq_urban: {
    map: 'urban', flow: 'seq', title: 'HARD ENTRY', tag: 'CITY · CLOSE QUARTERS',
    type: 'assault', parTime: 540, objectivesTotal: 4, optionals: ['marksman', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'REACH THE BANK APPROACH', sub: 'Past the west checkpoint — the squad is holed up in the bank' },
      { id: 'clear', kind: 'eliminate', text: 'CLEAR THE HOSTILE SQUAD', sub: 'Every hostile in the district — street posts and bank floor' },
      { id: 'records', kind: 'reach', pos: [-14, -12], r: 4, text: 'SECURE THE RECORD ROOM', sub: 'Back west corner of the bank — confirm the archive is intact' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'Service yard behind the shop row — green beacons' },
    ],
  },
  archive_facility: {
    map: 'facility', flow: 'seq', title: 'ARCHIVE RETRIEVAL', tag: 'NIGHT · STEALTH',
    type: 'recon', parTime: 480, objectivesTotal: 4, optionals: ['ghost', 'intel', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', trig: 'breach', text: 'SLIP INSIDE THE PERIMETER', sub: 'South fence cut — no shots unless you must' },
      { id: 'enter', kind: 'reach', trig: 'enter', text: 'ENTER THE WAREHOUSE', sub: 'Main roll-up or side door — the office wing is beyond' },
      { id: 'archive', kind: 'interact', target: 'terminal', text: 'PULL THE ARCHIVE', sub: 'Server room terminal, upper floor — hold F to download' },
      { id: 'extract', kind: 'extract', text: 'REACH EXTRACTION', sub: 'South-west yard — green beacons' },
    ],
  },
  hold_snow: {
    map: 'snow', flow: 'seq', title: 'LAST LIGHT', tag: 'SNOW · EXTRACTION',
    type: 'extraction', parTime: 420, objectivesTotal: 3, optionals: ['light', 'par'],
    seq: [
      { id: 'reach', kind: 'reach', pos: [-26, 12], r: 6, text: 'REACH THE HELIPAD', sub: 'West pad — the bird is inbound, not here yet' },
      { id: 'survive', kind: 'survive', t: 120, waves: [[10, 3, 1], [55, 3, 2], [95, 4, 1]], text: 'HOLD UNTIL THE BIRD LANDS', sub: 'Survive 120 seconds on the pad' },
      { id: 'extract', kind: 'extract', text: 'BOARD THE HELICOPTER', sub: 'Step onto the lit pad' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Briefing metadata (Stage D): category, location, insertion time, weather and
// reward lines shown on the pre-deploy briefing screen and the mission browser.
// Merged into MISSION_DEFS so the mission engine itself stays untouched.
// ---------------------------------------------------------------------------
export const BRIEF_META = {
  facility:        { cat: 'CAMPAIGN',      loc: 'KESTREL YARD — LOGISTICS COMPOUND',  time: '0210 HRS', wx: 'OVERCAST, DRY',      reward: 'XP · CAMPAIGN PROGRESSION · INTEL ARCHIVE' },
  desert:          { cat: 'CAMPAIGN',      loc: 'DUSTBOWL CACHE — DRY WADI',          time: '1640 HRS', wx: 'CLEAR, HIGH WIND',   reward: 'XP · CAMPAIGN PROGRESSION · INTEL ARCHIVE' },
  urban:           { cat: 'CAMPAIGN',      loc: 'GREYLINE DISTRICT — CITY BLOCK 7',   time: '2235 HRS', wx: 'LIGHT RAIN',         reward: 'XP · CAMPAIGN PROGRESSION · INTEL ARCHIVE' },
  snow:            { cat: 'CAMPAIGN',      loc: 'WHITEOUT RELAY — RIDGE STATION',     time: '0450 HRS', wx: 'SNOWFALL, GUSTS',    reward: 'XP · CAMPAIGN PROGRESSION · INTEL ARCHIVE' },
  recon_desert:    { cat: 'RECON',         loc: 'SOUTHERN WADI APPROACHES',           time: '0510 HRS', wx: 'CLEAR, COLD NIGHT',  reward: 'XP · RECON SPECIALIST TRACKING · INTEL' },
  sabotage_industrial: { cat: 'INFILTRATION', loc: 'RAVEL WORKS — PROCESSING PLANT',  time: '2350 HRS', wx: 'FOG BANKS',          reward: 'XP · SABOTAGE RECORD · INTEL ARCHIVE' },
  investigate_rural:   { cat: 'RECON',     loc: 'HOLLOW FARMSTEAD — EAST FIELDS',     time: '0320 HRS', wx: 'MIST, CALM',         reward: 'XP · INVESTIGATION RECORD · INTEL' },
  rescue_rural:    { cat: 'EXTRACTION',    loc: 'MILL ROAD SAFEHOUSE',                time: '0140 HRS', wx: 'RAIN SHOWERS',       reward: 'XP · RESCUE RECORD · IRON WILL TRACKING' },
  defense_urban:   { cat: 'DEFENSE',       loc: 'GREYLINE — MARKET SQUARE',           time: '2115 HRS', wx: 'DRIZZLE',            reward: 'XP · DEFENSE RECORD · SURVIVOR TRACKING' },
  hold_snow:       { cat: 'DEFENSE',       loc: 'RELAY APPROACH — TREE LINE',         time: '0620 HRS', wx: 'BLOWING SNOW',       reward: 'XP · DEFENSE RECORD · IRON WILL TRACKING' },
  convoy_rural:    { cat: 'VEHICLE',       loc: 'COUNTY ROAD 9 — NIGHT CONVOY',       time: '2355 HRS', wx: 'CLEAR, COLD',        reward: 'XP · ROAD MASTER · DRIVER TRACKING' },
  extract_desert:  { cat: 'EXTRACTION',    loc: 'WADI FLOOR — APC RECOVERY POINT',    time: '1720 HRS', wx: 'DUST HAZE',          reward: 'XP · ROAD MASTER · FIELD OPERATOR TRACKING' },
  recovery_snow:   { cat: 'RECOVERY',      loc: 'RIDGE ROAD — WRECK SITE',            time: '0540 HRS', wx: 'SNOW, LOW VIS',      reward: 'XP · RECOVERY RECORD · NAVIGATOR TRACKING' },
  escort_urban:    { cat: 'ESCORT',        loc: 'GREYLINE — HARBOUR STREET',          time: '2205 HRS', wx: 'RAIN, WIND',         reward: 'XP · ESCORT RECORD · TACTICIAN TRACKING' },
  transit_industrial:  { cat: 'VEHICLE',   loc: 'RAVEL WORKS — FENCE LINE ROAD',      time: '0025 HRS', wx: 'FOG, CALM',          reward: 'XP · NAVIGATOR · DRIVER TRACKING' },
  cq_urban:        { cat: 'CHALLENGE',     loc: 'GREYLINE — ROW HOUSES 12-18',        time: '2320 HRS', wx: 'OVERCAST',           reward: 'XP · CQB RECORD · SHARPSHOOTER TRACKING' },
  archive_facility:{ cat: 'INFILTRATION',  loc: 'KESTREL YARD — ARCHIVE WING',        time: '0245 HRS', wx: 'OVERCAST, DRY',      reward: 'XP · ANALYST RECORD · INTEL ARCHIVE' },
};
export const BRIEF_TEXT = {
  facility: 'Slip past the fence line, reach the server wing and pull the target data from the communications terminal. Response teams will converge once the download starts — be gone before the yard locks down.',
  desert: 'A supply cache is buried in the wadi compound. Enter quiet, manifest the cache on the record room terminal, and walk out north-east before the timed response arrives.',
  urban: 'The Greyline bank keeps an off-book record room. Pass the checkpoint without drawing attention, crack the records, and vanish down the alley to extraction.',
  snow: 'The relay station above the tree line is broadcasting on a frequency it should not have. Breach loud, clear the compound, and reach the helipad for pickup.',
  recon_desert: 'A night walk through the southern wadi approaches. Observe, mark and record — you are eyes, not a hammer. Extraction is on foot.',
  sabotage_industrial: 'The Ravel Works processing plant feeds the whole operation. Get inside the fence, plant the charge on the process line, and leave before it speaks.',
  investigate_rural: 'Something is being stored at the Hollow farmstead. Search the buildings, recover what the evidence points to, and do not leave a footprint.',
  rescue_rural: 'A contact is pinned at the Mill Road safehouse. Reach them, bring them out alive, and get them to extraction. The clock is their health, not yours.',
  defense_urban: 'Hostile squads will push the market square in waves. Hold the ground, protect the position, and break their will to keep coming.',
  hold_snow: 'The relay approach must stay ours until dawn. Falling snow, limited visibility, repeated pushes — hold the tree line.',
  convoy_rural: 'A transport is waiting on County Road 9. Reach the convoy, take the wheel, and drive the route to the far extraction. Stay in the vehicle — the road is watched.',
  extract_desert: 'An APC is parked on the wadi floor. Find it, drive it out through the dust, and deliver it to the pickup point. Fuel and integrity are both finite.',
  recovery_snow: 'An SUV went down on the ridge road carrying equipment we need back. Reach the wreck, salvage the gear, and extract. The wreck is barely holding together.',
  escort_urban: 'A manned truck must reach the harbour street objective alive. Ride with it, keep the alert low, and keep it rolling — if the truck dies, the mission dies.',
  transit_industrial: 'Under fog cover, drive the fence line road from the near gate to the far gate. Stay inside the fence. Finish on foot at extraction.',
  cq_urban: 'Row houses 12 through 18 are occupied. Work through them room by room, close quarters, controlled force. Speed is optional; method is not.',
  archive_facility: 'The archive wing holds the paper trail. Breach the service door with a placed charge, reach the archive terminal, pull the record, and extract.',
};
for (const id of Object.keys(BRIEF_META)) {
  if (MISSION_DEFS[id]) Object.assign(MISSION_DEFS[id], BRIEF_META[id]);
}
for (const id of Object.keys(BRIEF_TEXT)) {
  if (MISSION_DEFS[id]) MISSION_DEFS[id].brief = BRIEF_TEXT[id];
}

export class MissionManager {
  constructor(game) {
    this.game = game;
    this.missionId = null;
    this.stage = null;
    this.smokeActive = false;
    this.lockdownTotal = 360;      // seconds from download to full lockdown
    this.lockdownLeft = 0;
    this.lockdownActive = false;
    this.checkpointData = null;
    this.hacking = false;
    this.seqIdx = 0;
    this._survT = 0;
  }

  get isSeq() { return !!(this.def && this.def.seq); }
  get seqStep() { return this.isSeq ? this.def.seq[this.seqIdx] : null; }
  /** True while the active step requires being in a vehicle (DRIVER medal logic). */
  get isDriveStepActive() {
    const s = this.seqStep;
    return !!s && (s.kind === 'drive' || s.kind === 'board' || s.kind === 'escort_veh');
  }

  get def() {
    return MISSION_DEFS[this.missionId] || MISSION_DEFS.facility;
  }

  /** World position of the CURRENT primary objective (HUD distance/bearing). */
  currentObjectivePos() {
    if (!this.missionId || this.missionId === 'range') return null;
    try {
      const targets = this.mapTargets();
      const obj = targets.find(t => t.kind === 'objective');
      if (obj) return obj.pos;
      const ex = targets.find(t => t.kind === 'extraction');
      return ex ? ex.pos : null;
    } catch (e) { return null; }
  }

  // -------------------------------------------------------------------------
  start(missionId, checkpoint = null) {
    this.missionId = missionId;
    this.lockdownTotal = (MISSION_DEFS[missionId] || MISSION_DEFS.facility).lockdown || 360;
    this.smokeActive = false;
    this.lockdownActive = false;
    this.hacking = false;

    if (missionId === 'range') {
      this.stage = 'range';
      this.game.ui.setObjective('WEAPONS TRAINING', 'Engage targets downrange · R reload · 1/2/3 weapons · F resupply');
      return;
    }

    if (this.isSeq) {
      for (const st of this.def.seq) if (st.waves) for (const wv of st.waves) wv.done = false;
      this._survT = 0;
      this.seqIdx = 0;
      if (checkpoint && checkpoint.stage) {
        const idx = this.def.seq.findIndex(s => s.id === checkpoint.stage);
        if (idx >= 0) this.seqIdx = idx;
      }
      const step = this.def.seq[this.seqIdx];
      this.stage = step.id;
      this.checkpointData = checkpoint;
      this.game.ui.setObjective(step.text, step.sub);
      return;
    }

    if (checkpoint && checkpoint.stage) {
      this.stage = checkpoint.stage;
      this.lockdownLeft = checkpoint.lockdownLeft ?? 0;
    if (this.lockdownActive && this.lockdownLeft <= 0) this.lockdownLeft = this.lockdownTotal;
      this.lockdownActive = this.stage === 'escape' || this.stage === 'extract';
      this.smokeActive = this.stage === 'extract';
      this.checkpointData = checkpoint;
      const info = this.def.stages[this.stage] || STAGE_INFO[this.stage] || STAGE_INFO.approach;
      this.game.ui.setObjective(info.text, info.sub);
      // re-arm world state implied by the stage
      if (this.stage === 'escape' || this.stage === 'extract') {
        this.game.world.terminalUsed = true;
        const it = this.game.world.interactables.find(i => i.id === 'terminal');
        if (it) it.used = true;
      }
      return;
    }

    this._goto('approach', true);
  }

  // -------------------------------------------------------------------------
  /** generic multi-stage engine (expansion missions) */
  _updateSeq(dt) {
    const g = this.game;
    const step = this.seqStep;
    if (!step) return;
    let done = false;
    switch (step.kind) {
      case 'reach':
        done = step.trig
          ? g.world.checkTrigger(step.trig, g.player.pos)
          : g.player.pos.distanceTo(_seqV.set(step.pos[0], 0, step.pos[1])) < (step.r || 4);
        break;
      case 'interact': {
        const it = g.world.interactables.find(i => i.id === step.target);
        done = !!(it && it.used);
        break;
      }
      case 'collect':
        done = g.world.evidenceCollected >= step.n;
        break;
      case 'eliminate':
        done = g.enemies.activeHostiles === 0;
        break;
      case 'survive': {
        this._survT += dt;
        g.ui.setLockdown(step.t - this._survT);
        for (const w of step.waves || []) {
          if (!w.done && this._survT >= w[0]) {
            w.done = true;
            g.enemies.queueSurge(w[1], w[2]);
            g.audio.alarm(g.player.pos.clone());
            g.ui.toast('WAVE INBOUND', 'HOSTILES CLOSING ON YOUR POSITION');
          }
        }
        done = this._survT >= step.t;
        break;
      }
      case 'escort':
        done = !!g.enemies.escortComplete;
        break;
      case 'board':
        done = !!g.vehicleMode && (!step.veh || g.vehicleMode.tag === step.veh);
        break;
      case 'drive': {
        if (!g.vehicleMode) break;                       // must stay behind the wheel
        if (step.veh && g.vehicleMode.tag !== step.veh) break;
        done = g.player.pos.distanceTo(_seqV.set(step.pos[0], 0, step.pos[1])) < (step.r || 8);
        break;
      }
      case 'escort_veh': {
        const v = g.vehicles.byTag(step.veh);
        if (!v) break;
        if (v.hp <= 0) { g.missionFailed('THE TRANSPORT WAS DESTROYED'); return; }
        if (!v.driver) {
          v.driver = 'ai';
          if (!v.route || !v.route.length) {
            const V3 = v.pos.constructor;
            v.route = [new V3(step.pos[0], 0, step.pos[1])];
          }
          v.routeIdx = 0;
          g.ui.toast('CONVOY MOVING', 'THE TRUCK IS ROLLING — KEEP IT ALIVE');
        }
        if (g.enemies.squadAlert > 0.4) {
          // scripted harassing fire on the transport while the district is hot
          v.damage(2.2 * dt, g, null);
          this._escortShotT = (this._escortShotT || 0) - dt;
          if (this._escortShotT <= 0) {
            this._escortShotT = 0.45 + Math.random() * 0.8;
            g.audio.gunshot('enemy_ar', v.pos.clone(), { gain: 0.45 });
          }
        }
        done = v.pos.distanceTo(_seqV.set(step.pos[0], 0, step.pos[1])) < (step.r || 8);
        break;
      }
      case 'extract':
        if (g.world.checkTrigger('extraction', g.player.pos)) { g.missionComplete(); return; }
        return;
      default:
        break;
    }
    if (done) {
      if (step.alarmOnDone) {
        g.audio.alarm(g.player.pos.clone());
        g.onAlarmRaised(true);
        g.enemies.queueSurge(step.surge ? step.surge[0] : 3, step.surge ? step.surge[1] : 1);
        g.ui.toast('ALERT', 'THE WORKS IS AWAKE — FINISH THE JOB');
      }
      this._seqAdvance();
    }
  }

  _seqAdvance() {
    const g = this.game;
    const steps = this.def.seq;
    g.ui.toast('OBJECTIVE COMPLETE', steps[this.seqIdx].text);
    g.audio.objectiveComplete();
    this.seqIdx++;
    if (this.seqIdx >= steps.length) { g.missionComplete(); return; }
    const nx = steps[this.seqIdx];
    this.stage = nx.id;
    g.ui.setObjective(nx.text, nx.sub);
    g.ui.toastQueued('NEW OBJECTIVE', nx.text, 2.8, 2500);
    this.saveCheckpoint();
  }

  _goto(stage, silent = false) {
    const prev = this.stage;
    this.stage = stage;
    const info = this.def.stages[stage] || STAGE_INFO[stage];
    if (!info) return;
    this.game.ui.setObjective(info.text, info.sub);
    if (!silent && prev && prev !== stage) {
      this.game.ui.toast('OBJECTIVE UPDATED', info.text);
      this.game.audio.objectiveComplete();
    }
    switch (stage) {
      case 'escape': this._beginResponse(); break;
      case 'extract': this.smokeActive = true; break;
      default: break;
    }
    // save AFTER stage side-effects so the checkpoint captures alarm state
    this.saveCheckpoint();
  }

  _beginResponse() {
    const g = this.game;
    const d = this.def;
    this.lockdownActive = true;
    this.lockdownLeft = this.lockdownTotal;
    g.audio.alarm(g.player.pos.clone());
    g.onAlarmRaised(true);
    // every surviving guard converges on the objective wing; reinforcements inbound
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      if (e.state === 'combat') continue; // already engaged keeps fighting
      e.lastKnown.set(d.rally[0], 0, d.rally[1]);
      e.lastKnownValid = true;
      e.state = 'investigate';
      e.stateT = 0;
    }
    g.enemies.queueSurge(d.surge[0], d.surge[1]);
    g.ui.toast('ALERT', 'HOSTILES ARE CONVERGING ON YOUR POSITION');
  }

  /** Assault flow: the breach is loud — the whole compound turns on you. */
  _beginAssault() {
    const g = this.game;
    const d = this.def;
    g.audio.alarm(g.player.pos.clone());
    g.onAlarmRaised(true);
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      e.lastKnown.copy(g.player.pos);
      e.lastKnownValid = true;
      if (e.state !== 'combat') { e.state = 'investigate'; e.stateT = 0; }
    }
    g.enemies.queueSurge(d.surge[0], d.surge[1]);
    g.ui.toast('ALERT', 'COMPOUND ALERT — HOSTILES CONVERGING');
  }

  // -------------------------------------------------------------------------
  /** live status of this mission's optional objectives */
  optionalStatus() {
    const g = this.game, def = this.def;
    const out = [];
    for (const k of def.optionals || []) {
      switch (k) {
        case 'ghost': out.push({ key: k, text: 'NO MAJOR ALERT', done: !g.stats.alarm }); break;
        case 'par': out.push({ key: k, text: `EXTRACT UNDER PAR TIME (${def.parTime}s)`, done: g.stats.missionTime <= (def.parTime || 1e9) }); break;
        case 'intel': {
          const total = g.progress.intelTotal(g.world.map);
          out.push({ key: k, text: 'RECOVER ALL INTEL (' + total + ')', done: total > 0 && g.progress.intelFoundOn(g.world.map) >= total });
          break;
        }
        case 'light': out.push({ key: k, text: 'MINIMAL DAMAGE (≤ 25)', done: g.stats.damageTaken <= 25 }); break;
        case 'marksman': out.push({ key: k, text: '4+ HEADSHOTS', done: g.stats.headshots >= 4 }); break;
        default: break;
      }
    }
    return out;
  }

  /** everything the awards system needs about the finished run */
  missionRunContext(extracted) {
    const g = this.game, def = this.def;
    const opts = this.optionalStatus();
    const type = def.type || 'infiltration';
    const quietTypes = ['infiltration', 'recon', 'recovery', 'investigation', 'search', 'sabotage'];
    return {
      missionId: this.missionId, type,
      quietTypes: quietTypes.includes(type),
      timeSec: g.stats.missionTime, parTime: def.parTime || 0,
      shots: g.stats.shots, hits: g.stats.hits, headshots: g.stats.headshots, kills: g.stats.kills,
      damageTaken: g.stats.damageTaken, alarm: g.stats.alarm,
      checkpointsUsed: g.stats.checkpointsUsed,
      intelFound: g.stats.intelRun, intelTotal: g.progress.intelTotal(g.world.map),
      intelComplete: g.progress.intelTotal(g.world.map) > 0 && g.progress.intelFoundOn(g.world.map) >= g.progress.intelTotal(g.world.map),
      optionalDone: opts.filter(o => o.done).length, optionalTotal: opts.length,
      objectivesDone: def.objectivesTotal || 1, objectivesTotal: def.objectivesTotal || 1,
      minHealth: g.stats.minHealth, finishedHealth: g.player.health,
      extracted: !!extracted, optionals: opts,
      mapOpens: g.stats.mapOpens || 0,
      fogPct: g.tacmap ? g.tacmap.fogPct : 0,
      usedVehicle: !!g.stats.usedVehicle,
      vehicleMission: !!def.vehicle,
      equipCats: Object.keys(g.stats.equipCats || {}).length,
      driverClean: !!g.stats.usedVehicle && !g.stats.vehicleAbandoned,
      driveDist: g.stats.driveDist || 0,
      throwablesUsed: g.stats.throwablesUsed || 0,
    };
  }

  /**
   * Centralised marker source for the tactical map. The map never hard-codes
   * positions — objectives, optionals and extraction all flow from here so
   * markers update automatically as the mission advances.
   */
  mapTargets() {
    const g = this.game, w = g.world;
    const out = [];
    if (!w || !this.missionId || this.missionId === 'range') return out;
    if (w.extractionPoint && w.extractionPoint.lengthSq() > 1) {
      out.push({ pos: w.extractionPoint.clone(), label: 'EXTRACTION', kind: 'extraction' });
    }
    if (this.isSeq) {
      const s = this.seqStep;
      if (s && s.kind !== 'extract') {
        let pos = null;
        if (s.pos) {
          pos = new THREE.Vector3(s.pos[0], 0, s.pos[1]);
        } else if (s.trig) {
          const t = w.triggers.find(t2 => t2.id === s.trig);
          if (t) pos = t.center ? t.center.clone() : t.min.clone().lerp(t.max, 0.5);
        } else if (s.kind === 'collect') {
          const ev = w.interactables.find(i => i.id.indexOf('evidence_') === 0 && !i.used);
          if (ev) pos = ev.pos.clone();
        } else if (s.kind === 'escort') {
          const n = g.enemies.escortNpc;
          if (n) pos = n.pos.clone();
        } else if (s.veh && g.vehicles) {
          const v = g.vehicles.byTag(s.veh);
          if (v) pos = v.pos.clone();
        } else if (s.target) {
          const it = w.interactables.find(i => i.id === s.target);
          if (it) pos = it.pos.clone();
          else if (g.vehicles) {
            const v = g.vehicles.byId(s.target);
            if (v) pos = v.pos.clone();
          }
        }
        if (pos) out.push({ pos, label: s.text, kind: 'objective' });
      }
    } else if (this.stage) {
      const t = this.compassTarget ? this.compassTarget() : null;
      if (t) {
        const info = (this.def.stages && this.def.stages[this.stage]) || STAGE_INFO[this.stage];
        out.push({ pos: t.clone(), label: (info && info.text) || 'OBJECTIVE', kind: 'objective' });
      }
    }
    for (const it of w.interactables) {
      if (!it.used && it.id.indexOf('intel_') === 0) {
        out.push({ pos: it.pos, label: 'INTEL', kind: 'optional' });
      }
    }
    return out;
  }

  /** world position the compass should point at for the current stage */
  compassTarget() {
    const w = this.game.world;
    if (!w) return null;
    if (this.isSeq) {
      const step = this.seqStep;
      if (!step) return w.extractionPoint;
      switch (step.kind) {
        case 'reach':
          if (step.pos) return _seqV2.set(step.pos[0], 0, step.pos[1]);
          return w.extractionPoint;
        case 'interact': {
          const it = w.interactables.find(i => i.id === step.target);
          return it ? it.pos : w.extractionPoint;
        }
        case 'extract': return w.extractionPoint;
        case 'escort': {
          const npc = this.game.enemies.escortNpc;
          return npc ? npc.pos : w.extractionPoint;
        }
        default: return w.extractionPoint;
      }
    }
    const s = this.stage;
    if (s === 'extract' || s === 'escape' || s === 'clear') return w.extractionPoint;
    if (w.terminalPos && w.terminalPos.lengthSq() > 0.01) return w.terminalPos;
    return w.extractionPoint;
  }

  update(dt) {
    if (this.missionId === 'range' || !this.stage) return;
    if (this.isSeq) { this._updateSeq(dt); return; }
    const g = this.game;
    const pos = g.player.pos;
    const t = this.def.toasts || {};

    // lockdown countdown
    if (this.lockdownActive) {
      this.lockdownLeft -= dt;
      g.ui.setLockdown(this.lockdownLeft);
      if (this.lockdownLeft <= 0) {
        this.lockdownActive = false;
        g.missionFailed('The facility entered full lockdown before you reached extraction.');
        return;
      }
      // second wave during the run to extraction
      if (this.stage === 'extract' && !this._wave2 && this.lockdownLeft < this.lockdownTotal - 50) {
        this._wave2 = true;
        g.enemies.queueSurge(2, 0);
      }
    }

    switch (this.stage) {
      case 'approach':
        if (g.world.checkTrigger('breach', pos)) {
          g.ui.toast('OBJECTIVE COMPLETE', t.breach || 'INFILTRATION POINT REACHED');
          if (this.def.flow === 'assault') { this._goto('clear'); this._beginAssault(); }
          else this._goto('enter');
        }
        break;
      case 'enter':
        if (g.world.checkTrigger('enter_facility', pos)) {
          g.ui.toast('OBJECTIVE COMPLETE', t.enter || 'INSIDE THE FACILITY');
          this._goto('locate');
        }
        break;
      case 'clear':
        if (g.enemies.activeHostiles === 0) {
          g.ui.toast('OBJECTIVE COMPLETE', 'AREA CLEARED');
          this._goto('extract');
        }
        break;
      case 'locate':
        // completion happens through onTerminalComplete()
        break;
      case 'escape':
        if (g.world.checkTrigger('dock', pos)) {
          g.ui.toast('OBJECTIVE COMPLETE', t.dock || 'LOADING BAY REACHED');
          this._goto('extract');
        }
        break;
      case 'extract':
        if (g.world.checkTrigger('extraction', pos)) {
          this.lockdownActive = false;
          g.missionComplete();
        }
        break;
      default: break;
    }
  }

  /** Called by the terminal interactable when the hold-to-hack completes. */
  onTerminalComplete() {
    const g = this.game;
    if (g.world.terminalUsed) return;
    g.world.terminalUsed = true;
    const it = g.world.interactables.find(i => i.id === 'terminal');
    if (it) it.used = true;
    g.audio.terminalBeep(g.world.terminalPos);
    g.stats.dataSecured = true;
    g.ui.toast('OBJECTIVE COMPLETE', 'TARGET DATA SECURED');
    if (this.isSeq) return;   // seq missions watch it.used themselves — no flow stages
    this._goto('escape');
  }

  // -------------------------------------------------------------------------
  saveCheckpoint() {
    if (this.missionId === 'range') return;
    const g = this.game;
    if (!g.progress.difficulty.checkpoints) return;   // veteran: one life per run
    const data = {
      mission: this.missionId,
      stage: this.stage,
      lockdownLeft: this.lockdownActive ? this.lockdownLeft : 0,
      player: g.player.snapshot(),
      throwables: g.throwables ? g.throwables.snapshotInv() : null,
      kills: g.enemies.kills,
      time: g.stats.missionTime,
    };
    this.checkpointData = data;
    try {
      localStorage.setItem(CP_KEY, JSON.stringify(data));
    } catch (e) { /* storage may be unavailable — checkpoint stays in memory */ }
  }

  static loadStoredCheckpoint() {
    try {
      const raw = localStorage.getItem(CP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  static clearStoredCheckpoint() {
    try { localStorage.removeItem(CP_KEY); } catch (e) { /* ignore */ }
  }

  get hasCheckpoint() {
    return !!(this.checkpointData || MissionManager.loadStoredCheckpoint());
  }
}
