/**
 * weapons.js
 * Original fictional weapons with independent handling characteristics and a
 * proper shot simulation pipeline:
 *
 *   input → weapon state → firing state → hitscan / projectile simulation
 *         → collision (world + entities) → material interaction → damage
 *
 *  VX-4  — 5.56-class assault rifle, full-auto, hitscan with tracer
 *  MR-7  — marksman rifle, semi-auto, simulated projectile travel + drop
 *  P9    — compact sidearm, semi-auto, hitscan
 *
 * View models are built from primitives, rendered without depth test so they
 * never clip into walls, and animated procedurally (idle breathing, sway,
 * bob, recoil springs, reload keyframes, ADS transitions).
 * Weapon behaviour here is stylised game simulation, not a model of any
 * real-world firearm.
 */
import * as THREE from 'three';
import { rayAABBLocal } from './physics.js';

const DEG = Math.PI / 180;

export const WEAPON_DEFS = {
  vx4: {
    id: 'vx4', slot: 1, name: 'VX-4', klass: 'ASSAULT RIFLE',
    auto: true, rpm: 660,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 26,
    zoneMult: { head: 3.2, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 35, far: 110, min: 0.55 },
    projectile: false,
    spread: { hip: 1.15 * DEG, hipMove: 2.6 * DEG, ads: 0.09 * DEG, adsMove: 0.5 * DEG, bloomPerShot: 0.16 * DEG, bloomMax: 1.7 * DEG, bloomRecover: 2.6 * DEG },
    recoil: { pitch: 0.62 * DEG, yaw: 0.24 * DEG, kickZ: 0.055, kickPitch: 3.2 * DEG, recover: 9 },
    adsTime: 0.26, adsFov: 55, sightY: 0.055,
    reload: { tactical: 2.3, dry: 3.0 },
    noiseRadius: 55,
    sound: 'vx4',
    handling: 1.0, // how much movement slows while equipped
    weight: 5.0,
  },
  mr7: {
    id: 'mr7', slot: 2, name: 'MR-7', klass: 'MARKSMAN RIFLE',
    auto: false, rpm: 150, // mechanical cyclic limit; semi delay below
    semiDelay: 0.5,
    magSize: 10, startReserve: 40, reserveMax: 60,
    damage: 78,
    zoneMult: { head: 2.6, torso: 1.0, arms: 0.8, legs: 0.7 },
    falloff: { near: 90, far: 300, min: 0.7 },
    projectile: true, projSpeed: 260, projGravity: 9.81, projLife: 2.2,
    spread: { hip: 2.2 * DEG, hipMove: 4.0 * DEG, ads: 0.015 * DEG, adsMove: 0.25 * DEG, bloomPerShot: 0.9 * DEG, bloomMax: 3 * DEG, bloomRecover: 1.6 * DEG },
    recoil: { pitch: 2.1 * DEG, yaw: 0.5 * DEG, kickZ: 0.13, kickPitch: 9 * DEG, recover: 4.5 },
    adsTime: 0.42, adsFov: 34, sightY: 0.075,
    reload: { tactical: 3.1, dry: 3.8 },
    noiseRadius: 85,
    sound: 'mr7',
    handling: 0.82,
    weight: 6.0,
    shake: 0.1,
  },
  p9: {
    id: 'p9', slot: 3, name: 'PX-9', klass: 'SIDEARM',
    auto: false, rpm: 400,
    semiDelay: 0.13,
    magSize: 15, startReserve: 60, reserveMax: 105,
    damage: 24,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.75, legs: 0.65 },
    falloff: { near: 18, far: 60, min: 0.5 },
    projectile: false,
    spread: { hip: 1.3 * DEG, hipMove: 2.8 * DEG, ads: 0.16 * DEG, adsMove: 0.7 * DEG, bloomPerShot: 0.3 * DEG, bloomMax: 2.2 * DEG, bloomRecover: 3.4 * DEG },
    recoil: { pitch: 0.95 * DEG, yaw: 0.4 * DEG, kickZ: 0.07, kickPitch: 5.5 * DEG, recover: 11 },
    adsTime: 0.17, adsFov: 62, sightY: 0.048,
    reload: { tactical: 1.7, dry: 2.2 },
    noiseRadius: 34,
    sound: 'p9',
    handling: 1.15,
    weight: 1.5,
  },

  // ---- C3 arsenal: fictional designs, gameplay-first identities ----
  st12: {
    id: 'st12', slot: 3, name: 'ST-12', klass: 'SIDEARM',
    auto: false, rpm: 380, semiDelay: 0.17,
    magSize: 12, startReserve: 48, reserveMax: 84,
    damage: 34,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.75, legs: 0.65 },
    falloff: { near: 20, far: 65, min: 0.5 },
    projectile: false,
    spread: { hip: 1.4 * DEG, hipMove: 3.0 * DEG, ads: 0.14 * DEG, adsMove: 0.65 * DEG, bloomPerShot: 0.42 * DEG, bloomMax: 2.6 * DEG, bloomRecover: 3.0 * DEG },
    recoil: { pitch: 1.35 * DEG, yaw: 0.5 * DEG, kickZ: 0.085, kickPitch: 7 * DEG, recover: 9.5 },
    adsTime: 0.19, adsFov: 62, sightY: 0.048,
    reload: { tactical: 1.9, dry: 2.5 },
    noiseRadius: 38,
    sound: 'st12',
    handling: 1.1,
    weight: 1.8,
    vmTint: 0x3a3f45,
  },
  vekp: {
    id: 'vekp', slot: 3, name: 'VEKTOR P', klass: 'SIDEARM',
    auto: true, rpm: 950,
    magSize: 18, startReserve: 90, reserveMax: 144,
    damage: 15,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.72, legs: 0.6 },
    falloff: { near: 14, far: 45, min: 0.42 },
    projectile: false,
    spread: { hip: 2.2 * DEG, hipMove: 3.8 * DEG, ads: 0.34 * DEG, adsMove: 1.1 * DEG, bloomPerShot: 0.34 * DEG, bloomMax: 3.4 * DEG, bloomRecover: 4.2 * DEG },
    recoil: { pitch: 0.5 * DEG, yaw: 0.32 * DEG, kickZ: 0.045, kickPitch: 3.4 * DEG, recover: 13 },
    adsTime: 0.16, adsFov: 64, sightY: 0.046,
    reload: { tactical: 1.8, dry: 2.4 },
    noiseRadius: 32,
    sound: 'vekp',
    handling: 1.3,
    weight: 1.6,
    vmTint: 0x2c2f34,
  },
  vx12: {
    id: 'vx12', slot: 1, name: 'VX-12 BREACHER', klass: 'SHOTGUN',
    auto: false, rpm: 70, semiDelay: 0.85,
    magSize: 6, startReserve: 24, reserveMax: 42,
    damage: 13, pellets: 8, pelletRange: 55,
    zoneMult: { head: 2.4, torso: 1.0, arms: 0.8, legs: 0.7 },
    falloff: { near: 9, far: 30, min: 0.12 },
    projectile: false,
    spread: { hip: 3.4 * DEG, hipMove: 4.4 * DEG, ads: 1.7 * DEG, adsMove: 2.4 * DEG, bloomPerShot: 1.4 * DEG, bloomMax: 4 * DEG, bloomRecover: 2.2 * DEG },
    recoil: { pitch: 3.1 * DEG, yaw: 0.7 * DEG, kickZ: 0.19, kickPitch: 12 * DEG, recover: 4 },
    adsTime: 0.34, adsFov: 56, sightY: 0.062,
    reload: { tactical: 4.4, dry: 5.2 },
    noiseRadius: 62,
    sound: 'vx12',
    handling: 0.9,
    weight: 6.5,
    shake: 0.12,
    vmTint: 0x33302a,
  },
  mpx5: {
    id: 'mpx5', slot: 1, name: 'MPX-5', klass: 'SMG',
    auto: true, rpm: 850,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 19,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.72, legs: 0.6 },
    falloff: { near: 22, far: 70, min: 0.45 },
    projectile: false,
    spread: { hip: 1.5 * DEG, hipMove: 2.7 * DEG, ads: 0.22 * DEG, adsMove: 0.85 * DEG, bloomPerShot: 0.15 * DEG, bloomMax: 1.9 * DEG, bloomRecover: 3.0 * DEG },
    recoil: { pitch: 0.45 * DEG, yaw: 0.26 * DEG, kickZ: 0.042, kickPitch: 2.9 * DEG, recover: 12 },
    adsTime: 0.19, adsFov: 60, sightY: 0.052,
    reload: { tactical: 1.9, dry: 2.5 },
    noiseRadius: 42,
    sound: 'mpx5',
    handling: 1.25,
    weight: 3.5,
    vmTint: 0x26292e,
  },
  cr9: {
    id: 'cr9', slot: 1, name: 'CR-9', klass: 'SMG',
    auto: true, rpm: 700,
    magSize: 25, startReserve: 125, reserveMax: 175,
    damage: 23,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 26, far: 80, min: 0.5 },
    projectile: false,
    spread: { hip: 1.2 * DEG, hipMove: 2.3 * DEG, ads: 0.11 * DEG, adsMove: 0.6 * DEG, bloomPerShot: 0.11 * DEG, bloomMax: 1.4 * DEG, bloomRecover: 3.2 * DEG },
    recoil: { pitch: 0.38 * DEG, yaw: 0.16 * DEG, kickZ: 0.038, kickPitch: 2.4 * DEG, recover: 13 },
    adsTime: 0.23, adsFov: 58, sightY: 0.052,
    reload: { tactical: 2.1, dry: 2.7 },
    noiseRadius: 44,
    sound: 'cr9',
    handling: 1.1,
    weight: 4.0,
    vmTint: 0x2e3238,
  },
  rk4: {
    id: 'rk4', slot: 1, name: 'RK-4 LANCER', klass: 'ASSAULT RIFLE',
    auto: true, rpm: 520,
    magSize: 25, startReserve: 125, reserveMax: 175,
    damage: 34,
    zoneMult: { head: 3.1, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 40, far: 120, min: 0.6 },
    projectile: false,
    spread: { hip: 1.3 * DEG, hipMove: 2.8 * DEG, ads: 0.1 * DEG, adsMove: 0.55 * DEG, bloomPerShot: 0.2 * DEG, bloomMax: 2.1 * DEG, bloomRecover: 2.3 * DEG },
    recoil: { pitch: 0.85 * DEG, yaw: 0.34 * DEG, kickZ: 0.075, kickPitch: 4.4 * DEG, recover: 7.5 },
    adsTime: 0.3, adsFov: 52, sightY: 0.058,
    reload: { tactical: 2.6, dry: 3.3 },
    noiseRadius: 62,
    sound: 'rk4',
    handling: 0.85,
    weight: 5.5,
    shake: 0.06,
    vmTint: 0x3c3a33,
  },
  sz8: {
    id: 'sz8', slot: 1, name: 'SZ-8 WASP', klass: 'ASSAULT RIFLE',
    auto: true, rpm: 780,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 21,
    zoneMult: { head: 3.1, torso: 1.0, arms: 0.72, legs: 0.6 },
    falloff: { near: 28, far: 90, min: 0.5 },
    projectile: false,
    spread: { hip: 1.35 * DEG, hipMove: 2.5 * DEG, ads: 0.13 * DEG, adsMove: 0.7 * DEG, bloomPerShot: 0.13 * DEG, bloomMax: 1.6 * DEG, bloomRecover: 2.8 * DEG },
    recoil: { pitch: 0.5 * DEG, yaw: 0.22 * DEG, kickZ: 0.048, kickPitch: 3 * DEG, recover: 11 },
    adsTime: 0.21, adsFov: 58, sightY: 0.054,
    reload: { tactical: 2.2, dry: 2.8 },
    noiseRadius: 50,
    sound: 'sz8',
    handling: 1.2,
    weight: 4.0,
    vmTint: 0x28302c,
  },
  lb9: {
    id: 'lb9', slot: 1, name: 'LB-9 LONGBOW', klass: 'PRECISION RIFLE',
    auto: false, rpm: 52, semiDelay: 1.15,
    magSize: 5, startReserve: 20, reserveMax: 35,
    damage: 115,
    zoneMult: { head: 2.8, torso: 1.0, arms: 0.85, legs: 0.75 },
    falloff: { near: 120, far: 400, min: 0.75 },
    projectile: true, projSpeed: 420, projGravity: 9.81, projLife: 2.6,
    spread: { hip: 3.2 * DEG, hipMove: 5.5 * DEG, ads: 0.008 * DEG, adsMove: 0.35 * DEG, bloomPerShot: 1.6 * DEG, bloomMax: 5 * DEG, bloomRecover: 1.1 * DEG },
    recoil: { pitch: 3.4 * DEG, yaw: 0.8 * DEG, kickZ: 0.22, kickPitch: 14 * DEG, recover: 3 },
    adsTime: 0.55, adsFov: 20, sightY: 0.082,
    reload: { tactical: 3.6, dry: 4.4 },
    noiseRadius: 110,
    sound: 'lb9',
    handling: 0.7,
    weight: 7.5,
    shake: 0.16,
    vmTint: 0x33382f,
  },
};
export const WEAPON_ORDER = ['vx4', 'mr7', 'p9', 'st12', 'vekp', 'vx12', 'mpx5', 'cr9', 'rk4', 'sz8', 'lb9'];

