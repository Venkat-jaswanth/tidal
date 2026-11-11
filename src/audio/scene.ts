// The whole sound of Tidal as one graph on any BaseAudioContext, so the live mix and an offline render
// share every line. Four layers, each silent while the water rests:
//   slosh  filtered noise per vessel, following the liquid's kinetic energy
//   drops  bubble blips on small wall impacts, rain, and a few carried by the slosh and the stream
//   glass  modal partials when liquid slaps the glass hard
//   pour   burbling noise while liquid moves between vessels
// Each vessel has its own stereo channel, panned to where its window sits on the screen.

import { clickBuffers, noiseBuffer, wobbleBuffer } from './buffers';
import { liquidTone, type LiquidTone } from './liquids';
import { Glide, clamp, expRand, rampTo } from './params';
import { PourVoice, SloshVoice, playDrop, playGlass } from './voices';

/** Vessel slots carried in the world meta. */
export const SLOTS = 16;
/** Master gain when sound is on. */
export const MASTER_MAX = 0.5;

/** How far ahead of the audio clock one-shot voices start, so their attack is never cut. */
const LOOKAHEAD = 0.015;
/** Below this mean squared speed the vessel is at rest and silent. */
const REST_ENERGY = 3e-5;
/** Mean squared speed of a violent slosh. */
const FULL_ENERGY = 0.012;
const SQRT_REST = Math.sqrt(REST_ENERGY);
const SQRT_FULL = Math.sqrt(FULL_ENERGY);
/** Millilitres at which a vessel sloshes at full level. */
const FULL_ML = 300;
const MAX_SLOSH = 8;
const MAX_DROPS = 16;
const MAX_GLASS = 6;
/** Per-vessel dead time after an impact onset, s. */
const REFRACTORY = 0.06;
/** Impact of the hardest slap. */
const SLAP_MAX = 0.02;
/** Pour hysteresis and full scale, mL/s. */
const POUR_ON = 25;
const POUR_OFF = 12;
const POUR_FULL = 400;
/** Rain drips: none at or below RAIN_MIN mL, then RAIN_PER_ML per second for each mL, up to RAIN_MAX. */
const RAIN_MIN = 2;
const RAIN_PER_ML = 0.09;
const RAIN_MAX = 25;
const DROP_GAIN = 0.12;
const GLASS_GAIN = 0.03;
/** Continuous params (slosh, pour) are moved at most this often; their smoothing is far slower. Events run every frame. */
const CONTROL_DT = 1 / 60 - 0.001;
/** Without a new frame for this long the mix fades out by itself (hidden or stalled window). */
const ALIVE_HOLD = 0.35;

/** What the scene needs from one frame of the world. `FrameMeta` satisfies it. */
export interface SceneFrame {
  ml: ArrayLike<number>;
  energy: ArrayLike<number>;
  impact: ArrayLike<number>;
  rainMl: number;
  flow: number;
  liquid: string;
}

const STILL: SceneFrame = {
  ml: new Float64Array(SLOTS), energy: new Float64Array(SLOTS), impact: new Float64Array(SLOTS),
  rainMl: 0, flow: 0, liquid: '',
};

export class SoundScene {
  /** Plinks and drips played so far. */
  plinks = 0;
  /** Glass strikes played so far. */
  slaps = 0;
  /** The pour stream is running. */
  pouring = false;

  private readonly bus: GainNode;
  private readonly alive: GainNode;
  private readonly master: GainNode;
  private readonly anL: AnalyserNode;
  private readonly anR: AnalyserNode;
  private readonly scope: Float32Array<ArrayBuffer>;

  private readonly pink: AudioBuffer;
  private readonly gurgle: AudioBuffer;
  private readonly clicks: AudioBuffer[];
  private readonly pour: PourVoice;
  private readonly slosh: SloshVoice[] = [];
  private readonly voiceOf = new Int8Array(SLOTS).fill(-1);

