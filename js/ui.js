/**
 * ui.js
 * DOM-based HUD and menu layer. All screens live in index.html; this module
 * wires them up and updates the HUD each frame. Values are cached so the DOM
 * is only touched when something actually changes (no layout thrash in the
 * game loop).
 */
import * as THREE from 'three';
import { MISSION_DEFS } from './missions.js';
import { MEDALS, FINISHES, RANKS, DIFFICULTIES, MISSION_ORDER } from './progress.js';
import { WEAPON_DEFS } from './weapons.js';
import { THROWABLE_DEFS } from './throwables.js';
import { CARRY_BUDGET } from './loadout.js';

const $ = (id) => document.getElementById(id);

const COMPASS_PX_PER_DEG = 2.9;
const COMPASS_WINDOW = 340;

export class UI {
  constructor(game) {
    this.game = game;

    this.screens = {
      loading: $('screen-loading'),
      menu: $('screen-menu'),
      select: $('screen-select'),
      settings: $('screen-settings'),
      credits: $('screen-credits'),
      pause: $('screen-pause'),
      death: $('screen-death'),
      complete: $('screen-complete'),
      failed: $('screen-failed'),
      missions: $('screen-missions'),
      loadout: $('screen-loadout'),
      intel: $('screen-intel'),
      awards: $('screen-awards'),
      stats: $('screen-stats'),
      brief: $('screen-brief'),
      objectives: $('screen-objectives'),
      error: $('error-overlay'),
    };
    this.alertChip = $('alert-chip');
    this.mobnav = $('mobnav');
    this._bindMobNav();
    this._alertLvl = '';
    this.hud = $('hud');
    this.compass = $('compass');
    this.compassCtx = this.compass ? this.compass.getContext('2d') : null;
    this.tacEl = $('tacmap');
    this.tacCanvas = $('tacmap-canvas');
    this.eqWheel = $('eq-wheel');
    this.throwRow = $('throw-row');
    this.throwName = $('throw-name');
    this.throwCount = $('throw-count');
    this.vehHud = $('veh-hud');
    this.vehName = $('veh-name');
    this.vehKmh = $('veh-kmh');
    this.vehGear = $('veh-gear');
    this.vehDmgFill = $('veh-dmg-fill');
    this.vehHint = $('veh-hint');
    this.flashbangEl = $('flashbang');
    this.ammoTotal = $('ammo-total');
    this._fb = 0;
    this._wheelHover = null;
    this._wheelCats = null;
    this.tacCtx = this.tacCanvas ? this.tacCanvas.getContext('2d') : null;
    this.armorFill = $('armor-fill');
    this.bandageEl = $('bandage-bar');
    this.bandageFill = $('bandage-fill');
    this._tacOpen = false;
    this._tacStatic = null;
    this._tacB = null;
    this._armorFlashT = 0;

    // hud pieces
    this.objText = $('obj-text');
    this.objSub = $('obj-sub');
    this.lockdownEl = $('lockdown-timer');
    this.compassStrip = $('compass-strip');
    this.ammoMag = $('ammo-mag');
    this.fragEl = $('frag-count');
    this.radioEl = $('radio-line');
    this.pinnedEl = $('suppress-hint');
    this._radioT = 0;
    this.ammoReserve = $('ammo-reserve');
    this.weaponName = $('weapon-name');
    this.weaponState = $('weapon-state');
    this.healthFill = $('health-fill');
    this.healthNum = $('health-num');
    this.staminaFill = $('stamina-fill');
    this.crosshair = $('crosshair');
    this.hitmarker = $('hitmarker');
    this.dmgIndicators = $('damage-indicators');
    this.interactPrompt = $('interact-prompt');
    this.interactText = $('interact-text');
    this.hackProgress = $('hack-progress');
    this.hackFill = $('hack-fill');
    this.toastEl = $('objective-toast');
    this.toastLabel = $('toast-label');
    this.toastText = $('toast-text');
    this.damageFlash = $('damage-flash');
    this.vignette = $('vignette');
    this.fps = $('fps-counter');
    this.stance = $('stance-indicator');
    this.loadingBar = $('loading-bar');
    this.loadingStatus = $('loading-status');

    // caches (avoid touching DOM when unchanged)
    this._c = {};

    // damage indicator pool
    this._dmgPool = [];
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div');
      d.className = 'dmg-indicator';
      d.style.opacity = '0';
      d.style.transition = 'opacity 900ms ease-out';
      this.dmgIndicators.appendChild(d);
      this._dmgPool.push({ el: d, t: 0 });
    }

    this._hitmarkerT = 0;
    this._toastT = 0;
    this._briefT = 0;
    this._fpsT = 0;
    this._fpsFrames = 0;

