/**
 * touch.js — Stage D unified touch input layer.
 *
 * Virtual joysticks + tactical action buttons that write into the SAME
 * game.input command object as keyboard/mouse (spec §38: one gameplay
 * command path, no duplicated logic). Also provides: contextual interact,
 * weapon-pickup card, hold-Q-style equipment wheel via touch, haptics,
 * subtle aim assist, and settings-driven size/opacity/sensitivity.
 */
import { WEAPON_DEFS } from './weapons.js';

const VIBE = {
  shot: 10, hit: 22, damage: 45, objective: 30, collision: 26,
  pickup: 20, complete: [55, 70, 55],
};

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.enabled = false;
    this.layer = document.getElementById('touch-controls');

    // touch state
    this.moveId = null; this.lookId = null;
    this.moveOrigin = { x: 0, y: 0 };
    this.lookLast = { x: 0, y: 0 };
    this._joyMag = 0;
    this._sprintWrote = false;
    this._aimTouch = false;
    this._wheelTouch = false;
    this._interactTouch = false;
    this._brakeTouch = false;
    this._fireTouch = false;

    // haptics throttle + state deltas to react to
    this._vibeCd = 0;
    this._lastShots = 0; this._lastHealth = 100; this._lastHpVeh = 0;
    this._lastStage = ''; this._lastSpeed = 0; this._lastState = '';
    this._assistTarget = null;

    this._buildDom();
    this._bindLayer();
  }

  // =========================================================================
  // DOM construction
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

    // movement joystick (left zone; base+knob appear where you touch)
    this.moveZone = this._el('tjoy-zone left');
    this._stop(this.moveZone);
    // camera/look surface (right zone; buttons sit above it in DOM order)
    this.lookZone = this._el('tjoy-zone right');
    this._stop(this.lookZone);
    this.joyBase = this._el('tjoy-base');
    this.joyKnob = this._el('tjoy-knob');
    this.layer.appendChild(this.joyBase);
    this.layer.appendChild(this.joyKnob);

    // action buttons — right cluster: FIRE / AIM-USE / RELOAD / JUMP / CROUCH / CAM
    // left cluster: SPRINT / WHEEL / MAP, top-left: PAUSE
    const mk = (cls, label) => {
      const b = document.createElement('div');
      b.className = 'tbtn ' + cls;
      b.textContent = label;
      this.layer.appendChild(b);
      return b;
    };
    this.btnFire = mk('tbtn-fire', 'FIRE');
    this.btnAim = mk('tbtn-aim', 'AIM');
    this.btnReload = mk('tbtn-reload', 'RLD');
    this.btnJump = mk('tbtn-jump', 'JUMP');
    this.btnCrouch = mk('tbtn-crouch', 'CRCH');
    this.btnCam = mk('tbtn-cam hidden', 'CAM');
    this.btnSprint = mk('tbtn-sprint', 'SPRT');
    this.btnWheel = mk('tbtn-wheel', 'GEAR');
    this.btnMap = mk('tbtn-map', 'MAP');
    this.btnPause = mk('tbtn-pause', '❚❚');
    this.btnInteract = mk('tbtn-interact hidden', 'INTERACT');

    // weapon pickup card (spec §20)
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

    this._bindButtons();
  }

  // =========================================================================
  // Touch plumbing — multitouch by identifier
  // =========================================================================
  _on(el, fn) {
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      el.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); fn(e, t); }, { passive: false });
    }
  }

  _bindLayer() {
    // movement zone (left) + look zone (right); buttons stopPropagation so
    // they never start a drag
    this._on(this.moveZone, (e, type) => this._moveTouch(e, type));
    this._on(this.lookZone, (e, type) => this._layerTouch(e, type));
  }

  _stop(el) {
    el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
    el.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
    el.addEventListener('touchend', (e) => e.stopPropagation(), { passive: false });
    el.addEventListener('touchcancel', (e) => e.stopPropagation(), { passive: false });
  }

  _btn(el, onStart, onEnd) {
    this._stop(el);
    el.addEventListener('touchstart', (e) => {
      this._lastTouchT = performance.now();
      if (e.cancelable) e.preventDefault(); el.classList.add('press'); if (onStart) onStart(e);
    }, { passive: false });
    const end = (e) => {
      if (e.cancelable) e.preventDefault(); el.classList.remove('press'); if (onEnd) onEnd(e);
    };
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });
    // desktop-mouse fallback (touch-capable laptops, testing) — compat mouse
    // events that follow a touch are ignored so nothing double-fires
    const fromTouch = () => performance.now() - (this._lastTouchT || 0) < 800;
    el.addEventListener('mousedown', (e) => {
      if (fromTouch()) return;
      if (e.cancelable) e.preventDefault(); el.classList.add('press'); if (onStart) onStart(e);
    });
    el.addEventListener('mouseup', (e) => { if (fromTouch()) return; el.classList.remove('press'); if (onEnd) onEnd(e); });
    el.addEventListener('mouseleave', () => { if (fromTouch()) return; if (el.classList.contains('press')) { el.classList.remove('press'); if (onEnd) onEnd({}); } });
  }

  _bindButtons() {
    const g = () => this.game;
    const inp = () => this.game.input;

    this._btn(this.btnFire,
      () => { if (g().state === 'playing') { this._fireTouch = true; inp().mouse0 = true; this.vibrate(VIBE.shot); } },
      () => { this._fireTouch = false; inp().mouse0 = false; });

    this._btn(this.btnAim,
      () => {
        if (g().state !== 'playing') return;
        const s = g().settings;
        if (s.aimMode === 'toggle' && g().handsMode === 'gun') {
          this._aimTouch = !this._aimTouch;
          inp().mouse2 = this._aimTouch;
          this.btnAim.classList.toggle('on', this._aimTouch);
        } else {
          this._aimTouch = true; inp().mouse2 = true;
          this.btnAim.classList.toggle('on', true);
        }
      },
      () => {
        const s = g().settings;
        if (s.aimMode === 'toggle' && g().handsMode === 'gun') return; // stays toggled
        this._aimTouch = false; inp().mouse2 = false;
        this.btnAim.classList.remove('on');
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

    this._btn(this.btnCam,
      () => { if (g().state === 'playing') inp().camPressed = true; }, null);

    this._btn(this.btnSprint,
      () => { this._sprintBtn = true; },
      () => { this._sprintBtn = false; });

    this._btn(this.btnWheel,
      () => {
        if (g().state !== 'playing') return;
        this._wheelTouch = true; inp().wheelHeld = true;
        g().wheelX = 0; g().wheelY = 0;
        g().ui.moveWheelCursor(0, 0);
      },
      () => { this._wheelTouch = false; inp().wheelHeld = false; });

    this._btn(this.btnMap,
      () => { if (g().state === 'playing' && g().tacmap) g().tacmap.toggle(); }, null);

    this._btn(this.btnPause,
      () => {
        const st = g().state;
        if (st === 'playing') g().pause();
        else if (st === 'paused') g().resume();
      }, null);

    this._btn(this.btnInteract,
      () => {
        if (g().state !== 'playing') return;
        this._interactTouch = true;
        inp().interactPressed = true;
        inp().interactHeld = true;
      },
      () => { this._interactTouch = false; inp().interactHeld = false; });

    this._btn(this.pickBtn,
      () => {
        if (g().state !== 'playing') return;
        this._interactTouch = true;
        inp().interactPressed = true;
        inp().interactHeld = true;
      },
      () => { this._interactTouch = false; inp().interactHeld = false; });
  }

  // =========================================================================
  // Joystick + look drags
  // =========================================================================
  _moveTouch(e, type) {
    const g = this.game;
    if (!this.enabled || g.state !== 'playing') return;
    if (type === 'touchstart') {
      if (this.moveId !== null) return;
      const t = e.changedTouches[0];
      this.moveId = t.identifier;
      this.moveOrigin.x = t.clientX; this.moveOrigin.y = t.clientY;
      this.joyBase.style.left = t.clientX + 'px';
      this.joyBase.style.top = t.clientY + 'px';
      this.joyKnob.style.left = t.clientX + 'px';
      this.joyKnob.style.top = t.clientY + 'px';
      this.joyBase.classList.add('show');
      this.joyKnob.classList.add('show');
      return;
    }
    if (type === 'touchmove' && this.moveId !== null) {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.moveId) continue;
        const R = 52 * (g.settings.joySize || 1);
        let dx = t.clientX - this.moveOrigin.x;
        let dy = t.clientY - this.moveOrigin.y;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        this.joyKnob.style.left = (this.moveOrigin.x + dx) + 'px';
        this.joyKnob.style.top = (this.moveOrigin.y + dy) + 'px';
        const mag = Math.min(1, d / R);
        this._joyMag = mag < 0.14 ? 0 : mag;           // dead zone
        const k = this._joyMag / (mag || 1);
        g.input._touchF = -(dy * k) / R;                 // up = forward
        g.input._touchR = (dx * k) / R;
        if (this._joyMag === 0) { g.input._touchF = 0; g.input._touchR = 0; }
      }
      return;
    }
    // touchend / cancel
    for (const t of e.changedTouches) {
      if (t.identifier !== this.moveId) continue;
      this.moveId = null;
      this._joyMag = 0;
      g.input._touchF = 0; g.input._touchR = 0;
      this.joyBase.classList.remove('show');
      this.joyKnob.classList.remove('show');
    }
  }

  _layerTouch(e, type) {
    const g = this.game;
    if (!this.enabled || g.state !== 'playing') return;
    if (type === 'touchstart') {
      if (this.lookId !== null) return;
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lookLast.x = t.clientX; this.lookLast.y = t.clientY;
      return;
    }
    if (type === 'touchmove' && this.lookId !== null) {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        const s = g.settings;
        const ads = g.input.mouse2 && g.handsMode === 'gun';
        const sens = (s.lookSens != null ? s.lookSens : 1) * (ads ? (s.aimSens != null ? s.aimSens : 0.8) : 1);
        const sticky = (ads && this._assistTarget) ? 0.68 : 1;   // aim-assist stickiness
        let dx = t.clientX - this.lookLast.x;
        let dy = t.clientY - this.lookLast.y;
        this.lookLast.x = t.clientX; this.lookLast.y = t.clientY;
        g.input.lookX += dx * sens * sticky;
        g.input.lookY += (s.invertY ? -dy : dy) * sens * sticky;
      }
      return;
    }
    for (const t of e.changedTouches) {
      if (t.identifier === this.lookId) this.lookId = null;
    }
  }

  // =========================================================================
  // Runtime: visibility, contextual states, haptics, aim assist
  // =========================================================================
  setEnabled(on) {
    this.enabled = !!on;
    this.layer.classList.toggle('hidden', !this.enabled);
    if (!this.enabled) this._resetInputs();
  }

  _resetInputs() {
    const inp = this.game.input;
    inp._touchF = 0; inp._touchR = 0;
    inp.mouse0 = false; inp.mouse2 = false; inp.sprint = inp.sprint && !this._sprintBtn;
    inp.interactHeld = false; inp.wheelHeld = false; inp.spaceHeld = false;
    this.moveId = null; this.lookId = null;
    this.joyBase.classList.remove('show'); this.joyKnob.classList.remove('show');
    this.btnAim.classList.remove('on');
    this._sprintBtn = false; this._fireTouch = false; this._aimTouch = false;
  }

  applySettings() {
    // CSS vars are applied globally by game.applySettings; nothing heavy here.
    const s = this.game.settings;
    if (s.aimMode === 'hold') { this._aimTouch = false; this.btnAim && this.btnAim.classList.remove('on'); }
  }

  onResize() {
    // release drags — browser cancels touches on orientation change anyway
    if (this.moveId !== null) {
      this.moveId = null; this._joyMag = 0;
      this.game.input._touchF = 0; this.game.input._touchR = 0;
      this.joyBase.classList.remove('show'); this.joyKnob.classList.remove('show');
    }
    this.lookId = null;
  }

  vibrate(pattern) {
    if (!this.enabled || !this.game.settings.vibration) return;
    if (!navigator.vibrate) return;
    const now = performance.now();
    if (now - this._vibeCd < 70) return;
    this._vibeCd = now;
    try { navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
  }

  update(dt) {
    const g = this.game;
    if (!this.enabled) return;
    const playing = g.state === 'playing';
    const mapOpen = g.tacmap && g.tacmap.open;

    // layer visibility: only while actively playing (not paused, map closed)
    const showLayer = playing && !mapOpen;
    if (this._layerShown !== showLayer) {
      this._layerShown = showLayer;
      this.layer.style.visibility = showLayer ? 'visible' : 'hidden';
      if (!showLayer) this._resetInputs();
    }
    if (!showLayer) return;

    // vehicle context: show CAM, relabel JUMP as brake
    const inVeh = !!g.vehicleMode;
    this.btnCam.classList.toggle('hidden', !inVeh);
    this.btnJump.textContent = inVeh ? 'BRK' : 'JUMP';
    if (inVeh) {
      // handbrake is a hold: keep spaceHeld synced with brake button
      g.input.spaceHeld = this._brakeTouch;
    } else if (this._jumpHoldT > 0) {
      this._jumpHoldT -= dt;
      if (this._jumpHoldT <= 0) g.input.spaceHeld = false;
    }

    // AIM button doubles as USE/DETONATE for throwables & utilities
    const hands = g.handsMode || 'gun';
    this.btnAim.textContent = hands === 'gun' ? 'AIM' : hands === 'throwable' ? 'ALT' : 'USE';
    if (hands !== 'gun' && this._aimTouch && g.settings.aimMode === 'toggle') {
      this._aimTouch = false; g.input.mouse2 = false; this.btnAim.classList.remove('on');
    }

    // sprint: button hold OR auto-sprint at full joystick deflection
    const auto = g.settings.autoSprint && this._joyMag > 0.93;
    const want = !!(this._sprintBtn || auto);
    if (want) { g.input.sprint = true; this._sprintWrote = true; }
    else if (this._sprintWrote) { g.input.sprint = false; this._sprintWrote = false; }
    this.btnSprint.classList.toggle('on', want);

    // auto-fire (optional): only when aim assist has a target and holding aim
    if (g.settings.autoFire && hands === 'gun' && this._assistTarget && g.input.mouse2 && !this._fireTouch) {
      g.input.mouse0 = true;
      this._autoFire = true;
    } else if (this._autoFire && !this._fireTouch) {
      g.input.mouse0 = false; this._autoFire = false;
    }

    // contextual INTERACT button + weapon pickup card
    const it = g.interactTarget;
    const promptEl = document.getElementById('interact-prompt');
    const hasPrompt = promptEl && !promptEl.classList.contains('hidden');
    if (hasPrompt) {
      const label = it
        ? ((it.getPrompt ? it.getPrompt() : it.prompt) || 'INTERACT')
        : ((document.getElementById('interact-text') || {}).textContent || 'INTERACT');
      const clean = String(label).replace(/\[F\]/g, '').replace(/^HOLD\s*—?\s*/i, '').replace(/\s+/g, ' ').trim();
      this.btnInteract.textContent = (it && it.hold > 0 ? 'HOLD — ' : '') + clean;
      this.btnInteract.classList.remove('hidden');
    } else {
      this.btnInteract.classList.add('hidden');
    }

    // weapon pickup card (name / type / ammo / current weapon / PICK UP|SWAP)
    const wid = it && it.id && it.id.startsWith('wpn_') ? it.id.split('_')[1] : null;
    const def = wid ? WEAPON_DEFS[wid] : null;
    if (def) {
      const ws = g.weapons;
      const st = ws.state[wid];
      const owned = ws.owned.has(wid);
      const cur = WEAPON_DEFS[ws.currentId] || {};
      this.pickCard.classList.remove('hidden');
      this.pickCard.querySelector('#tpick-name').textContent = def.name;
      this.pickCard.querySelector('#tpick-meta').innerHTML =
        def.klass + ' · MAG ' + def.magSize + (st ? ' · STOCK ' + (st.mag + st.reserve) : '') +
        '<br>CURRENT: ' + (cur.name || '—') + ' · ' + (cur.klass || '');
      this.pickCard.querySelector('#tpick-take').textContent = owned ? 'TAKE AMMO' : (ws.isSlotFull && ws.isSlotFull(wid) ? 'SWAP' : 'PICK UP');
    } else {
      this.pickCard.classList.add('hidden');
    }

    // aim assist: subtle magnetic pull while aiming (spec §36)
    this._updateAimAssist(dt);

    // haptics from state deltas (no gameplay code touched)
    this._updateHaptics(dt);
  }

  _updateAimAssist(dt) {
    const g = this.game;
    const level = g.settings.aimAssist || 'off';
    this._assistTarget = null;
    if (level === 'off' || g.handsMode !== 'gun' || !g.input.mouse2 || g.vehicleMode) return;
    if (!g.enemies || !g.enemies.list) return;
    const rate = level === 'low' ? 0.55 : level === 'medium' ? 1.1 : 1.8;   // deg-ish pull/s
    const cone = level === 'high' ? 0.16 : 0.11;                             // radians
    const cam = g.camera;
    cam.getWorldDirection(this._dir || (this._dir = new (cam.position.constructor)()));
    let best = null, bestAng = cone;
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      const dx = e.pos.x - cam.position.x;
      const dy = (e.pos.y + 1.2) - cam.position.y;
      const dz = e.pos.z - cam.position.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.5 || len > 90) continue;
      const dot = (dx * this._dir.x + dy * this._dir.y + dz * this._dir.z) / len;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (ang < bestAng) { bestAng = ang; best = e; }
    }
    if (!best) return;
    this._assistTarget = best;
    // gentle rotational pull — never a snap
    const px = best.pos.x - cam.position.x;
    const pz = best.pos.z - cam.position.z;
    const py = (best.pos.y + 1.35) - cam.position.y;
    const wantYaw = Math.atan2(-px, -pz);
    let dYaw = wantYaw - g.player.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const wantPitch = -Math.atan2(py, Math.hypot(px, pz));
    const dPitch = wantPitch - g.player.pitch;
    const k = Math.min(1, rate * dt);
    g.player.yaw += dYaw * k * 0.35;
    g.player.pitch += dPitch * k * 0.35;
  }

  _updateHaptics(dt) {
    const g = this.game;
    const st = g.stats;
    // fired a shot
    if (st.shots > this._lastShots) { this._lastShots = st.shots; if (this._fireTouch || this._autoFire) this.vibrate(VIBE.shot); }
    // player took damage
    const hp = g.player.health;
    if (hp < this._lastHealth - 0.5) this.vibrate(VIBE.damage);
    this._lastHealth = hp;
    // hit registered on enemy
    if (st.hits > (this._lastHits || 0)) { this.vibrate(VIBE.hit); }
    this._lastHits = st.hits;
    // vehicle collision (sharp speed loss while driving)
    if (g.vehicleMode) {
      const sp = Math.abs(g.vehicleMode.speed);
      if (this._lastSpeed - sp > 6) this.vibrate(VIBE.collision);
      this._lastSpeed = sp;
    } else this._lastSpeed = 0;
    // objective / stage advance
    const stage = (g.missions && (g.missions.stage || (g.missions.seqStep && g.missions.seqStep.id))) || '';
    if (stage && stage !== this._lastStage) {
      if (this._lastStage) this.vibrate(VIBE.objective);
      this._lastStage = stage;
    }
    // interaction/pickup completed (§37)
    const it = g.interactTarget;
    if (it && it.used && this._lastUsedId !== it.id) { this._lastUsedId = it.id; this.vibrate(VIBE.pickup); }
    else if (!it || !it.used) this._lastUsedId = null;
    // mission complete
    if (g.state !== this._lastState) {
      if (g.state === 'complete') this.vibrate(VIBE.complete);
      this._lastState = g.state;
    }
  }
}
