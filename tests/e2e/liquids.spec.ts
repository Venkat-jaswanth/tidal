// Each liquid can be poured and keeps the world's volume; ink carries two colours that mix where they meet.

import type { Page } from '@playwright/test';
import { calibrate, deviation, expect, fmt, layoutRow, readTotals, rectOf, sleep, test } from '../helpers';

const LIQUIDS = ['water', 'mercury', 'honey', 'ink'] as const;

interface DyeShare { n: number; low: number; high: number; mid: number; midFraction: number }

/** Histogram of the red-5 bits of the snapshot's dye word (u16 at byte 8 of each 12-byte particle). */
function dyeShare(page: Page): Promise<DyeShare> {
  return page.evaluate(() => {
    const snap = window.tidal!.transport.latestSnapshot();
    if (!snap || snap.count === 0) return { n: 0, low: 0, high: 0, mid: 0, midFraction: 0 };
    const v = new DataView(snap.data.buffer, snap.data.byteOffset, snap.data.byteLength);
    let low = 0, high = 0, mid = 0;
    for (let i = 0; i < snap.count; i++) {
      const r5 = v.getUint16(i * 12 + 8, true) >> 11;
      if (r5 <= 2) low++; else if (r5 >= 29) high++; else mid++;
    }
    return { n: snap.count, low, high, mid, midFraction: mid / snap.count };
  });
}

test.describe('liquids', () => {
  test('every liquid can be selected, keeps its particles and the total volume', async ({ lab }) => {
    test.setTimeout(90_000);
    const w = await lab.mainOnly();
    const main = w.main;
    await sleep(1500);
    for (const id of [...LIQUIDS, 'water'] as const) {
      await main.evaluate((x) => window.tidal!.command({ type: 'cmd', cmd: 'liquid', value: x }), id);
      await sleep(2000);
      const s = await main.evaluate(() => ({ liquid: window.tidal!.liquid.id, metaLiquid: window.tidal!.meta!.liquid, particles: window.tidal!.stats.particles, fps: window.tidal!.stats.fps, blow: window.tidal!.stats.blowUps, ml: window.tidal!.ml }));
      const t = await readTotals(main);
      // the canvas must show liquid: more than a sliver of it is not background paper
      const shot = await main.locator('canvas#tank').screenshot();
      console.log(`${id}: meta.liquid ${s.metaLiquid}, particles ${s.particles}, fps ${fmt(s.fps, 0)}, vessel ${fmt(s.ml, 1)} mL, total ${fmt(t.total, 2)}, screenshot ${shot.length} bytes`);
      expect(s.liquid).toBe(id);
      expect(s.metaLiquid).toBe(id);
      expect(s.particles).toBeGreaterThan(0);
      expect(s.blow).toBe(0);
      expect(s.ml, 'liquid still in the vessel').toBeGreaterThan(900);
      expect(deviation(t.total)).toBeLessThanOrEqual(0.005);
      expect(shot.length, 'canvas not blank').toBeGreaterThan(2000);
    }
  });

  test('ink: two colours are present at first and mix when shaken', async ({ lab }) => {
    test.setTimeout(120_000);
    const w = await lab.world({ popups: 2 });
    await layoutRow(w, { gapMain: 0, gapPopups: 0 });
    for (const p of w.all) await calibrate(p);
    await sleep(7000); // water spreads over all three vessels
    await w.main.evaluate(() => window.tidal!.command({ type: 'cmd', cmd: 'liquid', value: 'ink' }));
    await sleep(1500);
    const initial = await dyeShare(w.main);
    console.log(`ink poured: ${JSON.stringify({ ...initial, midFraction: +initial.midFraction.toFixed(4) })}; vessels ${JSON.stringify((await readTotals(w.main)).ml.slice(0, 3).map((x) => +x.toFixed(0)))}`);
    expect(initial.low, 'particles of the first ink').toBeGreaterThan(initial.n * 0.02);
    expect(initial.high, 'particles of the second ink').toBeGreaterThan(initial.n * 0.02);

    // shake the middle popup back and forth for 4 s
    const pop = w.popups[0]!;
    const r0 = await rectOf(pop);
    const t0 = Date.now();
    const mids: number[] = [];
    while (Date.now() - t0 < 4000) {
      const t = (Date.now() - t0) / 1000;
      await pop.evaluate(([x, y]) => { const c = window.tidal!.calibrator.cal; window.moveTo(Math.round(x! - c.dx), Math.round(y! - c.dy)); }, [r0.x + 70 * Math.sin(2 * Math.PI * 2.5 * t), r0.y + 20 * Math.sin(2 * Math.PI * 1.7 * t)]);
      if (Math.floor(t * 4) !== mids.length) mids.push((await dyeShare(w.main)).midFraction);
      await sleep(10);
    }
    await pop.evaluate(([x, y]) => { const c = window.tidal!.calibrator.cal; window.moveTo(Math.round(x! - c.dx), Math.round(y! - c.dy)); }, [r0.x, r0.y]);
    await sleep(1000);
    const after = await dyeShare(w.main);
    console.log(`after shaking: ${JSON.stringify({ ...after, midFraction: +after.midFraction.toFixed(4) })}; mid share during shake ${mids.map((m) => fmt(m * 100, 1)).join(' ')} %`);
    expect(after.midFraction, 'intermediate dye values appear (mixing)').toBeGreaterThan(Math.max(initial.midFraction * 2, 0.02));
    const t = await readTotals(w.main);
    expect(deviation(t.total)).toBeLessThanOrEqual(0.005);
  });
});