  private readonly strips: (StereoPannerNode | null)[] = new Array<StereoPannerNode | null>(SLOTS).fill(null);
  private readonly stripPan: (Glide | null)[] = new Array<Glide | null>(SLOTS).fill(null);
  private readonly panOf = new Float64Array(SLOTS);
  private readonly widthOf = new Float64Array(SLOTS).fill(600);
  private readonly seen = new Int32Array(SLOTS);
  private stamp = 0;

  // impact onsets, per slot
  private readonly prevImpact = new Float64Array(SLOTS);
  private readonly lastOnset = new Float64Array(SLOTS).fill(-1);
  private readonly rang = new Uint8Array(SLOTS);
  // volume change per slot, mL/s, smoothed
  private readonly prevMl = new Float64Array(SLOTS);
  private readonly rate = new Float64Array(SLOTS);
  private haveMl = false;
  // all volume change, and the part of it that moved between vessels, mL/s, smoothed
  private moved = 0;
  private transfer = 0;
  // waits until the next random event, in events (exponential, mean 1)
  private readonly bubbleWait = new Float64Array(SLOTS).fill(1);
  private rainWait = 1;
  private pourWait = 1;

  private tone: LiquidTone = liquidTone('water');
  private liquidId = 'water';
  private activeDrops = 0;
  private activeGlass = 0;
  private clock = 0;
  private controlDt = 0;
  private aliveUntil = -Infinity;

  constructor(readonly ctx: BaseAudioContext, destination: AudioNode) {
    this.bus = ctx.createGain();
    this.alive = ctx.createGain();
    this.alive.gain.value = 0;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // a safety limiter only: the mix peaks well below its threshold
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    const tap = ctx.createGain();
    this.bus.connect(this.alive).connect(this.master).connect(limiter).connect(tap).connect(destination);
    const split = ctx.createChannelSplitter(2);
    this.anL = ctx.createAnalyser();
    this.anR = ctx.createAnalyser();
    this.anL.fftSize = this.anR.fftSize = 4096;
    tap.connect(split);
    split.connect(this.anL, 0);
    split.connect(this.anR, 1);
    this.scope = new Float32Array(this.anL.fftSize);

    this.pink = noiseBuffer(ctx, 5, true, 0.3);
    const white = noiseBuffer(ctx, 4, false, 0.3);
    this.gurgle = wobbleBuffer(ctx, 13, 3);
    const jitter = wobbleBuffer(ctx, 3, 50);
    this.clicks = clickBuffers(ctx, 6);
    this.pour = new PourVoice(ctx, white, jitter, this.bus);
    this.pour.tone(this.tone.pour, ctx.currentTime);
  }

  // ---------------------------------------------------------------- output

  /** Fade the whole mix in. */
  open(now: number, seconds: number): void {
    rampTo(this.master.gain, MASTER_MAX, now, seconds);
  }

  /** Fade the whole mix out. */
  close(now: number, seconds: number): void {
    rampTo(this.master.gain, 0, now, seconds);
  }

  /** RMS of the final output, both channels together. */
  rms(): number {
    const l = this.channelRms(this.anL), r = this.channelRms(this.anR);
    return Math.sqrt((l * l + r * r) / 2);
  }

  rmsLeft(): number { return this.channelRms(this.anL); }
  rmsRight(): number { return this.channelRms(this.anR); }

  private channelRms(an: AnalyserNode): number {
    const buf = this.scope;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]!; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  // ---------------------------------------------------------------- geometry

  /** Start a new list of vessels; slots not given again are treated as gone. */
  beginGeometry(): void {
    this.stamp++;
  }

  /** A vessel's position on screen, in CSS px; it pans the vessel's channel. */
  setVessel(slot: number, x: number, w: number, screenLeft: number, screenWidth: number, now: number): void {
    if (slot < 0 || slot >= SLOTS) return;
    const pan = clamp(((x + w / 2 - screenLeft) / Math.max(1, screenWidth)) * 2 - 1, -1, 1) * 0.8;
    this.panOf[slot] = pan;
    this.widthOf[slot] = Math.max(40, w);
    this.seen[slot] = this.stamp;
    this.stripPan[slot]?.to(pan, now, 0.06);
  }

