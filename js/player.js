/**
 * player.js
 * First-person controller: acceleration-based movement, stances (stand /
 * crouch / sprint), lean, stamina, jump with fall damage, head bob, camera
 * recoil springs, injury modifiers and noise emission for the AI hearing
 * system. Deliberately "heavy": no instant acceleration, no superhuman jump.
 */
import * as THREE from 'three';

const EYE_STAND = 1.62;
const EYE_CROUCH = 0.92;
const BOX_H_STAND = 1.8;
const BOX_H_CROUCH = 1.2;
const BOX_R = 0.34;
const GRAVITY = 16.0;
const JUMP_VEL = 4.4;           // ≈0.6 m jump — modest, realistic
const STEP_HEIGHT = 0.42;       // auto step-up onto stairs / low props
const MAX_FALL_SAFE = 11.5;     // below this landing speed: no damage

export class Player {
  constructor(game) {
    this.game = game;

    this.pos = new THREE.Vector3();      // feet position
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };

    this.onGround = true;
    this.crouching = false;
    this.crouchT = 0;      // 0 stand → 1 crouch (animated)
    this.sprinting = false;
    this.lean = 0;         // -1 left, +1 right
    this.leanT = 0;

    this.health = 100;
    this.frags = 2;
    this.maxHealth = 100;
    this.stamina = 100;
    this.exhausted = false;
    this.staminaDelay = 0;

    this.speed = 0;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.landImpulse = 0;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;

    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.rollT = 0;

    this.legInjury = 0;    // seconds remaining
    this.armor = 50;       // plate: absorbs 65% of damage until it shreds
    this.bandageT = 0;
    this.bandageCd = 0;
    this.bandageCdRate = 1;
    this.mantleT = 0; this.mantleDur = 0.45;
    this.mantleFrom = new THREE.Vector3();
    this.mantleTo = new THREE.Vector3();
    this.armInjury = 0;
    this.timeSinceDamage = 99;

    this.stepAccum = 0;
    this._groundMat = 'concrete';
    this._groundMatT = 0;

    this.headPos = new THREE.Vector3();
    this.viewDir = new THREE.Vector3();

