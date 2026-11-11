// Spike S3: does MLS-MPM stay stable when vessel walls are flung violently?
// One canvas stands in for the screen; rects moving inside it stand in for windows.
import { MpmSim, fillBlock, WATER } from '../../src/sim/mpm';
import type { Vessel } from '../../src/sim/domain';
import { MAX_RECTS, commonWGSL } from '../../src/sim/shaders';

const q = new URLSearchParams(location.search);
const CELL = Number(q.get('cell') ?? 6);
const HZ = Number(q.get('hz') ?? 900);
const N = Number(q.get('n') ?? 100000);
const WATER_AREA_PX = 220000;
const scenario = q.get('scenario') ?? 'fling';

interface Sample { t: number; phase: string; sub: number; total: number; rain: number; blowUps: number; gpuMs: number | null; area?: number }
declare global { interface Window { __s3?: { done: boolean; samples: Sample[]; summary?: unknown; error?: string } } }
window.__s3 = { done: false, samples: [] };

const viewWGSL = /* wgsl */ `${commonWGSL}
@group(0) @binding(1) var<storage, read> fieldA: array<vec4f>;
struct View { cellsPerPx: f32, pad: vec3f }
@group(0) @binding(2) var<uniform> V: View;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0.0, 1.0);
}
fn mass(c: vec2i) -> f32 {
  if (c.x < 0 || c.y < 0 || c.x >= i32(P.grid.x) || c.y >= i32(P.grid.y)) { return 0.0; }
  return fieldA[c.y * i32(P.grid.x) + c.x].x;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let g = fc.xy * V.cellsPerPx;
  let b = floor(g - 0.5);
  let f = g - 0.5 - b;
  let c = vec2i(b);
  let m = mix(mix(mass(c), mass(c + vec2i(1, 0)), f.x), mix(mass(c + vec2i(0, 1)), mass(c + vec2i(1, 1)), f.x), f.y);
  let s = sdUnion(g);
  var col = vec3f(0.08, 0.09, 0.11);
  if (s.x < 0.0) { col = vec3f(0.93, 0.92, 0.88); }
  let water = smoothstep(0.42, 0.52, m);
  col = mix(col, mix(vec3f(0.25, 0.62, 0.78), vec3f(0.05, 0.25, 0.45), clamp(m - 0.8, 0.0, 1.0)), water * 0.9);
  if (abs(s.x) < 0.2) { col = vec3f(0.2, 0.2, 0.22); }
  return vec4f(col, 1.0);
}`;

