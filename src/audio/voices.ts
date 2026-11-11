// The four kinds of voice. Slosh and pour voices live as long as the graph and only move their params;
// drop and glass voices are a handful of nodes each, built for one event and disconnected when it ends.

import type { PourTone, SloshTone } from './liquids';
import { Glide, clamp } from './params';

/** Slosh level at full energy and a full vessel, before the master. */
const SLOSH_GAIN = 0.4;
/** Pour level at the highest flow, before the master. */
const POUR_GAIN = 0.6;

const ATTACK = 0.04;
const RELEASE = 0.25;

/**
 * Sloshing liquid in one vessel: pink noise through a band-pass that opens with energy, plus a narrow low band
 * for the body of liquid in the tank. A slow random movement sweeps both filters and the level, so it gurgles.
 */
export class SloshVoice {
  slot = -1;
  private level = 0;
  private target = 0;
  private quietSince = 0;
  private readonly env: GainNode;
  private readonly gEnv: Glide;
  private readonly gFreq: Glide;
  private readonly gQ: Glide;
  private readonly gFloor: Glide;
  private readonly gAir: Glide;
  private readonly gBody: Glide;
  private readonly gBodyFloor: Glide;
  private readonly gBodyAmp: Glide;
  private readonly gDepth: Glide;
  private readonly gDepthBody: Glide;
  private readonly gDepthAm: Glide;
  private readonly gRate: Glide;

  constructor(ctx: BaseAudioContext, pink: AudioBuffer, wobble: AudioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = pink;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 1.4;
    // pink noise is heavy below the band; a small tank has no rumble
    const floor = ctx.createBiquadFilter();
    floor.type = 'highpass'; floor.frequency.value = 150; floor.Q.value = 0.6;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass'; air.frequency.value = 3200; air.Q.value = 0.5;
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass'; body.frequency.value = 260; body.Q.value = 3.5;
    const bodyFloor = ctx.createBiquadFilter();
    bodyFloor.type = 'highpass'; bodyFloor.frequency.value = 130; bodyFloor.Q.value = 0.7;
    const bodyAmp = ctx.createGain();
    bodyAmp.gain.value = 1.6;
    const am = ctx.createGain();
    am.gain.value = 1;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    src.connect(bp).connect(floor).connect(air).connect(am);
    src.connect(body).connect(bodyFloor).connect(bodyAmp).connect(am);
    am.connect(this.env);

    const mod = ctx.createBufferSource();
    mod.buffer = wobble;
    mod.loop = true;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    const depthBody = ctx.createGain();
    depthBody.gain.value = 0;
    const depthAm = ctx.createGain();
    depthAm.gain.value = 0;
    mod.connect(depth).connect(bp.detune);
    mod.connect(depthBody).connect(body.detune);
    mod.connect(depthAm).connect(am.gain);

    // tolerances well under what the smoothing could make audible
    this.gEnv = new Glide(this.env.gain, 0.03, 2e-5);
    this.gFreq = new Glide(bp.frequency, 0.012, 1);
    this.gQ = new Glide(bp.Q, 0.03, 0.01);
    this.gFloor = new Glide(floor.frequency, 0.02, 1);
    this.gAir = new Glide(air.frequency, 0.02, 1);
    this.gBody = new Glide(body.frequency, 0.01, 1);
    this.gBodyFloor = new Glide(bodyFloor.frequency, 0.02, 1);
    this.gBodyAmp = new Glide(bodyAmp.gain, 0.03, 0.005);
    this.gDepth = new Glide(depth.gain, 0.05, 2);
    this.gDepthBody = new Glide(depthBody.gain, 0.05, 2);
    this.gDepthAm = new Glide(depthAm.gain, 0.05, 0.005);
    this.gRate = new Glide(mod.playbackRate, 0.05, 0.01);

    src.start(0, Math.random() * pink.duration);
    mod.start(0, Math.random() * wobble.duration);
  }

  /** Route this voice to a vessel's channel. Only called while it is silent. */
  assign(slot: number, dest: AudioNode, clock: number): void {
    this.env.disconnect();
    this.env.connect(dest);
    this.slot = slot;
    this.quietSince = clock;
  }

  /** Silent for long enough that it can be handed to another vessel. */
  idle(clock: number): boolean {
    return this.target === 0 && this.level < 1e-4 && clock - this.quietSince > 2;
  }

