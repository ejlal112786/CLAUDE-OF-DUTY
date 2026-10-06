/**
 * progress.js
 * Persistent meta-progression: XP / ranks, medals, lifetime statistics,
 * mission unlocks, intelligence archive, weapon finishes and difficulty
 * definitions. Everything persists to localStorage — no backend.
 */

const KEY = 'obv_progress_v1';

export const RANKS = [
  { name: 'RECRUIT', xp: 0 },
  { name: 'OPERATOR', xp: 600 },
  { name: 'SPECIALIST', xp: 1600 },
  { name: 'VETERAN', xp: 3200 },
  { name: 'FIELD EXPERT', xp: 5400 },
  { name: 'ELITE', xp: 8200 },
];

/**
 * Difficulty changes behaviour, not health pools: awareness, reaction,
 * dispersion, resources, checkpoint policy and XP payout.
 */
export const DIFFICULTIES = {
  recruit: {
    name: 'RECRUIT', skill: 0.78, reaction: 1.4, spread: 1.3, detection: 0.7,
    hearing: 0.8, reserve: 1.3, armor: 75, bandageCd: 0.7, checkpoints: true, xp: 0.8,
    desc: 'Slower reactions, poorer aim, generous supplies. Checkpoints on.',
  },
  standard: {
    name: 'STANDARD', skill: 1.0, reaction: 1.0, spread: 1.0, detection: 1.0,
    hearing: 1.0, reserve: 1.0, armor: 50, bandageCd: 1.0, checkpoints: true, xp: 1.0,
    desc: 'The designed experience. Checkpoints on.',
  },
  hard: {
    name: 'HARD', skill: 1.16, reaction: 0.82, spread: 0.85, detection: 1.3,
    hearing: 1.15, reserve: 0.85, armor: 35, bandageCd: 1.3, checkpoints: true, xp: 1.3,
    desc: 'Sharp squads, quick triggers, thin supplies. Checkpoints on.',
  },
  veteran: {
    name: 'VETERAN', skill: 1.3, reaction: 0.68, spread: 0.72, detection: 1.5,
    hearing: 1.3, reserve: 0.7, armor: 25, bandageCd: 1.6, checkpoints: false, xp: 1.7,
    desc: 'Lethal AI, minimal gear, NO mid-mission checkpoints. One life per run.',
  },
};

/** Medal definitions. check(run) receives the finished-mission context. */
export const MEDALS = [
  { id: 'excellence', name: 'OPERATIONAL EXCELLENCE', desc: 'Finish a mission with a performance rating of 90 or higher.', check: r => r.rating >= 90 },
  { id: 'ghost', name: 'GHOST', desc: 'Complete an infiltration-style mission without triggering a major alert.', check: r => r.quietTypes && !r.alarm },
  { id: 'recon', name: 'RECON SPECIALIST', desc: 'Recover every intelligence item available on a mission.', check: r => !!r.intelComplete },
  { id: 'analyst', name: 'FIELD ANALYST', desc: 'Complete every optional objective in a single mission.', check: r => r.optionalTotal > 0 && r.optionalDone >= r.optionalTotal },
  { id: 'survivor', name: 'SURVIVOR', desc: 'Complete a mission having taken 35 damage or less.', check: r => r.damageTaken <= 35 },
  { id: 'precision', name: 'PRECISION', desc: 'Finish with 70% accuracy or better (minimum 20 rounds fired).', check: r => r.shots >= 20 && r.hits / r.shots >= 0.7 },
  { id: 'clean', name: 'CLEAN OPERATION', desc: 'No major alert and 15 damage or less taken.', check: r => !r.alarm && r.damageTaken <= 15 },
  { id: 'resourceful', name: 'RESOURCEFUL', desc: 'Complete a mission wounded — under 40 health at extraction.', check: r => r.finishedHealth < 40 },
  { id: 'explorer', name: 'EXPLORER', desc: 'Recover at least 3 intelligence items in one mission.', check: r => r.intelFound >= 3 },
  { id: 'extraction', name: 'EXTRACTION SPECIALIST', desc: 'Complete a mission under its par time.', check: r => r.parTime > 0 && r.timeSec <= r.parTime },
  { id: 'sharpshooter', name: 'SHARPSHOOTER', desc: 'Six or more kills with at least half of them headshots.', check: r => r.kills >= 6 && r.headshots / Math.max(1, r.kills) >= 0.5 },
  { id: 'ironwill', name: 'IRON WILL', desc: 'Drop below 15 health at any point and still complete the mission.', check: r => r.minHealth < 15 },
  // ---- C4 expansion medals ----
  { id: 'roadmaster', name: 'ROAD MASTER', desc: 'Drive at least 900 metres in a single mission.', check: r => (r.driveDist || 0) >= 900 },
  { id: 'navigator', name: 'NAVIGATOR', desc: 'Finish a drive of 300+ metres having used the tactical map.', check: r => (r.driveDist || 0) >= 300 && (r.mapOpens || 0) >= 1 },
  { id: 'tactician', name: 'TACTICIAN', desc: 'Complete a mission with no major alert using three or more equipment categories.', check: r => !r.alarm && (r.equipCats || 0) >= 3 },
  { id: 'fieldop', name: 'FIELD OPERATOR', desc: 'One mission: use a vehicle, throw ordnance, and map at least 30% of the area.', check: r => r.usedVehicle && (r.throwablesUsed || 0) >= 1 && (r.fogPct || 0) >= 30 },
  { id: 'driver', name: 'DRIVER', desc: 'Complete a vehicle mission without abandoning the vehicle mid-objective.', check: r => r.vehicleMission && r.driverClean },
];

