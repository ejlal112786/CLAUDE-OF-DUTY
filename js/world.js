/**
 * world.js
 * Procedural environment construction for OPERATION: BLACK VECTOR.
 * Everything is generated at runtime from primitives + canvas textures —
 * no external assets. Builds:
 *   - Mission map: abandoned industrial facility at night
 *     (exterior yard, fence line, warehouse, catwalk, two-storey office
 *      wing with server room, loading dock, containers, vehicles, pipes)
 *   - Training map: a night firing range
 * Also owns: doors, breakable glass, interactables, trigger volumes,
 * AI cover points / patrol routes / spawn data, audio zone volumes.
 */
import * as THREE from 'three';
import { WEAPON_DEFS } from './weapons.js';
import { Material as Mat } from './physics.js';

// ---------------------------------------------------------------------------
// Seeded RNG so the facility layout is identical every load (checkpoints!)
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural texture factory
// ---------------------------------------------------------------------------
function canvasTex(size, painter, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  painter(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Derive a tangent-space normal map from a grayscale height canvas. */
function normalFromHeight(heightCanvas, strength = 2) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const h = (x, y) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeHeightCanvas(size, painter) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  painter(c.getContext('2d'), size);
  return c;
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------
export class Door {
  /**
   * opts: { position:Vector3 (hinge), rotY, width, height, thickness,
   *         material, slideUp:false, locked:false, prompt }
   */
  constructor(world, opts) {
    this.world = world;
    this.pos = opts.position.clone();
    this.rotY = opts.rotY || 0;
    this.width = opts.width || 1.1;
    this.height = opts.height || 2.2;
    this.thickness = opts.thickness || 0.08;
    this.slideUp = !!opts.slideUp;
    this.locked = !!opts.locked;
    this.open = false;
    this.t = 0; // 0 closed → 1 open
    this.speed = this.slideUp ? 1.0 : 1.4;
    this.moving = false;

    const mat = opts.material || world.mat.doorMetal;
    const geo = new THREE.BoxGeometry(this.width, this.height, this.thickness);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    this.pivot = new THREE.Group();
    this.pivot.position.copy(this.pos);
    this.pivot.rotation.y = this.rotY;
    if (!this.slideUp) {
      // hinge at edge: offset mesh by half width along local X
      this.mesh.position.set(this.width / 2, this.height / 2, 0);
    } else {
      this.mesh.position.set(this.width / 2, this.height / 2, 0);
    }
    this.pivot.add(this.mesh);
    world.group.add(this.pivot);

    // handle
    if (!this.slideUp) {
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.16, 0.06),
        world.mat.metalDark
      );
      handle.position.set(this.width - 0.14, this.height * 0.47, this.thickness * 0.5 + 0.03);
      this.mesh.add(handle);
      const handle2 = handle.clone();
      handle2.position.z = -handle2.position.z;
      this.mesh.add(handle2);
    }

    const c0 = this._makeCollider();
    this.colliderObj = world.physics.add(c0.min, c0.max, Mat.METAL, { tag: 'door', entity: this });

    world.doors.push(this);
    const self = this;
    world.interactables.push({
      id: 'door_' + world.doors.length,
      pos: this.pos.clone().setY(this.pos.y + this.height * 0.5),
      radius: 2.2,
      prompt: 'OPEN DOOR',
      getPrompt: () => {
        if (self.locked) return 'LOCKED';
        return self.open ? 'CLOSE DOOR' : 'OPEN DOOR';
      },
      action: (game) => self.interact(game),
      hold: 0,
    });
  }

  _makeCollider() {
    // World-space AABB approximating the door leaf in its current state.
    const min = new THREE.Vector3(), max = new THREE.Vector3();
    const w = this.width, h = this.height, th = this.thickness;
    const cos = Math.abs(Math.cos(this.rotY)), sin = Math.abs(Math.sin(this.rotY));
    const ex = (cos * w + sin * th) / 2 + 0.02;
    const ez = (sin * w + cos * th) / 2 + 0.02;
    if (this.slideUp) {
      // leaf centre is offset +width/2 along the (axis-aligned) run, and lifts with t
      const cx = this.pos.x + (Math.cos(this.rotY) * w) / 2;
      const cz = this.pos.z - (Math.sin(this.rotY) * w) / 2;
      const lift = this.t * h;
      min.set(cx - ex, this.pos.y + lift, cz - ez);
      max.set(cx + ex, this.pos.y + lift + h, cz + ez);
    } else {
      // swinging leaf: rotate the centre offset with the animation
      const ang = this.rotY + this.t * Math.PI / 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const ac = Math.abs(c), as = Math.abs(s);
      const sx = (ac * w + as * th) / 2 + 0.02;
      const sz = (as * w + ac * th) / 2 + 0.02;
      const cx = this.pos.x + c * w / 2;
      const cz = this.pos.z - s * w / 2;
      min.set(cx - sx, this.pos.y, cz - sz);
      max.set(cx + sx, this.pos.y + h, cz + sz);
    }
    return { min, max };
  }

  interact(game) {
    if (this.locked) {
      game.audio.wpnClick(700, 0.5);
      game.ui.toastBrief('DOOR IS LOCKED');
      return false;
    }
    this.open = !this.open;
    this.moving = true;
    game.audio.doorSound(this.pos.clone().setY(this.pos.y + 1), this.open ? 'open' : 'close');
    // doors are audible events for the AI
    game.emitNoise(this.pos, this.open ? 18 : 10, 'door');
    return true;
  }

  update(dt) {
    if (!this.moving) return;
    const target = this.open ? 1 : 0;
    const step = this.speed * dt;
    if (Math.abs(target - this.t) <= step) {
      this.t = target;
      this.moving = false;
    } else {
      this.t += Math.sign(target - this.t) * step;
    }
    // animation
    if (this.slideUp) {
      this.mesh.position.y = this.height / 2 + this.t * this.height;
    } else {
      this.pivot.rotation.y = this.rotY + this.t * Math.PI / 2;
    }
    // collider follows state; disabled while moving (nothing walks through mid-swing in practice)
    const c = this._makeCollider();
    this.colliderObj.min.copy(c.min);
    this.colliderObj.max.copy(c.max);
    this.colliderObj.enabled = !this.moving && !(this.slideUp && this.t > 0.92);
  }
}

// ---------------------------------------------------------------------------
// Range targets (training map)
// ---------------------------------------------------------------------------
class RangeTarget {
  constructor(world, pos, scale = 1) {
    this.world = world;
    this.basePos = pos.clone();
    this.active = true;
    this.fallT = 0;
    this.respawn = 0;
    this.group = new THREE.Group();
    this.group.position.copy(pos);

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55 * scale, 1.1 * scale, 0.08), world.mat.targetFace);
    body.position.y = 1.15 * scale;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26 * scale, 0.3 * scale, 0.08), world.mat.targetFace);
    head.position.y = 1.9 * scale;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6), world.mat.metalDark);
    post.position.y = 0.3;
    this.group.add(body, head, post);
    this.body = body; this.head = head;
    world.group.add(this.group);

    this.halfW = 0.32 * scale;
    this.height = 2.1 * scale;
    world.rangeTargets.push(this);
  }

  /** ray vs target plane — returns {dist, zone} or null */
  rayTest(origin, dir, maxDist) {
    if (!this.active) return null;
    // treat as small AABB
    const min = _tmin.set(this.basePos.x - this.halfW, this.basePos.y + 0.55, this.basePos.z - 0.12);
    const max = _tmax.set(this.basePos.x + this.halfW, this.basePos.y + this.height, this.basePos.z + 0.12);
    const d = rayAABBSimple(origin, dir, min, max, maxDist);
    if (d === null) return null;
    const hy = origin.y + dir.y * d - this.basePos.y;
    return { dist: d, zone: hy > 1.62 ? 'head' : 'torso' };
  }

  hit() {
    this.active = false;
    this.fallT = 0.001;
    this.respawn = 2.5;
  }

  update(dt) {
    if (this.fallT > 0) {
      this.fallT = Math.min(1, this.fallT + dt * 3.2);
      this.group.rotation.x = -this.fallT * Math.PI * 0.42;
      if (this.fallT >= 1) this.fallT = 0;
    }
    if (!this.active) {
      this.respawn -= dt;
      if (this.respawn <= 0) {
        this.active = true;
        this.group.rotation.x = 0;
      }
    }
  }
}