  /**
   * `a` is the slosh amount, 0 at rest to 1 at a violent slosh (already the square root of energy, rescaled);
   * `fill` is how full the vessel is, 0 to 1; `width` the vessel's width in CSS px.
   */
  drive(a: number, fill: number, width: number, S: SloshTone, clock: number, now: number, dt: number): void {
    const target = a > 0 ? SLOSH_GAIN * S.level * Math.pow(a, 0.85) * fill : 0;
    const tau = target > this.level ? ATTACK : RELEASE;
    this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    if (target === 0 && this.target !== 0) this.quietSince = clock;
    this.target = target;
    this.gEnv.to(target, now, tau);
    if (target === 0 && this.level < 1e-4) return;

    const k = Math.pow(a, 0.8);
    this.gFreq.to(S.lo * Math.pow(S.hi / S.lo, k), now, 0.08);
    this.gQ.to(S.qLo + (S.qHi - S.qLo) * a, now, 0.1);
    this.gFloor.to(S.lo * 0.5, now, 0.1);
    this.gAir.to(S.air, now, 0.1);
    // a small tank rings higher than a wide one
    const bodyHz = (320 - 140 * clamp((width - 250) / 1250, 0, 1)) * S.bodyPitch;
    this.gBody.to(bodyHz, now, 0.2);
    this.gBodyFloor.to(bodyHz * 0.5, now, 0.2);
    this.gBodyAmp.to(1.6 * S.body, now, 0.2);
    const g = S.gurgle * (0.35 + 0.65 * a);
    this.gDepth.to(g, now, 0.15);
    this.gDepthBody.to(-0.45 * g, now, 0.15);
    this.gDepthAm.to(0.4 * Math.min(1, a * 3), now, 0.15);
    this.gRate.to(S.gurgleRate * (0.6 + a), now, 0.2);
  }
}

/**
 * The stream between two vessels: white noise, high-passed, into two band-passes whose gains and centres
 * jitter at 30 to 80 Hz so it burbles. A narrow peak near 3 kHz is there for mercury and flat otherwise.
 */
export class PourVoice {
  private level = 0;
  private readonly gAmp: Glide;
  private readonly gPan: Glide;
  private readonly gHp: Glide;
  private readonly gA: Glide;
  private readonly gB: Glide;
  private readonly gQA: Glide;
  private readonly gQB: Glide;
  private readonly gMetal: Glide;
  private readonly gAir: Glide;
  private readonly gRateA: Glide;
  private readonly gRateB: Glide;

  constructor(ctx: BaseAudioContext, white: AudioBuffer, jitter: AudioBuffer, dest: AudioNode) {
    const src = ctx.createBufferSource();
    src.buffer = white;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900; hp.Q.value = 0.7;
    const bandA = ctx.createBiquadFilter();
    bandA.type = 'bandpass'; bandA.frequency.value = 1850; bandA.Q.value = 2.2;
    const bandB = ctx.createBiquadFilter();
    bandB.type = 'bandpass'; bandB.frequency.value = 3350; bandB.Q.value = 2.6;
    const jitA = ctx.createGain();
    jitA.gain.value = 0.55;
    const jitB = ctx.createGain();
    jitB.gain.value = 0.55;
    const metal = ctx.createBiquadFilter();
    metal.type = 'peaking'; metal.frequency.value = 3100; metal.Q.value = 9; metal.gain.value = 0;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass'; air.frequency.value = 5500; air.Q.value = 0.5;
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(hp);
    hp.connect(bandA).connect(jitA).connect(metal);
    hp.connect(bandB).connect(jitB).connect(metal);
    metal.connect(air).connect(amp).connect(pan).connect(dest);

    const modA = ctx.createBufferSource();
    modA.buffer = jitter;
    modA.loop = true;
    const modB = ctx.createBufferSource();
    modB.buffer = jitter;
    modB.loop = true;
    const depthA = ctx.createGain();
    depthA.gain.value = 0.45;
    const depthB = ctx.createGain();
    depthB.gain.value = 0.45;
    const detA = ctx.createGain();
    detA.gain.value = 120;
    const detB = ctx.createGain();
    detB.gain.value = 160;
    modA.connect(depthA).connect(jitA.gain);
    modA.connect(detA).connect(bandA.detune);
    modB.connect(depthB).connect(jitB.gain);
    modB.connect(detB).connect(bandB.detune);

    this.gAmp = new Glide(amp.gain, 0.03, 2e-5);
    this.gPan = new Glide(pan.pan, 0, 0.004);
    this.gHp = new Glide(hp.frequency, 0.01, 1);
    this.gA = new Glide(bandA.frequency, 0.012, 1);
    this.gB = new Glide(bandB.frequency, 0.012, 1);
    this.gQA = new Glide(bandA.Q, 0.01, 0.01);
    this.gQB = new Glide(bandB.Q, 0.01, 0.01);
    this.gMetal = new Glide(metal.gain, 0, 0.05);
    this.gAir = new Glide(air.frequency, 0.01, 1);
    this.gRateA = new Glide(modA.playbackRate, 0.05, 0.01);
    this.gRateB = new Glide(modB.playbackRate, 0.05, 0.01);

    src.start(0, Math.random() * white.duration);
    modA.start(0, Math.random() * jitter.duration);
    modB.start(0, Math.random() * jitter.duration);
  }