  private strip(slot: number): StereoPannerNode {
    let p = this.strips[slot];
    if (!p) {
      p = this.ctx.createStereoPanner();
      p.pan.value = this.panOf[slot]!;
      p.connect(this.bus);
      this.strips[slot] = p;
      this.stripPan[slot] = new Glide(p.pan, 0, 0.003);
    }
    return p;
  }

  // ---------------------------------------------------------------- per frame

  /** Forget per-frame history, for example after this window has just become the leader. */
  reset(): void {
    this.haveMl = false;
    this.moved = this.transfer = 0;
    this.rate.fill(0);
    this.prevImpact.fill(0);
    this.lastOnset.fill(-1);
  }

  /**
   * Advance by one frame. `now` is the audio clock; `dt` the wall time since the previous frame, s.
   * Allocates nothing unless a one-shot voice starts.
   */
  step(frame: SceneFrame | null, now: number, dt: number): void {
    this.heartbeat(now);
    this.clock += dt;
    const f = frame ?? STILL;
    if (f.liquid && f.liquid !== this.liquidId) {
      this.liquidId = f.liquid;
      this.tone = liquidTone(f.liquid);
      this.pour.tone(this.tone.pour, now);
    }
    const L = this.tone;
    const t0 = now + LOOKAHEAD;
    // seconds since continuous params last moved, or 0 when they wait for a later frame
    this.controlDt += dt;
    const cdt = this.controlDt >= CONTROL_DT ? this.controlDt : 0;
    if (cdt) this.controlDt = 0;
    const live = this.haveMl && dt > 0;
    const kRate = live ? 1 - Math.exp(-dt / 0.25) : 0;
    let src = -1, dst = -1, srcRate = 0, dstRate = 0;
    let gained = 0, lost = 0;

    for (let s = 0; s < SLOTS; s++) {
      const ml = f.ml[s] ?? 0;
      if (live) {
        const d = ml - this.prevMl[s]!;
        if (d > 0) gained += d; else lost -= d;
        this.rate[s] = this.rate[s]! + (d / dt - this.rate[s]!) * kRate;
      }
      this.prevMl[s] = ml;
      const r = this.rate[s]!;
      if (r < srcRate) { srcRate = r; src = s; }
      if (r > dstRate) { dstRate = r; dst = s; }

      const e = f.energy[s] ?? 0;
      const a = e > REST_ENERGY ? clamp((Math.sqrt(e) - SQRT_REST) / (SQRT_FULL - SQRT_REST), 0, 1) : 0;
      const fill = clamp(ml / FULL_ML, 0, 1);
      this.sloshSlot(s, a, fill, now, dt, cdt, t0, L);
      this.impacts(s, f.impact[s] ?? 0, fill, t0, L);
    }
    this.haveMl = true;

    // `flow` counts any change of volume, so rain landing, or a closing vessel's liquid turning to rain,
    // reads as flow too. Only the part where one vessel's loss is another's gain is a stream.
    if (live) {
      const k = 1 - Math.exp(-dt / 0.08);
      this.moved += ((gained + lost) / 2 / dt - this.moved) * k;
      this.transfer += (Math.min(gained, lost) / dt - this.transfer) * k;
    }
    const share = this.moved > 2 ? clamp(this.transfer / this.moved, 0, 1) : 1;
    this.pourStep(f.flow * share, src, srcRate, dst, dstRate, now, dt, cdt, t0, L);
    this.rainStep(f.rainMl, f.ml, dt, t0, L);
  }

  /** Keep the mix open while frames keep coming; it closes by itself ALIVE_HOLD s after the last one. */
  private heartbeat(now: number): void {
    const p = this.alive.gain;
    if (now >= this.aliveUntil) {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(1, now, 0.03);
    } else if (now + ALIVE_HOLD - this.aliveUntil < 0.05) {
      return;
    } else {
      p.cancelScheduledValues(now);
    }
    this.aliveUntil = now + ALIVE_HOLD;
    p.setTargetAtTime(0, this.aliveUntil, 0.06);
  }

