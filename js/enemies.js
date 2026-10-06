/**
 * enemies.js
 * Hostile AI for the facility: members of the fictional private security
 * contractor "ARGUS GROUP" (original faction — no real-world organisation).
 *
 * State machine:
 *   PATROL → SUSPICIOUS → INVESTIGATE → COMBAT ⇄ (TAKE COVER / REPOSITION)
 *          → PLAYER LOST → SEARCH → PATROL
 *
 * Perception is imperfect by design: field-of-view cone, distance falloff,
 * line-of-sight occlusion checks, hearing events with radius + precision,
 * last-known-position memory and search behaviour. Squad awareness is
 * modelled through shared last-known position, radio shouts and cover
 * spacing so enemies don't clump or act identically.
 */
import * as THREE from 'three';
import { rayAABBLocal } from './physics.js';

const DEG = Math.PI / 180;
const GRAVITY = 16;

const ZONE_MULT = { head: 4.0, torso: 1.0, arms: 0.7, legs: 0.6 };

// ---------------------------------------------------------------------------
// Enemy visual model — simple articulated figure from primitives
// ---------------------------------------------------------------------------
function buildEnemyModel(mats) {
  const root = new THREE.Group();          // feet at origin
  const body = new THREE.Group();          // lifted/lowered for crouch
  root.add(body);

  const legs = new THREE.Group(); legs.position.y = 0.92; body.add(legs);
  const legGeo = new THREE.BoxGeometry(0.17, 0.92, 0.2);
  const legL = new THREE.Mesh(legGeo, mats.cloth);
  legL.position.set(-0.11, -0.46, 0);
  const legR = legL.clone(); legR.position.x = 0.11;
  legL.castShadow = legR.castShadow = true;
  legs.add(legL, legR);
  // boots
  const bootGeo = new THREE.BoxGeometry(0.19, 0.12, 0.3);
  const bootL = new THREE.Mesh(bootGeo, mats.dark);
  bootL.position.set(-0.11, -0.88, 0.04);
  const bootR = bootL.clone(); bootR.position.x = 0.11;
  legs.add(bootL, bootR);

  const torso = new THREE.Group(); torso.position.y = 0.92; body.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.26), mats.vest);
  chest.position.y = 0.3; chest.castShadow = true;
  torso.add(chest);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.23), mats.cloth);
  belly.position.y = 0.06;
  torso.add(belly);
  // pouches on the vest
  const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.05), mats.dark);
  pouch.position.set(-0.12, 0.3, 0.155);
  torso.add(pouch);
  const pouch2 = pouch.clone(); pouch2.position.x = 0.12; torso.add(pouch2);

  // head + helmet
  const headGrp = new THREE.Group(); headGrp.position.y = 0.66; torso.add(headGrp);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.24, 0.22), mats.skin);
  head.position.y = 0.1; head.castShadow = true;
  headGrp.add(head);
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.245, 0.13, 0.26), mats.helmet);
  helmet.position.y = 0.2;
  headGrp.add(helmet);
  const mask = new THREE.Mesh(new THREE.BoxGeometry(0.215, 0.1, 0.06), mats.dark);
  mask.position.set(0, 0.04, 0.115);
  headGrp.add(mask);

  // arms (pivot at shoulders) + a simple held rifle
  const armGeo = new THREE.BoxGeometry(0.12, 0.5, 0.14);
  const armL = new THREE.Group(); armL.position.set(-0.3, 0.5, 0); torso.add(armL);
  const armLMesh = new THREE.Mesh(armGeo, mats.cloth);
  armLMesh.position.y = -0.24; armLMesh.castShadow = true;
  armL.add(armLMesh);
  const armR = new THREE.Group(); armR.position.set(0.3, 0.5, 0); torso.add(armR);
  const armRMesh = new THREE.Mesh(armGeo, mats.cloth);
  armRMesh.position.y = -0.24; armRMesh.castShadow = true;
  armR.add(armRMesh);

  const rifle = new THREE.Group();
  const rBody = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.62), mats.gun);
  rifle.add(rBody);
  const rBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 6), mats.gun);
  rBarrel.rotation.x = Math.PI / 2; rBarrel.position.z = -0.44;
  rifle.add(rBarrel);
  const rMag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.07), mats.dark);
  rMag.position.set(0, -0.11, -0.05); rMag.rotation.x = 0.2;
  rifle.add(rMag);
  rifle.position.set(0.14, 0.24, -0.28);
  rifle.rotation.set(0, Math.PI, 0.05);
  torso.add(rifle);

  // small emissive IR strobe on the shoulder (faction marker, non-real)
  const strobe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.03), mats.strobe);
  strobe.position.set(-0.2, 0.46, 0.1);
  torso.add(strobe);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.62);
  rifle.add(muzzle);

  return { root, body, legs, legL, legR, torso, headGrp, armL, armR, rifle, muzzle, strobe };
}

// ---------------------------------------------------------------------------
// Single enemy
// ---------------------------------------------------------------------------
class Enemy {
  constructor(game, spawn, kind, personalitySeed) {
    this.game = game;
    this.kind = kind;
    this.alive = true;
    this.health = 100;

    // personality variance so squad members don't act identically
    const rnd = mulberry(personalitySeed);
    const diff = game.progress.difficulty;
    this.skill = Math.min(1.25, (0.55 + rnd() * 0.45) * diff.skill);
    this.aggression = 0.3 + rnd() * 0.7;         // reposition vs hold
    this.reactionBase = (0.75 - this.skill * 0.4) * diff.reaction; // s before first shot
    this.spreadMod = diff.spread;
    this.detectMod = diff.detection;
    this.hearMod = diff.hearing;
    this.burstLen = 2 + Math.floor(rnd() * 3);

    this.pos = spawn.pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = rnd() * Math.PI * 2;
    this.pitch = 0;
    this.onGround = true;
    this.crouchT = 0;
    this.crouching = false;

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._syncBox();

    // AI state
    this.state = 'patrol';
    this.route = spawn.route != null ? game.world.patrolRoutes[spawn.route] : null;
    this.routeIdx = 0;
    this.stateT = 0;
    this.pauseT = 0;
    this.speedScale = 1;

    this.lastKnown = new THREE.Vector3();
    this.lastKnownValid = false;
    this.lastSeenT = -99;
    this.detection = 0;          // 0..1 visual accumulation
    this.suspicionPoint = new THREE.Vector3();
    this.searchT = 0;
    this.searchPoint = new THREE.Vector3();
    this.nextPercept = rnd() * 0.3;
    this.hasLOS = false;

    // combat
    this.combatAction = 'engage';   // engage | cover | reposition
    this.actionT = 0;
    this.coverPoint = null;
    this.windupT = 0;
    this.suppressT = 0;
    this.stunT = 0;        // flashbang stun (C3)
    this.grenadeCd = 10 + rnd() * 12;
    this.throwT = 0;
    this.chatterCd = 0;
    this.moraleT = 0;
    this.surrendered = false;
    this.fled = false;
    this.burstLeft = 0;
    this.burstT = 0;
    this.repositionT = 0;
    this.aimYaw = this.yaw;
    this.flinchT = 0;
    this.flinchDir = new THREE.Vector3();
    this.armHitT = 0;
    this.legHitT = 0;
    this.deathT = 0;
    this.deathAxis = new THREE.Vector3(1, 0, 0);
    this.sinkT = 0;

    // locomotion anim
    this.walkPhase = rnd() * 10;
    this.moveSpeed = 0;
    this.stuckT = 0;
    this.lastPos = this.pos.clone();
    this.avoidYaw = 0;

    // model
    const mats = game.enemies.mats;
    this.model = buildEnemyModel(mats);
    if (spawn.flash) {
      const fl = new THREE.SpotLight(0xfff0cc, 0, 20, 0.42, 0.55, 1.7);
      fl.position.set(0.16, 0.42, 0.25);
      const tgt = new THREE.Object3D();
      tgt.position.set(0.1, 0.1, 8);
      this.model.torso.add(fl, tgt);
      fl.target = tgt;
      this.flash = fl;
    }
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    game.enemies.group.add(this.model.root);

    this._muzzleWorld = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._toPlayer = new THREE.Vector3();
    this._wish = new THREE.Vector3();
  }