async function main() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no adapter');
  const features: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({ requiredFeatures: features });
  device.addEventListener('uncapturederror', (e) => { window.__s3!.error = (e as GPUUncapturedErrorEvent).error.message; console.error((e as GPUUncapturedErrorEvent).error.message); });

  const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const gridW = Math.ceil(canvas.width / CELL) + 8;
  const gridH = Math.ceil(canvas.height / CELL) + 8;
  const sim = new MpmSim(device, { gridW, gridH, maxParticles: N, cellPx: CELL, substepHz: HZ });
  sim.liquid = { ...WATER, gravityY: Number(q.get('g') ?? WATER.gravityY), soundSpeed2: Number(q.get('c2') ?? WATER.soundSpeed2), eosPower: Number(q.get('gamma') ?? WATER.eosPower), cohesion: Number(q.get('coh') ?? 0), damping: Number(q.get('damp') ?? 1), wallFriction: Number(q.get('fr') ?? 0), viscosity: Number(q.get('mu') ?? WATER.viscosity) };
  const rho0 = (N * CELL * CELL) / WATER_AREA_PX;

  // vessels in px
  const boxes = [{ x: 400, y: 330, w: 700, h: 500 }];
  if (scenario === 'pour') boxes.push({ x: 1104, y: 330, w: 380, h: 500 });
  const fillFrac = scenario === 'level' ? 0.5 : 1;
  const prev = boxes.map((b) => ({ ...b }));
  const first = boxes[0]!;
  sim.setParticles(
    fillBlock(N, rho0, { x0: first.x / CELL, y0: first.y / CELL, x1: (first.x + first.w * fillFrac) / CELL, y1: (first.y + first.h) / CELL }, [0, 0, 0], 0),
    N, rho0,
  );

  const viewBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(viewBuf, 0, new Float32Array([1 / CELL, 0, 0, 0, 0, 0, 0, 0]));
  const viewParams = device.createBuffer({ size: (24 + MAX_RECTS * 12) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: viewWGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  });
  const viewGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: viewParams } },
      { binding: 1, resource: { buffer: sim.fieldA } },
      { binding: 2, resource: { buffer: viewBuf } },
    ],
  });

  // Reads the mass field back. Returns the wetted area in px² and the share of wet cells that
  // touch a dry cell: a settled pool scores a few percent, broken-up foam scores far higher.
  async function wetted(): Promise<{ area: number; edge: number; rough: number }> {
    const size = gridW * gridH * 16;
    const buf = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(sim.fieldA, 0, buf, 0, size);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange());
    const wet = (x: number, y: number) => x >= 0 && y >= 0 && x < gridW && y < gridH && f[(y * gridW + x) * 4]! > 0.5;
    let cells = 0, wetCells = 0, edgeCells = 0;
    for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
      cells += Math.min(1, Math.max(0, (f[(y * gridW + x) * 4]! - 0.25) / 0.5));
      if (!wet(x, y)) continue;
      wetCells++;
      if (!wet(x - 1, y) || !wet(x + 1, y) || !wet(x, y - 1) || !wet(x, y + 1)) edgeCells++;
    }
    // surface roughness: standard deviation of the topmost wet cell per column inside vessel 0, in px
    const b = boxes[0]!;
    const tops: number[] = [];
    for (let x = Math.ceil(b.x / CELL) + 2; x < Math.floor((b.x + b.w) / CELL) - 2; x++) {
      for (let y = 0; y < gridH; y++) if (wet(x, y)) { tops.push(y * CELL); break; }
    }
    const mean = tops.reduce((a, v) => a + v, 0) / Math.max(1, tops.length);
    const rough = Math.sqrt(tops.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, tops.length));
    buf.unmap(); buf.destroy();
    return { area: cells * CELL * CELL, edge: wetCells ? edgeCells / wetCells : 1, rough };
  }

  // Scripted motion. Peak speeds are in px/s; 13 000 px/s is about 3 m/s on a 110 dpi screen.
  const base = { x: first.x, y: first.y };
  function pose(t: number): { phase: string; x: number; y: number } {
    if (scenario !== 'fling') return { phase: t < 3 ? 'settle' : 'run', x: base.x, y: base.y };
    if (t < 3) return { phase: 'settle', x: base.x, y: base.y };
    if (t < 6) { const a = 300, w = 2000 / a; return { phase: 'shake-2000', x: base.x + a * Math.sin(w * (t - 3)), y: base.y }; }
    if (t < 9) { const a = 300, w = 6000 / a; return { phase: 'shake-6000', x: base.x + a * Math.sin(w * (t - 6)), y: base.y }; }
    if (t < 12) { const a = 300, w = 13000 / a; return { phase: 'shake-13000', x: base.x + a * Math.sin(w * (t - 9)), y: base.y }; }
    if (t < 15) { const a = 150, w = 13000 / a; return { phase: 'circle-13000', x: base.x + a * Math.sin(w * (t - 12)), y: base.y - 100 + 100 * Math.cos(w * (t - 12)) }; }
    if (t < 16) { const k = Math.floor((t - 15) / 0.25) % 2; return { phase: 'teleport', x: base.x + (k ? 380 : -380), y: base.y }; }
    return { phase: t < 26 ? 'rest' : 'rest-late', x: base.x, y: base.y };
  }
  const END = scenario === 'fling' ? 28 : scenario === 'level' ? 16 : 12;

  const log = document.querySelector('#log')!;
  let last = performance.now();
  const t0 = last;
  let areaStart = 0;
  let edgeStart = 0;
  let areaAsked = false;
  const frameTimes: number[] = [];
  let nextRough = 1;
  const roughLog: [number, number][] = [];

  async function finish() {
    const end = await wetted();
    const areaEnd = end.area;
    const s = window.__s3!;
    const totals = s.samples.map((x) => x.total + x.rain);
    const gpu = s.samples.map((x) => x.gpuMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const ft = frameTimes.slice().sort((a, b) => a - b);
    s.summary = {
      cell: CELL, hz: HZ, particles: N, restDensity: rho0, grid: [gridW, gridH],
      minTotal: Math.min(...totals), maxTotal: Math.max(...totals),
      countDriftPct: (100 * Math.max(...totals.map((v) => Math.abs(v - N)))) / N,
      blowUps: s.samples.reduce((a, x) => a + x.blowUps, 0),
      edgeShareStart: edgeStart, edgeShareEnd: end.edge,
      areaStartPx: areaStart, areaEndPx: areaEnd, areaDriftPct: (100 * (areaEnd - areaStart)) / areaStart,
      gpuMsP50: gpu[Math.floor(gpu.length / 2)] ?? null, gpuMsP95: gpu[Math.floor(gpu.length * 0.95)] ?? null,
      frameMsP50: ft[Math.floor(ft.length / 2)], frameMsP95: ft[Math.floor(ft.length * 0.95)],
      roughLog,
      substepsTypical: s.samples[Math.floor(s.samples.length / 2)]?.sub,
    };
    s.done = true;
    log.textContent = JSON.stringify(s.summary, null, 1);
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000);
    frameTimes.push(now - last);
    last = now;
    const t = (now - t0) / 1000;
    const p = pose(t);
    first.x = p.x; first.y = p.y;
    const nSub = sim.substepsFor(dt);
    const vessels: Vessel[] = boxes.map((b, i) => ({
      index: i,
      x0: b.x / CELL, y0: b.y / CELL, x1: (b.x + b.w) / CELL, y1: (b.y + b.h) / CELL,
      dx: (b.x - prev[i]!.x) / CELL, dy: (b.y - prev[i]!.y) / CELL, rainWeight: b.w,
    }));
    boxes.forEach((b, i) => { prev[i]!.x = b.x; prev[i]!.y = b.y; });
    sim.step(vessels, nSub, t, false);

    // the debug view only needs grid size and rects from the params block
    const pd = new ArrayBuffer((24 + MAX_RECTS * 12) * 4);
    const pu = new Uint32Array(pd); const pf = new Float32Array(pd);
    pu[0] = gridW; pu[1] = gridH; pu[2] = N; pu[3] = vessels.length;
    vessels.forEach((v, i) => { const o = 24 + i * 12; pf[o] = v.x0; pf[o + 1] = v.y0; pf[o + 2] = v.x1; pf[o + 3] = v.y1; });
    device.queue.writeBuffer(viewParams, 0, pd);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, viewGroup); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);

    const st = sim.stats;
    if (st) {
      let total = 0; for (const c of st.counts) total += c;
      window.__s3!.samples.push({ t, phase: p.phase, sub: st.substeps, total, rain: st.rain, blowUps: st.blowUps, gpuMs: st.gpuMs });
      if ((window.__s3!.samples.length & 15) === 0) log.textContent = `${p.phase} t=${t.toFixed(1)} sub=${st.substeps} total=${total.toFixed(1)} gpu=${st.gpuMs?.toFixed(2)}ms`;
    }
    if (scenario === 'level' && t > nextRough) { nextRough += 1; const tt = t; void wetted().then((a) => { roughLog.push([Math.round(tt), Math.round(a.rough * 10) / 10]); }); }
    if (t > 2.8 && !areaAsked) { areaAsked = true; void wetted().then((a) => { areaStart = a.area; edgeStart = a.edge; }); }
    if (t < END) requestAnimationFrame(frame); else void finish();
  }
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => { window.__s3!.error = String(e); window.__s3!.done = true; console.error(e); });
