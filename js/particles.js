/**
 * particles.js
 * Pooled, budget-capped visual effects:
 *  - GPU point pools (additive sparks / soft smoke-dust)
 *  - instanced debris & glass fragments (CPU-integrated, gravity, simple bounce)
 *  - pooled muzzle flashes (sprite + point light)
 *  - pooled tracers (fading additive lines)
 * No allocations during gameplay — everything is pre-created and recycled.
 */
import * as THREE from 'three';

// module-level scratch objects (avoid per-frame allocations)
const _euler = new THREE.Euler();
const _dq = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Point pool: a fixed-capacity Points cloud simulated on CPU, drawn with a
// tiny custom shader for per-particle size / colour / alpha.
// ---------------------------------------------------------------------------
class PointPool {
  constructor(scene, capacity, { additive = false, texture = null } = {}) {
    this.capacity = capacity;
    this.count = 0;

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);

    // CPU-side simulation state
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.spawnAlpha = new Float32Array(capacity);
    this.sizeGrow = new Float32Array(capacity); // >0 expands (smoke), <0 shrinks (sparks)
    this.alive = new Uint8Array(capacity);
    this.freeList = [];
    for (let i = capacity - 1; i >= 0; i--) this.freeList.push(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: texture } },
      vertexShader: `
        attribute vec3 pcolor;
        attribute float psize;
        attribute float palpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = pcolor;
          vAlpha = palpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * (320.0 / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uTex, gl_PointCoord);
          float a = tex.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * tex.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 10 : 5;
    this.geo = geo;
    scene.add(this.points);
  }

  spawn(pos, vel, opts) {
    if (this.freeList.length === 0) return -1; // budget exhausted: drop silently
    const i = this.freeList.pop();
    const i3 = i * 3;
    this.positions[i3] = pos.x; this.positions[i3 + 1] = pos.y; this.positions[i3 + 2] = pos.z;
    this.vel[i3] = vel.x; this.vel[i3 + 1] = vel.y; this.vel[i3 + 2] = vel.z;
    this.colors[i3] = opts.r; this.colors[i3 + 1] = opts.g; this.colors[i3 + 2] = opts.b;
    const life = opts.life;
    this.life[i] = life; this.maxLife[i] = life;
    this.gravity[i] = opts.gravity !== undefined ? opts.gravity : 0;
    this.drag[i] = opts.drag !== undefined ? opts.drag : 0;
    this.baseSize[i] = opts.size;
    this.spawnAlpha[i] = opts.alpha !== undefined ? opts.alpha : 1;
    this.sizeGrow[i] = opts.sizeGrow || 0;
    this.sizes[i] = opts.size;
    this.alphas[i] = this.spawnAlpha[i];
    this.alive[i] = 1;
    this.count++;
    return i;
  }

  update(dt) {
    let maxLive = 0;
    const pos = this.positions, vel = this.vel;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        this.count--;
        this.freeList.push(i);
        continue;
      }
      const dragF = Math.max(0, 1 - this.drag[i] * dt);
      vel[i3] *= dragF;
      vel[i3 + 1] = vel[i3 + 1] * dragF - this.gravity[i] * dt;
      vel[i3 + 2] *= dragF;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1 over lifetime
      this.alphas[i] = (1 - t * t) * this.spawnAlpha[i];
      this.sizes[i] = this.baseSize[i] + this.sizeGrow[i] * t;
      if (i + 1 > maxLive) maxLive = i + 1;
    }
    this.geo.setDrawRange(0, maxLive);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
    this.geo.attributes.palpha.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) { this.alive[i] = 0; this.count--; this.freeList.push(i); }
      this.alphas[i] = 0; this.sizes[i] = 0;
    }
    this.geo.setDrawRange(0, 0);
  }
}

// ---------------------------------------------------------------------------
// Debris pool: instanced tiny boxes (concrete chips, glass shards, casings).
// ---------------------------------------------------------------------------
class DebrisPool {
  constructor(scene, capacity) {
    this.capacity = capacity;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    scene.add(this.mesh);

    this.pos = []; this.vel = []; this.quat = []; this.avel = [];
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.color = [];
    for (let i = 0; i < capacity; i++) {
      this.pos.push(new THREE.Vector3(0, -100, 0));
      this.vel.push(new THREE.Vector3());
      this.quat.push(new THREE.Quaternion());
      this.avel.push(new THREE.Vector3());
      this.color.push(new THREE.Color(0.5, 0.5, 0.5));
      this.mesh.setColorAt(i, this.color[i]);
    }
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
  }

  spawn(pos, vel, size, color, life, spin) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity; // oldest gets recycled
    this.pos[i].copy(pos);
    this.vel[i].copy(vel);
    this.size[i] = size;
    this.life[i] = life;
    this.color[i].copy(color);
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.avel[i].set(
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin
    );
    this.quat[i].setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
  }

  update(dt) {
    const g = 14;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this._m.makeScale(0, 0, 0);
        this._m.setPosition(this.pos[i]);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }
      this.life[i] -= dt;
      const p = this.pos[i], v = this.vel[i];
      v.y -= g * dt;
      p.addScaledVector(v, dt);
      // crude ground bounce
      if (p.y < 0.02 && v.y < 0) { p.y = 0.02; v.y *= -0.32; v.x *= 0.7; v.z *= 0.7; }
      const q = this.quat[i], a = this.avel[i];
      _euler.set(a.x * dt, a.y * dt, a.z * dt);
      _dq.setFromEuler(_euler);
      q.multiply(_dq);
      const s = this.size[i];
      this._m.compose(p, q, this._s.set(s, s * (0.4 + Math.random() * 0.05 + 0.5), s));
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { this.life.fill(0); }
}

// ---------------------------------------------------------------------------
// Main effects manager
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pooled surface decals (bullet holes, scorch marks) — static quads recycled
// ring-buffer style so impacts leave persistent evidence on the world.
// ---------------------------------------------------------------------------
const _decalUp = new THREE.Vector3(0, 0, 1);
function makeDecalTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  if (kind === 'hole') {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 26);
    g.addColorStop(0, 'rgba(0,0,0,0.95)');
    g.addColorStop(0.45, 'rgba(10,8,6,0.8)');
    g.addColorStop(0.75, 'rgba(30,26,22,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(60,54,46,0.5)';
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(32 + Math.cos(a) * 6, 32 + Math.sin(a) * 6);
      ctx.lineTo(32 + Math.cos(a) * (14 + Math.random() * 10), 32 + Math.sin(a) * (14 + Math.random() * 10));
      ctx.stroke();
    }
  } else {
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(8,6,4,0.85)');
    g.addColorStop(0.6, 'rgba(14,10,8,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(32, 32, 30, 0, 7); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
class DecalPool {
  constructor(scene, cap = 64) {
    this.cap = cap;
    this.idx = 0;
    this.used = 0;
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.holeTex = makeDecalTexture('hole');
    this.scorchTex = makeDecalTexture('scorch');
    this.meshes = [];
    for (let i = 0; i < cap; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.holeTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2,
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.visible = false;
      m.renderOrder = 5;
      scene.add(m);
      this.meshes.push(m);
    }
  }
  spawn(point, normal, kind = 'hole', scale = 0.16) {
    const m = this.meshes[this.idx];
    this.idx = (this.idx + 1) % this.cap;
    this.used = Math.min(this.cap, this.used + 1);
    m.material.map = kind === 'scorch' ? this.scorchTex : this.holeTex;
    m.material.color.set(kind === 'scorch' ? 0x2a2420 : 0x141210);
    m.position.copy(point).addScaledVector(normal, 0.015);
    m.quaternion.setFromUnitVectors(_decalUp, normal);
    m.rotateZ(Math.random() * Math.PI * 2);
    const s = scale * (0.8 + Math.random() * 0.5);
    m.scale.set(s, s, s);
    m.visible = true;
  }
  clear() {
    for (const m of this.meshes) m.visible = false;
    this.idx = 0;
    this.used = 0;
  }
}


// ---------------------------------------------------------------------------
// Weather: pooled point field recycled around the camera (snow / rain / dust)
// ---------------------------------------------------------------------------
class Weather {
  constructor(scene) {
    this.n = 700;
    this.kind = null;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.n * 3);
    this.seed = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.seed[i] = Math.random();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.08, transparent: true, opacity: 0.85,
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
    this.t = 0;
  }
  setKind(kind) {
    this.kind = kind;
    if (!kind) { this.points.visible = false; return; }
    this.points.visible = true;
    if (kind === 'snow') { this.mat.color.set(0xf4f8ff); this.mat.size = 0.07; this.mat.opacity = 0.9; }
    else if (kind === 'rain') { this.mat.color.set(0x9fb4c8); this.mat.size = 0.05; this.mat.opacity = 0.55; }
    else if (kind === 'fog') { this.mat.color.set(0xa8b6c0); this.mat.size = 0.6; this.mat.opacity = 0.055; }
    else { this.mat.color.set(0xc8b088); this.mat.size = 0.045; this.mat.opacity = 0.4; }
  }
  update(dt, camera) {
    if (!this.kind) return;
    this.t += dt;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const R = 26, H = 18;
    const windX = Math.sin(this.t * 0.3) * 0.6 + 0.4;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3, s = this.seed[i];
      let x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      if (x === 0 && y === 0 && z === 0) {
        x = cx + (s - 0.5) * 2 * R;
        y = this.kind === 'fog' ? 0.3 + Math.random() * 3.6 : cy + Math.random() * H;
        z = cz + (this.seed[(i + 7) % this.n] - 0.5) * 2 * R;
      }
      if (this.kind === 'snow') {
        y -= dt * (0.9 + s * 0.7);
        x += dt * (windX * 0.8 + Math.sin(this.t * 1.3 + s * 9) * 0.5);
        z += dt * Math.cos(this.t * 0.9 + s * 7) * 0.4;
      } else if (this.kind === 'rain') {
        y -= dt * (13 + s * 4);
        x += dt * windX * 1.6;
      } else if (this.kind === 'fog') {
        x += dt * (0.22 + s * 0.18);
        z += dt * Math.sin(this.t * 0.21 + s * 5) * 0.16;
        y += Math.sin(this.t * 0.4 + s * 8) * dt * 0.04;
      } else {
        x += dt * (1.2 + s);
        y += Math.sin(this.t * 0.7 + s * 8) * dt * 0.25;
        z += dt * Math.sin(this.t * 0.5 + s * 5) * 0.5;
      }
      if (y < 0.05 || Math.abs(x - cx) > R || Math.abs(z - cz) > R) {
        x = cx + (s - 0.5) * 2 * R;
        y = this.kind === 'fog' ? 0.3 + Math.random() * 3.6 : cy + 4 + Math.random() * H;
        z = cz + (this.seed[(i + 13) % this.n] - 0.5) * 2 * R;
      }
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
  clear() { this.setKind(null); }
}

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.budget = 1; // quality multiplier

    // soft round sprite texture (procedural)
    const tex = makeSoftTexture();
    const smokeTex = makeSmokeTexture();

    this.sparks = new PointPool(scene, 480, { additive: true, texture: tex });
    this.smoke = new PointPool(scene, 320, { additive: false, texture: smokeTex });
    this.debris = new DebrisPool(scene, 96);
    this.decals = new DecalPool(scene);
    this.weather = new Weather(scene);

    // muzzle flash pool: sprites + one shared light
    this.flashes = [];
    const flashTex = makeFlashTexture();
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      s.visible = false;
      s.renderOrder = 12;
      scene.add(s);
      this.flashes.push({ sprite: s, life: 0 });
    }
    this.flashLight = new THREE.PointLight(0xffc98a, 0, 14, 2);
    scene.add(this.flashLight);
    this.flashLightLife = 0;

    // tracer pool
    this.tracers = [];
    const tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    for (let i = 0; i < 20; i++) {
      const line = new THREE.Line(tracerGeo.clone(), new THREE.LineBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._col = new THREE.Color();
  }

  setQuality(level, perfMode) {
    this.budget = perfMode ? 0.35 : (level === 'high' ? 1 : level === 'medium' ? 0.6 : 0.4);
  }

  // -- muzzle flash ---------------------------------------------------------
  muzzleFlash(pos, dir, withLight = true) {
    for (const f of this.flashes) {
      if (f.life <= 0) {
        f.life = 0.045 + Math.random() * 0.03;
        f.sprite.visible = true;
        f.sprite.position.copy(pos);
        const sc = 0.5 + Math.random() * 0.35;
        f.sprite.scale.set(sc, sc, sc);
        f.sprite.material.rotation = Math.random() * Math.PI * 2;
        f.sprite.material.opacity = 1;
        break;
      }
    }
    if (withLight) {
      this.flashLight.position.copy(pos).addScaledVector(dir, 0.3);
      this.flashLight.intensity = 26;
      this.flashLightLife = 0.05;
    }
  }

  // -- tracer from muzzle to impact -----------------------------------------
  tracer(from, to) {
    // shorten so it reads as a streak, not a laser
    const a = this._v1.copy(from);
    const b = this._v2.copy(to);
    const len = a.distanceTo(b);
    if (len > 2.2) a.lerp(b, 1 - Math.min(0.85, 2.2 / len));
    for (const t of this.tracers) {
      if (t.life <= 0) {
        t.life = 0.06;
        t.line.visible = true;
        t.line.material.opacity = 0.85;
        const posAttr = t.line.geometry.attributes.position;
        posAttr.setXYZ(0, a.x, a.y, a.z);
        posAttr.setXYZ(1, b.x, b.y, b.z);
        posAttr.needsUpdate = true;
        break;
      }
    }
  }

  /** Slow visible projectile (marksman rifle): small glowing streak. */
  projectileTrail(pos, dir) {
    const to = this._v1.copy(pos).addScaledVector(dir, 3.0);
    this.tracer(pos, to);
  }

  // -- surface impacts ------------------------------------------------------
  impact(point, normal, material, energy = 1) {
    const e = Math.min(1.6, energy) * this.budget;
    switch (material) {
      case 'metal': this._sparks(point, normal, 6 * e, 0xffd9a0, 5.5); this._dust(point, normal, 2 * e, 0.35, 0x8f9092); break;
      case 'glass': this.glassBurst(point, normal); break;
      case 'wood': this._dust(point, normal, 5 * e, 0.5, 0x8a6a44); this._debris(point, normal, 3 * e, 0x7a5a3a, 0.05); break;
      case 'soil':
      case 'gravel': this._dust(point, normal, 6 * e, 0.65, 0x6b5f4f); this._debris(point, normal, 3 * e, 0x5c5245, 0.04); break;
      case 'fabric': this._dust(point, normal, 3 * e, 0.4, 0x9a9a92); break;
      default: // concrete
        this._dust(point, normal, 6 * e, 0.55, 0x9d9a92);
        this._sparks(point, normal, 2 * e, 0xffe6bd, 4);
        this._debris(point, normal, 3 * e, 0x8f8c85, 0.035);
        break;
    }
  }

  _sparks(point, normal, n, color, speed) {
    n = Math.floor(n);
    this._col.setHex(color);
    for (let i = 0; i < n; i++) {
      this._v1.set(
        normal.x * speed * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * speed,
        normal.y * speed * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * speed + speed * 0.3,
        normal.z * speed * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * speed
      );
      this.sparks.spawn(point, this._v1, {
        r: this._col.r, g: this._col.g, b: this._col.b,
        size: 0.05 + Math.random() * 0.05,
        life: 0.25 + Math.random() * 0.4,
        gravity: 9, drag: 1.4,
      });
    }
  }

  _dust(point, normal, n, size, color) {
    n = Math.floor(n);
    this._col.setHex(color);
    for (let i = 0; i < n; i++) {
      this._v1.set(
        normal.x * 1.2 + (Math.random() - 0.5) * 1.6,
        normal.y * 1.2 + Math.random() * 0.9,
        normal.z * 1.2 + (Math.random() - 0.5) * 1.6
      );
      this.smoke.spawn(point, this._v1, {
        r: this._col.r, g: this._col.g, b: this._col.b,
        size: size * (0.6 + Math.random() * 0.7),
        sizeGrow: size * 1.6,
        life: 0.7 + Math.random() * 0.9,
        gravity: -0.25, drag: 2.2,
      });
    }
  }

  _debris(point, normal, n, color, size) {
    n = Math.floor(n);
    this._col.setHex(color);
    for (let i = 0; i < n; i++) {
      this._v1.set(
        normal.x * 3 + (Math.random() - 0.5) * 3,
        normal.y * 3 + Math.random() * 2.5,
        normal.z * 3 + (Math.random() - 0.5) * 3
      );
      this.debris.spawn(point, this._v1, size * (0.6 + Math.random() * 0.9), this._col, 1.6 + Math.random(), 10);
    }
  }

  glassBurst(point, normal) {
    const n = Math.floor(10 * this.budget);
    this._col.setHex(0xbfd8d8);
    for (let i = 0; i < n; i++) {
      this._v1.set(
        normal.x * 2.4 + (Math.random() - 0.5) * 3,
        normal.y * 2.4 + Math.random() * 1.5 - 0.5,
        normal.z * 2.4 + (Math.random() - 0.5) * 3
      );
      this.debris.spawn(point, this._v1, 0.05 + Math.random() * 0.07, this._col, 1.4 + Math.random(), 14);
    }
    this._sparks(point, normal, 3 * this.budget, 0xcfeaea, 2.5);
  }

  /** Soft ground dust for footsteps / landings. */
  footDust(point, material) {
    if (material === 'metal') {
      this._sparks(point, this._v2.set(0, 1, 0), 1.2 * this.budget, 0xcfd8dc, 1);
    } else {
      this._dust(point, this._v2.set(0, 1, 0), 1.4 * this.budget, 0.22, material === 'wood' ? 0x8a6a44 : 0x6f6a60);
    }
  }

  /** Sustained-fire smoke drifting from a muzzle. */
  gunSmoke(pos, dir) {
    this._v1.copy(dir).multiplyScalar(0.6);
    this._v1.x += (Math.random() - 0.5) * 0.3;
    this._v1.y += 0.35;
    this._v1.z += (Math.random() - 0.5) * 0.3;
    this.smoke.spawn(pos, this._v1, {
      r: 0.55, g: 0.55, b: 0.56,
      size: 0.06, sizeGrow: 0.4,
      life: 0.8 + Math.random() * 0.6,
      gravity: -0.3, drag: 1.6,
    });
  }

  /** Extraction / marker smoke column (green). */
  markerSmoke(pos, color = 0x5fae5f) {
    this._col.setHex(color);
    this._v1.set((Math.random() - 0.5) * 0.4, 1.4 + Math.random(), (Math.random() - 0.5) * 0.4);
    this.smoke.spawn(pos, this._v1, {
      r: this._col.r, g: this._col.g, b: this._col.b,
      size: 0.4, sizeGrow: 1.4,
      life: 2.4, gravity: -0.15, drag: 0.6, alpha: 0.55,
    });
  }

  update(dt, game) {
    if (game) this.weather.update(dt, game.camera);
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);

    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / 0.06);
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
    if (this.flashLightLife > 0) {
      this.flashLightLife -= dt;
      this.flashLight.intensity = Math.max(0, this.flashLightLife / 0.05) * 26;
    }
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.line.material.opacity = Math.max(0, t.life / 0.06) * 0.85;
        if (t.life <= 0) t.line.visible = false;
      }
    }
  }

  setWeather(kind) { this.weather.setKind(kind); }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.debris.clear();
    this.decals.clear();
    for (const f of this.flashes) { f.life = 0; f.sprite.visible = false; }
    for (const t of this.tracers) { t.life = 0; t.line.visible = false; }
    this.flashLight.intensity = 0;
  }
}

// ---------------------------------------------------------------------------
// Procedural sprite textures
// ---------------------------------------------------------------------------
function makeSoftTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function makeSmokeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  // mottle it a little so puffs don't look like perfect circles
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 26; i++) {
    const x = 8 + Math.random() * 48, y = 8 + Math.random() * 48, r = 4 + Math.random() * 10;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeFlashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.translate(64, 64);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  g.addColorStop(0, 'rgba(255,244,214,1)');
  g.addColorStop(0.25, 'rgba(255,205,120,0.75)');
  g.addColorStop(1, 'rgba(255,170,80,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
  // star spikes
  ctx.fillStyle = 'rgba(255,230,180,0.85)';
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate((i / 5) * Math.PI * 2 + Math.random());
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(48 + Math.random() * 16, 0); ctx.lineTo(0, 4);
    ctx.fill();
    ctx.restore();
  }
  return new THREE.CanvasTexture(c);
}