  _syncBox() {
    const h = THREE.MathUtils.lerp(1.82, 1.2, this.crouchT);
    this.box.min.set(this.pos.x - 0.32, this.pos.y, this.pos.z - 0.32);
    this.box.max.set(this.pos.x + 0.32, this.pos.y + h, this.pos.z + 0.32);
  }

  eyePos(out) {
    return out.set(this.pos.x, this.pos.y + THREE.MathUtils.lerp(1.62, 1.05, this.crouchT), this.pos.z);
  }

  // =========================================================================
  update(dt, manager) {
    const g = this.game;
    this.stateT += dt;
    this.suppressT = Math.max(0, this.suppressT - dt);
    if (this.stunT > 0) {
      this.stunT -= dt;          // flash-banged: blind and staggering
      this.hasLOS = false;
      return;
    }
    this.chatterCd -= dt;
    if (this.flash && this.alive) {
      const want = this.game.world.lightMode === 'night' && !this.surrendered &&
        (this.state === 'patrol' || this.state === 'suspicious' || this.state === 'investigate');
      this.flash.intensity += ((want ? 55 : 0) - this.flash.intensity) * Math.min(1, dt * 8);
    }

    if (!this.alive) {
      this._updateDeath(dt);
      return;
    }

    this.armHitT = Math.max(0, this.armHitT - dt);
    this.legHitT = Math.max(0, this.legHitT - dt);
    this.flinchT = Math.max(0, this.flinchT - dt * 3);

    // ---- perception tick (staggered across enemies for performance) ----
    this.nextPercept -= dt;
    if (this.nextPercept <= 0) {
      this.nextPercept = 0.18 + Math.random() * 0.14;
      this._perceive(manager);
    }
    // continuous detection bleed-off
    this.detection = Math.max(0, this.detection - dt * 0.12);

    // ---- state behaviour ----
    switch (this.state) {
      case 'patrol': this._patrol(dt); break;
      case 'suspicious': this._suspicious(dt); break;
      case 'investigate': this._investigate(dt); break;
      case 'combat': this._combat(dt, manager); break;
      case 'search': this._search(dt, manager); break;
      case 'flee': {
        const arrived = this._setMoveTarget(this.searchPoint, 0.4, 4.6);
        this.crouching = false;
        if (arrived || this.pos.distanceTo(this.searchPoint) < 1.6) {
          this.fleeing = false;
          this.fled = true;
          this._surrender(true);
        }
        break;
      }
      case 'surrender': {
        this.crouching = true;
        this._setMoveTarget(null, 0);
        this._aimAt(g.player.pos, dt, 0.25);
        break;
      }
    }

    // ---- locomotion ----
    this._move(dt);

    // ---- animation ----
    this._animate(dt, manager);
  }

  _perceive(manager) {
    const g = this.game;
    const player = g.player;
    if (!player.alive || g.state !== 'playing') { this.hasLOS = false; return; }

    const eye = this.eyePos(this._eye);
    const chest = _pv1.set(player.pos.x, player.pos.y + 1.05, player.pos.z);
    const toP = _pv2.copy(chest).sub(eye);
    const dist = toP.length();
    toP.normalize();

    // facing check (yaw only)
    const fwd = _pv3.set(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw));
    const flat = _pv4.set(toP.x, 0, toP.z).normalize();
    const dot = fwd.dot(flat);
    const fovCos = Math.cos(55 * DEG); // ~110° cone

    let los = false;
    if (dist < 90) {
      los = g.physics.hasLOS(eye, chest) &&
        !(g.throwables && g.throwables.smokeBlocksLOS(eye, chest));
    }
    this.hasLOS = los;

    const inCone = dot > fovCos;
    // close-range awareness even outside the cone (peripheral / body sense)
    const veryClose = dist < 2.6 && dot > -0.2;

    if (los && (inCone || veryClose)) {
      // visibility accumulation — distance, movement and stance all matter
      const rangeFactor = THREE.MathUtils.clamp(1.15 - dist / 52, 0.12, 1);
      let speedFactor = 0.55;
      if (player.sprinting) speedFactor = 1.7;
      else if (player.speed > 1.5) speedFactor = 1.0;
      else if (player.speed > 0.3) speedFactor = 0.7;
      else speedFactor = 0.45;
      const stanceFactor = player.crouching ? 0.55 : 1;
      // flashlight-free night: dim interior slightly favours a still player
      const lightFactor = this._playerInLight() ? 1.25 : 0.8;

      this.detection += rangeFactor * speedFactor * stanceFactor * lightFactor * 0.55 * this.detectMod;

      if (this.detection >= 1 || veryClose) {
        this._spotPlayer(manager, chest);
      } else if (this.detection > 0.35 && this.state === 'patrol') {
        this._goSuspicious(chest);
      }
    }