function rayAABBSimple(origin, dir, min, max, maxDist) {
  let tmin = 0, tmax = maxDist;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [min.x, min.y, min.z];
  const hi = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < lo[i] || o[i] > hi[i]) return null; }
    else {
      let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
const _tmin = new THREE.Vector3();
const _tmax = new THREE.Vector3();

// ---------------------------------------------------------------------------
// The world builder
// ---------------------------------------------------------------------------
export class GameWorld {
  constructor() {
    this.group = null;
    this.physics = null;
    this.doors = [];
    this.interactables = [];
    this.triggers = [];          // {id, min, max} or {id, center, radius}
    this.coverPoints = [];       // {pos:Vector3, normal:Vector3}
    this.patrolRoutes = [];      // [ [Vector3,...], ... ]
    this.enemySpawns = [];       // {pos, route, kind}
    this.surgeSpawns = [];       // {pos, route}
    this.glassPanes = [];        // {collider, mesh}
    this.rangeTargets = [];
    this.machinePositions = [];
    this.shadowLights = [];
    this.allLights = [];
    this.zones = [];             // audio reverb volumes {name, min, max}
    this.spawnPoint = new THREE.Vector3();
    this.spawnYaw = 0;
    this.extractionPoint = new THREE.Vector3();
    this.terminalPos = new THREE.Vector3();
    this.map = 'facility';
    this._flickerLights = [];
    this.shootables = [];
    this.npcSpawns = [];           // {pos, kind:'civilian'|'contact', waypoints}
    this.vehicleSpawns = [];       // {type,pos,yaw,route,ai,tag,mission,color,hpFrac} (C2)
    this.evidenceCollected = 0;
    this.intelPlaced = [];
    this.poweredDoors = [];        // doors unlocked by the generator
    this.generatorOn = false;
    this.sabotageDone = 0;
    this.weather = null;
    this.windLevel = 0.1;
    this.lightMode = 'night';
    this.fogMul = 1;
    this.fogMulBase = 1;
    this.scene = null;
    this.nightSky = { bg: 0x080c13, fog: 0x0a0e14 };
    this.daySky = { bg: 0xdfe6ec, fog: 0xd6dee6 };
    this.dayFogMul = 0.55;
    this._smokeTimer = 0;
    this.mat = {};
  }

  // =========================================================================
  // Materials & textures
  // =========================================================================
  _buildMaterials() {
    const M = this.mat;

    // ---- concrete (walls, floor, pillars) ----
    const concHeight = makeHeightCanvas(256, (ctx, s) => {
      ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 900; i++) {
        const v = 100 + Math.random() * 60;
        ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
      }
      for (let i = 0; i < 8; i++) { // cracks
        ctx.strokeStyle = 'rgba(40,40,40,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let x = Math.random() * s, y = Math.random() * s;
        ctx.moveTo(x, y);
        for (let j = 0; j < 8; j++) { x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 40; ctx.lineTo(x, y); }
        ctx.stroke();
      }
    });
    const concMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#7c7a75'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 1400; i++) {
        const v = Math.random();
        ctx.fillStyle = `rgba(${60 + v * 70},${58 + v * 68},${54 + v * 62},0.30)`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 4, 1 + Math.random() * 4);
      }
      // stains
      for (let i = 0; i < 10; i++) {
        const g = ctx.createRadialGradient(Math.random() * s, Math.random() * s, 2, Math.random() * s, Math.random() * s, 20 + Math.random() * 40);
        g.addColorStop(0, 'rgba(40,38,34,0.20)');
        g.addColorStop(1, 'rgba(40,38,34,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      }
    });
    const concNorm = normalFromHeight(concHeight, 1.4);
    concNorm.repeat.copy(concMap.repeat);
    M.concrete = (rep = 1) => this._cached(`concrete_${rep}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(concMap, rep), normalMap: this._rep(concNorm, rep),
      normalScale: new THREE.Vector2(0.35, 0.35),
      color: 0x9a9791, roughness: 0.94, metalness: 0.02,
    }));

    // ---- painted metal (walls, machines, doors) ----
    const metalMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#464d55'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 260; i++) { // brushed streaks
        ctx.strokeStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.04})`;
        const y = Math.random() * s;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y + (Math.random() - 0.5) * 3); ctx.stroke();
      }
      for (let i = 0; i < 12; i++) { // rust
        const x = Math.random() * s, y = Math.random() * s, r = 6 + Math.random() * 22;
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, 'rgba(122,72,38,0.5)');
        g.addColorStop(0.6, 'rgba(96,60,34,0.25)');
        g.addColorStop(1, 'rgba(96,60,34,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      // panel seams + rivets
      ctx.strokeStyle = 'rgba(20,24,28,0.55)'; ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, s - 4, s - 4);
      ctx.fillStyle = 'rgba(160,170,180,0.25)';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        ctx.beginPath(); ctx.arc(14 + i * ((s - 28) / 3), 14 + j * ((s - 28) / 3), 2.2, 0, 7); ctx.fill();
      }
    });
    M.metal = (rep = 1, color = 0x8f959c) => this._cached(`metal_${rep}_${color}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(metalMap, rep), color, roughness: 0.55, metalness: 0.65,
    }));
    M.metalDark = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.5, metalness: 0.7 });
    M.doorMetal = new THREE.MeshStandardMaterial({ color: 0x59616b, roughness: 0.45, metalness: 0.7, map: this._rep(metalMap, 1) });
    M.rust = new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.85, metalness: 0.35, map: this._rep(metalMap, 2) });

    // ---- corrugated container steel ----
    const corrHeight = makeHeightCanvas(128, (ctx, s) => {
      ctx.fillStyle = '#707070'; ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 8) {
        const g = ctx.createLinearGradient(x, 0, x + 8, 0);
        g.addColorStop(0, '#3a3a3a'); g.addColorStop(0.5, '#d0d0d0'); g.addColorStop(1, '#3a3a3a');
        ctx.fillStyle = g; ctx.fillRect(x, 0, 8, s);
      }
    });
    const corrNorm = normalFromHeight(corrHeight, 3);
    M.corrugated = (color = 0x6d7a72, rep = 4) => this._cached(`corr_${color}_${rep}`, () => {
      const n = corrNorm.clone(); n.needsUpdate = true; n.wrapS = n.wrapT = THREE.RepeatWrapping; n.repeat.set(rep, rep);
      return new THREE.MeshStandardMaterial({
        color, map: this._rep(metalMap, rep), normalMap: n,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.62, metalness: 0.55,
      });
    });

    // ---- wood (crates) ----
    const woodMap = canvasTex(128, (ctx, s) => {
      ctx.fillStyle = '#7d5f3c'; ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 16) { // planks
        ctx.fillStyle = `rgba(${40 + Math.random() * 30},${28 + Math.random() * 20},16,0.35)`;
        ctx.fillRect(0, y, s, 2);
        for (let i = 0; i < 30; i++) {
          ctx.strokeStyle = `rgba(60,42,24,${0.10 + Math.random() * 0.14})`;
          const yy = y + 2 + Math.random() * 13;
          ctx.beginPath(); ctx.moveTo(0, yy);
          ctx.bezierCurveTo(s * 0.3, yy + (Math.random() - 0.5) * 3, s * 0.7, yy + (Math.random() - 0.5) * 3, s, yy);
          ctx.stroke();
        }
      }
      // frame battens
      ctx.fillStyle = 'rgba(52,38,22,0.8)';
      ctx.fillRect(0, 0, s, 8); ctx.fillRect(0, s - 8, s, 8);
      ctx.fillRect(0, 0, 8, s); ctx.fillRect(s - 8, 0, 8, s);
    });
    M.wood = (rep = 1, color = 0xb09070) => this._cached(`wood_${rep}_${color}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(woodMap, rep), color, roughness: 0.9, metalness: 0,
    }));

    // ---- asphalt / gravel yard ----
    const gravelMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#3c3a37'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 4200; i++) {
        const v = Math.random();
        ctx.fillStyle = `rgba(${50 + v * 80},${48 + v * 76},${44 + v * 70},${0.15 + v * 0.3})`;
        const r = 0.5 + Math.random() * 1.6;
        ctx.beginPath(); ctx.arc(Math.random() * s, Math.random() * s, r, 0, 7); ctx.fill();
      }
      for (let i = 0; i < 6; i++) { // oil stains
        const g = ctx.createRadialGradient(Math.random() * s, Math.random() * s, 2, Math.random() * s, Math.random() * s, 16 + Math.random() * 26);
        g.addColorStop(0, 'rgba(16,15,14,0.4)'); g.addColorStop(1, 'rgba(16,15,14,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      }
    });
    M.gravel = (rep = 40) => this._cached(`gravel_${rep}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(gravelMap, rep), color: 0x8f8b84, roughness: 0.97, metalness: 0,
    }));

    // ---- polished-ish interior concrete floor ----
    M.floorConc = (rep = 24) => this._cached(`floorc_${rep}`, () => {
      const m = M.concrete(1).clone();
      m.map = this._rep(concMap, rep);
      m.normalMap = this._rep(concNorm, rep);
      m.color = new THREE.Color(0x6f6d68);
      m.roughness = 0.82;
      return m;
    });

    // ---- office tile ----
    const tileMap = canvasTex(128, (ctx, s) => {
      ctx.fillStyle = '#54585c'; ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(30,32,35,0.9)'; ctx.lineWidth = 3;
      ctx.strokeRect(0, 0, s, s);
      for (let i = 0; i < 500; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    });
    M.tile = (rep = 8) => this._cached(`tile_${rep}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(tileMap, rep), color: 0x9aa0a6, roughness: 0.6, metalness: 0.05,
    }));

    // ---- misc ----
    M.glass = new THREE.MeshStandardMaterial({
      color: 0x9fb8c4, roughness: 0.08, metalness: 0.1,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide,
    });
    // ---- snow ----
    const snowHeight = makeHeightCanvas(256, (ctx, s) => {
      ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 2600; i++) {
        const v = 118 + Math.random() * 60 | 0;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
      }
      for (let i = 0; i < 26; i++) {
        const g = ctx.createRadialGradient(Math.random() * s, Math.random() * s, 1, Math.random() * s, Math.random() * s, 26 + Math.random() * 40);
        g.addColorStop(0, 'rgba(150,150,150,0.35)'); g.addColorStop(1, 'rgba(150,150,150,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      }
    });
    const snowNorm = normalFromHeight(snowHeight, 0.7);
    const snowMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#dfe7ee'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 2200; i++) {
        const v = 225 + Math.random() * 30 | 0;
        ctx.fillStyle = `rgb(${v},${v},${Math.min(255, v + 4)})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4);
      }
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = 'rgba(150,165,185,0.10)';
        ctx.beginPath();
        ctx.ellipse(Math.random() * s, Math.random() * s, 20 + Math.random() * 40, 8 + Math.random() * 16, Math.random() * 3, 0, 7);
        ctx.fill();
      }
    });
    M.snow = (rep2 = 12) => this._cached(`snow_${rep2}`, () => {
      snowNorm.repeat.set(rep2, rep2); snowMap.repeat.set(rep2, rep2);
      return new THREE.MeshStandardMaterial({
        map: this._rep(snowMap, rep2), normalMap: this._rep(snowNorm, rep2),
        normalScale: new THREE.Vector2(0.4, 0.4),
        color: 0xf2f6fa, roughness: 0.82, metalness: 0.0,
      });
    });

    // ---- sand ----
    const sandHeight = makeHeightCanvas(256, (ctx, s) => {
      ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 3) {
        ctx.fillStyle = `rgba(${140 + Math.sin(y * 0.35) * 26 | 0},128,128,0.5)`;
        ctx.fillRect(0, y, s, 1.6);
      }
      for (let i = 0; i < 2400; i++) {
        const v = 116 + Math.random() * 40 | 0;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.3, 1.3);
      }
    });
    const sandNorm = normalFromHeight(sandHeight, 0.8);
    const sandMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#b49a6c'; ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 3) {
        ctx.fillStyle = `rgba(120,100,66,${0.10 + Math.sin(y * 0.35) * 0.06})`;
        ctx.fillRect(0, y, s, 1.5);
      }
      for (let i = 0; i < 1800; i++) {
        const v = 168 + Math.random() * 46 | 0;
        ctx.fillStyle = `rgb(${v},${v - 18 | 0},${v - 52 | 0})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4);
      }
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = 'rgba(90,74,48,0.12)';
        ctx.beginPath(); ctx.ellipse(Math.random() * s, Math.random() * s, 18 + Math.random() * 30, 10 + Math.random() * 18, 0, 0, 7); ctx.fill();
      }
    });
    M.sand = (rep2 = 14) => this._cached(`sand_${rep2}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(sandMap, rep2), normalMap: this._rep(sandNorm, rep2),
      normalScale: new THREE.Vector2(0.45, 0.45),
      color: 0xc9b189, roughness: 0.96, metalness: 0.0,
    }));

    // ---- asphalt ----
    const aspHeight = makeHeightCanvas(256, (ctx, s) => {
      ctx.fillStyle = '#7d7d7d'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 3200; i++) {
        const v = 110 + Math.random() * 50 | 0;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
      }
      ctx.strokeStyle = 'rgba(60,60,60,0.7)'; ctx.lineWidth = 1.2;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        let x = Math.random() * s, y = Math.random() * s;
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) { x += (Math.random() - 0.5) * 60; y += (Math.random() - 0.5) * 60; ctx.lineTo(x, y); }
        ctx.stroke();
      }
    });
    const aspNorm = normalFromHeight(aspHeight, 1.0);
    const aspMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#33363b'; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 3000; i++) {
        const v = 40 + Math.random() * 34 | 0;
        ctx.fillStyle = `rgb(${v},${v + 2 | 0},${v + 5 | 0})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5);
      }
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = 'rgba(20,21,24,0.35)';
        ctx.beginPath(); ctx.ellipse(Math.random() * s, Math.random() * s, 16 + Math.random() * 34, 10 + Math.random() * 22, 0, 0, 7); ctx.fill();
      }
    });
    M.asphalt = (rep2 = 10) => this._cached(`asphalt_${rep2}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(aspMap, rep2), normalMap: this._rep(aspNorm, rep2),
      normalScale: new THREE.Vector2(0.5, 0.5),
      color: 0x8b8f96, roughness: 0.93, metalness: 0.02,
    }));

    // ---- brick ----
    const brickMap = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#8d857c'; ctx.fillRect(0, 0, s, s);
      const bh = 16, bw = 32;
      for (let row = 0; row < s / bh; row++) {
        const off = (row % 2) * bw / 2;
        for (let col = -1; col < s / bw + 1; col++) {
          const t = Math.random();
          const r = 96 + t * 40 | 0, g2 = 62 + t * 26 | 0, b = 50 + t * 20 | 0;
          ctx.fillStyle = `rgb(${r},${g2},${b})`;
          ctx.fillRect(col * bw + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
        }
      }
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(40,34,30,${Math.random() * 0.25})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    });
    const brickHeight = makeHeightCanvas(256, (ctx, s) => {
      ctx.fillStyle = '#606060'; ctx.fillRect(0, 0, s, s);
      const bh = 16, bw = 32;
      for (let row = 0; row < s / bh; row++) {
        const off = (row % 2) * bw / 2;
        for (let col = -1; col < s / bw + 1; col++) {
          ctx.fillStyle = '#a8a8a8';
          ctx.fillRect(col * bw + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
        }
      }
    });
    const brickNorm = normalFromHeight(brickHeight, 1.6);
    M.brick = (rep2 = 6) => this._cached(`brick_${rep2}`, () => new THREE.MeshStandardMaterial({
      map: this._rep(brickMap, rep2), normalMap: this._rep(brickNorm, rep2),
      normalScale: new THREE.Vector2(0.7, 0.7),
      color: 0xb0a498, roughness: 0.9, metalness: 0.02,
    }));

    M.burntBulb = new THREE.MeshStandardMaterial({ color: 0x26241f, roughness: 0.7, metalness: 0.1 });
    M.emissiveLamp = new THREE.MeshStandardMaterial({ color: 0xfff3dd, emissive: 0xffe9c4, emissiveIntensity: 2.4, roughness: 1 });
    M.emissiveSodium = new THREE.MeshStandardMaterial({ color: 0xffc478, emissive: 0xffa64d, emissiveIntensity: 2.2, roughness: 1 });
    M.emissiveScreen = new THREE.MeshStandardMaterial({ color: 0x0d2a1a, emissive: 0x35d97a, emissiveIntensity: 1.1, roughness: 0.4 });
    M.emissiveIntel = new THREE.MeshStandardMaterial({ color: 0x1c2a1e, emissive: 0x9fd6a3, emissiveIntensity: 0.85, roughness: 0.6 });
    M.emissiveRed = new THREE.MeshStandardMaterial({ color: 0x331010, emissive: 0xd93a2a, emissiveIntensity: 1.6, roughness: 1 });
    M.emissiveGreen = new THREE.MeshStandardMaterial({ color: 0x0f2a12, emissive: 0x47d95f, emissiveIntensity: 1.8, roughness: 1 });
    M.targetFace = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, emissive: 0x223, emissiveIntensity: 0.05, roughness: 0.9, side: THREE.DoubleSide });
    for (const m of Object.values(M)) {
      if (m.isMeshStandardMaterial && m.emissiveIntensity) m.userData.emissiveBase = m.emissiveIntensity;
    }
    M.rubber = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95, metalness: 0 });
    M.fabric = new THREE.MeshStandardMaterial({ color: 0x3a4238, roughness: 1, metalness: 0 });
    M.whiteboard = new THREE.MeshStandardMaterial({ color: 0xb9c0b9, roughness: 0.35, metalness: 0 });
  }

  _matCache = new Map();
  _cached(key, factory) {
    let m = this._matCache.get(key);
    if (!m) { m = factory(); this._matCache.set(key, m); }
    return m;
  }
  _rep(tex, rep) {
    const key = tex.uuid + '_' + rep;
    let t = this._texCache.get(key);
    if (!t) {
      t = tex.clone();
      t.needsUpdate = true;
      t.repeat.set(rep, rep);
      this._texCache.set(key, t);
    }
    return t;
  }
  _texCache = new Map();

  // =========================================================================
  // Geometry helpers
  // =========================================================================
  /** Static box: mesh + collider in one call. */
  box(x, y, z, w, h, d, material, physMat, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = opts.cast !== false;
    mesh.receiveShadow = true;
    if (opts.rotY) mesh.rotation.y = opts.rotY;
    this.group.add(mesh);
    if (opts.noCollider !== true) {
      if (opts.rotY) {
        // rotated box → conservative AABB
        const c = Math.abs(Math.cos(opts.rotY)), s = Math.abs(Math.sin(opts.rotY));
        const bw = w * c + d * s, bd = w * s + d * c;
        this.physics.addBox(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(bw, h, bd), physMat, opts.collision || {});
      } else {
        this.physics.addBox(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(w, h, d), physMat, opts.collision || {});
      }
    }
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  cyl(x, y, z, rTop, rBot, h, seg, material, physMat, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material);
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = opts.cast !== false;
    mesh.receiveShadow = true;
    if (opts.rotX) mesh.rotation.x = opts.rotX;
    if (opts.rotZ) mesh.rotation.z = opts.rotZ;
    this.group.add(mesh);
    if (opts.noCollider !== true && !opts.rotX && !opts.rotZ) {
      this.physics.addBox(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(rBot * 2, h, rBot * 2), physMat, opts.collision || {});
    }
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  // =========================================================================
  // NIGHT LIGHTING RIG
  // =========================================================================
  _buildLighting(scene) {
    this.scene = scene;
    // cold moonlight
    const moon = new THREE.DirectionalLight(0x9db4d8, 2.3);
    moon.position.set(-80, 95, 95);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -100; moon.shadow.camera.right = 100;
    moon.shadow.camera.top = 100; moon.shadow.camera.bottom = -100;
    moon.shadow.camera.near = 20; moon.shadow.camera.far = 320;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.05;
    scene.add(moon);
    scene.add(moon.target);
    this.moon = moon;
    this.shadowLights.push(moon);
    this.allLights.push(moon);
    moon.userData.base = moon.intensity;

    // dim sky/ground bounce
    const hemi = new THREE.HemisphereLight(0x223047, 0x0b0d0a, 0.85);
    scene.add(hemi);
    this.allLights.push(hemi);
    this.hemiLight = hemi;
    hemi.userData.base = hemi.intensity;

    // star field + moon disc (night only)
    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.acos(Math.random() * 0.95);
      const r = 320;
      sp[i * 3] = Math.sin(e) * Math.cos(a) * r;
      sp[i * 3 + 1] = Math.cos(e) * r;
      sp[i * 3 + 2] = Math.sin(e) * Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xcfdcec, size: 1.6, sizeAttenuation: false, transparent: true,
      opacity: 0.75, depthWrite: false,
    }));
    this.stars.renderOrder = -10;
    scene.add(this.stars);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(9, 24),
      new THREE.MeshBasicMaterial({ color: 0xe9edf4, transparent: true, opacity: 0.92, depthWrite: false })
    );
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(15, 24),
      new THREE.MeshBasicMaterial({ color: 0x9db4d8, transparent: true, opacity: 0.16, depthWrite: false })
    );
    halo.position.z = -0.5;
    disc.add(halo);
    disc.position.copy(moon.position).normalize().multiplyScalar(300);
    disc.lookAt(0, 0, 0);
    this.moonDisc = disc;
    scene.add(disc);

    // faint blue fill so shadows aren't pure black
    const amb = new THREE.AmbientLight(0x1a2230, 0.5);
    scene.add(amb);
    this.allLights.push(amb);
    this.ambLight = amb;
    amb.userData.base = amb.intensity;
  }

  _lamp(x, y, z, color = 0xffe3b0, intensity = 26, dist = 16, shadow = false, parentEmissive = true) {
    // fixture
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.3, 10, 1, true), this.mat.metalDark);
    shade.position.set(x, y + 0.12, z);
    shade.rotation.x = Math.PI;
    this.group.add(shade);
    let bulb = null;
    if (parentEmissive) {
      bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), this.mat.emissiveLamp);
      bulb.position.set(x, y - 0.02, z);
      this.group.add(bulb);
    }
    const light = new THREE.PointLight(color, intensity * 1.5, dist, 1.9);
    light.position.set(x, y - 0.1, z);
    this.shootables.push({ pos: new THREE.Vector3(x, y - 0.05, z), r: 0.22, light, bulb: parentEmissive ? bulb : null });
    if (shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(512, 512);
      light.shadow.bias = -0.004;
      this.shadowLights.push(light);
    }
    this.group.add(light);
    this.allLights.push(light);
    light.userData.base = light.intensity;
    return light;
  }

  _poleLight(x, z, flicker = false) {
    const h = 8;
    this.cyl(x, 0, z, 0.09, 0.13, h, 8, this.mat.metalDark, Mat.METAL);
    const arm = this.box(x + 0.5, h - 0.25, z, 1.2, 0.12, 0.12, this.mat.metalDark, Mat.METAL, { noCollider: true });
    void arm;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.34), this.mat.emissiveSodium);
    head.position.set(x + 0.95, h - 0.2, z);
    this.group.add(head);
    const light = new THREE.PointLight(0xffa64d, 150, 40, 1.8);
    light.position.set(x + 0.95, h - 0.4, z);
    this.shootables.push({ pos: new THREE.Vector3(x + 0.95, h - 0.25, z), r: 0.3, light, bulb: head });
    this.group.add(light);
    this.allLights.push(light);
    light.userData.base = light.intensity;
    if (flicker) this._flickerLights.push({ light, base: light.intensity, t: Math.random() * 10 });
  }

  // =========================================================================
  // FACILITY MAP
  // =========================================================================
  _buildFloods() {
    const g = this.group;
    const fixtureMat = this._cached('flood_fixture', () => new THREE.MeshStandardMaterial({
      color: 0xdfe8f2, emissive: 0xdfe8f2, emissiveIntensity: 1.6, roughness: 1,
    }));
    for (const x of [-14, 14]) {
      const spot = new THREE.SpotLight(0xcfd8e6, 1100, 36, 1.05, 0.72, 1.8);
      spot.position.set(x, 8.6, 15.0);
      const tgt = new THREE.Object3D();
      tgt.position.set(x * 1.2, 0, 27);
      g.add(tgt);
      spot.target = tgt;
      g.add(spot);
      this.allLights.push(spot);
      spot.userData.base = spot.intensity;
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.3), fixtureMat);
      fixture.position.set(x, 8.5, 14.75);
      g.add(fixture);
    }
  }

  // -------------------------------------------------------------------------
  // WHITE MODE: relight any map for bright daylight (white sky, sun, lamps dim)
  // -------------------------------------------------------------------------
  setLightingMode(mode) {
    this.lightMode = mode;
    const day = mode === 'day';
    this.fogMul = (day ? this.dayFogMul : 1) * (this.fogMulBase || 1);
    if (this.moon) {
      this.moon.color.set(day ? 0xfff2dc : 0x9db4d8);
      this.moon.intensity = day ? 3.9 : (this.moon.userData.base || 2.3);
    }
    if (this.hemiLight) {
      this.hemiLight.color.set(day ? 0xcfdce8 : 0x223047);
      this.hemiLight.groundColor.set(day ? 0x9a9384 : 0x0b0d0a);
      this.hemiLight.intensity = day ? 1.3 : (this.hemiLight.userData.base || 0.85);
    }
    if (this.ambLight) {
      this.ambLight.color.set(day ? 0x96a4b4 : 0x1a2230);
      this.ambLight.intensity = day ? 0.6 : (this.ambLight.userData.base || 0.5);
    }
    for (const l of this.allLights) {
      if (l.isPointLight || l.isSpotLight) {
        const base = l.userData.base != null ? l.userData.base : l.intensity;
        l.intensity = l.userData.dead ? 0 : (day ? base * 0.22 : base);
      }
    }
    if (this.stars) this.stars.visible = !day;
    if (this.moonDisc) this.moonDisc.visible = !day;
    for (const m of Object.values(this.mat)) {
      if (m && m.isMeshStandardMaterial && m.userData.emissiveBase != null) {
        m.emissiveIntensity = day ? m.userData.emissiveBase * 0.3 : m.userData.emissiveBase;
      }
    }
    if (this.scene) {
      const sky = day ? this.daySky : this.nightSky;
      this.scene.background.set(sky.bg);
      if (this.scene.fog) this.scene.fog.color.set(sky.fog);
    }
  }

  // -------------------------------------------------------------------------
  // generic map-authoring helpers (used by all battlefields)
  // -------------------------------------------------------------------------
  _cover(x, z, nx, nz) {
    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), normal: new THREE.Vector3(nx, 0, nz) });
  }
  _coverBox(x, z, w, d) {
    this._cover(x, z + d / 2 + 0.9, 0, 1);
    this._cover(x, z - d / 2 - 0.9, 0, -1);
    this._cover(x + w / 2 + 0.9, z, 1, 0);
    this._cover(x - w / 2 - 0.9, z, -1, 0);
  }
  _route(pts) {
    this.patrolRoutes.push(pts.map(p => new THREE.Vector3(p[0], p[1] || 0, p[2])));
    return this.patrolRoutes.length - 1;
  }

  /** Weapon case pickup (C3): swaps into the matching loadout slot, or adds reserve ammo if already carried. */
  _weaponPickup(weaponId, x, y, z) {
    const w = WEAPON_DEFS[weaponId];
    if (!w) return;
    this.box(x, y + 0.06, z, 0.65, 0.12, 0.3, this.mat.metalDark, Mat.METAL);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.09, 0.11), this.mat.metal(1, 0x33383d));
    gun.position.set(x, y + 0.18, z);
    gun.rotation.y = 0.45;
    gun.castShadow = true;
    this.group.add(gun);
    const p = new THREE.Vector3(x, y, z);
    this.interactables.push({
      id: 'wpn_' + weaponId + '_' + x + '_' + z,
      pos: p.clone().setY(y + 0.45),
      radius: 1.7,
      prompt: 'PICK UP ' + w.name,
      getPrompt: () => 'PICK UP ' + w.name + ' — ' + w.klass,
      hold: 0.4,
      used: false,
      reusable: false,
      action: (game) => {
        const ws = game.weapons;
        const st = ws.state[weaponId];
        if (!st) return false;
        if (ws.owned.has(weaponId)) {
          const add = w.magSize * 2;
          st.reserve = Math.min(w.reserveMax, st.reserve + add);
          game.audio.pickup(p);
          game.ui.toastBrief(w.name + ' AMMO +' + add);
          return true;
        }
        const isSide = w.klass === 'SIDEARM';
        const displaced = isSide ? game.loadout.secondary : game.loadout.primary;
        if (isSide) game.loadout.secondary = weaponId;
        else game.loadout.primary = weaponId;
        ws.owned.add(weaponId);
        if (displaced && displaced !== weaponId) ws.owned.delete(displaced);   // slot limit: old weapon is dropped
        st.mag = w.magSize;
        st.reserve = Math.min(w.reserveMax, w.magSize * 2);
        st.malf = false;
        game.equipGun();
        ws.select(weaponId);
        game.audio.pickup(p);
        game.ui.toast('WEAPON ACQUIRED', w.name + ' — ' + w.klass + (isSide ? ' (REPLACES SECONDARY)' : ' (REPLACES PRIMARY)'));
        return true;
      },
    });
  }

  /** Supply crate (C3): mixed random loot — ammo / ordnance / armor — or empty. */
  _supplyCrate(i, x, y, z, forced = null) {
    this.box(x, y + 0.3, z, 0.9, 0.6, 0.62, this.mat.metal(1, 0x55604a), Mat.METAL);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.07, 0.64), this.mat.metal(1, 0x889050));
    stripe.position.set(x, y + 0.42, z);
    this.group.add(stripe);
    const p = new THREE.Vector3(x, y, z);
    this.interactables.push({
      id: 'crate_' + i,
      pos: p.clone().setY(y + 0.6),
      radius: 1.9,
      prompt: 'SEARCH SUPPLY CRATE',
      getPrompt: () => 'SEARCH SUPPLY CRATE',
      hold: 0.9,
      used: false,
      reusable: false,
      action: (game) => {
        const th = game.throwables;
        if (forced === 'empty' || (forced === null && Math.random() < 0.22)) {
          game.ui.toastBrief('THE CRATE IS EMPTY');
          game.audio.impact('metal', p, 0.4);
          return true;
        }
        const gained = [];
        const w = game.weapons.def, st = game.weapons.state[w.id];
        const addAmmo = () => { const add = w.magSize * 2; st.reserve = Math.min(w.reserveMax, st.reserve + add); gained.push(w.name + ' AMMO +' + add); };
        const n = forced ? 2 : 1 + Math.floor(Math.random() * 2.4);
        for (let k = 0; k < n; k++) {
          const roll = Math.random();
          if (roll < 0.34) addAmmo();
          else if (roll < 0.5 && th.addOne('vxfrag')) gained.push('VX-FRAG ×1');
          else if (roll < 0.64 && th.addOne('smoke')) gained.push('MS-2 SMOKE ×1');
          else if (roll < 0.76 && th.addOne('medkit')) gained.push('FIELD MEDKIT ×1');
          else if (roll < 0.86) { game.player.armor = Math.min(50, game.player.armor + 25); gained.push('ARMOR PLATE +25'); }
          else addAmmo();
        }
        game.audio.pickup(p);
        game.ui.toast('SUPPLIES RECOVERED', gained.join(' · '));
        return true;
      },
    });
  }

  /** Vehicle spawn descriptor (built by VehicleManager after world build).
   *  opts: {route:[[x,z],...] → AI driver, tag, mission, color, hpFrac}. */
  _vehicle(type, x, z, yawDeg, opts = {}) {
    this.vehicleSpawns.push({
      type,
      pos: new THREE.Vector3(x, 0, z),
      yaw: (yawDeg || 0) * Math.PI / 180,
      route: opts.route ? opts.route.map(p => new THREE.Vector3(p[0], 0, p[1])) : null,
      ai: !!opts.route,
      tag: opts.tag || null,
      mission: !!opts.mission,
      color: opts.color != null ? opts.color : null,
      hpFrac: opts.hpFrac != null ? opts.hpFrac : 1,
    });
    return this.vehicleSpawns.length - 1;
  }
  _spawn(x, y, z, route = null, kind = 'guard') {
    this.enemySpawns.push({ pos: new THREE.Vector3(x, y, z), route, kind });
  }
  _surge(x, y, z) {
    this.surgeSpawns.push({ pos: new THREE.Vector3(x, y, z) });
  }
  /** collectible intelligence document (archive-tracked via progress.js) */
  _intel(x, y, z, label) {
    const idx = this.intelPlaced.length;
    this.intelPlaced.push({ pos: new THREE.Vector3(x, y, z), label });
    const map = this.map;
    const paper = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.32), this.mat.emissiveIntel);
    paper.position.set(x, y + 0.92, z);
    paper.rotation.y = x * 0.7;
    this.group.add(paper);
    const glow = new THREE.PointLight(0x8fd694, 2.2, 2.6, 2);
    glow.position.set(x, y + 1.1, z);
    glow.userData.base = glow.intensity;
    this.group.add(glow);
    this.allLights.push(glow);
    this.interactables.push({
      id: 'intel_' + map + '_' + idx,
      pos: new THREE.Vector3(x, y + 1.0, z),
      radius: 1.6,
      prompt: 'RECOVER INTEL',
      hold: 0.7,
      used: false,
      reusable: false,
      reset: function () { this.used = false; paper.visible = true; glow.visible = true; },
      action: (game) => {
        paper.visible = false;
        glow.visible = false;
        game.onIntelPicked(map, idx, label);
        return true;
      },
    });
  }

  /** investigation evidence (mission-scoped counter) */
  _evidence(x, y, z, label) {
    const id = 'evidence_' + this.evidencePlaced();
    const prop = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.22), this.mat.emissiveIntel);
    prop.position.set(x, y + 0.9, z);
    this.group.add(prop);
    this.interactables.push({
      id,
      pos: new THREE.Vector3(x, y + 1.0, z),
      radius: 1.7,
      prompt: 'EXAMINE — ' + label,
      hold: 1.2,
      used: false,
      reusable: false,
      reset: function () { this.used = false; prop.visible = true; },
      action: (game) => {
        prop.visible = false;
        this.evidenceCollected++;
        game.audio.objectiveComplete();
        game.ui.radio('EVIDENCE LOGGED — ' + label);
        game.ui.toast('EVIDENCE', label + ' — ' + this.evidenceCollected + ' FOUND');
        return true;
      },
    });
  }
  evidencePlaced() {
    this._evCount = (this._evCount || 0) + 1;
    return this._evCount;
  }

  /** recon observation post — hold F to glass the area */
  _observe(x, y, z, id, label) {
    const tripod = this.cyl(x, y, z, 0.03, 0.05, 1.1, 5, this.mat.metalDark, Mat.METAL);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.3), this.mat.metal(2, 0x3a4148));
    head.position.set(x, y + 1.2, z);
    this.group.add(head);
    this.interactables.push({
      id,
      pos: new THREE.Vector3(x, y + 1.2, z),
      radius: 2.0,
      prompt: 'OBSERVE — ' + label,
      hold: 2.5,
      used: false,
      reusable: false,
      reset: function () { this.used = false; },
      action: (game) => {
        game.audio.objectiveComplete();
        game.ui.toast('OBSERVATION COMPLETE', label);
        tripod.visible = false; head.visible = false;
        return true;
      },
    });
  }

  /** auxiliary generator: restoring power unlocks linked doors */
  _generator(x, y, z) {
    this.box(x, y + 0.55, z, 1.5, 1.1, 0.9, this.mat.metal(3, 0x4c5a4a), Mat.METAL);
    this.cyl(x + 0.45, y + 1.35, z, 0.09, 0.09, 0.5, 6, this.mat.metalDark, Mat.METAL);
    this.box(x - 0.5, y + 1.16, z, 0.5, 0.12, 0.5, this.mat.rust, Mat.METAL);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), this.mat.emissiveRed);
    lamp.position.set(x + 0.6, y + 1.15, z + 0.46);
    this.group.add(lamp);
    this.machinePositions.push(new THREE.Vector3(x, y + 1, z));
    const self = this;
    this.interactables.push({
      id: 'generator',
      pos: new THREE.Vector3(x, y + 1.1, z),
      radius: 2.2,
      prompt: 'START AUXILIARY GENERATOR',
      getPrompt: () => (self.generatorOn ? 'GENERATOR RUNNING' : 'START AUXILIARY GENERATOR'),
      hold: 3.0,
      used: false,
      reusable: false,
      reset: function () { this.used = false; self.generatorOn = false; lamp.material = self.mat.emissiveRed; },
      action: (game) => {
        if (self.generatorOn) return false;
        self.generatorOn = true;
        lamp.material = self.mat.emissiveGreen;
        for (const d of self.poweredDoors) {
          d.locked = false;
        }
        game.audio.objectiveComplete();
        game.emitNoise(new THREE.Vector3(x, y, z), 40, 'machine');
        game.ui.toast('POWER RESTORED', 'AUXILIARY GENERATOR ONLINE — SECURITY DOORS UNLOCKED');
        game.ui.radio('GRID SECTION ENERGISED');
        return true;
      },
    });
  }

  /** sabotage charge on infrastructure */
  _sabotage(x, y, z, id, label) {
    const charge = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.12), this.mat.metal(2, 0x5a604a));
    charge.position.set(x, y + 1.05, z);
    this.group.add(charge);
    const blink = new THREE.Mesh(new THREE.SphereGeometry(0.03, 5, 4), this.mat.emissiveRed);
    blink.position.set(x, y + 1.17, z + 0.07);
    this.group.add(blink);
    const self = this;
    this.interactables.push({
      id,
      pos: new THREE.Vector3(x, y + 1.0, z),
      radius: 2.0,
      prompt: 'PLANT CHARGE — ' + label,
      hold: 4.0,
      used: false,
      reusable: false,
      reset: function () { this.used = false; charge.visible = true; blink.visible = true; },
      action: (game) => {
        charge.visible = false;
        blink.visible = false;
        self.sabotageDone++;
        game.particles.impact(new THREE.Vector3(x, y + 1, z), new THREE.Vector3(0, 1, 0), 'metal', 1.6);
        game.audio.impact('metal', new THREE.Vector3(x, y + 1, z), 1.4);
        game.emitNoise(new THREE.Vector3(x, y, z), 55, 'charge');
        game.ui.toast('CHARGE PLANTED', label + ' — ' + self.sabotageDone + ' OF 3');
        return true;
      },
    });
  }

  /** civilian / contact NPC spawn marker */
  _npc(x, z, kind, waypoints) {
    this.npcSpawns.push({
      pos: new THREE.Vector3(x, 0, z), kind,
      waypoints: (waypoints || []).map(p => new THREE.Vector3(p[0], 0, p[1])),
    });
  }

  _trig(id, x0, y0, z0, x1, y1, z1) {
    this.triggers.push({ id, min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) });
  }
  _trigR(id, x, y, z, r) {
    this.triggers.push({ id, center: new THREE.Vector3(x, y, z), radius: r });
  }
  _ammoCrate(i, x, y, z) {
    this.box(x, y, z, 0.7, 0.45, 0.5, this.mat.metal(1, 0x4a5a45), Mat.METAL);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.52), this.mat.metal(1, 0x8a7a3a));
    stripe.position.set(x, y + 0.3, z);
    this.group.add(stripe);
    const p = new THREE.Vector3(x, y, z);
    this.interactables.push({
      id: 'ammo_' + i,
      pos: p.clone().setY(y + 0.5),
      radius: 1.8,
      prompt: 'RESUPPLY AMMUNITION',
      getPrompt: () => 'RESUPPLY AMMUNITION',
      hold: 0.8,
      used: false,
      reusable: false,
      action: (game) => {
        game.player.resupplyAll();
        game.audio.pickup(p);
        game.ui.toastBrief('AMMUNITION RESUPPLIED');
        return true;
      },
    });
  }
  /** objective computer: hold-F download, completes through missions.onTerminalComplete */
  _objective(x, y, z, holdSec = 8, label = 'ACCESS THE TERMINAL') {
    this.terminalPos.set(x, y, z);
    this.box(x, y, z + 0.4, 1.8, 0.75, 0.8, this.mat.metalDark, Mat.METAL);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.05), this.mat.emissiveScreen);
    screen.position.set(x, y + 1.15, z + 0.3);
    screen.rotation.x = -0.12;
    this.group.add(screen);
    this.terminalScreen = screen;
    const glow = new THREE.PointLight(0x35d97a, 9, 5, 2);
    glow.position.set(x, y + 1.2, z + 0.5);
    glow.userData.base = glow.intensity;
    this.group.add(glow);
    this.allLights.push(glow);
    this.terminalGlow = glow;
    this.interactables.push({
      id: 'terminal',
      pos: new THREE.Vector3(x, y + 1.0, z + 0.5),
      radius: 2.2,
      prompt: label,
      getPrompt: () => label,
      hold: holdSec,
      used: false,
      reusable: false,
      action: (game) => { game.missions.onTerminalComplete(); return true; },
    });
  }
  /** extraction LZ: pad marker + blinking beacon */
  _lz(x, z, color = 0x47d95f) {
    this.extractionPoint.set(x, 0, z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.7, 24), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 1, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03, z);
    this.group.add(ring);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const l = new THREE.PointLight(color, 12, 8, 2);
      l.userData.base = l.intensity;
      l.position.set(x + Math.cos(a) * 2.45, 0.25, z + Math.sin(a) * 2.45);
      this.group.add(l);
      this.allLights.push(l);
      this._blinkLights = this._blinkLights || [];
      this._blinkLights.push(l);
    }
    this._trigR('extraction', x, 0, z, 4.5);
  }
  _pine(x, z, h = 7, rnd = Math.random) {
    this.cyl(x, 0, z, 0.16, 0.24, h * 0.4, 6, this.mat.wood(1), Mat.WOOD);
    for (let i = 0; i < 3; i++) {
      const yy = h * (0.32 + i * 0.22);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(h * 0.22 * (1 - i * 0.24), h * 0.34, 7), this.mat.foliage || this.mat.wood(1, 0x24382a));
      cone.position.set(x, yy, z);
      cone.castShadow = true;
      this.group.add(cone);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(h * 0.20 * (1 - i * 0.24), h * 0.10, 7), this.mat.snow(2));
      cap.position.set(x, yy + h * 0.13, z);
      this.group.add(cap);
    }
    void rnd;
  }
  _palm(x, z, h = 6) {
    this.cyl(x, 0, z, 0.12, 0.2, h, 6, this.mat.wood(1, 0x6b5636), Mat.WOOD);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const frond = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 0.5), this.mat.wood(1, 0x3c5a30));
      frond.position.set(x + Math.cos(a) * 1.1, h - 0.15, z + Math.sin(a) * 1.1);
      frond.rotation.y = -a;
      frond.rotation.z = 0.42;
      this.group.add(frond);
    }
  }
  _wreck(x, z, rotY, color = 0x4a4038) {
    const g = this.group;
    const body = this.box(x, 0, z, 4.4, 1.3, 1.9, this.mat.metal(0.6, color), Mat.METAL, { rotY });
    void body;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 1.7), this.mat.metal(0.6, color));
    cab.position.set(x - Math.cos(rotY) * 0.6, 1.55, z + Math.sin(rotY) * 0.6);
    cab.rotation.y = rotY;
    g.add(cab);
    for (const [wx, wz] of [[-1.5, 0.95], [-1.5, -0.95], [1.5, 0.95], [1.5, -0.95]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10), this.mat.rubber || this.mat.metalDark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(
        x + Math.cos(rotY) * wx - Math.sin(rotY) * wz * 0, 0.42,
        z + Math.sin(rotY) * wx * 0 + wz
      );
      wheel.rotation.y = rotY;
      g.add(wheel);
    }
  }
  buildByMap(map, scene, physics) {
    if (map === 'snow') this.buildSnow(scene, physics);
    else if (map === 'desert') this.buildDesert(scene, physics);
    else if (map === 'urban') this.buildUrban(scene, physics);
    else if (map === 'industrial') this.buildIndustrial(scene, physics);
    else if (map === 'rural') this.buildRural(scene, physics);
    else if (map === 'range') this.buildRange(scene, physics);
    else this.build(scene, physics);
  }

  build(scene, physics) {
    this.map = 'facility';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);

    const rnd = mulberry32(1337);
    this.rnd = rnd;

    this._buildGround();
    this._buildFence();
    this._buildWarehouse();
    this._buildOffices();
    this._buildCatwalk();
    this._buildDock();
    this._buildYardProps(rnd);
    this._buildVehicles();
    this._buildExtraction();
    this._buildTerminal();
    this._buildPickups();
    this._buildFloods();

    // audio reverb zones
    this.zones.push(
      { name: 'warehouse', min: new THREE.Vector3(-30, 0, -45), max: new THREE.Vector3(30, 10, 15) },
      { name: 'room', min: new THREE.Vector3(10, 0, -44.5), max: new THREE.Vector3(29.5, 8, -20) },
      { name: 'corridor', min: new THREE.Vector3(10, 0, -33.5), max: new THREE.Vector3(29.5, 8, -29.5) },
    );
    // exclude office interiors from the warehouse zone
    this.zones[0].exclude = { min: new THREE.Vector3(10, 0, -44.5), max: new THREE.Vector3(29.5, 8, -20) };

    this.weather = null; this.windLevel = 0.12;
    // recoverable intelligence scattered through the yard and wings
    this._intel(8, 0, 40, 'MANIFEST FRAGMENT');
    this._intel(-12, 0, 34, 'GUARD ROTA');
    this._intel(18, 0, 52, 'SERVER ROOM KEYCARD');
    this._intel(-4, 0, 16, 'SHIPMENT LEDGER');

    this.spawnPoint.set(0, 0, 88);
    this.spawnYaw = 0; // yaw 0 faces -Z (north, toward the facility)
    this.extractionPoint.set(-40, 0, 54);
    // vehicles (C2) — utility SUV parked in the south yard
    this._vehicle('suv', -44, 50, -90);   // west yard strip — probed clear
    // pickups & crates (C3)
    this._supplyCrate(90, 4, 0, 62);
    this._supplyCrate(91, -8, 0, 58);
    this._weaponPickup('mpx5', -12, 0, 60);
  }

  _buildGround() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(320, 320),
      this.mat.gravel(60)
    );
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    g.matrixAutoUpdate = false; g.updateMatrix();
    this.group.add(g);
    this.physics.add(new THREE.Vector3(-160, -1, -160), new THREE.Vector3(160, 0, 160), Mat.GRAVEL, { tag: 'ground' });

    // asphalt apron around buildings
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), this._cached('asphalt', () => {
      const m = this.mat.gravel(30).clone();
      m.color = new THREE.Color(0x4c4a47);
      return m;
    }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.015, 5);
    apron.receiveShadow = true;
    apron.matrixAutoUpdate = false; apron.updateMatrix();
    this.group.add(apron);
  }

  _buildFence() {
    const H = 3, T = 0.14;
    const fenceMat = this._cached('fence', () => new THREE.MeshStandardMaterial({
      color: 0x2e332e, roughness: 0.8, metalness: 0.4,
      transparent: true, opacity: 0.88, side: THREE.DoubleSide,
    }));
    const X = 70, Z1 = 70, Z2 = -70;
    const seg = (x, z, w, d) => {
      this.box(x, 0, z, w, H, d, fenceMat, Mat.METAL, { cast: false });
      // top rail
      this.box(x, H, z, w, 0.08, d + 0.05, this.mat.metalDark, Mat.METAL, { noCollider: true, cast: false });
    };
    // south fence with a breach gap at x∈[-3,3] (the infiltration point)
    seg(-36.5, Z1, 67, T);
    seg(36.5, Z1, 67, T);
    // breach posts + cut marks
    this.box(-3.3, 0, Z1, 0.25, H, 0.25, this.mat.metalDark, Mat.METAL);
    this.box(3.3, 0, Z1, 0.25, H, 0.25, this.mat.metalDark, Mat.METAL);
    // north / east / west
    seg(0, Z2, X * 2, T);
    seg(X, 0, T, Z1 * 2);
    seg(-X, 0, T, Z1 * 2);

    // north vehicle gate (closed)
    this.box(0, 0, Z2 + 0.4, 8, 4, 0.3, this.mat.corrugated(0x4a4f47, 2), Mat.METAL);

    // trigger: breach / infiltration point
    this.triggers.push({ id: 'breach', min: new THREE.Vector3(-4, 0, 66), max: new THREE.Vector3(4, 3, 71) });
  }

  _buildWarehouse() {
    const WM = this.mat.concrete(6);
    const WM2 = this.mat.metal(3, 0x565d66);
    const H = 10, T = 0.5;
    const x0 = -30, x1 = 30, z0 = -45, z1 = 15;

    // floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), this.mat.floorConc(20));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.03, (z0 + z1) / 2);
    floor.receiveShadow = true;
    floor.matrixAutoUpdate = false; floor.updateMatrix();
    this.group.add(floor);

    // --- south wall (z = z1): roll-up opening x[-5,5] h5 + personnel door gap x[-20.6,-19.4] ---
    void WM2;
    this._southWallFixup(x0, x1, z1, H, T, WM);

    // --- north wall (z = z0): dock opening x[-20,-12] h4 (west side, clear of the office wing) ---
    this.box(-25, 0, z0, 10, H, T, WM, Mat.CONCRETE);          // x -30..-20
    this.box(9, 0, z0, 42, H, T, WM, Mat.CONCRETE);            // x -12..30
    this.box(-16, 4, z0, 8, H - 4, T, WM, Mat.CONCRETE);       // lintel above dock door y4..10
    // dock roll-up door (slideUp, starts closed)
    new Door(this, {
      position: new THREE.Vector3(-20, 0, z0 + 0.28), rotY: 0,
      width: 8, height: 4, thickness: 0.16, slideUp: true,
    });

    // --- east wall (x = x1): window gaps z[-30..-26], [-20..-16], [-10..-6], y3..6 ---
    this.box(x1, 0, -15, T, 3, 60, WM, Mat.CONCRETE);          // sill band y0..3 (z -45..15)
    this.box(x1, 6, -22.5, T, 4, 45, WM, Mat.CONCRETE);        // head band y6..10 (z -45..0)
    this.box(x1, 3, 7.5, T, 7, 15, WM, Mat.CONCRETE);          // z 0..15 upper
    this.box(x1, 3, -37.5, T, 3, 15, WM, Mat.CONCRETE);        // pier z -45..-30
    this.box(x1, 3, -23, T, 3, 6, WM, Mat.CONCRETE);           // pier z -26..-20
    this.box(x1, 3, -13, T, 3, 6, WM, Mat.CONCRETE);           // pier z -16..-10
    this.box(x1, 3, -3, T, 3, 6, WM, Mat.CONCRETE);            // pier z -6..0
    // breakable window glass
    for (const wz of [-28, -18, -8]) {
      this._window(x1 - 0.02, 3, wz - 2, 4, 3, 'x');
    }

    // west wall (x = x0): solid
    this.box(x0, 0, (z0 + z1) / 2, T, H, z1 - z0, WM, Mat.CONCRETE);

    // roof (casts shadow so the interior stays lamp-lit — strong indoor/outdoor contrast)
    this.box(0, H, (z0 + z1) / 2, x1 - x0 + 1.2, 0.4, z1 - z0 + 1.2, this.mat.corrugated(0x3c4138, 8), Mat.METAL, { cast: true });

    // pillars (two rows)
    for (const px of [-16, 0, 16]) {
      for (let pz = -39; pz <= 9; pz += 12) {
        if (px === 16 && pz < -19) continue; // office wing occupies east end
        this.box(px, 0, pz, 0.6, H, 0.6, this.mat.concrete(3), Mat.CONCRETE);
        // pillar base plate
        this.box(px, 0, pz, 0.9, 0.15, 0.9, this.mat.metalDark, Mat.METAL, { noCollider: true });
      }
    }

    // ceiling pipes (decorative runs along X)
    const pipeMat = this.mat.metal(6, 0x6a7076);
    for (const [pz, py, r] of [[-32, 8.6, 0.16], [-14, 8.9, 0.11], [2, 8.5, 0.2], [10, 9.1, 0.09]]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 58, 8), pipeMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(0, py, pz);
      pipe.castShadow = false;
      this.group.add(pipe);
      // supports
      for (let sx = -24; sx <= 24; sx += 12) {
        const sup = new THREE.Mesh(new THREE.BoxGeometry(0.06, 10 - py + 0.3, 0.06), this.mat.metalDark);
        sup.position.set(sx, py + (10 - py) / 2 - 0.15, pz);
        this.group.add(sup);
      }
    }

    // hanging industrial lamps — two rows
    const lampRows = [-30, -15, 0];
    for (const lz of lampRows) {
      for (const lx of [-18, 0, 14]) {
        const shadow = (lx === 0 && lz === -15) || (lx === -18 && lz === 0);
        this._lampHang(lx, 7.4, lz, shadow);
      }
    }

    // interior clutter: crates, racks, machines, barrels
    this._warehouseProps();
  }

  _southWallFixup(x0, x1, z1, H, T, WM) {
    // (x0=-30, x1=30, z1=15) personnel door gap x[-20.6,-19.4] height 2.4; roll-up gap x[-5,5] height 5
    this.box((x0 + -20.6) / 2, 0, z1, -20.6 - x0, H, T, WM, Mat.CONCRETE);          // A
    this.box((-19.4 + -5) / 2, 0, z1, -5 + 19.4, H, T, WM, Mat.CONCRETE);           // B
    this.box(-20, 2.4, z1, 1.2, H - 2.4, T, WM, Mat.CONCRETE);                      // lintel over personnel door
    this.box(0, 5, z1, 10, H - 5, T, WM, Mat.CONCRETE);                             // C lintel over roll-up
    this.box((5 + x1) / 2, 0, z1, x1 - 5, H, T, WM, Mat.CONCRETE);                  // D
    // half-raised corrugated roll-up shutter above the main entrance (visual)
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(10, 1.6, 0.14), this.mat.corrugated(0x50565c, 4));
    shutter.position.set(0, 5 - 0.8, z1 + 0.05);
    shutter.castShadow = true;
    this.group.add(shutter);
    // partial side panels so the 5m-high opening reads as a doorway, not a tunnel
    // personnel door (swing)
    new Door(this, {
      position: new THREE.Vector3(-20.55, 0, z1 + 0.05), rotY: 0,
      width: 1.1, height: 2.35, material: this.mat.doorMetal,
    });
    // office exterior side door on south wall east end (leads nowhere — boarded)
    this.box(24, 0, z1 + 0.3, 2, 2.4, 0.12, this.mat.wood(1), Mat.WOOD);
  }

  _lightShaft(x, y, z, bottomR = 2.4, len = null) {
    const L = len == null ? y - 0.2 : len;
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, bottomR, L, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe2b8, transparent: true, opacity: 0.05, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      })
    );
    cone.position.set(x, y - L / 2, z);
    this.group.add(cone);
    if (!this._motes) this._makeMotes();
  }
  _makeMotes() {
    const n = 140;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = -28 + Math.random() * 56;
      pos[i * 3 + 1] = 0.4 + Math.random() * 8;
      pos[i * 3 + 2] = -42 + Math.random() * 54;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._motes = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xd8ccb0, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false,
    }));
    this.group.add(this._motes);
  }

  _lampHang(x, y, z, shadow) {
    // cord
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 10 - y - 0.2, 4), this.mat.metalDark);
    cord.position.set(x, y + (10 - y) / 2, z);
    this.group.add(cord);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.34, 12, 1, true), this.mat.metal(1, 0x3c4a44));
    shade.position.set(x, y + 0.14, z);
    shade.rotation.x = Math.PI;
    shade.castShadow = false;
    this.group.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), this.mat.emissiveLamp);
    bulb.position.set(x, y - 0.05, z);
    this.group.add(bulb);
    const light = new THREE.SpotLight(0xffe6c0, 300, 26, Math.PI / 3.1, 0.55, 1.7);
    light.position.set(x, y, z);
    this.shootables.push({ pos: new THREE.Vector3(x, y - 0.05, z), r: 0.26, light, bulb });
    light.target.position.set(x, 0, z);
    this.group.add(light);
    this.group.add(light.target);
    this.allLights.push(light);
    light.userData.base = light.intensity;
    this._lightShaft(x, y, z, shadow ? 2.8 : 2.2);
    if (shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.003;
      light.shadow.camera.near = 1;
      light.shadow.camera.far = 26;
      this.shadowLights.push(light);
    }
  }

  _window(x, y, z, w, h, axis) {
    // frame (verticals at both jambs, head + sill)
    const fm = this.mat.metalDark;
    if (axis === 'x') {
      this.box(x, y, z + 0.07, 0.14, h, 0.14, fm, Mat.METAL, { noCollider: true });
      this.box(x, y, z + w - 0.07, 0.14, h, 0.14, fm, Mat.METAL, { noCollider: true });
      this.box(x, y + h, z + w / 2, 0.16, 0.14, w + 0.2, fm, Mat.METAL, { noCollider: true });
      this.box(x, y - 0.14, z + w / 2, 0.16, 0.14, w + 0.2, fm, Mat.METAL, { noCollider: true });
    }
    if (axis !== 'x') {
      this.box(x - w / 2 + 0.07, y, z, 0.14, h, 0.14, fm, Mat.METAL, { noCollider: true });
      this.box(x + w / 2 - 0.07, y, z, 0.14, h, 0.14, fm, Mat.METAL, { noCollider: true });
      this.box(x, y + h, z, w + 0.2, 0.14, 0.16, fm, Mat.METAL, { noCollider: true });
      this.box(x, y - 0.14, z, w + 0.2, 0.14, 0.16, fm, Mat.METAL, { noCollider: true });
    }
    // glass pane (breakable collider + mesh)
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat.glass);
    pane.rotation.y = axis === 'x' ? Math.PI / 2 : 0;
    if (axis === 'x') pane.position.set(x, y + h / 2, z + w / 2);
    else pane.position.set(x, y + h / 2, z);
    this.group.add(pane);
    const min = axis === 'x'
      ? new THREE.Vector3(x - 0.08, y, z)
      : new THREE.Vector3(x - w / 2, y, z - 0.08);
    const max = axis === 'x'
      ? new THREE.Vector3(x + 0.08, y + h, z + w)
      : new THREE.Vector3(x + w / 2, y + h, z + 0.08);
    const col = this.physics.add(min, max, Mat.GLASS, { tag: 'glass', breakable: true });
    this.glassPanes.push({ collider: col, mesh: pane });
    col.entity = { pane: this.glassPanes[this.glassPanes.length - 1] };
  }

  _warehouseProps() {
    const rnd = this.rnd;
    // --- crate clusters (instanced) ---
    const crateGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
    const clusters = [
      [-24, 4, 5], [-22, -8, 4], [-8, 8, 4], [6, 10, 3], [24, 6, 4],
      [-12, -12, 5], [4, -16, 4], [-24, -24, 5], [-4, -30, 4], [6, -38, 3],
      [-4, -42, 4], [-27, -30, 3],
    ];
    const crateT = [];
    const crateR = [];
    for (const [cx, cz, n] of clusters) {
      for (let i = 0; i < n; i++) {
        const stack = i % 3 === 0 && rnd() > 0.4 ? 2 : 1;
        for (let s = 0; s < stack; s++) {
          crateT.push({
            p: new THREE.Vector3(cx + (rnd() - 0.5) * 3.4, s * 1.2 + 0.6, cz + (rnd() - 0.5) * 3.4),
            s: new THREE.Vector3(0.9 + rnd() * 0.25, 0.9 + rnd() * 0.2, 0.9 + rnd() * 0.25),
          });
          crateR.push((rnd() - 0.5) * 0.5);
        }
      }
    }
    // instanced with rotation → per-instance AABB colliders (conservative)
    {
      const inst = new THREE.InstancedMesh(crateGeo, this.mat.wood(1), crateT.length);
      inst.castShadow = true; inst.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      crateT.forEach((t, i) => {
        e.set(0, crateR[i], 0); q.setFromEuler(e);
        m.compose(t.p, q, t.s);
        inst.setMatrixAt(i, m);
        const size = new THREE.Vector3(1.2, 1.2, 1.2).multiply(t.s);
        // conservative AABB for rotated crate
        const c = Math.abs(Math.cos(crateR[i])), s = Math.abs(Math.sin(crateR[i]));
        this.physics.addBox(t.p, new THREE.Vector3(size.x * c + size.z * s, size.y, size.x * s + size.z * c), Mat.WOOD, { tag: 'prop' });
        // cover point beside each cluster crate (some)
        if (rnd() > 0.72) {
          const nx = Math.cos(crateR[i]), nz = -Math.sin(crateR[i]);
          this.coverPoints.push({ pos: new THREE.Vector3(t.p.x + nx * 1.1, 0, t.p.z + nz * 1.1), normal: new THREE.Vector3(nx, 0, nz) });
        }
      });
      this.group.add(inst);
    }

    // --- shelving racks ---
    const rackMat = this.mat.metal(2, 0x8a4a2e);
    const buildRack = (x, z, len, rotY = 0) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      const nBays = Math.floor(len / 2);
      for (let b = 0; b <= nBays; b++) {
        const up = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.6, 0.9), rackMat);
        up.position.set(-len / 2 + b * 2, 1.3, 0);
        up.castShadow = true;
        g.add(up);
      }
      for (let sh = 0; sh < 3; sh++) {
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.9), rackMat);
        shelf.position.y = 0.5 + sh * 0.95;
        shelf.castShadow = true; shelf.receiveShadow = true;
        g.add(shelf);
        // items on shelves
        for (let it = 0; it < nBays * 1.5; it++) {
          if (rnd() > 0.7) continue;
          const bx = new THREE.Mesh(
            new THREE.BoxGeometry(0.4 + rnd() * 0.5, 0.25 + rnd() * 0.4, 0.4 + rnd() * 0.3),
            rnd() > 0.5 ? this.mat.wood(1) : this.mat.metal(1, 0x666c72)
          );
          bx.position.set(-len / 2 + 0.5 + rnd() * (len - 1), 0.5 + sh * 0.95 + 0.2, (rnd() - 0.5) * 0.5);
          g.add(bx);
        }
      }
      this.group.add(g);
      // collider along the rack
      const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
      this.physics.addBox(new THREE.Vector3(x, 1.3, z), new THREE.Vector3(len * c + 0.9 * s, 2.6, len * s + 0.9 * c), Mat.METAL, { tag: 'prop' });
      this.coverPoints.push({ pos: new THREE.Vector3(x + Math.sin(rotY) * 1.1, 0, z + Math.cos(rotY) * 1.1), normal: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)) });
      this.coverPoints.push({ pos: new THREE.Vector3(x - Math.sin(rotY) * 1.1, 0, z - Math.cos(rotY) * 1.1), normal: new THREE.Vector3(-Math.sin(rotY), 0, -Math.cos(rotY)) });
    };
    buildRack(-8, -6, 8, 0);
    buildRack(8, -4, 8, 0);
    buildRack(-8, -22, 8, 0);
    buildRack(2, -26, 6, Math.PI / 2);
    buildRack(-20, -16, 6, Math.PI / 2);

    // --- big machines (hum sources) ---
    const buildMachine = (x, z, w, h, d) => {
      this.box(x, 0, z, w, h, d, this.mat.metal(2, 0x4f5a52), Mat.METAL);
      this.box(x, h, z, w * 0.6, 0.5, d * 0.6, this.mat.metalDark, Mat.METAL, { noCollider: true });
      // vents
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.1, 12), this.mat.metalDark);
      vent.rotation.x = Math.PI / 2;
      vent.position.set(x, h * 0.6, z + d / 2 + 0.02);
      this.group.add(vent);
      // status light
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), rnd() > 0.5 ? this.mat.emissiveRed : this.mat.emissiveGreen);
      lamp.position.set(x + w / 2 - 0.2, h - 0.15, z + d / 2 + 0.05);
      this.group.add(lamp);
      this.machinePositions.push(new THREE.Vector3(x, 1, z));
      this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z + d / 2 + 1), normal: new THREE.Vector3(0, 0, 1) });
      this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z - d / 2 - 1), normal: new THREE.Vector3(0, 0, -1) });
    };
    buildMachine(-5, -35.5, 4, 2.8, 2.4);
    buildMachine(4, -10, 3, 2.2, 2);
    buildMachine(-26.5, 11.5, 2.6, 3.4, 2.6);
    buildMachine(6, 2, 3.4, 2, 2.2);

    // --- barrels ---
    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 10);
    const spots = [];
    for (const [bx, bz, n] of [[-16, 12, 4], [10, 8, 3], [-28, -8, 5], [14, -34, 4], [-10, -34, 3], [26, -8, 3]]) {
      for (let i = 0; i < n; i++) spots.push(new THREE.Vector3(bx + (rnd() - 0.5) * 2, 0.475, bz + (rnd() - 0.5) * 2));
    }
    for (const p of spots) {
      const b = new THREE.Mesh(barrelGeo, rnd() > 0.6 ? this.mat.rust : this.mat.metal(1, 0x55605a));
      b.position.copy(p);
      b.castShadow = true; b.receiveShadow = true;
      this.group.add(b);
      this.physics.addBox(p, new THREE.Vector3(0.64, 0.95, 0.64), Mat.METAL, { tag: 'prop' });
    }

    // --- pallets + floor decals (no colliders) ---
    for (let i = 0; i < 10; i++) {
      const px = -26 + rnd() * 52, pz = -42 + rnd() * 54;
      if (px > 8 && pz < -18) continue; // skip office wing
      const pallet = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.1), this.mat.wood(1));
      pallet.position.set(px, 0.09, pz);
      pallet.receiveShadow = true;
      this.group.add(pallet);
    }

    // cover points around pillars
    for (const px of [-16, 0, 16]) {
      for (let pz = -39; pz <= 9; pz += 12) {
        if (px === 16 && pz < -19) continue;
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          this.coverPoints.push({ pos: new THREE.Vector3(px + nx * 0.8, 0, pz + nz * 0.8), normal: new THREE.Vector3(nx, 0, nz) });
        }
      }
    }
  }

  _buildOffices() {
    // -----------------------------------------------------------------------
    // Two-storey office wing attached inside the warehouse's east end.
    // Footprint x[10,29.5] z[-44,-20]. Ground: security office, storage,
    // corridor, stairwell. Upper: server room (data terminal), office,
    // corridor overlooking a stair void with railings.
    // -----------------------------------------------------------------------
    const ox0 = 10;
    const WM = this.mat.concrete(4);
    const PW = this.mat.concrete(3);
    const H = 4;      // floor-to-floor
    const TH = 0.24;  // partition thickness

    // ---- west face (x = 10): ground door gap z[-33,-32] ----
    this.box(ox0, 0, -38.5, 0.3, H, 11, WM, Mat.CONCRETE);        // z -44..-33 ground
    this.box(ox0, 2.3, -32.5, 0.3, H * 2 - 2.3, 1, WM, Mat.CONCRETE); // lintel over door (y2.3..8)
    this.box(ox0, 0, -31, 0.3, H * 2, 2, WM, Mat.CONCRETE);       // z -32..-30 full height
    this.box(ox0, H, -38.5, 0.3, H, 11, WM, Mat.CONCRETE);        // z -44..-33 upper
    new Door(this, {
      position: new THREE.Vector3(ox0 + 0.2, 0, -33), rotY: -Math.PI / 2,
      width: 1.0, height: 2.3,
    });

    // ---- south face (z = -20) ----
    this.box(19.75, 0, -20, 19.5, H, 0.3, WM, Mat.CONCRETE);
    this.box(19.75, H, -20, 19.5, H, 0.3, WM, Mat.CONCRETE);

    // ---- wing ceiling (y 7.7..8) ----
    this.box(19.75, 7.7, -32, 19.5, 0.3, 24, WM, Mat.CONCRETE, { cast: false });

    // ---- security office partition (z = -33, x 10..19.5; door gap x[17.2,18.2]) ----
    this.box(13.6, 0, -33, 7.2, H, TH, PW, Mat.CONCRETE);
    this.box(18.85, 0, -33, 1.3, H, TH, PW, Mat.CONCRETE);
    this.box(17.7, 2.3, -33, 1.0, H - 2.3, TH, PW, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(17.2, 0, -33.15), rotY: 0,
      width: 1.0, height: 2.3,
    });

    // ---- storage partition (x = 20, z -44..-33; door gap z[-39,-38]) ----
    this.box(20, 0, -41.5, TH, H, 5, PW, Mat.CONCRETE);
    this.box(20, 0, -35.5, TH, H, 5, PW, Mat.CONCRETE);
    this.box(20, 2.3, -38.5, TH, H - 2.3, 1, PW, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(20.15, 0, -38), rotY: Math.PI / 2,
      width: 1.0, height: 2.3,
    });

    // ---- upper floor slabs (top surface exactly y = 4.0) ----
    const SY = H - 0.3;
    this.box(16.5, SY, -32, 13, 0.3, 24, WM, Mat.CONCRETE, { cast: false });   // A x10..23 z-44..-20
    this.box(26.25, SY, -40, 6.5, 0.3, 8, WM, Mat.CONCRETE, { cast: false });  // B x23..29.5 z-44..-36
    this.box(26.25, SY, -22, 6.5, 0.3, 4, WM, Mat.CONCRETE, { cast: false });  // C x23..29.5 z-24..-20
    this.box(28.9, SY, -30, 1.2, 0.3, 12, WM, Mat.CONCRETE, { cast: false });  // D x28.3..29.5 z-36..-24
    // stair void: x[23,28.3] z[-36,-24]

    // ---- void railings (colliders so nobody falls) ----
    const rail = (x, z, w, d) => {
      this.box(x, H, z, w, 1.05, d, this.mat.metalDark, Mat.METAL);
      this.box(x, H + 1.0, z, w + 0.04, 0.05, d + 0.04, this.mat.metalDark, Mat.METAL, { noCollider: true });
    };
    rail(23.06, -29.5, 0.07, 11);    // west edge of void (gap at z -36..-35 for stair head)
    rail(25.65, -24.06, 5.3, 0.07);  // south edge
    rail(28.24, -30, 0.07, 12);      // east walkway inner edge
    rail(27.1, -36.06, 2.4, 0.07);   // slab B edge beside stair head

    // ---- server room partition (z = -32 upper; door gap x[16.2,17.6]) ----
    this.box(13.1, H, -32, 6.2, H, TH, PW, Mat.CONCRETE);
    this.box(18.8, H, -32, 2.4, H, TH, PW, Mat.CONCRETE);
    this.box(16.9, H + 2.3, -32, 1.4, H - 2.3, TH, PW, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(16.2, H, -32.15), rotY: 0,
      width: 1.4, height: 2.3,
    });

    // ---- stairs (x 23.5..25.9): ground→landing→upper, tops flush with slabs ----
    const stepMat = this.mat.concrete(2);
    for (let i = 0; i < 10; i++) {
      this.box(24.7, 0.2 * i, -22 - i * 0.6, 2.4, 0.2, 0.6, stepMat, Mat.CONCRETE, { cast: false });
    }
    this.box(24.7, 1.7, -29, 2.4, 0.3, 2, stepMat, Mat.CONCRETE, { cast: false }); // landing top y2.0
    for (let i = 0; i < 10; i++) {
      this.box(24.7, 2.0 + 0.2 * i, -30 - i * 0.6, 2.4, 0.2, 0.6, stepMat, Mat.CONCRETE, { cast: false });
    }
    // stair side stringers (visual)
    this.box(23.4, 0, -29, 0.1, 8, 14, PW, Mat.CONCRETE, { noCollider: true, cast: false });
    this.box(26.0, 0, -29, 0.1, 8, 14, PW, Mat.CONCRETE, { noCollider: true, cast: false });

    // ---- furniture ----
    const deskMat = this.mat.wood(1);
    const buildDesk = (x, y, z, rotY = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, z); g.rotation.y = rotY;
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.8), deskMat);
      top.position.y = 0.75; top.castShadow = true; top.receiveShadow = true;
      g.add(top);
      for (const [lx, lz] of [[-0.7, -0.3], [0.7, -0.3], [-0.7, 0.3], [0.7, 0.3]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), this.mat.metalDark);
        leg.position.set(lx, 0.375, lz);
        g.add(leg);
      }
      this.group.add(g);
      this.physics.addBox(new THREE.Vector3(x, y + 0.39, z), new THREE.Vector3(1.7, 0.78, 0.9), Mat.WOOD, { tag: 'prop' });
      return g;
    };
    const buildChair = (x, y, z) => {
      const g = new THREE.Group(); g.position.set(x, y, z);
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), this.mat.fabric);
      seat.position.y = 0.45; g.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), this.mat.fabric);
      back.position.set(0, 0.73, -0.22); g.add(back);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 6), this.mat.metalDark);
      pole.position.y = 0.22; g.add(pole);
      this.group.add(g);
    };
    buildDesk(14, 0, -40, 0.2); buildChair(14.1, 0, -39);
    buildDesk(16.5, 0, -41.5, -0.4); buildChair(16.6, 0, -40.4);
    buildDesk(25, 0, -41, 0); buildChair(25, 0, -40);
    buildDesk(26, H, -40, 0.3); buildChair(26, H, -39);
    buildDesk(27.8, H, -42.4, -0.2);
    // whiteboard + wall notice
    const wb = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 0.05), this.mat.whiteboard);
    wb.position.set(26, H + 1.5, -43.8);
    this.group.add(wb);
    // storage shelves
    for (let i = 0; i < 3; i++) {
      this.box(22 + i * 2.6, 0, -42, 0.6, 2.2, 3.4, this.mat.metal(1, 0x5c636a), Mat.METAL);
    }
    // server racks (upper, x10..20 z-44..-32)
    for (let i = 0; i < 4; i++) {
      this.box(11.8 + i * 2.1, H, -40.5, 0.8, 2.1, 1.1, this.mat.metal(1, 0x2f343a), Mat.METAL);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.02), i % 2 ? this.mat.emissiveGreen : this.mat.emissiveScreen);
      led.position.set(11.8 + i * 2.1, H + 1.6, -39.93);
      this.group.add(led);
    }

    // ---- interior lights ----
    this._lamp(14.5, 3.4, -38, 0xffd9a8, 12, 10);   // security
    this._lamp(25, 3.4, -38, 0xffd9a8, 12, 10);      // storage
    this._lamp(15, 3.4, -31.5, 0xffe0b4, 10, 9);     // corridor
    this._lamp(24.7, 3.4, -25.5, 0xffe0b4, 10, 9);   // stairwell
    this._lamp(15, 7.35, -38, 0xbfe8ff, 12, 10);     // server room (cold)
    this._lamp(17, 7.35, -30.5, 0xffe8c8, 10, 9);    // upper corridor
    this._lamp(26, 7.35, -40, 0xffe8c8, 10, 9);      // upstairs office

    // ---- patrols & spawns ----
    this.patrolRoutes.push([
      new THREE.Vector3(11.5, 0, -31.5), new THREE.Vector3(18.5, 0, -31.5),
      new THREE.Vector3(27, 0, -31.5), new THREE.Vector3(27, 0, -23),
      new THREE.Vector3(15, 0, -36), new THREE.Vector3(13, 0, -41),
    ]);
    this.patrolRoutes.push([
      new THREE.Vector3(15, H, -30.5), new THREE.Vector3(21.5, H, -30.5),
      new THREE.Vector3(24.7, H, -34.6), new THREE.Vector3(26.5, H, -38),
      new THREE.Vector3(27.5, H, -22.5),
    ]);
    this.enemySpawns.push({ pos: new THREE.Vector3(15, 0, -31.5), route: this.patrolRoutes.length - 2, kind: 'guard' });
    this.enemySpawns.push({ pos: new THREE.Vector3(21, H, -30.5), route: this.patrolRoutes.length - 1, kind: 'guard' });

    this.triggers.push({ id: 'enter_facility', min: new THREE.Vector3(-29, 0, -44), max: new THREE.Vector3(29, 9, 14) });
  }

  _buildCatwalk() {
    const y = 4.2, x = -27;
    const deckMat = this.mat.metal(6, 0x4a4f55);
    // deck runs z -40..10 along the west wall (top surface exactly y)
    this.box(x, y - 0.12, -15, 4, 0.12, 50, deckMat, Mat.METAL, { cast: false });
    // railing on the inner edge (WITH collider — falling 4 m hurts)
    this.box(x + 2, y, -15, 0.06, 1.05, 50, this.mat.metalDark, Mat.METAL);
    for (let z = -39; z <= 9; z += 3) {
      this.box(x + 2, y, z, 0.05, 1.05, 0.05, this.mat.metalDark, Mat.METAL, { noCollider: true });
    }
    // support columns
    for (let z = -37; z <= 8; z += 9) {
      this.cyl(x - 1, 0, z, 0.09, 0.11, y, 6, this.mat.metalDark, Mat.METAL);
      this.cyl(x + 1.4, 0, z, 0.09, 0.11, y, 6, this.mat.metalDark, Mat.METAL);
    }
    // stairs from the floor up to the deck (14 × 0.3 m rises — walkable via step-up)
    for (let i = 0; i < 14; i++) {
      const sy = (y / 14) * i, sz = 10 - i * 0.55;
      this.box(x, sy, sz, 2.2, y / 14, 0.55, deckMat, Mat.METAL, { cast: false });
    }
    // stair handrail (visual)
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 8.4), this.mat.metalDark);
    rail.position.set(x + 1.1, y / 2 + 0.95, 6.2);
    rail.rotation.x = -Math.atan2(y, 7.7);
    this.group.add(rail);

    // catwalk patrol + cover
    this.patrolRoutes.push([
      new THREE.Vector3(x + 0.8, y, -36), new THREE.Vector3(x + 0.8, y, 6),
    ]);
    this.enemySpawns.push({ pos: new THREE.Vector3(x + 0.8, y, -30), route: this.patrolRoutes.length - 1, kind: 'guard' });
    for (let z = -35; z <= 5; z += 10) {
      this.coverPoints.push({ pos: new THREE.Vector3(x + 1.4, y, z), normal: new THREE.Vector3(1, 0, 0) });
    }
    this._lamp(x + 1, 7.2, -20, 0xffe3b0, 16, 12);
  }

  _buildDock() {
    // Raised loading platform inside the north-west end: x[-24,-8] z[-45,-38] top y=1.2
    const dm = this.mat.concrete(4);
    this.box(-16, 0, -41.5, 16, 1.2, 7, dm, Mat.CONCRETE);
    // interior step-ramp up the east face (x -8..-6.4)
    for (let i = 0; i < 6; i++) {
      this.box(-7.2, 0.2 * i, -44.4 + i * 0.6, 1.6, 0.2, 0.6, dm, Mat.CONCRETE, { cast: false });
    }
    // exterior ramp down to the north yard through the dock doorway
    for (let i = 0; i < 6; i++) {
      this.box(-16, 1.0 - 0.2 * i, -45.6 - i * 0.6, 8, 0.2, 0.6, dm, Mat.CONCRETE, { cast: false });
    }
    // dock leveller plate at the doorway (visual)
    this.box(-16, 1.2, -44.7, 6, 0.08, 1.2, this.mat.metalDark, Mat.METAL, { noCollider: true });
    // cargo on the platform
    this.box(-19, 1.2, -41.5, 1.4, 1.0, 1.2, this.mat.wood(1), Mat.WOOD);
    this.box(-11, 1.2, -42, 1.2, 1.4, 1.2, this.mat.wood(1), Mat.WOOD);
    this.box(-11, 2.6, -42, 1.1, 0.9, 1.1, this.mat.wood(1), Mat.WOOD);
    this.coverPoints.push(
      { pos: new THREE.Vector3(-19, 1.2, -40.2), normal: new THREE.Vector3(0, 0, 1) },
      { pos: new THREE.Vector3(-11, 1.2, -40.6), normal: new THREE.Vector3(0, 0, 1) },
      { pos: new THREE.Vector3(-16, 0, -37.2), normal: new THREE.Vector3(0, 0, 1) },
      { pos: new THREE.Vector3(-24.8, 0, -41), normal: new THREE.Vector3(1, 0, 0) },
    );
    this._lamp(-16, 5.5, -43.4, 0xffd9a0, 18, 14);
    this.triggers.push({ id: 'dock', min: new THREE.Vector3(-26, 0, -52), max: new THREE.Vector3(-6, 6, -36) });
    this.patrolRoutes.push([
      new THREE.Vector3(-18, 1.2, -41), new THREE.Vector3(-10, 1.2, -41),
      new THREE.Vector3(-12, 0, -52), new THREE.Vector3(-22, 0, -50),
    ]);
    this.enemySpawns.push({ pos: new THREE.Vector3(-16, 1.2, -41), route: this.patrolRoutes.length - 1, kind: 'guard' });
  }
  _buildYardProps(rnd) {
    // ---- shipping containers ----
    const contGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
    const contColors = [0x6d4a3a, 0x3f5d4a, 0x4a5568, 0x7a6a3a];
    let colorIdx = 0;
    // [x, z, rotY, yOffset]
    const stacks = [
      [-48, -10, 0, 0], [-48, -6.6, 0, 0], [-48, -10, 0, 2.6],
      [-42, 10, 0.4, 0], [-42, 13.6, 0.4, 0],
      [42, -20, -0.3, 0], [42, -16.4, -0.3, 0], [42, -20, -0.3, 2.6],
      [46, 8, 1.2, 0], [40, 22, 0.1, 0], [36, -44, 0.2, 0], [-52, -40, -0.2, 0], [-46, -46, 0.5, 0],
    ];
    for (const [cx, cz, rot, yOff] of stacks) {
      const mesh = new THREE.Mesh(contGeo, this.mat.corrugated(contColors[colorIdx++ % contColors.length], 3));
      mesh.position.set(cx, 1.3 + yOff, cz);
      mesh.rotation.y = rot;
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
      const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
      this.physics.addBox(mesh.position, new THREE.Vector3(6.1 * c + 2.44 * s, 2.6, 6.1 * s + 2.44 * c), Mat.METAL, { tag: 'prop' });
      if (yOff === 0) {
        // cover points on both long sides
        const nx = -Math.sin(rot), nz = Math.cos(rot);
        this.coverPoints.push({ pos: new THREE.Vector3(cx + nx * 1.9, 0, cz + nz * 1.9), normal: new THREE.Vector3(nx, 0, nz) });
        this.coverPoints.push({ pos: new THREE.Vector3(cx - nx * 1.9, 0, cz - nz * 1.9), normal: new THREE.Vector3(-nx, 0, -nz) });
      }
    }

    // ---- concrete barriers ----
    const barrierGeo = new THREE.BoxGeometry(2.4, 1.05, 0.7);
    const barriers = [
      [-8, 58, 0.2], [8, 58, -0.2], [-14, 48, 0.5], [14, 48, -0.5],
      [30, 40, 1.4], [-30, 40, -1.4], [22, -58, 0.1], [-22, -58, 0.2],
      [55, 30, 1.5], [-55, 25, -1.5], [0, 30, 0], [50, -50, 0.7], [-50, -52, -0.7],
    ];
    for (const [bx, bz, rot] of barriers) {
      const m = new THREE.Mesh(barrierGeo, this.mat.concrete(2));
      m.position.set(bx, 0.525, bz);
      m.rotation.y = rot;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
      this.physics.addBox(new THREE.Vector3(bx, 0.525, bz), new THREE.Vector3(2.4 * c + 0.7 * s, 1.05, 2.4 * s + 0.7 * c), Mat.CONCRETE, { tag: 'prop' });
      this.coverPoints.push({ pos: new THREE.Vector3(bx + Math.sin(rot + Math.PI / 2) * 0.9, 0, bz + Math.cos(rot + Math.PI / 2) * 0.9), normal: new THREE.Vector3(Math.sin(rot + Math.PI / 2), 0, Math.cos(rot + Math.PI / 2)) });
      this.coverPoints.push({ pos: new THREE.Vector3(bx - Math.sin(rot + Math.PI / 2) * 0.9, 0, bz - Math.cos(rot + Math.PI / 2) * 0.9), normal: new THREE.Vector3(-Math.sin(rot + Math.PI / 2), 0, -Math.cos(rot + Math.PI / 2)) });
    }

    // ---- light poles around the yard ----
    this._poleLight(-20, 55);
    this._poleLight(20, 55);
    this._poleLight(-55, 15, true);
    this._poleLight(55, 15);
    this._poleLight(-55, -45);
    this._poleLight(55, -45, true);
    this._poleLight(0, -62);

    // ---- guard shack near the breach ----
    this.box(9, 0, 63, 4, 2.8, 3.4, this.mat.corrugated(0x50584e, 2), Mat.METAL);
    this.box(9, 2.8, 63, 4.4, 0.2, 3.8, this.mat.metalDark, Mat.METAL, { noCollider: true });
    // shack window (dark)
    const sw = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.2, metalness: 0.4 }));
    sw.position.set(9, 1.7, 61.29);
    this.group.add(sw);
    this._lamp(9, 3.2, 61.6, 0xffb060, 8, 9);

    // ---- cable spools, tanks, misc ----
    for (let i = 0; i < 5; i++) {
      const sx = -60 + rnd() * 120, sz = 20 + rnd() * 40;
      if (Math.abs(sx) < 34 && sz < 18) continue;
      const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.6, 12), this.mat.wood(1));
      spool.rotation.z = Math.PI / 2;
      spool.position.set(sx, 0.8, sz);
      spool.castShadow = true;
      this.group.add(spool);
      this.physics.addBox(new THREE.Vector3(sx, 0.8, sz), new THREE.Vector3(0.7, 1.6, 1.6), Mat.WOOD, { tag: 'prop' });
    }
    // fuel tank
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 5.5, 14), this.mat.rust);
    tank.rotation.z = Math.PI / 2;
    tank.position.set(-58, 1.7, -25);
    tank.castShadow = true;
    this.group.add(tank);
    this.physics.addBox(new THREE.Vector3(-58, 1.7, -25), new THREE.Vector3(5.5, 3.2, 3.2), Mat.METAL, { tag: 'prop' });
    this.coverPoints.push({ pos: new THREE.Vector3(-58, 0, -22.5), normal: new THREE.Vector3(0, 0, 1) });

    // ---- yard patrols ----
    this.patrolRoutes.push([
      new THREE.Vector3(-10, 0, 56), new THREE.Vector3(10, 0, 56),
      new THREE.Vector3(14, 0, 36), new THREE.Vector3(-14, 0, 38),
    ]);
    this.patrolRoutes.push([
      new THREE.Vector3(-50, 0, 30), new THREE.Vector3(-58, 0, -20),
      new THREE.Vector3(-40, 0, -55), new THREE.Vector3(-10, 0, -58),
      new THREE.Vector3(30, 0, -56), new THREE.Vector3(55, 0, -30),
      new THREE.Vector3(52, 0, 20), new THREE.Vector3(30, 0, 55),
    ]);
    this.patrolRoutes.push([
      new THREE.Vector3(-6, 0, 14), new THREE.Vector3(-6, 0, -2),
      new THREE.Vector3(6, 0, -6), new THREE.Vector3(6, 0, 10),
    ]);
    this.enemySpawns.push({ pos: new THREE.Vector3(6, 0, 50), route: this.patrolRoutes.length - 3, kind: 'guard' });
    this.enemySpawns.push({ pos: new THREE.Vector3(-50, 0, 30), route: this.patrolRoutes.length - 2, kind: 'patrol' });
    this.enemySpawns.push({ pos: new THREE.Vector3(-6, 0, 12), route: this.patrolRoutes.length - 1, kind: 'guard' });

    // surge spawn points (used when the alarm trips — always far from the player)
    this.surgeSpawns.push(
      { pos: new THREE.Vector3(0, 0, -66), route: null },   // north gate
      { pos: new THREE.Vector3(-25, 0, -60), route: null },
      { pos: new THREE.Vector3(25, 0, -60), route: null },
      { pos: new THREE.Vector3(60, 0, 40), route: null },
      { pos: new THREE.Vector3(-62, 0, 45), route: null },
      { pos: new THREE.Vector3(12, 0, -31), route: null },  // office corridor
    );
  }

  _buildVehicles() {
    const buildTruck = (x, z, rotY, withTrailer = true) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      const bodyMat = this.mat.metal(2, 0x4c5a52);
      // cab
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 2.6), bodyMat);
      cab.position.set(0, 1.5, 1.8);
      cab.castShadow = true; cab.receiveShadow = true;
      g.add(cab);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.4), bodyMat);
      hood.position.set(0, 0.9, 3.7);
      hood.castShadow = true;
      g.add(hood);
      // windshield (dark glass look)
      const ws = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.9), new THREE.MeshStandardMaterial({ color: 0x10161c, roughness: 0.1, metalness: 0.5 }));
      ws.position.set(0, 2.0, 3.06);
      ws.rotation.x = -0.12;
      g.add(ws);
      // cargo box
      if (withTrailer) {
        const box1 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 5.4), this.mat.corrugated(0x59616a, 3));
        box1.position.set(0, 1.7, -2.4);
        box1.castShadow = true; box1.receiveShadow = true;
        g.add(box1);
      }
      // chassis
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, withTrailer ? 8.4 : 4.4), this.mat.metalDark);
      chassis.position.set(0, 0.55, withTrailer ? -0.6 : 1.4);
      g.add(chassis);
      // wheels
      const wheelGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.36, 12);
      const wz = withTrailer ? [[2.6], [0.2], [-2.4], [-3.6]] : [[2.6], [0.4]];
      for (const [wzz] of wz) {
        for (const side of [-1.15, 1.15]) {
          const w = new THREE.Mesh(wheelGeo, this.mat.rubber);
          w.rotation.z = Math.PI / 2;
          w.position.set(side, 0.52, wzz);
          w.castShadow = true;
          g.add(w);
        }
      }
      // headlights (off — dead vehicles) & tail lights
      this.group.add(g);
      // colliders (local AABBs transformed by rotY → approximate with two boxes)
      const addRot = (lx, lz, w, d, h) => {
        const c = Math.cos(rotY), s = Math.sin(rotY);
        const wx = x + lx * c + lz * s;
        const wz2 = z - lx * s + lz * c;
        const cw = Math.abs(c), sw = Math.abs(s);
        this.physics.addBox(new THREE.Vector3(wx, h / 2, wz2), new THREE.Vector3(w * cw + d * sw, h, w * sw + d * cw), Mat.METAL, { tag: 'vehicle' });
        this.coverPoints.push({ pos: new THREE.Vector3(wx + Math.sin(rotY) * (d / 2 + 0.8), 0, wz2 + Math.cos(rotY) * (d / 2 + 0.8)), normal: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)) });
      };
      addRot(0, 2.4, 2.4, 4.6, 2.6);
      if (withTrailer) addRot(0, -2.4, 2.5, 5.4, 3);
    };
    buildTruck(-16, -51, Math.PI, true);         // backed up to the dock doorway (north yard)
    buildTruck(-40, 60, -Math.PI / 2.4, true);   // extraction vehicle, south-west yard
    buildTruck(48, 38, 2.2, false);              // yard truck, cab only
    // forklift near dock
    const fk = new THREE.Group();
    fk.position.set(-26, 0, -52);
    fk.rotation.y = 0.6;
    const fkb = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 2.0), this.mat.metal(1, 0x8a6a2e));
    fkb.position.y = 0.9; fkb.castShadow = true;
    fk.add(fkb);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.6, 0.15), this.mat.metalDark);
    mast.position.set(0, 1.3, -1.05);
    fk.add(mast);
    const fork1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 1.1), this.mat.metalDark);
    fork1.position.set(-0.3, 0.15, -1.6); fk.add(fork1);
    const fork2 = fork1.clone(); fork2.position.x = 0.3; fk.add(fork2);
    for (const [wx, wz] of [[-0.6, 0.6], [0.6, 0.6], [-0.5, -0.7], [0.5, -0.7]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10), this.mat.rubber);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.3, wz);
      fk.add(w);
    }
    this.group.add(fk);
    this.physics.addBox(new THREE.Vector3(-26, 0.9, -52), new THREE.Vector3(2, 1.8, 2.6), Mat.METAL, { tag: 'vehicle' });
    this.coverPoints.push({ pos: new THREE.Vector3(-26, 0, -50.2), normal: new THREE.Vector3(0, 0, 1) });
  }

  _buildExtraction() {
    const p = new THREE.Vector3(-40, 0, 54);
    // LZ marking: low concrete pad + 4 green lights
    const pad = new THREE.Mesh(new THREE.CircleGeometry(5, 24), new THREE.MeshStandardMaterial({ color: 0x3a3d38, roughness: 0.95 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(p.x, 0.03, p.z);
    pad.receiveShadow = true;
    this.group.add(pad);
    // painted H
    const hMat = new THREE.MeshBasicMaterial({ color: 0x9aa08f, transparent: true, opacity: 0.5 });
    const h1 = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3), hMat); h1.rotation.x = -Math.PI / 2; h1.position.set(p.x - 1, 0.04, p.z);
    const h2 = h1.clone(); h2.position.x = p.x + 1;
    const h3 = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.5), hMat); h3.rotation.x = -Math.PI / 2; h3.position.set(p.x, 0.045, p.z);
    this.group.add(h1, h2, h3);
    for (const [dx, dz] of [[-4.4, -4.4], [4.4, -4.4], [-4.4, 4.4], [4.4, 4.4]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.9, 6), this.mat.metalDark);
      post.position.set(p.x + dx, 0.45, p.z + dz);
      this.group.add(post);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), this.mat.emissiveGreen);
      bulb.position.set(p.x + dx, 0.95, p.z + dz);
      this.group.add(bulb);
      const l = new THREE.PointLight(0x47d95f, 12, 8, 2);
      l.position.set(p.x + dx, 1, p.z + dz);
      this.group.add(l);
      this.allLights.push(l);
      this._blinkLights = this._blinkLights || [];
      this._blinkLights.push(l);
    }
    this.extractionMarker = p.clone();
    this.triggers.push({ id: 'extraction', center: p.clone().setY(1), radius: 5 });
  }

  _buildTerminal() {
    // server room upstairs: desk + glowing terminal at (12.5, 4, -42.5)
    const tx = 12.5, ty = 4, tz = -42.8;
    this.terminalPos.set(tx, ty, tz);
    this.box(tx, ty, tz + 0.4, 1.8, 0.75, 0.8, this.mat.metalDark, Mat.METAL); // desk
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.05), this.mat.emissiveScreen);
    screen.position.set(tx, ty + 1.15, tz + 0.3);
    screen.rotation.x = -0.12;
    this.group.add(screen);
    this.terminalScreen = screen;
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.03, 0.2), this.mat.metalDark);
    kb.position.set(tx, ty + 0.78, tz + 0.65);
    this.group.add(kb);
    const glow = new THREE.PointLight(0x35d97a, 9, 5, 2);
    glow.position.set(tx, ty + 1.2, tz + 0.5);
    this.group.add(glow);
    this.allLights.push(glow);
    glow.userData.base = glow.intensity;
    this.terminalGlow = glow;

    this.interactables.push({
      id: 'terminal',
      pos: new THREE.Vector3(tx, ty + 1.0, tz + 0.5),
      radius: 2.2,
      prompt: 'ACCESS DATA TERMINAL',
      getPrompt: () => this.terminalUsed ? 'TERMINAL — DOWNLOAD COMPLETE' : 'ACCESS DATA TERMINAL',
      hold: 8, // seconds
      used: false,
      action: (game) => game.missions.onTerminalComplete(game),
      missionStage: 'locate',
    });
  }

  _buildPickups() {
    // ammo crates (interact to resupply)
    const ammoSpots = [
      new THREE.Vector3(-21, 0, 10),
      new THREE.Vector3(6, 0, -30),
      new THREE.Vector3(16, 4, -36),
      new THREE.Vector3(10, 1.2, -42.8),
      new THREE.Vector3(-40, 0, 48),
    ];
    ammoSpots.forEach((p, i) => {
      const crate = this.box(p.x, p.y, p.z, 0.7, 0.45, 0.5, this.mat.metal(1, 0x4a5a45), Mat.METAL);
      void crate;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.52), new THREE.MeshStandardMaterial({ color: 0x8a7a3a, roughness: 0.8 }));
      stripe.position.set(p.x, p.y + 0.3, p.z);
      this.group.add(stripe);
      this.interactables.push({
        id: 'ammo_' + i,
        pos: p.clone().setY(p.y + 0.5),
        radius: 1.8,
        prompt: 'RESUPPLY AMMUNITION',
        getPrompt: () => 'RESUPPLY AMMUNITION',
        hold: 0.8,
        used: false,
        reusable: false,
        action: (game) => {
          game.player.resupplyAll();
          game.audio.pickup(p);
          game.ui.toastBrief('AMMUNITION RESUPPLIED');
          return true;
        },
        reset() { this.used = false; },
      });
    });
  }

  // =========================================================================
  // TRAINING RANGE
  // =========================================================================
  // =========================================================================
  // BATTLEFIELD 2 — WHITEOUT RELAY STATION (snow, assault flow)
  // =========================================================================
  buildSnow(scene, physics) {
    this.map = 'snow';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);
    this.nightSky = { bg: 0x0a1018, fog: 0x0c1218 };
    this.daySky = { bg: 0xe9eef3, fog: 0xe2e9ef };
    this.dayFogMul = 1.9; // whiteout
    this.weather = 'snow'; this.windLevel = 0.7;

    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.mat.snow(48));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false; ground.updateMatrix();
    this.group.add(ground);
    physics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(240, 1, 240), Mat.SNOW || Mat.CONCRETE, {});

    const WM = this.mat.metal(3, 0x5a6068);
    const SN = this.mat.snow(3);

    // perimeter fence with south gate gap
    const F = 36, FH = 2.6;
    this.box(-F, 0, 0, 0.16, FH, F * 2 - 4, this.mat.metalDark, Mat.METAL);
    this.box(F, 0, 0, 0.16, FH, F * 2 - 4, this.mat.metalDark, Mat.METAL);
    this.box(0, 0, -F, F * 2, FH, 0.16, this.mat.metalDark, Mat.METAL);
    this.box(-(F + 3) / 2 - 1.5, 0, F, F - 3, FH, 0.16, this.mat.metalDark, Mat.METAL);
    this.box((F + 3) / 2 + 1.5, 0, F, F - 3, FH, 0.16, this.mat.metalDark, Mat.METAL);
    for (let i = -F; i <= F; i += 6) {
      this.cyl(-F, 0, i, 0.06, 0.06, FH + 0.3, 5, this.mat.metalDark, Mat.METAL, { noCollider: true });
      this.cyl(F, 0, i, 0.06, 0.06, FH + 0.3, 5, this.mat.metalDark, Mat.METAL, { noCollider: true });
    }
    // gate posts + open gate leaves
    this.box(-3.4, 0, F, 0.3, FH + 0.4, 0.3, this.mat.metal(1, 0x8a4a3a), Mat.METAL);
    this.box(3.4, 0, F, 0.3, FH + 0.4, 0.3, this.mat.metal(1, 0x8a4a3a), Mat.METAL);
    this.box(-4.6, 0, F - 1.6, 2.4, FH - 0.2, 0.1, this.mat.metalDark, Mat.METAL, { rotY: 1.3 });
    this.box(4.6, 0, F - 1.6, 2.4, FH - 0.2, 0.1, this.mat.metalDark, Mat.METAL, { rotY: -1.3 });

    // relay building (single storey, snow-capped)
    const bx = -4, bz = -14, BW = 26, BD = 12, BH = 5.5;
    this.box(bx - BW / 2, 0, bz, 0.5, BH, BD, WM, Mat.CONCRETE);
    this.box(bx + BW / 2, 0, bz, 0.5, BH, BD, WM, Mat.CONCRETE);
    this.box(bx, 0, bz - BD / 2, BW, BH, 0.5, WM, Mat.CONCRETE);
    this.box(bx - 6.5, 0, bz + BD / 2, 7, BH, 0.5, WM, Mat.CONCRETE);
    this.box(bx + 6.5, 0, bz + BD / 2, 7, BH, 0.5, WM, Mat.CONCRETE);
    this.box(bx, 2.4, bz + BD / 2, 4, BH - 2.4, 0.5, WM, Mat.CONCRETE); // lintel over door gap
    this.box(bx, BH, bz, BW + 1.2, 0.5, BD + 1.2, WM, Mat.CONCRETE);    // roof
    this.box(bx, BH + 0.5, bz, BW + 0.6, 0.22, BD + 0.6, SN, Mat.CONCRETE, { noCollider: true }); // snow cap
    new Door(this, {
      position: new THREE.Vector3(bx - 2, 0, bz + BD / 2), rotY: 0,
      width: 4, height: 2.4, slideUp: true, material: this.mat.doorMetal,
    });
    this._window(bx + 6, 1.2, bz + BD / 2, 3, 1.4, 'z');
    this._window(bx - 9, 1.2, bz + BD / 2, 3, 1.4, 'z');
    // interior: radio racks + desks
    for (let i = 0; i < 5; i++) {
      this.box(bx - 10 + i * 2.2, 0, bz - 4, 1.6, 2.1, 0.7, this.mat.metalDark, Mat.METAL);
      const led = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.02), i % 2 ? this.mat.emissiveGreen : this.mat.emissiveScreen);
      led.position.set(bx - 10 + i * 2.2, 1.7, bz - 3.62);
      this.group.add(led);
    }
    this.box(bx + 6, 0, bz - 2, 3, 0.75, 1.2, this.mat.wood(1), Mat.WOOD);
    this._lamp(bx - 6, 3.6, bz - 1, 0xbfe8ff, 12, 10);
    this._lamp(bx + 6, 3.6, bz - 1, 0xffe8c8, 10, 9);
    this._lamp(bx, 4.4, bz + BD / 2 + 0.8, 0xffe3b0, 10, 9); // over the door

    // fuel tanks + pipe run
    for (const tz of [-6, 0]) {
      this.cyl(16, 0, tz, 2.2, 2.2, 5, 14, this.mat.metal(2, 0x77684d), Mat.METAL);
      this.cyl(16, 5, tz, 2.2, 2.2, 0.25, 14, SN, Mat.CONCRETE, { noCollider: true });
      this._coverBox(16, tz, 4.4, 4.4);
    }
    this.cyl(16, 3, -3, 0.16, 0.16, 6.4, 6, this.mat.metalDark, Mat.METAL, { noCollider: true });

    // generator shack
    this.box(-22, 0, -4, 4, 3, 3, this.mat.wood(1, 0x5d4a38), Mat.WOOD);
    this.box(-22, 3, -4, 4.4, 0.3, 3.4, SN, Mat.CONCRETE, { noCollider: true });
    this._lamp(-22, 2.6, -2.2, 0xffb060, 6, 6);
    this._coverBox(-22, -4, 4, 3);
    this.machinePositions.push(new THREE.Vector3(-22, 1, -4));

    // radio mast with beacon
    this.cyl(10, 0, -26, 0.16, 0.3, 24, 8, this.mat.metalDark, Mat.METAL);
    const dish = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 0.2), this.mat.metal(1, 0x9aa2ab));
    dish.position.set(10, 16, -25.6);
    dish.rotation.x = 0.5;
    this.group.add(dish);
    const beacon = new THREE.PointLight(0xd93a2a, 10, 10, 2);
    beacon.userData.base = beacon.intensity;
    beacon.position.set(10, 24.2, -26);
    this.group.add(beacon);
    this.allLights.push(beacon);
    this._blinkLights = this._blinkLights || [];
    this._blinkLights.push(beacon);

    // helipad LZ (west)
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.08, 20), this.mat.metal(2, 0x3a4046));
    pad.position.set(-26, 0.04, 12);
    pad.receiveShadow = true;
    this.group.add(pad);
    this._lz(-26, 12);
    // vehicles (C2)
    this._vehicle('pickup', -14, 18, 0);
    // pickups & crates (C3)
    this._supplyCrate(90, -24, 0, 16);
    this._supplyCrate(91, 6, 0, -10);
    this._weaponPickup('cr9', -18, 0, 10);
    this._vehicle('suv', 12, -14, 45, { tag: 'snow_wreck', mission: true, hpFrac: 0.08, color: 0x5a6e52 });

    // props: crates, wood piles, plow truck, rocks, pines
    const crateSpots = [[-12, 8], [-10.4, 8.6], [-12, 9.8], [6, 12], [7.4, 12.4], [22, 16], [-24, -18], [20, -18]];
    for (const [cx, cz] of crateSpots) {
      this.box(cx, 0, cz, 1.2, 1.1, 1.2, this.mat.wood(1, 0x6a563c), Mat.WOOD);
      this.box(cx, 1.1, cz, 1.24, 0.14, 1.24, SN, Mat.CONCRETE, { noCollider: true });
      this._coverBox(cx, cz, 1.2, 1.2);
    }
    this._wreck(2, 22, 0.5, 0x5a4a3a);
    const plow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.1, 2.6), this.mat.metal(1, 0x8a5a2a));
    plow.position.set(2 + Math.cos(0.5) * 2.8, 0.55, 22 + Math.sin(0.5) * 2.8);
    plow.rotation.y = 0.5;
    this.group.add(plow);
    this._coverBox(2, 22, 4.4, 1.9);
    for (const [rx, rz, s] of [[-30, 20, 1.6], [28, 6, 2.2], [-16, 26, 1.2], [12, 30, 1.8], [-30, -26, 2.0]]) {
      this.box(rx, 0, rz, s, s * 0.7, s * 0.9, this.mat.concrete(2), Mat.CONCRETE, { rotY: rx * 0.7 });
      this.box(rx, s * 0.7, rz, s * 0.9, 0.16, s * 0.8, SN, Mat.CONCRETE, { noCollider: true });
      this._coverBox(rx, rz, s, s);
    }
    const pines = [[-32, 32], [-28, 34], [-34, 26], [30, 30], [34, 24], [26, 34], [-34, -8], [-33, 4], [33, -12], [34, -4], [-8, -32], [0, -33], [20, -32], [-24, 30]];
    for (const [px, pz] of pines) this._pine(px, pz, 6 + ((px * 7 + pz) % 3));

    this._ammoCrate(0, -14, 0, 6);
    this._ammoCrate(1, 20, 0, 10);

    // lights: gate poles + yard
    this._poleLight(-7, 33, true);
    this._poleLight(7, 33);
    this._poleLight(-20, 4);
    this._poleLight(18, -14, true);

    // cover: building corners + door
    this._cover(bx - BW / 2 - 1, bz + BD / 2, -1, 0.4);
    this._cover(bx + BW / 2 + 1, bz + BD / 2, 1, 0.4);
    this._cover(bx, bz + BD / 2 + 1.4, 0, 1);

    // routes + spawns (assault: 8 guards)
    const r1 = this._route([[-32, 0, 32], [32, 0, 32], [32, 0, -32], [-32, 0, -32]]);
    const r2 = this._route([[-16, 0, -5], [8, 0, -5], [8, 0, 4], [-16, 0, 4]]);
    const r3 = this._route([[13, 0, -8], [13, 0, 4], [19, 0, 4], [19, 0, -8]]);
    const r4 = this._route([[6, 0, -22], [14, 0, -30], [6, 0, -30]]);
    this._spawn(-30, 0, 30, r1);
    this._spawn(30, 0, -30, r1);
    this._spawn(-14, 0, -5, r2);
    this._spawn(6, 0, 4, r2);
    this._spawn(16, 0, -6, r3);
    this._spawn(8, 0, -26, r4);
    this._spawn(bx - 2, 0, bz + 3);
    this._spawn(bx + 8, 0, bz - 2);
    for (const s of [[-34, 34], [34, 34], [34, -34], [-34, -34]]) this._surge(s[0], 0, s[1]);

    // triggers + zones
    this._trig('breach', -3, 0, 32, 3, 3, 40);
    this._trig('enter_facility', -35, 0, -35, 35, 9, 35);
    this.zones.push({ name: 'room', min: new THREE.Vector3(bx - BW / 2, 0, bz - BD / 2), max: new THREE.Vector3(bx + BW / 2, 6, bz + BD / 2) });

    this._intel(-8, 0, -14, 'RELAY LOG PRINTOUT');
    this._intel(2, 0, -16, 'FUEL DEPOT NOTE');
    this._intel(-20, 0, 8, 'MAST ACCESS CODES');

    this.spawnPoint.set(0, 0, 48);
    this.spawnYaw = 0;
  }

  // =========================================================================
  // BATTLEFIELD 3 — DUSTBOWL CACHE (desert outpost, infiltrate flow)
  // =========================================================================
  buildDesert(scene, physics) {
    this.map = 'desert';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);
    this.nightSky = { bg: 0x0b0e14, fog: 0x0d1016 };
    this.daySky = { bg: 0xe7ddc6, fog: 0xd9c9a8 };
    this.dayFogMul = 1.1;
    this.weather = 'dust'; this.windLevel = 0.4;

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.mat.sand(48));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false; ground.updateMatrix();
    this.group.add(ground);
    physics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(240, 1, 240), Mat.CONCRETE, {});

    const AD = this.mat.brick(5);      // adobe-style brick
    const WD = this.mat.wood(1, 0x7a6448);

    // compound wall ±30 with south gate gap
    const C = 30, CH = 2.8;
    this.box(-C, 0, 0, 0.6, CH, C * 2 - 3, AD, Mat.CONCRETE);
    this.box(C, 0, 0, 0.6, CH, C * 2 - 3, AD, Mat.CONCRETE);
    this.box(0, 0, -C, C * 2, CH, 0.6, AD, Mat.CONCRETE);
    this.box(-(C + 2.5) / 2 - 1.25, 0, C, C - 2.5, CH, 0.6, AD, Mat.CONCRETE);
    this.box((C + 2.5) / 2 + 1.25, 0, C, C - 2.5, CH, 0.6, AD, Mat.CONCRETE);
    this.box(-1.6, 0, C, 0.5, CH + 0.5, 0.7, AD, Mat.CONCRETE);
    this.box(1.6, 0, C, 0.5, CH + 0.5, 0.7, AD, Mat.CONCRETE);

    // main building (cache house)
    const bx = -6, bz = -10, BW = 16, BD = 10, BH = 4;
    this.box(bx - BW / 2, 0, bz, 0.5, BH, BD, AD, Mat.CONCRETE);
    this.box(bx + BW / 2, 0, bz, 0.5, BH, BD, AD, Mat.CONCRETE);
    this.box(bx, 0, bz - BD / 2, BW, BH, 0.5, AD, Mat.CONCRETE);
    this.box(bx - 5, 0, bz + BD / 2, 5, BH, 0.5, AD, Mat.CONCRETE);
    this.box(bx + 5, 0, bz + BD / 2, 5, BH, 0.5, AD, Mat.CONCRETE);
    this.box(bx, 2.3, bz + BD / 2, 4, BH - 2.3, 0.5, AD, Mat.CONCRETE);
    this.box(bx, BH, bz, BW + 0.8, 0.4, BD + 0.8, AD, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(bx - 2, 0, bz + BD / 2), rotY: 0,
      width: 1.4, height: 2.2, material: this.mat.doorMetal,
    });
    this._window(bx + 4, 1.1, bz + BD / 2, 2.4, 1.2, 'z');
    this._window(bx - BW / 2, 1.1, bz, 2.4, 1.2, 'x');
    this._objective(bx - 4, 0, bz - 3.6, 6, 'DOWNLOAD THE CACHE MANIFEST');
    this._lamp(bx - 4, 3.2, bz - 1, 0xffd9a8, 10, 9);
    this._lamp(bx + 4, 3.2, bz, 0xffe0b4, 9, 8);
    this.box(bx + 5, 0, bz - 2, 2.4, 0.7, 1, WD, Mat.WOOD);   // crate table
    this._coverBox(bx + 5, bz - 2, 2.4, 1);

    // guard house
    this.box(12, 0, -2, 6, 3, 5, AD, Mat.CONCRETE);
    this.box(12, 3, -2, 6.6, 0.35, 5.6, AD, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(12, 0, 0.5), rotY: 0,
      width: 1.2, height: 2.1, material: this.mat.doorMetal,
    });
    this._lamp(12, 2.5, -1, 0xffe0b4, 7, 7);
    this._coverBox(12, -2, 6, 5);

    // watch tower NE
    for (const [lx, lz] of [[22.6, -22.6], [25.4, -22.6], [22.6, -25.4], [25.4, -25.4]]) {
      this.cyl(lx, 0, lz, 0.12, 0.16, 5.4, 6, WD, Mat.WOOD);
    }
    this.box(24, 5.4, -24, 4, 0.3, 4, WD, Mat.WOOD);
    this.box(24, 5.7, -24, 3.4, 1.2, 3.4, AD, Mat.CONCRETE, { noCollider: true });
    this.box(24, 6.9, -24, 4.2, 0.3, 4.2, WD, Mat.WOOD, { noCollider: true });
    const towerLamp = this._lamp(24, 6.4, -24, 0xfff0d0, 8, 12);
    void towerLamp;

    // sandbag walls (cover)
    const bags = [[-2, 6, 6, 0], [6, 10, 5, 0.4], [-12, 2, 5, -0.3], [2, -18, 6, 0], [18, 8, 4, 1.2], [-18, 12, 4, 0.8]];
    for (const [sx, sz, sw, rot] of bags) {
      this.box(sx, 0, sz, sw, 1.1, 0.7, this.mat.fabric, Mat.WOOD, { rotY: rot });
      this._coverBox(sx, sz, sw, 0.9);
    }
    // drums, wrecks, palms, rocks
    for (const [dx, dz] of [[8, 2], [8.8, 2.6], [8.4, 1.2], [-16, -18], [-15.2, -17.4]]) {
      this.cyl(dx, 0, dz, 0.35, 0.35, 0.95, 10, this.mat.rust, Mat.METAL);
    }
    this._wreck(-14, 16, -0.4, 0x6a5f4a);
    this._wreck(20, 14, 1.1, 0x4a4038);
    this._coverBox(-14, 16, 4.4, 1.9);
    this._coverBox(20, 14, 4.4, 1.9);
    for (const [px, pz] of [[-24, 22], [-20, 24], [26, 18], [-26, -12], [8, -24], [-8, 24]]) this._palm(px, pz, 5 + (px % 2));
    for (const [rx, rz, s] of [[-26, 4, 1.8], [26, -8, 2.4], [0, 24, 1.4], [-4, -24, 2.0]]) {
      this.box(rx, 0, rz, s, s * 0.6, s * 0.8, this.mat.concrete(2), Mat.CONCRETE, { rotY: rz * 0.3 });
      this._coverBox(rx, rz, s, s);
    }
    this._ammoCrate(0, bx + 6.5, 0, bz - 3);
    this._ammoCrate(1, 14.5, 0, -0.5);

    // lights
    this._poleLight(-4, 27, true);
    this._poleLight(10, 27);
    this._lamp(bx, 3.4, bz + BD / 2 + 1, 0xffb060, 8, 9);

    // routes + spawns (7 guards)
    const r1 = this._route([[-26, 0, 26], [26, 0, 26], [26, 0, -26], [-26, 0, -26]]);
    const r2 = this._route([[-12, 0, 6], [8, 0, 6], [8, 0, -4], [-12, 0, -4]]);
    const r3 = this._route([[bx - 5, 0, bz - 2], [bx + 5, 0, bz - 2], [bx + 5, 0, bz + 3], [bx - 5, 0, bz + 3]]);
    this._spawn(-24, 0, 24, r1);
    this._spawn(24, 0, -24, r1);
    this._spawn(-10, 0, 6, r2);
    this._spawn(6, 0, -4, r2);
    this._spawn(bx + 4, 0, bz + 2, r3);
    this._spawn(12, 0, 2);
    this._spawn(24, 5.7, -24);
    for (const s of [[-28, 28], [28, 28], [28, -28], [-28, -28]]) this._surge(s[0], 0, s[1]);

    // triggers + zones
    this._trig('breach', -2.5, 0, 27, 2.5, 3, 33);
    this._trig('enter_facility', -29, 0, -29, 29, 9, 26);
    this._trig('dock', -4, 0, -27, 4, 3, -23);
    this._lz(26, 34);
    // vehicles (C2)
    this._vehicle('buggy', 6, 36, 0);
    this._vehicle('apc', 24, 32, -90, { tag: 'extract_apc', mission: true, color: 0x4a5245 });
    // pickups & crates (C3)
    this._supplyCrate(90, 18, 0, 38);
    this._supplyCrate(91, -16, 0, 40, 'empty');
    this._weaponPickup('lb9', 28, 0, 38);
    this.zones.push({ name: 'room', min: new THREE.Vector3(bx - BW / 2, 0, bz - BD / 2), max: new THREE.Vector3(bx + BW / 2, 4, bz + BD / 2) });
    this.machinePositions.push(new THREE.Vector3(12, 1, -2));

    this._observe(-24, 0, 30, 'obs_a', 'WEST OVERWATCH');
    this._observe(24, 0, 30, 'obs_b', 'EAST OVERWATCH');
    this._observe(0, 0, -26, 'obs_c', 'NORTH RIDGE');

    this._intel(6, 0, 18, 'CACHE HOUSE MAP');
    this._intel(-8, 0, 10, 'WADI PATROL ORDER');
    this._intel(14, 0, 36, 'BURIED DRIVE');

    this.spawnPoint.set(0, 0, 44);
    this.spawnYaw = 0;
  }

  // =========================================================================
  // BATTLEFIELD 4 — GREYLINE DISTRICT (urban block, infiltrate flow)
  // =========================================================================
  buildUrban(scene, physics) {
    this.map = 'urban';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);
    this.nightSky = { bg: 0x090c12, fog: 0x0b0e14 };
    this.daySky = { bg: 0xdfe3e6, fog: 0xcfd4d8 };
    this.dayFogMul = 0.9;
    this.weather = 'rain'; this.windLevel = 0.25;

    // street + sidewalks
    const street = new THREE.Mesh(new THREE.PlaneGeometry(120, 10), this.mat.asphalt(16));
    street.rotation.x = -Math.PI / 2;
    street.position.set(0, 0.01, 7);
    street.receiveShadow = true;
    street.matrixAutoUpdate = false; street.updateMatrix();
    this.group.add(street);
    const walkN = new THREE.Mesh(new THREE.PlaneGeometry(120, 14), this.mat.concrete(20));
    walkN.rotation.x = -Math.PI / 2;
    walkN.position.set(0, 0.06, -5);
    walkN.receiveShadow = true;
    walkN.matrixAutoUpdate = false; walkN.updateMatrix();
    this.group.add(walkN);
    const walkS = new THREE.Mesh(new THREE.PlaneGeometry(120, 16), this.mat.concrete(20));
    walkS.rotation.x = -Math.PI / 2;
    walkS.position.set(0, 0.06, 22);
    walkS.receiveShadow = true;
    walkS.matrixAutoUpdate = false; walkS.updateMatrix();
    this.group.add(walkS);
    const base = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.mat.asphalt(40));
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.02;
    base.matrixAutoUpdate = false; base.updateMatrix();
    this.group.add(base);
    physics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(240, 1, 240), Mat.CONCRETE, {});

    const BR = this.mat.brick(6);
    const CON = this.mat.concrete(5);

    // --- Building A: bank (objective inside, ground floor) ---
    const ax = -14, az = -15, AW = 18, AD2 = 12, AH = 9;
    this.box(ax - AW / 2, 0, az, 0.6, AH, AD2, BR, Mat.CONCRETE);
    this.box(ax + AW / 2, 0, az, 0.6, AH, AD2, BR, Mat.CONCRETE);
    this.box(ax, 0, az - AD2 / 2, AW, AH, 0.6, BR, Mat.CONCRETE);
    this.box(ax, AH, az, AW + 0.6, 0.5, AD2 + 0.6, CON, Mat.CONCRETE);
    // front wall with door gap + window band
    this.box(ax - 6.5, 0, az + AD2 / 2, 5, AH, 0.6, BR, Mat.CONCRETE);
    this.box(ax + 6.5, 0, az + AD2 / 2, 5, AH, 0.6, BR, Mat.CONCRETE);
    this.box(ax - 2.5, 2.5, az + AD2 / 2, 2, AH - 2.5, 0.6, BR, Mat.CONCRETE);
    this.box(ax + 2.5, 2.5, az + AD2 / 2, 2, AH - 2.5, 0.6, BR, Mat.CONCRETE);
    this.box(ax, 2.5, az + AD2 / 2, 3, AH - 2.5, 0.6, BR, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(ax - 1.5, 0, az + AD2 / 2), rotY: 0,
      width: 1.6, height: 2.4, material: this.mat.doorMetal,
    });
    new Door(this, {
      position: new THREE.Vector3(ax + 1.5, 0, az + AD2 / 2), rotY: 0,
      width: 1.6, height: 2.4, material: this.mat.doorMetal,
    });
    this._window(ax - 4.5, 1.1, az + AD2 / 2, 3.4, 1.6, 'z');
    this._window(ax + 4.5, 1.1, az + AD2 / 2, 3.4, 1.6, 'z');
    // upper floor window band (dark glass look)
    for (let i = 0; i < 5; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.1), this.mat.glass);
      w.position.set(ax - 7 + i * 3.5, 5.6, az + AD2 / 2 + 0.32);
      this.group.add(w);
    }
    // ground floor interior: record room partition + objective
    this.box(ax - 4, 0, az - 1, 8, 3.2, 0.4, CON, Mat.CONCRETE);
    this.box(ax - 8, 0, az - 3, 0.4, 3.2, 6, CON, Mat.CONCRETE);
    this._objective(ax - 5, 0, az - 5, 6, 'DOWNLOAD THE RECORD ARCHIVE');
    this._lamp(ax - 5, 3, az - 3, 0xbfe8ff, 10, 9);
    this._lamp(ax + 4, 3, az, 0xffe0b4, 10, 9);
    this.box(ax + 5, 0, az + 2, 3, 1, 1.2, CON, Mat.CONCRETE);   // teller counter
    this._coverBox(ax + 5, az + 2, 3, 1.2);
    // scaffolding on facade
    for (let i = 0; i < 4; i++) {
      this.cyl(ax - 8 + i * 5, 0, az + AD2 / 2 + 1.2, 0.05, 0.05, AH, 5, this.mat.metalDark, Mat.METAL, { noCollider: true });
    }
    this.box(ax, 4.4, az + AD2 / 2 + 1.2, AW - 1, 0.12, 1.4, this.mat.metalDark, Mat.METAL, { noCollider: true });

    // --- Building B: apartments (shell) ---
    const bx2 = 12, bz2 = -16, BW2 = 14, BD2 = 10, BH2 = 10;
    this.box(bx2 - BW2 / 2, 0, bz2, 0.6, BH2, BD2, BR, Mat.CONCRETE);
    this.box(bx2 + BW2 / 2, 0, bz2, 0.6, BH2, BD2, BR, Mat.CONCRETE);
    this.box(bx2, 0, bz2 - BD2 / 2, BW2, BH2, 0.6, BR, Mat.CONCRETE);
    this.box(bx2, BH2, bz2, BW2 + 0.6, 0.5, BD2 + 0.6, CON, Mat.CONCRETE);
    this.box(bx2 - 4.5, 0, bz2 + BD2 / 2, 4, BH2, 0.6, BR, Mat.CONCRETE);
    this.box(bx2 + 4.5, 0, bz2 + BD2 / 2, 4, BH2, 0.6, BR, Mat.CONCRETE);
    this.box(bx2, 2.6, bz2 + BD2 / 2, 5, BH2 - 2.6, 0.6, BR, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(bx2 - 1.4, 0, bz2 + BD2 / 2), rotY: 0,
      width: 1.6, height: 2.4, material: this.mat.wood(1, 0x5d4a38),
    });
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.5, 0.1), this.mat.glass);
      w.position.set(bx2 - 4.5 + i * 3, 5.4, bz2 + BD2 / 2 + 0.32);
      this.group.add(w);
    }
    // rubble inside shell
    for (const [rx, rz, s] of [[bx2 - 3, bz2 - 2, 1.6], [bx2 + 2, bz2 + 1, 2.2], [bx2 + 4, bz2 - 3, 1.2]]) {
      this.box(rx, 0, rz, s, s * 0.5, s * 0.8, CON, Mat.CONCRETE, { rotY: rx * 0.4 });
      this._coverBox(rx, rz, s, s);
    }

    // --- Building C: shop row (south) ---
    const cx = -6, cz = 26, CW = 20, CD = 8, CH2 = 6;
    this.box(cx - CW / 2, 0, cz, 0.5, CH2, CD, BR, Mat.CONCRETE);
    this.box(cx + CW / 2, 0, cz, 0.5, CH2, CD, BR, Mat.CONCRETE);
    this.box(cx, 0, cz + CD / 2, CW, CH2, 0.5, BR, Mat.CONCRETE);
    this.box(cx, CH2, cz, CW + 0.6, 0.4, CD + 0.6, CON, Mat.CONCRETE);
    this.box(cx - 7, 0, cz - CD / 2, 6, CH2, 0.5, BR, Mat.CONCRETE);
    this.box(cx + 7, 0, cz - CD / 2, 6, CH2, 0.5, BR, Mat.CONCRETE);
    this.box(cx, 2.6, cz - CD / 2, 8, CH2 - 2.6, 0.5, BR, Mat.CONCRETE);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(8, 0.12, 2.2), this.mat.fabric);
    awning.position.set(cx, 2.7, cz - CD / 2 - 1.1);
    awning.rotation.x = 0.18;
    this.group.add(awning);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(6, 0.9, 0.12), this.mat.emissiveRed);
    sign.position.set(cx, 3.6, cz - CD / 2 - 0.3);
    this.group.add(sign);
    this._lamp(cx, 2.4, cz - 2, 0xffd9a8, 8, 8);

    // --- Building D: burnt shell (south-east) ---
    const dx = 22, dz = 24, DW = 12, DD = 7, DH = 7;
    this.box(dx - DW / 2, 0, dz, 0.6, DH, DD, BR, Mat.CONCRETE);
    this.box(dx + DW / 2, 0, dz, 0.6, DH * 0.7, DD, BR, Mat.CONCRETE);
    this.box(dx, 0, dz + DD / 2, DW, DH * 0.85, 0.6, BR, Mat.CONCRETE);
    this.box(dx - 3, 0, dz - DD / 2, 3, DH * 0.5, 0.6, BR, Mat.CONCRETE);
    this.box(dx + 4, 0, dz - DD / 2, 3, DH * 0.6, 0.6, BR, Mat.CONCRETE);
    for (const [rx, rz, s] of [[dx - 2, dz, 2.4], [dx + 2, dz - 1, 1.8]]) {
      this.box(rx, 0, rz, s, s * 0.45, s * 0.7, CON, Mat.CONCRETE, { rotY: rz * 0.2 });
      this._coverBox(rx, rz, s, s);
    }

    // street props: bus wreck, cars, dumpsters, rubble, checkpoint
    this.box(0, 0, 7, 9, 2.6, 2.6, this.mat.metal(2, 0x6a5a3a), Mat.METAL, { rotY: 0.06 });
    this._coverBox(0, 7, 9, 2.6);
    this._wreck(-16, 8, 0.15, 0x44484e);
    this._wreck(14, 5.5, -0.1, 0x50443c);
    this._coverBox(-16, 8, 4.4, 1.9);
    this._coverBox(14, 5.5, 4.4, 1.9);
    for (const [ux, uz] of [[-2, -3], [2, -6]]) {
      this.box(ux, 0, uz, 2.4, 1.3, 1.2, this.mat.metal(1, 0x3a4a3a), Mat.METAL);
      this._coverBox(ux, uz, 2.4, 1.2);
    }
    for (const [rx, rz, s] of [[-26, 4, 2.2], [26, 10, 1.8], [-8, 12, 1.4], [8, 12, 1.6]]) {
      this.box(rx, 0, rz, s, s * 0.5, s * 0.7, CON, Mat.CONCRETE, { rotY: rx * 0.3 });
      this._coverBox(rx, rz, s, s);
    }
    // west checkpoint sandbags (insertion side)
    for (const [sx, sz, sw] of [[-30, 4, 5], [-30, 10, 5], [-26, 7, 4]]) {
      this.box(sx, 0, sz, sw, 1.2, 0.8, this.mat.fabric, Mat.WOOD, { rotY: Math.PI / 2 });
      this._coverBox(sx, sz, 0.9, sw);
    }
    this._ammoCrate(0, -31, 0, 7.5);
    this._ammoCrate(1, ax + 7, 0, az + 3);

    // street lamps
    this._poleLight(-20, 3, true);
    this._poleLight(4, 11);
    this._poleLight(24, 3, true);
    this._poleLight(-2, 11);

    // routes + spawns (8 guards)
    const r1 = this._route([[-30, 0, 7], [30, 0, 7]]);
    const r2 = this._route([[-20, 0, -3], [16, 0, -3]]);
    const r3 = this._route([[0, 0, -2], [0, 0, -20], [4, 0, -20], [4, 0, -2]]);  // alley
    const r4 = this._route([[ax - 6, 0, az + 3], [ax + 6, 0, az + 3], [ax + 6, 0, az - 4], [ax - 6, 0, az - 4]]);
    this._spawn(-28, 0, 7, r1);
    this._spawn(28, 0, 7, r1);
    this._spawn(-18, 0, -3, r2);
    this._spawn(14, 0, -3, r2);
    this._spawn(2, 0, -4, r3);
    this._spawn(ax + 5, 0, az + 2, r4);
    this._spawn(ax - 6, 0, az - 3);
    this._spawn(bx2 - 3, 0, bz2 + 3);
    for (const s of [[-38, 7], [38, 7], [34, 20], [-34, 20]]) this._surge(s[0], 0, s[1]);

    // triggers + zones
    this._trig('breach', -34, 0, 3, -28, 3, 11);
    this._trig('enter_facility', ax - AW / 2, 0, az - AD2 / 2, ax + AW / 2, 8, az + AD2 / 2);
    this._trig('dock', -4, 0, -2, 4, 3, 4);
    this._lz(-28, 34);
    // vehicles (C2) — AI utility truck running the main street (escort mission), parked SUV
    this._vehicle('truck', -44, 9.5, -90, { tag: 'escort_truck', mission: true, color: 0x59605c });  // parked; escort mission starts its engine
    this._vehicle('suv', -20, 16.5, 90, { color: 0x4a5a68 });
    // pickups & crates (C3)
    this._supplyCrate(90, -30, 0, 9);
    this._supplyCrate(91, 14, 0, 16);
    this._weaponPickup('vx12', 30, 0, 8);
    this.zones.push(
      { name: 'room', min: new THREE.Vector3(ax - AW / 2, 0, az - AD2 / 2), max: new THREE.Vector3(ax + AW / 2, 8, az + AD2 / 2) },
      { name: 'corridor', min: new THREE.Vector3(-5, 0, -24), max: new THREE.Vector3(5, 8, 4) },
    );

    this._intel(-30, 0, 7, 'BANK FLOOR PLAN');
    this._intel(-14, 0, -8, 'TOLL RECORDS');
    this._intel(-24, 0, 20, 'SAFEHOUSE ADDRESS');
    this._intel(-34, 0, 24, 'RADIO FREQUENCY SHEET');

    this.spawnPoint.set(-42, 0, 7);
    this.spawnYaw = -Math.PI / 2; // face +X (east, down the street)
  }

  // =========================================================================
  // BATTLEFIELD 5 — KESTREL WORKS (industrial complex, sabotage flow)
  // =========================================================================
  buildIndustrial(scene, physics) {
    this.map = 'industrial';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);
    this.nightSky = { bg: 0x0a0d12, fog: 0x0c1016 };
    this.daySky = { bg: 0xdde1e4, fog: 0xc9ced3 };
    this.dayFogMul = 0.9;
    this.weather = 'rain'; this.windLevel = 0.2;
    this.bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 70 };

    const M = this.mat;
    const gravel = M.gravel(60);
    const floorC = M.floorConc(30);
    const conc = M.concrete(3);
    const corr1 = M.corrugated(0x5c645e, 6);
    const corr2 = M.corrugated(0x4a4644, 6);
    const steel = M.metal(2, 0x59616a);
    const steelD = M.metalDark;

    // --- ground ---
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(124, 134), gravel);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 5);
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false; ground.updateMatrix();
    this.group.add(ground);
    this.physics.add(new THREE.Vector3(-62, -1, -62), new THREE.Vector3(62, 0, 72), Mat.GRAVEL, { tag: 'ground' });
    this.box(0, 0, 38, 92, 0.06, 34, floorC, Mat.CONCRETE, { noCollider: true });   // south yard apron
    this.box(0, 0, -34, 52, 0.06, 30, floorC, Mat.CONCRETE, { noCollider: true });  // forge apron

    // --- perimeter wall (h 3.4, T 0.6) ---
    this.box(-31, 0, 56, 54, 3.4, 0.6, conc, Mat.CONCRETE);
    this.box(31, 0, 56, 54, 3.4, 0.6, conc, Mat.CONCRETE);
    this.box(-4.6, 0, 56, 1.2, 4.6, 1.2, conc, Mat.CONCRETE);   // gate piers
    this.box(4.6, 0, 56, 1.2, 4.6, 1.2, conc, Mat.CONCRETE);
    this.box(0, 0, -58, 116, 3.4, 0.6, conc, Mat.CONCRETE);
    this.box(58, 0, -1, 0.6, 3.4, 114, conc, Mat.CONCRETE);
    this.box(-58, 0, -35.5, 0.6, 3.4, 45, conc, Mat.CONCRETE);  // west, south of culvert
    this.box(-58, 0, 24.5, 0.6, 3.4, 63, conc, Mat.CONCRETE);   // west, north of culvert
    this.cyl(-58, 0.4, -10, 1.5, 1.5, 5, 12, steelD, Mat.METAL, { rotZ: Math.PI / 2, noCollider: true }); // service culvert pipe
    this.box(-58, 0.4, -10, 4.4, 3, 3, M.rubber, Mat.METAL, { noCollider: true });

    // =======================================================================
    // WAREHOUSE  x -20..20, z -20..16, h 8
    // =======================================================================
    this.box(-11.75, 0, 16, 16.5, 8, 0.5, corr1, Mat.METAL);
    this.box(11.75, 0, 16, 16.5, 8, 0.5, corr1, Mat.METAL);
    this.box(0, 5, 16, 7, 3, 0.5, corr1, Mat.METAL);            // header over gate
    new Door(this, {
      position: new THREE.Vector3(-3.5, 0, 16), rotY: 0,
      width: 7, height: 5, thickness: 0.14, slideUp: true, material: M.doorMetal,
    });
    this.box(-11, 0, -20, 18, 8, 0.5, corr1, Mat.METAL);
    this.box(11, 0, -20, 18, 8, 0.5, corr1, Mat.METAL);
    this.box(0, 3.4, -20, 4, 4.6, 0.5, corr1, Mat.METAL);
    const secDoor = new Door(this, {
      position: new THREE.Vector3(-2, 0, -19.9), rotY: 0,
      width: 4, height: 3.4, thickness: 0.16, locked: true, material: M.doorMetal,
    });
    this.poweredDoors.push(secDoor);
    this.box(20, 0, -2, 0.5, 5, 36, corr1, Mat.METAL);            // sill band y0..5
    this.box(20, 6.6, -2, 0.5, 1.4, 36, corr1, Mat.METAL);         // head band y6.6..8
    this.box(20, 5, -16.75, 0.5, 1.6, 6.5, corr1, Mat.METAL);      // piers between clerestories
    this.box(20, 5, -6, 0.5, 1.6, 9, corr1, Mat.METAL);
    this.box(20, 5, 4, 0.5, 1.6, 5, corr1, Mat.METAL);
    this.box(20, 5, 12.75, 0.5, 1.6, 6.5, corr1, Mat.METAL);
    for (const wz of [-13.5, -1.5, 6.5]) this._window(19.9, 5, wz, 3, 1.6, 'x');
    this.box(-20, 0, -12, 0.5, 8, 16, corr1, Mat.METAL);
    this.box(-20, 0, 7, 0.5, 8, 18, corr1, Mat.METAL);
    this.box(-20, 2.4, -3, 0.5, 5.6, 2, corr1, Mat.METAL);
    new Door(this, {
      position: new THREE.Vector3(-20, 0, -2), rotY: Math.PI / 2,
      width: 2, height: 2.4, material: M.doorMetal,
    });
    this.box(0, 8, -2, 40.6, 0.35, 36.6, M.metal(2, 0x41474d), Mat.METAL);          // roof slab
    this.box(0, 0, -2, 39.6, 0.08, 35.6, floorC, Mat.CONCRETE, { noCollider: true });
    for (const rz of [-12, -4, 4]) {
      this.box(-12, 0, rz, 10, 2.6, 1.3, steel, Mat.METAL); this._coverBox(-12, rz, 10, 1.3);
      this.box(0, 0, rz, 8, 2.6, 1.3, steel, Mat.METAL);    this._coverBox(0, rz, 8, 1.3);
      this.box(11, 0, rz, 7, 2.6, 1.3, steel, Mat.METAL);   this._coverBox(11, rz, 7, 1.3);
    }
    this.box(-16, 0, 10, 1.6, 1.2, 1.6, M.wood(2, 0x6a5540), Mat.WOOD);
    this.box(-16, 1.2, 10, 1.4, 1, 1.4, M.wood(2, 0x5f4c39), Mat.WOOD);
    this.box(16, 0, 12, 1.8, 1.4, 1.2, M.wood(2, 0x6a5540), Mat.WOOD);
    // forklifts
    for (const f of [[15, -9, 0], [-15, 8, Math.PI]]) {
      this.box(f[0], 0.3, f[2], 1.3, 0.9, 2.2, M.metal(1, 0x9a7b32), Mat.METAL, { rotY: f[1] === 0 ? 0 : 0 });
      this.box(f[0], 0, f[2] + (f[1] === 0 ? 1.3 : -1.3), 0.25, 2.7, 0.25, steelD, Mat.METAL);
      this.box(f[0], 0.1, f[2] + (f[1] === 0 ? 1.9 : -1.9), 0.9, 0.08, 1.1, steelD, Mat.METAL, { noCollider: true });
    }
    this._lampHang(-10, 7.4, -12); this._lampHang(10, 7.4, -12);
    this._lampHang(-10, 7.4, 4);   this._lampHang(10, 7.4, 4);
    this._lampHang(0, 7.4, -4, true);
    for (let i = 0; i < 10; i++) this.box(21.6, i * 0.8, 12 - i * 1.4, 2.4, 0.8, 1.4, conc, Mat.CONCRETE);
    this.box(21.6, 8, -3.2, 2.4, 0.35, 2.8, conc, Mat.CONCRETE);   // roof landing
    this.zones.push({ name: 'room', min: new THREE.Vector3(-20, 0, -20), max: new THREE.Vector3(20, 8, 16) });

    // =======================================================================
    // FORGE HALL  x -22..22, z -48..-20, h 7  (security door leads in)
    // =======================================================================
    this.box(-22, 0, -34, 0.5, 7, 28, corr2, Mat.METAL);
    this.box(22, 0, -34, 0.5, 7, 28, corr2, Mat.METAL);
    this.box(-14, 0, -48, 16, 7, 0.5, corr2, Mat.METAL);
    this.box(14, 0, -48, 16, 7, 0.5, corr2, Mat.METAL);
    this.box(0, 5, -48, 12, 2, 0.5, corr2, Mat.METAL);
    new Door(this, {
      position: new THREE.Vector3(-6, 0, -48), rotY: 0,
      width: 12, height: 5, thickness: 0.14, slideUp: true, material: M.doorMetal,
    });
    this.box(0, 7, -34, 44.6, 0.35, 28.6, M.metal(2, 0x3c4147), Mat.METAL);
    this.box(0, 0, -34, 43.6, 0.08, 27.6, floorC, Mat.CONCRETE, { noCollider: true });
    // main furnace (east end)
    this.cyl(8, 0, -40, 3, 3.4, 5.5, 14, M.metal(2, 0x3a3f45), Mat.METAL);
    this.cyl(8, 2.4, -40, 3.08, 3.08, 0.5, 14, M.emissiveRed, Mat.METAL, { noCollider: true });
    this.cyl(8, 5.5, -40, 1.2, 1.4, 1.6, 10, steelD, Mat.METAL);
    const furnaceGlow = new THREE.PointLight(0xff5f28, 300, 22, 2);
    furnaceGlow.position.set(8, 3, -40);
    furnaceGlow.userData.base = furnaceGlow.intensity;
    this.group.add(furnaceGlow); this.allLights.push(furnaceGlow);
    this.machinePositions.push(new THREE.Vector3(8, 1, -40));
    // hydraulic press (west bay)
    this.box(-12, 0, -33, 4, 1, 4, conc, Mat.CONCRETE);
    this.box(-12, 1, -34.4, 0.9, 3.4, 0.9, steelD, Mat.METAL);
    this.box(-12, 3.2, -33.4, 2.6, 1, 2.2, steelD, Mat.METAL);
    this.machinePositions.push(new THREE.Vector3(-12, 1, -33));
    // coolant tank (east side)
    this.cyl(15, 0, -30, 1.3, 1.3, 3.4, 12, M.metal(2, 0x4f6a72), Mat.METAL);
    this.cyl(15, 3.4, -30, 0.16, 0.16, 1.4, 6, steelD, Mat.METAL, { noCollider: true });
    this.cyl(11.5, 2.6, -30, 0.14, 0.14, 7, 6, steelD, Mat.METAL, { rotZ: Math.PI / 2, noCollider: true });
    // sabotage charges (mission interactables)
    this._sabotage(15, 0, -28.2, 'charge_1', 'COOLANT LINE');
    this._sabotage(-12, 0, -30.8, 'charge_2', 'PRESS FEED');
    this._sabotage(8, 0, -36.2, 'charge_3', 'FURNACE BUS');
    this._lampHang(-12, 6.5, -40); this._lampHang(14, 6.5, -42);
    this._lampHang(0, 6.5, -28, true);
    this.zones.push({ name: 'room', min: new THREE.Vector3(-22, 0, -48), max: new THREE.Vector3(22, 7, -20) });

    // =======================================================================
    // GENERATOR YARD (east, x 28..42, z -12..0)
    // =======================================================================
    this.box(35, 0, -12, 14, 2.2, 0.14, steelD, Mat.METAL);
    this.box(29.5, 0, 0, 3, 2.2, 0.14, steelD, Mat.METAL);
    this.box(38.5, 0, 0, 7, 2.2, 0.14, steelD, Mat.METAL);
    this.box(28, 0, -6, 0.14, 2.2, 12, steelD, Mat.METAL);
    this.box(42, 0, -6, 0.14, 2.2, 12, steelD, Mat.METAL);
    this._generator(34, 0, -6);
    this._poleLight(41, -1);

    // =======================================================================
    // OFFICE BLOCK (x 30..46, z 24..40, two storeys)
    // =======================================================================
    this.box(38, 0, 24, 16, 1.2, 0.4, conc, Mat.CONCRETE);        // south wall bands
    this.box(38, 2.8, 24, 16, 1.1, 0.4, conc, Mat.CONCRETE);
    this.box(38, 5.5, 24, 16, 0.9, 0.4, conc, Mat.CONCRETE);
    for (const py of [1.2, 3.9]) {
      this.box(31.35, py, 24, 2.7, 1.6, 0.4, conc, Mat.CONCRETE);
      this.box(38, py, 24, 5.4, 1.6, 0.4, conc, Mat.CONCRETE);
      this.box(44.65, py, 24, 2.7, 1.6, 0.4, conc, Mat.CONCRETE);
    }
    this.box(38, 0, 40, 16, 6.4, 0.4, conc, Mat.CONCRETE);        // north wall solid
    this.box(46, 0, 32, 0.4, 1.2, 16, conc, Mat.CONCRETE);        // east wall bands
    this.box(46, 2.8, 32, 0.4, 1.1, 16, conc, Mat.CONCRETE);
    this.box(46, 5.5, 32, 0.4, 0.9, 16, conc, Mat.CONCRETE);
    this.box(46, 1.2, 26.4, 0.4, 1.6, 4.8, conc, Mat.CONCRETE);
    this.box(46, 1.2, 35.6, 0.4, 1.6, 8.8, conc, Mat.CONCRETE);
    this.box(46, 3.9, 28.4, 0.4, 1.6, 8.8, conc, Mat.CONCRETE);
    this.box(46, 3.9, 37.6, 0.4, 1.6, 4.8, conc, Mat.CONCRETE);
    this.box(30, 0, 26.5, 0.4, 6.4, 5, conc, Mat.CONCRETE);
    this.box(30, 0, 35.5, 0.4, 6.4, 9, conc, Mat.CONCRETE);
    this.box(30, 2.5, 30, 0.4, 3.9, 2, conc, Mat.CONCRETE);
    new Door(this, {
      position: new THREE.Vector3(30, 0, 31), rotY: Math.PI / 2,
      width: 2, height: 2.5, material: M.doorMetal,
    });
    this.box(38, 3.2, 32, 15.6, 0.25, 15.6, conc, Mat.CONCRETE);   // second floor slab
    for (let i = 0; i < 8; i++) this.box(44.4, i * 0.43, 38.2 - i * 1.9, 1.6, 0.43, 1.9, conc, Mat.CONCRETE);
    for (const wx of [34, 42]) {
      this._window(wx, 1.2, 23.9, 2.6, 1.6, 'z');
      this._window(wx, 3.9, 23.9, 2.6, 1.6, 'z');
    }
    this._window(45.9, 1.2, 28.8, 2.4, 1.6, 'x');
    this._window(45.9, 3.9, 32.8, 2.4, 1.6, 'x');
    this.box(38, 6.4, 32, 16.4, 0.3, 16.4, M.metal(2, 0x4a5056), Mat.METAL);
    this.box(38, 0, 32.8, 2.2, 0.75, 1, M.wood(2, 0x5d4a36), Mat.WOOD);
    const offScreen = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.05), M.emissiveScreen);
    offScreen.position.set(38, 1.05, 32.6); offScreen.rotation.x = -0.1;
    this.group.add(offScreen);
    this.box(34, 3.45, 38, 3, 2.2, 0.7, steel, Mat.METAL);         // upstairs cabinets
    this.box(41, 3.45, 26, 2.4, 0.8, 1.2, M.wood(2, 0x5d4a36), Mat.WOOD);
    this.zones.push({ name: 'room', min: new THREE.Vector3(30, 0, 24), max: new THREE.Vector3(46, 6.4, 40) });

    // =======================================================================
    // YARD DRESSING — containers, pipe rack, water tower, wrecks, drums
    // =======================================================================
    const containers = [
      [-34, 44, 0.05, 0x7a4a3a], [-27, 44, -0.04, 0x3f5a6e], [-27, 44, 2.6, 0x6e6a3f],
      [-14, 49, 0.22, 0x4e6b45], [-6, 44, 0, 0x5a4a6e], [8, 50, -0.1, 0x7a5a3a], [14, 44, 0.02, 0x3f6e6a],
    ];
    for (const c of containers) {
      this.box(c[0], c[2], c[1], 6.2, 2.6, 2.5, M.corrugated(c[3], 3), Mat.METAL, { rotY: c[2] === 2.6 ? 0 : c[2] });
      if (c[2] < 1) this._coverBox(c[0], c[1], 6.2, 2.5);
    }
    for (const px of [-40, -34, -28, -22]) this.cyl(px, 0, 6, 0.22, 0.28, 3.2, 8, steelD, Mat.METAL);
    this.cyl(-31, 3.2, 6, 0.34, 0.34, 21, 10, M.rust, Mat.METAL, { rotZ: Math.PI / 2, noCollider: true });
    this.cyl(-31, 2.5, 6.8, 0.24, 0.24, 21, 8, steelD, Mat.METAL, { rotZ: Math.PI / 2, noCollider: true });
    for (const l of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
      this.box(46 + l[0], 0, -30 + l[1], 0.35, 5.5, 0.35, steelD, Mat.METAL);
    }
    this.cyl(46, 5.5, -30, 3, 3, 4, 12, M.metal(3, 0x6a7076), Mat.METAL);
    this.cyl(46, 9.5, -30, 0, 3.2, 1.6, 12, steelD, Mat.METAL, { noCollider: true });
    this._wreck(-44, 30, 0.5);
    this._wreck(20, 52, -0.3);
    for (const d of [[26, 10], [26.9, 10.4], [26.4, 11.2], [-24, -6]]) {
      this.cyl(d[0], 0, d[1], 0.34, 0.34, 0.9, 10, M.rust, Mat.METAL);
    }
    this._poleLight(-30, 48); this._poleLight(30, 48);
    this._poleLight(-26, -8, true); this._poleLight(24, 18);

    // --- AI data ---
    const r0 = this._route([[2, 50], [2, 20], [-8, 4], [8, -12]]);
    const r1 = this._route([[-40, 46], [-40, 12], [-24, 6], [-24, 46]]);
    const r2 = this._route([[-14, -30], [14, -30], [14, -44], [-14, -44]]);
    const r3 = this._route([[32, 26], [44, 26], [44, 38], [32, 38]]);
    this._spawn(3, 0, 52, r0);
    this._spawn(-30, 0, 30, r1);
    this._spawn(-24, 0, 14, r1);
    this._spawn(0, 0, -36, r2);
    this._spawn(12, 0, -42, r2);
    this._spawn(38, 0, 34, r3);
    this._spawn(0, 0, 6);
    this._spawn(-46, 0, -10);
    this._spawn(36, 0, -4);
    for (const s of [[-30, 52], [30, 52], [46, -18], [-46, -46]]) this._surge(s[0], 0, s[1]);

    // --- mission furniture ---
    this._ammoCrate(0, -18, 0, 14);
    this._ammoCrate(1, -30, 0, 40);
    this._ammoCrate(2, -20, 0, -46);
    this._trig('breach', -58, 0, -58, 58, 4, 55.5);
    this._lz(-46, 58);
    // vehicles (C2) — night transit truck on the apron + pickup by the office
    this._vehicle('truck', 4, 34, 180, { tag: 'transit_truck', mission: true, color: 0x5b6157 });
    this._vehicle('pickup', 32, 22, -90, { color: 0x6a6252 });
    // pickups & crates (C3)
    this._supplyCrate(90, -44, 0, 54);
    this._supplyCrate(91, 10, 0, 38);
    this._weaponPickup('rk4', 16, 0, 36);
    this._intel(12, 0, 44, 'FORGE SCHEMATIC');
    this._intel(38, 0, 32, 'SHIFT SCHEDULE');
    this._intel(10, 0, -40, 'COOLANT ANALYSIS');
    this._intel(-14, 0, 8, "FOREMAN'S LOG");

    this.spawnPoint.set(0, 0, 66);
    this.spawnYaw = 0; // face -Z (main gate)
  }

  // =========================================================================
  // BATTLEFIELD 6 — DRAVA OUTSKIRTS (rural valley, investigation + rescue)
  // =========================================================================
  buildRural(scene, physics) {
    this.map = 'rural';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this.fogMulBase = 2.4;
    this.fogMul = 2.4;
    this._buildLighting(scene);
    this.nightSky = { bg: 0x0b0e13, fog: 0x14181e };
    this.daySky = { bg: 0xd8dce0, fog: 0xc4c9ce };
    this.dayFogMul = 0.85;
    this.weather = 'fog'; this.windLevel = 0.25;
    this.bounds = { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };

    const M = this.mat;
    const grass = M.gravel(60).clone(); grass.color.set(0x3f4d33);
    const grassDark = M.gravel(40).clone(); grassDark.color.set(0x354229);
    const dirt = M.sand(40).clone(); dirt.color.set(0x6f5d47);
    const wheat = M.gravel(30).clone(); wheat.color.set(0x8f7f3f);
    const plaster = M.concrete(2).clone(); plaster.color.set(0x8a8378);
    const barnWood = M.wood(3, 0x6e4f3a);
    const hutWood = M.wood(2, 0x7a6a55);

    // --- ground ---
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), grass);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false; ground.updateMatrix();
    this.group.add(ground);
    this.physics.add(new THREE.Vector3(-76, -1, -76), new THREE.Vector3(76, 0, 76), Mat.SOIL, { tag: 'ground' });
    // dirt road: south leg, bend, north leg
    this.box(0, 0.02, 35, 5, 0.05, 52, dirt, Mat.SOIL, { noCollider: true });
    this.box(2, 0.03, 11, 9, 0.05, 5, dirt, Mat.SOIL, { noCollider: true });
    this.box(4, 0.02, -14, 5, 0.05, 50, dirt, Mat.SOIL, { noCollider: true });

    // --- terraced hills (east) ---
    for (let i = 0; i < 6; i++) {
      this.box(32 + i * 5.4, 0, -8, 5.6, 0.6 * (i + 1), 66, i % 2 ? grass : grassDark, Mat.SOIL);
    }
    const rnd = mulberry32(77);
    for (let i = 0; i < 14; i++) {
      const tier = 2 + Math.floor(rnd() * 4);
      this._pine(31 + tier * 5.4 + rnd() * 3, -38 + rnd() * 58, 5 + rnd() * 3, rnd);
    }
    for (let i = 0; i < 10; i++) this._pine(-58 + rnd() * 22, -52 + rnd() * 34, 6 + rnd() * 3, rnd);

    // --- wheat fields (west) ---
    for (let r = 0; r < 10; r++) {
      this.box(-21, 0, 1.5 + r * 3, 17, 0.55, 0.6, wheat, Mat.FABRIC, { noCollider: true });
    }
    this.box(-12, 0.55, 15, 0.1, 0.12, 30, hutWood, Mat.WOOD);   // field fence (east edge)
    this.box(-12, 0.95, 15, 0.1, 0.12, 30, hutWood, Mat.WOOD);
    for (let p = 0; p <= 6; p++) this.box(-12, 0, p * 5, 0.12, 1.15, 0.12, hutWood, Mat.WOOD, { noCollider: true });
    this.box(-21, 0.55, 0, 18, 0.12, 0.1, hutWood, Mat.WOOD);    // south edge
    this.box(-21, 0.95, 0, 18, 0.12, 0.1, hutWood, Mat.WOOD);

    // --- village (4 houses + well) ---
    const eastWallWin = (hx, hz, hw, hd, wallMat) => {
      const T = 0.3;
      this.box(hx + hw / 2, 0, hz, T, 1.3, hd, wallMat, Mat.WOOD);                       // sill
      this.box(hx + hw / 2, 2.4, hz, T, 0.5, hd, wallMat, Mat.WOOD);                     // head
      const pl = hd / 2 - 0.7, pc = (hd / 2 + 0.7) / 2;
      this.box(hx + hw / 2, 1.3, hz - pc, T, 1.1, pl, wallMat, Mat.WOOD);                // piers
      this.box(hx + hw / 2, 1.3, hz + pc, T, 1.1, pl, wallMat, Mat.WOOD);
      this._window(hx + hw / 2 - 0.02, 1.3, hz - 0.7, 1.4, 1.1, 'x');
    };
    const house = (hx, hz, hw, hd, wallMat) => {
      const T = 0.3, H = 2.9;
      this.box(hx, 0, hz - hd / 2, hw, H, T, wallMat, Mat.WOOD);
      this.box(hx, 0, hz + hd / 2, hw, H, T, wallMat, Mat.WOOD);
      this.box(hx - hw / 2, 0, hz, T, H, hd, wallMat, Mat.WOOD);
      eastWallWin(hx, hz, hw, hd, wallMat);
      this.box(hx, H, hz, hw + 0.5, 0.25, hd + 0.5, M.metal(2, 0x514840), Mat.METAL);
    };
    const houseDoor = (hx, hz, hw, hd, wallMat) => {
      const T = 0.3, H = 2.9, dz = hz + hd / 2;
      this.box(hx - hw / 4 - 0.35, 0, dz, hw / 2 - 0.7, H, T, wallMat, Mat.WOOD);
      this.box(hx + hw / 4 + 0.35, 0, dz, hw / 2 - 0.7, H, T, wallMat, Mat.WOOD);
      this.box(hx, 2.3, dz, 1.4, 0.6, T, wallMat, Mat.WOOD);
      new Door(this, {
        position: new THREE.Vector3(hx - 0.7, 0, dz + 0.02), rotY: 0,
        width: 1.4, height: 2.3, material: M.doorMetal,
      });
      this.box(hx, 0, hz - hd / 2, hw, H, T, wallMat, Mat.WOOD);
      this.box(hx - hw / 2, 0, hz, T, H, hd, wallMat, Mat.WOOD);
      eastWallWin(hx, hz, hw, hd, wallMat);
      this.box(hx, H, hz, hw + 0.5, 0.25, hd + 0.5, M.metal(2, 0x514840), Mat.METAL);
    };
    house(24, 21, 5.5, 5, hutWood);
    house(25, 30, 6, 5, plaster);
    houseDoor(14, 22, 6, 5, plaster);
    houseDoor(13, 31.5, 5, 4.5, hutWood);
    // village well
    this.cyl(18, 0, 26, 1.05, 1.2, 0.9, 10, M.concrete(1), Mat.CONCRETE);
    this.box(17.1, 0.9, 26, 0.12, 1.7, 0.12, hutWood, Mat.WOOD, { noCollider: true });
    this.box(18.9, 0.9, 26, 0.12, 1.7, 0.12, hutWood, Mat.WOOD, { noCollider: true });
    this.box(18, 2.6, 26, 2.6, 0.14, 2.2, barnWood, Mat.WOOD);
    this.cyl(18, 0.9, 26, 0.5, 0.5, 0.5, 8, M.rust, Mat.METAL, { noCollider: true });

    // --- burned truck + evidence markers ---
    this._wreck(2, 24, 0.35, 0x2f2b27);
    this.box(2, 0.03, 24, 4.4, 0.04, 6.4, M.rubber, Mat.SOIL, { noCollider: true });
    this._evidence(3.6, 0, 25.6, 'BURNED TRUCK');
    this._evidence(18, 0, 28.2, 'VILLAGE WELL');
    this._evidence(-10, 0, -11.4, 'SHACK PORCH');

    // --- radio shack (west of village, south of farm) ---
    const sx = -10, sz = -14.5;
    this.box(sx, 0, sz - 2, 4, 2.8, 0.25, hutWood, Mat.WOOD);
    this.box(sx - 1.35, 0, sz + 2, 1.3, 2.8, 0.25, hutWood, Mat.WOOD);
    this.box(sx + 1.35, 0, sz + 2, 1.3, 2.8, 0.25, hutWood, Mat.WOOD);
    this.box(sx, 2.25, sz + 2, 1.4, 0.55, 0.25, hutWood, Mat.WOOD);
    new Door(this, {
      position: new THREE.Vector3(sx - 0.7, 0, sz + 2.02), rotY: 0,
      width: 1.4, height: 2.25, material: M.doorMetal,
    });
    this.box(sx - 2, 0, sz, 0.25, 2.8, 4, hutWood, Mat.WOOD);
    this.box(sx + 2, 0, sz, 0.25, 2.8, 4, hutWood, Mat.WOOD);
    this.box(sx, 2.8, sz, 4.5, 0.2, 4.5, M.metal(2, 0x514840), Mat.METAL);
    this.box(sx, 0, sz - 1.4, 2, 0.75, 0.7, hutWood, Mat.WOOD);            // console desk
    const radioScreen = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.05), M.emissiveScreen);
    radioScreen.position.set(sx + 0.4, 1.05, sz - 1.3); radioScreen.rotation.x = -0.1;
    this.group.add(radioScreen);
    this.cyl(sx - 1.7, 0, sz - 1.7, 0.05, 0.07, 4.6, 5, M.metalDark, Mat.METAL, { noCollider: true }); // antenna mast
    this._observe(sx - 0.6, 0, sz - 0.9, 'radio_records', 'FREQUENCY RECORDS');
    this.zones.push({ name: 'room', min: new THREE.Vector3(sx - 2, 0, sz - 2), max: new THREE.Vector3(sx + 2, 2.8, sz + 2) });

    // --- farm compound (barn + silo + pen) ---
    this.box(-8, 0, -34, 12, 4, 0.3, barnWood, Mat.WOOD);
    this.box(-14, 0, -29, 0.3, 4, 10, barnWood, Mat.WOOD);
    this.box(-2, 0, -29, 0.3, 4, 10, barnWood, Mat.WOOD);
    this.box(-12, 0, -24, 4, 4, 0.3, barnWood, Mat.WOOD);
    this.box(-4, 0, -24, 4, 4, 0.3, barnWood, Mat.WOOD);
    this.box(-8, 3.4, -24, 4, 0.6, 0.3, barnWood, Mat.WOOD);
    new Door(this, {
      position: new THREE.Vector3(-10, 0, -24), rotY: 0,
      width: 4, height: 3.4, thickness: 0.12, slideUp: true, material: M.doorMetal,
    });
    this.box(-8, 4, -29, 12.6, 0.3, 10.6, M.metal(2, 0x514840), Mat.METAL);
    this.box(-11, 0, -31, 1.4, 0.8, 2, M.wood(2, 0x9a854a), Mat.FABRIC);   // hay bales
    this.box(-9.4, 0, -31.4, 1.4, 0.8, 2, M.wood(2, 0x8f7a42), Mat.FABRIC);
    this.box(-10.2, 0.8, -31.2, 1.4, 0.8, 2, M.wood(2, 0x9a854a), Mat.FABRIC);
    this.zones.push({ name: 'room', min: new THREE.Vector3(-14, 0, -34), max: new THREE.Vector3(-2, 4, -24) });
    this.cyl(-16.5, 0, -30, 2, 2, 7, 12, M.corrugated(0x77726a, 4), Mat.METAL);
    this.cyl(-16.5, 7, -30, 0, 2.15, 1.4, 12, M.metalDark, Mat.METAL, { noCollider: true });
    this.box(-12, 0.5, -20, 8, 0.12, 0.1, hutWood, Mat.WOOD);              // pen fence
    this.box(-12, 0.95, -20, 8, 0.12, 0.1, hutWood, Mat.WOOD);
    this.box(-16, 0.5, -17, 0.1, 0.12, 6, hutWood, Mat.WOOD);
    this.box(-16, 0.95, -17, 0.1, 0.12, 6, hutWood, Mat.WOOD);
    this.machinePositions.push(new THREE.Vector3(-6, 1, -32.5));

    // --- road checkpoint (south approach) ---
    this.box(-4.5, 0, 44, 3, 1, 0.9, M.fabric, Mat.FABRIC);
    this.box(4.5, 0, 44, 3, 1, 0.9, M.fabric, Mat.FABRIC);
    this._coverBox(-4.5, 44, 3, 0.9); this._coverBox(4.5, 44, 3, 0.9);
    this.cyl(3.2, 0, 41.6, 0.09, 0.11, 1.1, 6, M.metalDark, Mat.METAL);
    this.box(0.4, 1.05, 41.6, 5.6, 0.14, 0.14, M.metal(1, 0xaa4a32), Mat.METAL, { noCollider: true });
    for (const tp of [[5.4, 47.4], [8.6, 47.4], [5.4, 50.6], [8.6, 50.6]]) {
      this.cyl(tp[0], 0, tp[1], 0.07, 0.07, 2.3, 5, hutWood, Mat.WOOD, { noCollider: true });
    }
    this.box(7, 2.3, 49, 4, 0.15, 4, M.fabric, Mat.FABRIC);
    this._poleLight(5, 46);

    // --- NPCs (shepherd contact + two civilians) ---
    this._npc(16, 22, 'contact', [[16, 22], [10, 34], [2, 48], [-6, 58]]);
    this._npc(-20, 8, 'civ', [[-20, 8], [-24, 20], [-16, 26]]);
    this._npc(26, 30, 'civ', [[26, 30], [14, 36], [22, 20]]);

    // --- AI data ---
    const r0 = this._route([[12, 20], [28, 20], [28, 32], [12, 32]]);
    const r1 = this._route([[2, 42], [2, 14], [6, -14], [6, -36]]);
    const r2 = this._route([[-12, -30], [-4, -24], [-12, -20], [-16, -28]]);
    this._spawn(16, 0, 20, r0);
    this._spawn(26, 0, 30, r0);
    this._spawn(1, 0, 43, r1);
    this._spawn(4, 0, -10, r1);
    this._spawn(-10, 0, -26, r2);
    this._spawn(42, 2, -8);
    this._spawn(-24, 0, 24);
    for (const s of [[0, 52], [28, 8], [-28, -8]]) this._surge(s[0], 0, s[1]);

    // --- mission furniture ---
    this._ammoCrate(0, -4, 0, 42);
    this._ammoCrate(1, -12, 0, -32);
    this._ammoCrate(2, 20, 0, 24);
    this._trig('breach', -6, 0, 30, 6, 3, 38);
    this._lz(-8, 60);
    // vehicles (C2) — farm pickup (convoy), civilian truck looping the road, abandoned SUV in the treeline (recovery)
    this._vehicle('pickup', -5, -18, 0, { tag: 'farm_pickup', mission: true, color: 0x71604a });
    this._vehicle('truck', 2, 48, 180, { tag: 'civ_truck', ai: true, color: 0x7a7264,
      route: [[2, 48], [3, 20], [5, 0], [5, -20], [5, -36]] });
    this._vehicle('suv', -20, 8, 20, { tag: 'recovery_suv', mission: true, hpFrac: 0.08, color: 0x5a6e52 });
    // pickups & crates (C3)
    this._supplyCrate(90, -6, 0, -24);
    this._supplyCrate(91, 2, 0, 42);
    this._weaponPickup('st12', -14, 0, -16);
    this._intel(-9, 0, -13, 'CABIN RADIO TAPE');
    this._intel(-8, 0, -28, 'TRUCK WAYBILL');
    this._intel(4, 0, 44, 'FIELD SURVEY');
    this._intel(19.5, 0, 24, 'WELL WATER REPORT');

    this.spawnPoint.set(0, 0, 66);
    this.spawnYaw = 0; // face -Z up the road
  }

  buildRange(scene, physics) {
    this.map = 'range';
    this.physics = physics;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMaterials();
    this._buildLighting(scene);
    this.moon.intensity = 0.9;
    const rnd = mulberry32(99);
    this.rnd = rnd;

    // ground
    const g = new THREE.Mesh(new THREE.PlaneGeometry(200, 260), this.mat.gravel(40));
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    g.matrixAutoUpdate = false; g.updateMatrix();
    this.group.add(g);
    this.physics.add(new THREE.Vector3(-100, -1, -130), new THREE.Vector3(100, 0, 130), Mat.GRAVEL, { tag: 'ground' });

    this.spawnPoint.set(0, 0, 30);
    this.spawnYaw = 0; // face -Z, downrange toward the targets
    this.extractionPoint.set(0, 0, 30);

    // firing line shed (open front)
    this.box(0, 0, 34, 14, 0.2, 6, this.mat.concrete(4), Mat.CONCRETE, { cast: false }); // pad
    this.box(-7, 0, 34, 0.4, 3.4, 6, this.mat.metalDark, Mat.METAL);
    this.box(7, 0, 34, 0.4, 3.4, 6, this.mat.metalDark, Mat.METAL);
    this.box(0, 3.4, 34, 14.4, 0.3, 6.4, this.mat.corrugated(0x40464c, 3), Mat.METAL, { cast: false });
    this.box(0, 0, 37.2, 14, 3.4, 0.4, this.mat.concrete(4), Mat.CONCRETE);
    this._lamp(-3, 3.1, 35, 0xffe3b0, 16, 12);
    this._lamp(3, 3.1, 35, 0xffe3b0, 16, 12);
    // bench
    this.box(0, 0.5, 33, 8, 0.1, 0.6, this.mat.wood(1), Mat.WOOD);

    // lane dividers + distance markers at 10 / 25 / 50 / 100 m (north = -Z)
    const distances = [10, 25, 50, 100];
    for (const d of distances) {
      const z = 30 - d;
      // berms either side
      this.box(-14, 0, z, 1.4, 1.2 + d * 0.02, 2.4, this.mat.concrete(3), Mat.CONCRETE);
      this.box(14, 0, z, 1.4, 1.2 + d * 0.02, 2.4, this.mat.concrete(3), Mat.CONCRETE);
      // sign
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshStandardMaterial({
        color: 0x20242a, emissive: 0x33414d, emissiveIntensity: 0.4, roughness: 0.9, side: THREE.DoubleSide,
      }));
      sign.position.set(-14, 2.2, z);
      this.group.add(sign);
      // targets
      const n = d <= 25 ? 3 : d <= 50 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * (d <= 25 ? 5 : 7);
        new RangeTarget(this, new THREE.Vector3(x, 0, z), d <= 25 ? 1 : 1.15);
      }
      // backstop for the 100 m lane
      if (d === 100) this.box(0, 0, z - 3, 30, 5, 1, this.mat.concrete(6), Mat.CONCRETE);
    }

    // some cover barrels / crates in the lanes for movement practice
    for (let i = 0; i < 10; i++) {
      const x = -10 + rnd() * 20, z = 24 - rnd() * 60;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), this.mat.wood(1));
      crate.position.set(x, 0.6, z);
      crate.rotation.y = rnd() * 0.6;
      crate.castShadow = true; crate.receiveShadow = true;
      this.group.add(crate);
      this.physics.addBox(new THREE.Vector3(x, 0.6, z), new THREE.Vector3(1.4, 1.2, 1.4), Mat.WOOD, { tag: 'prop' });
    }

    // resupply crate on the bench
    this.interactables.push({
      id: 'range_ammo',
      pos: new THREE.Vector3(0, 0.9, 33),
      radius: 2.4,
      prompt: 'RESUPPLY AMMUNITION',
      getPrompt: () => 'RESUPPLY AMMUNITION',
      hold: 0.5,
      used: false,
      reusable: true,
      action: (game) => {
        game.player.resupplyAll(true);
        game.audio.pickup(null);
        return true;
      },
    });

    // floodlights
    this._poleLight(-20, 20);
    this._poleLight(20, 20);
    this._poleLight(-20, -40, true);
    this._poleLight(20, -40);

    this.zones.push({ name: 'open', min: new THREE.Vector3(-100, 0, -130), max: new THREE.Vector3(100, 50, 130) });
  }

  // =========================================================================
  // Runtime queries / updates
  // =========================================================================
  getAudioZone(pos) {
    // most specific zone wins: room > corridor > warehouse > open
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      if (pos.x >= z.min.x && pos.x <= z.max.x &&
          pos.y >= z.min.y && pos.y <= z.max.y &&
          pos.z >= z.min.z && pos.z <= z.max.z) {
        if (z.exclude &&
            pos.x >= z.exclude.min.x && pos.x <= z.exclude.max.x &&
            pos.z >= z.exclude.min.z && pos.z <= z.exclude.max.z &&
            pos.y >= z.exclude.min.y && pos.y <= z.exclude.max.y) continue;
        return z.name;
      }
    }
    return 'open';
  }

  checkTrigger(id, pos) {
    for (const t of this.triggers) {
      if (t.id !== id) continue;
      if (t.center) return pos.distanceToSquared(t.center) <= t.radius * t.radius;
      return pos.x >= t.min.x && pos.x <= t.max.x &&
             pos.y >= t.min.y && pos.y <= t.max.y &&
             pos.z >= t.min.z && pos.z <= t.max.z;
    }
    return false;
  }

  breakGlass(collider) {
    const pane = this.glassPanes.find(p => p.collider === collider);
    if (pane) {
      this.group.remove(pane.mesh);
      pane.mesh.geometry.dispose();
      this.glassPanes.splice(this.glassPanes.indexOf(pane), 1);
    }
    collider.enabled = false;
    collider.breakable = false;
  }

  /** Find the interactable the player is looking at. */
  findInteractable(camPos, camDir, maxDist = 2.6) {
    let best = null, bestD = maxDist;
    for (const it of this.interactables) {
      if (it.used && !it.reusable) continue;
      if (it.hidden) continue;
      const d = camPos.distanceTo(it.pos);
      if (d > maxDist + (it.radius || 0) * 0.35) continue;
      _iv.copy(it.pos).sub(camPos);
      const proj = _iv.dot(camDir);
      if (proj < 0 || proj > maxDist + 1.2) continue;
      const perp = Math.sqrt(Math.max(0, _iv.lengthSq() - proj * proj));
      if (perp > 1.1) continue;
      if (proj < bestD) { bestD = proj; best = it; }
    }
    return best;
  }

  update(dt, game) {
    if (this._motes) {
      const arr = this._motes.geometry.attributes.position.array;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] -= dt * 0.06;
        if (arr[i] < 0.3) arr[i] = 8.5;
      }
      this._motes.geometry.attributes.position.needsUpdate = true;
    }
    for (const d of this.doors) d.update(dt);
    for (const t of this.rangeTargets) t.update(dt);

    // flickering yard lights
    const lf = this.lightMode === 'day' ? 0.22 : 1;
    for (const f of this._flickerLights) {
      f.t += dt;
      const n = Math.sin(f.t * 37) * Math.sin(f.t * 13.7) * Math.sin(f.t * 5.1);
      f.light.intensity = (n > 0.35 ? f.base * 0.15 : f.base * (0.85 + n * 0.1)) * lf;
    }
    // extraction beacon blink
    if (this._blinkLights) {
      this._blinkT = (this._blinkT || 0) + dt;
      const on = Math.sin(this._blinkT * 4) > 0;
      for (const l of this._blinkLights) l.intensity = (on ? 12 : 1.5) * lf;
    }
    // terminal screen pulse before use
    if (this.terminalScreen && !this.terminalUsed) {
      const p = 0.9 + Math.sin(game.time * 6) * 0.2;
      this.terminalScreen.material.emissiveIntensity = p * 1.2;
      if (this.terminalGlow) this.terminalGlow.intensity = 2 + p * 1.5;
    }
    // extraction smoke marker (only once mission is in extraction phase)
    if (this.extractionMarker && game.missions && game.missions.smokeActive) {
      this._smokeTimer -= dt;
      if (this._smokeTimer <= 0) {
        this._smokeTimer = 0.12;
        game.particles.markerSmoke(this.extractionMarker);
      }
    }
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          if (m.normalMap) m.normalMap.dispose();
          m.dispose();
        }
      }
    });
    for (const m of this._matCache.values()) {
      m.dispose();
    }
    this._matCache.clear();
    for (const t of this._texCache.values()) t.dispose();
    this._texCache.clear();
    for (const l of this.allLights) {
      scene.remove(l);
      if (l.target) scene.remove(l.target);
    }
    if (this.moon) { scene.remove(this.moon); if (this.moon.target) scene.remove(this.moon.target); }
    this.doors.length = 0;
    this.interactables.length = 0;
    this.triggers.length = 0;
    this.coverPoints.length = 0;
    this.patrolRoutes.length = 0;
    this.enemySpawns.length = 0;
    this.surgeSpawns.length = 0;
    this.glassPanes.length = 0;
    this.rangeTargets.length = 0;
    this.shadowLights.length = 0;
    this.allLights.length = 0;
    this.zones.length = 0;
    this.machinePositions.length = 0;
    this._flickerLights.length = 0;
    this.shootables.length = 0;
    this.npcSpawns.length = 0;
    this.vehicleSpawns.length = 0;
    this.evidenceCollected = 0;
    this._evCount = 0;
    this.intelPlaced.length = 0;
    this.poweredDoors.length = 0;
    this.generatorOn = false;
    this.sabotageDone = 0;
    this._motes = null;
    this._blinkLights = null;
    this.terminalScreen = null;
    this.terminalGlow = null;
    this.moon = null;
  }
}

const _iv = new THREE.Vector3();
