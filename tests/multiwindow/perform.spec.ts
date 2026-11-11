// Perform: the popups choreograph themselves across the display. They must move smoothly, keep rendering,
// finish on their own, and stop at once on any input.

import type { Page } from '@playwright/test';
import { calibrate, deviation, expect, fmt, fpsOf, layoutRow, median, percentile, refreshRate, sleep, stopTotals, test, trackTotals, type World, type Lab } from '../helpers';

const PERFORM_SECONDS = 17; // src/perform/timeline.ts

async function ready(lab: Lab): Promise<World> {
  const w = await lab.world({ popups: 3 });
  await layoutRow(w, { gapMain: 0, gapPopups: 10, popupSize: { w: 330, h: 263 }, mainSize: { w: 620, h: 520 } });
  for (const p of w.all) await p.waitForFunction(() => window.tidalApp != null);
  for (const p of w.all) await calibrate(p);
  await sleep(2000);
  return w;
}

const isPerforming = (p: Page): Promise<boolean> => p.evaluate(() => window.tidalApp!.performer.performing);

test.describe('perform', () => {
  test('a full performance: smooth moves, 55+ fps in every popup, ends by itself, volume conserved', async ({ lab }) => {
    test.setTimeout(120_000);
    const w = await ready(lab);
    await trackTotals(w.main);
    // rAF gaps are only counted while performing
    for (const p of w.popups) await p.evaluate(() => {
      const s = window as unknown as { __g: number[]; __last: number };
      s.__g = []; s.__last = 0;
      const tick = (now: number): void => { if (window.tidalApp!.performer.performing) { if (s.__last) s.__g.push(now - s.__last); s.__last = now; } else s.__last = 0; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const count = await w.main.evaluate(() => window.tidalApp!.performer.start());
    const t0 = Date.now();
    console.log(`performing with ${count} vessels`);
    expect(count).toBe(3);
    let endedAt = -1;
    while (Date.now() - t0 < (PERFORM_SECONDS + 3) * 1000) {
      if (!(await isPerforming(w.main)) && Date.now() - t0 > 1000) { endedAt = (Date.now() - t0) / 1000; break; }
      await sleep(100);
    }
    console.log(`performance ended by itself after ${fmt(endedAt, 2)} s`);
    expect(endedAt, 'performance ended within PERFORM_SECONDS + 3').toBeGreaterThan(0);
    expect(endedAt, 'ran at least 12 s').toBeGreaterThanOrEqual(12);
    for (const p of w.all) expect(await isPerforming(p), 'every window stopped').toBe(false);

    for (const [i, p] of w.popups.entries()) {
      const r = await p.evaluate(() => {
        const m = window.tidalApp!.performer.moveStats;
        return { moves: m.moves, gaps: m.movingGapsMs.slice(), frames: (window as unknown as { __g: number[] }).__g.slice(), leader: window.tidal!.isLeader };
      });
      const hz = 1000 / median(r.gaps);
      const fps = fpsOf(r.frames);
      const rate = refreshRate(r.frames);
      console.log(`popup${i}: ${r.moves} moves; move rate while moving median ${fmt(hz, 1)} Hz (p5-slow ${fmt(1000 / percentile(r.gaps, 0.95), 1)} Hz, worst gap ${fmt(Math.max(...r.gaps), 0)} ms); render ${fmt(fps, 1)} fps over ${r.frames.length} frames (median frame ${fmt(median(r.frames), 1)} ms, p95 ${fmt(percentile(r.frames, 0.95), 1)} ms, worst ${fmt(Math.max(...r.frames), 0)} ms); observed refresh ~${rate} Hz; leader ${r.leader}`);
      expect.soft(hz, `popup${i} median move rate`).toBeGreaterThanOrEqual(30);
      expect.soft(fps, `popup${i} render fps (display ~${rate} Hz)`).toBeGreaterThanOrEqual(55);
    }
    const tot = await stopTotals(w.main);
    console.log(`total during performance: min ${fmt(tot.min, 3)} max ${fmt(tot.max, 3)} (worst deviation ${fmt(tot.worst * 100, 4)} %, max rain ${fmt(tot.maxRain, 1)} mL)`);
    expect(tot.worst).toBeLessThanOrEqual(0.005);
    expect(deviation(tot.min)).toBeLessThanOrEqual(0.005);
  });

  test('a key press stops the performance at once, in every window', async ({ lab }) => {
    test.setTimeout(90_000);
    const w = await ready(lab);
    for (const p of w.all) await p.evaluate(() => {
      const s = window as unknown as { __stopAt: number };
      s.__stopAt = 0;
      setInterval(() => { if (!window.tidalApp!.performer.performing && !s.__stopAt && (window as unknown as { __was: boolean }).__was) s.__stopAt = performance.timeOrigin + performance.now(); if (window.tidalApp!.performer.performing) (window as unknown as { __was: boolean }).__was = true; }, 5);
    });
    await w.main.evaluate(() => window.tidalApp!.performer.start());
    await sleep(3000);
    for (const p of w.all) expect(await isPerforming(p), 'performing after 3 s').toBe(true);
    const pressed = Date.now();
    await w.main.keyboard.press('Shift');
    await sleep(800);
    const stops = await Promise.all(w.all.map((p) => p.evaluate(() => (window as unknown as { __stopAt: number }).__stopAt)));
    const latencies = stops.map((s) => (s > 0 ? s - pressed : Infinity));
    console.log(`stop latency after keypress: main ${fmt(latencies[0]!, 0)} ms, popups ${latencies.slice(1).map((l) => fmt(l, 0)).join(' / ')} ms`);
    for (const p of w.all) expect(await isPerforming(p), 'stopped').toBe(false);
    for (const [i, l] of latencies.entries()) expect(l, `window ${i} stop latency`).toBeLessThanOrEqual(300);
  });
});