    // while in combat keep last-known fresh when visible
    if (this.state === 'combat' && los && inCone) {
      this.lastKnown.copy(player.pos);
      this.lastKnownValid = true;
      this.lastSeenT = g.time;
      manager.shareLastKnown(this.lastKnown, this);
    }
  }

  _playerInLight() {
    // cheap heuristic: is the player inside the warehouse lit zone or near a lamp area?
    const p = this.game.player.pos;
    const inside = p.x > -30 && p.x < 30 && p.z > -45 && p.z < 15;
    return inside ? (p.y > 0 && Math.abs(p.x) < 26) : false;
  }

  _spotPlayer(manager, chestPos) {
    const first = this.state !== 'combat';
    this.state = 'combat';
    this.combatAction = 'engage';
    this.stateT = 0;
    this.actionT = 0;
    this.lastKnown.copy(this.game.player.pos);
    this.lastKnownValid = true;
    this.lastSeenT = this.game.time;
    this.windupT = first ? this.reactionBase + Math.random() * 0.3 : 0.15;
    this.detection = 1;
    if (first) {
      manager.onPlayerSpotted(this);
    }
    void chestPos;
  }

  _goSuspicious(point) {
    if (this.state === 'combat') return;
    this.state = 'suspicious';
    this.stateT = 0;
    this.suspicionPoint.copy(point);
    this.detection = Math.max(this.detection, 0.35);
  }

  /** Hearing callback from the manager. */
  hear(noise, manager) {
    // noise: {pos, radius, kind}
    const d = this.pos.distanceTo(noise.pos);
    if (d > noise.radius * this.hearMod) return;
    if (this.state === 'combat') {
      // refresh squad knowledge toward the noise if it's stronger info
      if (noise.kind === 'gunshot' || noise.kind === 'player_shot') {
        this.lastKnown.copy(noise.pos);
        this.lastKnownValid = true;
      }
      return;
    }
    const proximity = 1 - d / noise.radius;
    if (noise.kind === 'gunshot' || noise.kind === 'glass' || noise.kind === 'alarm') {
      this.lastKnown.copy(noise.pos);
      this.lastKnownValid = true;
      this.state = 'investigate';
      this.stateT = 0;
      this.searchT = 0;
      manager.onPlayerSpotted(this, true); // loud violence = full alert
    } else if (noise.kind === 'door') {
      if (proximity > 0.35) {
        this.lastKnown.copy(noise.pos);
        this.lastKnownValid = true;
        this.state = 'investigate';
        this.stateT = 0;
      } else this._goSuspicious(noise.pos);
    } else { // footsteps / jump / land
      if (proximity > 0.55) {
        this.lastKnown.copy(noise.pos);
        this.lastKnownValid = true;
        if (this.state === 'patrol') { this.state = 'investigate'; this.stateT = 0; }
      } else if (proximity > 0.25) {
        this._goSuspicious(noise.pos);
      }
    }
  }

  // ---- states -------------------------------------------------------------
  _patrol(dt) {
    this.crouching = false;
    if (!this.route || this.route.length === 0) {
      // no route: idle guard, scan around
      this.yaw += Math.sin(this.game.time * 0.4 + this.walkPhase) * 0.2 * dt;
      this._setMoveTarget(null, 0);
      return;
    }
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this._setMoveTarget(null, 0);
      // glance around while paused
      this.yaw += Math.sin(this.game.time * 0.9 + this.walkPhase) * 0.5 * dt;
      return;
    }
    const wp = this.route[this.routeIdx % this.route.length];
    const arrived = this._setMoveTarget(wp, 1.55);
    if (arrived) {
      this.routeIdx = (this.routeIdx + 1) % this.route.length;
      this.pauseT = 0.8 + Math.random() * 2.4;
    }
  }

  _suspicious(dt) {
    this._setMoveTarget(this.suspicionPoint, 1.2, 1.1);
    if (this.stateT > 4.5) {
      if (this.detection > 0.55) {
        this.state = 'investigate';
        this.stateT = 0;
        this.lastKnown.copy(this.suspicionPoint);
        this.lastKnownValid = true;
      } else {
        this.state = 'patrol';
        this.stateT = 0;
        this.detection = 0;
      }
    }
  }

  _investigate(dt) {
    if (!this.lastKnownValid) { this.state = 'patrol'; return; }
    const arrived = this._setMoveTarget(this.lastKnown, 1.4, this.pos.distanceTo(this.lastKnown) > 12 ? 2.3 : 1.5);
    if (arrived) {
      this.state = 'search';
      this.stateT = 0;
      this.searchT = 7 + Math.random() * 5;
      this._pickSearchPoint();
    }
    if (this.stateT > 25) { this.state = 'search'; this.stateT = 0; this.searchT = 5; this._pickSearchPoint(); }
    void dt;
  }

  _search(dt, manager) {
    if (manager) this._checkMorale(dt, manager);
    this.searchT -= dt;
    const arrived = this._setMoveTarget(this.searchPoint, 1.0, 1.5);
    if (arrived) {
      // look around at this spot
      this.pauseT = this.pauseT > 0 ? this.pauseT : 0;
      this.yaw += Math.sin(this.game.time * 1.4 + this.walkPhase) * 1.6 * dt;
      if (Math.random() < dt * 0.7) this._pickSearchPoint();
    }
    if (this.searchT <= 0) {
      this.state = 'patrol';
      this.stateT = 0;
      this.detection = 0;
      this.lastKnownValid = false;
    }
  }

  _pickSearchPoint() {
    const base = this.lastKnownValid ? this.lastKnown : this.pos;
    for (let tries = 0; tries < 6; tries++) {
      const p = _pv1.set(
        base.x + (Math.random() - 0.5) * 14,
        this.pos.y,
        base.z + (Math.random() - 0.5) * 14
      );
      // must be walkable-ish: quick probe that the point isn't inside a wall
      const min = _pv2.set(p.x - 0.4, p.y + 0.2, p.z - 0.4);
      const max = _pv3.set(p.x + 0.4, p.y + 1.8, p.z + 0.4);
      const hits = this.game.physics.queryAABB(min, max, []);
      if (!hits.some(c => c.enabled && c.max.y > p.y + 0.4)) {
        this.searchPoint.copy(p);
        return;
      }
    }
    this.searchPoint.copy(base);
  }

  _combat(dt, manager) {
    const g = this.game;
    const player = g.player;
    this.actionT += dt;

    const sinceSeen = g.time - this.lastSeenT;
    const distToPlayer = this.pos.distanceTo(player.pos);

    this._checkMorale(dt, manager);

    // lost sight for a while → advance to last known, then search
    if (sinceSeen > 4.5) {
      if (this.lastKnownValid && this.pos.distanceTo(this.lastKnown) > 2.5) {
        this.combatAction = 'advance';
        const arrived = this._setMoveTarget(this.lastKnown, 2.0, 2.6);
        this._aimAt(player.pos, dt, 0.6);
        if (arrived) {
          this.state = 'search';
          this.stateT = 0;
          this.searchT = 8 + Math.random() * 5;
          this._pickSearchPoint();
          manager.combatTimeout(this);
        }
        return;
      } else {
        this.state = 'search';
        this.stateT = 0;
        this.searchT = 7 + Math.random() * 4;
        this._pickSearchPoint();
        manager.combatTimeout(this);
        return;
      }
    }

    // decide action periodically
    if (this.actionT > (this.combatAction === 'engage' ? 2.2 : 3.4) || this.coverPoint === null && this.combatAction === 'cover') {
      this.actionT = 0;
      const hurt = this.health < 45;
      const roll = Math.random();
      if (this.hasLOS && distToPlayer < 42) {
        if (hurt && roll < 0.55) this.combatAction = 'cover';
        else if (roll < 0.22 * this.aggression) this.combatAction = 'reposition';
        else if (roll < 0.5) this.combatAction = 'cover';
        else this.combatAction = 'engage';
      } else {
        this.combatAction = roll < 0.7 ? 'advance' : 'reposition';
      }
      if (this.combatAction === 'cover') this._pickCover(manager, distToPlayer);
      if (this.combatAction === 'reposition') this.repositionT = 0;
    }

    // frag grenade: telegraphed throw at mid range with LOS
    this.grenadeCd -= dt;
    if (this.throwT > 0) {
      this.throwT -= dt;
      if (this.throwT <= 0) manager.throwGrenade(this);
    } else if (this.grenadeCd <= 0 && this.hasLOS && distToPlayer > 7 && distToPlayer < 24 && player.alive) {
      this.throwT = 0.9;
      this.grenadeCd = 16 + Math.random() * 14;
      g.audio.radioSquelch(this.pos.clone().setY(this.pos.y + 1.3));
      g.ui.radio('GRENADE OUT — MOVE!');
    }

    switch (this.combatAction) {
      case 'engage': {
        // strafe slightly while firing
        const strafe = Math.sin(g.time * 0.8 + this.walkPhase) * 1.4;
        const right = _pv1.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const target = _pv2.copy(this.pos).addScaledVector(right, strafe);
        target.y = this.pos.y;
        this._setMoveTarget(target, 0.9, 1.2);
        this.crouching = distToPlayer > 25 && Math.random() < 0.3;
        this._aimAt(player.pos, dt, 1);
        this._trigger(dt, distToPlayer);
        break;
      }
      case 'cover': {
        if (!this.coverPoint) { this.combatAction = 'engage'; break; }
        const cp = this.coverPoint.pos;
        const arrived = this._setMoveTarget(cp, 0.7, 3.1);
        if (arrived || this.pos.distanceTo(cp) < 1.1) {
          this.crouching = true;
          this._setMoveTarget(null, 0);
          // peek cycles
          this.peekT = (this.peekT || 0) - dt;
          if (this.peekT <= 0) {
            this.peeking = !this.peeking;
            this.peekT = this.peeking ? 1.1 + Math.random() * 0.8 : 1.4 + Math.random() * 1.6;
          }
          if (this.peeking) {
            this.crouching = Math.random() < 0.5;
            this._aimAt(player.pos, dt, 1);
            if (this.hasLOS) this._trigger(dt, distToPlayer);
          } else {
            this._aimAt(this.lastKnown, dt, 0.5);
          }
        } else {
          this.crouching = false;
          this._aimAt(player.pos, dt, 0.7);
          if (this.hasLOS && Math.random() < dt * 0.8) this._trigger(dt, distToPlayer); // firing on the move
        }
        break;
      }
      case 'reposition': {
        this.repositionT += dt;
        if (!this.reposTarget || this.repositionT > 5 || this.pos.distanceTo(this.reposTarget) < 1.2) {
          this.repositionT = 0;
          this.reposTarget = this._pickReposPoint(manager, distToPlayer);
        }
        this._setMoveTarget(this.reposTarget, 0.8, 3.4);
        this.crouching = false;
        this._aimAt(player.pos, dt, 0.8);
        if (this.hasLOS && Math.random() < dt * 0.5) this._trigger(dt, distToPlayer);
        break;
      }
      case 'advance': {
        const tgt = this.lastKnownValid ? this.lastKnown : player.pos;
        this._setMoveTarget(tgt, 1.4, 2.8);
        this.crouching = false;
        this._aimAt(player.pos, dt, 0.8);
        if (this.hasLOS) this._trigger(dt, distToPlayer);
        break;
      }
    }
  }

  _pickCover(manager, distToPlayer) {
    const g = this.game;
    const player = g.player;
    const points = g.world.coverPoints;
    let best = null, bestScore = -1e9;
    const dirToPlayer = _pv1.copy(player.pos).sub(this.pos).setY(0).normalize();

    // sample a subset each pick for variety + perf
    const start = Math.floor(Math.random() * points.length);
    for (let n = 0; n < Math.min(points.length, 26); n++) {
      const cp = points[(start + n) % points.length];
      const d = this.pos.distanceTo(cp.pos);
      if (d > 18 || d < 0.8) continue;
      let score = -d * 0.35;
      // cover should face the player
      score += cp.normal.dot(dirToPlayer) * 3.5;
      // actual occlusion test at the cover spot (eye height there)
      const cEye = _pv2.set(cp.pos.x, cp.pos.y + 1.2, cp.pos.z);
      const pEye = _pv3.set(player.pos.x, player.pos.y + 1.05, player.pos.z);
      if (!g.physics.hasLOS(cEye, pEye)) score += 4.5;
      // spacing from squadmates — avoid stacking
      for (const e of manager.list) {
        if (e === this || !e.alive) continue;
        const ed = e.pos.distanceTo(cp.pos);
        if (ed < 2.2) score -= 6;
        else if (ed < 4) score -= 1.5;
        if (e.coverPoint === cp) score -= 5;
      }
      // low health prefers distant cover (retreating behaviour)
      if (this.health < 35) score += d * 0.22;
      if (score > bestScore) { bestScore = score; best = cp; }
    }
    this.coverPoint = bestScore > -2 ? best : null;
    if (!this.coverPoint) this.combatAction = 'reposition';
    void distToPlayer;
  }

  _pickReposPoint(manager, distToPlayer) {
    const g = this.game;
    const player = g.player;
    // flank-ish: offset perpendicular to the player direction, keep spacing from allies
    const dir = _pv1.copy(player.pos).sub(this.pos).setY(0).normalize();
    const side = Math.random() < 0.5 ? 1 : -1;
    const perp = _pv2.set(-dir.z * side, 0, dir.x * side);
    const forward = THREE.MathUtils.clamp(14 - distToPlayer, -6, 8) * (0.4 + this.aggression);
    for (let tries = 0; tries < 7; tries++) {
      const p = new THREE.Vector3()
        .copy(this.pos)
        .addScaledVector(perp, 4 + Math.random() * 7)
        .addScaledVector(dir, forward * (0.5 + Math.random()));
      p.y = this.pos.y;
      // spacing from allies
      let ok = true;
      for (const e of manager.list) {
        if (e === this || !e.alive) continue;
        if (e.pos.distanceTo(p) < 3) { ok = false; break; }
      }
      if (!ok) continue;
      // walkable probe
      const min = _pv3.set(p.x - 0.4, p.y + 0.2, p.z - 0.4);
      const max = _pv4.set(p.x + 0.4, p.y + 1.8, p.z + 0.4);
      const hits = g.physics.queryAABB(min, max, []);
      if (hits.some(c => c.enabled && c.max.y > p.y + 0.45)) continue;
      return p;
    }
    return this.pos.clone().addScaledVector(perp, 3);
  }

  _aimAt(target, dt, tracking) {
    const to = _pv5.set(target.x - this.pos.x, 0, target.z - this.pos.z);
    const targetYaw = Math.atan2(-to.x, -to.z);
    let diff = targetYaw - this.aimYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = THREE.MathUtils.clamp(diff, -4.5 * dt * tracking, 4.5 * dt * tracking);
    this.aimYaw += turn;
  }

  _trigger(dt, distToPlayer) {
    const g = this.game;
    // reaction windup before the first burst
    if (this.windupT > 0) { this.windupT -= dt; return; }
    if (this.burstLeft <= 0) {
      if (this.burstPause === undefined) this.burstPause = 0;
      this.burstPause -= dt;
      if (this.burstPause <= 0) {
        this.burstLeft = this.burstLen + (this.hasLOS ? 1 : 0);
        this.burstT = 0;
        this.burstPause = THREE.MathUtils.lerp(2.6, 0.9, this.skill) * (0.6 + Math.random() * 0.8);
      }
      return;
    }
    this.burstT -= dt;
    if (this.burstT <= 0) {
      this.burstT = 0.115;
      this.burstLeft--;
      this._shoot(distToPlayer);
    }
  }

  /** wounded + no ally within 12 m → roll to break: surrender up close, flee at range */
  _checkMorale(dt, manager) {
    if (this.health >= 25 || this.surrendered || this.fleeing) return;
    for (const o of manager.list) {
      if (o === this || !o.alive || o.surrendered) continue;
      if (o.pos.distanceToSquared(this.pos) < 144) { this.moraleT = 0; return; }
    }
    this.moraleT += dt;
    if (this.moraleT > 1.6 && Math.random() < dt * 1.5) {
      if (this.pos.distanceTo(this.game.player.pos) < 8) this._surrender();
      else this._flee(manager);
    }
  }

  _surrender(hidden = false) {
    this.surrendered = true;
    this.fled = this.fled || hidden;
    this.state = 'surrender';
    this.stateT = 0;
    this.crouching = true;
    this.model.rifle.visible = false;
    this.throwT = 0;
    if (this.flash) this.flash.intensity = 0;
  }
  _flee(manager) {
    this.fleeing = true;
    this.state = 'flee';
    this.stateT = 0;
    const spawns = this.game.world.surgeSpawns;
    let best = null, bd = -1;
    for (const s of spawns) {
      const d = s.pos.distanceToSquared(this.game.player.pos);
      if (d > bd) { bd = d; best = s.pos; }
    }
    this.searchPoint.copy(best || this.pos).addScaledVector(this.pos.clone().sub(this.game.player.pos).setY(0).normalize(), 6);
  }

  _shoot(distToPlayer) {
    const g = this.game;
    const player = g.player;
    if (!player.alive) return;

    this.model.muzzle.getWorldPosition(this._muzzleWorld);
    const origin = this._muzzleWorld;
    const target = _pv1.set(
      player.pos.x + (Math.random() - 0.5) * 0.1,
      player.pos.y + THREE.MathUtils.lerp(1.0, 1.45, Math.random()),
      player.pos.z + (Math.random() - 0.5) * 0.1
    );
    const dir = _pv2.copy(target).sub(origin);
    const dist = dir.length();
    dir.normalize();

    // dispersion: skill, distance, own movement, arm injury, suppression
    let spread = (3.4 - this.skill * 2.1) * DEG * this.spreadMod;
    if (this.suppressT > 0) spread *= 2.1;
    spread *= THREE.MathUtils.clamp(dist / 18, 0.55, 2.4);
    spread *= this.moveSpeed > 1 ? 1.7 : 1;
    if (this.armHitT > 0) spread *= 1.8;
    if (this.crouching) spread *= 0.75;
    // first shots of a burst are worse (muzzle climb)
    spread *= 1 + (this.burstLen - this.burstLeft) * 0.16;

    _pv3.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2)
      .sub(dir.clone().multiplyScalar(_pv3.dot(dir))).normalize().multiplyScalar(Math.random() * spread);
    dir.add(_pv3).normalize();

    // effects
    g.particles.muzzleFlash(origin, dir, false);
    g.particles.tracer(origin, _pv4.copy(origin).addScaledVector(dir, Math.min(dist, 60)));
    g.audio.gunshot('enemy_ar', origin, { gain: 1 });
    g.emitNoise(origin, 60, 'enemy_shot');

    // resolve: player box vs world
    const pboxMin = _pv5.set(player.pos.x - 0.34, player.pos.y, player.pos.z - 0.34);
    const pboxMax = _pv6.set(player.pos.x + 0.34, player.pos.y + THREE.MathUtils.lerp(1.8, 1.2, player.crouchT), player.pos.z + 0.34);
    const local = { x: 0, y: 0, z: 0, dist: 0 };
    const dPlayer = rayAABBLocal(origin, dir, pboxMin, pboxMax, dist + 1, local);
    const worldHit = g.physics.raycast(origin, dir, dPlayer !== null ? dPlayer : dist + 2);

    if (dPlayer !== null && (!worldHit || dPlayer < worldHit.dist)) {
      // glass between? bullet still reaches — but shatter panes on the way
      if (worldHit && worldHit.collider.breakable && worldHit.dist < dPlayer) {
        g.world.breakGlass(worldHit.collider);
        g.particles.glassBurst(worldHit.point, worldHit.normal);
      }
      const hy = local.y / THREE.MathUtils.lerp(1.8, 1.2, player.crouchT);
      const lateral = Math.max(Math.abs(local.x - player.pos.x), Math.abs(local.z - player.pos.z));
      let zone = 'legs';
      if (hy > 0.84) zone = 'head';
      else if (hy > 0.5) zone = lateral > 0.3 ? 'arms' : 'torso';
      else if (hy > 0.42) zone = lateral > 0.3 ? 'arms' : 'torso';
      const dmg = (8 + Math.random() * 6) * ZONE_MULT[zone];
      player.damage(zone, dmg, this.pos.clone());
      g.particles.impact(_pv4.copy(origin).addScaledVector(dir, dPlayer), dir.clone().negate(), 'fabric', 0.5);
    } else if (worldHit) {
      if (worldHit.collider.breakable) {
        g.world.breakGlass(worldHit.collider);
        g.particles.glassBurst(worldHit.point, worldHit.normal);
      } else {
        g.onWorldImpact(worldHit.point, worldHit.normal, worldHit.collider.material, 1.0);
      }
    }
    // rounds cracking past = suppression even when they miss
    const hx = player.pos.x - origin.x, hy = player.pos.y + 1.45 - origin.y, hz = player.pos.z - origin.z;
    const tt = hx * dir.x + hy * dir.y + hz * dir.z;
    if (tt > 0 && tt < dist + 2) {
      const mx = hx - dir.x * tt, my = hy - dir.y * tt, mz = hz - dir.z * tt;
      if (mx * mx + my * my + mz * mz < 1.9) player.addSuppress(0.28);
    }
  }

  // =========================================================================
  damageTaken(zone, amount, point, dir, manager) {
    if (!this.alive) return;
    const g = this.game;
    this.health -= amount * ZONE_MULT[zone];
    this.flinchT = zone === 'head' ? 1.4 : 0.9;
    this.flinchDir.copy(dir).setY(0).normalize();

    if (zone === 'legs') this.legHitT = 4.5;
    if (zone === 'arms') this.armHitT = 4;

    // being shot is a very loud, very clear stimulus
    if (this.state !== 'combat') {
      this._spotPlayer(manager, null);
    } else {
      this.lastSeenT = Math.max(this.lastSeenT, g.time - 2);
      this.windupT = Math.min(this.windupT, 0.2);
    }
    this.lastKnown.copy(g.player.pos);
    this.lastKnownValid = true;
    manager.onAllyShot(this, g.player.pos);

    // knockback stagger
    this.vel.addScaledVector(this.flinchDir, zone === 'head' ? 0.6 : 1.4);

    if (this.health <= 0) {
      this.health = 0;
      this.die(point, dir);
      return true; // killed
    }
    return false;
  }

  die(point, dir) {
    this.alive = false;
    this.deathT = 0.001;
    this.deathYaw = this.model.root.rotation.y;
    this.deathAxis.set(dir.x, 0, dir.z).normalize();
    if (this.deathAxis.lengthSq() < 0.1) this.deathAxis.set(0, 0, 1);
    this.game.audio.radioSquelch(this.pos.clone().setY(this.pos.y + 1.2));
    this.game.audio.impact('fabric', this.pos.clone().setY(this.pos.y + 0.9), 0.8);
    this.game.particles.impact(
      point || this.pos.clone().setY(this.pos.y + 1.2),
      dir ? dir.clone().negate() : new THREE.Vector3(0, 1, 0),
      'fabric', 0.7
    );
    void point;
  }

  _updateDeath(dt) {
    this.deathT = Math.min(1, this.deathT + dt * 2.6);
    const root = this.model.root;
    // topple around the hit axis
    const ang = this.deathT * Math.PI * 0.48;
    root.rotation.set(0, this.deathYaw !== undefined ? this.deathYaw : this.yaw, 0);
    root.rotateOnWorldAxis(this.deathAxis, ang);
    root.position.y = this.pos.y - this.deathT * 0.18;
    if (this.deathT >= 1) {
      this.sinkT += dt;
      if (this.sinkT > 30) {
        // let the scene stay tidy: slowly sink long-dead bodies out of sight
        root.position.y -= dt * 0.05;
      }
    }
  }

  // =========================================================================
  _setMoveTarget(target, arriveDist = 1.0, speed = 1.6) {
    if (!target) { this._wish.set(0, 0, 0); this.moveSpeed = 0; return true; }
    const to = _pv1.set(target.x - this.pos.x, 0, target.z - this.pos.z);
    const dist = to.length();
    if (dist < arriveDist) { this._wish.set(0, 0, 0); this.moveSpeed = 0; return true; }
    to.normalize();

    // whisker avoidance: probe ahead, steer around blockers
    const probeLen = 1.6 + speed * 0.35;
    const eye = this.eyePos(_pv2);
    const ahead = _pv3.copy(eye).addScaledVector(to, probeLen * 0.6);
    ahead.y = this.pos.y + 0.7;
    const hit = this.game.physics.raycast(_pv4.copy(eye).setY(this.pos.y + 0.7), to, probeLen);
    void ahead;
    if (hit && hit.dist < probeLen) {
      // choose the more open side
      const left = _pv5.set(-to.z, 0, to.x);
      const hitL = this.game.physics.raycast(_pv4.copy(eye).setY(this.pos.y + 0.7), left, probeLen * 0.8);
      const dL = hitL ? hitL.dist : probeLen;
      const dR = (() => {
        const right = _pv6.set(to.z, 0, -to.x);
        const h = this.game.physics.raycast(_pv4.copy(eye).setY(this.pos.y + 0.7), right, probeLen * 0.8);
        return h ? h.dist : probeLen;
      })();
      const side = dL > dR ? left : _pv6.set(to.z, 0, -to.x);
      const blend = THREE.MathUtils.clamp(1 - hit.dist / probeLen, 0.25, 1);
      to.addScaledVector(side, blend * 1.35).normalize();
    }

    // yaw follows movement when not aiming at the player
    if (this.state !== 'combat' || !this.hasLOS) {
      const targetYaw = Math.atan2(-to.x, -to.z);
      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += THREE.MathUtils.clamp(diff, -5 * 0.016, 5 * 0.016) * 2.2;
    }

    this._wish.copy(to).multiplyScalar(speed * this.speedScale * (this.legHitT > 0 ? 0.6 : 1));
    this.moveSpeed = this._wish.length();
    return false;
  }

  _move(dt) {
    // gravity + integrate with collision (same solver as the player)
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    // damping on knockback impulses
    this.vel.x *= Math.exp(-6 * dt);
    this.vel.z *= Math.exp(-6 * dt);

    const dx = (this._wish.x + this.vel.x) * dt;
    const dz = (this._wish.z + this.vel.z) * dt;
    const dy = this.vel.y * dt;

    this._syncBox();
    this.game.physics.moveBox(this.box, dx, dy, dz, this._moveOut, this.onGround ? 0.42 : 0);
    this.pos.set(this.box.min.x + 0.32, this.box.min.y, this.box.min.z + 0.32);
    this.onGround = this._moveOut.onGround;
    if (this._moveOut.hitCeil) this.vel.y = Math.min(0, this.vel.y);

    // stuck detection (patrol waypoints can be unreachable)
    const moved = this.pos.distanceTo(this.lastPos);
    this.lastPos.copy(this.pos);
    if (this.moveSpeed > 0.5 && moved < 0.004) {
      this.stuckT += dt;
      if (this.stuckT > 1.6) {
        this.stuckT = 0;
        if (this.state === 'patrol' && this.route) this.routeIdx = (this.routeIdx + 1) % this.route.length;
        else if (this.state === 'investigate' || this.state === 'search') { this._pickSearchPoint(); this.stateT = 0; }
        else this.combatAction = 'reposition';
      }
    } else this.stuckT = 0;

    // crouch blend
    const cTarget = this.crouching ? 1 : 0;
    this.crouchT = THREE.MathUtils.lerp(this.crouchT, cTarget, 1 - Math.exp(-10 * dt));
  }

  _animate(dt, manager) {
    void manager;
    const m = this.model;
    m.root.position.set(this.pos.x, this.pos.y, this.pos.z);

    // facing: aim yaw in combat, movement yaw otherwise
    const facing = this.state === 'combat' ? this.aimYaw : this.yaw;
    let d = facing - m.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    m.root.rotation.y += d * Math.min(1, 10 * dt);

    // crouch lowering
    m.body.position.y = -this.crouchT * 0.55;
    m.legs.scale.y = 1 - this.crouchT * 0.35;

    // walk cycle
    const speed = Math.hypot(this._wish.x, this._wish.z);
    this.walkPhase += dt * (2.2 + speed * 2.6);
    const swing = Math.sin(this.walkPhase * 2) * Math.min(0.62, 0.1 + speed * 0.14);
    m.legL.rotation.x = swing;
    m.legR.rotation.x = -swing;
    const bob = Math.abs(Math.cos(this.walkPhase * 2)) * Math.min(0.05, speed * 0.012);
    m.body.position.y += bob - (speed > 0.2 ? 0 : Math.sin(this.game.time * 1.6 + this.walkPhase) * 0.008);

    // arms / rifle: raised toward the target in combat, relaxed on patrol
    const aimT = this.state === 'combat' ? 1 : this.state === 'investigate' ? 0.55 : this.state === 'suspicious' ? 0.3 : 0.12;
    m.armL.rotation.x = THREE.MathUtils.lerp(m.armL.rotation.x, -1.35 * aimT + Math.sin(this.walkPhase * 2) * 0.35 * (1 - aimT), Math.min(1, 8 * dt));
    m.armR.rotation.x = THREE.MathUtils.lerp(m.armR.rotation.x, -1.15 * aimT - Math.sin(this.walkPhase * 2) * 0.35 * (1 - aimT), Math.min(1, 8 * dt));
    m.rifle.rotation.x = THREE.MathUtils.lerp(m.rifle.rotation.x, 0.1 + aimT * 0.06 + (this.crouchT * 0.1), Math.min(1, 8 * dt));
    m.rifle.position.y = THREE.MathUtils.lerp(m.rifle.position.y, 0.24 + aimT * 0.06, Math.min(1, 8 * dt));

    // torso pitch when aiming + slight yaw toward aim
    const pitchTo = this.state === 'combat' ? THREE.MathUtils.clamp((this.game.player.pos.y + 1.1 - (this.pos.y + 1.3)) / Math.max(2, this.pos.distanceTo(this.game.player.pos)), -0.3, 0.3) : 0;
    m.torso.rotation.x = THREE.MathUtils.lerp(m.torso.rotation.x, -pitchTo * (this.crouching ? 0.5 : 1), Math.min(1, 6 * dt));

    // head scan when not engaged
    if (this.state !== 'combat') {
      m.headGrp.rotation.y = Math.sin(this.game.time * 0.7 + this.walkPhase) * 0.5;
    } else {
      m.headGrp.rotation.y = THREE.MathUtils.lerp(m.headGrp.rotation.y, 0, Math.min(1, 6 * dt));
    }

    // flinch reaction
    if (this.flinchT > 0) {
      const f = Math.sin(this.flinchT * 24) * this.flinchT * 0.14;
      m.torso.rotation.z = f;
      m.headGrp.rotation.z = f * 1.6;
    } else {
      m.torso.rotation.z = THREE.MathUtils.lerp(m.torso.rotation.z, 0, Math.min(1, 6 * dt));
      m.headGrp.rotation.z = THREE.MathUtils.lerp(m.headGrp.rotation.z, 0, Math.min(1, 6 * dt));
    }

    // faction strobe blink
    m.strobe.visible = Math.sin(this.game.time * 3 + this.walkPhase) > 0.2;
  }
}

