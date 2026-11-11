// 2D MLS-MPM (APIC) fluid solver on WebGPU. Runs on the leader window only.

import type { SimRect } from './domain';
import { DomainPlan, type DomainOptions, type Vessel } from './domain';
import {
  CELL_STRIDE, MAX_RECTS, PARTICLE_BYTES,
  carryWGSL, clearWGSL, g2pWGSL, gridWGSL, p2gDyeWGSL, p2gWGSL, recolorWGSL,
} from './shaders';

export const MAX_SUBSTEPS = 48;
const PARAM_FLOATS = 24 + MAX_RECTS * 12;
const COUNTER_SLOTS = MAX_RECTS + 4 + 32;

export interface SimConfig {
  gridW: number;
  gridH: number;
  maxParticles: number;
  /** CSS px per grid cell. */
  cellPx: number;
  /** Substeps per second of simulated time. */
  substepHz: number;
}

/** Material and world parameters in physical-ish units; converted to solver units per frame. */
export interface Liquid {
  /** px / s² */
  gravityX: number;
  gravityY: number;
  /** Squared sound speed in (cells / substep)². Sets stiffness. */
  soundSpeed2: number;
  eosPower: number;
  viscosity: number;
  cohesion: number;
  wallFriction: number;
  /** Velocity kept per substep (1 = no damping). */
  damping: number;
  dyeMix: number;
}

export const WATER: Liquid = {
  gravityX: 0, gravityY: 3200,
  soundSpeed2: 0.35, eosPower: 5,
  viscosity: 0.08, cohesion: 0, wallFriction: 0,
  damping: 0.999, dyeMix: 0,
};

export interface SimStats {
  frame: number;
  substeps: number;
  /** Particles owned by each vessel index, averaged over the frame's substeps. */
  counts: Float64Array;
  rain: number;
  blowUps: number;
  /** Mean squared speed (cells per substep)² of the particles owned by each vessel, per particle in the world. */
  energy: Float64Array;
  /** Wall-slap strength per vessel this frame, per particle in the world. */
  impact: Float64Array;
  /** GPU time of the frame's compute pass in ms, when timestamp queries are available. */
  gpuMs: number | null;
}

type Pipes = Record<'clear' | 'carry' | 'recolor' | 'p2g' | 'p2gDye' | 'grid' | 'g2p', GPUComputePipeline>;
const pipelineCache = new WeakMap<GPUDevice, { layout: GPUBindGroupLayout; pipes: Pipes }>();

