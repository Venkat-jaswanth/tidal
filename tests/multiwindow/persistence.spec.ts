// The world is saved to IndexedDB and poured back in as rain on the next visit within the same browser profile.

import { APP_URL, deviation, expect, fmt, recordMeta, sleep, test, waitForSettledTotal } from '../helpers';

test('persistence: a reload in the same context restores the world as rain', async ({ lab }) => {
  test.setTimeout(90_000);
  const context = await lab.context();
  let page = await context.newPage();
  lab.watch(page, 'visit1');
  await page.goto(APP_URL);
  await page.waitForFunction(() => (window.tidal?.stats.particles ?? 0) > 0, null, { timeout: 30_000 });
  const first = await page.evaluate(() => ({ restored: window.tidal!.restored, ml: window.tidal!.ml }));
  console.log('first visit:', JSON.stringify(first));
  expect(first.restored, 'restored on first visit').toBe(false);
  await sleep(5000); // the leader saves a snapshot every couple of seconds
  await page.close();

  page = await context.newPage();
  lab.watch(page, 'visit2');
  await page.goto(APP_URL);
  await page.waitForFunction(() => window.tidal?.meta != null, null, { timeout: 30_000 });
  const samples = await recordMeta(page, 6000);
  const second = await page.evaluate(() => ({ restored: window.tidal!.restored }));
  const maxRain = Math.max(...samples.map((s) => s.rainMl));
  const firstRain = samples.find((s) => s.rainMl > 1);
  const calm = samples.find((s) => s.rainMl < 1 && s.t > 500);
  console.log(`second visit: restored ${second.restored}; max rain ${fmt(maxRain, 1)} mL; rain first seen at ${firstRain ? fmt(firstRain.t / 1000, 2) : 'never'} s; rain below 1 mL from ${calm ? fmt(calm.t / 1000, 2) : 'never'} s`);
  console.log('  rain / vessel at 0.0 0.5 1.0 2.0 s:', [0, 500, 1000, 2000].map((t) => { const s = samples.find((x) => x.t >= t); return s ? `${fmt(s.rainMl, 0)}/${fmt(s.ml[0]!, 0)}` : '-'; }).join('  '));
  expect(second.restored, 'restored on second visit').toBe(true);
  expect(maxRain, 'rain appears while the world pours back in').toBeGreaterThan(50);
  await waitForSettledTotal(page, 15_000);
  const end = samples[samples.length - 1]!;
  expect(deviation(end.total)).toBeLessThanOrEqual(0.005);
  const final = await page.evaluate(() => { const m = window.tidal!.meta!; return m.ml.reduce((a, b) => a + b, 0) + m.rainMl; });
  console.log('total after rain:', fmt(final, 2));
  expect(deviation(final)).toBeLessThanOrEqual(0.005);
});
