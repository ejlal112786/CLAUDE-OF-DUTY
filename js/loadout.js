/**
 * loadout.js
 * Pre-mission loadout configuration (C3). One PRIMARY, one SECONDARY,
 * one THROWABLE type (+count), one UTILITY type (+count).
 *
 * Compatibility rules ("no incompatible combos"):
 *  - secondary must be a SIDEARM; primary may not be a SIDEARM
 *  - carry capacity: weapon weights + throwable/utility weights must fit
 *    the operator's load budget — heavy primaries force lighter ordnance
 */
import { WEAPON_DEFS, WEAPON_ORDER } from './weapons.js';
import { THROWABLE_DEFS } from './throwables.js';

const KEY = 'obv_loadout_v1';
export const CARRY_BUDGET = 11.0;

export const DEFAULT_LOADOUT = {
  primary: 'vx4',
  secondary: 'p9',
  throwable: 'vxfrag',
  throwableCount: 2,
  utility: 'medkit',
  utilityCount: 1,
};

export class Loadout {
  constructor() {
    this.primary = DEFAULT_LOADOUT.primary;
    this.secondary = DEFAULT_LOADOUT.secondary;
    this.throwable = DEFAULT_LOADOUT.throwable;
    this.throwableCount = DEFAULT_LOADOUT.throwableCount;
    this.utility = DEFAULT_LOADOUT.utility;
    this.utilityCount = DEFAULT_LOADOUT.utilityCount;
    this.load();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.current())); } catch (e) { /* private mode */ }
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && WEAPON_DEFS[d.primary]) this.primary = d.primary;
      if (d && WEAPON_DEFS[d.secondary]) this.secondary = d.secondary;
      if (d && THROWABLE_DEFS[d.throwable]) this.throwable = d.throwable;
      if (d && THROWABLE_DEFS[d.utility]) this.utility = d.utility;
      this.throwableCount = Math.max(0, Math.min(3, d.throwableCount | 0));
      this.utilityCount = Math.max(0, Math.min(2, d.utilityCount | 0));
    } catch (e) { /* corrupted storage — keep defaults */ }
  }

  current() {
    return {
      primary: this.primary, secondary: this.secondary,
      throwable: this.throwable, throwableCount: this.throwableCount,
      utility: this.utility, utilityCount: this.utilityCount,
    };
  }

  /** Weight currently carried. */
  weight() {
    const pw = (WEAPON_DEFS[this.primary] || {}).weight || 5;
    const sw = (WEAPON_DEFS[this.secondary] || {}).weight || 1.5;
    const tw = (THROWABLE_DEFS[this.throwable] || {}).weight || 0.5;
    const uw = (THROWABLE_DEFS[this.utility] || {}).weight || 0.6;
    return pw + sw + tw * this.throwableCount + uw * this.utilityCount;
  }

  /** Returns null when valid, or a human-readable rejection reason. */
  validate() {
    const p = WEAPON_DEFS[this.primary], s = WEAPON_DEFS[this.secondary];
    if (!p || !s) return 'UNKNOWN GEAR SELECTED';
    if (p.klass === 'SIDEARM') return 'PRIMARY CANNOT BE A SIDEARM';
    if (s.klass !== 'SIDEARM') return 'SECONDARY MUST BE A SIDEARM';
    if (this.primary === this.secondary) return 'CANNOT CARRY THE SAME WEAPON TWICE';
    const td = THROWABLE_DEFS[this.throwable];
    if (!td || td.cat !== 'throwable') return 'INVALID THROWABLE';
    const ud = THROWABLE_DEFS[this.utility];
    if (!ud || ud.cat !== 'utility') return 'INVALID UTILITY ITEM';
    const w = this.weight();
    if (w > CARRY_BUDGET + 0.001) return `OVER LOAD BUDGET (${w.toFixed(1)} / ${CARRY_BUDGET.toFixed(1)} KG-EQ) — DROP SOMETHING`;
    return null;
  }

  primaries() { return WEAPON_ORDER.filter(id => WEAPON_DEFS[id].klass !== 'SIDEARM'); }
  secondaries() { return WEAPON_ORDER.filter(id => WEAPON_DEFS[id].klass === 'SIDEARM'); }
  throwables() { return Object.keys(THROWABLE_DEFS).filter(id => THROWABLE_DEFS[id].cat === 'throwable'); }
  utilities() { return Object.keys(THROWABLE_DEFS).filter(id => THROWABLE_DEFS[id].cat === 'utility'); }

  /** Apply a change; returns null when the loadout is valid, else the reason. */
  set(field, value) {
    this[field] = value;
    const bad = this.validate();
    this.save();
    return bad;
  }
}
