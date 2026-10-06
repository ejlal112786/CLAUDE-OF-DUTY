/**
 * vehicles.js
 * Drivable vehicles for OPERATION: BLACK VECTOR — original fictional designs
 * built from primitives. Arcade-realistic physics tuned for the browser:
 * acceleration / braking / steering with speed-sensitive turn rate, friction,
 * handbrake, weight per class, suspension visuals, wheel spin, AABB collision
 * through the shared physics world, crash damage, terrain step climbing.
 *
 * Damage states: NORMAL → DAMAGED → SEVERELY DAMAGED → DISABLED with smoke,
 * sparks, dead lights and degraded performance.
 *
 * AI vehicles follow authored routes at sane speeds (no dense traffic — they
 * exist to make the world feel lived-in and to serve escort missions).
 */
import * as THREE from 'three';

export const VEHICLE_DEFS = {
  suv: {
    id: 'suv', name: 'SV-2 SCOUT', kind: 'suv',
    wd: 2.0, hl: 2.3, h: 1.85, seatH: 1.25, mass: 1450,
    power: 15000, top: 30, steer: 1.9, hp: 240,
    camDist: 7.4, camH: 2.5, wheelR: 0.42, axles: [[1.5, 0.95], [-1.5, 0.95]],
  },
  pickup: {
    id: 'pickup', name: 'GR-4 HAULER', kind: 'pickup',
    wd: 2.1, hl: 2.65, h: 1.9, seatH: 1.3, mass: 1550,
    power: 15500, top: 29, steer: 1.8, hp: 250,
    camDist: 8.0, camH: 2.6, wheelR: 0.44, axles: [[1.75, 0.98], [-1.75, 0.98]],
  },
  truck: {
    id: 'truck', name: 'UT-6 UTILITY', kind: 'truck',
    wd: 2.35, hl: 3.3, h: 2.5, seatH: 1.75, mass: 2800,
    power: 24000, top: 25, steer: 1.45, hp: 340,
    camDist: 9.2, camH: 3.1, wheelR: 0.52, axles: [[2.15, 1.05], [0.1, 1.05], [-2.15, 1.05]],
  },
  apc: {
    id: 'apc', name: 'AV-3 BULWARK', kind: 'apc',
    wd: 2.5, hl: 3.4, h: 2.55, seatH: 1.7, mass: 5400,
    power: 40000, top: 23, steer: 1.15, hp: 720,
    camDist: 9.8, camH: 3.3, wheelR: 0.58, axles: [[2.2, 1.12], [0, 1.12], [-2.2, 1.12]],
  },
  buggy: {
    id: 'buggy', name: 'TCV-9 JACKAL', kind: 'buggy',
    wd: 1.9, hl: 2.15, h: 1.55, seatH: 1.05, mass: 950,
    power: 14000, top: 36, steer: 2.3, hp: 170,
    camDist: 6.8, camH: 2.3, wheelR: 0.48, axles: [[1.4, 0.88], [-1.4, 0.88]],
  },
};

// shared palette (built once per manager)
function makeMats() {
  return {
    paint: (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.7, metalness: 0.3 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.95, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x16222b, roughness: 0.15, metalness: 0.6 }),
    head: new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffe9b0, emissiveIntensity: 1.7, roughness: 0.4 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x3a1412, emissive: 0xd0281e, emissiveIntensity: 1.2, roughness: 0.5 }),
    rust: new THREE.MeshStandardMaterial({ color: 0x6e4a34, roughness: 0.9, metalness: 0.2 }),
  };
}

