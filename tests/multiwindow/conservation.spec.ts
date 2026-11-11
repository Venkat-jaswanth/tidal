// Soak: three windows, the popups hop around the display at random (touching, apart, shaking back and
// forth) while the world's total is sampled every second. Volume must stay 1000 mL within 0.5 %, and an
// independent count from the particle snapshot must show (almost) every particle inside some vessel.

import type { Page } from '@playwright/test';
import { deviation, displayOf, expect, fmt, layoutRow, readTotals, rectOf, sleep, snapshotFraction, startRectHistory, test, type Display } from '../helpers';

const SOAK_SECONDS = Number(process.env.TIDAL_SOAK_SECONDS ?? 60);
const POP = { w: 340, h: 263 };

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

async function moveTo(p: Page, x: number, y: number): Promise<void> {
  await p.evaluate(([px, py]) => { const c = window.tidal!.calibrator.cal; window.moveTo(Math.round(px! - c.dx), Math.round(py! - c.dy)); }, [x, y]);
}

/** One random behaviour: jump somewhere, snap against a neighbour, or shake quickly back and forth. */
async function hop(me: Page, others: Page[], d: Display): Promise<void> {
  const roll = Math.random();
  const anyX = (): number => rnd(d.left + 10, d.left + d.w - POP.w - 10);
  const anyY = (): number => rnd(d.top + 90, d.top + d.h - POP.h - 20);
  if (roll < 0.4) {
    await moveTo(me, anyX(), anyY());
  } else if (roll < 0.65) {
    // touching (or nearly) a neighbour: left, right or below it, with a few px of random slack
    const other = others[Math.floor(Math.random() * others.length)]!;
    const r = await rectOf(other);
    const side = Math.floor(Math.random() * 3);
    const slack = rnd(-6, 18);
    const x = side === 0 ? r.x - POP.w - slack : side === 1 ? r.x + r.w + slack : r.x + rnd(-100, 100);
    const y = side === 2 ? r.y + r.h + slack : r.y + rnd(-60, 60);
    await moveTo(me, Math.max(d.left, Math.min(d.left + d.w - POP.w, x)), Math.max(d.top + 90, Math.min(d.top + d.h - POP.h - 10, y)));
  } else {
    // fast back-and-forth: about 8 Hz for half a second
    const r = await rectOf(me);
    const amp = rnd(40, 160);
    const horizontal = Math.random() < 0.7;
    for (let i = 0; i < 8; i++) {
      const s = i % 2 === 0 ? amp : -amp;
      await moveTo(me, Math.max(d.left, Math.min(d.left + d.w - POP.w, r.x + (horizontal ? s : 0))), Math.max(d.top + 90, Math.min(d.top + d.h - POP.h - 10, r.y + (horizontal ? 0 : s))));
      await sleep(60);
    }
  }
}

test('conservation: total volume holds while two popups roam (soak)', async ({ lab }) => {
  test.setTimeout(SOAK_SECONDS * 1000 + 180_000);
  const w = await lab.world({ popups: 2, popupSize: POP });
  const layout = await layoutRow(w, { gapMain: 0, gapPopups: 20, mainSize: { w: 620, h: 520 } });
  const d = layout.display;
  await startRectHistory(w.main);
  await sleep(4000); // let the water spread before the soak starts

  const samples: { t: number; total: number; rain: number; blowUps: number }[] = [];
  const shares: { at: string; count: number; inside: number; rain: number; fraction: number; ageMs: number; rectsUsed: number }[] = [];
  const t0 = Date.now();
  let running = true;
  const pos: ({ x: number; y: number } | undefined)[] = [];
  let travelled = 0;

  let hops = 0;
  const mover = async (me: Page, others: Page[]): Promise<void> => {
    while (running) {
      await hop(me, others, d);
      hops++;
      await sleep(rnd(500, 1500));
    }
  };
  const movers = [mover(w.popups[0]!, [w.main, w.popups[1]!]), mover(w.popups[1]!, [w.main, w.popups[0]!])];

  const checkpoints = [0.25, 0.5, 0.75].map((f) => f * SOAK_SECONDS);
  let nextCp = 0;
  const sample = async (): Promise<void> => {
    const [t, blow] = await Promise.all([readTotals(w.main), w.main.evaluate(() => window.tidal!.stats.blowUps)]);
    const pr = await Promise.all(w.popups.map(rectOf));
    for (const [i, r] of pr.entries()) { const last = pos[i]; if (last) travelled += Math.hypot(r.x - last.x, r.y - last.y); pos[i] = r; }
    samples.push({ t: (Date.now() - t0) / 1000, total: t.total, rain: t.rainMl, blowUps: blow });
  };
  while ((Date.now() - t0) / 1000 < SOAK_SECONDS) {
    await sample();
    const el = (Date.now() - t0) / 1000;
    if (nextCp < checkpoints.length && el >= checkpoints[nextCp]!) {
      const s = await snapshotFraction(w.main);
      shares.push({ at: `${fmt(el, 0)} s`, ...s });
      nextCp++;
    }
    await sleep(1000);
  }
  running = false;
  await Promise.all(movers);
  await sample();
  const end = await snapshotFraction(w.main);
  shares.push({ at: 'end', ...end });
  // and once more after the windows rest, which must be at least as good
  await sleep(2500);
  const rested = await snapshotFraction(w.main);
  shares.push({ at: 'end+2.5s at rest', ...rested });

  const totals = samples.map((s) => s.total);
  const worst = Math.max(...samples.map((s) => deviation(s.total)));
  const maxRain = Math.max(...samples.map((s) => s.rain));
  console.log(`conservation: ${SOAK_SECONDS} s, ${samples.length} samples, display ${JSON.stringify(await displayOf(w.main))}`);
  console.log(`  total min ${fmt(Math.min(...totals), 3)} mL, max ${fmt(Math.max(...totals), 3)} mL, worst deviation ${fmt(worst * 100, 4)} %, max rain ${fmt(maxRain, 1)} mL`);
  console.log(`  ${hops} hops; popups travelled ${fmt(travelled, 0)} px in total (sampled once a second)`);
  expect(hops).toBeGreaterThan(SOAK_SECONDS / 2);
  console.log(`  blowUps at end: ${samples[samples.length - 1]!.blowUps}`);
  for (const s of shares) console.log(`  snapshot @ ${s.at}: ${s.inside}/${s.count} inside union+30px or raining (${s.rain} rain) = ${fmt(s.fraction * 100, 3)} % (snapshot ${fmt(s.ageMs, 0)} ms old, compared with ${s.rectsUsed} vessel rects from its own moment)`);

  for (const s of samples) expect(deviation(s.total), `total at t=${fmt(s.t, 1)} s was ${fmt(s.total, 2)}`).toBeLessThanOrEqual(0.005);
  expect(samples[samples.length - 1]!.blowUps, 'stats.blowUps').toBe(0);
  for (const s of shares) expect(s.fraction, `snapshot fraction at ${s.at}`).toBeGreaterThanOrEqual(0.995);
});
