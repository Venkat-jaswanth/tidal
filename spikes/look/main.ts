// Single-vessel harness for judging the look: the real solver and the real renderer in one window.
// ?theme=bench|darkroom|millimetre  ?motion=rest|slosh|pour  ?freeze=<seconds>
import { MpmSim, fillBlock } from '../../src/sim/mpm';
import { CropPacker, type Crop } from '../../src/sim/crop';
import { WaterRenderer, graduationStep } from '../../src/render/water';
import { THEMES } from '../../src/render/theme';
import { LIQUIDS } from '../../src/liquids';

const q = new URLSearchParams(location.search);
const CELL = 6, HZ = 720, N = Number(q.get('n') ?? 100000), PX2_PER_ML = 220;
const theme = THEMES[q.get('theme') ?? 'bench']!;
const motion = q.get('motion') ?? 'rest';
const freeze = Number(q.get('freeze') ?? Infinity);
declare global { interface Window { __look?: { t: number; frozen: boolean; error?: string } } }
window.__look = { t: 0, frozen: false };

const TYPE: Record<string, { label: string; mono: string; weight: string }> = {
  bench: { label: "'B612', sans-serif", mono: "'B612 Mono', monospace", weight: '400' },
  darkroom: { label: "'IBM Plex Sans Condensed', sans-serif", mono: "'IBM Plex Mono', monospace", weight: '500' },
  millimetre: { label: "'Archivo Narrow', sans-serif", mono: "'Chivo Mono', monospace", weight: '500' },
};

function chrome() {
  const el = document.querySelector<HTMLElement>('#chrome')!;
  const type = TYPE[theme.name]!;
  el.dataset.dir = theme.name;
  el.style.setProperty('--ink', theme.ink);
  el.style.setProperty('--label', type.label);
  el.style.setProperty('--mono', type.mono);
  el.style.setProperty('--label-weight', type.weight);
  const { tickMl, major } = graduationStep(innerWidth, PX2_PER_ML);
  const pxPerMl = PX2_PER_ML / innerWidth;
  const grads = document.querySelector('#grads')!;
  for (let ml = tickMl * major; ml * pxPerMl < innerHeight - 70; ml += tickMl * major) {
    const d = document.createElement('div');
    d.className = 'grad num';
    d.style.top = `${innerHeight - ml * pxPerMl}px`;
    d.textContent = String(ml);
    grads.append(d);
  }
}

async function main() {
  chrome();
  await document.fonts.ready;
  const adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))!;
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', (e) => { window.__look!.error = (e as GPUUncapturedErrorEvent).error.message; console.error(window.__look!.error); });
  const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
  const dpr = devicePixelRatio;
  const W = innerWidth, H = innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  // pretend the viewport sits somewhere on a screen; the grid origin is a little up and left of it
  const viewX = 317, viewY = 203;
  const PAD = 40; // cells of room for the vessel to move
  const gridW = Math.ceil(W / CELL) + PAD * 2, gridH = Math.ceil(H / CELL) + PAD * 2;
  const gridOriginX = viewX - PAD * CELL, gridOriginY = viewY - PAD * CELL;
  const sim = new MpmSim(device, { gridW, gridH, maxParticles: N, cellPx: CELL, substepHz: HZ });
  const liquid = LIQUIDS[q.get('liquid') ?? 'water']!;
  sim.liquid = { ...liquid.physics, viscosity: Number(q.get('mu') ?? liquid.physics.viscosity), cohesion: Number(q.get('coh') ?? liquid.physics.cohesion) };
  sim.dye = liquid.id === 'ink';
  const rho0 = (Number(q.get('cal') ?? 0.93) * N * CELL * CELL) / (1000 * PX2_PER_ML);
  const OUTSET = Number(q.get('outset') ?? 1);
  const rect = (ox: number, oy: number) => ({
    x0: (viewX + ox - gridOriginX) / CELL - OUTSET, y0: (viewY + oy - gridOriginY) / CELL - OUTSET,
    x1: (viewX + ox + W - gridOriginX) / CELL + OUTSET, y1: (viewY + oy + H - gridOriginY) / CELL + OUTSET,
  });
  const r0 = rect(0, 0);
  const fill = motion === 'pour' ? { ...r0, x1: r0.x0 + (r0.x1 - r0.x0) * 0.45 } : r0;
  const block = fillBlock(N, rho0, fill, [0, 0, 0], 0);
  if (liquid.id === 'ink') {
    const f32 = new Float32Array(block);
    const mid = (fill.x0 + fill.x1) / 2;
    for (let i = 0; i < N; i++) f32[i * 16 + 8] = f32[i * 16]! > mid ? 1 : 0;
  }
  sim.setParticles(block, N, rho0);

  const packer = new CropPacker(device, sim);
  const renderer = new WaterRenderer(device, format);
  let crop: Crop | null = null;
  let last = performance.now(), t = 0, px = 0, py = 0;

  function offset(time: number): [number, number] {
    if (motion !== 'slosh') return [0, 0];
    // a hand shoving the vessel sideways and back, then letting go
    const k = time < 1 ? 0 : Math.sin((time - 1) * 5.5) * Math.exp(-Math.max(0, time - 2.2) * 1.4);
    return [k * 90, 0];
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    const frozen = t >= freeze;
    if (!frozen) {
      t += dt;
      const [ox, oy] = offset(t);
      const r = rect(ox, oy);
      sim.step([{ index: 0, ...r, dx: (ox - px) / CELL, dy: (oy - py) / CELL, rainWeight: 1 }], sim.substepsFor(dt), t, false);
      px = ox; py = oy;
    }
    window.__look!.t = t; window.__look!.frozen = frozen;
    const [ox, oy] = [px, py];
    const r = rect(ox, oy);
    crop = packer.fit(crop, r.x0, r.y0, r.x1, r.y1);
    const enc = device.createCommandEncoder();
    packer.pack(enc, [crop], 0, 1, liquid.id === 'ink');
    renderer.draw(enc, ctx.getCurrentTexture().createView(), crop.view, {
      originX: viewX + ox, originY: viewY + oy, width: W, height: H, dpr, time: t,
      cropX: gridOriginX + crop.cellX * CELL, cropY: gridOriginY + crop.cellY * CELL,
      cellPx: CELL, px2PerMl: PX2_PER_ML, gravityX: 0, gravityY: 1, tier: Number(q.get('tier') ?? 0),
    }, theme, liquid.id === 'water' ? { ...liquid.look, ...theme.liquid } : liquid.look);
    device.queue.submit([enc.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
main().catch((e: unknown) => { window.__look!.error = String(e); console.error(e); });
