/**
 * Efectos de sonido sintetizados con Web Audio (sin archivos): pase, bote, canasta, aro, tablero
 * y pitido de árbitro. Los navegadores solo dejan sonar tras una interacción: `unlock()` se llama
 * en el primer toque/tecla.
 */
type Pan = number; // −1 izquierda … 1 derecha

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('sfx-muted') === '1';
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      // Compresor suave para que los golpes fuertes no saturen.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.02);
    try {
      localStorage.setItem('sfx-muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** Evita que un mismo sonido se dispare varias veces seguidas (p. ej. varios contactos con el aro). */
  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.last.get(key) ?? -1e9) < ms) return false;
    this.last.set(key, now);
    return true;
  }

  private out(pan: Pan, gain: number): GainNode | null {
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return null;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.master);
    return g;
  }

  /** Ráfaga de ruido filtrado con envolvente. */
  private noiseHit(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, attack: number, decay: number, freqEnd?: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(env).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** Tono con caída de frecuencia y volumen (golpes graves). */
  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, decay: number, gain = 1, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(env).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  /** Bote del balón en el parqué: golpe grave + "palmada" de la goma. */
  bounce(strength = 1, pan: Pan = 0): void {
    if (!this.throttle('bounce', 70)) return;
    const o = this.out(pan, 0.55 * Math.min(1, 0.35 + strength * 0.65));
    if (!o) return;
    this.tone(o, 'sine', 140, 55, 0.12, 1);
    this.noiseHit(o, 'bandpass', 900, 1.2, 0.002, 0.05);
  }

  /** Pase: soplido de aire rápido y el "plof" al salir de las manos. */
  pass(pan: Pan = 0): void {
    if (!this.throttle('pass', 80)) return;
    const o = this.out(pan, 0.45);
    if (!o) return;
    this.noiseHit(o, 'bandpass', 600, 0.8, 0.01, 0.16, 2400);
    this.tone(o, 'sine', 220, 120, 0.07, 0.6);
  }

  /** Recepción del pase: palmada corta. */
  catch(pan: Pan = 0): void {
    if (!this.throttle('catch', 80)) return;
    const o = this.out(pan, 0.35);
    if (!o) return;
    this.noiseHit(o, 'bandpass', 1400, 1, 0.002, 0.06);
    this.tone(o, 'sine', 180, 90, 0.06, 0.5);
  }

  /** Aro: golpe metálico con armónicos inarmónicos. */
  rim(strength = 1, pan: Pan = 0): void {
    if (!this.throttle('rim', 120)) return;
    const o = this.out(pan, 0.5 * Math.min(1, 0.3 + strength * 0.25));
    if (!o) return;
    for (const [f, g, d] of [
      [523, 0.7, 0.45],
      [1187, 0.45, 0.3],
      [1893, 0.3, 0.22],
      [2760, 0.18, 0.15],
    ] as const) {
      this.tone(o, 'triangle', f, f * 0.98, d, g);
    }
    this.noiseHit(o, 'highpass', 2500, 0.7, 0.001, 0.04);
  }

  /** Tablero: golpe sordo de madera/metacrilato. */
  board(strength = 1, pan: Pan = 0): void {
    if (!this.throttle('board', 120)) return;
    const o = this.out(pan, 0.55 * Math.min(1, 0.4 + strength * 0.15));
    if (!o) return;
    this.tone(o, 'sine', 210, 120, 0.16, 1);
    this.tone(o, 'square', 420, 300, 0.05, 0.12);
    this.noiseHit(o, 'bandpass', 500, 1.5, 0.002, 0.1);
  }

  /** Canasta: "swish" de la red y el público. */
  basket(pan: Pan = 0, big = false): void {
    if (!this.throttle('basket', 400)) return;
    const o = this.out(pan, 0.6);
    if (!o) return;
    this.noiseHit(o, 'highpass', 3000, 0.6, 0.02, 0.32);
    this.noiseHit(o, 'bandpass', 5000, 2, 0.04, 0.2);
    const crowd = this.out(0, big ? 0.38 : 0.28);
    if (!crowd) return;
    this.noiseHit(crowd, 'bandpass', 1100, 0.5, 0.35, big ? 1.6 : 1.1, 700);
  }

  /** Pitido de árbitro: tono agudo con el trino de la bolita. */
  whistle(long = true): void {
    const o = this.out(0, 0.32);
    if (!o || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = long ? 0.75 : 0.25;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 2950;
    // Trino: modulación rápida de la frecuencia.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 38;
    const depth = ctx.createGain();
    depth.gain.value = 140;
    lfo.connect(depth).connect(osc.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.02);
    env.gain.setValueAtTime(1, t + dur - 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(o);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
    this.noiseHit(o, 'bandpass', 3000, 3, 0.02, dur * 0.9);
  }
}
