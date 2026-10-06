/**
 * tacmap.js
 * Live tactical map + HUD mini-map for OPERATION: BLACK VECTOR.
 *
 * Lightweight 2D top-down representation (never a second 3D world):
 *  - terrain from the physics collider list, drawn per-material
 *  - fog of war on a coarse grid: unexplored areas stay hidden,
 *    explored areas stay revealed (KNOWN vs LIVE information)
 *  - markers centralised through missions.mapTargets() so objectives,
 *    optionals and extraction update automatically with the mission system
 *  - enemies appear only when the player has a reason to know about them
 *    (visual detection, or they have the player under observation);
 *    stale contacts fade and drop off
 *  - zoom (wheel + buttons), player-centred / north-up rotation, optional
 *    route line to PRIMARY / OPTIONAL / EXTRACTION target
 *  - mini-map with independent size / opacity / rotation settings
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

const MAT_COLOR = {
  concrete: '#39424a', metal: '#4b5866', wood: '#5d4a33',
  glass: 'rgba(120,200,255,0.4)', soil: '#2e2a22',
  gravel: '#33302a', fabric: '#3a3540',
};

export class TacticalMap {
  constructor(game) {
    this.game = game;
    this.open = false;
    this.zoom = 1;
    this.panX = 0; this.panY = 0;      // world-metre view offset (touch pan)
    this.minZoom = 0.45;
    this.maxZoom = 3.5;
    this.rotateMode = 'player';          // 'player' | 'north' (full map)
    this.routeSel = 'primary';           // 'primary' | 'optional' | 'extraction' | null
    this.fog = null;
    this.known = new Map();              // enemy → {x, z, t}
    this.knownNpc = new Map();           // npc → {x, z, t}
    this._detectT = 0;
    this._fogCv = document.createElement('canvas');
    this._fogCtx = this._fogCv.getContext('2d');
    this._fogImg = null;
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.fullCv = document.getElementById('tacmap-canvas');
    this.fullCtx = this.fullCv ? this.fullCv.getContext('2d') : null;
    this.miniCv = document.getElementById('minimap');
    this.miniCtx = this.miniCv ? this.miniCv.getContext('2d') : null;
    this.el = document.getElementById('tacmap');

    if (this.fullCv) {
      this.fullCv.addEventListener('touchstart', (e) => this._touchMap(e, 'start'), { passive: false });
      this.fullCv.addEventListener('touchmove', (e) => this._touchMap(e, 'move'), { passive: false });
      this.fullCv.addEventListener('touchend', (e) => this._touchMap(e, 'end'), { passive: false });
      this.fullCv.addEventListener('touchcancel', (e) => this._touchMap(e, 'end'), { passive: false });
      this.fullCv.addEventListener('wheel', e => {
        if (!this.open) return;
        e.preventDefault();
        this.setZoom(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
    }
  }

  // ---------------------------------------------------------------------
  // mission lifecycle
  // ---------------------------------------------------------------------
  reset() {
    const g = this.game;
    const b = (g.world && g.world.bounds) || { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
    const cell = 3, m = 9;
    const gw = Math.max(8, Math.ceil((b.maxX - b.minX + 2 * m) / cell));
    const gh = Math.max(8, Math.ceil((b.maxZ - b.minZ + 2 * m) / cell));
    this.fog = { cell, x0: b.minX - m, z0: b.minZ - m, gw, gh, data: new Uint8Array(gw * gh) };
    this._fogCv.width = gw; this._fogCv.height = gh;
    this._fogImg = this._fogCtx.createImageData(gw, gh);
    this.known.clear();
    this.knownNpc.clear();
    this.zoom = 1;
    this.panX = 0; this.panY = 0;
    this.routeSel = 'primary';
    this.close(true);
  }

  get fogPct() {
    if (!this.fog) return 0;
    let n = 0;
    for (let i = 0; i < this.fog.data.length; i++) if (this.fog.data[i]) n++;
    return n / this.fog.data.length;
  }

  // ---------------------------------------------------------------------
  // open / close (partial pause: the sim freezes while the map is up)
  // ---------------------------------------------------------------------
  toggle() { this.open ? this.close() : this.openMap(); }

  openMap() {
    const g = this.game;
    if (g.state !== 'playing' || this.open) return;
    this.open = true;
    this.panX = 0; this.panY = 0;
    if (this.el) this.el.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    g.stats.mapOpens = (g.stats.mapOpens || 0) + 1;
    this._syncControls();
    this.drawFull();
  }

  close(silent = false) {
    const g = this.game;
    this.open = false;
    if (this.el) this.el.classList.add('hidden');
    if (!silent && g.state === 'playing' && g._requestLock) g._requestLock();
  }

  setZoom(step) {
    this.zoom = THREE.MathUtils.clamp(this.zoom * (step > 0 ? 1.25 : 0.8), this.minZoom, this.maxZoom);
    this._syncControls();
    this.drawFull();
  }

  setRotate(mode) {
    this.rotateMode = mode;
    this._syncControls();
    this.drawFull();
  }

  setRoute(sel) {
    this.routeSel = this.routeSel === sel ? null : sel;
    this._syncControls();
    this.drawFull();
  }

  _syncControls() {
    const set = (id, txt) => { const e = document.getElementById(id); if (e && txt != null) e.textContent = txt; };
    set('tac-zoomval', this.zoom.toFixed(1) + '×');
    set('tac-rotbtn', this.rotateMode === 'player' ? 'ROT: PLAYER-UP' : 'ROT: NORTH-UP');
    set('tac-routebtn', 'ROUTE: ' + (this.routeSel ? this.routeSel.toUpperCase() : 'OFF'));
  }

  // ---------------------------------------------------------------------
  // per-frame knowledge + fog updates (runs while the sim is live)
  // ---------------------------------------------------------------------
  update(dt) {
    const g = this.game;
    if (!this.fog || g.state !== 'playing') return;
    const p = g.player.pos;
    this._reveal(p.x, p.z, 15);
    this._detectT -= dt;
    if (this._detectT <= 0) {
      this._detectT = 0.25;
      this._scanView();
    }
    // prune stale contacts
    for (const [e, k] of this.known) if (g.time - k.t > 26 || !e.alive) this.known.delete(e);
    for (const [n, k] of this.knownNpc) if (g.time - k.t > 26) this.knownNpc.delete(n);
  }

  _reveal(x, z, r) {
    const f = this.fog, cr = Math.ceil(r / f.cell);
    const ci = Math.floor((x - f.x0) / f.cell), cj = Math.floor((z - f.z0) / f.cell);
    const r2 = r * r;
    for (let j = Math.max(0, cj - cr); j <= Math.min(f.gh - 1, cj + cr); j++) {
      for (let i = Math.max(0, ci - cr); i <= Math.min(f.gw - 1, ci + cr); i++) {
        const wx = f.x0 + (i + 0.5) * f.cell, wz = f.z0 + (j + 0.5) * f.cell;
        const dx = wx - x, dz = wz - z;
        if (dx * dx + dz * dz <= r2) f.data[j * f.gw + i] = 1;
      }
    }
  }

  _cellAt(x, z) {
    const f = this.fog;
    const i = Math.floor((x - f.x0) / f.cell), j = Math.floor((z - f.z0) / f.cell);
    if (i < 0 || j < 0 || i >= f.gw || j >= f.gh) return 1; // outside bounds counts as open
    return f.data[j * f.gw + i];
  }

  _scanView() {
    const g = this.game, p = g.player;
    const eye = this._v1.copy(g.camera.position);
    const yaw = p.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // view-cone fog reveal: 9 rays, stepped until blocked
    for (let r = -4; r <= 4; r++) {
      const a = r * 14 * DEG;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fx * ca - fz * sa, dz = fx * sa + fz * ca;
      for (let d = 8; d <= 52; d += 8) {
        const tx = eye.x + dx * d, tz = eye.z + dz * d;
        this._v2.set(tx, 1.0, tz);
        if (!g.physics.hasLOS(eye, this._v2) || (g.throwables && g.throwables.smokeBlocksLOS(eye, this._v2))) break;
        this._reveal(tx, tz, 5);
      }
    }
    // hostile knowledge: player sees them, or they are actively engaging the player
    const px = p.pos.x, pz = p.pos.z;
    for (const e of g.enemies.list) {
      if (!e.alive) { this.known.delete(e); continue; }
      const dx = e.pos.x - px, dz = e.pos.z - pz;
      const d2 = dx * dx + dz * dz;
      let sees = false;
      if (d2 < 75 * 75) {
        const dot = (dx * fx + dz * fz) / Math.sqrt(Math.max(d2, 0.01));
        if (dot > 0.34 || e.hasLOS) {           // ~140° cone, or the enemy has YOU pinned
          e.eyePos(this._v2); this._v2.y -= 0.15;
          sees = (g.physics.hasLOS(eye, this._v2) && !(g.throwables && g.throwables.smokeBlocksLOS(eye, this._v2))) || (e.hasLOS && d2 < 90 * 90);
        }
      }
      if (!sees && g.throwables && g.throwables.revealCovers(e.pos)) sees = true;  // flare / sensor coverage
      if (sees) this.known.set(e, { x: e.pos.x, z: e.pos.z, t: g.time });
    }
    // friendly knowledge: escorted contact is always known; others when close & visible
    if (g.enemies.npcs) {
      for (const n of g.enemies.npcs) {
        const dx = n.pos.x - px, dz = n.pos.z - pz;
        const d2 = dx * dx + dz * dz;
        const auto = n === g.enemies.escortNpc && n.contacted;
        if (auto || (d2 < 45 * 45 && g.physics.hasLOS(eye, this._v2.set(n.pos.x, n.pos.y + 1.2, n.pos.z)))) {
          this.knownNpc.set(n, { x: n.pos.x, z: n.pos.z, t: g.time });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // drawing helpers
  // ---------------------------------------------------------------------
  _applyTransform(ctx, cx, cz, px, pz, scale, rotPlayer, yaw) {
    ctx.translate(cx, cz);
    if (rotPlayer) ctx.rotate(yaw);
    ctx.scale(scale, scale);
    ctx.translate(-px, -pz);
  }

  _drawTerrain(ctx, g, viewR) {
    const px = g.player.pos.x, pz = g.player.pos.z;
    const cols = g.physics.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c.enabled || c.max.y - c.min.y < 0.45) continue;
      const mx = (c.min.x + c.max.x) / 2, mz = (c.min.z + c.max.z) / 2;
      if (Math.abs(mx - px) > viewR || Math.abs(mz - pz) > viewR) continue;
      ctx.fillStyle = MAT_COLOR[c.material] || '#39424a';
      const w = Math.max(c.max.x - c.min.x, 0.35), d = Math.max(c.max.z - c.min.z, 0.35);
      ctx.fillRect(c.min.x, c.min.z, w, d);
    }
    // doors
    ctx.fillStyle = '#59d8e8';
    for (const dr of g.world.doors) {
      ctx.fillRect(dr.pos.x - 0.7, dr.pos.z - 0.7, 1.4, 1.4);
    }
  }

  _drawFog(ctx) {
    const f = this.fog;
    if (!f || !this._fogImg) return;
    const d = this._fogImg.data;
    for (let i = 0; i < f.data.length; i++) {
      const o = i * 4;
      if (f.data[i]) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0; }
      else { d[o] = 6; d[o + 1] = 9; d[o + 2] = 13; d[o + 3] = 238; }
    }
    this._fogCtx.putImageData(this._fogImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._fogCv, f.x0, f.z0, f.gw * f.cell, f.gh * f.cell);
  }

  _diamond(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath(); ctx.fill();
  }

  _label(ctx, x, y, text, color, scale) {
    ctx.save();
    ctx.scale(1 / scale, 1 / scale);          // keep text size constant on screen
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x * scale, (y + 2.6) * scale);
    ctx.restore();
  }

  _drawMarkers(ctx, g, scale, labels) {
    const t = g.time;
    // important interactables + evidence, only inside revealed fog
    for (const it of g.world.interactables) {
      if (it.used) continue;
      const id = it.id;
      const important = id === 'generator' || id === 'terminal' || id === 'npc_contact' ||
        id === 'radio_records' || id.startsWith('charge_') || id.startsWith('evidence_') || id.startsWith('obs_');
      if (!important) continue;
      if (!this._cellAt(it.pos.x, it.pos.z)) continue;
      const col = id.startsWith('evidence_') || id.startsWith('obs_') ? '#c9a24b' : '#e8d259';
      ctx.fillStyle = col;
      ctx.fillRect(it.pos.x - 0.8, it.pos.z - 0.8, 1.6, 1.6);
    }
    // discovered intel (recovered) + remaining intel as dim optionals
    for (const it of g.world.interactables) {
      if (!it.id.startsWith('intel_')) continue;
      if (!this._cellAt(it.pos.x, it.pos.z)) continue;
      if (it.used) this._diamond(ctx, it.pos.x, it.pos.z, 1.7, '#ffe066');
      else { ctx.globalAlpha = 0.4; this._diamond(ctx, it.pos.x, it.pos.z, 1.4, '#9aa7b2'); ctx.globalAlpha = 1; }
    }
    // vehicles (Stage C2; guarded so the map works before vehicles exist)
    if (g.vehicles && g.vehicles.list) {
      for (const v of g.vehicles.list) {
        if (!this._cellAt(v.pos.x, v.pos.z) && v !== g.vehicleMode) continue;
        ctx.save();
        ctx.translate(v.pos.x, v.pos.z);
        ctx.rotate(-v.heading);
        ctx.fillStyle = v === g.vehicleMode ? '#bfe8ff' : v.mission ? '#e0a548' : '#8b95a0';
        ctx.fillRect(-v.def.hl, -v.def.wd / 2, v.def.hl * 2, v.def.wd);
        ctx.restore();
      }
    }
    // friendly NPCs (known)
    ctx.fillStyle = '#6fa8ff';
    for (const [n, k] of this.knownNpc) {
      const live = t - k.t < 3;
      const x = live ? n.pos.x : k.x, z = live ? n.pos.z : k.z;
      ctx.globalAlpha = live ? 1 : Math.max(0.25, 1 - (t - k.t) / 26);
      ctx.beginPath(); ctx.arc(x, z, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // known hostiles: live position while fresh, last-known with decay when stale
    for (const [e, k] of this.known) {
      const age = t - k.t;
      const live = age < 2.5;
      const x = live ? e.pos.x : k.x, z = live ? e.pos.z : k.z;
      ctx.globalAlpha = live ? 0.95 : Math.max(0.12, 1 - age / 26);
      ctx.fillStyle = live ? '#ff5c47' : '#b3493c';
      ctx.beginPath(); ctx.arc(x, z, live ? 1.7 : 1.4, 0, Math.PI * 2); ctx.fill();
      if (!live) {
        ctx.strokeStyle = 'rgba(255,92,71,0.35)';
        ctx.lineWidth = 0.4;
        ctx.beginPath(); ctx.arc(x, z, 2.4, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // mission targets (objectives / optionals / extraction) — briefing knowledge, always drawn
    const targets = g.missions.mapTargets ? g.missions.mapTargets() : [];
    for (const m of targets) {
      if (m.kind === 'extraction') {
        ctx.strokeStyle = '#47d95f'; ctx.lineWidth = Math.max(0.5, 1.6 / scale * 4 / 4);
        ctx.beginPath(); ctx.arc(m.pos.x, m.pos.z, 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(m.pos.x, m.pos.z, 3.2, 0, Math.PI * 2); ctx.stroke();
        if (labels) this._label(ctx, m.pos.x, m.pos.z + 5.4, m.label, '#47d95f', scale);
      } else if (m.kind === 'objective') {
        this._diamond(ctx, m.pos.x, m.pos.z, 2.6, '#47d95f');
        ctx.strokeStyle = 'rgba(71,217,95,0.5)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.arc(m.pos.x, m.pos.z, 4.2 + Math.sin(t * 3) * 0.6, 0, Math.PI * 2); ctx.stroke();
        if (labels) this._label(ctx, m.pos.x, m.pos.z + 5.2, m.label, '#b6f0c2', scale);
      } else {
        this._diamond(ctx, m.pos.x, m.pos.z, 1.5, 'rgba(201,162,75,0.75)');
      }
    }
    return targets;
  }

  _routeTarget(g, targets) {
    if (!this.routeSel) return null;
    if (this.routeSel === 'extraction') return targets.find(t => t.kind === 'extraction') || null;
    if (this.routeSel === 'optional') return targets.find(t => t.kind === 'optional') || null;
    return targets.find(t => t.kind === 'objective') || null;
  }

  _drawRoute(ctx, g, targets, scale) {
    const m = this._routeTarget(g, targets);
    if (!m) return;
    const px = g.player.pos.x, pz = g.player.pos.z;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,212,121,0.8)';
    ctx.lineWidth = 0.7;
    ctx.setLineDash([2.4, 1.8]);
    ctx.beginPath(); ctx.moveTo(px, pz); ctx.lineTo(m.pos.x, m.pos.z); ctx.stroke();
    ctx.setLineDash([]);
    const dist = Math.hypot(m.pos.x - px, m.pos.z - pz);
    const mx = (px + m.pos.x) / 2, mz = (pz + m.pos.z) / 2;
    this._label(ctx, mx, mz, Math.round(dist) + 'm — ' + m.label, '#ffd479', scale);
    ctx.restore();
  }

  _drawPlayer(ctx, g, scale, rotPlayer) {
    // player arrow always at screen centre in player mode; world pos in north mode
    const yaw = g.player.yaw;
    ctx.save();
    ctx.translate(g.player.pos.x, g.player.pos.z);
    if (!rotPlayer) ctx.rotate(-yaw);        // arrow points up when the map rotates with the player
    const s = 1 / scale;                      // constant screen size
    ctx.fillStyle = '#bfe8ff';
    ctx.beginPath();
    ctx.moveTo(0, -7 * s); ctx.lineTo(5 * s, 6 * s); ctx.lineTo(0, 3.4 * s); ctx.lineTo(-5 * s, 6 * s);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // view cone
    ctx.save();
    ctx.translate(g.player.pos.x, g.player.pos.z);
    ctx.rotate(-yaw + (rotPlayer ? 0 : 0));
    ctx.fillStyle = 'rgba(160,220,255,0.10)';
    const r = 34;
    ctx.beginPath(); ctx.moveTo(0, 0);
    const fx = 0, fz = -1; // cone drawn in player frame then rotated
    const ang = Math.atan2(fz, fx);
    ctx.arc(0, 0, r, ang - 0.62, ang + 0.62);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // full map
  // ---------------------------------------------------------------------
  // touch gestures: 1 finger = tap marker (or drag-pan), 2 fingers = pan,
  // pinch = continuous zoom. Handlers live on the map canvas only, so they
  // never interfere with gameplay touch controls underneath.
  // ---------------------------------------------------------------------
  _touchMap(e, phase) {
    if (e.cancelable) e.preventDefault();
    const ts = e.touches;
    if (phase === 'start') {
      this._tmoved = false;
      if (ts.length === 1) {
        this._tmode = 'one';
        this._tlast = { x: ts[0].clientX, y: ts[0].clientY };
        this._tstart = { x: ts[0].clientX, y: ts[0].clientY };
      } else if (ts.length >= 2) {
        this._tmode = 'two';
        this._tpinch = Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
        this._tmid = { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 };
      }
      return;
    }
    if (phase === 'move') {
      if (this._tmode === 'two' && ts.length >= 2) {
        const d = Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
        const mid = { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 };
        if (this._tpinch > 0 && d > 0) this._zoomBy(d / this._tpinch);
        this._tpinch = d;
        this._panByPx(mid.x - this._tmid.x, mid.y - this._tmid.y);
        this._tmid = mid;
        this._tmoved = true;
      } else if (this._tmode === 'one' && ts.length === 1) {
        const dx = ts[0].clientX - this._tlast.x, dy = ts[0].clientY - this._tlast.y;
        if (Math.hypot(ts[0].clientX - this._tstart.x, ts[0].clientY - this._tstart.y) > 12) this._tmoved = true;
        if (this._tmoved) { this._panByPx(dx, dy); this.drawFull(); }
        this._tlast = { x: ts[0].clientX, y: ts[0].clientY };
      }
      return;
    }
    // end
    if (this._tmode === 'one' && !this._tmoved && this._tstart) {
      const rect = this.fullCv.getBoundingClientRect();
      const cx = (this._tstart.x - rect.left) * (this.fullCv.width / rect.width);
      const cy = (this._tstart.y - rect.top) * (this.fullCv.height / rect.height);
      this._selectAt(cx, cy);
    }
    this._tmode = null;
  }

  _zoomBy(f) {
    const z = THREE.MathUtils.clamp(this.zoom * f, this.minZoom, this.maxZoom);
    if (Math.abs(z - this.zoom) < 1e-4) return;
    this.zoom = z;
    this._syncControls();
    this.drawFull();
  }

  /** Pan by a screen-space pixel delta (converts through rotation + scale). */
  _panByPx(dxPx, dyPx) {
    const g = this.game;
    const rect = this.fullCv.getBoundingClientRect();
    const scale = 4.0 * this.zoom * (rect.width / this.fullCv.width);   // css px per metre
    let dx = dxPx / scale, dy = dyPx / scale;
    if (this.rotateMode === 'player') {
      const c = Math.cos(g.player.yaw), s = Math.sin(g.player.yaw);
      const wx = dx * c + dy * s, wy = -dx * s + dy * c;
      dx = wx; dy = wy;
    }
    this.panX = THREE.MathUtils.clamp(this.panX - dx, -140, 140);
    this.panY = THREE.MathUtils.clamp(this.panY - dy, -140, 140);
  }

  /** Tap-to-select: nearest marker under a canvas-space point → details + route. */
  _selectAt(cx, cy) {
    const g = this.game;
    const S = this.fullCv.width;
    const scale = 4.0 * this.zoom;
    let dx = (cx - S / 2) / scale, dy = (cy - S / 2) / scale;
    if (this.rotateMode === 'player') {
      const yaw = -g.player.yaw;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const rx = dx * c - dy * s;
      dy = dx * s + dy * c;
      dx = rx;
    }
    const wx = g.player.pos.x + this.panX + dx;
    const wz = g.player.pos.z + this.panY + dy;

    const cands = [];
    try {
      for (const t of g.missions.mapTargets()) cands.push({ x: t.pos.x, z: t.pos.z, label: t.label, kind: t.kind });
    } catch (e) { /* no mission targets */ }
    if (g.vehicles) for (const v of g.vehicles.list) cands.push({ x: v.pos.x, z: v.pos.z, label: (v.def && v.def.name) || 'VEHICLE', kind: 'vehicle' });
    for (const [, k] of this.known) cands.push({ x: k.x, z: k.z, label: 'KNOWN CONTACT — ' + Math.round(g.time - k.t) + 's OLD', kind: 'enemy' });
    for (const [, k] of this.knownNpc) cands.push({ x: k.x, z: k.z, label: 'FRIENDLY CONTACT', kind: 'friend' });
    for (const it of g.world.interactables) {
      if (it.used) continue;
      const id = it.id;
      const important = id === 'generator' || id === 'terminal' || id === 'npc_contact' ||
        id.startsWith('charge_') || id.startsWith('evidence_') || id.startsWith('crate_') ||
        id.startsWith('wpn_') || id.startsWith('trunk_');
      if (!important) continue;
      if (!this._cellAt(it.pos.x, it.pos.z)) continue;
      cands.push({ x: it.pos.x, z: it.pos.z, label: (it.getPrompt ? it.getPrompt() : it.prompt) || id.toUpperCase(), kind: 'item' });
    }

    const thresh = Math.max(6, 14 / scale);
    let best = null, bd = thresh;
    for (const c of cands) {
      const d = Math.hypot(c.x - wx, c.z - wz);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) {
      this.panX = 0; this.panY = 0; this.drawFull();
      g.ui.toastBrief('MAP RECENTERED ON YOUR POSITION');
      return;
    }
    const ddx = best.x - g.player.pos.x, ddz = best.z - g.player.pos.z;
    const dist = Math.round(Math.hypot(ddx, ddz));
    let ang = Math.atan2(ddx, -ddz) * 180 / Math.PI; if (ang < 0) ang += 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const dir = dirs[Math.round(ang / 45) % 8];
    g.ui.toastBrief(best.label + ' — ' + dist + ' m ' + dir, 2.6);
    if (best.kind === 'objective') this.routeSel = 'primary';
    else if (best.kind === 'optional') this.routeSel = 'optional';
    else if (best.kind === 'extraction') this.routeSel = 'extraction';
    else return;
    this._syncControls();
    this.drawFull();
  }

  // ---------------------------------------------------------------------
  drawFull() {
    const g = this.game, ctx = this.fullCtx;
    if (!ctx || !this.open || !this.fog) return;
    const S = this.fullCv.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070a0e';
    ctx.fillRect(0, 0, S, S);
    const scale = 4.0 * this.zoom;                       // px per metre at zoom 1
    const rotPlayer = this.rotateMode === 'player';
    ctx.save();
    this._applyTransform(ctx, S / 2, S / 2, g.player.pos.x + this.panX, g.player.pos.z + this.panY, scale, rotPlayer, g.player.yaw);
    const viewR = (S / 2) / scale + 8;
    this._drawTerrain(ctx, g, viewR);
    this._drawFog(ctx);
    const targets = this._drawMarkers(ctx, g, scale, this.zoom >= 0.8);
    this._drawRoute(ctx, g, targets, scale);
    this._drawPlayer(ctx, g, scale, rotPlayer);
    ctx.restore();
    // north indicator (screen space)
    ctx.save();
    ctx.translate(S - 26, 26);
    if (rotPlayer) ctx.rotate(-g.player.yaw);
    ctx.strokeStyle = 'rgba(220,240,225,0.85)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(-4, -3); ctx.moveTo(0, -10); ctx.lineTo(4, -3); ctx.stroke();
    ctx.fillStyle = 'rgba(220,240,225,0.9)';
    ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('N', 0, -13);
    ctx.restore();
    // scale bar
    const mPer = 25;
    ctx.strokeStyle = 'rgba(220,240,225,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(14, S - 16); ctx.lineTo(14 + mPer * scale, S - 16); ctx.stroke();
    ctx.fillStyle = 'rgba(220,240,225,0.75)';
    ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText(mPer + 'm', 14, S - 22);
  }

  // ---------------------------------------------------------------------
  // mini-map (HUD)
  // ---------------------------------------------------------------------
  drawMini() {
    const g = this.game, ctx = this.miniCtx;
    if (!ctx || !this.miniCv || !this.fog) return;
    const s = g.settings;
    const show = s.minimapOn && g.state === 'playing' && !this.open;
    this.miniCv.classList.toggle('hidden', !show);
    if (!show) return;
    const sizeKey = s.minimapSize || 'm';
    const px = sizeKey === 's' ? 110 : sizeKey === 'l' ? 190 : 148;
    if (this.miniCv.width !== 180) { this.miniCv.width = 180; this.miniCv.height = 180; }
    this.miniCv.style.width = px + 'px';
    this.miniCv.style.height = px + 'px';
    this.miniCv.style.opacity = String(s.minimapOpacity != null ? s.minimapOpacity : 0.85);
    const S = 180;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#0b1015';
    ctx.fillRect(0, 0, S, S);
    const scale = 2.35;
    const rotPlayer = (s.minimapRotate || 'north') === 'player';
    this._applyTransform(ctx, S / 2, S / 2, g.player.pos.x, g.player.pos.z, scale, rotPlayer, g.player.yaw);
    const viewR = (S / 2) / scale + 6;
    this._drawTerrain(ctx, g, viewR);
    this._drawFog(ctx);
    const targets = this._drawMarkers(ctx, g, scale, false);
    if (this.routeSel) this._drawRoute(ctx, g, targets, scale);
    this._drawPlayer(ctx, g, scale, rotPlayer);
    ctx.restore();
    ctx.strokeStyle = 'rgba(140,170,160,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.stroke();
  }
}
