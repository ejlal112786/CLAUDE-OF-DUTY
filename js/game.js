/**
 * game.js
 * Orchestrator: renderer/scene setup, game-state machine, input aggregation,
 * pointer lock, settings persistence, quality tiers, mission lifecycle
 * (start / checkpoint restart / complete / fail) and the main loop.
 */
import * as THREE from 'three';
import { PhysicsWorld } from './physics.js';
import { GameWorld } from './world.js';
import { Particles } from './particles.js';
import { AudioSystem } from './audio.js';
import { WeaponSystem, WEAPON_ORDER } from './weapons.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { MissionManager, MISSION_DEFS } from './missions.js';
import { UI } from './ui.js';
import { TacticalMap } from './tacmap.js';
import { VehicleManager } from './vehicles.js';
import { ThrowableSystem, THROWABLE_DEFS } from './throwables.js';
import { Loadout } from './loadout.js';
import { Progress, MISSION_ORDER } from './progress.js';
import { PlayerBody } from './playerbody.js';

const SETTINGS_KEY = 'obv_settings_v1';

/** thrown device: gravity, bounce, per-type fuse (frag / smoke / flash / decoy / flare / sensor) */
class Grenade {
  constructor(game, pos, vel, type = 'vxfrag') {
    this.game = game;
    this.type = type;
    this.pos = pos.clone();
    this.vel = vel.clone();
    const def = THROWABLE_DEFS[type];
    this.fuse = def ? def.fuse : 2.6;
    this.done = false;
    const mat = (game.throwables && game.throwables._mats[type]) || game._grenadeMat;
    this.mesh = new THREE.Mesh(game._grenadeGeo, mat);
    this.mesh.position.copy(pos);
    game.scene.add(this.mesh);
  }
  update(dt) {
    this.vel.y -= 9.81 * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < 0.06) {
      this.pos.y = 0.06;
      if (this.vel.y < -1) { this.vel.y *= -0.32; this.vel.x *= 0.55; this.vel.z *= 0.55; }
      else this.vel.y = 0;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += dt * 6;
    this.fuse -= dt;
    if (this.fuse <= 0) this.done = true;
  }
  dispose() { this.game.scene.remove(this.mesh); }
}

export const GameState = {
  BOOT: 'boot',
  MENU: 'menu',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DEAD: 'dead',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  fov: 75,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  ambVolume: 0.7,
  quality: 'medium',
  perfMode: false,
  dayMode: false,
  minimapOn: true,
  vehSteerInvert: false, vehSteerSens: 1.0, vehCamDist: 1.0,
  // Stage D — touch, accessibility, presentation
  touchControls: 'auto',      // 'auto' | 'on' | 'off'
  joySize: 1.0, joyOpacity: 0.55, btnSize: 1.0, btnOpacity: 0.8,
  lookSens: 1.0, aimSens: 0.8, invertY: false,
  autoSprint: true, aimMode: 'hold', autoFire: false,
  aimAssist: 'low',           // 'off' | 'low' | 'medium' | 'high'
  vibration: true, hudScale: 1.0,
  highContrast: false, largeText: false, reduceMotion: false,
  shakeScale: 1.0, subtitles: true,
  minimapSize: 'm',
  minimapOpacity: 0.85,
  minimapRotate: 'north',
};

export class Game {
  constructor() {
    this.state = GameState.BOOT;
    this.time = 0;
    this.settings = { ...DEFAULT_SETTINGS };
    this._loadSettings();

    this.progress = new Progress();
    this.noiseMask = 1;
    this._worldEvT = 40;
    this._lastMission = 'facility';
    this.stats = { kills: 0, shots: 0, hits: 0, headshots: 0, missionTime: 0, dataSecured: false, damageTaken: 0, alarm: false, checkpointsUsed: 0, intelRun: 0, minHealth: 100, mapOpens: 0, equipCats: {}, usedVehicle: false, vehicleAbandoned: false, driveDist: 0, throwablesUsed: 0 };

    this.input = {
      moveF: 0, moveR: 0,
      sprint: false, crouch: false, spaceHeld: false,
      jumpPressed: false,
      leanL: false, leanR: false,
      mouse0: false, mouse2: false,
      lookX: 0, lookY: 0,
      reloadPressed: false,
      selectWeapon: null,
      interactPressed: false,
      interactHeld: false,
      escPressed: false,
      wheelHeld: false,
      camPressed: false,
      grenadePressed: false,
      bandageHeld: false,
      mapPressed: false,
    };

    this.audio = new AudioSystem();
    this.hackProgress = 0;
    this.hackTarget = null;
    this._zoneT = 0;
    this._fovCurrent = this.settings.fov;
    this._raf = 0;
    this._lastT = 0;
    this._tmpV1 = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this.shake = 0;
    this.interactTarget = null;   // touch layer reads the current interactable
    this.suppress = 0;
    this.grenades = [];
  }

