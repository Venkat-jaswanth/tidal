// One Engine per window. Every window renders its own vessel; the window holding leadership also
// simulates the whole world and sends each other window the part of the field under it.

import { loadWorld, saveWorld } from './net/persist';
import { decodeSnapshot, encodeSnapshot } from './net/snapshot';
import { Transport, type CropHeader, type FrameMeta, type Snapshot } from './net/transport';
import { WATER_LOOK, type LiquidLook, type Theme } from './render/theme';
import { WaterRenderer, columnHeight, type Column, type QuietZone, type ViewState } from './render/water';
import { CropPacker, warmCropPipeline, type Crop } from './sim/crop';
import type { Vessel } from './sim/domain';
import { MpmSim, WATER, fillBlock, warmSimPipelines, type Liquid } from './sim/mpm';
import { Leadership } from './world/leader';
import { Calibrator, Registry, claimSlot, clock, type VesselInfo } from './world/registry';

export const CELL_PX = 6;
// 480 substeps a second: 8 per frame at 60 Hz. Fewer is stable too (tested down to 360) but the
// liquid then compresses visibly more under its own weight.
export const SUBSTEP_HZ = 480;
export const PARTICLES = 100_000;
export const WORLD_ML = 1000;
const LOW_PARTICLES = 50_000;
export const PX2_PER_ML = 220;
const GRID_W = 1024;
const GRID_H = 512;
const OUTSET = 1;            // cells the simulated vessel extends past the viewport, so liquid meets the glass
// The liquid is weakly compressible and part of it sits in the hidden margin behind the glass.
// Scaling the rest density makes a resting body show the volume it is labelled with.
export const REST_DENSITY_SCALE = 0.93;
const SNAPSHOT_MS = 100;
const PERSIST_MS = 2000;
// Measured on the real solver: resting energy is about 3e-5, and a hard slosh slaps the glass at about 1.4e-3 raw.
const ENERGY_FLOOR = 6e-5;
const REST_ENERGY = 3e-4;
const IMPULSE_SECONDS = 0.06;
const IMPACT_GAIN = 4;
const STALL_MS = 700;         // a visible follower takes over after this long without a frame from the leader
const SNAPSHOT_BROADCAST_MS = 500;

export interface LiquidDef {
  id: string;
  physics: Liquid;
  look: LiquidLook;
}

export const LIQUID_WATER: LiquidDef = { id: 'water', physics: WATER, look: WATER_LOOK };

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** The window whose viewport this engine draws (differs from the script's window for picture-in-picture). */
  view: Window;
  kind: VesselInfo['kind'];
  theme: Theme;
  liquids: Record<string, LiquidDef>;
  particles?: number;
}

export interface EngineStats {
  leader: boolean;
  frame: number;
  fps: number;
  /** Longest gap between two presented frames in the last second, ms. */
  worstFrameMs: number;
  simGpuMs: number | null;
  /** GPU time of this window's render pass, ms. */
  renderGpuMs: number | null;
  renderCpuMs: number;
  /** Particles that went non-finite since this window started leading. Should stay 0. */
  blowUps: number;
  /** Quality tier in use, 0 (everything) to 5. */
  tier: number;
  substeps: number;
  particles: number;
}

export type Command =
  | { type: 'cmd'; cmd: 'liquid'; value: string }
  | { type: 'cmd'; cmd: 'impulse'; x: number; y: number }
  | { type: 'cmd'; cmd: 'gravity'; x: number; y: number }
  | { type: 'cmd'; cmd: 'calm'; value: boolean }
  | { type: 'cmd'; cmd: 'thin' };

interface Tracked { x: number; y: number }

/** One vessel drawn by this window. */
interface View {
  info: VesselInfo;
  win: Window;
  canvas: HTMLCanvasElement;
  ctx: GPUCanvasContext;
  renderer: WaterRenderer;
  cal: Calibrator;
  fieldTex: GPUTexture | null;
  fieldView: GPUTextureView | null;
  fieldHead: CropHeader | null;
  /** The last two crops received, for blending when this window draws faster than the leader simulates. */
  prev: { head: CropHeader; data: Uint8Array } | null;
  curr: { head: CropHeader; data: Uint8Array; at: number } | null;
  /** Smoothed time between crops, ms. */
  cropInterval: number;
  blend: Uint8Array | null;
  /** Header of whatever is on the GPU now (a crop or a blend towards it). */
  fieldHeadShown: CropHeader | null;
  ml: number;
  /** performance.now() of the last draw. */
  lastDraw: number;
}

/** Handle to a second vessel this window draws (its picture-in-picture tank). */
export interface ExtraView {
  readonly info: VesselInfo;
  readonly ml: number;
  remove(): void;
}

