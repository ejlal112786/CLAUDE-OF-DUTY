/**
 * audio.js
 * Procedural Web Audio engine. Every sound in the game is synthesised at
 * runtime — no external audio assets, nothing copyrighted.
 *
 * Features:
 *  - HRTF spatialisation (PannerNode) so direction can be judged by ear
 *  - Zone-based convolution reverb (open yard / warehouse / corridor / room)
 *    with procedurally generated impulse responses
 *  - Per-material impact voices, weapon profiles, footsteps, doors, UI
 *  - Ambient beds: wind, machinery hum, distant combat when the AI is alert
 *  - Voice cap + reuse of a single noise buffer to keep CPU/GC cost low
 */
import * as THREE from 'three';

const MAX_VOICES = 28;

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.failed = false;

    this.volumes = { master: 0.8, sfx: 0.9, amb: 0.7 };
    this.zone = 'open';
    this.alertLevel = 0;   // 0..1 — drives distant-combat scheduling
    this.activeVoices = 0;

    this._ambientNodes = [];
    this._nextDistantShot = 0;
    this._rand = Math.random;
  }

  // -------------------------------------------------------------------------
  /** Must be called from a user gesture (click) to satisfy autoplay policy. */
  init() {
    if (this.ready || this.failed) return this.ready;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API unavailable');
      this.ctx = new AC();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumes.master;
      this.suppFilter = this.ctx.createBiquadFilter();
      this.suppFilter.type = 'lowpass';
      this.suppFilter.frequency.value = 20000;
      this.master.connect(this.suppFilter);
      this.suppFilter.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.volumes.sfx;
      this.sfxBus.connect(this.master);

      this.ambBus = this.ctx.createGain();
      this.ambBus.gain.value = this.volumes.amb;
      this.ambBus.connect(this.master);

      // reverb bus (zone IR is swapped at runtime)
      this.reverbGain = this.ctx.createGain();
      this.reverbGain.gain.value = 0.2;
      this.convolver = this.ctx.createConvolver();
      this.convolver.normalize = true;
      this.reverbGain.connect(this.convolver);
      this.convolver.connect(this.master);

      this.irs = {
        open: this._makeIR(0.9, 2.2, 0.06),
        warehouse: this._makeIR(2.8, 2.6, 0.25),
        corridor: this._makeIR(1.4, 3.4, 0.18),
        room: this._makeIR(0.7, 2.8, 0.15),
      };
      this.convolver.buffer = this.irs.open;

      // shared white-noise buffer (2 s)
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.ready = true;
    if (this.windTarget > 0 && !this.windSrc) this._startWind();
      return true;
    } catch (e) {
      this.failed = true;
      console.warn('Audio init failed:', e);
      return false;
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  setVolumes(master, sfx, amb) {
    this.volumes = { master, sfx, amb };
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05);
    this.sfxBus.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.05);
    this.ambBus.gain.setTargetAtTime(amb, this.ctx.currentTime, 0.05);
  }

  setZone(zone) {
    if (zone === this.zone || !this.ready || !this.irs[zone]) return;
    this.zone = zone;
    this.convolver.buffer = this.irs[zone];
    // reverb amount depends on space
    const amounts = { open: 0.08, warehouse: 0.30, corridor: 0.24, room: 0.18 };
    this.reverbGain.gain.setTargetAtTime(amounts[zone] ?? 0.15, this.ctx.currentTime, 0.25);
  }

  // -------------------------------------------------------------------------
  // Voice plumbing
  // -------------------------------------------------------------------------
  _voiceAvailable() {
    return this.ready && this.ctx.state === 'running' && this.activeVoices < MAX_VOICES;
  }

  _track(node) {
    this.activeVoices++;
    node.onended = () => { this.activeVoices = Math.max(0, this.activeVoices - 1); };
  }

  /** Build an output chain: [source chain] → panner(optional) → sfxBus + reverb send */
  _makeChain(position, opts = {}) {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = opts.gain !== undefined ? opts.gain : 1;

    if (position) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = opts.refDistance || 1.5;
      p.rolloffFactor = opts.rolloff || 1.3;
      p.maxDistance = opts.maxDistance || 110;
      p.positionX.value = position.x;
      p.positionY.value = position.y;
      p.positionZ.value = position.z;
      out.connect(p);
      p.connect(this.sfxBus);
      const send = this.ctx.createGain();
      send.gain.value = opts.reverbSend !== undefined ? opts.reverbSend : 0.5;
      p.connect(send);
      send.connect(this.reverbGain);
    } else {
      out.connect(this.sfxBus);
      const send = this.ctx.createGain();
      send.gain.value = opts.reverbSend !== undefined ? opts.reverbSend : 0.35;
      out.connect(send);
      send.connect(this.reverbGain);
    }
    void t;
    return out;
  }

  _noiseSource(rate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = rate;
    return src;
  }

  _env(param, t0, attack, decay, peak) {
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(peak, t0 + attack);
    param.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // -------------------------------------------------------------------------
  // Weapons
  // -------------------------------------------------------------------------
  /**
   * kind: 'vx4' | 'mr7' | 'p9' | 'enemy_ar'
   * position null → first-person (player's own weapon).
   */
  gunshot(kind, position = null, opts = {}) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime + (opts.delay || 0);
    const chain = this._makeChain(position, {
      gain: opts.gain ?? 1,
      refDistance: 2, rolloff: 1.2, maxDistance: 160,
      reverbSend: position ? 0.7 : 0.45,
    });

    const P = {
      vx4:      { crackF: 2400, crackQ: 0.8, crackD: 0.055, bodyF: 190, bodyD: 0.10, tailD: 0.28, lp: 5200, peak: 0.85 },
      mr7:      { crackF: 1700, crackQ: 0.7, crackD: 0.09,  bodyF: 120, bodyD: 0.20, tailD: 0.55, lp: 4200, peak: 1.0 },
      p9:       { crackF: 3000, crackQ: 0.9, crackD: 0.04,  bodyF: 240, bodyD: 0.07, tailD: 0.18, lp: 6000, peak: 0.7 },
      enemy_ar: { crackF: 2200, crackQ: 0.8, crackD: 0.055, bodyF: 180, bodyD: 0.10, tailD: 0.30, lp: 5000, peak: 0.85 },
      st12:     { crackF: 2600, crackQ: 0.85, crackD: 0.05, bodyF: 200, bodyD: 0.11, tailD: 0.24, lp: 5400, peak: 0.85 },
      vekp:     { crackF: 3200, crackQ: 0.9, crackD: 0.032, bodyF: 250, bodyD: 0.055, tailD: 0.14, lp: 6400, peak: 0.6 },
      vx12:     { crackF: 1300, crackQ: 0.5, crackD: 0.13, bodyF: 95, bodyD: 0.26, tailD: 0.65, lp: 3200, peak: 1.0 },
      mpx5:     { crackF: 2900, crackQ: 0.85, crackD: 0.038, bodyF: 215, bodyD: 0.075, tailD: 0.18, lp: 5800, peak: 0.68 },
      cr9:      { crackF: 2700, crackQ: 0.8, crackD: 0.044, bodyF: 200, bodyD: 0.085, tailD: 0.21, lp: 5600, peak: 0.72 },
      rk4:      { crackF: 2100, crackQ: 0.75, crackD: 0.065, bodyF: 165, bodyD: 0.13, tailD: 0.34, lp: 4800, peak: 0.92 },
      sz8:      { crackF: 2600, crackQ: 0.8, crackD: 0.045, bodyF: 195, bodyD: 0.085, tailD: 0.2, lp: 5600, peak: 0.74 },
      lb9:      { crackF: 1500, crackQ: 0.6, crackD: 0.11, bodyF: 105, bodyD: 0.24, tailD: 0.8, lp: 3800, peak: 1.0 },
      decoy:    { crackF: 2300, crackQ: 0.8, crackD: 0.055, bodyF: 185, bodyD: 0.1, tailD: 0.3, lp: 5000, peak: 0.85 },
    }[kind] || { crackF: 2400, crackQ: 0.8, crackD: 0.055, bodyF: 190, bodyD: 0.10, tailD: 0.28, lp: 5200, peak: 0.85 };

    // crack: sharp filtered noise transient
    const noise = this._noiseSource(1);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = P.crackF; bp.Q.value = P.crackQ;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = P.lp;
    const ng = this.ctx.createGain();
    this._env(ng.gain, t, 0.001, P.crackD, P.peak);
    noise.connect(bp); bp.connect(lp); lp.connect(ng); ng.connect(chain);
    noise.start(t, Math.random() * 1.5); noise.stop(t + P.crackD + 0.05);
    this._track(noise);

    // body: low sine thump with pitch drop
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(P.bodyF * 2.2, t);
    osc.frequency.exponentialRampToValueAtTime(P.bodyF, t + P.bodyD);
    const og = this.ctx.createGain();
    this._env(og.gain, t, 0.002, P.bodyD, P.peak * 0.8);
    osc.connect(og); og.connect(chain);
    osc.start(t); osc.stop(t + P.bodyD + 0.05);

    // tail: noise through a decaying lowpass (report lingering in the space)
    const tail = this._noiseSource(0.7);
    const tlp = this.ctx.createBiquadFilter();
    tlp.type = 'lowpass';
    tlp.frequency.setValueAtTime(2600, t);
    tlp.frequency.exponentialRampToValueAtTime(240, t + P.tailD);
    const tg = this.ctx.createGain();
    this._env(tg.gain, t + 0.01, 0.005, P.tailD, P.peak * 0.35);
    tail.connect(tlp); tlp.connect(tg); tg.connect(chain);
    tail.start(t, Math.random() * 1.5); tail.stop(t + P.tailD + 0.1);
  }

  // ---------------------------------------------------------------------
  // Vehicle engine: one shared voice (player) + optional positional hum.
  // Pure synthesis — saw through a lowpass, pitch tracks speed.
  // ---------------------------------------------------------------------
  _ensureEngine() {
    if (this._eng || !this.ready) return this._eng;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 48;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = 24;
    const sg = ctx.createGain();
    sg.gain.value = 0.5;
    osc.connect(lp); sub.connect(sg); sg.connect(lp); lp.connect(g);
    g.connect(this.sfxBus ? this.sfxBus : ctx.destination);
    osc.start(); sub.start();
    this._eng = { osc, sub, lp, g, pos: null, panner: null };
    return this._eng;
  }

  engineUpdate(rpmNorm, load, vol = 1, position = null) {
    const e = this._ensureEngine();
    if (!e) return;
    const t = this.ctx.currentTime;
    const rpm = Math.min(1, Math.max(0, rpmNorm));
    e.osc.frequency.setTargetAtTime(44 + rpm * 105 + (load ? 14 : 0), t, 0.08);
    e.sub.frequency.setTargetAtTime(22 + rpm * 52, t, 0.08);
    e.lp.frequency.setTargetAtTime(300 + rpm * 1500 + (load ? 380 : 0), t, 0.08);
    e.g.gain.setTargetAtTime((0.05 + rpm * 0.1 + (load ? 0.035 : 0)) * vol, t, 0.1);
    void position; // positional falloff approximated by vol (single shared voice)
  }

  /** Flashbang: bright transient + disorienting ring. */
  flashbang(position = null) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 1, refDistance: 3, rolloff: 1.1, maxDistance: 90, reverbSend: position ? 0.6 : 0.3 });
    const pop = this._noiseSource(1);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1800;
    const pg = this.ctx.createGain();
    this._env(pg.gain, t, 0.002, 0.12, 0.9);
    pop.connect(hp); hp.connect(pg); pg.connect(chain);
    pop.start(t, Math.random() * 1.3); pop.stop(t + 0.2);
    this._track(pop);
    const ring = this.ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(4200, t);
    ring.frequency.exponentialRampToValueAtTime(3100, t + 1.4);
    const rg = this.ctx.createGain();
    this._env(rg.gain, t + 0.02, 0.05, 1.3, 0.16);
    ring.connect(rg); rg.connect(chain);
    ring.start(t); ring.stop(t + 1.6);
    this._track(ring);
  }

  /** Soft device deploy chirp (sensor / charge armed). */
  deviceChirp(position = null) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.5, refDistance: 1.5, rolloff: 1.4, maxDistance: 30, reverbSend: 0.2 });
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 1500 + i * 420;
      const g = this.ctx.createGain();
      this._env(g.gain, t + i * 0.12, 0.004, 0.06, 0.1);
      o.connect(g); g.connect(chain);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.1);
      this._track(o);
    }
  }

  engineStop() {
    const e = this._eng;
    if (!e || !this.ready) return;
    e.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
  }

  dryFire(position = null) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.5, reverbSend: 0.2 });
    this._click(t, chain, 2600, 0.03, 0.5);
  }

  // -------------------------------------------------------------------------
  // Impacts (material-dependent)
  // -------------------------------------------------------------------------
  impact(material, position, energy = 1) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: Math.min(1, 0.5 + energy * 0.4), refDistance: 1.2, reverbSend: 0.5 });

    switch (material) {
      case 'metal': {
        // ping: two detuned resonant bandpasses over a tick
        this._click(t, chain, 3400, 0.02, 0.7);
        for (const f of [1150 + Math.random() * 300, 1730 + Math.random() * 250]) {
          const osc = this.ctx.createOscillator();
          osc.type = 'triangle'; osc.frequency.value = f;
          const g = this.ctx.createGain();
          this._env(g.gain, t, 0.002, 0.35, 0.16 * energy);
          osc.connect(g); g.connect(chain);
          osc.start(t); osc.stop(t + 0.45);
        }
        break;
      }
      case 'glass': this.glassBreak(position); break;
      case 'wood': {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(420, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.06);
        const g = this.ctx.createGain();
        this._env(g.gain, t, 0.002, 0.09, 0.5 * energy);
        osc.connect(g); g.connect(chain);
        osc.start(t); osc.stop(t + 0.15);
        this._noiseBurst(t, chain, 900, 0.05, 0.25 * energy);
        break;
      }
      case 'soil':
      case 'gravel':
        this._noiseBurst(t, chain, 500, 0.10, 0.4 * energy, 'lowpass');
        break;
      case 'fabric':
        this._noiseBurst(t, chain, 700, 0.05, 0.22 * energy, 'lowpass');
        break;
      default: // concrete
        this._noiseBurst(t, chain, 1400, 0.07, 0.45 * energy, 'lowpass');
        this._click(t, chain, 2200, 0.02, 0.4 * energy);
        break;
    }
  }

  glassBreak(position) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.8, reverbSend: 0.6 });
    // initial crack
    this._noiseBurst(t, chain, 5200, 0.05, 0.6, 'highpass');
    // tinkling shards
    for (let i = 0; i < 7; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2400 + Math.random() * 4200;
      const g = this.ctx.createGain();
      const tt = t + 0.02 + i * 0.028 + Math.random() * 0.03;
      this._env(g.gain, tt, 0.001, 0.12 + Math.random() * 0.15, 0.09);
      osc.connect(g); g.connect(chain);
      osc.start(tt); osc.stop(tt + 0.35);
    }
  }

  // -------------------------------------------------------------------------
  // Movement / interaction
  // -------------------------------------------------------------------------
  footstep(material, position, intensity = 1) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.4 * intensity, refDistance: 1, maxDistance: 60, reverbSend: 0.4 });
    const f = material === 'metal' ? 1700 : material === 'wood' ? 900 : material === 'gravel' ? 2600 : 1200;
    this._noiseBurst(t, chain, f * (0.85 + Math.random() * 0.3), 0.055, 0.5, material === 'metal' ? 'bandpass' : 'lowpass');
    if (material === 'metal') this._click(t, chain, 2100, 0.025, 0.25 * intensity);
  }

  jump(position) { this._rustle(position, 0.25); }
  land(position, hard) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: hard ? 0.7 : 0.4, reverbSend: 0.4 });
    this._noiseBurst(t, chain, 700, hard ? 0.12 : 0.07, 0.6, 'lowpass');
  }

  doorSound(position, phase /* 'open' | 'close' */) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.6, reverbSend: 0.55 });
    // hinge creak: detuned sawtooth through a moving bandpass
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    const f0 = phase === 'open' ? 210 : 260;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f0 * (phase === 'open' ? 1.5 : 0.7), t + 0.7);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.1);
    g.gain.setValueAtTime(0.05, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    osc.connect(bp); bp.connect(g); g.connect(chain);
    osc.start(t); osc.stop(t + 0.8);
    // latch click at the end
    this._click(t + 0.72, chain, 2500, 0.03, 0.5);
  }

  pickup(position) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position || null, { gain: 0.4 });
    this._tone(t, chain, 620, 0.07, 0.4, 'sine');
    this._tone(t + 0.08, chain, 880, 0.09, 0.4, 'sine');
  }

  // -------------------------------------------------------------------------
  // Reload / weapon handling (first-person, 2D)
  // -------------------------------------------------------------------------
  wpnClick(freq = 2300, gain = 0.4, delay = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const chain = this._makeChain(null, { gain, reverbSend: 0.15 });
    this._click(t, chain, freq, 0.025, 1);
  }

  wpnMagOut(delay = 0) { this.wpnClick(1500, 0.5, delay); this.wpnClick(900, 0.3, delay + 0.03); }
  wpnMagIn(delay = 0) { this.wpnClick(2000, 0.6, delay); this._rustle(null, 0.15, delay); }
  wpnBolt(delay = 0) { this.wpnClick(2800, 0.55, delay); this.wpnClick(1200, 0.4, delay + 0.06); }
  wpnRaise(delay = 0) { this._rustle(null, 0.3, delay); }
  casingDrop(position, delay = 0.15) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const chain = this._makeChain(null, { gain: 0.16, reverbSend: 0.2 });
    this._tone(t, chain, 3100 + Math.random() * 600, 0.06, 0.3, 'sine');
    this._tone(t + 0.09, chain, 2400 + Math.random() * 500, 0.05, 0.18, 'sine');
    void position;
  }

  // -------------------------------------------------------------------------
  // UI / mission
  // -------------------------------------------------------------------------
  uiHover() { if (this.ready) { const c = this._makeChain(null, { gain: 0.12, reverbSend: 0 }); this._tone(this.ctx.currentTime, c, 1200, 0.03, 0.5, 'sine'); } }
  uiConfirm() { if (this.ready) { const c = this._makeChain(null, { gain: 0.2, reverbSend: 0 }); this._tone(this.ctx.currentTime, c, 660, 0.06, 0.6, 'sine'); this._tone(this.ctx.currentTime + 0.07, c, 990, 0.09, 0.5, 'sine'); } }
  uiBack() { if (this.ready) { const c = this._makeChain(null, { gain: 0.18, reverbSend: 0 }); this._tone(this.ctx.currentTime, c, 440, 0.08, 0.6, 'sine'); } }

  objectiveComplete() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const c = this._makeChain(null, { gain: 0.22, reverbSend: 0.3 });
    this._tone(t, c, 523, 0.25, 0.5, 'sine');
    this._tone(t + 0.14, c, 784, 0.35, 0.5, 'sine');
  }

  hitMarker(kill) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const c = this._makeChain(null, { gain: 0.3, reverbSend: 0 });
    this._tone(t, c, kill ? 1500 : 2100, 0.045, 0.7, 'square');
    if (kill) this._tone(t + 0.03, c, 900, 0.06, 0.5, 'square');
  }

  playerHurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const c = this._makeChain(null, { gain: 0.5, reverbSend: 0.2 });
    this._noiseBurst(t, c, 320, 0.16, 0.9, 'lowpass');
    this._tone(t, c, 110, 0.14, 0.5, 'sine');
  }

  radioSquelch(position) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.35, refDistance: 1, maxDistance: 30, reverbSend: 0.3 });
    this._noiseBurst(t, chain, 2800, 0.09, 0.5, 'bandpass');
    this._noiseBurst(t + 0.12, chain, 2400, 0.14, 0.4, 'bandpass');
  }

  terminalBeep(position) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.25, reverbSend: 0.3 });
    this._tone(t, chain, 1046, 0.05, 0.5, 'square');
    this._tone(t + 0.09, chain, 1318, 0.07, 0.4, 'square');
  }

  alarm(position) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 0.5, maxDistance: 140, reverbSend: 0.6 });
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const tt = t + i * 0.55;
      osc.frequency.setValueAtTime(660, tt);
      osc.frequency.linearRampToValueAtTime(440, tt + 0.4);
      const g = this.ctx.createGain();
      this._env(g.gain, tt, 0.02, 0.42, 0.18);
      osc.connect(g); g.connect(chain);
      osc.start(tt); osc.stop(tt + 0.5);
    }
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------
  startAmbience(machinePositions = []) {
    if (!this.ready) return;
    this.stopAmbience();
    const ctx = this.ctx;

    // wind: looped noise through a slowly-modulated lowpass
    const wind = this._noiseSource(0.35);
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass'; wlp.frequency.value = 380;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 160;
    lfo.connect(lfoGain); lfoGain.connect(wlp.frequency);
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.045;
    const lfo2Gain = ctx.createGain(); lfo2Gain.gain.value = 0.03;
    lfo2.connect(lfo2Gain); lfo2Gain.connect(wg.gain);
    wind.connect(wlp); wlp.connect(wg); wg.connect(this.ambBus);
    wind.start(); lfo.start(); lfo2.start();
    this._ambientNodes.push(wind, lfo, lfo2);

    // machinery hums (spatialised, limited to 3 nearest sources)
    const chosen = machinePositions.slice(0, 3);
    for (const pos of chosen) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 48 + Math.random() * 8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 190;
      const g = ctx.createGain(); g.gain.value = 0.05;
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.refDistance = 3; p.rolloffFactor = 1.1; p.maxDistance = 45;
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      osc.connect(lp); lp.connect(g); g.connect(p); p.connect(this.ambBus);
      osc.start();
      this._ambientNodes.push(osc);
    }
  }

  stopAmbience() {
    for (const n of this._ambientNodes) {
      try { n.stop(); } catch (e) { /* not a source node */ }
      try { n.disconnect(); } catch (e) { /* already gone */ }
    }
    this._ambientNodes.length = 0;
  }

  // -------------------------------------------------------------------------
  // Low-level building blocks
  // -------------------------------------------------------------------------
  _click(t, chain, freq, dur, gain) {
    const noise = this._noiseSource(1);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = freq;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.001, dur, gain);
    noise.connect(hp); hp.connect(g); g.connect(chain);
    noise.start(t, Math.random() * 1.5); noise.stop(t + dur + 0.02);
  }

  _noiseBurst(t, chain, freq, dur, gain, type = 'bandpass') {
    const noise = this._noiseSource(0.8 + Math.random() * 0.4);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = type === 'bandpass' ? 1.2 : 0.7;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.002, dur, gain);
    noise.connect(f); f.connect(g); g.connect(chain);
    noise.start(t, Math.random() * 1.5); noise.stop(t + dur + 0.03);
  }

  _tone(t, chain, freq, dur, gain, type = 'sine') {
    const osc = this.ctx.createOscillator();
    osc.type = type; osc.frequency.value = freq;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.004, dur, gain);
    osc.connect(g); g.connect(chain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _rustle(position, gain = 0.2, delay = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const chain = this._makeChain(position, { gain, reverbSend: 0.2 });
    this._noiseBurst(t, chain, 1600, 0.09, 0.5, 'bandpass');
  }

  /** Procedural impulse response: exponentially-decaying noise, stereo. */
  _makeIR(duration, decayPow, earlyGain) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayPow);
      }
      // a couple of early reflections give the space some character
      const e1 = Math.floor(rate * 0.017), e2 = Math.floor(rate * 0.031);
      if (e1 < len) d[e1] += earlyGain;
      if (e2 < len) d[e2] += earlyGain * 0.7;
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  /** Called every frame: update listener transform + distant-combat bed. */
  setSuppression(x) {
    if (!this.ready || !this.suppFilter) return;
    const f = 20000 - 17200 * Math.min(1, x);
    this.suppFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.06);
  }

  explosion(position) {
    if (!this._voiceAvailable()) return;
    const t = this.ctx.currentTime;
    const chain = this._makeChain(position, { gain: 1, refDistance: 4, reverbSend: 1 });
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.5);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.004, 0.55, 1.0);
    osc.connect(g); g.connect(chain);
    osc.start(t); osc.stop(t + 0.8);
    this._noiseBurst(t, chain, 1500, 0.28, 1.0, 'lowpass');
    this._noiseBurst(t, chain, 480, 0.55, 0.8, 'lowpass');
  }

  setWind(level) {
    this.windTarget = level || 0;
    if (this.windTarget > 0 && this.ctx && !this.windSrc) this._startWind();
  }
  _startWind() {
    const len = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = last * 0.96 + w * 0.04;   // brown-ish noise
      d[i] = last * 3.2;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.4;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(lp).connect(this.windGain).connect(this.master);
    src.start();
    this.windSrc = src;
  }
  _updateWind(now) {
    if (!this.windGain) return;
    const gust = 0.55 + 0.3 * Math.sin(now * 0.23) + 0.18 * Math.sin(now * 0.61 + 2.1) + 0.08 * Math.sin(now * 1.7);
    const target = (this.windTarget || 0) * Math.max(0.1, gust) * 0.5;
    this.windGain.gain.value += (target - this.windGain.gain.value) * 0.04;
  }

  update(camera, now, hasLOSFn) {
    this._updateWind(now / 1000);
    if (!this.ready) return;
    const l = this.ctx.listener;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    if (l.positionX) {
      l.positionX.value = camera.position.x;
      l.positionY.value = camera.position.y;
      l.positionZ.value = camera.position.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(camera.position.x, camera.position.y, camera.position.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }

    // distant combat when the facility is on alert
    if (this.alertLevel > 0.2 && now > this._nextDistantShot) {
      this._nextDistantShot = now + 1.5 + Math.random() * 4 / this.alertLevel;
      const ang = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 50;
      const pos = new THREE.Vector3(
        camera.position.x + Math.cos(ang) * r,
        2 + Math.random() * 6,
        camera.position.z + Math.sin(ang) * r
      );
      if (!hasLOSFn || !hasLOSFn(camera.position, pos)) {
        this.gunshot(Math.random() < 0.5 ? 'enemy_ar' : 'vx4', pos, { gain: 0.28 });
      }
    }
  }
}