  // =========================================================================
  // Boot
  // =========================================================================
  async boot() {
    this.ui = new UI(this);
    this.tacmap = new TacticalMap(this);
    this.ui.setLoading(0.05, 'CHECKING RENDERER…');
    await raf();

    // --- WebGL availability ---
    try {
      const test = document.createElement('canvas');
      const gl = test.getContext('webgl2') || test.getContext('webgl');
      if (!gl) throw new Error('no webgl');
    } catch (e) {
      this.ui.showError('WebGL is not available in this browser. Enable hardware acceleration or try a different browser (Chrome / Edge / Firefox).');
      return;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.settings.perfMode,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      this.ui.showError('Failed to create the WebGL renderer: ' + e.message);
      return;
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    document.getElementById('game-container').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this._grenadeGeo = new THREE.SphereGeometry(0.07, 6, 5);
    this._grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2c3027, roughness: 0.8 });
    this._markers = [];
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 24),
        new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.visible = false;
      this.scene.add(ring);
      this._markers.push(ring);
    }
    this.scene.background = new THREE.Color(0x080c13);
    this.scene.fog = new THREE.FogExp2(0x0a0e14, 0.0095);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.05, 220);
    this.scene.add(this.camera);

    this.physics = new PhysicsWorld();
    this.particles = new Particles(this.scene);
    this.world = new GameWorld();
    this.player = new Player(this);
    // Visible operator body (shared by first-person awareness and any
    // third-person camera) — one representation, never two.
    this.body = new PlayerBody(this);
    this.body.build();
    this.scene.add(this.body.root);
    this.weapons = new WeaponSystem(this);
    this.weapons.attachTo(this.camera);
    this.enemies = new EnemyManager(this);
    this.vehicles = new VehicleManager(this);
    this.vehicleMode = null;   // the Vehicle the player is currently driving
    this.throwables = new ThrowableSystem(this);
    this.loadout = new Loadout();
    this.handsMode = 'gun';    // 'gun' | 'throwable' | 'utility'
    this.wheelActive = false;
    this.wheelX = 0; this.wheelY = 0;
    this._throwCd = 0;
    this._mouse2Was = false;
    this.missions = new MissionManager(this);

    this.ui.setLoading(0.2, 'PREPARING SYSTEMS…');
    await raf();

    this._bindInput();
    this._bindUI();
    this.applySettings(true);
    {
      const { TouchControls } = await import('./touch.js');
      this.touch = new TouchControls(this);
      this._detectDevice();
      this.touch.applySettings();
    }
    this._losFn = (a, b) => this.physics.hasLOS(a, b);

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 120));
    document.addEventListener('fullscreenchange', () => this._onResize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this._onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === GameState.PLAYING) this.pause();
    });

    this.ui.setLoading(1, 'READY');
    await raf(250);
    this.setState(GameState.MENU);
    this._loop = this._loop.bind(this);
    this._lastT = performance.now();
    requestAnimationFrame(this._loop);
  }

  // =========================================================================
  // Settings
  // =========================================================================
  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) { /* first run */ }
  }
  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
  }

  applySettings(initial = false) {
    const s = this.settings;
    s.sensitivity = THREE.MathUtils.clamp(s.sensitivity, 0.2, 3);
    s.fov = THREE.MathUtils.clamp(Math.round(s.fov), 60, 100);

    if (!this.renderer) return;
    const q = s.perfMode ? 'low' : s.quality;

    // resolution
    const prCap = q === 'high' ? 2 : q === 'medium' ? 1.5 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // draw distance + fog
    const far = q === 'high' ? 260 : q === 'medium' ? 220 : 160;
    const fogD = q === 'high' ? 0.0075 : q === 'medium' ? 0.0095 : 0.013;
    this.camera.far = far;
    if (this.scene.fog) this.scene.fog.density = fogD * (this.world && this.world.fogMul ? this.world.fogMul : 1);
    this.camera.fov = this._fovCurrent = s.fov;
    this.camera.updateProjectionMatrix();

    // shadows
    if (this.world && this.world.shadowLights) {
      for (const l of this.world.shadowLights) {
        const isMoon = l.isDirectionalLight;
        const wantShadow = isMoon ? true : q === 'high' || q === 'medium';
        if (l.castShadow !== wantShadow) l.castShadow = wantShadow;
        const size = isMoon ? (q === 'high' ? 2048 : q === 'medium' ? 1536 : 1024) : (q === 'high' ? 1024 : 512);
        if (l.shadow.mapSize.x !== size) {
          l.shadow.mapSize.set(size, size);
          if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
        }
      }
    }

    // player body shadows follow the same quality ladder as the world
    if (this.body && this.body.built) {
      this.body.setShadows(q === 'high' || q === 'medium');
    }

    // white mode (daylight relight)
    if (this.world && this.world.scene) this.world.setLightingMode(s.dayMode ? 'day' : 'night');
    document.body.classList.toggle('daymode', !!s.dayMode);
    document.body.classList.toggle('contrast-high', !!s.highContrast);
    document.body.classList.toggle('text-lg', !!s.largeText);
    document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--touch-scale', String(s.btnSize != null ? s.btnSize : 1));
    rootStyle.setProperty('--joy-scale', String(s.joySize != null ? s.joySize : 1));
    rootStyle.setProperty('--joy-op', String(s.joyOpacity != null ? s.joyOpacity : 0.55));
    rootStyle.setProperty('--btn-op', String(s.btnOpacity != null ? s.btnOpacity : 0.8));
    rootStyle.setProperty('--hud-scale', String(s.hudScale != null ? s.hudScale : 1));
    rootStyle.setProperty('--look-scale', String(s.lookStickSize != null ? s.lookStickSize : 1));
    if (this.touch) this.touch.applySettings();

    // particles
    this.particles && this.particles.setQuality(s.quality, s.perfMode);

    // audio
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.ambVolume);

    if (!initial) this.saveSettings();
    this.ui && this.ui.syncSettingsControls(s);
  }

  setActiveFov(fov) {
    if (Math.abs(fov - this._fovCurrent) > 0.02) {
      this._fovCurrent = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _onResize() {
    if (!this.renderer) return;
    const vv = window.visualViewport;
    const w = Math.max(320, vv ? Math.round(vv.width) : window.innerWidth);
    const h = Math.max(240, vv ? Math.round(vv.height) : window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.touch && this.touch.onResize) this.touch.onResize(w, h);
    if (this.tacmap && this.tacmap.open) this.tacmap.render2D();
    this._updateRotateOverlay();
  }

  /** Portrait gameplay on a touch phone is unplayable — say so, never break. */
  _updateRotateOverlay() {
    const el = document.getElementById('rotate-overlay');
    if (!el) return;
    const portrait = window.innerHeight > window.innerWidth;
    const show = !!this._touchPrimary && portrait && this.device && this.device.isPhone
      && this.state === GameState.PLAYING;
    el.classList.toggle('hidden', !show);
  }

  /** Classify the device ONCE (capability detection, not UA alone). */
  _detectDevice() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const touches = (navigator.maxTouchPoints || 0) > 0;
    const ua = navigator.userAgent || '';
    const isPhone = /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua)
      || (coarse && Math.min(window.screen ? screen.width : 9999, window.screen ? screen.height : 9999) < 760);
    const isTablet = !isPhone && (/iPad|Android|Tablet|PlayBook/i.test(ua) || (coarse && touches));
    this.device = { coarse, touches, isPhone, isTablet, isDesktop: !coarse && !touches };
    const mode = this.settings.touchControls;
    this._touchPrimary = mode === 'on' ? true : mode === 'off' ? false : coarse;
    document.body.classList.toggle('touch-device', !!this._touchPrimary);
    document.body.classList.toggle('touch-on', !!this._touchPrimary);
    if (this.touch) this.touch.setEnabled(!!this._touchPrimary);
    this._maybeSuggestPerf();
  }

  /** One-shot, NON-BLOCKING performance suggestion — main menu only, auto-hides. */
  _maybeSuggestPerf() {
    try {
      if (this._perfSuggestDone) return;
      if (this.state !== GameState.MENU) return;
      const weak = (navigator.deviceMemory && navigator.deviceMemory <= 4)
        || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
      if (!this._touchPrimary || !weak || localStorage.getItem('obv_perf_suggested')
          || this.settings.perfMode || this.settings.quality === 'low') return;
      this._perfSuggestDone = true;
      const el = document.getElementById('perf-suggest');
      if (!el) return;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 12000);   // never in the way for long
    } catch (e) { /* never block on detection */ }
  }

  // =========================================================================
  // Input
  // =========================================================================
  _bindInput() {
    const inp = this.input;

    document.addEventListener('keydown', (e) => {
      this._unlockAudioOnce();
      if (e.repeat) {
        if (e.code === 'Space') e.preventDefault();
        return;
      }
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': inp._w = true; break;
        case 'KeyS': case 'ArrowDown': inp._s = true; break;
        case 'KeyA': case 'ArrowLeft': inp._a = true; break;
        case 'KeyD': case 'ArrowRight': inp._d = true; break;
        case 'ShiftLeft': case 'ShiftRight': inp.sprint = true; break;
        case 'ControlLeft': case 'ControlRight':
          if (this.state === GameState.PLAYING) inp.crouch = !inp.crouch;
          e.preventDefault();
          break;
        case 'Space': inp.jumpPressed = true; inp.spaceHeld = true; e.preventDefault(); break;
        case 'KeyQ': inp.wheelHeld = true; break;
        case 'KeyE': inp.leanR = true; break;
        case 'KeyZ': inp.leanL = true; break;
        case 'KeyX': inp.leanR = true; break;
        case 'KeyC': inp.camPressed = true; break;
        case 'KeyR': inp.reloadPressed = true; break;
        case 'KeyG': inp.grenadePressed = true; break;
        case 'KeyH': inp.bandageHeld = true; break;
        case 'KeyM': inp.mapPressed = true; break;
        case 'KeyF': inp.interactPressed = true; inp.interactHeld = true; break;
        case 'Digit1': inp.selectWeapon = 'primary'; break;
        case 'Digit2': inp.selectWeapon = 'secondary'; break;
        case 'Digit3': inp.selectWeapon = 'throwable'; break;
        case 'Digit4': inp.selectWeapon = 'utility'; break;
        case 'Escape':
          if (this.tacmap && this.tacmap.open) this.tacmap.close();
          else if (this.state === GameState.PLAYING) this.pause();
          else if (this.state === GameState.PAUSED) this.resume();
          break;
        default: break;
      }
    });

    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': inp._w = false; break;
        case 'KeyS': case 'ArrowDown': inp._s = false; break;
        case 'KeyA': case 'ArrowLeft': inp._a = false; break;
        case 'KeyD': case 'ArrowRight': inp._d = false; break;
        case 'ShiftLeft': case 'ShiftRight': inp.sprint = false; break;
        case 'Space': inp.jumpPressed = false; inp.spaceHeld = false; break;
        case 'KeyQ': inp.wheelHeld = false; break;
        case 'KeyE': inp.leanR = false; break;
        case 'KeyZ': inp.leanL = false; break;
        case 'KeyX': inp.leanR = false; break;
        case 'KeyH': inp.bandageHeld = false; break;
        case 'KeyF': inp.interactHeld = false; inp.interactPressed = false; break;
        default: break;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.renderer.domElement) return;
      const cap = 160; // ignore ridiculous spikes from high-rate mice
      this.input.lookX += THREE.MathUtils.clamp(e.movementX || 0, -cap, cap);
      this.input.lookY += THREE.MathUtils.clamp(e.movementY || 0, -cap, cap);
    });

    document.addEventListener('mousedown', (e) => {
      this._unlockAudioOnce();
      if (this.state !== GameState.PLAYING) return;
      if (!this._touchPrimary && document.pointerLockElement !== this.renderer.domElement) {
        this._requestLock();
        return;
      }
      if (e.button === 0) this.input.mouse0 = true;
      if (e.button === 2) this.input.mouse2 = true;
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.mouse0 = false;
      if (e.button === 2) this.input.mouse2 = false;
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.renderer.domElement;
      this._locked = locked;
      if (!locked && this.state === GameState.PLAYING && !(this.tacmap && this.tacmap.open)) {
        // browser dropped the lock (ESC etc.) → pause rather than play blind
        // (the tactical map intentionally releases the lock while open)
        this.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.state === GameState.PLAYING) {
        this.ui.toastBrief('CLICK TO RE-CAPTURE MOUSE');
      }
    });
  }

  toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        const p = document.documentElement.requestFullscreen
          ? document.documentElement.requestFullscreen({ navigationUI: 'hide' }) : null;
        if (p && p.catch) p.catch(() => this.ui.toastBrief('FULLSCREEN UNAVAILABLE ON THIS DEVICE'));
      } else if (document.exitFullscreen) {
        const p = document.exitFullscreen();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { this.ui.toastBrief('FULLSCREEN UNAVAILABLE ON THIS DEVICE'); }
  }

  _requestLock() {
    if (this._touchPrimary) return;   // touch devices play without pointer lock
    const el = this.renderer.domElement;
    try {
      const p = el.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.ui.toastBrief('POINTER LOCK FAILED — CLICK AGAIN'); });
    } catch (e) {
      this.ui.toastBrief('POINTER LOCK FAILED — CLICK AGAIN');
    }
  }

  _unlockAudioOnce() {
    if (!this.audio.ready) {
      if (this.audio.init()) {
        this.applySettings(true);
        if (this.world.map) this.audio.startAmbience(this.world.machinePositions);
      }
    } else {
      this.audio.resume();
    }
  }

  /** Aggregate raw key flags into movement axes each frame. */
  _pollInput() {
    const inp = this.input;
    const keyF = (inp._w ? 1 : 0) - (inp._s ? 1 : 0);
    const keyR = (inp._d ? 1 : 0) - (inp._a ? 1 : 0);
    // touch joysticks contribute analog axes through the SAME command object
    inp.moveF = THREE.MathUtils.clamp(keyF + (inp._touchF || 0), -1, 1);
    inp.moveR = THREE.MathUtils.clamp(keyR + (inp._touchR || 0), -1, 1);
  }

  // =========================================================================
  // UI wiring
  // =========================================================================
  _bindUI() {
    const click = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        this.audio.init(); this.audio.resume(); this.audio.uiConfirm();
        fn();
      });
      el.addEventListener('mouseenter', () => { if (this.audio.ready) this.audio.uiHover(); });
    };

    click('btn-campaign', () => { this.ui.showScreen('select'); });
    click('btn-fullscreen', () => this.toggleFullscreen());
    click('btn-pause-objectives', () => { this.ui.buildObjectivesPanel(); this.ui.showScreen('objectives'); });
    click('btn-objectives-back', () => this.ui.showScreen('pause'));
    click('btn-pause-map', () => { this.resume(); this.tacmap.toggle(); });
    click('btn-pause-equipment', () => { this.ui.buildEquipmentPanel(); this.ui.showScreen('objectives'); });
    const perfApply = document.getElementById('btn-perf-apply');
    if (perfApply) perfApply.addEventListener('click', () => {
      this.settings.perfMode = true; this.saveSettings(); this.applySettings();
      document.getElementById('perf-suggest').classList.add('hidden');
      try { localStorage.setItem('obv_perf_suggested', '1'); } catch (e) { /* ignore */ }
      this.ui.syncSettingsControls(this.settings);
    });
    const perfDismiss = document.getElementById('btn-perf-dismiss');
    if (perfDismiss) perfDismiss.addEventListener('click', () => {
      document.getElementById('perf-suggest').classList.add('hidden');
      try { localStorage.setItem('obv_perf_suggested', '1'); } catch (e) { /* ignore */ }
    });
    click('btn-select-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen('menu'); });
    click('btn-mission-facility', () => this.ui.showBrief('facility', 'select'));
    click('btn-mission-snow', () => this.ui.showBrief('snow', 'select'));
    click('btn-mission-desert', () => this.ui.showBrief('desert', 'select'));
    click('btn-mission-urban', () => this.ui.showBrief('urban', 'select'));
    click('btn-brief-start', () => { if (this.ui._briefId) this.startMission(this.ui._briefId); });
    click('btn-brief-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen(this.ui._briefOrigin || 'select'); });
    click('btn-brief-loadout', () => this.ui.showScreen('select'));
    click('btn-training', () => this.startMission('range'));
    click('btn-missions', () => { this.ui.buildMissionsList(); this.ui.showScreen('missions'); });
    click('btn-missions-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen('menu'); });
    click('btn-loadout', () => { this.ui.buildLoadoutList(); this.ui.showScreen('loadout'); });
    click('btn-loadout-back', () => this.ui.showScreen('menu'));
    click('btn-intel', () => { this.ui.buildIntelList(); this.ui.showScreen('intel'); });
    click('btn-intel-back', () => this.ui.showScreen('menu'));
    click('btn-awards', () => { this.ui.buildAwardsList(); this.ui.showScreen('awards'); });
    click('btn-awards-back', () => this.ui.showScreen('menu'));
    click('btn-stats', () => { this.ui.buildStatsList(); this.ui.showScreen('stats'); });
    click('btn-stats-back', () => this.ui.showScreen('menu'));
    click('btn-complete-retry', () => this.startMission(this._lastMission));
    click('btn-complete-next', () => {
      const next = MISSION_ORDER[MISSION_ORDER.indexOf(this._lastMission) + 1];
      if (next && this.progress.isMissionUnlocked(next)) this.startMission(next);
      else this.abortToMenu();
    });
    const diffSel = document.getElementById('set-difficulty');
    if (diffSel) diffSel.addEventListener('change', (e) => {
      this.progress.setDifficulty(e.target.value);
      this.ui.syncDifficultyControl();
    });
    click('btn-settings', () => { this.ui.syncSettingsControls(this.settings); this.ui.showScreen('settings'); });
    click('btn-credits', () => { this.ui.showScreen('credits'); });
    click('btn-settings-back', () => {
      if (this.state === GameState.PAUSED) this.ui.showScreen('pause');
      else this.ui.showScreen('menu');
    });
    click('btn-credits-back', () => this.ui.showScreen('menu'));

    click('btn-resume', () => this.resume());
    click('btn-pause-settings', () => { this.ui.settingsReturnTo = 'pause'; this.ui.syncSettingsControls(this.settings); this.ui.showScreen('settings'); });
    click('btn-restart-cp', () => this.restartFromCheckpoint());
    click('btn-restart-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-quit', () => this.abortToMenu());

    click('btn-death-cp', () => this.restartFromCheckpoint());
    click('btn-death-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-death-menu', () => this.abortToMenu());

    click('btn-failed-cp', () => this.restartFromCheckpoint());
    click('btn-failed-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-failed-menu', () => this.abortToMenu());

    click('btn-complete-menu', () => this.abortToMenu());

    // tactical map controls + HUD map button
    click('hud-mapbtn', () => this.tacmap.toggle());
    click('tac-zoomin', () => this.tacmap.setZoom(1));
    click('tac-zoomout', () => this.tacmap.setZoom(-1));
    click('tac-rotbtn', () => this.tacmap.setRotate(this.tacmap.rotateMode === 'player' ? 'north' : 'player'));
    click('tac-routebtn', () => this.tacmap.setRoute(
      this.tacmap.routeSel === 'primary' ? 'optional' : this.tacmap.routeSel === 'optional' ? 'extraction' : 'primary'));
    click('tac-close', () => this.tacmap.close());

    // mini-map settings
    const mmOn = document.getElementById('set-minimap');
    if (mmOn) mmOn.addEventListener('change', e => { this.settings.minimapOn = e.target.checked; this.saveSettings(); });
    const mmSize = document.getElementById('set-minimap-size');
    if (mmSize) mmSize.addEventListener('change', e => { this.settings.minimapSize = e.target.value; this.saveSettings(); });
    const mmRot = document.getElementById('set-minimap-rotate');
    if (mmRot) mmRot.addEventListener('change', e => { this.settings.minimapRotate = e.target.value; this.saveSettings(); });

    // settings controls
    const bindRange = (id, valId, key, fmt, live) => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        this.settings[key] = v;
        document.getElementById(valId).textContent = fmt(v);
        if (live) live(v);
        this.saveSettings();
      });
    };
    bindRange('set-sens', 'val-sens', 'sensitivity', v => v.toFixed(2));
    bindRange('set-fov', 'val-fov', 'fov', v => String(v | 0), () => this.applySettings());
    bindRange('set-master', 'val-master', 'masterVolume', v => v.toFixed(2), v => this.audio.setVolumes(v, this.settings.sfxVolume, this.settings.ambVolume));
    bindRange('set-sfx', 'val-sfx', 'sfxVolume', v => v.toFixed(2), v => this.audio.setVolumes(this.settings.masterVolume, v, this.settings.ambVolume));
    bindRange('set-amb', 'val-amb', 'ambVolume', v => v.toFixed(2), v => this.audio.setVolumes(this.settings.masterVolume, this.settings.sfxVolume, v));
    bindRange('set-minimap-opacity', 'val-minimap-opacity', 'minimapOpacity', v => v.toFixed(2));
    bindRange('set-veh-sens', 'val-veh-sens', 'vehSteerSens', v => v.toFixed(2));
    bindRange('set-veh-cam', 'val-veh-cam', 'vehCamDist', v => v.toFixed(2));
    const vInv = document.getElementById('set-veh-invert');
    if (vInv) vInv.addEventListener('change', e => { this.settings.vehSteerInvert = e.target.checked; this.saveSettings(); });

    // touch controls + accessibility (Stage D)
    const bindSelect = (id, key, after) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', e => {
        this.settings[key] = e.target.value; this.saveSettings();
        if (after) after(e.target.value);
      });
    };
    const bindCheck = (id, key, after) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', e => {
        this.settings[key] = e.target.checked; this.saveSettings(); this.applySettings();
        if (after) after(e.target.checked);
      });
    };
    bindSelect('set-touch-mode', 'touchControls', () => { this._detectDevice(); });
    bindRange('set-joy-size', 'val-joy-size', 'joySize', v => v.toFixed(2));
    bindRange('set-joy-opacity', 'val-joy-opacity', 'joyOpacity', v => v.toFixed(2));
    bindRange('set-look-sens', 'val-look-sens', 'lookSens', v => v.toFixed(2));
    bindRange('set-aim-sens', 'val-aim-sens', 'aimSens', v => v.toFixed(2));
    bindRange('set-btn-size', 'val-btn-size', 'btnSize', v => v.toFixed(2));
    bindRange('set-btn-opacity', 'val-btn-opacity', 'btnOpacity', v => v.toFixed(2));
    bindRange('set-hud-scale', 'val-hud-scale', 'hudScale', v => v.toFixed(2));
    bindRange('set-shake', 'val-shake', 'shakeScale', v => v.toFixed(2));
    bindCheck('set-invert-y', 'invertY');
    bindCheck('set-auto-sprint', 'autoSprint');
    bindCheck('set-auto-fire', 'autoFire');
    bindCheck('set-vibration', 'vibration');
    bindSelect('set-aim-mode', 'aimMode', () => this.touch && this.touch.applySettings());
    bindSelect('set-aim-assist', 'aimAssist');
    bindCheck('set-contrast', 'highContrast');
    bindCheck('set-large-text', 'largeText');
    bindCheck('set-reduce-motion', 'reduceMotion');
    bindCheck('set-subtitles', 'subtitles');
    document.getElementById('set-quality').addEventListener('change', (e) => {
      this.settings.quality = e.target.value;
      this.saveSettings();
      this.applySettings();
    });
    document.getElementById('set-perf').addEventListener('change', (e) => {
      this.settings.perfMode = e.target.checked;
      this.saveSettings();
      this.applySettings();
    });
    document.getElementById('set-daymode').addEventListener('change', (e) => {
      this.settings.dayMode = e.target.checked;
      this.saveSettings();
      this.applySettings();
    });
  }

  // =========================================================================
  // State machine
  // =========================================================================
  setState(s) {
    if (s === GameState.MENU && this.ui) { this.ui.refreshMenuBadges(); this.ui.syncDifficultyControl(); }
    const prev = this.state;
    if (prev === s) return;
    this.state = s;
    this._updateRotateOverlay();

    switch (s) {
      case GameState.MENU:
        this.ui.showScreen('menu');
        this._maybeSuggestPerf();
        break;
      case GameState.LOADING:
        this.ui.showScreen('loading');
        break;
      case GameState.PLAYING:
        this.ui.hideAll();
        this.ui.hud.classList.remove('hidden');
        break;
      case GameState.PAUSED:
        this.ui.showScreen('pause');
        document.getElementById('btn-restart-cp').style.display = this.missions.hasCheckpoint ? '' : 'none';
        break;
      case GameState.DEAD:
        break; // death screen shown by onPlayerDeath (needs cause)
      case GameState.COMPLETE:
        break; // shown by missionComplete
      case GameState.FAILED:
        break; // shown by missionFailed
      default: break;
    }
  }

  pause() {
    if (this.state !== GameState.PLAYING) return;
    this.setState(GameState.PAUSED);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.mouse0 = false; this.input.mouse2 = false;
    this.wheelActive = false;
    this.ui.hideEqWheel();
    this.audio.suspend();
  }

  resume() {
    if (this.state !== GameState.PAUSED) return;
    this.audio.resume();
    this.setState(GameState.PLAYING);
    this._requestLock();
    // zero accumulated look deltas so the resume click doesn't jerk the view
    this.input.lookX = 0; this.input.lookY = 0;
  }

  // =========================================================================
  // Mission lifecycle
  // =========================================================================
  async startMission(id, checkpoint = null) {
    if (this.state === GameState.LOADING) return;
    const def = MISSION_DEFS[id] || (id === 'range' ? null : MISSION_DEFS.facility);
    this.setState(GameState.LOADING);
    this.ui.setLoading(0.05, 'DEPLOYING…');
    await raf(60);

    // tear down any previous mission
    this._teardownMission();

    this.ui.setLoading(0.15, 'GENERATING TERRAIN…');
    await raf();

    this.stats = { kills: 0, shots: 0, hits: 0, headshots: 0, missionTime: 0, dataSecured: false, damageTaken: 0, alarm: false, checkpointsUsed: 0, intelRun: 0, minHealth: 100, mapOpens: 0, equipCats: {}, usedVehicle: false, vehicleAbandoned: false, driveDist: 0, throwablesUsed: 0 };
    this.physics.clear();
    this.world.terminalUsed = false;

    this.ui.setLoading(0.35, def ? `CONSTRUCTING ${def.title}…` : 'BUILDING RANGE…');
    await raf();
    if (id !== 'range' && !this.progress.isMissionUnlocked(id)) {
      this.ui.toast('MISSION LOCKED', 'COMPLETE THE PREVIOUS OPERATION FIRST');
      this.setState(GameState.MENU);
      return;
    }
    this.world.buildByMap(def ? def.map : 'range', this.scene, this.physics);
    this.noiseMask = { rain: 0.72, snow: 0.88, dust: 0.94, fog: 1 }[this.world.weather] || 1;
    this._worldEvT = 35 + Math.random() * 45;
    this.tacmap.reset();

    this.ui.setLoading(0.6, 'DEPLOYING UNITS…');
    await raf();
    this.enemies.reset();
    this.enemies.group.clear();
    if (id !== 'range') {
      this.enemies.spawnInitial();
      this.enemies.spawnNPCs();
    }
    this.vehicleMode = null;
    this.vehicles.reset();
    this.vehicles.spawnFromWorld();
    this.ui.hideVehicleHUD();

    this.ui.setLoading(0.75, 'CALIBRATING WEAPONS…');
    await raf();
    this.weapons.reset(id === 'range');
    if (id === 'range') {
      for (const wid of WEAPON_ORDER) this.weapons.state[wid].reserve = 9999;
      this.throwables.reset({ throwable: 'vxfrag', throwableCount: 3, utility: 'medkit', utilityCount: 2 });
    } else {
      if (this.loadout.validate()) {   // invalid stored loadout → fall back to defaults
        Object.assign(this.loadout, { primary: 'vx4', secondary: 'p9', throwable: 'vxfrag', throwableCount: 2, utility: 'medkit', utilityCount: 1 });
        this.loadout.save();
      }
      const loc = this.loadout.current();
      this.weapons.applyLoadout(loc.primary, loc.secondary);
      this.throwables.reset(loc);
    }
    this.handsMode = 'gun';
    this.wheelActive = false;
    this.ui.hideEqWheel();
    this.player.reset(this.world.spawnPoint, this.world.spawnYaw);
    if (this.body && this.body.built) {
      this.body.setVisible(true);
      this.body.setThirdPerson(false);
      this.body.snug();          // avoid a one-frame lerp from the previous spawn
    }
    const diff = this.progress.difficulty;
    this.player.armor = diff.armor;
    this.player.bandageCdRate = diff.bandageCd;
    for (const ws of Object.values(this.weapons.state)) {
      if (ws.reserve > 1000) continue;
      ws.reserve = Math.max(0, Math.round(ws.reserve * diff.reserve));
    }
    this.weapons.applyFinish();
    this.particles.clear();
    this._clearGrenades();

    this.ui.setLoading(0.9, 'SYNCING OBJECTIVES…');
    await raf();
    if (!checkpoint) MissionManager.clearStoredCheckpoint();
    this.missions.checkpointData = null;
    this.missions._wave2 = false;
    this.missions.start(id, checkpoint);
    if (this.missions.def && this.missions.def.setup) {
      try { this.missions.def.setup(this); } catch (e) { console.warn('mission setup failed', e); }
    }

    this.particles.setWeather(this.world.weather || null);
    this.audio.setWind(this.world.windLevel || 0);
    if (this.audio.ready) {
      this.audio.startAmbience(this.world.machinePositions);
      this.audio.setZone('open');
    }
    this.applySettings();

    this.ui.setLoading(1, 'INSERTION COMPLETE — CLICK TO TAKE CONTROL');
    await raf(350);
    this.setState(GameState.PLAYING);
    this._requestLock();
    if (id === 'range') this.ui.toast('OPERATION: BLACK VECTOR', 'WEAPONS TRAINING — FIRE AT WILL');
    else if (checkpoint) this.ui.toast('CHECKPOINT', 'RESTORED — OBJECTIVE ACTIVE');
    else this.ui.toast('OPERATION: BLACK VECTOR — ' + def.title, def.flow === 'assault' ? 'ASSAULT — YOU ARE ON FOOT' : 'NIGHT INSERTION — YOU ARE ON FOOT');
  }

  _teardownMission() {
    if (this.world.group) {
      this.world.dispose(this.scene);
    }
    this.enemies.reset();
    this.vehicles.reset();
    this.vehicleMode = null;
    this.throwables.clearField();
    this.handsMode = 'gun';
    this.wheelActive = false;
    this.ui.hideEqWheel();
    if (this.audio.ready && this.audio.engineStop) this.audio.engineStop();
    this.particles.clear();
    this._clearGrenades();
    this.audio.stopAmbience();
    this.physics.clear();
    this.world.group = null;
    this.world.terminalUsed = false;
  }

  /** In-place reset back to the last checkpoint (fast — no world rebuild). */
  restartFromCheckpoint() {
    const cp = this.missions.checkpointData || MissionManager.loadStoredCheckpoint();
    if (!cp) { this.startMission(this.missions.missionId || 'facility'); return; }
    if (cp.mission && cp.mission !== this.missions.missionId) {
      this.startMission(cp.mission, cp);
      return;
    }

    // reset doors to their initial closed state
    for (const d of this.world.doors) {
      d.open = false; d.t = 0; d.moving = false;
      if (!d.slideUp) d.pivot.rotation.y = d.rotY;
      else d.mesh.position.y = d.height / 2;
      d.colliderObj.enabled = true;
      const c = d._makeCollider();
      d.colliderObj.min.copy(c.min);
      d.colliderObj.max.copy(c.max);
    }
    // reset pickups
    for (const it of this.world.interactables) {
      if (it.reset) it.reset();
      else if (it.id !== 'terminal') it.used = false;
    }
    // reset enemies & effects
    this.enemies.reset();
    this.enemies.group.clear();
    this.enemies.spawnInitial();
    this.enemies.spawnNPCs();
    this.vehicleMode = null;
    this.vehicles.reset();
    this.vehicles.spawnFromWorld();
    this.ui.hideVehicleHUD();
    this.particles.clear();
    this._clearGrenades();
    this.hackProgress = 0;
    this.hackTarget = null;

    this.stats.checkpointsUsed++;
    this.missions._wave2 = false;
    this.missions.checkpointData = cp;
    this.missions.start(cp.mission, cp);
    if (this.missions.def && this.missions.def.setup) {
      try { this.missions.def.setup(this); } catch (e) { console.warn('mission setup failed', e); }
    }
    this.player.restoreSnapshot(cp.player);
    if (cp.throwables) this.throwables.restoreInv(cp.throwables);
    else this.throwables.reset(this.loadout.current());
    this.throwables.clearField();
    this.handsMode = 'gun';
    this.weapons.rig.visible = true;
    this.ui.setThrowHighlight(null);

    if (this.audio.ready) {
      this.audio.resume();
      this.audio.startAmbience(this.world.machinePositions);
    }
    this.setState(GameState.PLAYING);
    this._requestLock();
    this.ui.toast('CHECKPOINT', 'RESTORED — OBJECTIVE ACTIVE');
  }

  missionComplete() {
    if (this.state !== GameState.PLAYING) return;
    this._clearVehicleMode();
    this.stats.dataSecured = this.world.terminalUsed;
    this.setState(GameState.COMPLETE);
    if (document.pointerLockElement) document.exitPointerLock();
    MissionManager.clearStoredCheckpoint();
    this.progress.save();
    this._lastMission = this.missions.missionId;
    const ctx = this.missions.missionRunContext(true);
    const result = this.progress.evaluateMission(ctx);
    this.ui.showDebrief(result, this.missions.def, ctx);
    this.audio.objectiveComplete();
  }

  missionFailed(reason) {
    if (this.state !== GameState.PLAYING) return;
    this._clearVehicleMode();
    this.progress.recordFailure(this.missions.missionId);
    this.setState(GameState.FAILED);
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showFailed(reason, !!this.missions.checkpointData);
  }

  onPlayerDeath(cause) {
    if (this.state !== GameState.PLAYING) return;
    this._clearVehicleMode();
    this.setState(GameState.DEAD);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.mouse0 = false;
    this.weapons.rig.visible = false;
    // let the death cam play for a beat before the screen
    setTimeout(() => {
      if (this.state === GameState.DEAD) {
        this.ui.showDeath(
          cause === 'injuries' ? 'You succumbed to your injuries.' : 'You were eliminated by hostile fire.',
          !!this.missions.checkpointData
        );
      }
    }, 1400);
  }

  abortToMenu() {
    this.particles.setWeather(null);
    if (this.audio.ready) this.audio.setWind(0);
    this.setState(GameState.MENU);
    if (document.pointerLockElement) document.exitPointerLock();
    this._teardownMission();
    this.missions.missionId = null;
    this.missions.stage = null;
    this.audio.stopAmbience();
  }

  onAlarmRaised(force = false) {
    void force;
    this.stats.alarm = true;
  }

  // =========================================================================
  // Shared simulation hooks
  // =========================================================================
  emitNoise(pos, radius, kind) {
    if (radius <= 0) return;
    this.enemies.hearNoise(pos, radius * this.noiseMask, kind);
  }

  /** ambient world events: distant firefights, intercepted radio chatter */
  _worldEvent() {
    if (this.missions.missionId === 'range') return;
    const b = this.world.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const a = Math.random() * Math.PI * 2;
    const d = 60 + Math.random() * 55;
    const px = THREE.MathUtils.clamp(this.player.pos.x + Math.cos(a) * d, b.minX + 4, b.maxX - 4);
    const pz = THREE.MathUtils.clamp(this.player.pos.z + Math.sin(a) * d, b.minZ + 4, b.maxZ - 4);
    if (Math.random() < 0.62) {
      const p = new THREE.Vector3(px, 1, pz);
      const n = 1 + Math.floor(Math.random() * 4);
      let t = 0;
      for (let i = 0; i < n; i++) { this.audio.gunshot('enemy_ar', p, { delay: t }); t += 0.12 + Math.random() * 0.35; }
    } else {
      const lines = {
        facility: 'RADIO (intercepted): "…conveyor two is jammed again — send the welder down…"',
        snow: 'RADIO (intercepted): "…relay goes dark at oh-three-hundred. Count your batteries…"',
        desert: 'RADIO (intercepted): "…sand in everything. The wadi route is hot — avoid it…"',
        urban: 'RADIO (intercepted): "…toll booths are closed. Nobody enters the district tonight…"',
        industrial: 'RADIO (intercepted): "…forge is running hot. Night shift stays clear of the hall…"',
        rural: 'RADIO (intercepted): "…livestock is spooked again. Check the fence line at dawn…"',
      };
      this.audio.radioSquelch(null);
      this.ui.radio(lines[this.world.map] || lines.facility);
    }
  }

  /** an intel document was picked up on the current map */
  onIntelPicked(map, idx, label) {
    const fresh = this.progress.recordIntel(map, idx);
    if (fresh) this.stats.intelRun++;
    this.audio.pickup(this.player.pos);
    this.ui.radio(fresh ? 'INTEL RECOVERED — ' + label : 'INTEL ALREADY IN ARCHIVE — ' + label);
    return fresh;
  }

  spawnGrenade(pos, vel, type = 'vxfrag') {
    this.grenades.push(new Grenade(this, pos, vel, type));
    const marker = this._markers.find(m => !m.visible);
    if (marker) {
      marker.visible = true;
      marker.position.set(pos.x + vel.x * 0.9, 0.05, pos.z + vel.z * 0.9);
      marker.userData.t = 0;
    }
    this.audio.impact('metal', pos, 0.5);
  }

  /** Convenience wrapper kept for compatibility — routes through the throwable system. */
  spawnThrowable(pos, vel, type) {
    this.spawnGrenade(pos, vel, type || 'vxfrag');
  }

  throwPlayerGrenade() {
    this.throwables.throwCurrent(false);
  }

  // =========================================================================
  // Hands state machine (C3): gun / throwable / utility + equipment wheel
  // =========================================================================
  equipGun() {
    if (this.handsMode === 'gun') return;
    this.handsMode = 'gun';
    this.weapons.rig.visible = !this.vehicleMode;
    this.ui.setThrowHighlight(null);
  }

  equipThrowable(id) {
    if (this.vehicleMode) return;
    if (id) { if (!this.throwables.select(id)) { this.ui.radio('NONE LEFT'); return; } }
    else if (!this.throwables.equipped || this.throwables.count(this.throwables.equipped) <= 0) {
      if (!this.throwables.cycle('throwable')) { this.ui.radio('NO THROWABLES LEFT'); return; }
    }
    this.handsMode = 'throwable';
    this.weapons.rig.visible = false;
    this.stats.equipCats.throwable = true;
    if (this.weapons.state_ === 'reloading') { this.weapons.state_ = 'ready'; this.weapons.stateT = 0; }
    this.ui.setThrowHighlight('throwable');
    this.ui.toastBrief(THROWABLE_DEFS[this.throwables.equipped].name + ' — LMB THROW · RMB SOFT TOSS · G CYCLE · 1 BACK TO GUN');
  }

  equipUtility(id) {
    if (this.vehicleMode) return;
    if (id) { if (!this.throwables.select(id)) { this.ui.radio('NONE LEFT'); return; } }
    else if (!this.throwables.utility || this.throwables.count(this.throwables.utility) <= 0) {
      if (!this.throwables.cycle('utility')) { this.ui.radio('NO UTILITY ITEMS LEFT'); return; }
    }
    this.handsMode = 'utility';
    this.weapons.rig.visible = false;
    this.stats.equipCats.utility = true;
    if (this.weapons.state_ === 'reloading') { this.weapons.state_ = 'ready'; this.weapons.stateT = 0; }
    this.ui.setThrowHighlight('utility');
    const d = THROWABLE_DEFS[this.throwables.utility];
    this.ui.toastBrief(d.name + (d.kind === 'place' ? ' — LMB PLACE · RMB DETONATE' : ' — LMB USE · 1 BACK TO GUN'));
  }

  _cycleHands() {
    if (this.vehicleMode) return;
    if (this.handsMode === 'gun') this.equipThrowable();
    else if (this.handsMode === 'throwable') {
      const id = this.throwables.cycle('throwable');
      if (id) this.ui.toastBrief(THROWABLE_DEFS[id].name + ' READY');
      else this.equipGun();
    } else {
      const id = this.throwables.cycle('utility');
      if (id) this.ui.toastBrief(THROWABLE_DEFS[id].name + ' READY');
      else this.equipGun();
    }
  }

  _selectSlot(slot) {
    if (slot === 'throwable') { this.equipThrowable(); return; }
    if (slot === 'utility') { this.equipUtility(); return; }
    const id = slot === 'secondary' ? this.loadout.secondary : this.loadout.primary;
    if (!id || !this.weapons.owned.has(id)) { this.ui.radio('NOT IN LOADOUT'); return; }
    this.equipGun();
    this.weapons.select(id);
  }

  _applyWheel(sel) {
    if (!sel) return;
    if (sel.cat === 'primary') { this.loadout.primary = sel.id; this.weapons.owned.add(sel.id); this.equipGun(); this.weapons.select(sel.id); this.stats.equipCats.primary = true; }
    else if (sel.cat === 'secondary') { this.loadout.secondary = sel.id; this.weapons.owned.add(sel.id); this.equipGun(); this.weapons.select(sel.id); this.stats.equipCats.secondary = true; }
    else if (sel.cat === 'throwable') this.equipThrowable(sel.id);
    else if (sel.cat === 'utility') this.equipUtility(sel.id);
    else if (sel.cat === 'mission') this.ui.toastBrief('MISSION GEAR IS ALWAYS CARRIED');
  }

  /** LMB/RMB while holding a throwable or utility item. */
  _handsFire(dt, inp) {
    this._throwCd -= dt;
    if (inp.mouse0 && this._throwCd <= 0) {
      this._throwCd = 0.5;
      this.throwables.throwCurrent(false);
    }
    if (inp.mouse2 && !this._mouse2Was) {
      this._throwCd = Math.max(this._throwCd, 0.35);
      this.throwables.altUse();
    }
    this._mouse2Was = inp.mouse2;
  }

  explodeAt(pos) {
    const R = 7.5;
    this.particles.muzzleFlash(pos, _upTmp, true);
    this.particles.impact(pos, _upTmp, 'metal', 2.4);
    this.particles.impact(pos, _upTmp, 'concrete', 2.4);
    this.particles.decals.spawn(new THREE.Vector3(pos.x, 0.02, pos.z), _upTmp, 'scorch', 1.5);
    this.audio.explosion(pos);
    this.emitNoise(pos, 90, 'explosion');
    const dp = pos.distanceTo(this.player.pos);
    if (dp < R && this.player.alive) {
      this.applyDamageToPlayer('torso', 92 * Math.pow(1 - dp / R, 1.35), pos.clone());
    }
    for (const e of this.enemies.list) {
      if (!e.alive) continue;
      const d = pos.distanceTo(e.pos);
      if (d < R) this.enemies.damage(e, 'torso', 135 * Math.pow(1 - d / R, 1.35), pos.clone());
    }
    if (dp < 16) this.addShake(Math.min(0.9, 0.85 * (1 - dp / 16)));
    if (dp < R) this.player.addSuppress(0.9);
  }

  _clearGrenades() {
    for (const gr of this.grenades) gr.dispose();
    this.grenades.length = 0;
    for (const m of this._markers) { m.visible = false; m.material.opacity = 0; }
    this.suppress = 0;
  }

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount * (this.settings.shakeScale != null ? this.settings.shakeScale : 1));
  }

  // =========================================================================
  // Vehicles (C2)
  // =========================================================================
  enterVehicle(v) {
    if (this.state !== GameState.PLAYING || this.vehicleMode || !v.drivable) return;
    if (v.driver === 'ai') v.driver = null;   // commandeered
    this.vehicleMode = v;
    v.driver = 'player';
    v.firstPerson = false;
    this.stats.usedVehicle = true;
    this.stats.equipCats.vehicle = true;
    this.weapons.rig.visible = false;
    // chase camera by default: the same operator rig is shown in third person
    this.body.setThirdPerson(!v.firstPerson);
    this.body.setVisible(!v.firstPerson);
    this.ui.showVehicleHUD(v);
    this.ui.toast('VEHICLE ACQUIRED', v.def.name + ' — W/S throttle · A/D steer · SPACE handbrake · SHIFT boost · C camera · F exit');
    if (this.audio.ready && this.audio.engineUpdate) this.audio.engineUpdate(0, true, 1, null);
    this.emitNoise(v.pos, 16, 'machine');
  }

  exitVehicle(forced = false) {
    const v = this.vehicleMode;
    if (!v) return;
    // safe egress: try both flanks, then front/rear; never inside geometry
    const fwd = new THREE.Vector3(-Math.sin(v.heading), 0, -Math.cos(v.heading));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const spots = [
      v.pos.clone().addScaledVector(right, -(v.def.wd / 2 + 1.0)),
      v.pos.clone().addScaledVector(right, (v.def.wd / 2 + 1.0)),
      v.pos.clone().addScaledVector(fwd, -(v.def.hl + 1.2)),
      v.pos.clone().addScaledVector(fwd, (v.def.hl + 1.2)),
    ];
    const mn = new THREE.Vector3(), mx = new THREE.Vector3(), hits = [];
    let chosen = spots[0];
    for (const s of spots) {
      hits.length = 0;
      mn.set(s.x - 0.4, s.y + 0.2, s.z - 0.4);
      mx.set(s.x + 0.4, s.y + 1.8, s.z + 0.4);
      this.physics.queryAABB(mn, mx, hits);
      let blocked = false;
      for (const c of hits) {
        const hgt = c.max.y - c.min.y;
        const area = (c.max.x - c.min.x) * (c.max.z - c.min.z);
        if (hgt > 0.5 && area < 40 && c.min.y < s.y + 1.7) { blocked = true; break; }
      }
      if (!blocked) { chosen = s; break; }
    }
    if (v.driver === 'player') v.driver = null;
    if (!forced && this.missions.isDriveStepActive) this.stats.vehicleAbandoned = true;
    this.vehicleMode = null;
    this.player.pos.copy(chosen);
    this.player.vel.set(0, 0, 0);
    this.player.yaw = v.heading;
    this.weapons.rig.visible = true;
    this.body.setThirdPerson(false);
    this.body.setVisible(true);
    this.ui.hideVehicleHUD();
    if (this.audio.ready && this.audio.engineStop) this.audio.engineStop();
    if (forced) this.ui.toast('VEHICLE LOST', 'CONTINUE ON FOOT');
  }

  /** Clear vehicle state without side effects (death / failure / completion). */
  _clearVehicleMode() {
    if (!this.vehicleMode) return;
    if (this.vehicleMode.driver === 'player') this.vehicleMode.driver = null;
    this.vehicleMode = null;
    this.weapons.rig.visible = true;
    this.body.setThirdPerson(false);
    this.ui.hideVehicleHUD();
    if (this.audio.ready && this.audio.engineStop) this.audio.engineStop();
  }

  /** Central damage gate: while driving, most incoming damage goes to the vehicle. */
  applyDamageToPlayer(zone, amount, fromPos) {
    const v = this.vehicleMode;
    if (v && v.drivable) {
      v.damage(amount * 1.6, this, fromPos ? fromPos.clone() : null);
      this.player.damage(zone, amount * 0.12, fromPos);   // shock bleed-through
      return;
    }
    this.player.damage(zone, amount, fromPos);
  }

  onWorldImpact(point, normal, material, energy) {
    this.particles.impact(point, normal, material, energy);
    const d = point.distanceTo(this.player.pos);
    if (d < 14) this.addShake(0.22 * energy * (1 - d / 14));
    if (material !== 'glass') this.particles.decals.spawn(point, normal, 'hole', 0.1 + energy * 0.05);
    this.audio.impact(material, point, energy);
    if (material === 'metal' && energy > 1) this.emitNoise(point, 8, 'impact');
  }

  // =========================================================================
  // Interaction (doors, terminal, pickups)
  // =========================================================================
  _updateInteraction(dt) {
    const inp = this.input;
    const cam = this.camera;
    cam.getWorldDirection(this._tmpV1);
    const it = this.world.findInteractable(cam.position, this._tmpV1, 2.6);

    this.interactTarget = it || null;
    if (!it || it.hold <= 0) {
      // instant interactions on key press edge
      if (this.hackTarget && (!it || it !== this.hackTarget)) {
        this.hackProgress = Math.max(0, this.hackProgress - dt * 2);
        if (this.hackProgress <= 0.001) this.hackTarget = null;
      }
      if (it && inp.interactPressed) {
        inp.interactPressed = false;
        const result = it.action(this);
        if (result !== false && !it.reusable && it.hold <= 0 && !it.id.startsWith('door')) it.used = true;
      }
      this.ui.setInteract(it ? (it.getPrompt ? it.getPrompt() : it.prompt) : null);
      if (!this.hackTarget) this.ui.setHackProgress(null);
      return;
    }

    // hold interaction (terminal / resupply)
    this.ui.setInteract(`HOLD [F] — ${it.getPrompt ? it.getPrompt() : it.prompt}`);
    this.hackTarget = it;
    if (inp.interactHeld) {
      this.hackProgress += dt / it.hold;
      if (this.hackProgress >= 1) {
        this.hackProgress = 0;
        this.hackTarget = null;
        it.action(this);
        if (!it.reusable) it.used = true;
        this.ui.setHackProgress(null);
        return;
      }
      if (Math.random() < dt * 6) this.audio.terminalBeep(it.pos);
    } else {
      this.hackProgress = Math.max(0, this.hackProgress - dt * 0.8);
    }
    this.ui.setHackProgress(this.hackProgress, it.id === 'terminal' ? 'DOWNLOADING TARGET DATA…' : 'RESUPPLYING…');
  }

  // =========================================================================
  // Main loop
  // =========================================================================
  _loop(nowMs) {
    requestAnimationFrame(this._loop);
    let dt = (nowMs - this._lastT) / 1000;
    this._lastT = nowMs;
    if (!isFinite(dt) || dt <= 0) dt = 0.016;
    dt = Math.min(dt, 0.05); // clamp after tab-outs; simulation stays stable

    if (this.touch) this.touch.update(dt);

    const st = this.state;
    if (st === GameState.PLAYING) {
      this._pollInput();
      if (this.input.mapPressed) { this.input.mapPressed = false; this.tacmap.toggle(); }
      if (this.tacmap.open) {
        // partial pause: the world freezes while the map is up, but keeps rendering
        this.input.lookX = 0; this.input.lookY = 0;
        this.input.jumpPressed = false; this.input.interactPressed = false;
        this.ui.updateHUD(dt);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      this.time += dt;
      this.stats.missionTime += dt;
      this.progress.tick(dt);
      if (this.player.health < this.stats.minHealth) this.stats.minHealth = this.player.health;

      const inp = this.input;

      // weapon / hands commands (edge-triggered)
      if (inp.reloadPressed) {
        inp.reloadPressed = false;
        if (this.handsMode !== 'gun') this.equipGun();
        else this.weapons.startReload();
      }
      if (inp.selectWeapon) { const slot = inp.selectWeapon; inp.selectWeapon = null; this._selectSlot(slot); }

      if (this.vehicleMode) {
        // edge inputs only — simulation happens in vehicles.update() below
        const v = this.vehicleMode;
        if (inp.camPressed) {
          inp.camPressed = false; v.firstPerson = !v.firstPerson;
          this.ui.toastBrief(v.firstPerson ? 'DRIVER CAMERA' : 'CHASE CAMERA');
          this.body.setThirdPerson(!v.firstPerson);
          this.body.setVisible(!v.firstPerson);
        }
        if (inp.interactPressed) { inp.interactPressed = false; this.exitVehicle(); }
      } else {
        this.player.update(dt, inp);
        if (this.handsMode === 'gun') {
          this.weapons.tryFire(this.time, inp.mouse0);
          this.weapons.update(dt, this.time, this.player);
          this._mouse2Was = inp.mouse2;
        } else {
          this._handsFire(dt, inp);
        }
      }
      if (this.shake > 0.001) {
        const s = this.shake;
        this.camera.rotation.x += (Math.random() - 0.5) * 0.028 * s;
        this.camera.rotation.y += (Math.random() - 0.5) * 0.028 * s;
        this.camera.rotation.z += (Math.random() - 0.5) * 0.02 * s;
        this.shake *= Math.exp(-6 * dt);
      } else this.shake = 0;
      this.enemies.update(dt);
      this.missions.update(dt);
      this._worldEvT -= dt;
      if (this._worldEvT <= 0) {
        this._worldEvT = 55 + Math.random() * 75;
        this._worldEvent();
      }
      // equipment wheel (hold Q): virtual cursor from mouse deltas, resolve on release
      if (inp.wheelHeld && !this.wheelActive && !this.vehicleMode && !this.tacmap.open) {
        this.wheelActive = true;
        this.wheelX = 0; this.wheelY = 0;
        this.ui.showEqWheel(this);
      }
      if (this.wheelActive) {
        if (inp.wheelHeld) {
          this.wheelX = THREE.MathUtils.clamp(this.wheelX + inp.lookX * 0.55, -180, 180);
          this.wheelY = THREE.MathUtils.clamp(this.wheelY - inp.lookY * 0.55, -180, 180);
          this.ui.moveWheelCursor(this.wheelX, this.wheelY);
          inp.lookX = 0; inp.lookY = 0;
        } else {
          this.wheelActive = false;
          const sel = this.ui.resolveWheel(this.wheelX, this.wheelY);
          this.ui.hideEqWheel();
          this._applyWheel(sel);
        }
      }

      // interaction while driving: the contextual action IS exiting (F / touch INTERACT)
      if (this.vehicleMode) {
        this.interactTarget = null;
        this.ui.setInteract('EXIT VEHICLE');
        if (this.hackTarget) { this.hackTarget = null; this.hackProgress = 0; this.ui.setHackProgress(null); }
      } else {
        this._updateInteraction(dt);
      }

      // consumed once per frame
      inp.lookX = 0; inp.lookY = 0;
      inp.jumpPressed = false;
      inp.interactPressed = false;
      inp.camPressed = false;

      this.world.update(dt, this);
      this.vehicles.update(dt);
      this.throwables.update(dt);
      const vm = this.vehicleMode;
      if (vm) {
        // the player entity rides the vehicle so triggers/missions/AI target it
        this.player.pos.copy(vm.pos);
        this.player.yaw = vm.heading;
        this.player.vel.set(0, 0, 0);
        vm.updateCamera(dt, this);
        this.ui.updateVehicleHUD(vm);
        this.stats.driveDist += Math.abs(vm.speed) * dt;
        if (this.shake > 0.001) {
          this.camera.rotation.x += (Math.random() - 0.5) * 0.028 * this.shake;
          this.camera.rotation.y += (Math.random() - 0.5) * 0.028 * this.shake;
          this.camera.rotation.z += (Math.random() - 0.5) * 0.02 * this.shake;
        }
        // engine noise attracts attention
        vm._noiseT = (vm._noiseT || 0) - dt;
        if (vm._noiseT <= 0 && Math.abs(vm.speed) > 1.5) {
          vm._noiseT = 0.5;
          this.emitNoise(vm.pos, 12 + Math.abs(vm.speed) * 0.9, 'machine');
        }
      }
      if (this.input.grenadePressed) { this.input.grenadePressed = false; this._cycleHands(); }
      this.tacmap.update(dt);
      for (let i = this.grenades.length - 1; i >= 0; i--) {
        const gr = this.grenades[i];
        gr.update(dt);
        if (gr.done) { this.throwables.detonate(gr.type, gr.pos); gr.dispose(); this.grenades.splice(i, 1); }
      }
      for (const m of this._markers) {
        if (!m.visible) continue;
        m.userData.t += dt;
        m.material.opacity = 0.35 + 0.3 * Math.sin(m.userData.t * 10);
        if (m.userData.t > 2.7) { m.visible = false; m.material.opacity = 0; }
      }
      this.suppress *= Math.exp(-0.85 * dt);
      if (this.suppress < 0.01) this.suppress = 0;
      this.audio.setSuppression(this.suppress);
      this.ui.setPinned(this.suppress > 0.5);
      this.particles.update(dt, this);

      // visible operator body: the same rig in first and third person
      if (this.body && this.body.built) {
        const bodyOn = !(this.vehicleMode && this.vehicleMode.firstPerson);
        if (this._bodyOn !== bodyOn) { this._bodyOn = bodyOn; this.body.setVisible(bodyOn); }
        if (bodyOn) this.body.update(dt, this.player);
      }

      // audio listener + zone
      this._zoneT -= dt;
      if (this._zoneT <= 0) {
        this._zoneT = 0.5;
        this.audio.setZone(this.world.getAudioZone(this.player.pos));
      }
      this.audio.update(this.camera, this.time, this._losFn);

      this.ui.updateHUD(dt);
      this.renderer.render(this.scene, this.camera);
    } else if (st === GameState.PAUSED || st === GameState.DEAD || st === GameState.COMPLETE || st === GameState.FAILED) {
      // keep rendering the frozen world behind the panel; death cam keeps animating
      if (st === GameState.DEAD) {
        this.player.update(dt, this.input);
        this.particles.update(dt, this);
        this.world.update(dt, this);
        this.enemies.update(dt);
        // the death camera sinks to the ground — hide the rig so it cannot clip
        if (this.body && this.body.built) this.body.setVisible(false);
      }
      this.renderer.render(this.scene, this.camera);
    } else if (st === GameState.LOADING) {
      this.renderer.render(this.scene, this.camera);
    }
    // MENU / BOOT: nothing rendered (opaque menu covers the viewport)
  }
}

function raf(delay = 0) {
  return new Promise(res => {
    if (delay > 0) setTimeout(() => requestAnimationFrame(() => res()), delay);
    else requestAnimationFrame(() => res());
  });
}

const _upTmp = new THREE.Vector3(0, 1, 0);