    this._buildCompass();
    this.settingsReturnTo = 'menu';
  }

  // -------------------------------------------------------------------------
  _buildCompass() {
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let d = 0; d <= 720; d += 15) {
      const deg = d % 360;
      const label = labels[deg] || '|';
      const cls = labels[deg] ? 'compass-tick cardinal' : 'compass-tick';
      html += `<div class="${cls}" style="left:${d * COMPASS_PX_PER_DEG}px">${label}</div>`;
    }
    this.compassStrip.innerHTML = html;
    this.compassStrip.style.width = `${720 * COMPASS_PX_PER_DEG}px`;
  }

  // -------------------------------------------------------------------------
  showScreen(name) {
    if (name === 'select') this.syncLoadoutPanel();
    for (const k of Object.keys(this.screens)) {
      this.screens[k].classList.toggle('hidden', k !== name);
    }
    this.hud.classList.toggle('hidden', name !== null);
    if (name !== null) this.closeTacMap();
    this._updateMobNav(name);
    if (name !== 'menu') { const ps = $('perf-suggest'); if (ps) ps.classList.add('hidden'); }
    if (name === null) {
      for (const k of Object.keys(this.screens)) this.screens[k].classList.add('hidden');
    }
  }

  hideAll() {
    for (const k of Object.keys(this.screens)) this.screens[k].classList.add('hidden');
  }

  setLoading(p, status) {
    this.showScreen('loading');
    this.loadingBar.style.width = `${Math.round(p * 100)}%`;
    if (status && this._c.loadStatus !== status) {
      this.loadingStatus.textContent = status;
      this._c.loadStatus = status;
    }
  }

  showError(msg) {
    $('error-message').textContent = msg;
    this.showScreen('error');
  }

  // -------------------------------------------------------------------------
  setObjective(text, sub) {
    this.objText.textContent = text;
    this._objSubBase = sub || '';
    this.objSub.textContent = sub || '';
    this._objDist = '';
    this._c.obj = text;
  }

  /** Delayed toast — lets a preceding toast (e.g. OBJECTIVE COMPLETE) finish first. */
  toastQueued(label, text, duration = 3.0, delayMs = 2400) {
    setTimeout(() => {
      try { if (this.game.state === 'playing') this.toast(label, text, duration); } catch (e) { /* gone */ }
    }, delayMs);
  }

  toast(label, text, duration = 3.2) {
    this.toastLabel.textContent = label;
    this.toastText.textContent = text;
    this.toastEl.classList.remove('hidden');
    requestAnimationFrame(() => this.toastEl.classList.add('show'));
    this._toastT = duration;
  }

  // =========================================================================
  // C3: flashbang, throw row, equipment wheel, loadout panel
  // =========================================================================
  flashbang(power) {
    this._fb = Math.max(this._fb, Math.min(1, power));
    if (this.flashbangEl) this.flashbangEl.style.opacity = this._fb.toFixed(3);
  }

  setThrowHighlight(mode) {
    if (!this.throwRow) return;
    this.throwRow.classList.toggle('hl-throw', mode === 'throwable');
    this.throwRow.classList.toggle('hl-util', mode === 'utility');
  }

  showEqWheel(game) {
    const cv = this.eqWheel;
    if (!cv) return;
    const ws = game.weapons, th = game.throwables;
    const owned = Array.from(ws.owned || []);
    const mk = (ids) => ids.map(id => ({ id, label: WEAPON_DEFS[id].name }));
    const mkT = (ids) => ids.map(id => ({ id, label: THROWABLE_DEFS[id].name + ' ×' + th.count(id) }));
    const cats = [
      { cat: 'primary', label: 'PRIMARY', items: mk(owned.filter(id => WEAPON_DEFS[id] && WEAPON_DEFS[id].klass !== 'SIDEARM')) },
      { cat: 'secondary', label: 'SECONDARY', items: mk(owned.filter(id => WEAPON_DEFS[id] && WEAPON_DEFS[id].klass === 'SIDEARM')) },
      { cat: 'throwable', label: 'THROWABLE', items: mkT(th.listWithStock('throwable')) },
      { cat: 'utility', label: 'UTILITY', items: mkT(th.listWithStock('utility')) },
      { cat: 'mission', label: 'MISSION', items: [{ id: 'info', label: 'MISSION GEAR — CARRIED' }] },
    ];
    for (const c of cats) if (!c.items.length) c.items.push({ id: null, label: '— NONE —' });
    this._wheelCats = cats;
    this._wheelHover = null;
    cv.classList.remove('hidden');
    this._drawWheel(0, 0);
  }

  moveWheelCursor(x, y) {
    this._wheelHover = this._wheelHit(x, y);
    this._drawWheel(x, y);
  }

  resolveWheel(x, y) {
    const h = this._wheelHit(x, y);
    if (!h) return null;
    const cat = this._wheelCats[h.catIdx];
    const item = cat.items[h.idx];
    if (!item || !item.id) return h.catIdx === 4 ? { cat: 'mission' } : null;
    return { cat: cat.cat, id: item.id };
  }

  hideEqWheel() {
    if (this.eqWheel) this.eqWheel.classList.add('hidden');
    this._wheelHover = null;
  }

  /** Sector + row hit test in wheel-cursor space (origin = wheel centre). */
  _wheelHit(x, y) {
    const r = Math.hypot(x, y);
    if (r < 26 || r > 168 || !this._wheelCats) return null;
    let ang = Math.atan2(y, x) * 180 / Math.PI;      // -180..180, up = -90
    const rel = ((ang + 90 + 36) % 360 + 360) % 360; // 0 at top-sector left edge
    const catIdx = Math.floor(rel / 72) % 5;
    const cat = this._wheelCats[catIdx];
    const mid = (catIdx * 72 - 90) * Math.PI / 180;
    const py = Math.sin(mid) * 100;
    const n = cat.items.length;
    let j = Math.round((y - py) / 20 + (n - 1) / 2);
    j = Math.max(0, Math.min(n - 1, j));
    return { catIdx, idx: j };
  }

  _drawWheel(curX, curY) {
    const cv = this.eqWheel;
    if (!cv || !this._wheelCats) return;
    const ctx = cv.getContext('2d');
    const cx = 180, cy = 180;
    ctx.clearRect(0, 0, 360, 360);
    const DEG = Math.PI / 180;
    ctx.fillStyle = 'rgba(5, 9, 7, 0.84)';
    ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 140, 0.3)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.stroke();
    const hover = this._wheelHover;
    for (let i = 0; i < 5; i++) {
      const a0 = (i * 72 - 90 - 36) * DEG, a1 = a0 + 72 * DEG;
      const mid = (i * 72 - 90) * DEG;
      if (hover && hover.catIdx === i) {
        ctx.fillStyle = 'rgba(64, 140, 88, 0.24)';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 168, a0, a1); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(120, 200, 140, 0.22)';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a0) * 168, cy + Math.sin(a0) * 168); ctx.stroke();
      // category title
      ctx.fillStyle = 'rgba(150, 220, 170, 0.9)';
      ctx.font = '700 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this._wheelCats[i].label, cx + Math.cos(mid) * 150, cy + Math.sin(mid) * 150 + 3);
      // item rows
      const items = this._wheelCats[i].items;
      const px = Math.cos(mid) * 100, py = Math.sin(mid) * 100;
      ctx.font = '10px monospace';
      for (let j = 0; j < items.length; j++) {
        const ry = cy + py + (j - (items.length - 1) / 2) * 20;
        const rx = cx + px;
        if (hover && hover.catIdx === i && hover.idx === j) {
          ctx.fillStyle = 'rgba(140, 230, 160, 0.9)';
          ctx.fillRect(rx - 74, ry - 9, 148, 17);
          ctx.fillStyle = '#08120c';
        } else {
          ctx.fillStyle = items[j].id ? 'rgba(200, 225, 205, 0.88)' : 'rgba(140, 150, 145, 0.55)';
        }
        ctx.textAlign = 'center';
        ctx.fillText(items[j].label, rx, ry + 3);
      }
    }
    // cursor crosshair
    ctx.strokeStyle = 'rgba(255, 210, 120, 0.95)';
    ctx.lineWidth = 1.5;
    const gx = cx + curX, gy = cy + curY;
    ctx.beginPath();
    ctx.moveTo(gx - 8, gy); ctx.lineTo(gx + 8, gy);
    ctx.moveTo(gx, gy - 8); ctx.lineTo(gx, gy + 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 210, 120, 0.9)';
    ctx.font = '700 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RELEASE [Q] TO EQUIP', cx, cy + 6);
  }

  buildLoadoutPanel() {
    const lo = this.game.loadout;
    const p = $('lo-primary');
    if (!lo || !p || this._loBuilt) return;
    this._loBuilt = true;
    const s = $('lo-secondary'), t = $('lo-throwable'), tc = $('lo-tcount'), u = $('lo-utility'), uc = $('lo-ucount');
    const fill = (sel, ids, labeler) => {
      sel.innerHTML = '';
      for (const id of ids) {
        const o = document.createElement('option');
        o.value = id; o.textContent = labeler(id);
        sel.appendChild(o);
      }
    };
    fill(p, lo.primaries(), id => WEAPON_DEFS[id].name + ' · ' + WEAPON_DEFS[id].klass);
    fill(s, lo.secondaries(), id => WEAPON_DEFS[id].name);
    fill(t, lo.throwables(), id => THROWABLE_DEFS[id].name);
    fill(u, lo.utilities(), id => THROWABLE_DEFS[id].name);
    tc.innerHTML = '';
    for (let i = 0; i <= 3; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = '×' + i; tc.appendChild(o); }
    uc.innerHTML = '';
    for (let i = 0; i <= 2; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = '×' + i; uc.appendChild(o); }
    const bind = (el, field, parse) => {
      el.addEventListener('change', () => {
        lo.set(field, parse ? parse(el.value) : el.value);
        this.syncLoadoutPanel();
      });
    };
    bind(p, 'primary'); bind(s, 'secondary'); bind(t, 'throwable'); bind(u, 'utility');
    bind(tc, 'throwableCount', v => parseInt(v, 10) | 0);
    bind(uc, 'utilityCount', v => parseInt(v, 10) | 0);
    this.syncLoadoutPanel();
  }

  syncLoadoutPanel() {
    const lo = this.game.loadout;
    const p = $('lo-primary');
    if (!lo) return;
    if (!this._loBuilt) { this.buildLoadoutPanel(); return; }
    if (!p) return;
    p.value = lo.primary; $('lo-secondary').value = lo.secondary;
    $('lo-throwable').value = lo.throwable; $('lo-tcount').value = String(lo.throwableCount);
    $('lo-utility').value = lo.utility; $('lo-ucount').value = String(lo.utilityCount);
    const msg = lo.validate();
    $('lo-weight').textContent = 'CARRY ' + lo.weight().toFixed(1) + ' / ' + CARRY_BUDGET.toFixed(1);
    const m = $('lo-msg');
    m.textContent = msg || 'LOADOUT VALID — CLEAR TO DEPLOY';
    m.className = msg ? 'lo-bad' : 'lo-ok';
  }

  // ---- vehicle HUD (C2) ----
  showVehicleHUD(v) {
    if (!this.vehHud) return;
    this.vehHud.classList.remove('hidden');
    this.vehName.textContent = v.def.name;
  }

  updateVehicleHUD(v) {
    if (!this.vehHud || this.vehHud.classList.contains('hidden')) return;
    this.vehKmh.textContent = String(Math.round(Math.abs(v.speed) * 3.6));
    this.vehGear.textContent = v.speed > 0.5 ? 'D' : (v.speed < -0.5 ? 'R' : 'N');
    const f = Math.max(0, v.hp / v.def.hp);
    this.vehDmgFill.style.width = (f * 100).toFixed(0) + '%';
    this.vehDmgFill.className = 'bar-fill' + (f > 0.6 ? '' : f > 0.25 ? ' mid' : ' low');
    this.vehHint.textContent = v.hp <= 0 ? 'DISABLED' : (f < 0.25 ? 'SEVERELY DAMAGED' : f < 0.6 ? 'DAMAGED' : 'OPERATIONAL');
  }

  hideVehicleHUD() {
    if (this.vehHud) this.vehHud.classList.add('hidden');
  }

  toastBrief(text, secs = 1.6) {
    // reuse interaction prompt area for transient messages
    this._briefMsg = text;
    this._briefT = secs;
    this.subtitle('BRIEF', text, 3.2);
  }

  hitMarker(kill) {
    this.hitmarker.classList.remove('hidden');
    this.hitmarker.classList.add('show');
    this.hitmarker.classList.toggle('kill', !!kill);
    this._hitmarkerT = kill ? 0.28 : 0.14;
  }

  playerDamaged(amount, fromPos, playerPos) {
    // red flash scaled by damage
    const f = Math.min(1, amount / 40);
    this.damageFlash.style.transition = 'none';
    this.damageFlash.style.opacity = String(0.25 + f * 0.6);
    requestAnimationFrame(() => {
      this.damageFlash.style.transition = 'opacity 350ms ease-out';
      this.damageFlash.style.opacity = '0';
    });

    if (fromPos) {
      // directional indicator: angle of attacker relative to view direction
      const dx = fromPos.x - playerPos.x;
      const dz = fromPos.z - playerPos.z;
      const bearingToAttacker = Math.atan2(dx, -dz);            // 0 = north
      const viewBearing = -this.game.player.yaw;                 // player forward bearing
      let rel = bearingToAttacker - viewBearing;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const slot = this._dmgPool.find(d => d.t <= 0) || this._dmgPool[0];
      slot.t = 1.2;
      slot.el.style.transform = `translate(-50%,-50%) rotate(${rel}rad)`;
      slot.el.style.opacity = '1';
    }
  }

  setLockdown(seconds) {
    if (seconds <= 0) {
      this.lockdownEl.classList.add('hidden');
      return;
    }
    this.lockdownEl.classList.remove('hidden');
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const txt = `LOCKDOWN T-${m}:${s.toString().padStart(2, '0')}`;
    if (this._c.lockdown !== txt) {
      this.lockdownEl.textContent = txt;
      this._c.lockdown = txt;
    }
  }

  setInteract(prompt) {
    if (prompt) {
      this.interactPrompt.classList.remove('hidden');
      if (this._c.prompt !== prompt) {
        this.interactText.textContent = prompt;
        this._c.prompt = prompt;
      }
    } else {
      this.interactPrompt.classList.add('hidden');
      this._c.prompt = null;
    }
  }

  setHackProgress(p, label) {
    if (p === null) {
      this.hackProgress.classList.add('hidden');
    } else {
      this.hackProgress.classList.remove('hidden');
      this.hackFill.style.width = `${Math.round(p * 100)}%`;
      if (label && this._c.hackLabel !== label) {
        $('hack-label').textContent = label;
        this._c.hackLabel = label;
      }
    }
  }

  // -------------------------------------------------------------------------
  /** Called every rendered frame while playing. */
  // ------------------------------------------------------------------
  // meta screens: menu badges, mission list, loadout, intel, awards, stats
  refreshMenuBadges() {
    const pr = this.game.progress;
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    set('badge-missions', pr.completedCount() + ' / ' + MISSION_ORDER.length);
    set('badge-intel', pr.intelGrandFound() + ' / ' + pr.intelGrandTotal());
    set('badge-awards', pr.data.medals.length + ' / ' + MEDALS.length);
    const rankEl = $('menu-rank');
    if (rankEl) {
      rankEl.innerHTML = `RANK — ${pr.rank.name} · ${pr.data.xp} XP` +
        (pr.nextRank ? ` · NEXT: ${pr.nextRank.name} AT ${pr.nextRank.xp}` : ' · MAX RANK') +
        `<span class="rank-bar"><i style="width:${Math.round(pr.rankProgress * 100)}%"></i></span>`;
    }
  }

  buildMissionsList() {
    const pr = this.game.progress;
    const el = $('missions-list');
    if (!el) return;
    el.innerHTML = '';

    // category filter chips (spec §32)
    const cats = ['ALL', 'CAMPAIGN', 'RECON', 'RECOVERY', 'INFILTRATION', 'ESCORT',
      'EXTRACTION', 'DEFENSE', 'VEHICLE', 'CHALLENGE'];
    const chips = document.createElement('div');
    chips.className = 'cat-chips';
    for (const c of cats) {
      const chip = document.createElement('button');
      chip.className = 'cat-chip' + ((this._missionCat || 'ALL') === c ? ' on' : '');
      chip.textContent = c;
      chip.addEventListener('click', () => { this._missionCat = c; this.buildMissionsList(); });
      chips.appendChild(chip);
    }
    el.appendChild(chips);

    const diff = (this.game.settings.difficulty || 'standard').toUpperCase();
    for (const id of MISSION_ORDER) {
      const def = MISSION_DEFS[id];
      if (!def) continue;
      const cat = def.cat || 'CAMPAIGN';
      if (this._missionCat && this._missionCat !== 'ALL' && cat !== this._missionCat) continue;
      const unlocked = pr.isMissionUnlocked(id);
      const rec = pr.data.missions[id];
      const intel = (pr.data.intel && pr.data.intel[def.map]) ? pr.data.intel[def.map].length : 0;
      const row = document.createElement('button');
      row.className = 'mission-row' + (unlocked ? '' : ' locked');
      const status = !unlocked
        ? `<span class="m-status lock">LOCKED — COMPLETE ${(MISSION_DEFS[pr.unlockRequirement(id)] || { title: '?' }).title}</span>`
        : rec && rec.completed
          ? `<span class="m-status">COMPLETE ★ ${rec.bestRating}</span>`
          : '<span class="m-status">AVAILABLE</span>';
      const medals = rec && rec.bestMedals && rec.bestMedals.length
        ? ' · 🏅 ' + rec.bestMedals.length : '';
      row.innerHTML = `<span class="m-main"><span class="m-title">${def.title}</span>` +
        `<span class="m-tag">${cat} · ${def.tag} · ${(def.loc || '').split('—')[0].trim() || def.map.toUpperCase()}</span>` +
        `<span class="m-tag">DIFFICULTY ${diff} · ${def.vehicle ? 'VEHICLE OP' : 'ON FOOT'} · INTEL ${intel}${medals}</span>` +
        `</span>${status}`;
      if (unlocked) row.addEventListener('click', () => this.showBrief(id, 'missions'));
      el.appendChild(row);
    }
  }

  /** Pre-deploy briefing screen (spec §29) — works on mobile via .brief-panel CSS. */
  showBrief(id, origin) {
    const def = MISSION_DEFS[id];
    if (!def) return;
    this._briefId = id;
    this._briefOrigin = origin || 'select';
    const g = this.game;
    $('brief-title').textContent = def.title;
    $('brief-meta').innerHTML =
      `<span>LOCATION <b>${def.loc || (def.map || '').toUpperCase()}</b></span>` +
      `<span>TIME <b>${def.time || '—'}</b></span>` +
      `<span>WEATHER <b>${def.wx || '—'}</b></span>` +
      `<span>TYPE <b>${(def.cat || 'CAMPAIGN')} · ${(def.type || '').toUpperCase()}</b></span>` +
      `<span>DIFFICULTY <b>${(g.settings.difficulty || 'standard').toUpperCase()}</b></span>` +
      `<span>PAR TIME <b>${def.parTime ? def.parTime + 's' : '—'}</b></span>`;
    $('brief-body').textContent = def.brief ||
      'Execute the operation as briefed. Follow the objective marker and extract when complete.';
    const obj = $('brief-objectives');
    let html = '<h3>PRIMARY OBJECTIVES</h3><ul>';
    const steps = def.seq || [];
    for (const st of steps) {
      if (st.opt) continue;
      html += `<li>${st.text}</li>`;
    }
    if (!steps.length) html += '<li>COMPLETE THE OPERATION AND REACH EXTRACTION</li>';
    html += '</ul>';
    const OPT_NAMES = {
      ghost: 'RAISE NO ALARM', intel: 'RECOVER ALL INTEL', par: 'FINISH UNDER PAR TIME',
      light: 'MINIMIZE CASUALTIES', marksman: 'MARKSMAN ACCURACY',
    };
    if (def.optionals && def.optionals.length) {
      html += '<h3>OPTIONAL OBJECTIVES</h3><ul>';
      for (const o of def.optionals) html += `<li class="opt">${OPT_NAMES[o] || String(o).toUpperCase()}</li>`;
      html += '</ul>';
    }
    obj.innerHTML = html;
    $('brief-reward').innerHTML = '<h3>REWARDS</h3>' + (def.reward || 'XP · CAMPAIGN PROGRESSION');
    this.showScreen('brief');
  }

  /** Pause-menu panels: objective sequence + current equipment (spec §43). */
  buildObjectivesPanel() {
    const g = this.game;
    const el = $('objectives-list');
    const title = document.querySelector('#screen-objectives .panel-title');
    if (title) title.textContent = 'MISSION OBJECTIVES';
    if (!el) return;
    el.innerHTML = '';
    const m = g.missions;
    const def = m.def;
    const rows = [];
    const steps = (m.isSeq && def && def.seq) ? def.seq : null;
    if (steps) {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        rows.push({ text: st.text, state: i < m.seqIdx ? 'done' : i === m.seqIdx ? 'current' : 'next' });
      }
    } else if (g.state === 'playing') {
      rows.push({ text: (this._objSubBase || def.title || 'COMPLETE THE OPERATION').toUpperCase(), state: 'current' });
    }
    const op = m.currentObjectivePos ? m.currentObjectivePos() : null;
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'obj-row ' + r.state;
      const mark = r.state === 'done' ? '✓' : r.state === 'current' ? '▶' : '◇';
      let dist = '';
      if (r.state === 'current' && op) {
        const d = Math.round(Math.hypot(op.x - g.player.pos.x, op.z - g.player.pos.z));
        dist = `<span class="obj-dist">${d} m</span>`;
      }
      div.innerHTML = `<span class="obj-mark">${mark}</span><span>${r.text}</span>${dist}`;
      el.appendChild(div);
    }
    if (!rows.length) el.innerHTML = '<div class="obj-row"><span>NO ACTIVE OPERATION</span></div>';
  }

  buildEquipmentPanel() {
    const g = this.game;
    const el = $('objectives-list');
    const title = document.querySelector('#screen-objectives .panel-title');
    if (title) title.textContent = 'EQUIPMENT / LOADOUT';
    if (!el) return;
    const ws = g.weapons;
    const defs = ws.defs || {};
    const lo = g.loadout || {};
    const wname = (id) => (defs[id] ? defs[id].name + ' · ' + defs[id].klass : (id || '—').toUpperCase());
    const line = (slot, txt) => `<div class="obj-row"><span class="obj-mark">■</span><span>${slot}: <b>${txt}</b></span></div>`;
    const cur = ws.state[ws.currentId] || {};
    let html = '';
    html += line('IN HAND', wname(ws.currentId));
    html += line('PRIMARY', wname(lo.primary));
    html += line('SECONDARY', wname(lo.secondary));
    const th = g.throwables;
    if (th && th.count) {
      const tnames = ['vxfrag', 'smoke', 'flash', 'decoy', 'flare', 'sensor', 'breach']
        .map(id => ((THROWABLE_DEFS[id] && THROWABLE_DEFS[id].name) || id.toUpperCase()) + ' ×' + th.count(id))
        .filter(x => !/×0$/.test(x));
      html += `<div class="obj-row"><span class="obj-mark">●</span><span>THROWABLES: <b>${tnames.length ? tnames.join(' · ') : 'EMPTY'}</b></span></div>`;
      html += `<div class="obj-row"><span class="obj-mark">◇</span><span>UTILITY: MEDKIT ×${th.count('medkit') || 0}</span></div>`;
    }
    html += `<div class="obj-row"><span class="obj-mark">Σ</span><span>AMMO: <b>${cur.mag != null ? cur.mag : '—'}</b> IN MAG · ${cur.reserve != null ? cur.reserve : '—'} RESERVE</span></div>`;
    html += `<div class="obj-row"><span class="obj-mark">i</span><span>SWAP GEAR IN THE FIELD: WEAPON PICKUPS, SUPPLY CRATES, VEHICLE TRUNKS (HOLD INTERACT)</span></div>`;
    el.innerHTML = html;
  }

  buildLoadoutList() {
    const pr = this.game.progress;
    const el = $('loadout-list');
    if (!el) return;
    el.innerHTML = '';
    for (const f of FINISHES) {
      const unlocked = pr.finishUnlocked(f.id);
      const equipped = pr.data.finish === f.id;
      const row = document.createElement('button');
      row.className = 'list-row' + (unlocked ? '' : ' locked');
      const swatch = f.color === null ? '#23262a' : '#' + f.color.toString(16).padStart(6, '0');
      row.innerHTML = `<span style="width:14px;height:14px;background:${swatch};border:1px solid rgba(255,255,255,0.25);display:inline-block"></span>` +
        `<span class="m-main"><span class="m-title">${f.name}</span></span>` +
        `<span class="m-status${unlocked ? '' : ' lock'}">${equipped ? 'EQUIPPED' : unlocked ? 'SELECT' : 'LOCKED — RANK ' + RANKS[f.rank].name}</span>`;
      if (unlocked && !equipped) {
        row.addEventListener('click', () => {
          pr.setFinish(f.id);
          this.game.weapons.applyFinish();
          this.buildLoadoutList();
        });
      }
      el.appendChild(row);
    }
  }

  buildIntelList() {
    const pr = this.game.progress;
    const el = $('intel-list');
    if (!el) return;
    el.innerHTML = '';
    const MAP_NAMES = { facility: 'KESTREL YARD', snow: 'WHITEOUT RELAY', desert: 'DUSTBOWL CACHE', urban: 'GREYLINE DISTRICT', industrial: 'COLD FORGE WORKS', rural: 'OUTSKIRTS' };
    for (const map of Object.keys(MAP_NAMES)) {
      const total = pr.intelTotal(map);
      if (!total) continue;
      const found = pr.intelFoundOn(map);
      const h = document.createElement('div');
      h.className = 'intel-map';
      h.textContent = `${MAP_NAMES[map]} — ${found} / ${total} RECOVERED`;
      el.appendChild(h);
      for (let i = 0; i < total; i++) {
        const it = document.createElement('div');
        const got = pr.isIntelFound(map, i);
        it.className = 'intel-item' + (got ? ' found' : '');
        it.textContent = got ? pr.intelFoundLabel(map, i) : 'UNRECOVERED DOCUMENT';
        el.appendChild(it);
      }
    }
  }

  buildAwardsList() {
    const pr = this.game.progress;
    const el = $('awards-list');
    if (!el) return;
    el.innerHTML = '';
    for (const m of MEDALS) {
      const earned = pr.data.medals.includes(m.id);
      const card = document.createElement('div');
      card.className = 'medal-card' + (earned ? ' earned' : '');
      card.innerHTML = `<span class="medal-icon">🎖</span><div class="medal-name">${m.name}</div><div class="medal-desc">${m.desc}</div>`;
      el.appendChild(card);
    }
  }

  buildStatsList() {
    const pr = this.game.progress;
    const s = pr.data.stats;
    const el = $('stats-list');
    if (!el) return;
    const hrs = Math.floor(s.playTime / 3600), mins = Math.floor((s.playTime % 3600) / 60);
    const acc = s.shots > 0 ? Math.round(s.hits / s.shots * 100) : 0;
    const rows = [
      ['RANK', pr.rank.name + ' · ' + pr.data.xp + ' XP'],
      ['DIFFICULTY', pr.difficulty.name],
      ['MISSIONS COMPLETED', s.missionsCompleted],
      ['MISSIONS FAILED', s.missionsFailed],
      ['TOTAL PLAY TIME', hrs + 'h ' + mins + 'm'],
      ['PRIMARY OBJECTIVES', s.objectivesCompleted],
      ['OPTIONAL OBJECTIVES', s.optionalCompleted],
      ['INTEL DISCOVERED', s.intelFound],
      ['MEDALS EARNED', pr.data.medals.length + ' / ' + MEDALS.length],
      ['SHOTS FIRED', s.shots],
      ['SHOTS HIT', s.hits + ' (' + acc + '%)'],
      ['HEADSHOTS', s.headshots],
      ['HOSTILES NEUTRALISED', s.kills],
      ['DAMAGE TAKEN', Math.round(s.damageTaken)],
      ['SUCCESSFUL EXTRACTIONS', s.extractions],
      ['STEALTH COMPLETIONS', s.stealthCompletions],
      ['CHECKPOINTS USED', s.checkpointsUsed],
      ['BEST PERFORMANCE', s.bestRating + ' / 100'],
    ];
    el.innerHTML = '<div class="stat-grid">' +
      rows.map(r => `<span class="s-label">${r[0]}</span><span class="s-val">${r[1]}</span>`).join('') +
      '</div>';
  }

  /** post-mission debrief: objectives, performance, medals, XP, unlocks */
  showDebrief(result, def, ctx) {
    const pr = this.game.progress;
    const body = $('debrief-body');
    const acc = ctx.shots > 0 ? Math.round(ctx.hits / ctx.shots * 100) : 0;
    const mm = Math.floor(ctx.timeSec / 60), ss = Math.floor(ctx.timeSec % 60);
    const optLines = (ctx.optionals || []).map(o =>
      `<div class="debrief-row"><span>${o.text}</span><b class="${o.done ? 'ok' : 'bad'}">${o.done ? '✓ DONE' : '✗ MISSED'}</b></div>`).join('');
    const medalChips = result.allMedals.map(id => {
      const m = MEDALS.find(x => x.id === id);
      const isNew = result.newMedals.includes(id);
      return `<span class="medal-chip${isNew ? ' new' : ''}">${m ? m.name : id}</span>`;
    }).join('') || '<span class="debrief-row">NO MEDALS THIS RUN</span>';
    const unlocks = result.unlocks.map(x => `<div class="unlock-line">UNLOCKED — ${x}</div>`).join('');
    body.innerHTML = `
      <div class="debrief-sec">
        <h3>MISSION</h3>
        <div class="debrief-row"><span>${def.title}</span><b>${(def.type || 'infiltration').toUpperCase()} · ${pr.difficulty.name}</b></div>
        <div class="debrief-row"><span>STATUS</span><b class="ok">COMPLETE — EXTRACTED</b></div>
      </div>
      <div class="debrief-sec">
        <h3>OBJECTIVES</h3>
        <div class="debrief-row"><span>PRIMARY OBJECTIVES</span><b class="ok">✓ ${ctx.objectivesDone}/${ctx.objectivesTotal}</b></div>
        <div class="debrief-row"><span>OPTIONAL OBJECTIVES</span><b>${ctx.optionalDone}/${ctx.optionalTotal}</b></div>
        ${optLines}
      </div>
      <div class="debrief-sec">
        <h3>PERFORMANCE</h3>
        <div class="debrief-row"><span>ACCURACY</span><b>${acc}% (${ctx.hits}/${ctx.shots})</b></div>
        <div class="debrief-row"><span>DAMAGE TAKEN</span><b>${Math.round(ctx.damageTaken)}</b></div>
        <div class="debrief-row"><span>TIME</span><b>${mm}:${ss.toString().padStart(2, '0')}${ctx.parTime ? ' · PAR ' + ctx.parTime + 's' : ''}</b></div>
        <div class="debrief-row"><span>ALERT LEVEL</span><b class="${ctx.alarm ? 'bad' : 'ok'}">${ctx.alarm ? 'MAJOR ALERT TRIGGERED' : 'GHOST — NO MAJOR ALERT'}</b></div>
        <div class="debrief-row"><span>INTELLIGENCE</span><b>${ctx.intelFound}/${ctx.intelTotal}</b></div>
        <div class="debrief-row"><span>CHECKPOINTS USED</span><b>${ctx.checkpointsUsed}</b></div>
      </div>
      <div class="rating-big"><div class="r-num">${result.rating}</div><div class="r-label">PERFORMANCE RATING</div></div>
      <div class="debrief-sec">
        <h3>AWARDS</h3>
        <div class="medal-strip">${medalChips}</div>
      </div>
      <div class="debrief-sec xp-strip">
        <h3>PROGRESSION</h3>
        <div class="debrief-row"><span>XP GAINED</span><b>+${result.xp}</b></div>
        <div class="debrief-row"><span>RANK</span><b>${pr.rank.name}${result.rankUp ? ' → ' + result.rankUp : ''}</b></div>
        <div class="xp-bar"><i style="width:${Math.round(pr.rankProgress * 100)}%"></i></div>
        ${unlocks}
      </div>`;
    this.showScreen('complete');
  }

  armorFlash() {
    if (this._armorFlashT > 0) return;
    this._armorFlashT = 0.35;
    this.armorFlashEl();
  }
  armorFlashEl() { if (this.armorFill) this.armorFill.classList.add('flash'); }

  toggleTacMap() {
    if (this.game.tacmap) this.game.tacmap.toggle();
  }
  closeTacMap() {
    if (this.game.tacmap) this.game.tacmap.close(true);
  }

  _drawCompass() {
    const ctx = this.compassCtx;
    if (!ctx) return;
    const g = this.game, p = g.player;
    const W = 440, cx = W / 2, ppd = 2.9;
    ctx.clearRect(0, 0, W, 36);
    const cb = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    ctx.textAlign = 'center';
    for (let t = 0; t < 360; t += 7.5) {
      const d = ((t - cb + 540) % 360) - 180;
      if (Math.abs(d) > 74) continue;
      const x = cx + d * ppd;
      const major = t % 90 === 0, mid = t % 45 === 0;
      ctx.strokeStyle = major ? 'rgba(220,240,225,0.9)' : mid ? 'rgba(180,210,190,0.55)' : 'rgba(150,180,160,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, major ? 15 : mid ? 12 : 10); ctx.stroke();
      if (major) {
        const lbl = t === 0 ? 'N' : t === 90 ? 'E' : t === 180 ? 'S' : 'W';
        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = 'rgba(225,245,230,0.95)';
        ctx.fillText(lbl, x, 27);
      } else if (mid) {
        ctx.font = '8px monospace';
        ctx.fillStyle = 'rgba(170,200,180,0.6)';
        ctx.fillText(String(t), x, 26);
      }
    }
    const tgt = g.missions.compassTarget ? g.missions.compassTarget() : null;
    if (tgt) {
      const dx = tgt.x - p.pos.x, dz = tgt.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      const tb = ((Math.atan2(dx, -dz) * 180 / Math.PI) % 360 + 360) % 360;
      const d = ((tb - cb + 540) % 360) - 180;
      const xe = Math.max(12, Math.min(W - 12, cx + d * ppd));
      const onStrip = Math.abs(d) <= 74;
      ctx.fillStyle = onStrip ? '#ffd479' : 'rgba(255,212,121,0.5)';
      ctx.beginPath();
      ctx.moveTo(xe, 1); ctx.lineTo(xe + 5, 7); ctx.lineTo(xe, 13); ctx.lineTo(xe - 5, 7);
      ctx.closePath(); ctx.fill();
      if (onStrip) {
        ctx.font = '8px monospace';
        ctx.fillText(Math.round(dist) + 'm', xe, 35);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 3); ctx.lineTo(cx, 17); ctx.stroke();
  }

  radio(text) {
    if (!this.radioEl) return;
    this.radioEl.textContent = '▸ ' + text;
    this.radioEl.classList.add('show');
    this._radioT = 3.2;
    this.subtitle('COMMS', text, 3.6);
  }

  /** Subtitle line for comms / briefings / important updates (spec §47). */
  subtitle(tag, text, secs = 4) {
    if (this.game.settings && !this.game.settings.subtitles) return;
    const el = $('subtitle-line');
    if (!el) return;
    $('subtitle-tag').textContent = '[' + tag + ']';
    $('subtitle-text').textContent = text;
    el.classList.remove('hidden');
    this._subT = secs;
  }
  setPinned(on) {
    if (!this.pinnedEl) return;
    this.pinnedEl.classList.toggle('show', !!on);
  }

  updateHUD(dt) {
    const g = this.game;
    const p = g.player;
    const ws = g.weapons;

    // subtitles auto-hide
    if (this._subT > 0) {
      this._subT -= dt;
      if (this._subT <= 0) { const sl = $('subtitle-line'); if (sl) sl.classList.add('hidden'); }
    }

    // live distance + compass direction to the CURRENT objective (spec §26)
    if (g.missions && g.missions.currentObjectivePos && this.objSub) {
      const op = g.missions.currentObjectivePos();
      if (op) {
        const dx = op.x - p.pos.x, dz = op.z - p.pos.z;
        const dist = Math.round(Math.hypot(dx, dz));
        let ang = Math.atan2(dx, -dz) * 180 / Math.PI;   // 0 = north (-Z), clockwise
        if (ang < 0) ang += 360;
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const dir = dirs[Math.round(ang / 45) % 8];
        const txt = dist + ' m · ' + dir;
        if (txt !== this._objDist) {
          this._objDist = txt;
          this.objSub.textContent = (this._objSubBase ? this._objSubBase + ' · ' : '') + txt + ' · [M] MAP';
        }
      } else if (this._objDist) {
        this._objDist = '';
        this.objSub.textContent = this._objSubBase || '';
      }
    }

    // timers
    if (this._radioT > 0) {
      this._radioT -= dt;
      if (this._radioT <= 0) this.radioEl.classList.remove('show');
    }
    if (this.fragEl) this.fragEl.textContent = 'FRAG ×' + (p.frags || 0);
    if (this.armorFill) {
      this.armorFill.style.width = Math.max(0, Math.min(100, p.armor || 0)) + '%';
      if (this._armorFlashT > 0) {
        this._armorFlashT -= dt;
        if (this._armorFlashT <= 0) this.armorFill.classList.remove('flash');
      }
    }
    if (this.bandageEl) {
      const bandaging = p.bandageT > 0.05;
      this.bandageEl.classList.toggle('hidden', !bandaging);
      if (bandaging && this.bandageFill) this.bandageFill.style.width = (p.bandageT / 2.8 * 100) + '%';
    }
    this._drawCompass();
    const tm = g.tacmap;
    if (tm) { if (tm.open) tm.drawFull(); else tm.drawMini(); }
    const lvl = g.enemies.alertLevel || 'unaware';
    if (lvl !== this._alertLvl) {
      this._alertLvl = lvl;
      if (this.alertChip) {
        this.alertChip.textContent = lvl.toUpperCase();
        this.alertChip.className = lvl === 'unaware' ? 'hidden' : lvl;
      }
    }
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.toastEl.classList.remove('show');
    }
    if (this._hitmarkerT > 0) {
      this._hitmarkerT -= dt;
      if (this._hitmarkerT <= 0) { this.hitmarker.classList.remove('show'); this.hitmarker.classList.add('hidden'); }
    }
    for (const d of this._dmgPool) {
      if (d.t > 0) {
        d.t -= dt;
        if (d.t <= 0) d.el.style.opacity = '0';
      }
    }
    if (this._briefT > 0) {
      this._briefT -= dt;
      this.setInteract(this._briefMsg);
      if (this._briefT <= 0) this._briefMsg = null;
    }

    // compass
    const bearing = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const x = -(bearing - COMPASS_WINDOW / 2 / COMPASS_PX_PER_DEG) * COMPASS_PX_PER_DEG;
    this.compassStrip.style.transform = `translateX(${x.toFixed(1)}px)`;

    // ammo / weapon
    const st = ws.st, def = ws.def;
    if (this._c.mag !== st.mag) { this.ammoMag.textContent = String(st.mag); this._c.mag = st.mag; }
    if (this._c.res !== st.reserve) { this.ammoReserve.textContent = String(st.reserve); this._c.res = st.reserve; }
    this.ammoMag.classList.toggle('low', st.mag <= def.magSize * 0.25);
    // §13: auto-suggest reload when the magazine runs dry — one-shot toast +
    // pulsing RELOAD button on touch (never blocking)
    const rldBtn = this._rldBtn || (this._rldBtn = document.getElementById('tbtn-reload'));
    if (st.mag === 0 && st.reserve > 0 && g.handsMode === 'gun') {
      if (rldBtn) rldBtn.classList.add('suggest');
      if (!this._dryWarned) { this._dryWarned = true; this.toastBrief('MAGAZINE EMPTY — RELOAD'); }
    } else {
      if (rldBtn) rldBtn.classList.remove('suggest');
      if (st.mag > 0) this._dryWarned = false;
    }
    // total rounds + reload state (C3)
    const total = st.mag + st.reserve;
    if (this._c.total !== total) {
      if (this.ammoTotal) this.ammoTotal.textContent = 'Σ ' + total;
      this._c.total = total;
    }
    // throwable / utility row
    const th = g.throwables;
    if (th && this.throwRow) {
      const tid = th.equipped || 'vxfrag';
      const tName = THROWABLE_DEFS[tid] ? THROWABLE_DEFS[tid].name : '—';
      let txt = tName + ' ×' + th.count(tid);
      if (th.utility && THROWABLE_DEFS[th.utility]) txt += '   ·   ' + THROWABLE_DEFS[th.utility].name + ' ×' + th.count(th.utility);
      if (this._c.throwTxt !== txt) { this.throwRow.textContent = txt; this._c.throwTxt = txt; }
      this.throwRow.classList.remove('hidden');
      this.throwRow.classList.toggle('hl-throw', g.handsMode === 'throwable');
      this.throwRow.classList.toggle('hl-util', g.handsMode === 'utility');
    }
    // flashbang whiteout decay
    if (this._fb > 0) {
      this._fb = Math.max(0, this._fb - dt * 1.05);
      if (this.flashbangEl) this.flashbangEl.style.opacity = this._fb.toFixed(3);
    }
    if (this._c.wpn !== ws.currentId) {
      this.weaponName.textContent = `${def.name} — ${def.klass}`;
      this._c.wpn = ws.currentId;
    }
    let stateTxt = '';
    if (ws.state_ === 'reloading') stateTxt = st.malf ? 'RACKING BOLT' : 'RELOADING';
    else if (st.malf) stateTxt = 'MALFUNCTION — R TO CLEAR';
    else if (st.mag === 0) stateTxt = 'MAGAZINE EMPTY — R';
    else if (p.armInjury > 0) stateTxt = 'HANDLING IMPAIRED';
    if (this._c.wstate !== stateTxt) { this.weaponState.textContent = stateTxt; this._c.wstate = stateTxt; }

    // vitals
    const hp = Math.ceil(p.health);
    if (this._c.hp !== hp) {
      this.healthFill.style.width = `${hp}%`;
      this.healthNum.textContent = String(hp);
      this._c.hp = hp;
    }
    this.healthFill.classList.toggle('critical', hp < 30);
    const sp = Math.floor(p.stamina);
    if (this._c.sp !== sp) {
      this.staminaFill.style.width = `${sp}%`;
      this._c.sp = sp;
    }
    this.staminaFill.classList.toggle('exhausted', p.exhausted);

    // low-health vignette
    const low = p.health < 45 ? (1 - p.health / 45) * 0.55 : 0;
    this.vignette.style.opacity = String(0.7 + low);

    // crosshair: gap from live weapon dispersion, hidden when aiming down sights
    const ads = ws.adsT > 0.55;
    if (this._c.ads !== ads) {
      this.crosshair.style.opacity = ads ? '0' : '1';
      this._c.ads = ads;
    }
    if (!ads) {
      const spread = ws.currentSpreadDegrees();
      const gap = 5 + spread * 3.4;
      if (Math.abs((this._c.gap || 0) - gap) > 0.4) {
        this._c.gap = gap;
        const ticks = this.crosshair.children;
        ticks[0].style.transform = `translateY(${-gap - 7}px)`;
        ticks[1].style.transform = `translateY(${gap}px)`;
        ticks[2].style.transform = `translateX(${-gap - 7}px)`;
        ticks[3].style.transform = `translateX(${gap}px)`;
      }
    }

    // stance indicator
    let stanceTxt = '';
    if (!p.onGround) stanceTxt = 'AIRBORNE';
    else if (p.crouching) stanceTxt = 'CROUCHED';
    else if (p.sprinting) stanceTxt = 'SPRINTING';
    else if (ads) stanceTxt = 'AIMING';
    if (this._c.stance !== stanceTxt) { this.stance.textContent = stanceTxt; this._c.stance = stanceTxt; }

    // fps counter (performance mode)
    this._fpsFrames++;
    this._fpsT += dt;
    if (this._fpsT >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsT);
      this.fps.textContent = `${fps} FPS`;
      this._fpsT = 0; this._fpsFrames = 0;
    }
    this.fps.classList.toggle('hidden', !g.settings.perfMode);
  }

  // -------------------------------------------------------------------------
  showDeath(cause, hasCheckpoint) {
    $('death-cause').textContent = cause || 'You were eliminated by hostile fire.';
    $('btn-death-cp').style.display = hasCheckpoint ? '' : 'none';
    this.showScreen('death');
  }

  showFailed(reason, hasCheckpoint) {
    $('failed-reason').textContent = reason;
    $('btn-failed-cp').style.display = hasCheckpoint ? '' : 'none';
    this.showScreen('failed');
  }

  syncDifficultyControl() {
    const sel = $('set-difficulty');
    const pr = this.game.progress;
    if (sel) sel.value = pr.data.difficulty;
    const desc = $('difficulty-desc');
    if (desc) desc.textContent = pr.difficulty.desc;
  }

  /** Compact bottom navigation for touch devices (menu-side screens only). */
  _bindMobNav() {
    if (!this.mobnav) return;
    const go = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        if (this.game.audio && this.game.audio.ready) this.game.audio.uiConfirm();
        fn();
      });
    };
    go('mn-home', () => { this.refreshMenuBadges(); this.showScreen('menu'); });
    go('mn-missions', () => { this.buildMissionsList(); this.showScreen('missions'); });
    go('mn-loadout', () => this.showScreen('select'));
    go('mn-intel', () => { this.buildIntelList(); this.showScreen('intel'); });
    go('mn-settings', () => this.showScreen('settings'));
  }

  _updateMobNav(name) {
    if (!this.mobnav) return;
    const menuScreens = ['menu', 'select', 'missions', 'loadout', 'intel', 'awards', 'stats', 'settings', 'credits', 'brief'];
    const show = !!this.game._touchPrimary && menuScreens.indexOf(name) >= 0;
    this.mobnav.classList.toggle('hidden', !show);
    const map = { menu: 'mn-home', missions: 'mn-missions', select: 'mn-loadout', brief: 'mn-loadout', intel: 'mn-intel', settings: 'mn-settings' };
    for (const id of ['mn-home', 'mn-missions', 'mn-loadout', 'mn-intel', 'mn-settings']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('on', map[name] === id);
    }
  }

  syncSettingsControls(settings) {
    $('set-sens').value = settings.sensitivity;
    $('val-sens').textContent = settings.sensitivity.toFixed(2);
    $('set-fov').value = settings.fov;
    $('val-fov').textContent = String(settings.fov);
    $('set-master').value = settings.masterVolume;
    $('val-master').textContent = settings.masterVolume.toFixed(2);
    $('set-sfx').value = settings.sfxVolume;
    $('val-sfx').textContent = settings.sfxVolume.toFixed(2);
    $('set-amb').value = settings.ambVolume;
    $('val-amb').textContent = settings.ambVolume.toFixed(2);
    $('set-quality').value = settings.quality;
    $('set-perf').checked = !!settings.perfMode;
    $('set-daymode').checked = !!settings.dayMode;
    const mm = $('set-minimap'); if (mm) mm.checked = settings.minimapOn !== false;
    const mms = $('set-minimap-size'); if (mms) mms.value = settings.minimapSize || 'm';
    const mmo = $('set-minimap-opacity'); if (mmo) mmo.value = settings.minimapOpacity != null ? settings.minimapOpacity : 0.85;
    const mmov = $('val-minimap-opacity'); if (mmov) mmov.textContent = (settings.minimapOpacity != null ? settings.minimapOpacity : 0.85).toFixed(2);
    const mmr = $('set-minimap-rotate'); if (mmr) mmr.value = settings.minimapRotate || 'north';
    const vi = $('set-veh-invert'); if (vi) vi.checked = !!settings.vehSteerInvert;
    const vs = $('set-veh-sens'); if (vs) vs.value = settings.vehSteerSens != null ? settings.vehSteerSens : 1;
    const vsv = $('val-veh-sens'); if (vsv) vsv.textContent = (settings.vehSteerSens != null ? settings.vehSteerSens : 1).toFixed(2);
    const vc = $('set-veh-cam'); if (vc) vc.value = settings.vehCamDist != null ? settings.vehCamDist : 1;
    const vcv = $('val-veh-cam'); if (vcv) vcv.textContent = (settings.vehCamDist != null ? settings.vehCamDist : 1).toFixed(2);

    // Stage D — touch + accessibility controls
    const rng = (id, valId, key, dflt) => {
      const el = $(id); if (el) el.value = settings[key] != null ? settings[key] : dflt;
      const vv = $(valId); if (vv) vv.textContent = (settings[key] != null ? settings[key] : dflt).toFixed(2);
    };
    const chk = (id, key, dflt) => { const el = $(id); if (el) el.checked = settings[key] != null ? !!settings[key] : !!dflt; };
    const sel = (id, key, dflt) => { const el = $(id); if (el) el.value = settings[key] || dflt; };
    sel('set-touch-mode', 'touchControls', 'auto');
    rng('set-look-sens', 'val-look-sens', 'lookSens', 1);
    rng('set-aim-sens', 'val-aim-sens', 'aimSens', 0.8);
    rng('set-joy-size', 'val-joy-size', 'joySize', 1);
    rng('set-look-stick-size', 'val-look-stick-size', 'lookStickSize', 1);
    rng('set-joy-opacity', 'val-joy-opacity', 'joyOpacity', 0.55);
    rng('set-btn-size', 'val-btn-size', 'btnSize', 1);
    rng('set-btn-opacity', 'val-btn-opacity', 'btnOpacity', 0.8);
    rng('set-hud-scale', 'val-hud-scale', 'hudScale', 1);
    rng('set-shake', 'val-shake', 'shakeScale', 1);
    sel('set-aim-mode', 'aimMode', 'hold');
    sel('set-aim-assist', 'aimAssist', 'low');
    chk('set-invert-y', 'invertY', false);
    chk('set-auto-sprint', 'autoSprint', true);
    chk('set-auto-fire', 'autoFire', false);
    chk('set-vibration', 'vibration', true);
    chk('set-contrast', 'highContrast', false);
    chk('set-large-text', 'largeText', false);
    chk('set-reduce-motion', 'reduceMotion', false);
    chk('set-subtitles', 'subtitles', true);
    const mmsV = $('val-minimap-size'); if (mmsV) mmsV.textContent = (settings.minimapSize || 'm').toUpperCase();
    const mmrV = $('val-minimap-rotate'); if (mmrV) mmrV.textContent = (settings.minimapRotate || 'north').toUpperCase();
  }
}

void THREE;