// ---------------------------------------------------------------------------
// View model construction (all original shapes — no real weapon replicas)
// ---------------------------------------------------------------------------
function gunMetal(color = 0x23262a, rough = 0.42) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.72, depthTest: false });
  return m;
}
function polymer(color = 0x2c3129) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, depthTest: false });
}
function accent(color = 0x4a4f42) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, depthTest: false });
}

class ViewModelBuilder {
  /** Every mesh material must render on top (depthTest false) and share renderOrder. */
  static finalize(group) {
    group.traverse(o => {
      if (o.isMesh) {
        o.renderOrder = 999;
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    return group;
  }

  static box(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  }
  static cyl(parent, rt, rb, h, seg, mat, x, y, z, rx = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    parent.add(m);
    return m;
  }

  /** Class-shaped generic viewmodel for the expanded arsenal (C3). */
  static generic(def) {
    const g = new THREE.Group();
    const steel = gunMetal(def.vmTint || 0x26292e);
    const dark = gunMetal(0x17191c, 0.5);
    const poly = polymer(0x31362c);
    const k = def.klass;
    const muzzle = new THREE.Object3D();
    const port = new THREE.Object3D();
    if (k === 'SIDEARM') {
      this.box(g, 0.05, 0.062, 0.24, steel, 0, 0.012, -0.09);            // slide
      this.box(g, 0.042, 0.03, 0.2, dark, 0, -0.02, -0.08);               // frame
      this.box(g, 0.044, 0.11, 0.052, poly, 0, -0.075, 0.015, 0.32);      // grip
      this.cyl(g, 0.009, 0.009, 0.06, 8, dark, 0, 0.012, -0.23, Math.PI / 2);
      muzzle.position.set(0, 0.012, -0.25);
      port.position.set(0.035, 0.03, -0.06);
    } else if (k === 'SHOTGUN') {
      this.box(g, 0.062, 0.078, 0.3, steel, 0, 0, -0.1);                  // receiver
      this.cyl(g, 0.017, 0.017, 0.56, 8, dark, 0, 0.016, -0.46, Math.PI / 2); // barrel
      this.cyl(g, 0.012, 0.012, 0.44, 8, dark, 0, -0.018, -0.4, Math.PI / 2); // tube
      this.box(g, 0.066, 0.05, 0.13, poly, 0, -0.016, -0.36);             // pump
      this.box(g, 0.055, 0.07, 0.24, poly, 0, -0.02, 0.16, -0.12);        // stock
      this.box(g, 0.045, 0.09, 0.05, poly, 0, -0.07, 0.0, 0.3);           // grip
      muzzle.position.set(0, 0.016, -0.75);
      port.position.set(0.045, 0.03, -0.14);
    } else if (k === 'SMG') {
      this.box(g, 0.055, 0.075, 0.26, steel, 0, 0, -0.09);
      this.cyl(g, 0.011, 0.011, 0.2, 8, dark, 0, 0.012, -0.3, Math.PI / 2);
      this.box(g, 0.05, 0.055, 0.14, poly, 0, -0.005, -0.26);             // short handguard
      g.userData.mag = this.box(g, 0.04, 0.12, 0.05, poly, 0, -0.085, -0.05, 0.16); // mag
      this.box(g, 0.044, 0.085, 0.048, poly, 0, -0.062, 0.02, 0.3);       // grip
      this.box(g, 0.03, 0.05, 0.16, dark, 0, -0.01, 0.12);                // folded stock
      muzzle.position.set(0, 0.012, -0.41);
      port.position.set(0.04, 0.028, -0.08);
    } else if (k === 'PRECISION RIFLE' || k === 'MARKSMAN RIFLE') {
      this.box(g, 0.06, 0.08, 0.38, steel, 0, 0, -0.12);
      this.cyl(g, 0.012, 0.014, 0.64, 8, dark, 0, 0.014, -0.56, Math.PI / 2);
      this.cyl(g, 0.021, 0.021, 0.17, 10, gunMetal(0x14161a), 0, 0.072, -0.16, Math.PI / 2); // scope
      this.box(g, 0.02, 0.03, 0.03, dark, 0, 0.045, -0.1);                // scope mount
      this.box(g, 0.02, 0.03, 0.03, dark, 0, 0.045, -0.22);
      g.userData.mag = this.box(g, 0.042, 0.1, 0.05, poly, 0, -0.075, -0.02, 0.26); // mag
      this.box(g, 0.055, 0.075, 0.28, poly, 0, -0.018, 0.18, -0.1);       // stock
      this.box(g, 0.046, 0.09, 0.05, poly, 0, -0.068, 0.03, 0.3);         // grip
      this.box(g, 0.02, 0.055, 0.02, dark, 0, 0.06, 0.06);                // bipod hint folded
      muzzle.position.set(0, 0.014, -0.9);
      port.position.set(0.045, 0.03, -0.16);
    } else { // ASSAULT RIFLE
      this.box(g, 0.06, 0.082, 0.33, steel, 0, 0, -0.1);
      this.cyl(g, 0.011, 0.011, 0.36, 8, dark, 0, 0.012, -0.45, Math.PI / 2);
      this.box(g, 0.056, 0.06, 0.23, poly, 0, 0.002, -0.34);
      for (let i = 0; i < 3; i++) this.box(g, 0.06, 0.01, 0.024, dark, 0, 0.02, -0.27 - i * 0.06);
      this.cyl(g, 0.014, 0.014, 0.05, 8, dark, 0, 0.012, -0.63, Math.PI / 2);
      g.userData.mag = this.box(g, 0.042, 0.12, 0.055, poly, 0, -0.09, -0.04, 0.2); // mag
      this.box(g, 0.046, 0.09, 0.05, poly, 0, -0.07, 0.03, 0.32);        // grip
      this.box(g, 0.05, 0.065, 0.2, poly, 0, -0.008, 0.17, -0.08);       // stock
      muzzle.position.set(0, 0.012, -0.66);
      port.position.set(0.045, 0.03, -0.13);
    }
    g.userData.muzzle = muzzle;
    g.userData.port = port;
    g.add(muzzle); g.add(port);
    return this.finalize(g);
  }

  static vx4() {
    const g = new THREE.Group();
    const steel = gunMetal(0x23262a);
    const dark = gunMetal(0x17191c, 0.5);
    const poly = polymer(0x31362c);
    const tan = accent(0x5c5a44);

    // receiver
    this.box(g, 0.062, 0.085, 0.34, steel, 0, 0, -0.10);
    // barrel + gas tube
    this.cyl(g, 0.011, 0.011, 0.34, 8, dark, 0, 0.012, -0.44, Math.PI / 2);
    this.cyl(g, 0.016, 0.016, 0.2, 8, steel, 0, 0.028, -0.36, Math.PI / 2);
    // handguard with slots
    this.box(g, 0.058, 0.062, 0.24, poly, 0, 0.002, -0.34);
    for (let i = 0; i < 4; i++) {
      this.box(g, 0.062, 0.01, 0.026, dark, 0, 0.02, -0.26 - i * 0.055);
    }
    // muzzle brake
    this.cyl(g, 0.015, 0.015, 0.05, 8, dark, 0, 0.012, -0.625, Math.PI / 2);
    // magazine (slight curve via two segments)
    const mag = new THREE.Group();
    this.box(mag, 0.04, 0.13, 0.075, poly, 0, -0.075, 0);
    this.box(mag, 0.04, 0.07, 0.075, poly, 0, -0.16, 0.022, 0.35);
    mag.position.set(0, -0.04, -0.12);
    g.add(mag);
    // pistol grip + trigger guard
    this.box(g, 0.04, 0.11, 0.055, poly, 0, -0.085, 0.02, 0.28);
    this.box(g, 0.02, 0.012, 0.07, dark, 0, -0.045, -0.02);
    // stock + buffer tube
    this.cyl(g, 0.016, 0.016, 0.12, 8, dark, 0, 0.005, 0.12, Math.PI / 2);
    this.box(g, 0.045, 0.09, 0.14, poly, 0, -0.005, 0.17);
    this.box(g, 0.05, 0.11, 0.03, tan, 0, -0.005, 0.245);
    // rail + iron sights (front post, rear aperture)
    this.box(g, 0.03, 0.012, 0.3, dark, 0, 0.048, -0.2);
    this.box(g, 0.014, 0.03, 0.014, dark, 0, 0.062, -0.42);       // front post
    this.box(g, 0.03, 0.024, 0.02, dark, 0, 0.06, 0.02);           // rear base
    this.box(g, 0.008, 0.008, 0.016, tan, 0, 0.068, 0.02);         // rear aperture dot
    // selector / pins
    this.cyl(g, 0.006, 0.006, 0.07, 6, tan, 0, -0.01, 0.05, 0, Math.PI / 2);
    // gloved hands
    this.box(g, 0.075, 0.075, 0.11, polymer(0x26292b), 0.005, -0.05, 0.03, 0.1);   // firing hand
    this.box(g, 0.07, 0.07, 0.1, polymer(0x26292b), -0.012, -0.035, -0.3, 0, 0.2);  // support hand

    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, -0.66); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.04, 0.02, -0.06); g.add(port);
    g.userData = { mag, muzzle, port };
    return this.finalize(g);
  }

  static mr7() {
    const g = new THREE.Group();
    const steel = gunMetal(0x1e2124, 0.36);
    const dark = gunMetal(0x14161a, 0.5);
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.7, metalness: 0.05, depthTest: false });
    const tan = accent(0x6a6450);