  /** Static colour of the stream for a liquid. */
  tone(P: PourTone, now: number): void {
    this.gHp.to(P.hp, now, 0.1);
    this.gQA.to(P.q, now, 0.1);
    this.gQB.to(P.q * 1.2, now, 0.1);
    this.gMetal.to(P.metal, now, 0.1);
    this.gAir.to(P.air, now, 0.1);
  }

  pan(p: number, now: number): void {
    this.gPan.to(p, now, 0.08);
  }

  /** `a` is the stream amount, 0 (off) to 1, already on a log scale of flow. */
  drive(a: number, P: PourTone, now: number, dt: number): void {
    const target = a > 0 ? POUR_GAIN * P.level * a : 0;
    const tau = target > this.level ? 0.08 : 0.15;
    this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    this.gAmp.to(target, now, tau);
    if (target === 0) return;
    this.gA.to(P.bandA * (1 + 0.35 * a), now, 0.1);
    this.gB.to(P.bandB * (1 + 0.3 * a), now, 0.1);
    this.gRateA.to(P.jitter * (0.6 + 0.8 * a), now, 0.1);
    this.gRateB.to(P.jitter * (0.75 + 0.85 * a), now, 0.1);
  }
}

/**
 * One water drop: a sine that dips and then sweeps up, the sound of the small bubble it traps,
 * with a tiny tick of noise at the moment it lands.
 */
export function playDrop(
  ctx: BaseAudioContext, dest: AudioNode, t: number,
  f0: number, rise: number, sweep: number, decay: number, level: number,
  click: AudioBuffer, clickLevel: number, onEnd: () => void,
): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  const f = osc.frequency;
  f.setValueAtTime(f0, t);
  f.linearRampToValueAtTime(f0 * 0.92, t + 0.004);
  f.exponentialRampToValueAtTime(f0 * rise, t + 0.004 + sweep);
  const g = env.gain;
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(level, t + 0.002);
  g.setTargetAtTime(0, t + 0.002, decay / 4.6);
  osc.connect(env).connect(dest);
  osc.start(t);
  osc.stop(t + 0.002 + decay * 1.8);

  const tick = ctx.createBufferSource();
  tick.buffer = click;
  const tg = ctx.createGain();
  tg.gain.value = clickLevel;
  tick.connect(tg).connect(dest);
  tick.start(t);
  tick.onended = () => { tick.disconnect(); tg.disconnect(); };
  osc.onended = () => { osc.disconnect(); env.disconnect(); onEnd(); };
}

// A struck glass beaker: inharmonic modes, the lowest split into a slowly beating pair.
const RATIOS = [1, 1.0021, 2.32, 4.25, 6.63, 9.38, 12.8];
const AMPS = [1, 0.55, 0.5, 0.32, 0.2, 0.12, 0.07];
/** Seconds to fall 40 dB; higher modes die faster. */
const DECAYS = [0.45, 0.42, 0.3, 0.21, 0.15, 0.11, 0.08];

/**
 * Modal synthesis of glass: up to seven exponentially decaying sine partials. `tilt` (0 to 1) sets how hard
 * the upper modes are struck; `level` is the amplitude of the lowest mode.
 */
export function playGlass(
  ctx: BaseAudioContext, dest: AudioNode, t: number,
  base: number, tilt: number, decay: number, level: number, partials: number,
  click: AudioBuffer, clickLevel: number, onEnd: () => void,
): void {
  const limit = Math.min(14000, ctx.sampleRate * 0.45);
  const nodes: AudioNode[] = [];
  let first: OscillatorNode | null = null;
  const n = Math.min(partials, RATIOS.length);
  for (let i = 0; i < n; i++) {
    const f = base * RATIOS[i]! * (1 + (Math.random() - 0.5) * 0.002);
    if (f > limit) break;
    const amp = level * AMPS[i]! * Math.pow(tilt, i < 2 ? 0 : i - 1);
    const tau = (DECAYS[i]! * decay) / 4.6;
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    const env = ctx.createGain();
    const g = env.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(amp, t + 0.0015);
    g.setTargetAtTime(0, t + 0.0015, tau);
    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + 0.0015 + tau * 8);
    nodes.push(osc, env);
    first ??= osc;
  }
  const tick = ctx.createBufferSource();
  tick.buffer = click;
  const tg = ctx.createGain();
  tg.gain.value = clickLevel;
  tick.connect(tg).connect(dest);
  tick.start(t);
  nodes.push(tick, tg);
  // the lowest mode rings longest, so its end is the voice's end
  const last = first ?? tick;
  last.onended = () => { for (const node of nodes) node.disconnect(); onEnd(); };
}