/** All models face -Z at heading 0 (same convention as the player camera). */
function buildBody(def, mats, color, rnd) {
  const g = new THREE.Group();
  const paint = mats.paint(color);
  const B = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const wd = def.wd, hl = def.hl;

  if (def.kind === 'suv') {
    B(wd, 0.62, hl * 2 - 0.2, paint, 0, 0.62, 0);                 // chassis
    B(wd - 0.12, 0.62, hl * 1.05, paint, 0, 1.22, 0.28);          // cabin
    B(wd - 0.2, 0.5, hl * 0.95, mats.glass, 0, 1.26, 0.24);        // greenhouse
    B(wd + 0.1, 0.14, 0.3, mats.trim, 0, 0.42, -hl + 0.05);       // front bumper
    B(wd + 0.1, 0.14, 0.3, mats.trim, 0, 0.42, hl - 0.05);        // rear bumper
    B(0.08, 0.34, 0.5, mats.trim, -wd / 2 + 0.02, 0.55, -hl + 0.3); // bull bar hints
    B(0.08, 0.34, 0.5, mats.trim, wd / 2 - 0.02, 0.55, -hl + 0.3);
    B(wd - 0.5, 0.07, 0.9, mats.trim, 0, 1.56, 0.5);              // roof rack
    B(0.5, 0.06, 0.16, mats.head, -wd / 2 + 0.42, 0.78, -hl + 0.02);
    B(0.5, 0.06, 0.16, mats.head, wd / 2 - 0.42, 0.78, -hl + 0.02);
    B(0.44, 0.1, 0.08, mats.tail, -wd / 2 + 0.4, 0.95, hl - 0.01);
    B(0.44, 0.1, 0.08, mats.tail, wd / 2 - 0.4, 0.95, hl - 0.01);
  } else if (def.kind === 'pickup') {
    B(wd, 0.6, hl * 2 - 0.2, paint, 0, 0.6, 0);
    B(wd - 0.12, 0.66, hl * 0.8, paint, 0, 1.24, -hl * 0.42);     // cab (front)
    B(wd - 0.22, 0.5, hl * 0.7, mats.glass, 0, 1.28, -hl * 0.44);
    B(wd - 0.16, 0.5, hl * 1.0, paint, 0, 0.92, hl * 0.48);       // bed walls
    B(wd - 0.5, 0.1, hl * 0.9, mats.trim, 0, 0.72, hl * 0.48);    // bed floor
    B(wd + 0.08, 0.14, 0.28, mats.trim, 0, 0.42, -hl + 0.05);
    B(0.5, 0.06, 0.16, mats.head, -wd / 2 + 0.42, 0.78, -hl + 0.02);
    B(0.5, 0.06, 0.16, mats.head, wd / 2 - 0.42, 0.78, -hl + 0.02);
    B(0.4, 0.1, 0.08, mats.tail, -wd / 2 + 0.4, 0.95, hl - 0.01);
    B(0.4, 0.1, 0.08, mats.tail, wd / 2 - 0.4, 0.95, hl - 0.01);
  } else if (def.kind === 'truck') {
    B(wd, 0.75, hl * 2 - 0.2, paint, 0, 0.68, 0);
    B(wd - 0.1, 0.95, hl * 0.72, paint, 0, 1.5, -hl * 0.5);       // cab
    B(wd - 0.24, 0.6, hl * 0.6, mats.glass, 0, 1.62, -hl * 0.52);
    B(wd - 0.06, 1.5, hl * 1.16, mats.paint(0x59605c), 0, 1.28, hl * 0.42); // cargo box
    B(wd + 0.1, 0.16, 0.32, mats.trim, 0, 0.45, -hl + 0.05);
    B(0.55, 0.07, 0.18, mats.head, -wd / 2 + 0.45, 0.95, -hl + 0.02);
    B(0.55, 0.07, 0.18, mats.head, wd / 2 - 0.45, 0.95, -hl + 0.02);
    B(0.44, 0.12, 0.08, mats.tail, -wd / 2 + 0.45, 1.0, hl - 0.01);
    B(0.44, 0.12, 0.08, mats.tail, wd / 2 - 0.45, 1.0, hl - 0.01);
  } else if (def.kind === 'apc') {
    B(wd, 1.0, hl * 2 - 0.2, mats.paint(0x4a5245), 0, 0.78, 0);    // hull
    B(wd - 0.3, 0.5, hl * 0.7, mats.paint(0x414839), 0, 1.5, hl * 0.25); // upper hull
    B(wd - 0.55, 0.14, 0.5, mats.paint(0x363b30), 0, 1.32, -hl + 0.35);  // sloped glacis hint
    B(0.7, 0.35, 0.7, mats.trim, 0, 1.9, hl * 0.3);                // hatch cupola
    B(0.14, 0.2, 0.5, mats.trim, -wd / 2 + 0.1, 1.35, -hl * 0.55); // vision slits
    B(0.14, 0.2, 0.5, mats.trim, wd / 2 - 0.1, 1.35, -hl * 0.55);
    B(wd + 0.12, 0.2, 0.4, mats.trim, 0, 0.5, -hl + 0.08);        // ram bar
    B(0.5, 0.08, 0.14, mats.head, -wd / 2 + 0.5, 1.12, -hl + 0.03);
    B(0.5, 0.08, 0.14, mats.head, wd / 2 - 0.5, 1.12, -hl + 0.03);
    B(0.4, 0.1, 0.08, mats.tail, -wd / 2 + 0.5, 1.2, hl - 0.02);
    B(0.4, 0.1, 0.08, mats.tail, wd / 2 - 0.5, 1.2, hl - 0.02);
  } else { // buggy
    B(wd, 0.34, hl * 2 - 0.3, paint, 0, 0.55, 0);                  // floor pan
    B(wd - 0.2, 0.5, hl * 0.75, paint, 0, 0.85, hl * 0.15);        // engine bay rear
    B(0.12, 0.9, 1.5, mats.trim, -wd / 2 + 0.1, 1.0, 0);           // roll cage sides
    B(0.12, 0.9, 1.5, mats.trim, wd / 2 - 0.1, 1.0, 0);
    B(wd - 0.3, 0.1, 1.4, mats.trim, 0, 1.45, 0);                  // cage top
    B(wd - 0.5, 0.4, 0.5, mats.trim, 0, 0.95, -hl * 0.55);         // dash
    B(0.44, 0.07, 0.14, mats.head, -wd / 2 + 0.4, 0.7, -hl + 0.05);
    B(0.44, 0.07, 0.14, mats.head, wd / 2 - 0.4, 0.7, -hl + 0.05);
    B(0.36, 0.09, 0.08, mats.tail, -wd / 2 + 0.4, 0.85, hl - 0.04);
    B(0.36, 0.09, 0.08, mats.tail, wd / 2 - 0.4, 0.85, hl - 0.04);
  }

  // wheels: pivot (steer yaw) → tilt (axle along X) → spin mesh
  const wheels = [];
  const r = def.wheelR, wW = 0.3;
  const geo = new THREE.CylinderGeometry(r, r, wW, 12);
  for (let a = 0; a < def.axles.length; a++) {
    const [az, ax] = def.axles[a];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * ax, r, az);
      const tilt = new THREE.Group();
      tilt.rotation.z = Math.PI / 2;
      const mesh = new THREE.Mesh(geo, mats.rubber);
      mesh.castShadow = true;
      tilt.add(mesh);
      pivot.add(tilt);
      g.add(pivot);
      wheels.push({ pivot, spin: mesh, front: a === 0 });
    }
  }
  g.userData.wheels = wheels;
  g.userData.paintMats = [paint];
  void rnd;
  return g;
}

// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(manager, spawn) {
    this.manager = manager;
    this.game = manager.game;
    this.def = VEHICLE_DEFS[spawn.type] || VEHICLE_DEFS.suv;
    this.tag = spawn.tag || null;
    this.mission = !!spawn.mission;
    this.route = spawn.route && spawn.route.length ? spawn.route : null;
    this.routeIdx = 0;
    this.pos = spawn.pos.clone();
    this.heading = spawn.yaw || 0;
    this.speed = 0;
    this.vy = 0;
    this.hp = this.def.hp * (spawn.hpFrac != null ? spawn.hpFrac : 1);
    this.driver = spawn.ai ? 'ai' : null;
    this.firstPerson = false;
    this.steerVis = 0;
    this.pitchT = 0; this.rollT = 0; this.bobT = 0;
    this.smokeT = 0;
    this.lightsBroken = false;

    const color = spawn.color != null ? spawn.color : [0x5a6e52, 0x6a6252, 0x4a5a68, 0x71604a][Math.floor(Math.random() * 4)];
    this.model = buildBody(this.def, manager.mats, color);
    this.model.position.copy(this.pos);
    this.model.rotation.y = this.heading;
    manager.group.add(this.model);
    this.wheels = this.model.userData.wheels;
    this.headLights = [];
    this.model.traverse(o => { if (o.isMesh && o.material === manager.mats.head) this.headLights.push(o); });

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._prevSpeed = 0;
    this._syncBox();
  }

  get state() {
    const f = this.hp / this.def.hp;
    if (f <= 0) return 'disabled';
    if (f < 0.25) return 'severe';
    if (f < 0.6) return 'damaged';
    return 'normal';
  }
  get drivable() { return this.hp > 0; }

  _syncBox() {
    const c = Math.abs(Math.cos(this.heading)), s = Math.abs(Math.sin(this.heading));
    const hl = this.def.hl, wd = this.def.wd;
    const ex = (c * wd + s * hl * 2) / 2, ez = (s * wd + c * hl * 2) / 2;
    this.box.min.set(this.pos.x - ex, this.pos.y, this.pos.z - ez);
    this.box.max.set(this.pos.x + ex, this.pos.y + this.def.h, this.pos.z + ez);
  }

  damage(amount, game, point) {
    if (this.hp <= 0) return;
    this.hp -= amount;
    if (point && amount > 6) {
      game.particles.impact(point, this._tmpV.set(0, 1, 0), 'metal', Math.min(2.4, 0.6 + amount / 30));
      game.audio.impact('metal', point, Math.min(2.2, 0.5 + amount / 40));
    }
    if (this.hp < this.def.hp * 0.25 && !this.lightsBroken && Math.random() < 0.5) {
      this.lightsBroken = true;
      for (const l of this.headLights) l.visible = false;
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.speed = 0;
      game.ui.radio('VEHICLE DISABLED');
      if (this.driver === 'player') game.exitVehicle(true);
    }
  }

  update(dt, game) {
    const def = this.def;
    let throttle = 0, steerIn = 0, brake = false, boost = false;

    if (this.driver === 'player' && this.hp > 0) {
      const inp = game.input;
      const cfg = game.settings || {};
      throttle = inp.moveF;
      steerIn = -inp.moveR
        * (cfg.vehSteerInvert ? -1 : 1)
        * (cfg.vehSteerSens != null ? cfg.vehSteerSens : 1);
      brake = !!inp.spaceHeld;
      boost = !!inp.sprint;
    } else if (this.driver === 'ai' && this.hp > 0) {
      const ctrl = this._aiControl(dt);
      throttle = ctrl.t; steerIn = ctrl.s;
    }

    // ---- longitudinal ----
    const hurt = this.hp < def.hp * 0.3 ? 0.62 : 1;
    const powerAcc = (def.power / def.mass) * hurt * (boost ? 1.25 : 1);
    if (throttle > 0.05) this.speed += powerAcc * throttle * dt;
    else if (throttle < -0.05) {
      if (this.speed > 0.6) this.speed -= 15 * dt;                  // braking
      else this.speed -= powerAcc * 0.5 * dt;                       // reverse
    }
    if (brake) {
      const b = 24 * dt;
      this.speed = Math.abs(this.speed) <= b ? 0 : this.speed - Math.sign(this.speed) * b;
    }
    // drag + rolling friction
    this.speed -= this.speed * (0.12 + 0.0022 * Math.abs(this.speed)) * dt * (brake ? 2 : 1);
    if (Math.abs(this.speed) < 0.04 && throttle === 0) this.speed = 0;
    const top = def.top * (boost ? 1.12 : 1) * hurt;
    this.speed = THREE.MathUtils.clamp(this.speed, -top * 0.38, top);

    // ---- steering (speed sensitive) ----
    const spdF = Math.min(1, Math.abs(this.speed) / 5) * (1 - 0.4 * Math.min(1, Math.abs(this.speed) / def.top));
    const steerRate = def.steer * (brake ? 1.4 : 1);
    this.heading += steerIn * steerRate * spdF * (this.speed < -0.1 ? -1 : 1) * dt;
    if (this.heading > Math.PI) this.heading -= Math.PI * 2;
    if (this.heading < -Math.PI) this.heading += Math.PI * 2;

    // ---- integrate through the shared physics world ----
    this._fwd.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.vy = Math.max(this.vy - 22 * dt, -32);
    this._syncBox();
    game.physics.moveBox(this.box, this._fwd.x * this.speed * dt, this.vy * dt, this._fwd.z * this.speed * dt, this._moveOut, 0.55);
    this.pos.set((this.box.min.x + this.box.max.x) / 2, this.box.min.y, (this.box.min.z + this.box.max.z) / 2);
    if (this._moveOut.onGround) this.vy = 0;

    // ---- crash damage ----
    const impactV = Math.abs(this._prevSpeed);
    if ((this._moveOut.hitX || this._moveOut.hitZ) && impactV > 6.5) {
      const amount = (impactV - 6.5) * def.mass / 480;
      const point = this._tmpV.copy(this.pos).addScaledVector(this._fwd, def.hl).setY(this.pos.y + 0.7);
      this.damage(amount, game, point);
      this.speed *= -0.12;
      if (this.driver === 'player') game.addShake(Math.min(1, impactV / 22));
    } else if (this._moveOut.hitX || this._moveOut.hitZ) {
      this.speed *= 0.55;                                            // scraping a barrier / fence
    }
    this._prevSpeed = this.speed;

    // ---- run-over check (player driven) ----
    if (this.driver === 'player' && Math.abs(this.speed) > 8) {
      for (const e of game.enemies.list) {
        if (!e.alive) continue;
        const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
        if (dx * dx + dz * dz > 6.25) continue;
        if (Math.abs(e.pos.y - this.pos.y) > 2) continue;
        game.enemies.damage(e, 'torso', 55 + impactV * 4, this.pos.clone(), this._fwd.clone());
        this.speed *= 0.72;
      }
    }

    // ---- presentation ----
    const accel = (this.speed - this._prevSpeed) / Math.max(dt, 0.001);
    this.pitchT += (THREE.MathUtils.clamp(-accel * 0.011, -0.085, 0.085) - this.pitchT) * Math.min(1, 9 * dt);
    this.rollT += (THREE.MathUtils.clamp(-steerIn * this.speed * 0.0055, -0.11, 0.11) - this.rollT) * Math.min(1, 7 * dt);
    this.steerVis += (THREE.MathUtils.clamp(steerIn, -1, 1) * 0.42 - this.steerVis) * Math.min(1, 10 * dt);
    this.bobT += dt * (1 + Math.abs(this.speed) * 0.5);
    const bob = Math.sin(this.bobT * 7.3) * Math.min(0.03, Math.abs(this.speed) * 0.0016);
    this.model.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.model.rotation.set(this.pitchT, this.heading, this.rollT);
    const spin = this.speed / def.wheelR * dt;
    for (const w of this.wheels) {
      w.spin.rotation.y += spin;
      if (w.front) w.pivot.rotation.y = this.steerVis;
    }

    // ---- damage smoke / sparks ----
    const st = this.state;
    if (st === 'damaged' || st === 'severe' || st === 'disabled') {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.smokeT = st === 'disabled' ? 0.06 : st === 'severe' ? 0.14 : 0.3;
        const p = this._tmpV.copy(this.pos).addScaledVector(this._fwd, def.hl * 0.55).setY(this.pos.y + def.h * 0.7);
        const dark = st !== 'damaged';
        game.particles.smoke.spawn(p, game._tmpV2.set((Math.random() - 0.5) * 0.5, 1.3 + Math.random(), (Math.random() - 0.5) * 0.5), {
          r: dark ? 0.13 : 0.42, g: dark ? 0.13 : 0.42, b: dark ? 0.14 : 0.44,
          size: dark ? 0.5 : 0.34, sizeGrow: 1.5, life: 1.4 + Math.random(), gravity: -0.35, drag: 1.4,
        });
        if (st === 'severe' && Math.random() < 0.3) {
          game.particles.impact(p, game._tmpV1.set(0, 1, 0), 'metal', 0.8);
        }
      }
    }

    // ---- engine audio (player vehicle; nearby AI vehicles get a quiet positional hum) ----
    if (game.audio.ready && game.audio.engineUpdate) {
      if (this.driver === 'player') {
        game.audio.engineUpdate(Math.abs(this.speed) / def.top, throttle > 0.05, 1, null);
      } else {
        const d = this.pos.distanceTo(game.player.pos);
        if (d < 34 && Math.abs(this.speed) > 1) {
          game.audio.engineUpdate(Math.abs(this.speed) / def.top, throttle > 0.05, 0.4 * (1 - d / 34), this.pos);
        }
      }
    }
  }

  _aiControl(dt) {
    void dt;
    if (!this.route || !this.route.length) return { t: 0, s: 0 };
    const wp = this.route[this.routeIdx];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 3) {
      this.routeIdx = (this.routeIdx + 1) % this.route.length;
      return { t: 0.3, s: 0 };
    }
    const desired = Math.atan2(-dx, -dz);
    let diff = desired - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const s = THREE.MathUtils.clamp(diff * 2.4, -1, 1);
    const cruise = Math.abs(diff) > 0.55 ? 0.35 : 0.85;
    const t = this.speed > this.def.top * 0.55 ? 0 : cruise;
    return { t, s };
  }

  updateCamera(dt, game) {
    const def = this.def;
    this._fwd.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    this._right.set(-this._fwd.z, 0, this._fwd.x);
    const cam = game.camera;
    if (this.firstPerson) {
      this._camTarget.copy(this.pos)
        .addScaledVector(this._fwd, 0.1)
        .addScaledVector(this._right, def.wd * 0.24)
        .setY(this.pos.y + def.seatH);
      cam.position.lerp(this._camTarget, 1 - Math.exp(-30 * dt));
      this._tmpV.copy(cam.position).addScaledVector(this._fwd, 12).setY(cam.position.y - 0.5);
      cam.lookAt(this._tmpV);
      cam.rotation.z += this.rollT * 0.55 + this.steerVis * 0.02;
    } else {
      const camMul = (game.settings && game.settings.vehCamDist != null) ? game.settings.vehCamDist : 1;
      const dist = (def.camDist + Math.min(2.4, Math.abs(this.speed) * 0.08)) * camMul;
      const anchor = this._tmpV.copy(this.pos).setY(this.pos.y + 1.35);
      this._camTarget.copy(anchor)
        .addScaledVector(this._fwd, -dist)
        .setY(this.pos.y + def.camH)
        .addScaledVector(this._right, this.steerVis * 1.1);
      const dir = this._camTarget.clone().sub(anchor).normalize();
      const hit = game.physics.raycast(anchor, dir, dist + 0.6);
      if (hit && hit.dist < dist) {
        this._camTarget.copy(anchor).addScaledVector(dir, Math.max(1.6, hit.dist - 0.45));
      }
      cam.position.lerp(this._camTarget, 1 - Math.exp(-7 * dt));
      cam.lookAt(this.pos.x + this._fwd.x * Math.min(7, this.speed * 0.4), this.pos.y + 1.15, this.pos.z + this._fwd.z * Math.min(7, this.speed * 0.4));
    }
  }
}

