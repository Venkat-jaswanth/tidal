// Closing a vessel that holds water: its liquid falls as rain into the vessels that remain.

import { calibrate, deviation, expect, fmt, layoutRow, readTotals, recordMeta, sleep, slotOf, test } from '../helpers';

test('rain: closing a popup that holds water moves its volume to the others', async ({ lab }) => {
  test.setTimeout(90_000);
  const w = await lab.world({ popups: 2 });
  await layoutRow(w, { gapMain: 0, gapPopups: 0, alignBottom: true });
  for (const p of w.all) await calibrate(p);
  await sleep(7000);
  const victim = w.popups[0]!;
  const keeper = w.popups[1]!;
  const slot = await slotOf(victim);
  const before = await readTotals(w.main);
  console.log(`before close: slot ${slot} holds ${fmt(before.ml[slot]!, 1)} mL; per slot ${before.ml.slice(0, 3).map((x) => fmt(x, 1)).join(' / ')}`);
  expect(before.ml[slot]!, 'the popup holds water').toBeGreaterThan(50);

  const recording = recordMeta(w.main, 4500);
  const t0 = Date.now();
  await victim.close();
  console.log(`popup closed after ${Date.now() - t0} ms`);
  const samples = await recording;

  const maxRain = Math.max(...samples.map((s) => s.rainMl));
  const worst = Math.max(...samples.map((s) => deviation(s.total)));
  const firstZero = samples.find((s) => s.ml[slot]! < 0.5);
  const at3 = samples.filter((s) => s.t >= 3000)[0]!;
  const last = samples[samples.length - 1]!;
  console.log(`${samples.length} frames recorded; max rain ${fmt(maxRain, 1)} mL; worst total deviation ${fmt(worst * 100, 4)} %`);
  console.log(`closed slot volume reached <0.5 mL at ${firstZero ? fmt(firstZero.t / 1000, 2) + ' s' : 'never'} (relative to recording start); at 3 s: slot ${fmt(at3.ml[slot]!, 2)} mL, rain ${fmt(at3.rainMl, 1)} mL`);
  const keepSlot = await slotOf(keeper);
  console.log(`end: main ${fmt(last.ml[0]!, 1)}, keeper(slot ${keepSlot}) ${fmt(last.ml[keepSlot]!, 1)}, closed ${fmt(last.ml[slot]!, 2)}, rain ${fmt(last.rainMl, 2)}`);

  expect(maxRain, 'rain fell at some sample').toBeGreaterThan(0);
  expect(worst, 'total stays 1000 within 0.5 % at every sample').toBeLessThanOrEqual(0.005);
  expect(at3.ml[slot]!, 'closed slot is empty by 3 s').toBeLessThan(0.5);
  expect(at3.rainMl, 'rain has landed by 3 s').toBeLessThan(5);
  const remaining = at3.ml.reduce((a, b, i) => (i === slot ? a : a + b), 0);
  expect(remaining + at3.rainMl, 'all water is in the remaining vessels or still falling').toBeGreaterThan(995);
  expect(last.ml[slot]!, 'closed slot ends at 0').toBe(0);
});