/** Cosmetic weapon finishes, unlocked by rank. Purely visual. */
export const FINISHES = [
  { id: 'standard', name: 'STANDARD ISSUE', rank: 0, color: null },
  { id: 'arctic', name: 'ARCTIC WHITE', rank: 1, color: 0xd8dde2 },
  { id: 'midnight', name: 'MIDNIGHT BLUE', rank: 2, color: 0x2c3648 },
  { id: 'rustline', name: 'RUSTLINE CAMO', rank: 3, color: 0x6e5237 },
  { id: 'olive', name: 'FIELD OLIVE', rank: 4, color: 0x4a5540 },
  { id: 'goldline', name: 'GOLDLINE CEREMONIAL', rank: 5, color: 0xb99a4f },
];

/** Campaign order — each mission unlocks by completing the previous one. */
export const MISSION_ORDER = [
  'facility', 'desert', 'urban', 'snow',
  'recon_desert', 'sabotage_industrial', 'investigate_rural',
  'rescue_rural', 'defense_urban', 'hold_snow',
  'convoy_rural', 'extract_desert', 'recovery_snow', 'escort_urban',
  'transit_industrial', 'cq_urban', 'archive_facility',
];

const INTEL_LABELS = {
  facility: ['MANIFEST FRAGMENT', 'GUARD ROTA', 'SERVER ROOM KEYCARD', 'SHIPMENT LEDGER'],
  snow: ['RELAY LOG PRINTOUT', 'FUEL DEPOT NOTE', 'MAST ACCESS CODES'],
  desert: ['CACHE HOUSE MAP', 'WADI PATROL ORDER', 'BURIED DRIVE'],
  urban: ['BANK FLOOR PLAN', 'TOLL RECORDS', 'SAFEHOUSE ADDRESS', 'RADIO FREQUENCY SHEET'],
  industrial: ['FORGE SCHEMATIC', 'SHIFT SCHEDULE', 'COOLANT ANALYSIS', 'FOREMAN\'S LOG'],
  rural: ['FIELD SURVEY', 'TRUCK WAYBILL', 'CABIN RADIO TAPE', 'WELL WATER REPORT'],
};