    // long heavy barrel
    this.cyl(g, 0.013, 0.016, 0.62, 10, steel, 0, 0.01, -0.52, Math.PI / 2);
    this.cyl(g, 0.02, 0.02, 0.06, 10, dark, 0, 0.01, -0.85, Math.PI / 2); // brake
    // receiver
    this.box(g, 0.066, 0.08, 0.3, steel, 0, 0.005, -0.12);
    // scope: tube + objectives + turrets
    this.cyl(g, 0.021, 0.021, 0.3, 12, dark, 0, 0.075, -0.16, Math.PI / 2);
    this.cyl(g, 0.028, 0.024, 0.05, 12, dark, 0, 0.075, -0.32, Math.PI / 2);
    this.cyl(g, 0.026, 0.026, 0.03, 12, dark, 0, 0.075, -0.015, Math.PI / 2);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 12),
      new THREE.MeshStandardMaterial({ color: 0x16212e, emissive: 0x22384e, emissiveIntensity: 0.7, roughness: 0.1, metalness: 0.4, depthTest: false }));
    lens.position.set(0, 0.075, -0.344); lens.rotation.y = Math.PI;
    g.add(lens);
    this.cyl(g, 0.012, 0.012, 0.03, 8, tan, 0.03, 0.075, -0.16, 0, Math.PI / 2); // windage
    this.cyl(g, 0.012, 0.012, 0.03, 8, tan, 0, 0.105, -0.14);                    // elevation
    // scope mounts
    this.box(g, 0.03, 0.03, 0.04, dark, 0, 0.045, -0.24);
    this.box(g, 0.03, 0.03, 0.04, dark, 0, 0.045, -0.08);
    // iron sights (backup, low)
    this.box(g, 0.01, 0.018, 0.01, tan, 0, 0.05, -0.44);
    // stock (wooden, thumbhole vibe)
    this.box(g, 0.05, 0.085, 0.26, wood, 0, -0.01, 0.14);
    this.box(g, 0.05, 0.1, 0.05, wood, 0, -0.03, 0.03);
    this.box(g, 0.052, 0.12, 0.03, dark, 0, -0.01, 0.275); // buttpad
    // grip
    this.box(g, 0.04, 0.11, 0.05, wood, 0, -0.085, 0.02, 0.2);
    // magazine
    const mag = new THREE.Group();
    this.box(mag, 0.038, 0.1, 0.07, steel, 0, -0.06, 0);
    mag.position.set(0, -0.035, -0.14);
    g.add(mag);
    // bipod (folded)
    this.cyl(g, 0.007, 0.007, 0.09, 6, dark, -0.02, -0.035, -0.4, 0.5, 0.2);
    this.cyl(g, 0.007, 0.007, 0.09, 6, dark, 0.02, -0.035, -0.4, 0.5, -0.2);
    // hands
    this.box(g, 0.075, 0.075, 0.11, polymer(0x26292b), 0.005, -0.06, 0.02, 0.1);
    this.box(g, 0.07, 0.07, 0.1, polymer(0x26292b), -0.01, -0.045, -0.26);

    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.01, -0.9); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.04, 0.02, -0.08); g.add(port);
    g.userData = { mag, muzzle, port };
    return this.finalize(g);
  }

  static p9() {
    const g = new THREE.Group();
    const steel = gunMetal(0x202327, 0.38);
    const poly = polymer(0x2a2d28);
    const tan = accent(0x5c5a44);

    // slide
    this.box(g, 0.045, 0.05, 0.21, steel, 0, 0.028, -0.09);
    // serrations
    for (let i = 0; i < 4; i++) this.box(g, 0.047, 0.008, 0.008, poly, 0, 0.042, -0.02 - i * 0.014);
    // frame + grip
    this.box(g, 0.042, 0.035, 0.16, poly, 0, -0.005, -0.06);
    this.box(g, 0.042, 0.12, 0.055, poly, 0, -0.075, 0.015, 0.22);
    // trigger guard
    this.box(g, 0.012, 0.01, 0.05, poly, 0, -0.035, -0.035);
    this.box(g, 0.012, 0.035, 0.01, poly, 0, -0.02, -0.058);
    // barrel tip
    this.cyl(g, 0.009, 0.009, 0.02, 8, steel, 0, 0.015, -0.2, Math.PI / 2);
    // sights
    this.box(g, 0.008, 0.012, 0.008, tan, 0, 0.06, -0.185);
    this.box(g, 0.03, 0.012, 0.01, tan, 0, 0.06, -0.005);
    // magazine
    const mag = new THREE.Group();
    this.box(mag, 0.032, 0.1, 0.045, steel, 0, -0.06, 0);
    mag.position.set(0, -0.03, 0.01);
    mag.rotation.x = 0.22;
    g.add(mag);
    // hand
    this.box(g, 0.07, 0.08, 0.1, polymer(0x26292b), 0.004, -0.07, 0.02, 0.15);

    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.015, -0.22); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.035, 0.03, -0.05); g.add(port);
    g.userData = { mag, muzzle, port };
    return this.finalize(g);
  }
}

