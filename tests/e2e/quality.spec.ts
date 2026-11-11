// The quality ladder: forcing the lowest tier halves the particles, renders at device pixel ratio 1 and keeps the volume.

import { deviation, expect, fmt, readTotals, sleep, test } from '../helpers';

test('quality: ?tier=5 thins the particles and renders at dpr 1', async ({ lab }) => {
  test.setTimeout(60_000);
  const w = await lab.mainOnly({ query: '?tier=5' });
  const main = w.main;
  await main.waitForFunction(() => window.tidal?.stats.tier === 5, null, { timeout: 10_000 });
  const t0 = Date.now();
  await main.waitForFunction(() => window.tidal!.stats.particles <= 50_000, null, { timeout: 5000 });
  console.log(`particles reached <= 50000 after ${Date.now() - t0} ms of the tier being set`);
  await sleep(1500);
  const s = await main.evaluate(() => ({
    tier: window.tidal!.stats.tier, particles: window.tidal!.stats.particles, dpr: devicePixelRatio,
    canvasW: document.querySelector<HTMLCanvasElement>('#tank')!.width, canvasH: document.querySelector<HTMLCanvasElement>('#tank')!.height,
    innerW: innerWidth, innerH: innerHeight, fps: window.tidal!.stats.fps,
  }));
  const t = await readTotals(main);
  console.log(`tier ${s.tier}, particles ${s.particles}, devicePixelRatio ${s.dpr}, canvas ${s.canvasW}x${s.canvasH}, inner ${s.innerW}x${s.innerH}, fps ${fmt(s.fps, 0)}, total ${fmt(t.total, 2)}${s.dpr === 1 ? ' (note: this display has dpr 1, so the canvas-size check cannot tell dpr 1 rendering from native)' : ''}`);
  expect(s.tier).toBe(5);
  expect(s.particles).toBeLessThanOrEqual(50_000);
  expect(s.canvasW, 'canvas.width equals innerWidth').toBe(s.innerW);
  expect(deviation(t.total)).toBeLessThanOrEqual(0.005);

  // control: the default tier renders at the device pixel ratio
  const c = await lab.mainOnly();
  await sleep(1000);
  const d = await c.main.evaluate(() => ({ tier: window.tidal!.stats.tier, particles: window.tidal!.stats.particles, dpr: devicePixelRatio, w: document.querySelector<HTMLCanvasElement>('#tank')!.width, iw: innerWidth }));
  console.log(`control (tier 0): tier ${d.tier}, particles ${d.particles}, canvas.width ${d.w} for innerWidth ${d.iw} at dpr ${d.dpr}`);
  expect(d.particles).toBe(100_000);
  expect(d.w).toBe(Math.round(d.iw * d.dpr));
});
