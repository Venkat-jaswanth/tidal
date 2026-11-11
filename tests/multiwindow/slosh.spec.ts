// A popup holding water is shaken by moving itself: a gentle motion, then a violent one. The energy and
// wall-impact readings must reflect the difference, and no water may be lost.

import type { Page } from '@playwright/test';
import { calibrate, displayOf, expect, fmt, layoutRow, mean, readTotals, setRect, sleep, test } from '../helpers';

const POP = { w: 340, h: 263 };

interface Shake { energy: number[]; impact: number[]; ml0: number; ml1: number; moves: number }

/** Move the popup sinusoidally around where it is (x axis) for `seconds`, recording this vessel's meta readings every frame. */
function shake(page: Page, amp: number, hz: number, seconds: number): Promise<Shake> {
  return page.evaluate(([a, f, s]) => new Promise<Shake>((resolve) => {
    const e = window.tidal!;
    const cx = window.screenX, cy = window.screenY;
    const out: Shake = { energy: [], impact: [], ml0: e.ml, ml1: 0, moves: 0 };
    const t0 = performance.now();
    const mover = setInterval(() => { const t = (performance.now() - t0) / 1000; window.moveTo(Math.round(cx + a! * Math.sin(2 * Math.PI * f! * t)), cy); out.moves++; }, 8);
    const frame = (): void => {
      const m = e.meta;
      if (m) { out.energy.push(m.energy[e.slot] ?? 0); out.impact.push(m.impact[e.slot] ?? 0); }
      if (performance.now() - t0 < s! * 1000) requestAnimationFrame(frame);
      else { clearInterval(mover); window.moveTo(cx, cy); out.ml1 = e.ml; resolve(out); }
    };
    requestAnimationFrame(frame);
  }), [amp, hz, seconds] as const);
}

test('slosh: a violent shake carries far more energy and impact than a gentle one', async ({ lab }) => {
  test.setTimeout(120_000);
  const w = await lab.world({ popups: 1, popupSize: POP });
  const pop = w.popups[0]!;
  // fill the popup from main, then park it alone in the middle of the display, away from every wall of main
  const layout = await layoutRow(w, { gapMain: 0, popupSize: POP });
  await sleep(6000);
  const d = await displayOf(pop);
  await setRect(pop, { x: d.left + d.w / 2 + 100, y: layout.popups[0]!.y, ...POP });
  await calibrate(pop);
  await sleep(6000);
  const slot = await pop.evaluate(() => window.tidal!.slot);
  const held = await pop.evaluate(() => window.tidal!.ml);
  console.log(`popup slot ${slot} holds ${fmt(held, 1)} mL before shaking`);
  expect(held, 'popup holds water').toBeGreaterThan(60);
  const rest = await pop.evaluate(() => window.tidal!.meta!.energy[window.tidal!.slot] ?? 0);

  const gentle = await shake(pop, 40, 1.5, 3);
  await sleep(6000);
  const settled = await pop.evaluate(() => window.tidal!.meta!.energy[window.tidal!.slot] ?? 0);
  const violent = await shake(pop, 120, 3, 3);
  await sleep(1500);
  const total = (await readTotals(w.main)).total;

  const stat = (s: Shake) => ({ peakE: Math.max(...s.energy), meanE: mean(s.energy), peakI: Math.max(...s.impact), meanI: mean(s.impact) });
  const g = stat(gentle), v = stat(violent);
  console.log(`energy at rest ${rest.toExponential(2)}, after settle ${settled.toExponential(2)}; ${gentle.moves}/${violent.moves} moveTo calls`);
  console.log(`gentle  (40 px, 1.5 Hz): peak energy ${g.peakE.toExponential(3)}, mean ${g.meanE.toExponential(3)}, peak impact ${g.peakI.toFixed(3)}, mean impact ${g.meanI.toFixed(4)}, ml ${fmt(gentle.ml0)} -> ${fmt(gentle.ml1)}`);
  console.log(`violent (120 px, 3 Hz): peak energy ${v.peakE.toExponential(3)}, mean ${v.meanE.toExponential(3)}, peak impact ${v.peakI.toFixed(3)}, mean impact ${v.meanI.toFixed(4)}, ml ${fmt(violent.ml0)} -> ${fmt(violent.ml1)}`);
  console.log(`ratio violent/gentle: peak energy ${fmt(v.peakE / g.peakE)}x, mean energy ${fmt(v.meanE / g.meanE)}x, peak impact ${fmt(v.peakI / g.peakI)}x; total ${fmt(total, 2)} mL`);

  expect(v.peakE / g.peakE, 'peak energy ratio').toBeGreaterThanOrEqual(2);
  expect(v.meanE / g.meanE, 'mean energy ratio').toBeGreaterThanOrEqual(2);
  expect(v.peakI, 'peak impact higher for the violent shake').toBeGreaterThan(g.peakI);
  expect(Math.abs(total - 1000) / 1000).toBeLessThanOrEqual(0.005);
});