// ---------------------------------------------------------------------------
// Manager: spawning, squad coordination, noise distribution
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Civilian / friendly NPC — wanders waypoints, flees gunfire, can be escorted
// ---------------------------------------------------------------------------
class NPC {
  constructor(manager, spawn, index) {
    this.manager = manager;
    this.game = manager.game;
    this.kind = spawn.kind;                     // 'contact' | 'civ'
    this.pos = spawn.pos.clone();
    this.yaw = Math.random() * Math.PI * 2;
    this.state = 'wander';                      // wander | follow | flee
    this.waypoints = spawn.waypoints.length ? spawn.waypoints : [spawn.pos.clone()];
    this.wpIdx = 0;
    this.pauseT = Math.random() * 2;
    this.walkPhase = Math.random() * 6;
    this.fleeT = 0;
    this.fleeDir = new THREE.Vector3();
    this.contacted = false;

    const tone = index % 2 === 0 ? 0x4d5a68 : 0x6b5d4a;   // jacket colour variance
    const mats = {
      cloth: new THREE.MeshStandardMaterial({ color: tone, roughness: 0.95 }),
      vest: new THREE.MeshStandardMaterial({ color: this.kind === 'contact' ? 0x53412e : 0x3d4650, roughness: 0.9 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.9 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x9a7a5e, roughness: 0.9 }),
      helmet: new THREE.MeshStandardMaterial({ color: this.kind === 'contact' ? 0x4a3b2a : 0x33383f, roughness: 0.85 }),
      gun: manager.mats.gun,
      strobe: manager.mats.strobe,
    };
    this.model = buildEnemyModel(mats);
    this.model.rifle.visible = false;
    this.model.strobe.visible = false;
    this.model.root.position.copy(this.pos);
    manager.group.add(this.model.root);

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._wish = new THREE.Vector3();
    this._syncBox();
  }