// ---------------------------------------------------------------------------
export class VehicleManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);
    this.mats = makeMats();
    this._idSeq = 0;
  }

  reset() {
    for (const v of this.list) {
      this.group.remove(v.model);
      v.model.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.list.length = 0;
    this._idSeq = 0;
    const wi = this.game.world ? this.game.world.interactables : null;
    if (wi) {
      for (let i = wi.length - 1; i >= 0; i--) {
        if (wi[i].id.indexOf('veh_') === 0 || wi[i].id.indexOf('trunk_') === 0) wi.splice(i, 1);
      }
    }
  }

  spawnFromWorld() {
    const spawns = (this.game.world && this.game.world.vehicleSpawns) || [];
    for (const s of spawns) {
      const v = new Vehicle(this, s);
      v.idTag = 'v' + (this._idSeq++);
      this.list.push(v);
      this.game.world.interactables.push({
        id: 'veh_' + v.idTag,
        pos: v.pos.clone().setY(v.pos.y + 1.1),
        radius: 3.4,
        prompt: 'ENTER VEHICLE',
        getPrompt: () => {
          if (!v.drivable) return 'WRECKED — UNDRIVABLE';
          if (v.driver === 'ai' && Math.abs(v.speed) > 2.5) return 'MOVING — CANNOT BOARD';
          return 'ENTER ' + v.def.name;
        },
        hold: 0.45,
        used: false,
        reusable: true,
        vehicle: v,
        action: (game) => {
          if (!v.drivable) { game.ui.toastBrief('THE VEHICLE IS WRECKED'); return false; }
          if (v.driver === 'ai' && Math.abs(v.speed) > 2.5) return false;
          game.enterVehicle(v);
          return false; // never mark used — vehicles are re-enterable
        },
        reset: function () { this.used = false; },
      });
      // storage compartment in the rear of cargo-capable vehicles (one-time loot)
      if (v.def.kind === 'suv' || v.def.kind === 'pickup' || v.def.kind === 'truck') {
        this.game.world.interactables.push({
          id: 'trunk_' + v.idTag,
          pos: v.pos.clone().setY(v.pos.y + 0.9),
          radius: 2.2,
          prompt: 'SEARCH VEHICLE STORAGE',
          hold: 0.7,
          used: false,
          reusable: false,
          vehicle: v,
          trunk: true,
          reset: function () { this.used = false; },
          action: (game) => {
            const roll = Math.random();
            const w = game.weapons.def, st = game.weapons.state[w.id];
            const addAmmo = () => { const add = w.magSize * 2; st.reserve = Math.min(w.reserveMax, st.reserve + add); return 'SPARE ' + w.name + ' AMMO +' + add; };
            let msg;
            if (roll < 0.28) msg = 'STORAGE IS EMPTY';
            else if (roll < 0.6) msg = addAmmo();
            else if (roll < 0.8) msg = game.throwables.addOne('vxfrag') ? 'VX-FRAG ×1' : addAmmo();
            else msg = game.throwables.addOne('medkit') ? 'FIELD MEDKIT ×1' : addAmmo();
            game.audio.pickup(v.pos);
            game.ui.toastBrief(msg);
            return true;
          },
        });
      }
    }
  }

  byTag(tag) { return this.list.find(v => v.tag === tag) || null; }
  byId(interactId) {
    const it = this.game.world.interactables.find(i => i.id === interactId);
    return it && it.vehicle ? it.vehicle : null;
  }

  update(dt) {
    const g = this.game;
    for (const v of this.list) v.update(dt, g);
    // sync interactable positions + prompts (vehicles move!)
    for (const it of g.world.interactables) {
      if (!it.vehicle) continue;
      const v = it.vehicle;
      if (it.trunk) {
        // rear of the vehicle
        it.pos.set(v.pos.x + Math.sin(v.heading) * v.def.hl, v.pos.y + 0.9, v.pos.z + Math.cos(v.heading) * v.def.hl);
      } else if (it.id.indexOf('veh_') === 0) {
        it.pos.copy(v.pos).setY(v.pos.y + 1.1);
      }
    }
  }
}
