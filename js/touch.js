/**
 * touch.js — unified mobile control layer.
 *
 * Writes into the SAME `game.input` command object the keyboard/mouse use, so
 * gameplay code is identical on every device (one command path, no duplicated
 * logic).
 *
 * Design rules:
 *  - TWO analog joysticks: left = movement, right = camera/look.
 *  - Ownership is tracked by POINTER ID and enforced with setPointerCapture, so
 *    a second finger can never steal a joystick that another finger owns, and
 *    `lostpointercapture` guarantees cleanup if the OS takes the pointer away.
 *  - Buttons track their owning pointerId too: a held button cannot be
 *    double-triggered, and releasing outside still fires exactly one release.
 *  - Everything is multi-touch by construction: move + look + fire + ADS can all
 *    be active simultaneously because each control owns a distinct pointer.
 *  - `touch-action: none` + preventDefault stops scroll/zoom/pinch during play.
 *  - Haptics always fail safe (feature-detected and wrapped).
 */
import { WEAPON_DEFS } from './weapons.js';

const VIBE = {
  shot: 10, hit: 22, damage: 45, objective: 30, collision: 26,
  pickup: 20, complete: [55, 70, 55], ui: 8,
};

// Look stick: peak turn rate in "mouse-pixel equivalents" per second at full
// deflection. ~850 * 0.0022 rad/unit ≈ 107°/s — controllable, not twitchy.
const LOOK_RATE = 850;
const DEAD_ZONE = 0.14;
const RESPONSE_CURVE = 1.35;   // >1 = finer control near the centre

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.enabled = false;
    this.layer = document.getElementById('touch-controls');

    // joystick pointer ownership
    this.moveId = null;
    this.lookId = null;
    this.moveOrigin = { x: 0, y: 0 };
    this.lookOrigin = { x: 0, y: 0 };
    this.moveVec = { x: 0, y: 0 };       // normalised analog, -1..1
    this.lookVec = { x: 0, y: 0 };

    // button/action state owned by touch
    this._fireTouch = false;
    this._aimTouch = false;
    this._sprintBtn = false;
    this._sprintWrote = false;
    this._wheelTouch = false;
    this._interactTouch = false;
    this._brakeTouch = false;
    this._jumpHoldT = 0;
    this._autoFire = false;

    // haptics + deltas
    this._vibeCd = 0;
    this._lastShots = 0;
    this._lastHealth = 100;
    this._lastHpVeh = 0;
    this._lastStage = '';
    this._lastSpeed = 0;
    this._lastState = '';
    this._assistTarget = null;
    this._layerShown = null;
    this._orientation = null;

    this._buildDom();
    this._bindLayer();
    this._bindButtons();
  }

  // =========================================================================
  // DOM
  // =========================================================================
  _el(cls, text, parent) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    (parent || this.layer).appendChild(d);
    return d;
  }

  _buildDom() {
    this.layer.innerHTML = '';

    // --- joysticks -------------------------------------------------------
    this.moveZone = this._el('tstick-zone left');
    this.lookZone = this._el('tstick-zone right');

    this.moveBase = this._el('tstick-base left');
    this.moveKnob = this._el('tstick-knob left');
    this.lookBase = this._el('tstick-base right');
    this.lookKnob = this._el('tstick-knob right');

    // --- action buttons --------------------------------------------------
    // Right thumb cluster: FIRE / ADS / RELOAD / JUMP / CROUCH / SWITCH
    // Left thumb cluster:  SPRINT / GEAR / MAP / CAM (vehicle)
    // Utility row:         INTERACT (contextual) / PAUSE
    const mk = (cls, label) => {
      const b = document.createElement('div');
      b.className = 'tbtn ' + cls;
      b.dataset.key = cls.replace('tbtn-', '');
      b.textContent = label;
      this.layer.appendChild(b);
      return b;
    };

    this.btnFire    = mk('tbtn-fire', 'FIRE');
    this.btnAds     = mk('tbtn-ads', 'ADS');
    this.btnReload  = mk('tbtn-reload', 'RELOAD');
    this.btnJump    = mk('tbtn-jump', 'JUMP');
    this.btnCrouch  = mk('tbtn-crouch', 'CROUCH');
    this.btnSwitch  = mk('tbtn-switch', 'SWITCH');
    this.btnSprint  = mk('tbtn-sprint', 'SPRINT');
    this.btnGear    = mk('tbtn-gear', 'GEAR');
    this.btnMap     = mk('tbtn-map', 'MAP');
    this.btnCam     = mk('tbtn-cam hidden', 'CAM');
    this.btnInteract= mk('tbtn-interact hidden', 'INTERACT');
    this.btnPause   = mk('tbtn-pause', '❚❚');

    // weapon pickup card
    this.pickCard = document.createElement('div');
    this.pickCard.id = 'tpick-card';
    this.pickCard.classList.add('hidden');
    this.pickCard.innerHTML =
      '<div class="tpick-head">WEAPON FOUND</div>' +
      '<div class="tpick-name" id="tpick-name">—</div>' +
      '<div class="tpick-meta" id="tpick-meta"></div>' +
      '<button class="menu-btn tpick-btn" id="tpick-take">PICK UP</button>';
    this.layer.appendChild(this.pickCard);
    this._stop(this.pickCard);
    this.pickBtn = this.pickCard.querySelector('#tpick-take');
  }

  /** Swallow pointer traffic so a control never starts a background drag. */
  _stop(el) {
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      el.addEventListener(t, (e) => e.stopPropagation(), { passive: false });
    }
  }

  // =========================================================================
  // Joysticks — pointer-id ownership + capture
  // =========================================================================
  _bindLayer() {
    this._bindStick(this.moveZone, 'moveId', this.moveOrigin, this.moveVec,
                    this.moveBase, this.moveKnob, false);
    this._bindStick(this.lookZone, 'lookId', this.lookOrigin, this.lookVec,
                    this.lookBase, this.lookKnob, true);
  }

  _bindStick(zone, idKey, origin, vecOut, baseEl, knobEl, isLook) {
    const g = () => this.game;

    zone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || g().state !== 'playing') return;
      if (this[idKey] !== null) return;              // another finger already owns it
      if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
      this[idKey] = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
      origin.x = e.clientX; origin.y = e.clientY;
      vecOut.x = 0; vecOut.y = 0;
      baseEl.style.left = e.clientX + 'px';
      baseEl.style.top = e.clientY + 'px';
      knobEl.style.left = e.clientX + 'px';
      knobEl.style.top = e.clientY + 'px';
      baseEl.classList.add('show');
      knobEl.classList.add('show');
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    zone.addEventListener('pointermove', (e) => {
      if (this[idKey] !== e.pointerId) return;       // not ours — ignore
      const R = this._radius(isLook);
      let dx = e.clientX - origin.x;
      let dy = e.clientY - origin.y;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      knobEl.style.left = (origin.x + dx) + 'px';
      knobEl.style.top = (origin.y + dy) + 'px';
      vecOut.x = dx / R;
      vecOut.y = dy / R;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    const release = (e) => {
      if (this[idKey] !== e.pointerId) return;
      this[idKey] = null;
      try { zone.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
      vecOut.x = 0; vecOut.y = 0;
      baseEl.classList.remove('show');
      knobEl.classList.remove('show');
      if (!isLook) { g().input._touchF = 0; g().input._touchR = 0; }
    };
    zone.addEventListener('pointerup', release, { passive: false });
    zone.addEventListener('pointercancel', release, { passive: false });
    // Safety net: if the OS/browser steals the pointer, we still let go cleanly.
    zone.addEventListener('lostpointercapture', release, { passive: false });
  }

  _radius(isLook) {
    const s = this.game.settings;
    return 56 * (isLook ? (s.lookStickSize || 1) : (s.joySize || 1));
  }

  /** Dead zone + gentle exponential response for fine aim control. */
  static _shape(mag) {
    if (mag < DEAD_ZONE) return 0;
    const t = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
    return Math.pow(Math.min(1, t), RESPONSE_CURVE);
  }

  // =========================================================================
  // Buttons — one owning pointer each, no duplicate presses/releases
  // =========================================================================
  _btn(el, onPress, onRelease) {
    let owner = null;
    const press = (e) => {
      if (owner !== null) return;                    // already held — no duplicate
      owner = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
      el.classList.add('press');
      this._lastTouchT = performance.now();
      if (onPress) onPress(e);
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };
    const release = (e) => {
      if (owner === null || e.pointerId !== owner) return;
      owner = null;
      el.classList.remove('press');
      if (onRelease) onRelease(e);
    };
    el.addEventListener('pointerdown', press, { passive: false });
    el.addEventListener('pointerup', release, { passive: false });
    el.addEventListener('pointercancel', release, { passive: false });
    el.addEventListener('lostpointercapture', release, { passive: false });
    // Desktop-mouse convenience for touch-capable laptops; compat mouse events
    // that follow a touch are ignored so nothing double-fires.
    el.addEventListener('mousedown', (e) => {
      if (performance.now() - (this._lastTouchT || 0) < 800) return;
      if (owner !== null) return;
      owner = 'mouse';
      el.classList.add('press');
      if (onPress) onPress(e);
    });
    el.addEventListener('mouseup', (e) => {
      if (owner !== 'mouse') return;
      owner = null; el.classList.remove('press');
      if (onRelease) onRelease(e);
    });
    el.addEventListener('mouseleave', () => {
      if (owner !== 'mouse') return;
      owner = null; el.classList.remove('press');
      if (onRelease) onRelease({});
    });
  }

  _bindButtons() {
    const g = () => this.game;
    const inp = () => this.game.input;

    this._btn(this.btnFire,
      () => {
        if (g().state !== 'playing') return;
        this._fireTouch = true; inp().mouse0 = true; this.vibrate(VIBE.shot);
      },
      () => { this._fireTouch = false; inp().mouse0 = false; });

    this._btn(this.btnAds,
      () => {
        if (g().state !== 'playing') return;
        const s = g().settings;
        if (s.aimMode === 'toggle' && g().handsMode === 'gun') {
          this._aimTouch = !this._aimTouch;
          inp().mouse2 = this._aimTouch;
          this.btnAds.classList.toggle('on', this._aimTouch);
        } else {
          this._aimTouch = true; inp().mouse2 = true;
          this.btnAds.classList.add('on');
        }
      },
      () => {
        const s = g().settings;
        if (s.aimMode === 'toggle' && g().handsMode === 'gun') return;   // stays toggled
        this._aimTouch = false; inp().mouse2 = false;
        this.btnAds.classList.remove('on');
      });

    this._btn(this.btnReload,
      () => { if (g().state === 'playing') inp().reloadPressed = true; }, null);

    this._btn(this.btnJump,
      () => {
        if (g().state !== 'playing') return;
        if (g().vehicleMode) { this._brakeTouch = true; inp().spaceHeld = true; }
        else { inp().jumpPressed = true; inp().spaceHeld = true; this._jumpHoldT = 0.18; }
      },
      () => { this._brakeTouch = false; if (!this._jumpHoldT) inp().spaceHeld = false; });

    this._btn(this.btnCrouch,
      () => { if (g().state === 'playing') inp().crouch = !inp().crouch; }, null);

    // Weapon switch: swap slots through the SAME selectWeapon command the
    // keyboard uses, so no weapon state machine is duplicated.
    this._btn(this.btnSwitch,
      () => {
        if (g().state !== 'playing') return;
        const game = g();
        if (game.handsMode !== 'gun') { inp().selectWeapon = 'primary'; this.vibrate(VIBE.ui); return; }
        inp().selectWeapon = (game.weapons.currentId === game.loadout.primary) ? 'secondary' : 'primary';
        this.vibrate(VIBE.ui);
      }, null);

    this._btn(this.btnSprint,
      () => { this._sprintBtn = true; },
      () => { this._sprintBtn = false; });

    this._btn(this.btnGear,
      () => {
        if (g().state !== 'playing') return;
        this._wheelTouch = true; inp().wheelHeld = true;
        g().wheelX = 0; g().wheelY = 0;
        if (g().ui && g().ui.moveWheelCursor) g().ui.moveWheelCursor(0, 0);
      },
      () => { this._wheelTouch = false; inp().wheelHeld = false; });

    this._btn(this.btnMap,
      () => { if (g().state === 'playing' && g().tacmap) g().tacmap.toggle(); }, null);

    this._btn(this.btnCam,
      () => { if (g().state === 'playing') inp().camPressed = true; }, null);

    this._btn(this.btnPause,
      () => {
        const st = g().state;
        if (st === 'playing') g().pause();
        else if (st === 'paused') g().resume();
      }, null);

    const pressInteract = () => {
      if (g().state !== 'playing') return;
      this._interactTouch = true;
      inp().interactPressed = true;
      inp().interactHeld = true;
    };
    const releaseInteract = () => { this._interactTouch = false; inp().interactHeld = false; };
    this._btn(this.btnInteract, pressInteract, releaseInteract);
    this._btn(this.pickBtn, pressInteract, releaseInteract);
  }

  // =========================================================================
  // Runtime
  // =========================================================================
  setEnabled(on) {
    this.enabled = !!on;
    this.layer.classList.toggle('hidden', !this.enabled);
    if (!this.enabled) this._resetInputs();
  }

  _resetInputs() {
    const inp = this.game.input;
    inp._touchF = 0; inp._touchR = 0;
    inp.mouse0 = false; inp.mouse2 = false;
    inp.sprint = inp.sprint && !this._sprintBtn;
    inp.interactHeld = false; inp.wheelHeld = false; inp.spaceHeld = false;
    this.moveId = null; this.lookId = null;
    this.moveVec.x = 0; this.moveVec.y = 0;
    this.lookVec.x = 0; this.lookVec.y = 0;
    for (const el of [this.moveBase, this.moveKnob, this.lookBase, this.lookKnob]) {
      if (el) el.classList.remove('show');
    }
    if (this.btnAds) this.btnAds.classList.remove('on');
    this._sprintBtn = false; this._fireTouch = false; this._aimTouch = false;
    this._sprintWrote = false; this._autoFire = false;
  }

  applySettings() {
    const s = this.game.settings;
    if (s.aimMode === 'hold') {
      this._aimTouch = false;
      if (this.btnAds) this.btnAds.classList.remove('on');
    }
    this._applyOrientation();
  }

  onResize() {
    // Release drags — the browser cancels pointers on orientation change anyway.
    this.moveId = null; this.lookId = null;
    this.moveVec.x = 0; this.moveVec.y = 0;
    this.lookVec.x = 0; this.lookVec.y = 0;
    const inp = this.game.input;
    if (inp) { inp._touchF = 0; inp._touchR = 0; }
    for (const el of [this.moveBase, this.moveKnob, this.lookBase, this.lookKnob]) {
      if (el) el.classList.remove('show');
    }
    this._applyOrientation();
  }

  _applyOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    const cls = portrait ? 'portrait' : 'landscape';
    if (this._orientation === cls) return;
    this._orientation = cls;
    this.layer.classList.remove('portrait', 'landscape');
    this.layer.classList.add(cls);
  }

  vibrate(pattern) {
    try {
      if (!this.enabled || !this.game.settings.vibration) return;
      if (typeof navigator === 'undefined' || !navigator.vibrate) return;  // fail safe
      const now = performance.now();
      if (now - this._vibeCd < 70) return;
      this._vibeCd = now;
      navigator.vibrate(pattern);
    } catch (_) { /* unsupported — never throw */ }
  }

  update(dt) {
    const g = this.game;
    if (!this.enabled) return;
    const playing = g.state === 'playing';
    const mapOpen = g.tacmap && g.tacmap.open;

    // While the tactical map is up, only MAP and PAUSE stay reachable (the
    // `map-open` class filters the rest in CSS), so the same button that
    // opened the map can close it again.
    if (this._mapShown !== mapOpen) {
      this._mapShown = mapOpen;
      this.layer.classList.toggle('map-open', !!mapOpen);
      // the stick zones vanish with the class, so drop any held stick now —
      // otherwise a finger released over hidden DOM would leave it stuck on
      if (mapOpen) this._resetInputs();
    }
    if (this._layerShown !== playing) {
      this._layerShown = playing;
      this.layer.style.visibility = playing ? 'visible' : 'hidden';
      if (!playing) this._resetInputs();
    }
    if (!playing) return;
    if (mapOpen) return;              // no stick driving while the map is up

    const s = g.settings;

    // ---- movement stick -> analog move axes ------------------------------
    if (this.moveId !== null) {
      const mag = Math.min(1, Math.hypot(this.moveVec.x, this.moveVec.y));
      const shaped = TouchControls._shape(mag);
      const k = mag > 0.0001 ? shaped / mag : 0;
      g.input._touchF = -(this.moveVec.y * k);      // up on screen = forward
      g.input._touchR = this.moveVec.x * k;
    }

    // ---- look stick -> analog look rate ----------------------------------
    if (this.lookId !== null) {
      const mag = Math.min(1, Math.hypot(this.lookVec.x, this.lookVec.y));
      const shaped = TouchControls._shape(mag);
      const k = mag > 0.0001 ? shaped / mag : 0;
      const ads = g.input.mouse2 && g.handsMode === 'gun';
      const sens = (s.lookSens != null ? s.lookSens : 1) * (ads ? (s.aimSens != null ? s.aimSens : 0.8) : 1);
      const sticky = (ads && this._assistTarget) ? 0.68 : 1;
      g.input.lookX += this.lookVec.x * k * LOOK_RATE * sens * sticky * dt;
      g.input.lookY += (s.invertY ? -this.lookVec.y : this.lookVec.y) * k * LOOK_RATE * sens * sticky * dt;
    }

    // ---- vehicle context -------------------------------------------------
    const inVeh = !!g.vehicleMode;
    this.btnCam.classList.toggle('hidden', !inVeh);
    this.btnJump.textContent = inVeh ? 'BRAKE' : 'JUMP';
    if (inVeh) {
      g.input.spaceHeld = this._brakeTouch;
    } else if (this._jumpHoldT > 0) {
      this._jumpHoldT -= dt;
      if (this._jumpHoldT <= 0) g.input.spaceHeld = false;
    }

    // ---- ADS button doubles as USE/DETONATE ------------------------------
    const hands = g.handsMode || 'gun';
    this.btnAds.textContent = hands === 'gun' ? 'ADS' : hands === 'throwable' ? 'ALT' : 'USE';
    if (hands !== 'gun' && this._aimTouch && s.aimMode === 'toggle') {
      this._aimTouch = false; g.input.mouse2 = false; this.btnAds.classList.remove('on');
    }

    // ---- sprint: button hold OR auto-sprint at full stick deflection -----
    const moveMag = Math.hypot(g.input._touchF || 0, g.input._touchR || 0);
    const auto = s.autoSprint && moveMag > 0.93;
    const want = !!(this._sprintBtn || auto);
    if (want) { g.input.sprint = true; this._sprintWrote = true; }
    else if (this._sprintWrote) { g.input.sprint = false; this._sprintWrote = false; }
    this.btnSprint.classList.toggle('on', want);

    // ---- optional auto-fire (only with an aim-assist target while ADS) ----
    if (s.autoFire && hands === 'gun' && this._assistTarget && g.input.mouse2 && !this._fireTouch) {
      g.input.mouse0 = true;
      this._autoFire = true;
    } else if (this._autoFire && !this._fireTouch) {
      g.input.mouse0 = false; this._autoFire = false;
    }

    // ---- contextual INTERACT + pickup card -------------------------------
    const promptEl = document.getElementById('interact-prompt');
    const hasPrompt = promptEl && !promptEl.classList.contains('hidden');
    this.btnInteract.classList.toggle('hidden', !hasPrompt);

    // ---- haptics and assist bookkeeping ---------------------------------
    this._haptics(dt);
    this._aimAssist(dt);
  }

  _haptics(dt) {
    const g = this.game;
    const st = g.stats || {};
    if (st.shots > this._lastShots) {
      this._lastShots = st.shots;
      if (this._fireTouch || this._autoFire) this.vibrate(VIBE.shot);
    }
    if (g.player && g.player.health < this._lastHealth) this.vibrate(VIBE.damage);
    if (g.player) this._lastHealth = g.player.health;
    if (g.state !== this._lastState) {
      if (g.state === 'complete') this.vibrate(VIBE.complete);
      this._lastState = g.state;
    }
  }

  _aimAssist(dt) {
    const g = this.game;
    const level = g.settings.aimAssist || 'off';
    if (level === 'off' || g.handsMode !== 'gun') { this._assistTarget = null; return; }
    // Reuse the enemy manager's closest visible target when ADS is engaged.
    if (!g.input.mouse2) { this._assistTarget = null; return; }
    let best = null, bestScore = Infinity;
    const list = (g.enemies && g.enemies.list) || [];
    for (const e of list) {
      if (!e.alive) continue;
      const dx = e.pos.x - g.player.pos.x, dz = e.pos.z - g.player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 60) continue;
      const fwd = -Math.sin(g.player.yaw), fwdZ = -Math.cos(g.player.yaw);
      const dot = (dx * fwd + dz * fwdZ) / Math.max(dist, 0.001);
      if (dot < 0.9) continue;
      if (dist < bestScore) { bestScore = dist; best = e; }
    }
    this._assistTarget = best;
  }
}
