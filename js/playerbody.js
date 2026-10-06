/**
 * playerbody.js
 *
 * A real, rigged character representation for the operator: head, torso,
 * pelvis, arms (upper/lower), hands, legs (upper/lower) and boots, plus an
 * anchor for a third-person weapon.
 *
 * The SAME rig is used everywhere there is a camera that can see the operator
 * (first-person body awareness, vehicle chase camera), so there is never a
 * second contradictory player state.
 *
 * Performance notes:
 *  - geometry and materials are created once and shared by every limb
 *  - the update path allocates nothing (all scratch vectors are preallocated)
 *  - shadow casting is enabled per-mesh and follows the quality setting
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

// Proportions are in metres, derived from the gameplay constants so the rig and
// the camera agree:
//   pelvis 0.78 + torso offset 0.10 + torso 0.52 + neck 0.10 + head/2 0.12
//     = 1.62  -> exactly Player.EYE_STAND, so the camera sits at eye level with
//                the whole torso BELOW it (no near-plane clipping, no occlusion).
//   feet land on y = 0 and the helmet tops out at ~1.75, matching BOX_H_STAND.
const LEG_UPPER = 0.37;
const LEG_LOWER = 0.33;
const TORSO_H = 0.52;
const PELVIS_H = 0.20;
const HEAD_H = 0.24;
const ARM_UPPER = 0.28;
const ARM_LOWER = 0.26;
const PELVIS_LIFT = 0.08;   // pelvis rest height above the ankle joint

export class PlayerBody {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'player-body';
    this.built = false;
    this.thirdPerson = false;
    this.visible = true;

    // scratch — never reallocated
    this._v1 = new THREE.Vector3();
    this._walkPhase = 0;
    this._leanT = 0;
    this._crouchT = 0;
    this._sprintT = 0;
    this._adsT = 0;
    this._airT = 0;
    this._lastSpeed = 0;

    this._mats = {};
    this._geos = [];
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------
  _mat(key, color, rough = 0.85, metal = 0.05) {
    if (!this._mats[key]) {
      this._mats[key] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    }
    return this._mats[key];
  }

  _box(w, h, d) {
    const g = new THREE.BoxGeometry(w, h, d);
    this._geos.push(g);
    return g;
  }

  _mesh(geo, mat, cast = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = false;
    return m;
  }

  build() {
    if (this.built) return;
    this.built = true;

    const suit = this._mat('suit', 0x3a4238, 0.92, 0.02);
    const vest = this._mat('vest', 0x2b3129, 0.88, 0.06);
    const skin = this._mat('skin', 0x9a7d63, 0.95, 0.0);
    const gear = this._mat('gear', 0x1f2420, 0.8, 0.15);
    const boot = this._mat('boot', 0x171a17, 0.9, 0.05);

    // ---- root: feet on the ground, +Z is "behind" -------------------------
    // The pelvis is the animated pivot; everything hangs off it so crouching
    // lowers the whole upper body without distorting limb lengths.
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = LEG_UPPER + LEG_LOWER + PELVIS_LIFT;   // 0.78 m at rest
    this.root.add(this.pelvis);

    // torso
    this.torso = new THREE.Group();
    this.torso.position.y = PELVIS_H * 0.5;
    this.pelvis.add(this.torso);

    const chest = this._mesh(this._box(0.46, TORSO_H, 0.26), vest);
    chest.position.y = TORSO_H * 0.5;
    this.torso.add(chest);

    // plate carrier — thin slab, reads as tactical without extra geometry
    const plate = this._mesh(this._box(0.40, 0.34, 0.10), gear);
    plate.position.set(0, TORSO_H * 0.55, -0.17);
    this.torso.add(plate);

    const belt = this._mesh(this._box(0.44, 0.09, 0.24), gear);
    belt.position.y = 0.04;
    this.torso.add(belt);

    // shoulders + neck
    const neck = this._mesh(this._box(0.14, 0.10, 0.14), skin);
    neck.position.y = TORSO_H + 0.02;
    this.torso.add(neck);

    // ---- head --------------------------------------------------------------
    this.head = new THREE.Group();
    this.head.position.y = TORSO_H + 0.10 + HEAD_H * 0.5;
    this.torso.add(this.head);

    const skull = this._mesh(this._box(0.21, HEAD_H, 0.22), skin);
    this.head.add(skull);
    const helmet = this._mesh(this._box(0.235, 0.14, 0.245), gear);
    helmet.position.y = 0.06;
    this.head.add(helmet);
    const visor = this._mesh(this._box(0.17, 0.05, 0.03), this._mat('visor', 0x121614, 0.35, 0.5));
    visor.position.set(0, 0.01, -0.115);
    this.head.add(visor);

    // ---- arms --------------------------------------------------------------
    this.armL = this._buildArm(suit, gear, skin, -1);
    this.armR = this._buildArm(suit, gear, skin, 1);
    this.armL.group.position.set(-0.27, TORSO_H - 0.06, 0);
    this.armR.group.position.set(0.27, TORSO_H - 0.06, 0);
    this.torso.add(this.armL.group);
    this.torso.add(this.armR.group);

    // third-person weapon anchor (right hand)
    this.handAnchor = new THREE.Object3D();
    this.handAnchor.position.set(0, -ARM_LOWER - 0.04, -0.06);
    this.armR.lower.add(this.handAnchor);

    // ---- legs (hang off pelvis, not torso, so crouch reads correctly) -----
    this.legL = this._buildLeg(suit, boot, -1);
    this.legR = this._buildLeg(suit, boot, 1);
    this.legL.group.position.set(-0.12, 0, 0);
    this.legR.group.position.set(0.12, 0, 0);
    this.pelvis.add(this.legL.group);
    this.pelvis.add(this.legR.group);

    this.setThirdPerson(false);
  }

  _buildArm(suit, gear, skin, side) {
    const group = new THREE.Group();
    const upper = new THREE.Group();
    group.add(upper);
    const upperMesh = this._mesh(this._box(0.13, ARM_UPPER, 0.13), suit);
    upperMesh.position.y = -ARM_UPPER * 0.5;
    upper.add(upperMesh);
    const pad = this._mesh(this._box(0.155, 0.10, 0.155), gear);
    pad.position.y = -0.06;
    upper.add(pad);

    const lower = new THREE.Group();
    lower.position.y = -ARM_UPPER;
    upper.add(lower);
    const lowerMesh = this._mesh(this._box(0.115, ARM_LOWER, 0.115), suit);
    lowerMesh.position.y = -ARM_LOWER * 0.5;
    lower.add(lowerMesh);

    const hand = this._mesh(this._box(0.10, 0.12, 0.12), skin);
    hand.position.y = -ARM_LOWER - 0.04;
    lower.add(hand);

    group.rotation.z = side * 4 * DEG;   // slight outward rest pose
    return { group, upper, lower, hand, side };
  }

  _buildLeg(suit, boot, side) {
    const group = new THREE.Group();
    const upper = new THREE.Group();
    group.add(upper);
    const upperMesh = this._mesh(this._box(0.16, LEG_UPPER, 0.16), suit);
    upperMesh.position.y = -LEG_UPPER * 0.5;
    upper.add(upperMesh);

    const lower = new THREE.Group();
    lower.position.y = -LEG_UPPER;
    upper.add(lower);
    const lowerMesh = this._mesh(this._box(0.14, LEG_LOWER, 0.14), suit);
    lowerMesh.position.y = -LEG_LOWER * 0.5;
    lower.add(lowerMesh);

    const foot = this._mesh(this._box(0.15, 0.10, 0.26), boot);
    foot.position.set(0, -LEG_LOWER - 0.03, -0.04);
    lower.add(foot);

    return { group, upper, lower, foot, side };
  }

  // -------------------------------------------------------------------------
  // Visibility / mode
  // -------------------------------------------------------------------------
  /**
   * First person hides the head (the camera lives inside it) to guarantee no
   * near-plane clipping. Third person shows the complete operator.
   */
  setThirdPerson(on) {
    if (!this.built) return;
    this.thirdPerson = !!on;
    this.head.visible = this.thirdPerson;
    this.root.visible = this.visible;
  }

  setVisible(on) {
    this.visible = !!on;
    this.root.visible = this.visible;
  }

  setShadows(enabled) {
    if (!this.built) return;
    this.root.traverse(o => { if (o.isMesh) o.castShadow = !!enabled; });
  }

  /**
   * Snap every smoothed value to the player's current state so the rig never
   * lerps across the map from a stale pose (mission start / respawn).
   */
  snug() {
    if (!this.built) return;
    const p = this.game.player;
    if (!p) return;
    this._crouchT = p.crouchT || 0;
    this._sprintT = p.sprinting ? 1 : 0;
    this._adsT = (this.game.weapons && this.game.weapons.adsT) || 0;
    this._leanT = p.lean || 0;
    this._airT = p.onGround ? 0 : 1;
    this._walkPhase = 0;
    this._lastSpeed = p.speed || 0;
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = p.yaw || 0;
  }

  // -------------------------------------------------------------------------
  // Per-frame update — allocation free
  // -------------------------------------------------------------------------
  update(dt, player) {
    if (!this.built || !this.visible) return;

    const sprinting = !!player.sprinting;
    const speed = player.speed || 0;
    const grounded = !!player.onGround;

    // smoothed stance weights
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this._crouchT += (player.crouchT - this._crouchT) * k(14);
    this._sprintT += ((sprinting ? 1 : 0) - this._sprintT) * k(8);
    this._adsT += (((player.game.weapons && player.game.weapons.adsT) || 0) - this._adsT) * k(12);
    this._leanT += ((player.lean || 0) - this._leanT) * k(10);
    this._airT += ((grounded ? 0 : 1) - this._airT) * k(9);

    // place the rig: feet on the ground, facing the aim yaw
    this.root.position.set(player.pos.x, player.pos.y, player.pos.z);
    this.root.rotation.y = player.yaw;

    // ---- pelvis height: stand / crouch / airborne -------------------------
    const standY = LEG_UPPER + LEG_LOWER + PELVIS_LIFT;
    const crouchY = standY * 0.55;
    let pelvisY = THREE.MathUtils.lerp(standY, crouchY, this._crouchT);
    if (this._airT > 0.01) pelvisY += this._airT * 0.09;      // tuck slightly
    this.pelvis.position.y = pelvisY;

    // ---- walk cycle --------------------------------------------------------
    // Phase is driven by distance travelled so the stride never skates.
    this._walkPhase += (speed * dt) * (sprinting ? 2.6 : 3.1);
    const stride = Math.min(1, speed / (sprinting ? 5.4 : 3.0));
    const swing = Math.sin(this._walkPhase) * stride;
    const swing2 = Math.cos(this._walkPhase) * stride;

    // legs counter-swing; airborne tucks them
    const legAmp = (sprinting ? 0.62 : 0.42) * stride;
    const tuck = this._airT * 0.55;
    this._setLeg(this.legL, swing * legAmp, tuck);
    this._setLeg(this.legR, -swing * legAmp, tuck);

    // vertical body bob follows the same cycle
    const bob = Math.abs(Math.sin(this._walkPhase)) * stride * (sprinting ? 0.035 : 0.018);
    this.pelvis.position.y += bob - this._crouchT * 0.0;

    // ---- torso: forward lean when sprinting, upright when aiming ----------
    const leanFwd = this._sprintT * 9 * DEG + this._crouchT * 12 * DEG - this._adsT * 4 * DEG;
    this.torso.rotation.x = leanFwd;
    this.torso.rotation.z = -this._leanT * 5 * DEG;
    // head counter-rotates so the operator still looks where they aim
    this.head.rotation.x = -leanFwd * 0.75 + THREE.MathUtils.clamp(
      -(player.pitch || 0) * (this.thirdPerson ? 1 : 0.35), -0.6, 0.6);

    // ---- arms --------------------------------------------------------------
    if (this.thirdPerson) {
      // Aim the weapon: right arm forward, left arm supports.
      const raise = this._adsT;
      const aimPitch = THREE.MathUtils.clamp(-(player.pitch || 0), -1.2, 1.2);
      this.armR.upper.rotation.x = THREE.MathUtils.lerp(
        -swing2 * 0.30 * stride, -78 * DEG + aimPitch, raise);
      this.armR.upper.rotation.z = -14 * DEG * raise + 8 * DEG;
      this.armR.lower.rotation.x = THREE.MathUtils.lerp(-18 * DEG, -12 * DEG, raise);

      this.armL.upper.rotation.x = THREE.MathUtils.lerp(
        swing2 * 0.30 * stride, -66 * DEG + aimPitch, raise);
      this.armL.upper.rotation.z = 22 * DEG * raise - 8 * DEG;
      this.armL.lower.rotation.x = THREE.MathUtils.lerp(-16 * DEG, -34 * DEG, raise);
    } else {
      // First person: arms are represented by the weapon viewmodel, so the rig
      // arms hang naturally and simply counter-swing with the stride.
      this.armR.upper.rotation.x = -swing2 * 0.34 * stride - this._crouchT * 10 * DEG;
      this.armR.upper.rotation.z = 8 * DEG;
      this.armR.lower.rotation.x = -22 * DEG - this._crouchT * 18 * DEG;

      this.armL.upper.rotation.x = swing2 * 0.34 * stride - this._crouchT * 10 * DEG;
      this.armL.upper.rotation.z = -8 * DEG;
      this.armL.lower.rotation.x = -22 * DEG - this._crouchT * 18 * DEG;
    }

    this._lastSpeed = speed;
  }

  _setLeg(leg, swing, tuck) {
    leg.upper.rotation.x = swing - tuck;
    leg.lower.rotation.x = Math.max(0, -swing * 0.85) + tuck * 1.35;
  }

  // -------------------------------------------------------------------------
  dispose() {
    if (!this.built) return;
    this.root.traverse(o => { if (o.isMesh) o.geometry = null; });
    for (const g of this._geos) g.dispose();
    for (const m of Object.values(this._mats)) m.dispose();
    this._geos.length = 0;
    this._mats = {};
    this.built = false;
  }
}