  _syncBox() {
    this.box.min.set(this.pos.x - 0.3, this.pos.y, this.pos.z - 0.3);
    this.box.max.set(this.pos.x + 0.3, this.pos.y + 1.78, this.pos.z + 0.3);
  }

  contact() {
    if (this.contacted) return;
    this.contacted = true;
    this.state = 'follow';
    this.pauseT = 0;
    this.game.ui.radio('SURVIVOR: "You came — take me south, to the road bend. Quickly."');
    this.game.audio.pickup(this.pos);
  }

  hear(pos, radius, kind) {
    if (this.state === 'follow') return;                 // escorted NPC stays with player
    if (kind !== 'shot' && kind !== 'glass' && kind !== 'explosion' && kind !== 'impact') return;
    if (this.pos.distanceToSquared(pos) > (radius + 6) * (radius + 6)) return;
    this.fleeDir.copy(this.pos).sub(pos);
    this.fleeDir.y = 0;
    if (this.fleeDir.lengthSq() < 0.01) this.fleeDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.fleeDir.normalize();
    this.fleeDir.x += (Math.random() - 0.5) * 0.6;
    this.fleeDir.z += (Math.random() - 0.5) * 0.6;
    this.fleeDir.normalize();
    this.fleeT = 4 + Math.random() * 3;
    this.state = 'flee';
  }