/** Compiles the solver's pipelines once per device. Call ahead of time so taking over leadership is quick. */
export function simPipelines(device: GPUDevice): { layout: GPUBindGroupLayout; pipes: Pipes } {
  const cached = pipelineCache.get(device);
  if (cached) return cached;
  const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
    binding, visibility: GPUShaderStage.COMPUTE, buffer: { type },
  });
  const layout = device.createBindGroupLayout({
    entries: [entry(0, 'uniform'), entry(1, 'storage'), entry(2, 'storage'), entry(3, 'storage'), entry(4, 'storage'), entry(5, 'storage')],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (label: string, code: string) =>
    device.createComputePipeline({
      label, layout: pipelineLayout,
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
  const made = {
    layout,
    pipes: {
      clear: pipe('clear', clearWGSL), carry: pipe('carry', carryWGSL), recolor: pipe('recolor', recolorWGSL),
      p2g: pipe('p2g', p2gWGSL), p2gDye: pipe('p2gDye', p2gDyeWGSL),
      grid: pipe('grid', gridWGSL), g2p: pipe('g2p', g2pWGSL),
    },
  };
  pipelineCache.set(device, made);
  return made;
}

export class MpmSim {
  readonly particles: GPUBuffer;
  readonly fieldA: GPUBuffer;
  readonly fieldB: GPUBuffer;
  readonly cells: GPUBuffer;
  readonly domain: DomainOptions;
  particleCount = 0;
  /** Scatter dye to the grid (ink). Costs three more atomics per particle per cell. */
  dye = false;
  restDensity = 8;
  liquid: Liquid = { ...WATER };
  stats: SimStats | null = null;
  /** Active region of the last frame, in cells: x, y, w, h. */
  region: [number, number, number, number] = [0, 0, 1, 1];

  private readonly counters: GPUBuffer;
  private readonly paramBuffers: GPUBuffer[] = [];
  private readonly bindGroups: GPUBindGroup[] = [];
  private readonly pipes: Pipes;
  private readonly paramData = new ArrayBuffer(PARAM_FLOATS * 4);
  private readonly pf = new Float32Array(this.paramData);
  private readonly pu = new Uint32Array(this.paramData);
  private readonly zeroCounters = new Uint32Array(COUNTER_SLOTS);
  private readonly readPool: GPUBuffer[] = [];
  private readonly querySet: GPUQuerySet | null;
  private readonly queryResolve: GPUBuffer | null;
  private frameNo = 0;
  private seed = 1;

  constructor(
    readonly device: GPUDevice,
    readonly config: SimConfig,
  ) {
    const { gridW, gridH, maxParticles } = config;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.particles = device.createBuffer({ label: 'particles', size: maxParticles * PARTICLE_BYTES, usage: storage });
    this.cells = device.createBuffer({ label: 'cells', size: gridW * gridH * CELL_STRIDE * 4, usage: storage });
    this.fieldA = device.createBuffer({ label: 'fieldA', size: gridW * gridH * 16, usage: storage });
    this.fieldB = device.createBuffer({ label: 'fieldB', size: gridW * gridH * 16, usage: storage });
    this.counters = device.createBuffer({ label: 'counters', size: COUNTER_SLOTS * 4, usage: storage });
    this.domain = { gap: 24 / config.cellPx, margin: 1, maxWallSpeed: 0.7 };

    const { layout, pipes } = simPipelines(device);
    this.pipes = pipes;
    // One uniform buffer per substep, because the walls move within a frame.
    for (let i = 0; i <= MAX_SUBSTEPS; i++) {
      const buffer = device.createBuffer({ size: PARAM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.paramBuffers.push(buffer);
      this.bindGroups.push(device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: this.particles } },
          { binding: 2, resource: { buffer: this.cells } },
          { binding: 3, resource: { buffer: this.fieldA } },
          { binding: 4, resource: { buffer: this.fieldB } },
          { binding: 5, resource: { buffer: this.counters } },
        ],
      }));
    }
    if (device.features.has('timestamp-query')) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    } else {
      this.querySet = null;
      this.queryResolve = null;
    }
  }

  /** Substeps needed to advance `seconds` of world time. */
  substepsFor(seconds: number): number {
    return Math.max(1, Math.min(MAX_SUBSTEPS, Math.round(seconds * this.config.substepHz)));
  }

  /** Replace all particles. `data` is PARTICLE_BYTES per particle. */
  setParticles(data: ArrayBuffer, count: number, restDensity: number): void {
    this.device.queue.writeBuffer(this.particles, 0, data, 0, count * PARTICLE_BYTES);
    this.particleCount = count;
    this.restDensity = restDensity;
  }

  /**
   * Advance one display frame. `vessels` carry their displacement over this frame.
   * `rain` turns particles stranded outside every vessel into rain instead of clamping them.
   */
  step(vessels: readonly Vessel[], nSub: number, timeSeconds: number, rain: boolean): void {
    const { device, config, liquid } = this;
    if (vessels.length === 0 || this.particleCount === 0) return;
    const plan = new DomainPlan(vessels, nSub, this.domain);
    const hz = config.substepHz;
    const gScale = 1 / (config.cellPx * hz * hz);

    // Active region: bounding box of every rect across the frame, padded for the stencil.
    const first = plan.rectsAt(-1);
    const last = plan.rectsAt(nSub - 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of [...first, ...last]) {
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
      x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
    }
    // Also cover last frame's box so cells a vessel just left are cleared rather than left stale.
    const own: [number, number, number, number] = [
      Math.max(0, Math.floor(x0) - 3), Math.max(0, Math.floor(y0) - 3),
      Math.min(config.gridW, Math.ceil(x1) + 3), Math.min(config.gridH, Math.ceil(y1) + 3),
    ];
    const before = this.lastBox ?? own;
    this.lastBox = own;
    const rx = Math.min(own[0], before[0]);
    const ry = Math.min(own[1], before[1]);
    const rw = Math.max(1, Math.max(own[2], before[2]) - rx);
    const rh = Math.max(1, Math.max(own[3], before[3]) - ry);
    this.region = [rx, ry, rw, rh];

    const write = (slot: number, rects: SimRect[], carry: boolean) => {
      const { pf, pu } = this;
      pu[0] = config.gridW; pu[1] = config.gridH; pu[2] = this.particleCount; pu[3] = rects.length;
      pu[4] = rx; pu[5] = ry; pu[6] = rw; pu[7] = rh;
      pf[8] = liquid.gravityX * gScale; pf[9] = liquid.gravityY * gScale;
      pf[10] = (liquid.soundSpeed2 * this.restDensity) / liquid.eosPower; pf[11] = this.restDensity;
      pf[12] = liquid.viscosity; pf[13] = liquid.eosPower; pf[14] = 0.9; pf[15] = liquid.damping;
      pf[16] = timeSeconds; pf[17] = rain ? 1 : 0; pf[18] = liquid.dyeMix; pf[19] = this.seed;
      pf[20] = liquid.cohesion; pf[21] = liquid.wallFriction; pf[22] = this.domain.margin; pf[23] = 0;
      for (let i = 0; i < MAX_RECTS; i++) {
        const o = 24 + i * 12;
        const r = rects[i];
        if (!r) { pf.fill(0, o, o + 12); continue; }
        pf[o] = r.x0; pf[o + 1] = r.y0; pf[o + 2] = r.x1; pf[o + 3] = r.y1;
        pf[o + 4] = r.vx; pf[o + 5] = r.vy;
        pf[o + 6] = carry ? r.carryX : 0; pf[o + 7] = carry ? r.carryY : 0;
        pf[o + 8] = r.owner; pf[o + 9] = r.kind; pf[o + 10] = r.rainWeight; pf[o + 11] = 0;
      }
      device.queue.writeBuffer(this.paramBuffers[slot]!, 0, this.paramData);
      this.seed = (this.seed + 7919) % 1000003;
    };

    device.queue.writeBuffer(this.counters, 0, this.zeroCounters);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(
      this.querySet ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {},
    );
    const pGroups = Math.ceil(this.particleCount / 64);
    const gx = Math.ceil(rw / 8);
    const gy = Math.ceil(rh / 8);
    if (plan.hasCarry || this.recolorNext) {
      write(MAX_SUBSTEPS, first, true);
      pass.setBindGroup(0, this.bindGroups[MAX_SUBSTEPS]!);
      if (plan.hasCarry) { pass.setPipeline(this.pipes.carry); pass.dispatchWorkgroups(pGroups); }
      if (this.recolorNext) { pass.setPipeline(this.pipes.recolor); pass.dispatchWorkgroups(pGroups); this.recolorNext = false; }
    }
    for (let s = 0; s < nSub; s++) {
      write(s, plan.rectsAt(s), false);
      pass.setBindGroup(0, this.bindGroups[s]!);
      pass.setPipeline(this.pipes.clear); pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.dye ? this.pipes.p2gDye : this.pipes.p2g); pass.dispatchWorkgroups(pGroups);
      pass.setPipeline(this.pipes.grid); pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.pipes.g2p); pass.dispatchWorkgroups(pGroups);
    }
    pass.end();

    // Stats come back a frame or two later through a small pool of mappable buffers, so no frame ever waits.
    const frame = ++this.frameNo;
    const read = this.readPool.pop() ?? (this.readPoolSize < 4 ? this.newReadBuffer() : null);
    if (read) {
      encoder.copyBufferToBuffer(this.counters, 0, read, 0, COUNTER_SLOTS * 4);
      if (this.querySet && this.queryResolve) {
        encoder.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0);
        encoder.copyBufferToBuffer(this.queryResolve, 0, read, COUNTER_SLOTS * 4, 16);
      }
    }
    device.queue.submit([encoder.finish()]);
    if (read) {
      void read.mapAsync(GPUMapMode.READ).then(() => {
        const bytes = read.getMappedRange();
        const c = new Uint32Array(bytes, 0, COUNTER_SLOTS);
        const counts = new Float64Array(MAX_RECTS);
        for (let i = 0; i < MAX_RECTS; i++) counts[i] = c[i]! / nSub;
        let gpuMs: number | null = null;
        if (this.querySet) {
          const t = new BigUint64Array(bytes, COUNTER_SLOTS * 4, 2);
          gpuMs = Number(t[1]! - t[0]!) / 1e6;
        }
        if (!this.stats || frame > this.stats.frame) {
          const energy = new Float64Array(16);
          const impact = new Float64Array(16);
          const norm = 256 * nSub * Math.max(1, this.particleCount);
          for (let i = 0; i < 16; i++) { energy[i] = c[MAX_RECTS + 4 + i]! / norm; impact[i] = c[MAX_RECTS + 20 + i]! / norm; }
          this.stats = { frame, substeps: nSub, counts, rain: c[MAX_RECTS]! / nSub, blowUps: c[MAX_RECTS + 1]!, energy, impact, gpuMs };
        }
        read.unmap();
        this.readPool.push(read);
      });
    }
  }

  /** Gives each vessel's liquid that vessel's ink. Takes effect with the next step. */
  recolor(): void { this.recolorNext = true; }
  private recolorNext = false;

  /** Copies every particle to the CPU. Resolves a frame or so later; never blocks a frame. */
  async readParticles(): Promise<ArrayBuffer> {
    const size = this.particleCount * PARTICLE_BYTES;
    const buf = this.snapPool.pop() ?? this.device.createBuffer({ size: this.config.maxParticles * PARTICLE_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.particles, 0, buf, 0, size);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ, 0, size);
    const out = buf.getMappedRange(0, size).slice(0);
    buf.unmap();
    this.snapPool.push(buf);
    return out;
  }

  destroy(): void {
    for (const b of [this.particles, this.cells, this.fieldA, this.fieldB, this.counters, ...this.paramBuffers, ...this.readPool, ...this.snapPool]) b.destroy();
  }

  private readonly snapPool: GPUBuffer[] = [];
  private readPoolSize = 0;
  private lastBox: [number, number, number, number] | null = null;
  private newReadBuffer(): GPUBuffer {
    this.readPoolSize++;
    return this.device.createBuffer({ size: COUNTER_SLOTS * 4 + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }
}

/** Fills a block of resting liquid into the bottom of a rect (cells). Returns PARTICLE_BYTES per particle. */
export function fillBlock(
  count: number, restDensity: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  dye: [number, number, number], owner: number,
): ArrayBuffer {
  const data = new ArrayBuffer(count * PARTICLE_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  const inset = 1.2;
  const width = rect.x1 - rect.x0 - inset * 2;
  const spacing = 1 / Math.sqrt(restDensity);
  const cols = Math.max(1, Math.floor(width / spacing));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    const o = (i * PARTICLE_BYTES) / 4;
    const col = i % cols;
    const row = Math.floor(i / cols);
    f[o] = rect.x0 + inset + (col + 0.5 + (rnd() - 0.5) * 0.6) * spacing;
    f[o + 1] = rect.y1 - inset - (row + 0.5 + (rnd() - 0.5) * 0.6) * spacing;
    f[o + 8] = dye[0]; f[o + 9] = dye[1]; f[o + 10] = dye[2];
    u[o + 12] = owner;
    f[o + 13] = restDensity;
  }
  return data;
}