  private sloshSlot(s: number, a: number, fill: number, now: number, dt: number, cdt: number, t0: number, L: LiquidTone): void {
    let vi = this.voiceOf[s]!;
    if (vi < 0 && cdt && a * fill > 0) vi = this.claimSlosh(s);
    if (vi < 0) return;
    if (cdt) this.slosh[vi]!.drive(a, fill, this.widthOf[s]!, L.slosh, this.clock, now, cdt);

    // a lively slosh carries the odd small bubble
    const rate = L.slosh.bubbles * Math.pow(a, 1.5) * fill;
    if (rate <= 0) return;
    let wait = this.bubbleWait[s]! - rate * dt;
    for (let n = 0; wait <= 0 && n < 4; n++) {
      this.drop(s, t0 + Math.random() * dt, 0.18 + 0.3 * Math.random() * a, 1, L);
      wait += expRand();
    }
    this.bubbleWait[s] = Math.max(wait, 0);
  }

  private claimSlosh(s: number): number {
    let vi = -1;
    if (this.slosh.length < MAX_SLOSH) {
      vi = this.slosh.length;
      this.slosh.push(new SloshVoice(this.ctx, this.pink, this.gurgle));
    } else {
      for (let i = 0; i < this.slosh.length; i++) {
        if (this.slosh[i]!.idle(this.clock)) { vi = i; break; }
      }
      if (vi < 0) return -1;
    }
    const v = this.slosh[vi]!;
    if (v.slot >= 0) this.voiceOf[v.slot] = -1;
    v.assign(s, this.strip(s), this.clock);
    this.voiceOf[s] = vi;
    return vi;
  }

  private impacts(s: number, imp: number, fill: number, t0: number, L: LiquidTone): void {
    const prev = this.prevImpact[s]!;
    this.prevImpact[s] = imp;
    const th = L.drop.threshold, hard = L.glass.threshold;
    if (imp < th || fill <= 0) return;
    const since = this.clock - this.lastOnset[s]!;
    const rising = prev < th || imp > prev * 1.6;
    if (rising && (this.lastOnset[s]! < 0 || since >= REFRACTORY)) {
      this.lastOnset[s] = this.clock;
      if (imp >= hard) {
        this.rang[s] = 1;
        this.glass(s, imp, fill, t0, L);
        // a hard slap throws a droplet or two that land a moment later
        const n = 1 + (Math.random() < 0.4 ? 1 : 0);
        for (let i = 0; i < n; i++) this.drop(s, t0 + 0.04 + Math.random() * 0.18, 0.35 + 0.3 * Math.random(), 1, L);
      } else {
        this.rang[s] = 0;
        const k = clamp(Math.log(imp / th) / Math.log(hard / th), 0, 1);
        this.drop(s, t0, (0.35 + 0.65 * k) * (0.75 + 0.25 * Math.random()), 1, L);
      }
    } else if (!this.rang[s] && imp >= hard && since < 0.05) {
      // the slap kept growing after its onset
      this.rang[s] = 1;
      this.glass(s, imp, fill, t0, L);
    }
  }

  private pourStep(flow: number, src: number, srcRate: number, dst: number, dstRate: number, now: number, dt: number, cdt: number, t0: number, L: LiquidTone): void {
    if (!this.pouring && flow > POUR_ON) this.pouring = true;
    else if (this.pouring && flow < POUR_OFF) this.pouring = false;
    const a = this.pouring ? clamp(Math.log(flow / POUR_OFF) / Math.log(POUR_FULL / POUR_OFF), 0, 1) : 0;
    if (cdt) {
      // pan to where the stream is: between the vessels losing and gaining liquid fastest
      if (src >= 0 && dst >= 0 && srcRate < -4 && dstRate > 4) {
        const ws = -srcRate, wd = dstRate;
        this.pour.pan((this.panOf[src]! * ws + this.panOf[dst]! * wd) / (ws + wd), now);
      }
      this.pour.drive(a, L.pour, now, cdt);
    }
    if (a <= 0 || dst < 0 || L.pour.bubbles <= 0) return;
    // bubbles where the stream lands
    let wait = this.pourWait - L.pour.bubbles * (0.3 + 0.7 * a) * dt;
    for (let n = 0; wait <= 0 && n < 4; n++) {
      this.drop(dst, t0 + Math.random() * dt, 0.25 + 0.35 * Math.random(), 1, L);
      wait += expRand();
    }
    this.pourWait = Math.max(wait, 0);
  }