  update(dt) {
    const speed = this.state === 'flee' ? 4.4 : this.state === 'follow' ? 2.6 : 1.4;
    this._wish.set(0, 0, 0);

    if (this.state === 'wander') {
      if (this.pauseT > 0) this.pauseT -= dt;
      else {
        const wp = this.waypoints[this.wpIdx];
        const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.7) {
          this.wpIdx = (this.wpIdx + 1) % this.waypoints.length;
          this.pauseT = 1.6 + Math.random() * 3;
        } else {
          this._wish.set(dx / d, 0, dz / d);
        }
      }
    } else if (this.state === 'follow') {
      const p = this.game.player.pos;
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.1) {
        const s = Math.min(1, (d - 2.1) / 6);            // ease up to a jog when far behind
        this._wish.set(dx / d * (0.6 + 0.4 * s), 0, dz / d * (0.6 + 0.4 * s));
      }
    } else if (this.state === 'flee') {
      this._wish.copy(this.fleeDir);
      this.fleeT -= dt;
      if (this.fleeT <= 0) this.state = 'wander';
    }

    const sp = this._wish.length();
    if (sp > 0.01) {
      this._wish.normalize();
      this.yaw = Math.atan2(-this._wish.x, -this._wish.z);
    }
    const step = speed * dt;
    this._syncBox();
    this.game.physics.moveBox(this.box, this._wish.x * step, -2.4 * dt, this._wish.z * step, this._moveOut, 0.4);
    this.pos.set(
      (this.box.min.x + this.box.max.x) / 2,
      this.box.min.y,
      (this.box.min.z + this.box.max.z) / 2
    );

    // presentation
    const m = this.model;
    m.root.position.copy(this.pos);
    let dyaw = this.yaw - m.root.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    m.root.rotation.y += dyaw * Math.min(1, 8 * dt);
    this.walkPhase += dt * (2 + sp * speed * 2.4);
    const swing = Math.sin(this.walkPhase * 2) * Math.min(0.6, 0.08 + sp * speed * 0.13);
    m.legL.rotation.x = swing;
    m.legR.rotation.x = -swing;
    m.armL.rotation.x = Math.sin(this.walkPhase * 2) * 0.3 * sp;
    m.armR.rotation.x = -Math.sin(this.walkPhase * 2) * 0.3 * sp;
    m.body.position.y = Math.abs(Math.cos(this.walkPhase * 2)) * 0.03 * sp;
  }
}

