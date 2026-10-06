/**
 * throwables.js
 * Universal throwable / utility framework for OPERATION: BLACK VECTOR (C3).
 * All items are fictional devices; effects are pure gameplay — arcs, fuses,
 * radii and falloff only, no real-world construction detail.
 *
 * Categories:
 *  - THROWABLES (G to equip, LMB throw, RMB soft/alt toss):
 *      VX-FRAG   — timed fragmentation effect (arc, fuse 2.6s, radius, falloff)
 *      MS-2 SMOKE— deploys a vision-blocking smoke volume (~15s)
 *      FL-8 FLASH— bangs after landing: stuns enemies in radius + LOS, whites out the player if facing it
 *      DC-3 DECOY— emits gunshot reports + noise events for 10s (AI investigates)
 *      SG-1 FLARE— burning marker light: reveals enemies in radius (via LOS) on the tac map, lights night scenes
 *  - UTILITIES (wheel or Digit4; LMB primary use, RMB secondary):
 *      TS-7 SENSOR — tossed deployable: marks enemies within radius on the tac map THROUGH walls (~22s)
 *      BR-X BREACH — PLACE on a surface (LMB), ACTIVATE all placed charges (RMB): blast effect,
 *                    forces doors (even locked), shatters nearby glass, mission state updates flow naturally
 *      FIELD MEDKIT— instant heal + partial armor restore
 *
 * VX-FRAG count remains on player.frags so old saves/checkpoints stay compatible.
 */
import * as THREE from 'three';