function defaultData() {
  return {
    version: 1,
    xp: 0,
    difficulty: 'standard',
    finish: 'standard',
    medals: [],
    missions: {},                       // id → { completed, bestRating, bestMedals:[] }
    intel: {},                          // map → [idx found]
    stats: {
      missionsCompleted: 0, missionsFailed: 0, playTime: 0,
      objectivesCompleted: 0, optionalCompleted: 0,
      intelFound: 0, medalsEarned: 0,
      shots: 0, hits: 0, headshots: 0, kills: 0,
      damageTaken: 0, extractions: 0, stealthCompletions: 0,
      bestRating: 0, checkpointsUsed: 0,
    },
  };
}

export class Progress {
  constructor() {
    this.data = defaultData();
    this.load();
    this._saveT = 0;
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        const base = defaultData();
        this.data = Object.assign(base, d);
        this.data.stats = Object.assign(base.stats, d.stats || {});
      }
    } catch (e) { /* corrupt save → fresh start */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
  }

  /** throttled save for continuous updates like play time */
  tick(dt) {
    this.data.stats.playTime += dt;
    this._saveT -= dt;
    if (this._saveT <= 0) { this._saveT = 15; this.save(); }
  }

  // -------------------------------------------------------------------------
  get difficulty() { return DIFFICULTIES[this.data.difficulty] || DIFFICULTIES.standard; }
  setDifficulty(id) { if (DIFFICULTIES[id]) { this.data.difficulty = id; this.save(); } }

  get rankIndex() {
    let i = 0;
    for (let k = 0; k < RANKS.length; k++) if (this.data.xp >= RANKS[k].xp) i = k;
    return i;
  }
  get rank() { return RANKS[this.rankIndex]; }
  get nextRank() { return RANKS[this.rankIndex + 1] || null; }
  get rankProgress() {
    const cur = this.rank.xp, next = this.nextRank ? this.nextRank.xp : cur + 1;
    return Math.min(1, (this.data.xp - cur) / Math.max(1, next - cur));
  }

  isMissionUnlocked(id) {
    if (id === 'range') return true;
    const i = MISSION_ORDER.indexOf(id);
    if (i < 0) return true;
    if (i <= 3) return true;             // the four founding operations stay open
    const prev = MISSION_ORDER[i - 1];
    return !!(this.data.missions[prev] && this.data.missions[prev].completed);
  }
  unlockRequirement(id) {
    const i = MISSION_ORDER.indexOf(id);
    if (i <= 0) return null;
    return MISSION_ORDER[i - 1];
  }
  completedCount() {
    return MISSION_ORDER.filter(id => this.data.missions[id] && this.data.missions[id].completed).length;
  }

  // -------------------------------------------------------------------------
  // intelligence archive
  intelLabels(map) { return INTEL_LABELS[map] || []; }
  intelTotal(map) { return (INTEL_LABELS[map] || []).length; }
  intelFoundOn(map) { return (this.data.intel[map] || []).length; }
  intelFoundLabel(map, idx) { return (INTEL_LABELS[map] || [])[idx] || 'DOCUMENT'; }
  isIntelFound(map, idx) { return (this.data.intel[map] || []).includes(idx); }
  recordIntel(map, idx) {
    if (!this.data.intel[map]) this.data.intel[map] = [];
    if (this.data.intel[map].includes(idx)) return false;
    this.data.intel[map].push(idx);
    this.data.stats.intelFound++;
    this.save();
    return true;
  }
  intelGrandTotal() { return Object.keys(INTEL_LABELS).reduce((a, m) => a + this.intelTotal(m), 0); }
  intelGrandFound() { return Object.keys(INTEL_LABELS).reduce((a, m) => a + this.intelFoundOn(m), 0); }

  // -------------------------------------------------------------------------
  recordFailure(missionId) {
    this.data.stats.missionsFailed++;
    this.save();
  }

  /**
   * Evaluate a finished mission. run = {
   *   missionId, type, quietTypes, timeSec, parTime, shots, hits, headshots,
   *   kills, damageTaken, alarm, checkpointsUsed, intelFound, intelTotal,
   *   optionalDone, optionalTotal, objectivesDone, objectivesTotal,
   *   minHealth, finishedHealth, extracted }
   * Returns { rating, xp, newMedals, allMedals, rankUp, unlocks, run }.
   */
  evaluateMission(run) {
    const diff = this.difficulty;
    // --- rating -----------------------------------------------------------
    const objScore = run.objectivesTotal > 0 ? run.objectivesDone / run.objectivesTotal : 1;
    const optScore = run.optionalTotal > 0 ? run.optionalDone / run.optionalTotal : 0.5;
    const acc = run.shots > 0 ? run.hits / run.shots : 0;
    const stealth = run.alarm ? 0.25 : 1;
    const timeScore = run.parTime > 0 ? Math.max(0.2, Math.min(1, run.parTime / Math.max(1, run.timeSec))) : 0.7;
    const cpPenalty = Math.min(0.25, run.checkpointsUsed * 0.05);
    const rating = Math.round(Math.max(0, Math.min(100,
      (objScore * 40 + optScore * 20 + acc * 15 + stealth * 15 + timeScore * 10) - cpPenalty * 40)));

    // --- medals -------------------------------------------------------------
    const ctx = Object.assign({}, run, { rating });
    const earned = [], fresh = [];
    for (const m of MEDALS) {
      let ok = false;
      try { ok = !!m.check(ctx); } catch (e) { ok = false; }
      if (ok) {
        earned.push(m.id);
        if (!this.data.medals.includes(m.id)) { fresh.push(m.id); this.data.medals.push(m.id); }
      }
    }

    // --- xp -----------------------------------------------------------------
    let xp = 150 + run.optionalDone * 50 + run.intelFound * 25 + fresh.length * 40 + rating * 1.5;
    xp = Math.round(xp * diff.xp);
    const before = this.rankIndex;
    this.data.xp += xp;
    const after = this.rankIndex;
    const rankUp = after > before ? RANKS[after].name : null;

    // --- stats + mission record ----------------------------------------------
    const s = this.data.stats;
    s.missionsCompleted++;
    s.shots += run.shots; s.hits += run.hits; s.headshots += run.headshots;
    s.kills += run.kills; s.damageTaken += Math.round(run.damageTaken);
    s.objectivesCompleted += run.objectivesDone;
    s.optionalCompleted += run.optionalDone;
    s.checkpointsUsed += run.checkpointsUsed;
    if (run.extracted) s.extractions++;
    if (!run.alarm) s.stealthCompletions++;
    if (rating > s.bestRating) s.bestRating = rating;
    s.medalsEarned = this.data.medals.length;

    const rec = this.data.missions[run.missionId] || { completed: false, bestRating: 0, bestMedals: [] };
    rec.completed = true;
    if (rating > rec.bestRating) { rec.bestRating = rating; rec.bestMedals = earned; }
    this.data.missions[run.missionId] = rec;

    // --- unlocks ---------------------------------------------------------------
    const unlocks = [];
    const nextId = MISSION_ORDER[MISSION_ORDER.indexOf(run.missionId) + 1];
    if (nextId && this.isMissionUnlocked(nextId)) unlocks.push('MISSION — ' + (this._missionName ? this._missionName(nextId) : nextId.toUpperCase()));
    if (rankUp) {
      unlocks.push('RANK — ' + rankUp);
      for (const f of FINISHES) if (f.rank === after) unlocks.push('FINISH — ' + f.name);
    }
    for (const id of fresh) {
      const m = MEDALS.find(x => x.id === id);
      if (m) unlocks.push('MEDAL — ' + m.name);
    }
    this.save();
    return { rating, xp, newMedals: fresh, allMedals: earned, rankUp, unlocks, run: ctx };
  }

  finishUnlocked(finishId) {
    const f = FINISHES.find(x => x.id === finishId);
    return f && this.rankIndex >= f.rank;
  }
  setFinish(id) {
    if (this.finishUnlocked(id)) { this.data.finish = id; this.save(); return true; }
    return false;
  }
  get finish() { return FINISHES.find(f => f.id === this.data.finish) || FINISHES[0]; }
}