  private rainStep(rainMl: number, ml: ArrayLike<number>, dt: number, t0: number, L: LiquidTone): void {
    if (rainMl <= RAIN_MIN) { this.rainWait = 0.3 * expRand(); return; }
    const rate = Math.min(RAIN_MAX, rainMl * RAIN_PER_ML);
    let wait = this.rainWait - rate * dt;
    for (let n = 0; wait <= 0 && n < 6; n++) {
      const s = this.rainSlot(ml);
      // a drip into an empty vessel is a dry tick on the glass, not a bubble
      const wet = clamp((ml[s] ?? 0) / 20, 0, 1);
      this.drop(s, t0 + Math.random() * dt, 0.3 + 0.45 * Math.random(), wet, L);
      wait += expRand();
    }
    this.rainWait = Math.max(wait, 0);
  }

  /** A vessel for a raindrop, chosen in proportion to width. */
  private rainSlot(ml: ArrayLike<number>): number {
    let total = 0;
    for (let s = 0; s < SLOTS; s++) if (this.seen[s] === this.stamp) total += this.widthOf[s]!;
    if (total <= 0) {
      let best = 0;
      for (let s = 1; s < SLOTS; s++) if ((ml[s] ?? 0) > (ml[best] ?? 0)) best = s;
      return best;
    }
    let pick = Math.random() * total;
    let last = 0;
    for (let s = 0; s < SLOTS; s++) {
      if (this.seen[s] !== this.stamp) continue;
      last = s;
      pick -= this.widthOf[s]!;
      if (pick <= 0) return s;
    }
    return last;
  }

  // ---------------------------------------------------------------- one-shot voices

  /** `level` 0 to 1; `wet` 0 for a drop landing on dry glass, 1 for one landing in liquid. */
  private drop(s: number, t: number, level: number, wet: number, L: LiquidTone): void {
    if (this.activeDrops >= MAX_DROPS) return;
    const D = L.drop;
    const size = Math.random();
    const f0 = 1600 * Math.pow(500 / 1600, size) * D.pitch * (0.94 + 0.12 * Math.random());
    const rise = 1.5 + Math.random();
    const sweep = 0.04 + 0.05 * Math.random();
    const decay = (0.06 + 0.08 * size) * D.decay;
    const click = this.clicks[(Math.random() * this.clicks.length) | 0]!;
    const g = DROP_GAIN * level;
    this.activeDrops++;
    this.plinks++;
    playDrop(this.ctx, this.strip(s), t, f0, rise, sweep, decay, g * D.level * wet, click, g * D.click * (1 + 2 * (1 - wet)), this.dropEnded);
  }

  private readonly dropEnded = (): void => { this.activeDrops--; };

  private glass(s: number, imp: number, fill: number, t: number, L: LiquidTone): void {
    if (this.activeGlass >= MAX_GLASS) return;
    const G = L.glass;
    const k = clamp(Math.log(imp / G.threshold) / Math.log(SLAP_MAX / G.threshold), 0, 1);
    // a narrow vessel rings higher: 2.2 kHz at 250 px wide down to 900 Hz at 1600 px
    const w = this.widthOf[s]!;
    const base = 2200 * Math.pow(900 / 2200, clamp(Math.log(w / 250) / Math.log(1600 / 250), 0, 1));
    // liquid against the glass damps it
    const decay = G.decay * (1 - 0.25 * fill);
    const level = GLASS_GAIN * G.level * (0.3 + 0.7 * k);
    const click = this.clicks[this.clicks.length - 1 - ((Math.random() * 2) | 0)]!;
    this.activeGlass++;
    this.slaps++;
    const tilt = 0.5 + 0.45 * G.bright * (0.6 + 0.4 * k);
    playGlass(this.ctx, this.strip(s), t, base, tilt, decay, level, G.partials, click, level * 0.6, this.glassEnded);
  }

  private readonly glassEnded = (): void => { this.activeGlass--; };
}