    this.alive = true;
    this._tmp1 = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._tmp3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  reset(spawn, yaw, restore) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = 100;
    this.frags = 2;
    this.stamina = 100;
    this.exhausted = false;
    this.crouching = false;
    this.crouchT = 0;
    this.lean = 0; this.leanT = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.legInjury = 0; this.armInjury = 0;
    this.armor = 50;
    this.bandageT = 0; this.bandageCd = 0; this.mantleT = 0;
    this.timeSinceDamage = 99;
    this.landImpulse = 0;
    this.alive = true;
    this._syncBox();
    if (restore) {
      this.health = restore.health ?? 100;
      this.stamina = restore.stamina ?? 100;
    }
  }

  _syncBox() {
    const h = THREE.MathUtils.lerp(BOX_H_STAND, BOX_H_CROUCH, this.crouchT);
    this.box.min.set(this.pos.x - BOX_R, this.pos.y, this.pos.z - BOX_R);
    this.box.max.set(this.pos.x + BOX_R, this.pos.y + h, this.pos.z + BOX_R);
  }

  handlingMultiplier() {
    // arm injuries slow weapon handling (>1 = worse)
    return this.armInjury > 0 ? 1.35 : 1.0;
  }
  spreadMultiplier() {
    let m = 1;
    if (this.armInjury > 0) m *= 1.3;
    if (this.health < 30) m *= 1.15;
    // Stance matters: a crouched operator is braced, a leaning one is not.
    if (this.crouching) m *= 0.72;
    if (Math.abs(this.lean) > 0.4) m *= 1.12;
    return m;
  }

  /**
   * Weapon-pose stability. Lower = steadier. Used for view-model sway so a
   * braced stance visibly settles the weapon instead of only shrinking the
   * crosshair.
   */
  stabilityMultiplier() {
    let m = 1;
    if (this.crouching) m *= 0.7;                    // braced
    if (Math.abs(this.lean) > 0.4) m *= 1.15;        // off-axis
    if (!this.onGround) m *= 1.5;                    // no footing
    if (this.armInjury > 0) m *= 1.25;
    return m;
  }
  speedMultiplier() {
    let m = 1;
    if (this.legInjury > 0) m *= 0.62;
    if (this.health < 25) m *= 0.85;
    return m;
  }

  addRecoil(pitch, yaw) {
    this.recoilPitch = THREE.MathUtils.clamp(this.recoilPitch + pitch, -6 * THREE.MathUtils.DEG2RAD, 8 * THREE.MathUtils.DEG2RAD);
    this.recoilYaw = THREE.MathUtils.clamp(this.recoilYaw + yaw, -4 * THREE.MathUtils.DEG2RAD, 4 * THREE.MathUtils.DEG2RAD);
  }

  weaponBob() {
    // figure-eight style bob fed to the weapon rig
    const amp = this.bobAmp;
    return {
      x: Math.cos(this.bobPhase) * amp * 1.35,
      y: -Math.abs(Math.sin(this.bobPhase)) * amp * 1.6 + amp * 0.35,
    };
  }

  // -------------------------------------------------------------------------
  update(dt, input) {
    const g = this.game;
    if (!this.alive) {
      // death cam: slowly sink / tilt
      this.pitch = THREE.MathUtils.lerp(this.pitch, -0.5, 1 - Math.exp(-2 * dt));
      this.rollT = THREE.MathUtils.lerp(this.rollT, 0.9, 1 - Math.exp(-2 * dt));
      this._applyCamera();
      return;
    }

    // ---- look ----
    const sens = g.settings.sensitivity * 0.0022;
    this.lookDeltaX = input.lookX;
    this.lookDeltaY = input.lookY;
    this.yaw -= input.lookX * sens;
    this.pitch -= input.lookY * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.53, 1.53);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // ---- recoil recovery springs ----
    const rk = 1 - Math.exp(-7.5 * dt);
    this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, 0, rk);
    this.recoilYaw = THREE.MathUtils.lerp(this.recoilYaw, 0, rk * 1.2);

    // ---- stance ----
    const wantsCrouch = input.crouch;
    if (wantsCrouch !== this.crouching) {
      if (!wantsCrouch) {
        // stand-up headroom check
        const h = BOX_H_STAND;
        const min = this._tmp1.set(this.pos.x - BOX_R, this.pos.y + 0.02, this.pos.z - BOX_R);
        const max = this._tmp2.set(this.pos.x + BOX_R, this.pos.y + h, this.pos.z + BOX_R);
        const hits = g.physics.queryAABB(min, max, []);
        const blocked = hits.some(c => c.enabled && c.max.y > this.pos.y + BOX_H_CROUCH + 0.05);
        if (!blocked) this.crouching = false;
      } else {
        this.crouching = true;
      }
    }
    const crouchTarget = this.crouching ? 1 : 0;
    this.crouchT = THREE.MathUtils.lerp(this.crouchT, crouchTarget, 1 - Math.exp(-11 * dt));
    this._syncBox();

    // ---- lean ----
    const leanWant = (input.leanL ? -1 : 0) + (input.leanR ? 1 : 0);
    this.leanT = THREE.MathUtils.lerp(this.leanT, leanWant, 1 - Math.exp(-10 * dt));
    this.lean = this.leanT;

    // ---- stamina ----
    this.staminaDelay = Math.max(0, this.staminaDelay - dt);
    const ads = g.weapons.adsT > 0.5;
    const wantSprint = input.sprint && !this.crouching && !ads && input.moveF > 0.2 && this.stamina > 1 && !this.exhausted;
    this.sprinting = wantSprint && this.onGround;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - 17 * dt);
      this.staminaDelay = 1.1;
      if (this.stamina <= 0) this.exhausted = true;
    } else if (this.staminaDelay <= 0) {
      this.stamina = Math.min(100, this.stamina + (this.speed < 0.5 ? 15 : 9) * dt);
      if (this.exhausted && this.stamina > 40) this.exhausted = false;
    }

    // ---- movement wish ----
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    // camera faces -Z at yaw 0 → forward = (-sin? ) compute:
    const fwdX = -sinY, fwdZ = -cosY;
    const rightX = cosY, rightZ = -sinY;
    let wishX = fwdX * input.moveF + rightX * input.moveR;
    let wishZ = fwdZ * input.moveF + rightZ * input.moveR;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1) { wishX /= wishLen; wishZ /= wishLen; }

    let targetSpeed = 3.0;                                   // brisk walk
    if (this.crouching) targetSpeed = 1.15;
    else if (this.sprinting) targetSpeed = 5.6;
    if (ads && !this.crouching) targetSpeed = Math.min(targetSpeed, 1.75);
    if (Math.abs(this.lean) > 0.4) targetSpeed *= 0.78;
    targetSpeed *= g.weapons.def.handling || 1;
    targetSpeed *= this.speedMultiplier();
    if (wishLen < 0.05) targetSpeed = 0;
    else targetSpeed *= Math.min(1, wishLen);

    // accel / friction (ground)
    const horizVel = this._tmp1.set(this.vel.x, 0, this.vel.z);
    const curSpeed = horizVel.length();
    if (this.onGround) {
      const accel = this.sprinting ? 11 : 15;
      if (targetSpeed > 0.01) {
        // accelerate toward wish direction, but never above targetSpeed
        const desiredX = wishX * targetSpeed, desiredZ = wishZ * targetSpeed;
        let dvx = desiredX - this.vel.x, dvz = desiredZ - this.vel.z;
        const dvLen = Math.hypot(dvx, dvz);
        const maxDv = accel * dt;
        if (dvLen > maxDv) { dvx = dvx / dvLen * maxDv; dvz = dvz / dvLen * maxDv; }
        this.vel.x += dvx; this.vel.z += dvz;
        // clamp overspeed when slowing from sprint
        const nh = Math.hypot(this.vel.x, this.vel.z);
        const cap = Math.max(targetSpeed, curSpeed - 8 * dt);
        if (nh > cap) { this.vel.x *= cap / nh; this.vel.z *= cap / nh; }
      } else {
        // friction decel
        const drop = Math.max(curSpeed - 6 * dt, 0) / Math.max(curSpeed, 0.0001);
        this.vel.x *= drop; this.vel.z *= drop;
        if (curSpeed < 0.05) { this.vel.x = 0; this.vel.z = 0; }
      }
    } else {
      // air control — weak
      if (targetSpeed > 0.01) {
        this.vel.x += wishX * 2.2 * dt * targetSpeed;
        this.vel.z += wishZ * 2.2 * dt * targetSpeed;
      }
    }

    // ---- jump ----
    if (input.jumpPressed && this.onGround && !this.crouching && this.stamina > 8) {
      this.vel.y = JUMP_VEL;
      this.onGround = false;
      this.stamina -= 10;
      this.staminaDelay = 1.0;
      g.audio.jump(this.headPos);
      g.emitNoise(this.pos, this.sprinting ? 14 : 8, 'jump');
    }

    // gravity
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    // ---- integrate + collide ----
    const dx = this.vel.x * dt, dy = this.vel.y * dt, dz = this.vel.z * dt;
    const wasAir = !this.onGround;
    g.physics.moveBox(this.box, dx, dy, dz, this._moveOut, this.onGround ? STEP_HEIGHT : 0);
    this.pos.set(this.box.min.x + BOX_R, this.box.min.y, this.box.min.z + BOX_R);
    const out = this._moveOut;
    this.onGround = out.onGround;
    if (out.hitX) this.vel.x = 0;
    if (out.hitZ) this.vel.z = 0;
    if (out.hitCeil) this.vel.y = Math.min(0, this.vel.y);

    // ---- mantle / vault (ledges up to ~1.1 m) ----
    if (this.mantleT > 0) {
      this.mantleT -= dt;
      const k = 1 - Math.max(0, this.mantleT) / this.mantleDur;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.pos.lerpVectors(this.mantleFrom, this.mantleTo, e);
      this.pos.y += Math.sin(k * Math.PI) * 0.16;
      this.vel.set(0, 0, 0);
      this._syncBox();
      if (this.mantleT <= 0) this.onGround = true;
    } else if (out.onGround && (out.hitX || out.hitZ) && !this.crouching &&
               this.stamina > 14 && this.bandageT <= 0 &&
               (input.moveF > 0.3 || Math.abs(input.moveR) > 0.6)) {
      this._tryMantle(wishX, wishZ);
    }

    // landing
    if (wasAir && this.onGround) {
      const impactV = Math.abs(Math.min(0, dy / Math.max(dt, 0.0001)));
      this.landImpulse = THREE.MathUtils.clamp(impactV / 14, 0, 1.4);
      g.audio.land(this.headPos, impactV > 6);
      g.emitNoise(this.pos, impactV > 8 ? 16 : impactV > 4 ? 8 : 3, 'land');
      if (impactV > MAX_FALL_SAFE) {
        const dmg = (impactV - MAX_FALL_SAFE) * 7;
        this.damage('legs', dmg, null, true);
      }
      if (impactV > 2) {
        g.particles.footDust(this._tmp2.set(this.pos.x, this.pos.y + 0.05, this.pos.z), this._groundMaterial());
      }
    }
    this.landImpulse = Math.max(0, this.landImpulse - dt * 3.2);

    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // ---- footsteps / noise ----
    this._groundMatT -= dt;
    if (this.onGround && this.speed > 0.35) {
      const stride = this.sprinting ? 2.35 : this.crouching ? 1.3 : 1.85;
      this.stepAccum += this.speed * dt;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this._footstep();
      }
    } else {
      this.stepAccum = Math.min(this.stepAccum, 0.5);
    }

    // ---- head bob ----
    const bobTarget = this.onGround && this.speed > 0.4
      ? (this.sprinting ? 0.055 : this.crouching ? 0.018 : 0.032) * Math.min(1, this.speed / 3)
      : 0;
    this.bobAmp = THREE.MathUtils.lerp(this.bobAmp, bobTarget, 1 - Math.exp(-8 * dt));
    this.bobPhase += dt * (this.sprinting ? 11.5 : this.crouching ? 5.2 : 7.6) * Math.min(1.4, this.speed / 2.2 + 0.25);

    // ---- bandage hold (H): stop the clock on injuries + patch up ----
    this.bandageCd = Math.max(0, this.bandageCd - dt);
    if (input.bandageHeld && this.bandageCd <= 0 && this.mantleT <= 0 &&
        (this.armInjury > 0 || this.legInjury > 0 || this.health < 75)) {
      this.bandageT += dt;
      if (this.bandageT >= 2.8) {
        this.bandageT = 0;
        this.bandageCd = 12 * (this.bandageCdRate || 1);
        this.health = Math.min(100, this.health + 28);
        this.armInjury = 0;
        this.legInjury = 0;
        g.audio.impact('fabric', this.headPos, 0.5);
        g.ui.radio('FIELD DRESSING APPLIED');
      }
    } else {
      this.bandageT = Math.max(0, this.bandageT - dt * 2);
    }

    // ---- injuries / regen ----
    this.legInjury = Math.max(0, this.legInjury - dt);
    this.armInjury = Math.max(0, this.armInjury - dt);
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > 12 && this.health < 50 && this.health > 0) {
      this.health = Math.min(50, this.health + 2.4 * dt); // field stabilisation, partial only
    }

    this._applyCamera();

    // view vectors for interaction / AI
    g.camera.getWorldDirection(this.viewDir);
    this.headPos.set(this.pos.x, this.pos.y + this._eyeHeight(), this.pos.z);
  }

  _tryMantle(wishX, wishZ) {
    const g = this.game;
    const len = Math.hypot(wishX, wishZ);
    if (len < 0.05) return;
    const dx = wishX / len, dz = wishZ / len;
    // chest-high probe: anything taller than ~1.1 m is a wall, not a ledge
    const o1 = this._tmp1.set(this.pos.x + dx * 0.1, this.pos.y + 1.38, this.pos.z + dz * 0.1);
    const d1 = this._tmp2.set(dx, 0, dz);
    if (g.physics.raycast(o1, d1, 0.8)) return;
    // find the ledge surface just past the obstacle
    const p3 = this._tmp3.set(this.pos.x + dx * 0.75, this.pos.y + 1.5, this.pos.z + dz * 0.75);
    const hit = g.physics.raycast(p3, this._tmp2.set(0, -1, 0), 2.6);
    if (!hit) return;
    const ledgeY = hit.point.y;
    const rise = ledgeY - this.pos.y;
    if (rise < 0.32 || rise > 1.28) return;
    // headroom over the ledge
    const o4 = this._tmp1.set(p3.x, ledgeY + 0.35, p3.z);
    if (g.physics.raycast(o4, this._tmp2.set(dx, 0, dz), 0.55)) return;
    this.mantleFrom.copy(this.pos);
    this.mantleTo.set(this.pos.x + dx * 0.8, ledgeY + 0.02, this.pos.z + dz * 0.8);
    this.mantleT = this.mantleDur;
    this.stamina -= 9;
    this.staminaDelay = 0.7;
    this.onGround = false;
    g.audio.jump(this.headPos);
    g.emitNoise(this.pos, 6, 'mantle');
  }

  _eyeHeight() {
    return THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, this.crouchT);
  }

  _applyCamera() {
    const cam = this.game.camera;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.55;

    // lean: offset along the local right vector + roll
    const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    const leanOff = this.lean * 0.26;

    cam.position.set(
      this.pos.x + rightX * leanOff + (-Math.sin(this.yaw + Math.PI / 2)) * bobX * 0,
      this.pos.y + this._eyeHeight() + bobY,
      this.pos.z + rightZ * leanOff
    );
    // apply bob along the right axis too
    cam.position.x += rightX * bobX;
    cam.position.z += rightZ * bobX;

    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + this.recoilYaw;
    cam.rotation.x = THREE.MathUtils.clamp(this.pitch + this.recoilPitch, -1.55, 1.55);

    // roll: lean + slight strafe tilt + death tilt
    const strafeRoll = THREE.MathUtils.clamp(-this.vel.x * Math.cos(this.yaw) - this.vel.z * -Math.sin(this.yaw), -3, 3);
    const targetRoll = -this.lean * 0.055 + strafeRoll * 0.002 + this.rollT;
    this.rollT = this.alive ? THREE.MathUtils.lerp(this.rollT, 0, 0.1) : this.rollT;
    cam.rotation.z = THREE.MathUtils.lerp(cam.rotation.z || 0, targetRoll, 0.25);

    this.headPos.set(cam.position.x, cam.position.y, cam.position.z);
  }

  _groundMaterial() {
    if (this._groundMatT > 0) return this._groundMat;
    this._groundMatT = 0.35;
    const origin = this._tmp3.set(this.pos.x, this.pos.y + 0.15, this.pos.z);
    const hit = this.game.physics.raycast(origin, this._downDir || (this._downDir = new THREE.Vector3(0, -1, 0)), 0.8);
    this._groundMat = hit ? hit.collider.material : 'concrete';
    return this._groundMat;
  }

  _footstep() {
    const g = this.game;
    const mat = this._groundMaterial();
    const intensity = this.sprinting ? 1.25 : this.crouching ? 0.4 : 0.8;
    g.audio.footstep(mat, this._tmp2.set(this.pos.x, this.pos.y + 0.2, this.pos.z), intensity);
    if (!this.crouching || Math.random() < 0.4) {
      g.particles.footDust(this._tmp2.set(this.pos.x, this.pos.y + 0.04, this.pos.z), mat);
    }
    // AI hearing radii by gait (crouch-walking is nearly silent)
    let radius = 0;
    if (this.sprinting) radius = mat === 'metal' ? 26 : 18;
    else if (this.crouching) radius = mat === 'metal' ? 4 : 2.2;
    else radius = mat === 'metal' ? 13 : 8;
    g.emitNoise(this.pos, radius, 'footstep');
  }

  // -------------------------------------------------------------------------
  damage(zone, amount, fromPos, silent = false) {
    if (!this.alive || this.game.state !== 'playing') return;
    if (this.armor > 0 && amount > 0) {
      const absorbed = Math.min(this.armor, amount * 0.65);
      this.armor -= absorbed;
      amount -= absorbed;
      if (amount < 0.6) {
        this.timeSinceDamage = 0;
        this.game.ui.armorFlash();
        return;
      }
    }
    this.game.stats.damageTaken += amount;
    this.health -= amount;
    this.timeSinceDamage = 0;

    if (zone === 'legs') this.legInjury = Math.max(this.legInjury, 5.5);
    if (zone === 'arms') this.armInjury = Math.max(this.armInjury, 7);

    const g = this.game;
    if (!silent) g.audio.playerHurt();
    g.ui.playerDamaged(amount, fromPos, this.pos);

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      g.onPlayerDeath(fromPos ? 'hostile fire' : 'injuries');
    }
  }

  addSuppress(a) { this.game.suppress = Math.min(1, this.game.suppress + a); }

  resupplyAll(full = false) {
    this.frags = Math.min(3, (this.frags || 0) + 1);
    this.armor = Math.min(100, this.armor + 50);
    const ws = this.game.weapons;
    for (const id of Object.keys(ws.state)) {
      const def = ws.defs[id];
      ws.state[id].reserve = full ? def.reserveMax : Math.min(def.reserveMax, ws.state[id].reserve + Math.ceil(def.magSize * 2.5));
    }
  }

  // -------------------------------------------------------------------------
  snapshot() {
    return {
      pos: this.pos.toArray(),
      yaw: this.yaw,
      health: this.health,
      frags: this.frags,
      armor: this.armor,
      stamina: this.stamina,
      ammo: JSON.parse(JSON.stringify(this.game.weapons.state)),
      weapon: this.game.weapons.currentId,
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return;
    this.reset(new THREE.Vector3().fromArray(snap.pos), snap.yaw, { health: snap.health, stamina: snap.stamina });
    this.frags = snap.frags != null ? snap.frags : 2;
    this.armor = snap.armor != null ? snap.armor : 50;
    const ws = this.game.weapons;
    Object.assign(ws.state, JSON.parse(JSON.stringify(snap.ammo)));
    ws.currentId = snap.weapon || 'vx4';
    for (const m of Object.values(ws.models)) m.visible = false;
    ws.models[ws.currentId].visible = true;
    ws.state_ = 'ready';
    if (ws.rebuildOwned) ws.rebuildOwned();
  }
}