export const THROWABLE_DEFS = {
  vxfrag: { id: 'vxfrag', name: 'VX-FRAG', cat: 'throwable', kind: 'frag', max: 3, weight: 0.5, fuse: 2.6, color: 0x3d4a3a },
  smoke: { id: 'smoke', name: 'MS-2 SMOKE', cat: 'throwable', kind: 'smoke', max: 3, weight: 0.5, fuse: 1.1, color: 0x61695e },
  flash: { id: 'flash', name: 'FL-8 FLASH', cat: 'throwable', kind: 'flash', max: 3, weight: 0.4, fuse: 1.5, color: 0x8a8f94 },
  decoy: { id: 'decoy', name: 'DC-3 DECOY', cat: 'throwable', kind: 'decoy', max: 3, weight: 0.4, fuse: 0.5, color: 0x4a4f42 },
  flare: { id: 'flare', name: 'SG-1 FLARE', cat: 'throwable', kind: 'flare', max: 3, weight: 0.4, fuse: 0.9, color: 0xa8452e },
  sensor: { id: 'sensor', name: 'TS-7 SENSOR', cat: 'utility', kind: 'deploy', max: 2, weight: 0.8, fuse: 0.7, color: 0x33454f },
  breach: { id: 'breach', name: 'BR-X BREACH', cat: 'utility', kind: 'place', max: 2, weight: 0.9, fuse: 0, color: 0x6a5030 },
  medkit: { id: 'medkit', name: 'FIELD MEDKIT', cat: 'utility', kind: 'instant', max: 2, weight: 0.6, fuse: 0, color: 0xaab2aa },
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class ThrowableSystem {
  constructor(game) {
    this.game = game;
    this.inv = {};
    for (const id in THROWABLE_DEFS) this.inv[id] = 0;
    this.equipped = null;        // throwable id currently in hand ('throwable' mode)
    this.utility = null;         // utility id currently in hand ('utility' mode)
    this.smokeVolumes = [];      // {pos, r, t}
    this.revealVolumes = [];     // {pos, r, t, los:boolean}
    this.decoys = [];            // {pos, t, next, mesh}
    this.charges = [];           // {pos, mesh, blink}
    this._mats = {};
    for (const id in THROWABLE_DEFS) {
      this._mats[id] = new THREE.MeshStandardMaterial({ color: THROWABLE_DEFS[id].color, roughness: 0.7, metalness: 0.2 });
    }
    this._chargeMat = new THREE.MeshStandardMaterial({ color: 0x6a5030, roughness: 0.6, metalness: 0.3, emissive: 0xff9a2e, emissiveIntensity: 0 });
    this._geo = null; // lazy shared projectile geo
    this._smokeT = 0;
  }

  // ---------------------------------------------------------------- inventory
  reset(loadout) {
    for (const id in this.inv) this.inv[id] = 0;
    this.clearField();
    if (loadout) {
      if (loadout.throwable && THROWABLE_DEFS[loadout.throwable] && loadout.throwable !== 'vxfrag') {
        this.inv[loadout.throwable] = Math.min(THROWABLE_DEFS[loadout.throwable].max, loadout.throwableCount || 0);
      }
      if (loadout.utility && THROWABLE_DEFS[loadout.utility]) {
        this.inv[loadout.utility] = Math.min(THROWABLE_DEFS[loadout.utility].max, loadout.utilityCount || 0);
      }
      this.game.player.frags = loadout.throwable === 'vxfrag' ? Math.min(3, loadout.throwableCount || 0) : 0;
    }
    this.equipped = null;
    this.utility = null;
  }

  snapshotInv() { return Object.assign({ frags: this.game.player.frags }, this.inv); }
  restoreInv(snap) {
    if (!snap) return;
    for (const id in this.inv) if (snap[id] != null) this.inv[id] = snap[id];
    if (snap.frags != null) this.game.player.frags = snap.frags;
  }

  count(id) {
    if (id === 'vxfrag') return this.game.player.frags || 0;
    return this.inv[id] || 0;
  }

  addOne(id) {
    if (!THROWABLE_DEFS[id]) return false;
    if (id === 'vxfrag') {
      if ((this.game.player.frags || 0) >= 3) return false;
      this.game.player.frags = (this.game.player.frags || 0) + 1;
      return true;
    }
    if (this.inv[id] >= THROWABLE_DEFS[id].max) return false;
    this.inv[id]++;
    return true;
  }

  consume(id) {
    if (id === 'vxfrag') { this.game.player.frags = Math.max(0, (this.game.player.frags || 0) - 1); return; }
    this.inv[id] = Math.max(0, (this.inv[id] || 0) - 1);
  }

  listWithStock(cat) {
    const out = [];
    for (const id in THROWABLE_DEFS) {
      const d = THROWABLE_DEFS[id];
      if (d.cat === cat && this.count(id) > 0) out.push(id);
    }
    return out;
  }

  // ---------------------------------------------------------------- equipping
  cycle(cat) {
    const stock = this.listWithStock(cat);
    if (!stock.length) return null;
    const cur = cat === 'throwable' ? this.equipped : this.utility;
    let idx = cur ? stock.indexOf(cur) : -1;
    idx = (idx + 1) % stock.length;
    const id = stock[idx];
    if (cat === 'throwable') this.equipped = id; else this.utility = id;
    return id;
  }

  select(id) {
    const d = THROWABLE_DEFS[id];
    if (!d || this.count(id) <= 0) return false;
    if (d.cat === 'throwable') this.equipped = id; else this.utility = id;
    return true;
  }

  // ---------------------------------------------------------------- throwing
  throwCurrent(soft = false) {
    const g = this.game;
    const id = g.handsMode === 'utility' ? this.utility : this.equipped;
    if (!id) return false;
    const def = THROWABLE_DEFS[id];
    if (this.count(id) <= 0) {
      g.ui.radio(def.cat === 'utility' ? 'NO UTILITY ITEMS LEFT' : 'NO THROWABLES LEFT');
      g.equipGun();
      return false;
    }
    if (def.kind === 'instant') { this.useMedkit(); return true; }
    if (def.kind === 'place') { this.placeCharge(); return true; }
    this.consume(id);
    g.stats.throwablesUsed = (g.stats.throwablesUsed || 0) + 1;
    const dir = g.camera.getWorldDirection(_v1);
    const pos = _v2.copy(g.camera.position).addScaledVector(dir, 0.45);
    pos.y -= 0.08;
    const vel = dir.clone().multiplyScalar(soft ? 7 : def.kind === 'deploy' ? 9 : 13.5);
    vel.y += soft ? 1.2 : 2.4;
    g.spawnThrowable(pos.clone(), vel, id);
    g.player.frags = g.player.frags; // keep field live for HUD
    return true;
  }

  altUse() {
    const g = this.game;
    if (g.handsMode === 'utility') {
      const id = this.utility;
      if (id === 'breach') { this.detonateCharges(); return; }
      if (id === 'medkit') { this.useMedkit(); return; }
      this.throwCurrent(false); // sensor: deploy toss
      return;
    }
    this.throwCurrent(true);    // soft toss
  }

  useMedkit() {
    const g = this.game;
    if (this.count('medkit') <= 0) { g.ui.radio('NO MEDKITS LEFT'); return; }
    const p = g.player;
    if (p.health >= 100 && p.armor >= 50) { g.ui.radio('ALREADY AT FULL STRENGTH'); return; }
    this.consume('medkit');
    p.health = Math.min(100, p.health + 55);
    p.armor = Math.min(50, p.armor + 25);
    g.audio.deviceChirp(null);
    g.ui.toastBrief('MEDKIT USED');
    if (this.count('medkit') <= 0) g.equipGun();
  }

  // ---------------------------------------------------------------- breach
  placeCharge() {
    const g = this.game;
    if (this.count('breach') <= 0) { g.ui.radio('NO BREACH CHARGES LEFT'); return; }
    if (this.charges.length >= 2) { g.ui.radio('CHARGES SET — DETONATE FIRST'); return; }
    const dir = g.camera.getWorldDirection(_v1);
    const hit = g.physics.raycast(g.camera.position, dir, 3.2);
    if (!hit) { g.ui.radio('AIM AT A SURFACE — CHARGE NEEDS SOMETHING TO STICK TO'); return; }
    this.consume('breach');
    const pos = hit.point.clone().addScaledVector(hit.normal || _v2.set(0, 1, 0), 0.04);
    const mesh = new THREE.Mesh(this._geoBox(), this._chargeMat.clone());
    mesh.position.copy(pos);
    if (hit.normal) mesh.lookAt(pos.clone().add(hit.normal));
    g.scene.add(mesh);
    this.charges.push({ pos, mesh, blink: 0 });
    g.audio.deviceChirp(pos);
    g.ui.toastBrief('BREACH CHARGE SET — RMB TO DETONATE');
    if (this.count('breach') <= 0) { /* stay in utility mode so RMB can detonate */ }
  }

  detonateCharges() {
    const g = this.game;
    if (!this.charges.length) { g.ui.radio('NO CHARGES SET'); return; }
    for (const c of this.charges) {
      g.explodeAt(c.pos);
      // doors in the blast are forced — locked or not (mission state flows from world doors)
      for (const d of g.world.doors) {
        if (d.pos && d.pos.distanceTo(c.pos) < 3.5) {
          d.locked = false;
          if (!d.open) d.open = true;
        }
      }
      // nearby glass shatters
      for (const pane of g.world.glassPanes) {
        if (pane.broken) continue;
        const pc = pane.collider;
        if (!pc) continue;
        _v3.set((pc.min.x + pc.max.x) / 2, (pc.min.y + pc.max.y) / 2, (pc.min.z + pc.max.z) / 2);
        if (_v3.distanceTo(c.pos) < 5) g.world.breakGlass(pc);
      }
      g.scene.remove(c.mesh);
    }
    this.charges.length = 0;
    if (g.handsMode === 'utility' && this.count('breach') <= 0) g.equipGun();
  }

  _geoBox() {
    if (!this._boxGeo) this._boxGeo = new THREE.BoxGeometry(0.24, 0.16, 0.07);
    return this._boxGeo;
  }

  // ---------------------------------------------------------------- detonation effects
  detonate(type, pos) {
    const g = this.game;
    const def = THROWABLE_DEFS[type];
    if (!def) { g.explodeAt(pos); return; }
    switch (def.kind) {
      case 'frag':
        g.explodeAt(pos);
        break;
      case 'smoke':
        this.smokeVolumes.push({ pos: pos.clone(), r: 4.2, t: 15 });
        g.audio.impact('metal', pos, 0.4);
        break;
      case 'flash': {
        g.audio.flashbang(pos);
        g.emitNoise(pos, 40, 'explosion');
        g.particles.muzzleFlash(pos, _v2.set(0, 1, 0), true);
        for (const e of g.enemies.list) {
          if (!e.alive) continue;
          if (e.pos.distanceTo(pos) < 14 && g.physics.hasLOS(pos, _v2.copy(e.pos).setY(e.pos.y + 1.3)) && !this.smokeBlocksLOS(pos, e.pos)) {
            e.stunT = 2.6;
            e.suppressT = Math.max(e.suppressT || 0, 3.2);
          }
        }
        const dp = pos.distanceTo(g.camera.position);
        if (dp < 14) {
          const dir = g.camera.getWorldDirection(_v1);
          const toBlast = _v2.copy(pos).sub(g.camera.position).normalize();
          const facing = dir.dot(toBlast);
          if (facing > 0.25 && g.physics.hasLOS(g.camera.position, pos)) {
            const power = Math.max(0.25, 1 - dp / 14) * Math.min(1, (facing - 0.25) / 0.5);
            g.ui.flashbang(power);
            g.suppress = Math.max(g.suppress || 0, power * 0.9);
          }
        }
        break;
      }
      case 'decoy': {
        const mesh = new THREE.Mesh(this._geoBall(), this._mats.decoy);
        mesh.position.copy(pos).setY(pos.y + 0.06);
        g.scene.add(mesh);
        this.decoys.push({ pos: pos.clone(), t: 10, next: 0.35, mesh });
        break;
      }
      case 'flare': {
        const light = new THREE.PointLight(0xff6a3c, 26, 34, 2);
        light.position.copy(pos).setY(pos.y + 0.5);
        g.scene.add(light);
        const mesh = new THREE.Mesh(this._geoBall(), new THREE.MeshStandardMaterial({ color: 0xff5a30, emissive: 0xff5a30, emissiveIntensity: 2.4 }));
        mesh.position.copy(pos).setY(pos.y + 0.08);
        g.scene.add(mesh);
        this.revealVolumes.push({ pos: pos.clone(), r: 26, t: 25, los: true, light, mesh, smokeT: 0, kind: 'flare' });
        g.audio.impact('metal', pos, 0.5);
        break;
      }
      case 'deploy': { // sensor
        const mesh = new THREE.Mesh(this._geoBox(), new THREE.MeshStandardMaterial({ color: 0x33454f, roughness: 0.5, metalness: 0.4, emissive: 0x39c6d8, emissiveIntensity: 0.5 }));
        mesh.position.copy(pos).setY(pos.y + 0.08);
        g.scene.add(mesh);
        this.revealVolumes.push({ pos: pos.clone(), r: 16, t: 22, los: false, mesh, beep: 0, kind: 'sensor' });
        g.audio.deviceChirp(pos);
        break;
      }
      default:
        g.explodeAt(pos);
    }
  }

  _geoBall() {
    if (!this._ballGeo) this._ballGeo = new THREE.SphereGeometry(0.07, 8, 6);
    return this._ballGeo;
  }

  // ---------------------------------------------------------------- field queries
  smokeBlocksLOS(a, b) {
    if (!this.smokeVolumes.length) return false;
    _v1.copy(b).sub(a);
    const len2 = _v1.lengthSq();
    if (len2 < 0.0001) return false;
    for (const s of this.smokeVolumes) {
      const t = THREE.MathUtils.clamp(_v2.copy(s.pos).sub(a).dot(_v1) / len2, 0, 1);
      _v3.copy(a).addScaledVector(_v1, t);
      const rr = s.r * (0.6 + 0.4 * Math.min(1, s.t / 3)); // thinning as it dissipates
      if (_v3.distanceToSquared(s.pos) < rr * rr) return true;
    }
    return false;
  }

  /** Tac map aid: is this position covered by an active reveal volume? */
  revealCovers(pos, needLos = true) {
    for (const r of this.revealVolumes) {
      if (r.t <= 0) continue;
      if (pos.distanceToSquared(r.pos) > r.r * r.r) continue;
      if (!r.los || !needLos) return true;
      if (this.game.physics.hasLOS(_v1.copy(r.pos).setY(r.pos.y + 0.5), pos)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    const g = this.game;
    // smoke volumes: dissipate + keep pumping particles
    this._smokeT -= dt;
    const puff = this._smokeT <= 0;
    if (puff) this._smokeT = 0.07;
    for (let i = this.smokeVolumes.length - 1; i >= 0; i--) {
      const s = this.smokeVolumes[i];
      s.t -= dt;
      if (s.t <= 0) { this.smokeVolumes.splice(i, 1); continue; }
      if (puff && g.camera.position.distanceToSquared(s.pos) < 90 * 90) {
        for (let k = 0; k < 2; k++) {
          _v1.copy(s.pos);
          _v1.x += (Math.random() - 0.5) * s.r * 1.5;
          _v1.z += (Math.random() - 0.5) * s.r * 1.5;
          _v1.y += Math.random() * 1.2;
          g.particles.smoke.spawn(_v1, _v2.set((Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4), {
            r: 0.52, g: 0.53, b: 0.52, size: 0.9, sizeGrow: 2.6, life: 2.0 + Math.random(), gravity: -0.12, drag: 1.1,
          });
        }
      }
    }
    // decoys: periodic reports
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.t -= dt;
      if (d.t <= 0) { g.scene.remove(d.mesh); this.decoys.splice(i, 1); continue; }
      d.next -= dt;
      if (d.next <= 0) {
        d.next = 0.6 + Math.random() * 0.9;
        g.audio.gunshot('decoy', d.pos, { gain: 0.9 });
        g.emitNoise(d.pos, 50, 'gunfire');
      }
    }
    // reveal volumes (flare / sensor)
    for (let i = this.revealVolumes.length - 1; i >= 0; i--) {
      const r = this.revealVolumes[i];
      r.t -= dt;
      if (r.t <= 0) {
        if (r.light) g.scene.remove(r.light);
        if (r.mesh) g.scene.remove(r.mesh);
        this.revealVolumes.splice(i, 1);
        continue;
      }
      if (r.kind === 'flare') {
        r.light.intensity = 22 + Math.sin(g.time * 17) * 6 + Math.random() * 4;
        r.smokeT = (r.smokeT || 0) - dt;
        if (r.smokeT <= 0) {
          r.smokeT = 0.18;
          _v1.copy(r.pos).setY(r.pos.y + 0.2);
          g.particles.smoke.spawn(_v1, _v2.set((Math.random() - 0.5) * 0.3, 1.1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3), {
            r: 0.62, g: 0.24, b: 0.16, size: 0.3, sizeGrow: 1.1, life: 1.1 + Math.random() * 0.6, gravity: -0.3, drag: 1.5,
          });
        }
      } else if (r.kind === 'sensor') {
        r.beep = (r.beep || 0) - dt;
        const m = r.mesh.material;
        m.emissiveIntensity = 0.35 + Math.max(0, Math.sin(g.time * 4)) * 0.5;
        if (r.beep <= 0) { r.beep = 1.6; g.audio.deviceChirp(r.pos); }
      }
    }
    // placed charges blink
    for (const c of this.charges) {
      c.blink += dt;
      c.mesh.material.emissiveIntensity = 0.4 + Math.max(0, Math.sin(c.blink * 8)) * 1.2;
    }
  }

  clearField() {
    const g = this.game;
    for (const d of this.decoys) g.scene.remove(d.mesh);
    this.decoys.length = 0;
    for (const r of this.revealVolumes) {
      if (r.light) g.scene.remove(r.light);
      if (r.mesh) g.scene.remove(r.mesh);
    }
    this.revealVolumes.length = 0;
    for (const c of this.charges) g.scene.remove(c.mesh);
    this.charges.length = 0;
    this.smokeVolumes.length = 0;
  }
}