export class Engine {
  readonly registry: Registry;
  readonly leadership = new Leadership();
  readonly transport: Transport;
  readonly calibrator: Calibrator;
  theme: Theme;
  liquid: LiquidDef;
  /** This vessel's volume, millilitres. */
  ml = 0;
  meta: FrameMeta | null = null;
  stats: EngineStats = { leader: false, frame: 0, fps: 0, worstFrameMs: 0, simGpuMs: null, renderGpuMs: null, renderCpuMs: 0, blowUps: 0, tier: 0, substeps: 0, particles: 0 };
  /** Called after every presented frame. */
  readonly frameListeners = new Set<(e: Engine) => void>();
  /** Called on the leader when a vessel disappears while holding liquid. */
  onVesselClosed: ((slot: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly view: Window;
  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private main!: View;
  private readonly extraViews = new Set<View>();
  private readonly liquids: Record<string, LiquidDef>;
  private readonly particleCount: number;

  // leader state
  private sim: MpmSim | null = null;
  private packer: CropPacker | null = null;
  private readonly crops = new Map<string, Crop>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly readPool = new Map<number, GPUBuffer[]>();
  private originX = 0;
  private originY = 0;
  private worldTime = 0;
  private frameNo = 0;
  private lastSnapshot = 0;
  private lastSnapshotBroadcast = 0;
  private snapshotBusy = false;
  private gravity: [number, number] = [0, 1];
  private impulse: [number, number, number] = [0, 0, 0]; // x, y, seconds left
  private calm = false;
  private knownSlots = new Set<number>();
  private lastMl: number[] | null = null;
  private lastMlFrame = -1;
  private flow = 0;
  private simLiquid = '';
  private lastBlowFrame = -1;
  private wantThin = false;
  private lastLadder = 0;
  private frameMs = 16.7;

  private lastFrame = 0;
  private frameTimes: number[] = [];
  private running = false;
  private lastPrune = 0;
  private lastMetaAt = 0;
  private persisted: Snapshot | null = null;
  private lastPersist = 0;
  /** True when this world was poured back in from the previous visit. */
  restored = false;
  /** Test hook: a stalled leader keeps its lock but stops simulating. */
  stalled = false;
  private stallJitter = Math.random() * 400;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.view = opts.view;
    this.theme = opts.theme;
    this.liquids = opts.liquids;
    this.liquid = opts.liquids.water ?? LIQUID_WATER;
    this.particleCount = opts.particles ?? PARTICLES;
    this.calibrator = new Calibrator(opts.view);
    const id = crypto.randomUUID();
    const r = this.calibrator.rect();
    this.registry = new Registry({
      id, slot: -1, x: r.x, y: r.y, w: r.w, h: r.h, dpr: opts.view.devicePixelRatio,
      visible: document.visibilityState === 'visible', focused: document.hasFocus(),
      kind: opts.kind, active: true, group: '', t: clock(),
    });
    this.transport = new Transport(id, () => this.registry.self.slot);
    this.transport.onMeta = (m) => {
      if (this.leadership.isLeader && m.leader !== id) return;
      this.meta = m;
      this.lastMetaAt = performance.now();
      const next = this.liquids[m.liquid];
      if (next && next.id !== this.liquid.id) this.liquid = next;
    };
    this.registry.channel.addEventListener('message', (e: MessageEvent<Command | { type: string }>) => {
      if (e.data.type === 'cmd') this.handle(e.data as Command);
    });
  }

  get id(): string { return this.registry.self.id; }
  get slot(): number { return this.registry.self.slot; }
  get isLeader(): boolean { return this.leadership.isLeader; }

  /**
   * Rectangles (CSS px in the vessel's viewport) where text sits. The paper's ruling fades out
   * softly behind them, so a grid line never strikes through a label. At most four per vessel.
   */
  setQuietZones(zones: readonly QuietZone[], slot = this.registry.self.slot): void {
    this.quietZones.set(slot, zones.slice(0, 4));
  }
  private readonly quietZones = new Map<number, QuietZone[]>();

  /** How the current liquid compresses under its own weight: see `columnHeight`. */
  get column(): Column {
    const ph = this.liquid.physics;
    const g = Math.hypot(ph.gravityX, ph.gravityY) / (CELL_PX * SUBSTEP_HZ * SUBSTEP_HZ); // cells per substep²
    return { a: (g * ph.eosPower) / ph.soundSpeed2 / CELL_PX, gamma: ph.eosPower };
  }

  /** Height in px at which a resting column of `ml` stands in a vessel `width` px wide. */
  heightOfMl(ml: number, width: number): number {
    return columnHeight((ml * PX2_PER_ML) / width, this.column);
  }

  /**
   * Quality ladder (spec §6.9), applied in order when a window cannot keep its frame rate:
   * 1 fewer particles, 2 lower render resolution, 3 cheaper refraction, 4 no caustics, 5 no foam.
   */
  tier = 0;
  /** True when the tier was set by hand (`?tier=`), which stops the automatic ladder. */
  tierForced = false;
  get isCalm(): boolean { return this.calm; }

  /** Set the quality tier. Rung 1 is a property of the world, so it is passed to the leader. */
  setTier(tier: number, forced = false): void {
    this.tier = Math.max(0, Math.min(5, Math.round(tier)));
    this.tierForced = this.tierForced || forced;
    this.stats.tier = this.tier;
    if (this.tier >= 1) this.command({ type: 'cmd', cmd: 'thin' });
  }

  /** Step down a rung when the frame rate stays low. Called once a second with the last second's rate. */
  private ladder(fps: number): void {
    if (this.tierForced || this.tier >= 5 || document.visibilityState !== 'visible') return;
    // six slow seconds in a row, so a stall from a resize or a screenshot does not cost quality
    this.slowSeconds = fps > 1 && fps < 45 ? this.slowSeconds + 1 : 0;
    if (this.slowSeconds >= 6) { this.slowSeconds = 0; this.setTier(this.tier + 1); }
  }
  private slowSeconds = 0;

  /** Halve the particle count (rung 1). Each remaining particle stands for twice the liquid. */
  private thin(): void {
    const sim = this.sim;
    if (!sim || this.thinned || sim.particleCount <= LOW_PARTICLES) return;
    this.thinned = true;
    void sim.readParticles().then((bytes) => {
      if (this.sim !== sim) return;
      const keep = Math.max(1, Math.round(sim.particleCount / LOW_PARTICLES));
      const count = Math.floor(sim.particleCount / keep);
      const out = new Uint8Array(count * 64);
      const src = new Uint8Array(bytes);
      for (let i = 0; i < count; i++) out.set(src.subarray(i * keep * 64, i * keep * 64 + 64), i * 64);
      // each survivor now stands for more liquid: scale the rest density and the density every
      // particle remembers by the same factor, so the pressure does not jump
      const scale = count / sim.particleCount;
      const f = new Float32Array(out.buffer);
      for (let i = 0; i < count; i++) f[i * 16 + 13] = f[i * 16 + 13]! * scale;
      sim.setParticles(out.buffer, count, sim.restDensity * scale);
    });
  }
  private thinned = false;

  /** Take this window's vessel out of the world, or put it back. Its liquid rains into the others. */
  setActive(active: boolean): void {
    if (this.registry.self.active === active) return;
    this.registry.self.active = active;
    this.registry.announce(true);
  }
  /** Millilitres this vessel would hold if filled to the top. */
  get capacityMl(): number { return (this.registry.self.w * this.registry.self.h) / PX2_PER_ML; }

  /** Set up the GPU, join the world and start drawing. Returns false when WebGPU is unavailable. */
  async start(): Promise<boolean> {
    if (!('gpu' in navigator)) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    this.device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) return false;
    ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.main = {
      info: this.registry.self, win: this.view, canvas: this.canvas, ctx,
      renderer: new WaterRenderer(this.device, this.format), cal: this.calibrator,
      fieldTex: null, fieldView: null, fieldHead: null, prev: null, curr: null, cropInterval: 0, blend: null, fieldHeadShown: null, ml: 0, lastDraw: 0,
    };

    const claim = await claimSlot();
    this.registry.self.slot = claim.slot;
    this.registry.self.group = this.transport.group;
    this.registry.announce(true);

    this.persisted = await loadWorld();
    this.leadership.onGain = () => this.becomeLeader();
    this.leadership.onLose = () => this.stopLeading();
    if (this.leadership.isLeader) this.becomeLeader();
    // compile everything a leader needs in the background, so a later promotion does not hitch
    setTimeout(() => { void warmSimPipelines(this.device).catch(() => {}); void warmCropPipeline(this.device).catch(() => {}); }, 300);

    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      this.view.requestAnimationFrame(loop);
    };
    this.view.requestAnimationFrame(loop);
    return true;
  }

  stop(): void {
    this.running = false;
    this.leadership.resign();
    this.registry.leave();
  }

  /** Ask the leader (possibly this window) to change something about the world. */
  command(c: Command): void {
    this.registry.channel.postMessage(c);
    this.handle(c);
  }

  private handle(c: Command): void {
    if (c.cmd === 'liquid') {
      const next = this.liquids[c.value];
      if (next) this.liquid = next;
    } else if (c.cmd === 'impulse') {
      this.impulse = [c.x, c.y, IMPULSE_SECONDS];
    } else if (c.cmd === 'gravity') {
      this.gravity = [c.x, c.y];
    } else if (c.cmd === 'calm') {
      this.calm = c.value;
    } else if (c.cmd === 'thin') {
      this.wantThin = true;
    }
  }

  // ---------------------------------------------------------------- leading

  private becomeLeader(): void {
    if (!this.device || this.sim) return;
    const sim = new MpmSim(this.device, { gridW: GRID_W, gridH: GRID_H, maxParticles: Math.max(this.particleCount, 200_000), cellPx: CELL_PX, substepHz: SUBSTEP_HZ });
    this.sim = sim;
    this.packer = new CropPacker(this.device, sim);
    this.tracked.clear();
    this.knownSlots = new Set(this.registry.all().map((v) => v.slot));

    const snap = this.transport.latestSnapshot();
    if (snap && snap.count > 0) {
      this.originX = snap.originX; this.originY = snap.originY;
      this.worldTime = 0;
      sim.setParticles(decodeSnapshot(snap.data, snap.count, 0, snap.restDensity), snap.count, snap.restDensity);
      const liquid = this.liquids[snap.liquid];
      if (liquid) this.liquid = liquid;
      this.frameNo = snap.frame;
    } else {
      // a new world: centre the grid on this window
      const s = this.registry.self;
      this.originX = Math.round((s.x + s.w / 2 - (GRID_W * CELL_PX) / 2) / CELL_PX) * CELL_PX;
      this.originY = Math.round((s.y + s.h / 2 - (GRID_H * CELL_PX) / 2) / CELL_PX) * CELL_PX;
      this.worldTime = 0;
    }
    const saved = this.persisted;
    if (snap && snap.count > 0) {
      // already restored above
    } else if (saved && this.registry.peers.size === 0) {
      // the liquid saved on the last visit pours back in from the top of this vessel
      const s = this.registry.self;
      const r = this.cellRect(s);
      const bytes = decodeSnapshot(saved.data, saved.count, 0, saved.restDensity);
      const f = new Float32Array(bytes);
      const u = new Uint32Array(bytes);
      for (let i = 0; i < saved.count; i++) {
        const o = i * 16;
        f[o] = r.x0 + 7 + Math.random() * (r.x1 - r.x0 - 14);
        f[o + 1] = r.y0 + 1.6 + Math.random() * 2;
        f[o + 2] = 0; f[o + 3] = 0.3;
        f[o + 11] = 0.05 + Math.random() * 1.6;
        u[o + 12] = s.slot;
      }
      sim.setParticles(bytes, saved.count, saved.restDensity);
      const liquid = this.liquids[saved.liquid];
      if (liquid) this.liquid = liquid;
      this.restored = true;
    } else {
      const s = this.registry.self;
      const n = this.particleCount;
      const rho0 = (REST_DENSITY_SCALE * n * CELL_PX * CELL_PX) / (WORLD_ML * PX2_PER_ML);
      const block = fillBlock(n, rho0, this.cellRect(s), [0, 0, 0], s.slot);
      // A new world pours in from the top of the first vessel, and the readout counts up with it.
      // With reduced motion it is simply there.
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const r = this.cellRect(s);
        const f = new Float32Array(block);
        for (let i = 0; i < n; i++) {
          const o = i * 16;
          f[o] = r.x0 + 7 + Math.random() * (r.x1 - r.x0 - 14);
          f[o + 1] = r.y0 + 1.6 + Math.random() * 2;
          f[o + 2] = 0; f[o + 3] = 0.3;
          f[o + 11] = 0.05 + Math.random() * 1.5;
        }
      }
      sim.setParticles(block, n, rho0);
    }
    this.stats.leader = true;
  }

  private stopLeading(): void {
    this.stats.leader = false;
    const sim = this.sim;
    this.sim = null;
    this.packer = null;
    for (const c of this.crops.values()) { c.texture.destroy(); c.uniform.destroy(); }
    this.crops.clear();
    // let in-flight readbacks finish before the buffers go
    if (sim) setTimeout(() => sim.destroy(), 500);
  }

  private cellRect(v: { x: number; y: number; w: number; h: number }): { x0: number; y0: number; x1: number; y1: number } {
    return {
      x0: (v.x - this.originX) / CELL_PX - OUTSET, y0: (v.y - this.originY) / CELL_PX - OUTSET,
      x1: (v.x + v.w - this.originX) / CELL_PX + OUTSET, y1: (v.y + v.h - this.originY) / CELL_PX + OUTSET,
    };
  }

  private simulate(dt: number, encoder: GPUCommandEncoder): void {
    const sim = this.sim!;
    const packer = this.packer!;
    const all = this.registry.all().filter((v) => {
      const r = this.cellRect(v);
      return r.x0 > 4 && r.y0 > 4 && r.x1 < GRID_W - 4 && r.y1 < GRID_H - 4 && v.w > 40 && v.h > 40;
    });
    if (all.length === 0) return;

    // a vessel that vanished since last frame turns its liquid into rain
    const slots = new Set(all.map((v) => v.slot));
    let closed = false;
    let closedY = -Infinity;
    for (const s of this.knownSlots) {
      if (!slots.has(s)) { closed = true; this.onVesselClosed?.(s); }
    }
    for (const [id, t] of this.tracked) {
      if (!all.some((v) => v.id === id)) { closedY = Math.max(closedY, t.y); this.tracked.delete(id); }
    }
    this.knownSlots = slots;

    const vessels: Vessel[] = all.map((v) => {
      const prev = this.tracked.get(v.id);
      const r = this.cellRect(v);
      this.tracked.set(v.id, { x: v.x, y: v.y });
      // rain prefers vessels below the one that closed
      const below = closed && v.y > closedY - 1 ? 1 : 0.2;
      return {
        index: v.slot, ...r,
        dx: prev ? (v.x - prev.x) / CELL_PX : 0, dy: prev ? (v.y - prev.y) / CELL_PX : 0,
        rainWeight: v.w * (closed ? below : 1),
      };
    });

    const physics = { ...this.liquid.physics };
    const g = Math.hypot(physics.gravityX, physics.gravityY);
    physics.gravityX = this.gravity[0] * g; physics.gravityY = this.gravity[1] * g;
    if (this.impulse[2] > 0) {
      // a push lasts a fixed time, not a number of frames, so it is the same at any frame rate
      const share = Math.min(1, this.impulse[2] / Math.max(dt, 1e-3));
      physics.gravityX += this.impulse[0] * g * 1.1 * share; physics.gravityY += this.impulse[1] * g * 1.1 * share;
      this.impulse[2] -= dt;
    }
    if (this.calm) physics.damping = Math.min(physics.damping, 0.9982);
    // once the liquid has all but stopped, damp what is left so the surface comes to a true rest
    const stats = sim.stats;
    if (stats) {
      let moving = 0;
      for (const e of stats.energy) moving += e;
      if (moving < REST_ENERGY) physics.damping = Math.min(physics.damping, 0.996);
    }
    sim.liquid = physics;
    sim.dye = this.liquid.id === 'ink';
    if (sim.dye && this.simLiquid !== 'ink') sim.recolor();
    this.simLiquid = this.liquid.id;

    if (this.wantThin) this.thin();
    const nSub = sim.substepsFor(dt);
    this.worldTime += nSub / SUBSTEP_HZ;
    sim.step(vessels, nSub, this.worldTime, closed);
    this.frameNo++;

    // crops for every vessel; this window's own is drawn straight from the texture
    const list: Crop[] = [];
    for (const v of all) {
      const r = this.cellRect(v);
      const crop = packer.fit(this.crops.get(v.id) ?? null, r.x0, r.y0, r.x1, r.y1);
      this.crops.set(v.id, crop);
      list.push(crop);
    }
    for (const [id, c] of this.crops) {
      if (!all.some((v) => v.id === id)) { c.texture.destroy(); c.uniform.destroy(); this.crops.delete(id); }
    }
    packer.pack(encoder, list, this.gravity[0], this.gravity[1], this.liquid.id === 'ink');

    const pending: { v: VesselInfo; crop: Crop; buf: GPUBuffer; bytesPerRow: number; head: CropHeader }[] = [];
    for (const v of all) {
      if (v.id === this.id || this.registry.proxies.has(v.id)) continue;
      const crop = this.crops.get(v.id)!;
      const bytesPerRow = Math.ceil((crop.width * 8) / 256) * 256;
      const size = bytesPerRow * crop.height;
      const pool = this.readPool.get(size) ?? [];
      this.readPool.set(size, pool);
      const buf = pool.pop() ?? this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      encoder.copyTextureToBuffer({ texture: crop.texture }, { buffer: buf, bytesPerRow }, [crop.width, crop.height]);
      pending.push({ v, crop, buf, bytesPerRow, head: { frame: this.frameNo, cellX: crop.cellX, cellY: crop.cellY, width: crop.width, height: crop.height, rectX: v.x, rectY: v.y } });
    }
    this.afterSubmit = () => {
      for (const p of pending) {
        void p.buf.mapAsync(GPUMapMode.READ).then(() => {
          const src = new Uint8Array(p.buf.getMappedRange());
          const rowBytes = p.head.width * 8;
          const tight = new Uint8Array(rowBytes * p.head.height);
          for (let y = 0; y < p.head.height; y++) tight.set(src.subarray(y * p.bytesPerRow, y * p.bytesPerRow + rowBytes), y * rowBytes);
          p.buf.unmap();
          this.readPool.get(p.buf.size)?.push(p.buf);
          this.transport.sendCrop(p.v.id, p.v.slot, p.v.group, p.head, tight);
        });
      }
    };

    // world meta, from the stats that came back from an earlier frame
    const st = sim.stats;
    const ml = new Array<number>(16).fill(0);
    const energy = new Array<number>(16).fill(0);
    const impact = new Array<number>(16).fill(0);
    let rainMl = 0;
    if (st) {
      // millilitres per counted particle, from the count itself: the vessels and the rain always add up to the world
      let counted = st.rain;
      for (const c of st.counts) counted += c;
      const k = WORLD_ML / Math.max(1, counted);
      for (let i = 0; i < 16; i++) {
        ml[i] = (st.counts[i] ?? 0) * k;
        // resting liquid still jitters a little: remove that floor so rest reads as exactly 0
        energy[i] = Math.max(0, (st.energy[i] ?? 0) - ENERGY_FLOOR);
        impact[i] = (st.impact[i] ?? 0) * IMPACT_GAIN;
      }
      rainMl = st.rain * k;
      // liquid changing vessels: half the summed change, as a smoothed rate
      if (this.lastMl && st.frame !== this.lastMlFrame) {
        let moved = 0;
        for (let i = 0; i < 16; i++) moved += Math.abs(ml[i]! - this.lastMl[i]!);
        this.flow += (moved / 2 / Math.max(dt, 1e-3) - this.flow) * 0.25;
      }
      this.lastMl = ml; this.lastMlFrame = st.frame;
      this.stats.simGpuMs = st.gpuMs;
      if (st.frame !== this.lastBlowFrame) { this.stats.blowUps += st.blowUps; this.lastBlowFrame = st.frame; }
      this.stats.substeps = st.substeps;
    }
    this.stats.particles = sim.particleCount;
    // nothing is published until the first counts are back, so no window ever shows a false 0 mL
    if (st) this.transport.sendMeta({
      type: 'meta', leader: this.id, frame: this.frameNo, t: clock(),
      originX: this.originX, originY: this.originY, cellPx: CELL_PX, liquid: this.liquid.id,
      gravityX: this.gravity[0], gravityY: this.gravity[1],
      ml, rainMl, energy, impact, flow: this.flow,
    });
    if (st) this.meta = this.transport.meta;

    // snapshots keep every window ready to take over
    const now = performance.now();
    if (!this.snapshotBusy && now - this.lastSnapshot > SNAPSHOT_MS) {
      this.lastSnapshot = now;
      this.snapshotBusy = true;
      const head = {
        frame: this.frameNo, t: clock(), count: sim.particleCount, originX: this.originX, originY: this.originY,
        gridW: GRID_W, gridH: GRID_H, restDensity: sim.restDensity, liquid: this.liquid.id,
      };
      const time = this.worldTime;
      const broadcast = now - this.lastSnapshotBroadcast > SNAPSHOT_BROADCAST_MS;
      if (broadcast) this.lastSnapshotBroadcast = now;
      void sim.readParticles().then((bytes) => {
        const data = encodeSnapshot(bytes, head.count, time);
        this.transport.sendSnapshot(head, data, broadcast);
        if (now - this.lastPersist > PERSIST_MS) { this.lastPersist = now; void saveWorld({ ...head, data }); }
      }).finally(() => { this.snapshotBusy = false; });
    }
  }

  private afterSubmit: (() => void) | null = null;

  // ---------------------------------------------------------------- every window

  /**
   * Adds a second vessel drawn by this window: its picture-in-picture tank. This window speaks for
   * it in the registry and draws it with its own GPU device. Returns null when no slot is free.
   */
  async addView(win: Window, canvas: HTMLCanvasElement, kind: VesselInfo['kind']): Promise<ExtraView | null> {
    const claim = await claimSlot();
    if (claim.slot < 0) return null;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) { claim.release(); return null; }
    ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    const cal = new Calibrator(win);
    const r = cal.rect();
    const info: VesselInfo = {
      id: crypto.randomUUID(), slot: claim.slot, x: r.x, y: r.y, w: r.w, h: r.h, dpr: win.devicePixelRatio,
      visible: true, focused: false, kind, active: true, group: this.transport.group, t: clock(),
    };
    const view: View = { info, win, canvas, ctx, renderer: new WaterRenderer(this.device, this.format), cal, fieldTex: null, fieldView: null, fieldHead: null, prev: null, curr: null, cropInterval: 0, blend: null, fieldHeadShown: null, ml: 0, lastDraw: 0 };
    this.registry.proxies.set(info.id, info);
    this.transport.listenFor(info.id, info.slot);
    this.extraViews.add(view);
    this.registry.announce(true);
    let alive = true;
    const loop = () => {
      if (!alive) return;
      if (performance.now() - view.lastDraw > 6) this.drawExtra(view, performance.now());
      win.requestAnimationFrame(loop);
    };
    win.requestAnimationFrame(loop);
    return {
      info,
      get ml() { return view.ml; },
      remove: () => {
        if (!alive) return;
        alive = false;
        this.extraViews.delete(view);
        this.registry.removeProxy(info.id);
        this.transport.stopListening(info.id);
        view.fieldTex?.destroy();
        claim.release();
      },
    };
  }

  /** Keeps a view's registry entry in step with where its window really is. */
  private track(view: View): void {
    const r = view.cal.rect();
    const i = view.info;
    // the first reads of a new picture-in-picture window can be zeros
    if (r.w < 8 || r.h < 8) return;
    i.x = r.x; i.y = r.y; i.w = r.w; i.h = r.h;
    i.dpr = view.win.devicePixelRatio || 1;
    i.group = this.transport.group;
  }

  private empty: GPUTextureView | null = null;
  /** A field with no liquid in it. */
  private emptyField(): GPUTextureView {
    this.empty ??= this.device.createTexture({ size: [2, 2], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }).createView();
    return this.empty;
  }

  private sizeCanvas(view: View): { w: number; h: number; dpr: number } {
    // rung 2 of the quality ladder: draw at one device pixel per CSS pixel
    const dpr = this.tier >= 2 ? 1 : view.win.devicePixelRatio || 1;
    const w = view.win.innerWidth, h = view.win.innerHeight;
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (view.canvas.width !== pw || view.canvas.height !== ph) { view.canvas.width = pw; view.canvas.height = ph; }
    return { w, h, dpr };
  }

  /** Draws one vessel from the leader's crop for it: straight from the texture when this window leads, otherwise from what was sent. */
  private drawView(view: View, encoder: GPUCommandEncoder, now: number): void {
    const info = view.info;
    const { w, h, dpr } = this.sizeCanvas(view);
    let field: GPUTextureView | null = null;
    let cropX = 0, cropY = 0;
    const crop = this.sim && !this.stalled ? this.crops.get(info.id) : undefined;
    if (crop) {
      field = crop.view;
      cropX = this.originX + crop.cellX * CELL_PX;
      cropY = this.originY + crop.cellY * CELL_PX;
    } else if (!this.sim || this.stalled) {
      const got = this.transport.takeCrop(info.slot);
      const t = performance.now();
      if (got) {
        if (view.curr) {
          const gap = t - view.curr.at;
          view.cropInterval = view.cropInterval ? view.cropInterval + (gap - view.cropInterval) * 0.2 : gap;
        }
        view.prev = view.curr;
        view.curr = { ...got, at: t };
      }
      this.present(view, t, got !== null);
      const m = this.meta;
      const shown = view.fieldHeadShown;
      if (view.fieldView && shown && m) {
        field = view.fieldView;
        // anchor the crop to the vessel as it was simulated, so walls and liquid never separate
        cropX = m.originX + shown.cellX * CELL_PX - shown.rectX + info.x;
        cropY = m.originY + shown.cellY * CELL_PX - shown.rectY + info.y;
      }
    }
    const m = this.meta;
    if (m) view.ml = info.active ? (m.ml[info.slot] ?? 0) : 0;
    if (!info.active || !field) { field = this.emptyField(); cropX = info.x; cropY = info.y; }
    if (w < 2 || h < 2) return;
    const state: ViewState = {
      originX: info.x, originY: info.y, width: w, height: h, dpr, time: now / 1000,
      cropX, cropY, cellPx: CELL_PX, px2PerMl: PX2_PER_ML,
      gravityX: m?.gravityX ?? 0, gravityY: m?.gravityY ?? 1, tier: this.tier, column: this.column, quiet: this.quietZones.get(info.slot) ?? [],
    };
    const look = this.liquid.id === 'water' ? { ...this.liquid.look, ...this.theme.liquid } : this.liquid.look;
    view.renderer.draw(encoder, view.ctx.getCurrentTexture().createView(), field, state, this.theme, look);
  }

  private drawExtra(view: View, now: number): void {
    view.lastDraw = performance.now();
    this.track(view);
    const encoder = this.device.createCommandEncoder();
    this.drawView(view, encoder, now);
    this.device.queue.submit([encoder.finish()]);
  }

  private frame(now: number): void {
    const dt = this.lastFrame ? Math.min(0.034, (now - this.lastFrame) / 1000) : 1 / 60;
    if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); this.frameMs += (Math.min(50, now - this.lastFrame) - this.frameMs) * 0.1; }
    this.lastFrame = now;
    const cpu0 = performance.now();

    const self = this.registry.self;
    this.track(this.main);
    self.visible = document.visibilityState === 'visible';
    self.focused = document.hasFocus();
    for (const v of this.extraViews) {
      this.track(v);
      // a picture-in-picture window's own frames can slow or stop; draw it from this loop too,
      // whichever fires first
      if (performance.now() - v.lastDraw > 6) this.drawExtra(v, now);
    }
    this.registry.announce();
    if (now - this.lastPrune > 400) { this.lastPrune = now; void this.registry.prune(); }

    const encoder = this.device.createCommandEncoder();
    if (this.sim && !this.stalled) {
      this.simulate(dt, encoder);
    } else {
      // Watchdog: if the leader has gone quiet while this window is visible, take over.
      if (!this.lastMetaAt) this.lastMetaAt = now;
      if (self.visible && now - this.lastMetaAt > STALL_MS + this.stallJitter) {
        this.lastMetaAt = now;
        this.stallJitter = Math.random() * 400;
        this.leadership.steal();
      }
    }
    this.drawView(this.main, encoder, now);
    this.ml = this.main.ml;
    this.device.queue.submit([encoder.finish()]);
    this.afterSubmit?.();
    this.afterSubmit = null;

    this.stats.renderCpuMs = performance.now() - cpu0;
    this.stats.frame = this.frameNo || (this.meta?.frame ?? 0);
    if (this.frameTimes.length >= 60) {
      const sum = this.frameTimes.reduce((a, b) => a + b, 0);
      this.stats.fps = (1000 * this.frameTimes.length) / sum;
      this.stats.worstFrameMs = Math.max(...this.frameTimes);
      this.frameTimes = [];
    }
    this.stats.renderGpuMs = this.main.renderer.gpuMs;
    if (now - this.lastLadder > 1000) { this.lastLadder = now; this.ladder(this.stats.fps); }
    for (const fn of this.frameListeners) fn(this);
  }

  /**
   * Puts the right field on the GPU for a follower. Normally that is the newest crop. When this
   * window draws clearly faster than the leader simulates (a 120 Hz window following a 60 Hz
   * leader), it blends from the previous crop to the newest by the leader's frame spacing, so the
   * liquid moves on every frame instead of every other one.
   */
  private present(view: View, now: number, fresh: boolean): void {
    const c = view.curr, p = view.prev;
    if (!c) return;
    const frameMs = this.frameMs || 16.7;
    const same = p && p.head.width === c.head.width && p.head.height === c.head.height && p.head.cellX === c.head.cellX && p.head.cellY === c.head.cellY;
    const consecutive = p && c.head.frame - p.head.frame === 1;
    if (same && consecutive && typeof Float16Array !== 'undefined' && view.cropInterval > frameMs * 1.4 && view.cropInterval < 60) {
      const a = Math.min(1, Math.max(0, (now - c.at + frameMs) / view.cropInterval));
      if (a >= 1) { if (fresh || view.fieldHead !== c.head) this.upload(view, c.head, c.data); return; }
      const n = c.data.byteLength;
      if (!view.blend || view.blend.byteLength !== n) view.blend = new Uint8Array(n);
      const out = new Float16Array(view.blend.buffer, 0, n / 2);
      const from = new Float16Array(p.data.buffer, p.data.byteOffset, n / 2);
      const to = new Float16Array(c.data.buffer, c.data.byteOffset, n / 2);
      for (let i = 0; i < out.length; i++) out[i] = from[i]! + (to[i]! - from[i]!) * a;
      this.upload(view, c.head, view.blend);
      view.fieldHead = null; // a blend is on the GPU, not the crop itself
      view.fieldHeadShown = c.head;
      return;
    }
    if (fresh || view.fieldHead !== c.head) this.upload(view, c.head, c.data);
  }

  private upload(view: View, head: CropHeader, data: Uint8Array): void {
    if (!view.fieldTex || view.fieldTex.width !== head.width || view.fieldTex.height !== head.height) {
      view.fieldTex?.destroy();
      view.fieldTex = this.device.createTexture({
        size: [head.width, head.height], format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      view.fieldView = view.fieldTex.createView();
    }
    this.device.queue.writeTexture({ texture: view.fieldTex }, data, { bytesPerRow: head.width * 8 }, [head.width, head.height]);
    view.fieldHead = head;
    view.fieldHeadShown = head;
  }
}