export class EnemyManager {
  constructor(game) {
    this._recoverT = 0;
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);

    this.mats = {
      cloth: new THREE.MeshStandardMaterial({ color: 0x35392f, roughness: 0.95 }),
      vest: new THREE.MeshStandardMaterial({ color: 0x26291f, roughness: 0.8, metalness: 0.1 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.9 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x8a6a52, roughness: 0.9 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0x2b2f26, roughness: 0.6, metalness: 0.2 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.45, metalness: 0.6 }),
      strobe: new THREE.MeshStandardMaterial({ color: 0x331111, emissive: 0xd02020, emissiveIntensity: 1.4 }),
    };

    this.npcs = [];
    this.escortComplete = false;
    this.escortNpc = null;
    this.squadAlert = 0;             // 0..1 shared alert level
    this.squadLastKnown = new THREE.Vector3();
    this.squadLastKnownT = -99;
    this.surgeQueue = 0;
    this.surgeTimer = 0;
    this.kills = 0;
    this._noiseScratch = { pos: new THREE.Vector3(), radius: 0, kind: '' };
  }

  reset() {
    for (const e of this.list) {
      this.group.remove(e.model.root);
      e.model.root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.list.length = 0;
    for (const n of this.npcs) {
      this.group.remove(n.model.root);
      n.model.root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.npcs.length = 0;
    this.escortComplete = false;
    this.escortNpc = null;
    const wi = this.game.world.interactables;
    const ni = wi.findIndex(i => i.id === 'npc_contact');
    if (ni >= 0) wi.splice(ni, 1);
    this.squadAlert = 0;
    this.squadLastKnownT = -99;
    this.surgeQueue = 0;
    this.surgeTimer = 0;
    this.kills = 0;
  }

  spawnInitial() {
    for (const s of this.game.world.enemySpawns) {
      s.flash = this.list.length % 3 === 0;
      this.list.push(new Enemy(this.game, s, s.kind, this.list.length * 7919 + 13));
    }
  }

  /** civilians + escort contacts authored in world.npcSpawns */
  spawnNPCs() {
    const spawns = this.game.world.npcSpawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const npc = new NPC(this, spawns[i], i);
      this.npcs.push(npc);
      if (npc.kind === 'contact') {
        this.escortNpc = npc;
        this.game.world.interactables.push({
          id: 'npc_contact',
          pos: npc.pos.clone().setY(npc.pos.y + 1.2),
          radius: 2.4,
          prompt: 'SPEAK TO THE SURVIVOR',
          getPrompt: () => 'SPEAK TO THE SURVIVOR',
          hold: 0.6,
          used: false,
          reusable: false,
          npc,
          action: () => { npc.contact(); return true; },
        });
      }
    }
  }

  get activeHostiles() {
    let n = 0;
    for (const e of this.list) if (e.alive && !e.surrendered) n++;
    return n;
  }

  /** lob a frag toward the player's predicted position */
  throwGrenade(by) {
    const g = this.game;
    const T = 1.15;
    const target = _pv1.copy(g.player.pos).addScaledVector(g.player.vel, 0.55);
    const from = _pv2.copy(by.pos).setY(by.pos.y + 1.5);
    const vel = _pv3.copy(target).sub(from).divideScalar(T);
    vel.y += 0.5 * 9.81 * T;
    g.spawnGrenade(from.clone(), vel.clone(), by);
    g.ui.radio('HOSTILE GRENADE INBOUND');
  }

  /** Queue reinforcements; they materialise at spawn points far from the player. */
  queueSurge(count, delay = 0) {
    this.surgeQueue += count;
    this.surgeTimer = Math.max(this.surgeTimer, delay);
  }

  _trySpawnSurge(dt) {
    if (this.surgeQueue <= 0) return;
    this.surgeTimer -= dt;
    if (this.surgeTimer > 0) return;
    this.surgeTimer = 2.5 + Math.random() * 3;

    const g = this.game;
    const spawns = g.world.surgeSpawns;
    if (!spawns.length) { this.surgeQueue = 0; return; }
    // pick a spawn far from the player without LOS
    for (let tries = 0; tries < spawns.length * 2; tries++) {
      const s = spawns[Math.floor(Math.random() * spawns.length)];
      const d = s.pos.distanceTo(g.player.pos);
      if (d < 30) continue;
      const eye = _pv1.set(s.pos.x, s.pos.y + 1.6, s.pos.z);
      const pEye = _pv2.set(g.player.pos.x, g.player.pos.y + 1.2, g.player.pos.z);
      if (g.physics.hasLOS(eye, pEye)) continue;
      const e = new Enemy(g, { pos: s.pos.clone(), route: null }, 'surge', Math.floor(Math.random() * 1e6));
      e.state = 'investigate';
      e.lastKnown.copy(this.squadLastKnownT > -50 ? this.squadLastKnown : g.player.pos);
      e.lastKnownValid = true;
      this.list.push(e);
      this.surgeQueue--;
      return;
    }
  }

  shareLastKnown(pos, by) {
    this.squadLastKnown.copy(pos);
    this.squadLastKnownT = this.game.time;
    this.squadAlert = 1;
    void by;
  }

  /** An enemy visually confirmed the player: shout to the squad. */
  onPlayerSpotted(by, quiet = false) {
    const g = this.game;
    this.shareLastKnown(g.player.pos, by);
    if (quiet) return;
    // radio shout — nearby allies switch to combat/investigate toward the player
    g.audio.radioSquelch(by.pos.clone().setY(by.pos.y + 1.3));
    if (by.chatterCd <= 0) {
      by.chatterCd = 9;
      const lines = ['CONTACT — MOVING TO ENGAGE', 'HE\'S IN THE OPEN', 'CHECK LAST POSITION', 'SUPPRESSING, KEEP LOW'];
      g.ui.radio(lines[Math.floor(Math.random() * lines.length)]);
    }
    for (const e of this.list) {
      if (e === by || !e.alive) continue;
      if (e.pos.distanceTo(by.pos) < 34) {
        if (e.state === 'patrol' || e.state === 'suspicious') {
          e.lastKnown.copy(g.player.pos);
          e.lastKnownValid = true;
          e.state = 'investigate';
          e.stateT = 0;
        }
      }
    }
    g.onAlarmRaised();
  }

  /** Gunfire near allies raises everyone. */
  onAllyShot(victim, shooterGuess) {
    for (const e of this.list) {
      if (!e.alive || e === victim) continue;
      if (e.pos.distanceTo(victim.pos) < 40 && e.state !== 'combat') {
        e.lastKnown.copy(shooterGuess);
        e.lastKnownValid = true;
        if (e.state === 'patrol' || e.state === 'suspicious') { e.state = 'investigate'; e.stateT = 0; }
      }
    }
    this.squadAlert = 1;
  }

  combatTimeout(e) {
    // one enemy giving up slowly calms the squad
    this.squadAlert = Math.max(0, this.squadAlert - 0.15);
    void e;
  }

  /** Global noise dispatch from game.emitNoise. */
  hearNoise(pos, radius, kind) {
    this._noiseScratch.pos.copy(pos);
    this._noiseScratch.radius = radius;
    this._noiseScratch.kind = kind;
    for (const e of this.list) {
      if (!e.alive) continue;
      // cheap squared-distance gate before per-enemy logic
      if (e.pos.distanceToSquared(pos) > (radius + 5) * (radius + 5)) continue;
      e.hear(this._noiseScratch, this);
    }
    for (const n of this.npcs) n.hear(pos, radius, kind);
  }

  damage(enemy, zone, amount, point, dir) {
    const killed = enemy.damageTaken(zone, amount, point, dir, this);
    const g = this.game;
    g.ui.hitMarker(killed);
    g.audio.hitMarker(killed);
    if (killed) {
      this.kills++;
      g.stats.kills++;
    }
  }

  /** squad-wide alert state for the minimal HUD readout */
  get alertLevel() {
    const g = this.game;
    let lvl = 'unaware';
    for (const e of this.list) {
      if (!e.alive || e.surrendered) continue;
      if (e.state === 'combat') { this._recoverT = 18; return 'combat'; }
      if (e.state === 'search') lvl = 'searching';
      else if (e.state === 'investigate' && lvl !== 'searching') lvl = 'investigating';
      else if (e.state === 'suspicious' && lvl === 'unaware') lvl = 'suspicious';
    }
    if (lvl !== 'unaware') return lvl;
    if (g.stats && g.stats.alarm) return 'alert';
    if (this._recoverT > 0) return 'recovering';
    return 'unaware';
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  update(dt) {
    this._recoverT = Math.max(0, this._recoverT - dt);
    this.squadAlert = Math.max(0, this.squadAlert - dt * 0.02);
    this.game.audio.alertLevel = this.squadAlert;
    this._trySpawnSurge(dt);
    for (let i = 0; i < this.list.length; i++) {
      this.list[i].update(dt, this);
    }
    if (this.npcs.length) {
      for (const n of this.npcs) n.update(dt);
      const wi = this.game.world.interactables;
      for (const it of wi) {
        if (it.id === 'npc_contact' && it.npc) it.pos.copy(it.npc.pos).setY(it.npc.pos.y + 1.2);
      }
      if (this.escortNpc && this.escortNpc.contacted && !this.escortComplete) {
        const lz = this.game.world.triggers.find(t => t.id === 'extraction' && t.center);
        if (lz && this.escortNpc.pos.distanceToSquared(lz.center) < 25) {
          this.escortComplete = true;
          this.game.ui.radio('SURVIVOR: "This is far enough — signal them. Thank you."');
          this.game.audio.pickup(this.escortNpc.pos);
        }
      }
    }
  }
}

// scratch vectors (module-level, reused — never captured across calls)
const _pv1 = new THREE.Vector3();
const _pv2 = new THREE.Vector3();
const _pv3 = new THREE.Vector3();
const _pv4 = new THREE.Vector3();
const _pv5 = new THREE.Vector3();
const _pv6 = new THREE.Vector3();

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