// ---------------------------------------------------------------------------
// Projectile (marksman rifle)
// ---------------------------------------------------------------------------
class Projectile {
  constructor(def, origin, dir, game) {
    this.def = def;
    this.game = game;
    this.pos = origin.clone();
    this.vel = dir.clone().multiplyScalar(def.projSpeed);
    this.life = def.projLife;
    this.dead = false;
    this._last = new THREE.Vector3();
  }

  update(dt) {
    const g = this.game;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    this.vel.y -= this.def.projGravity * dt;
    this._last.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);

    const seg = _seg.copy(this.pos).sub(this._last);
    const segLen = seg.length();
    if (segLen < 0.0001) return;
    seg.divideScalar(segLen);

    // entities along the segment
    let bestT = segLen, bestHit = null, bestZone = null, bestEnemy = null;

    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      const d = rayAABBLocal(this._last, seg, e.box.min, e.box.max, bestT, _local);
      if (d !== null) {
        bestT = d; bestEnemy = e; bestHit = null;
        bestZone = zoneFromLocal(_local, e);
      }
    }
    for (const t of g.world.rangeTargets) {
      const hit = t.rayTest(this._last, seg, bestT);
      if (hit) { bestT = hit.dist; bestHit = { target: t, zone: hit.zone }; bestEnemy = null; }
    }

    const worldHit = g.physics.raycast(this._last, seg, bestT);
    if (worldHit) {
      bestT = worldHit.dist; bestEnemy = null; bestHit = worldHit;
    }

    if (bestEnemy) {
      const point = _p1.copy(this._last).addScaledVector(seg, bestT);
      g.stats.hits++;
      if (bestZone === 'head') g.stats.headshots++;
      g.enemies.damage(bestEnemy, bestZone, this._damageAt(point.distanceTo(g.camera.position)), point, seg);
      this.dead = true;
    } else if (bestHit && bestHit.target) {
      bestHit.target.hit();
      g.audio.wpnClick(1800, 0.4);
      g.particles.impact(_p1.copy(this._last).addScaledVector(seg, bestT), _n1.set(0, 0, 1), 'metal', 0.5);
      this.dead = true;
    } else if (bestHit && bestHit.collider) {
      const point = bestHit.point;
      const c = bestHit.collider;
      if (c.breakable) {
        g.world.breakGlass(c);
        g.particles.glassBurst(point, bestHit.normal);
        // projectile punches through broken glass (slight velocity loss)
        this.pos.copy(point).addScaledVector(seg, 0.05);
        this.vel.multiplyScalar(0.92);
        if (this.life > 0.05) return;
      }
      g.onWorldImpact(point, bestHit.normal, c.material, 1.4);
      this.dead = true;
    }

    // tracer streak for the projectile itself
    g.particles.projectileTrail(this.pos, _n2.copy(this.vel).normalize());
  }

  _damageAt(dist) {
    const f = this.def.falloff;
    const k = dist <= f.near ? 1 : Math.max(f.min, 1 - (dist - f.near) / (f.far - f.near) * (1 - f.min));
    return this.def.damage * k;
  }
}

const _seg = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _oc = new THREE.Vector3();
const _local = { x: 0, y: 0, z: 0, dist: 0 };

/** Derive the hit zone from local hit coordinates relative to an enemy box. */
function zoneFromLocal(local, enemy) {
  const h = local.y; // height above feet
  const total = enemy.box.max.y - enemy.box.min.y;
  const rel = h / total;
  // lateral offset decides arms vs torso on the upper body
  const cx = (enemy.box.min.x + enemy.box.max.x) / 2;
  const cz = (enemy.box.min.z + enemy.box.max.z) / 2;
  const lateral = Math.max(Math.abs(local.x - cx), Math.abs(local.z - cz));
  if (rel > 0.84) return 'head';
  if (rel > 0.55) return lateral > 0.34 ? 'arms' : 'torso';
  if (rel > 0.42) return lateral > 0.3 ? 'arms' : 'torso';
  return 'legs';
}

// ---------------------------------------------------------------------------
// WeaponSystem
// ---------------------------------------------------------------------------
export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.defs = WEAPON_DEFS;

    // per-weapon runtime state
    this.state = {};
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      this.state[id] = {
        mag: def.magSize,
        reserve: def.startReserve,
        bloom: 0,
        heat: 0,
        malf: false,
        shotIdx: 0,
      };
    }

    // view model rig (attached to the camera)
    this.rig = new THREE.Group();
    this.models = {};
    const CUSTOM = { vx4: () => ViewModelBuilder.vx4(), mr7: () => ViewModelBuilder.mr7(), p9: () => ViewModelBuilder.p9() };
    for (const id of WEAPON_ORDER) {
      this.models[id] = CUSTOM[id] ? CUSTOM[id]() : ViewModelBuilder.generic(WEAPON_DEFS[id]);
    }
    for (const m of Object.values(this.models)) {
      m.visible = false;
      this.rig.add(m);
    }
    this.owned = new Set(WEAPON_ORDER);   // narrowed by applyLoadout() per mission

    this.currentId = 'vx4';
    this.models[this.currentId].visible = true;

    // animation state
    this.adsT = 0;          // 0 hip → 1 sights
    this.sprintT = 0;
    this.state_ = 'ready';  // ready | reloading | stowing | drawing
    this.stateT = 0;
    this.stateDur = 0;
    this.nextShotAt = 0;
    this.triggerWasDown = false;
    this.kickZ = 0; this.kickPitch = 0;
    this.swayX = 0; this.swayY = 0;
    this.swayVX = 0; this.swayVY = 0;
    this.bobT = 0;
    this.landDip = 0;
    this.projectiles = [];
    this.reloadEvents = [];   // {t, fired, fn}
    this.dryFireLatch = false;

    this.hipPos = new THREE.Vector3(0.13, -0.115, -0.28);
    this.hipRot = new THREE.Vector3(0, -0.05, 0);
    this._targetPos = new THREE.Vector3();
    this._targetRot = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._shotDir = new THREE.Vector3();
    this._pelletDir = new THREE.Vector3();
  }

  get def() { return WEAPON_DEFS[this.currentId]; }
  get st() { return this.state[this.currentId]; }
  get model() { return this.models[this.currentId]; }

  /** rank-earned cosmetic finish: tint the metalwork of every view model */
  applyFinish() {
    const f = this.game.progress.finish;
    for (const model of Object.values(this.models)) {
      model.traverse(o => {
        if (!o.isMesh || !o.material || o.material.metalness === undefined) return;
        if (o.userData._baseColor === undefined) o.userData._baseColor = o.material.color.getHex();
        if (o.material.metalness <= 0.5) return;
        if (f.color === null) o.material.color.setHex(o.userData._baseColor);
        else o.material.color.set(o.userData._baseColor).lerp(_finishColor.setHex(f.color), 0.55);
      });
    }
  }

  attachTo(camera) {
    camera.add(this.rig);
    // soft cool fill so the view model reads against dark interiors
    this.gunLight = new THREE.PointLight(0xcfe0f0, 1.15, 2.4, 2);
    this.gunLight.position.set(0.32, 0.24, -0.55);
    camera.add(this.gunLight);
  }

  reset(fullAmmo = false) {
    this.owned = new Set(WEAPON_ORDER);   // narrowed by applyLoadout() for missions
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      this.state[id].mag = def.magSize;
      this.state[id].reserve = fullAmmo ? def.reserveMax : def.startReserve;
      this.state[id].bloom = 0;
      this.state[id].heat = 0;
    }
    this.currentId = 'vx4';
    for (const m of Object.values(this.models)) m.visible = false;
    this.models.vx4.visible = true;
    this.adsT = 0; this.sprintT = 0;
    this.state_ = 'ready';
    this.projectiles.length = 0;
    this.rig.position.copy(this.hipPos);
    this.rig.rotation.set(0, -0.05, 0);
  }

  /** Carry only the loadout weapons; everything else stays at zero until picked up. */
  applyLoadout(primaryId, secondaryId, fullAmmo = false) {
    const ids = [primaryId, secondaryId].filter(id => WEAPON_DEFS[id]);
    this.owned = new Set(ids);
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      const carry = ids.indexOf(id) >= 0;
      this.state[id].mag = carry ? def.magSize : 0;
      this.state[id].reserve = carry ? (fullAmmo ? def.reserveMax : def.startReserve) : 0;
      this.state[id].bloom = 0;
      this.state[id].heat = 0;
      this.state[id].malf = false;
    }
    this.currentId = ids[0] || 'vx4';
    for (const m of Object.values(this.models)) m.visible = false;
    this.models[this.currentId].visible = true;
    this.adsT = 0;
    this.state_ = 'ready';
  }

  /** After a checkpoint restore: re-derive carry from restored ammo state. */
  rebuildOwned() {
    this.owned = new Set();
    for (const id of WEAPON_ORDER) {
      const st = this.state[id];
      if (st && (st.mag > 0 || st.reserve > 0)) this.owned.add(id);
    }
    this.owned.add(this.currentId);
  }

  /** §21 slot limits: picking up `id` would displace the occupant of its slot. */
  isSlotFull(id) {
    const def = WEAPON_DEFS[id];
    if (!def) return false;
    return def.klass === 'SIDEARM' ? !!this.game.loadout.secondary : !!this.game.loadout.primary;
  }
  select(id) {
    if (id === this.currentId || this.state_ === 'stowing' || this.state_ === 'drawing') return;
    if (!WEAPON_DEFS[id]) return;
    if (this.owned && !this.owned.has(id)) return;   // not carried — no ghost slots
    this.state_ = 'stowing';
    this.stateT = 0;
    this.stateDur = 0.22;
    this.pendingSelect = id;
    this.reloadEvents.length = 0;
  }

  startReload(force = false) {
    if (this.state_ !== 'ready') return;
    const st = this.st, def = this.def;
    if (st.malf) {
      // tap-rack: clear the stoppage without touching the magazine
      const handling = this.game.player.handlingMultiplier();
      this.state_ = 'reloading';
      this.stateT = 0;
      this.stateDur = 1.15 * handling;
      this._rackMalf = true;
      this.malfLatch = false;
      const audio = this.game.audio;
      this.reloadEvents.push({ t: 0.05, fired: false, fn: () => audio.wpnClick(500, 0.5) });
      this.reloadEvents.push({ t: this.stateDur * 0.5, fired: false, fn: () => audio.wpnBolt(0) });
      this.reloadEvents.push({ t: this.stateDur * 0.85, fired: false, fn: () => audio.wpnClick(1900, 0.35) });
      return;
    }
    if (st.mag >= def.magSize) return;
    if (st.reserve <= 0 && !force) {
      this.game.ui.toastBrief('NO RESERVE AMMO');
      return;
    }
    const dry = st.mag === 0;
    const base = dry ? def.reload.dry : def.reload.tactical;
    const handling = this.game.player.handlingMultiplier(); // arm injuries slow reloads
    this.state_ = 'reloading';
    this.stateT = 0;
    this.stateDur = base * handling;
    this.dryFireLatch = false;

    // schedule audio + magazine-swap keyframes along the timeline
    const audio = this.game.audio;
    const ev = [];
    ev.push({ t: 0.02, fn: () => audio.wpnRaise(0) });
    ev.push({ t: this.stateDur * 0.18, fn: () => audio.wpnMagOut(0) });
    ev.push({ t: this.stateDur * 0.55, fn: () => audio.wpnMagIn(0) });
    if (dry) ev.push({ t: this.stateDur * 0.78, fn: () => audio.wpnBolt(0) });
    ev.push({ t: this.stateDur * 0.92, fn: () => audio.wpnClick(1900, 0.35) });
    ev.forEach(e => this.reloadEvents.push({ t: e.t, fired: false, fn: e.fn }));
  }

  _finishReload() {
    const st = this.st, def = this.def;
    if (this._rackMalf) {
      this._rackMalf = false;
      st.malf = false;
      this.state_ = 'ready';
      return;
    }
    const need = def.magSize - st.mag;
    const take = Math.min(need, st.reserve);
    st.mag += take;
    st.reserve -= take;
    this.state_ = 'ready';
  }

  tryFire(now, triggerDown) {
    if (this.game.state !== 'playing') return;
    const def = this.def, st = this.st;
    const player = this.game.player;

    // semi-auto needs a fresh press
    const freshPress = triggerDown && !this.triggerWasDown;
    const canFire = def.auto ? triggerDown : freshPress;

    if (this.state_ !== 'ready' || player.sprinting || !triggerDown) {
      if (!triggerDown) this.dryFireLatch = false;
      return;
    }
    if (now < this.nextShotAt) return;

    if (st.malf) {
      if (!this.malfLatch) {
        this.game.audio.wpnClick(320, 0.5); // dead click
        this.malfLatch = true;
        this.nextShotAt = now + 0.25;
      }
      return;
    }
    if (st.mag <= 0) {
      if (!this.dryFireLatch) {
        this.game.audio.dryFire();
        this.dryFireLatch = true;
        this.nextShotAt = now + 0.3;
      }
      return;
    }
    if (!canFire) return;

    this.nextShotAt = now + (def.auto ? 60 / def.rpm : (def.semiDelay || 60 / def.rpm));
    st.mag--;
    this.dryFireLatch = false;
    this.game.stats.shots++;

    // --- shot direction: camera forward + dispersion cone ---
    const cam = this.game.camera;
    cam.getWorldDirection(this._camDir);
    const speed = player.speed;
    const moving = speed > 0.6;
    const s = def.spread;
    let spread = (this.adsT > 0.6 ? THREE.MathUtils.lerp(s.ads, s.adsMove, Math.min(1, speed / 2)) : THREE.MathUtils.lerp(s.hip, s.hipMove, Math.min(1, speed / 3.2)));
    spread += st.bloom;
    spread *= player.spreadMultiplier();
    if (!player.onGround) spread *= 2.4;

    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    this._shotDir.copy(this._camDir)
      .addScaledVector(this._right, Math.cos(a) * r)
      .addScaledVector(this._up, Math.sin(a) * r)
      .normalize();

    // muzzle world position
    const muzzleObj = this.model.userData.muzzle;
    muzzleObj.getWorldPosition(this._muzzleWorld);

    // bloom + heat
    st.bloom = Math.min(s.bloomMax, st.bloom + s.bloomPerShot);
    st.heat = Math.min(20, st.heat + 1);
    // hot guns jam: rare when clean, more likely soaked in heat
    const jamChance = st.heat > 14 ? 0.02 : st.heat > 9 ? 0.006 : 0.002;
    if (Math.random() < jamChance) st.malf = true;

    // recoil into the camera (player applies + recovers)
    const rec = def.recoil;
    st.shotIdx = (st.shotIdx || 0) + 1;
    const si = st.shotIdx;
    // signature curve: mild first round, strong early climb, settled group after
    const ramp = si <= 1 ? 0.72 : si <= 6 ? 0.95 + si * 0.05 : 0.9;
    const yawSig = Math.sin(si * (def.id === 'vx4' ? 1.9 : def.id === 'p9' ? 2.3 : 3.1))
      * (def.id === 'mr7' ? 0.25 : 0.8);
    player.addRecoil(
      rec.pitch * ramp * (0.92 + Math.random() * 0.16),
      rec.yaw * yawSig + (Math.random() - 0.5) * rec.yaw * 0.5
    );
    this.kickZ += rec.kickZ;
    this.kickPitch += rec.kickPitch;

    // audio + visuals
    this.game.addShake(def.shake != null ? def.shake : 0.045);
    this.game.audio.gunshot(def.sound, null);
    this.game.emitNoise(player.headPos, def.noiseRadius, 'gunshot');
    this.game.particles.muzzleFlash(this._muzzleWorld, this._shotDir, true);
    if (st.heat > 6) this.game.particles.gunSmoke(this._muzzleWorld, this._shotDir);
    this.game.audio.casingDrop(null, 0.28);
    this._ejectCasing();

    // simulation
    if (def.pellets) {
      // shotgun: independent cone roll per pellet, hard range cap
      for (let i = 0; i < def.pellets; i++) {
        const ap = Math.random() * Math.PI * 2;
        const rp = Math.sqrt(Math.random()) * spread;
        this._pelletDir.copy(this._camDir)
          .addScaledVector(this._right, Math.cos(ap) * rp)
          .addScaledVector(this._up, Math.sin(ap) * rp)
          .normalize();
        this._hitscan(this._muzzleWorld, this._pelletDir, def.pelletRange || 60);
      }
    } else if (def.projectile) {
      const p = new Projectile(def, this._muzzleWorld.clone(), this._shotDir.clone(), this.game);
      this.projectiles.push(p);
    } else {
      this._hitscan(this._muzzleWorld, this._shotDir, 300);
    }
  }

  _ejectCasing() {
    const cam = this.game.camera;
    const port = this.model.userData.port;
    port.getWorldPosition(_p1);
    _n1.set(1, 0.6, 0.2).applyQuaternion(cam.quaternion).multiplyScalar(1.6 + Math.random());
    this.game.particles.debris.spawn(_p1, _n1, 0.018, _casingColor, 1.4, 16);
  }

  /**
   * Hitscan with glass penetration: rays pass through breakable panes
   * (shattering them) and keep going.
   */
  _hitscan(origin, dir, maxRange) {
    const g = this.game;
    this._penMult = 1;
    let from = origin;
    let remaining = maxRange;
    let finalPoint = _p1.copy(origin).addScaledVector(dir, maxRange);
    let hitSomething = false;

    for (let pass = 0; pass < 3 && remaining > 0.1; pass++) {
      // --- entity tests ---
      let bestT = remaining, bestEnemy = null, bestZone = null, bestTarget = null, bestTargetZone = null;
      for (const e of g.enemies.list) {
        if (!e.alive) continue;
        const d = rayAABBLocal(from, dir, e.box.min, e.box.max, bestT, _local);
        if (d !== null) {
          bestT = d; bestEnemy = e;
          bestZone = zoneFromLocal(_local, e);
        }
      }
      for (const t of g.world.rangeTargets) {
        const hit = t.rayTest(from, dir, bestT);
        if (hit && (!bestEnemy || hit.dist < bestT)) {
          bestT = hit.dist; bestTarget = t; bestTargetZone = hit.zone; bestEnemy = null;
        }
      }

      // --- shootable lamps ---
      let bestShoot = null, bestShootT = bestT;
      for (const sh of g.world.shootables) {
        if (sh.dead) continue;
        _oc.copy(sh.pos).sub(from);
        const tca = _oc.dot(dir);
        if (tca < 0 || tca > bestShootT) continue;
        const d2 = _oc.lengthSq() - tca * tca;
        if (d2 > sh.r * sh.r) continue;
        const thc = Math.sqrt(sh.r * sh.r - d2);
        const d0 = tca - thc;
        if (d0 >= 0 && d0 < bestShootT) { bestShootT = d0; bestShoot = sh; }
      }
      if (bestShoot) {
        if (!bestEnemy || bestShootT < bestT) {
          const point = _p2.copy(from).addScaledVector(dir, bestShootT);
          bestShoot.dead = true;
          bestShoot.light.userData.dead = true;
          bestShoot.light.intensity = 0;
          if (bestShoot.bulb) bestShoot.bulb.material = g.world.mat.burntBulb;
          g.particles.impact(point, _n1.copy(dir).negate(), 'metal', 1.4);
          g.audio.impact('metal', point, 1.4);
          g.audio.wpnClick(140, 0.6);
          g.emitNoise(point, 10, 'impact');
          from = _p3.copy(point).addScaledVector(dir, 0.06);
          remaining -= bestShootT + 0.06;
          bestT = remaining;
          bestEnemy = null; bestTarget = null;
          continue;
        }
      }

      // --- world test ---
      const worldHit = g.physics.raycast(from, dir, bestT);

      if (bestEnemy) {
        const point = _p2.copy(from).addScaledVector(dir, bestT);
        const dmg = this._damageAt(this.def, point.distanceTo(g.camera.position)) * this._penMult;
        g.stats.hits++;
        if (bestZone === 'head') g.stats.headshots++;
        g.enemies.damage(bestEnemy, bestZone, dmg, point, dir);
        finalPoint.copy(point);
        hitSomething = true;
        break;
      }
      if (bestTarget) {
        const point = _p2.copy(from).addScaledVector(dir, bestT);
        bestTarget.hit();
        g.audio.wpnClick(1800, 0.4);
        g.particles.impact(point, _n1.copy(dir).negate(), 'metal', 0.6);
        finalPoint.copy(point);
        hitSomething = true;
        break;
      }
      if (worldHit) {
        if (worldHit.collider.breakable) {
          // shatter and continue through the pane (slight energy loss)
          g.world.breakGlass(worldHit.collider);
          g.particles.glassBurst(worldHit.point, worldHit.normal);
          g.audio.impact('glass', worldHit.point);
          g.emitNoise(worldHit.point, 30, 'glass');
          this._penMult *= 0.85;
          from = _p3.copy(worldHit.point).addScaledVector(dir, 0.06);
          remaining -= worldHit.dist + 0.06;
          continue; // next pass
        }
        if (worldHit.collider.material === 'wood' && pass === 0) {
          // punches thin wood once, bleeding energy
          g.particles.impact(worldHit.point, worldHit.normal, 'wood', 0.8);
          g.audio.impact('wood', worldHit.point);
          this._penMult *= 0.6;
          from = _p3.copy(worldHit.point).addScaledVector(dir, 0.14);
          remaining -= worldHit.dist + 0.14;
          continue;
        }
        g.onWorldImpact(worldHit.point, worldHit.normal, worldHit.collider.material, 1.2);
        finalPoint.copy(worldHit.point);
        hitSomething = true;
        break;
      }
      break; // hit nothing
    }

    g.particles.tracer(this._muzzleWorld, finalPoint);
    void hitSomething;
  }

  _damageAt(def, dist) {
    const f = def.falloff;
    const k = dist <= f.near ? 1 : Math.max(f.min, 1 - (dist - f.near) / (f.far - f.near) * (1 - f.min));
    return def.damage * k;
  }

  // -------------------------------------------------------------------------
  update(dt, now, player) {
    const g = this.game;
    const def = this.def, st = this.st;

    // ---- breathing sway on the aimed camera ----
    if (this.isAds() && g.state === 'playing') {
      const t = g.time;
      const fatigue = 1 + (1 - player.stamina / 100) * 2.2 + (player.health < 40 ? 1.2 : 0);
      const amp = 0.00042 * fatigue * (player.armInjury > 0 ? 1.8 : 1) * (1 + (g.suppress || 0) * 3.5);
      g.camera.rotation.x += Math.sin(t * 1.7) * amp + Math.sin(t * 3.9 + 1.7) * amp * 0.45;
      g.camera.rotation.y += Math.cos(t * 1.3 + 0.6) * amp * 0.6;
    }

    // ---- projectiles ----
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt);
      if (p.dead) this.projectiles.splice(i, 1);
    }

    // ---- bloom / heat recovery ----
    st.bloom = Math.max(0, st.bloom - def.spread.bloomRecover * dt);
    if (st.bloom <= 0.0001 && this.state_ === 'ready') st.shotIdx = 0;
    st.heat = Math.max(0, st.heat - dt * 1.4);

    // ---- state machine (reload / swap timelines) ----
    this.stateT += dt;
    if (this.state_ === 'reloading') {
      for (const ev of this.reloadEvents) {
        if (!ev.fired && this.stateT >= ev.t) { ev.fired = true; ev.fn(); }
      }
      if (this.stateT >= this.stateDur) {
        this._finishReload();
        this.reloadEvents.length = 0;
      }
    } else if (this.state_ === 'stowing') {
      if (this.stateT >= this.stateDur) {
        this.models[this.currentId].visible = false;
        this.currentId = this.pendingSelect || 'vx4';
        this.models[this.currentId].visible = true;
        this.state_ = 'drawing';
        this.stateT = 0;
        const newDef = WEAPON_DEFS[this.currentId];
        this.stateDur = (0.42 / (newDef.handling || 1)) * player.handlingMultiplier();
        g.audio.wpnRaise();
      }
    } else if (this.state_ === 'drawing') {
      if (this.stateT >= this.stateDur) { this.state_ = 'ready'; this.nextShotAt = now; }
    }

    // ---- ADS ----
    const wantsAds = g.input.mouse2 && this.state_ === 'ready' && !player.sprinting && player.speed < 4.2;
    const adsSpeed = 1 / (def.adsTime * player.handlingMultiplier());
    this.adsT = THREE.MathUtils.clamp(this.adsT + (wantsAds ? adsSpeed : -adsSpeed * 1.3) * dt, 0, 1);
    // camera FOV
    const baseFov = g.settings.fov;
    g.setActiveFov(THREE.MathUtils.lerp(baseFov, def.adsFov, this.easeInOut(this.adsT)));

    // ---- sprint pose ----
    const wantsSprint = player.sprinting && player.speed > 1.2;
    this.sprintT = THREE.MathUtils.clamp(this.sprintT + (wantsSprint ? 5 : -6) * dt, 0, 1);

    // ---- procedural pose target ----
    const model = this.model;
    const adsPos = _adsPos.set(0, -def.sightY - 0.008, -0.24);
    const sprintPos = _sprintPos.set(0.02, -0.16, -0.24);
    const sprintRot = _sprintRot.set(0.28, -0.5, -0.42);

    this._targetPos.copy(this.hipPos).lerp(adsPos, this.easeInOut(this.adsT));
    this._targetRot.set(
      THREE.MathUtils.lerp(this.hipRot.x, 0, this.adsT),
      THREE.MathUtils.lerp(this.hipRot.y, 0, this.adsT),
      0
    );
    // sprint blend
    this._targetPos.lerp(sprintPos, this.sprintT);
    this._targetRot.lerp(sprintRot, this.sprintT);

    // reload pose: dip the weapon down-left and tilt; mag hand-off motion
    if (this.state_ === 'reloading') {
      const t = this.stateT / this.stateDur;
      const dip = Math.sin(Math.min(1, t) * Math.PI);        // down and back up
      const tilt = Math.sin(Math.min(1, t * 1.1) * Math.PI); // roll
      this._targetPos.x += -0.045 * dip * (1 - this.adsT * 0.5);
      this._targetPos.y += -0.075 * dip;
      this._targetPos.z += 0.05 * dip;
      this._targetRot.x += 0.42 * dip;
      this._targetRot.z += 0.4 * tilt;
      this._targetRot.y += -0.18 * dip;
      // magazine visual: drops out and comes back (models without a tagged
      // magazine — pistols, shotgun shells — simply skip this detail)
      const mag = model.userData.mag;
      if (mag) {
        const magDrop = t < 0.18 ? 0 : t < 0.32 ? (t - 0.18) / 0.14 : t < 0.5 ? 1 : t < 0.62 ? 1 - (t - 0.5) / 0.12 : 0;
        mag.position.y = mag.userData.baseY === undefined ? (mag.userData.baseY = mag.position.y) : mag.userData.baseY;
        mag.position.y = mag.userData.baseY - magDrop * 0.35;
        mag.visible = !(t > 0.2 && t < 0.5);
      }
    } else if (model.userData.mag) {
      model.userData.mag.visible = true;
      if (model.userData.mag.userData.baseY !== undefined) model.userData.mag.position.y = model.userData.mag.userData.baseY;
    }
    // stow / draw dip
    if (this.state_ === 'stowing') {
      const t = Math.min(1, this.stateT / this.stateDur);
      this._targetPos.y -= 0.35 * t;
      this._targetRot.x += 0.5 * t;
    } else if (this.state_ === 'drawing') {
      const t = Math.min(1, this.stateT / this.stateDur);
      this._targetPos.y -= 0.35 * (1 - t);
      this._targetRot.x += 0.5 * (1 - t);
    }

    // ---- head bob + landing dip + sway spring ----
    const bob = player.weaponBob(); // {x,y} small offsets
    this._targetPos.x += bob.x * (1 - this.adsT * 0.85);
    this._targetPos.y += bob.y * (1 - this.adsT * 0.85);

    this.landDip = THREE.MathUtils.lerp(this.landDip, player.landImpulse, 1 - Math.exp(-14 * dt));
    this._targetPos.y -= this.landDip * 0.045;
    this._targetRot.x += this.landDip * 0.16;

    // look sway (weapon trails camera rotation)
    const swayK = 26, swayD = 9;
    this.swayVX += (-player.lookDeltaX * 0.02 * swayK - this.swayX * swayK - this.swayVX * swayD) * dt;
    this.swayVY += (-player.lookDeltaY * 0.02 * swayK - this.swayY * swayK - this.swayVY * swayD) * dt;
    this.swayX = THREE.MathUtils.clamp(this.swayX + this.swayVX * dt, -0.06, 0.06);
    this.swayY = THREE.MathUtils.clamp(this.swayY + this.swayVY * dt, -0.06, 0.06);
    this._targetPos.x += this.swayX * (1 - this.adsT * 0.9);
    this._targetPos.y += this.swayY * (1 - this.adsT * 0.9);
    this._targetRot.y += -this.swayX * 2.2;
    this._targetRot.z += this.swayX * 1.4;
    this._targetRot.x += this.swayY * 1.6;

    // ---- recoil kick spring on the view model ----
    const rec = def.recoil.recover;
    this.kickZ = THREE.MathUtils.lerp(this.kickZ, 0, 1 - Math.exp(-rec * dt));
    this.kickPitch = THREE.MathUtils.lerp(this.kickPitch, 0, 1 - Math.exp(-rec * dt));
    this._targetPos.z += this.kickZ;
    this._targetRot.x += this.kickPitch;

    // ---- smooth toward target (faster when ads for responsiveness) ----
    const k = this.adsT > 0.5 ? 16 : 11;
    const f = 1 - Math.exp(-k * dt);
    this.rig.position.lerp(this._targetPos, f);
    this.rig.rotation.x = THREE.MathUtils.lerp(this.rig.rotation.x, this._targetRot.x, f);
    this.rig.rotation.y = THREE.MathUtils.lerp(this.rig.rotation.y, this._targetRot.y, f);
    this.rig.rotation.z = THREE.MathUtils.lerp(this.rig.rotation.z, this._targetRot.z, f);

    // idle breathing when nearly still
    const still = player.speed < 0.4 && this.state_ === 'ready' ? 1 : 0;
    this.bobT += dt;
    if (still > 0) {
      const br = Math.sin(this.bobT * 1.4) * 0.0022 + Math.sin(this.bobT * 0.9) * 0.0015;
      this.rig.position.y += br * (1 - this.adsT * 0.4);
      this.rig.rotation.z += Math.sin(this.bobT * 0.7) * 0.0016;
    }

    // hide the whole rig while dead / menus
    this.rig.visible = g.state === 'playing';
  }

  easeInOut(t) { return t * t * (3 - 2 * t); }

  /** Crosshair spread in pixels-ish units for the HUD. */
  currentSpreadDegrees() {
    const def = this.def, st = this.st;
    const player = this.game.player;
    const s = def.spread;
    const speed = player.speed;
    let spread = (this.adsT > 0.6 ? THREE.MathUtils.lerp(s.ads, s.adsMove, Math.min(1, speed / 2)) : THREE.MathUtils.lerp(s.hip, s.hipMove, Math.min(1, speed / 3.2)));
    spread += st.bloom;
    spread *= player.spreadMultiplier();
    if (!player.onGround) spread *= 2.4;
    return spread / DEG;
  }

  isAds() { return this.adsT > 0.6; }
}

const _casingColor = new THREE.Color(0.72, 0.55, 0.3);
const _adsPos = new THREE.Vector3();
const _sprintPos = new THREE.Vector3();
const _sprintRot = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();

const _finishColor = new THREE.Color();
