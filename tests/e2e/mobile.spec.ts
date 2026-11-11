// Pocket mode on a phone: tilt steers gravity. Chromium runs a Pixel 7 emulation with CDP virtual sensors;
// WebKit runs an iPhone emulation and must load into either the app or the fallback.

import { devices, webkit } from '@playwright/test';
import { deviation, expect, fmt, readTotals, sleep, test } from '../helpers';

const BASE = process.env.TIDAL_URL ?? 'http://localhost:5174';

/** Unit quaternion of a deviceorientation reading, as the virtual 'relative-orientation' sensor wants it (see spikes/s8-tilt). */
function quaternion(alpha: number, beta: number, gamma: number): { w: number; x: number; y: number; z: number } {
  const d = Math.PI / 180;
  const h = (v: number): [number, number] => [Math.cos((v * d) / 2), Math.sin((v * d) / 2)];
  const [cz, sz] = h(alpha), [cx, sx] = h(beta), [cy, sy] = h(gamma);
  type Q = { w: number; x: number; y: number; z: number };
  const mul = (a: Q, b: Q): Q => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  return mul(mul({ w: cz, x: 0, y: 0, z: sz }, { w: cx, x: sx, y: 0, z: 0 }), { w: cy, x: 0, y: sy, z: 0 });
}

test.describe('mobile', () => {
  test('pocket mode: tilt (CDP virtual sensors) steers gravity', async ({ lab }) => {
    test.setTimeout(90_000);
    const context = await lab.context({ ...devices['Pixel 7'] });
    const page = await context.newPage();
    lab.watch(page, 'pixel7');
    await page.goto('/');
    await page.waitForFunction(() => (window.tidal?.stats.particles ?? 0) > 0 && window.tidal?.meta != null, null, { timeout: 30_000 });
    const kind = await page.evaluate(() => window.tidal!.registry.self.kind);
    console.log(`Pixel 7: kind ${kind}, viewport ${JSON.stringify(page.viewportSize())}`);
    expect(kind).toBe('pocket');
    const prompt = page.getByRole('button', { name: 'Tilt to pour' });
    await expect(prompt).toBeVisible();

    // sensors must exist before the page attaches its listeners (i.e. before the tap)
    const cdp = await context.newCDPSession(page);
    for (const type of ['relative-orientation', 'absolute-orientation', 'accelerometer', 'gravity', 'linear-acceleration', 'gyroscope'] as const) {
      await cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type, metadata: { available: true } });
    }
    const tilt = (beta: number, gamma: number) => cdp.send('Emulation.setSensorOverrideReadings', { type: 'relative-orientation', reading: { quaternion: quaternion(0, beta, gamma) } });
    await tilt(0, 0);
    await page.evaluate(() => { const w = window as unknown as { __oe: number }; w.__oe = 0; addEventListener('deviceorientation', () => { w.__oe++; }); });
    await prompt.tap();
    await sleep(1200);
    const events = await page.evaluate(() => (window as unknown as { __oe: number }).__oe);
    console.log(`real deviceorientation events from the virtual sensor: ${events} (synthetic fallback not needed: ${events > 0})`);
    expect(events, 'CDP virtual sensor delivers deviceorientation').toBeGreaterThan(0);

    const gx = () => page.evaluate(() => window.tidal!.meta!.gravityX);
    const gy = () => page.evaluate(() => window.tidal!.meta!.gravityY);
    await tilt(0, 30);
    await page.waitForFunction(() => window.tidal!.meta!.gravityX > 0.3, null, { timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
    const right = { x: await gx(), y: await gy() };
    await tilt(0, -30);
    await page.waitForFunction(() => window.tidal!.meta!.gravityX < -0.3, null, { timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
    const left = { x: await gx(), y: await gy() };
    await tilt(0, 0);
    await sleep(2500);
    const t = await readTotals(page);
    console.log(`gravity tilted right (gamma +30): (${fmt(right.x, 3)}, ${fmt(right.y, 3)}); left (gamma -30): (${fmt(left.x, 3)}, ${fmt(left.y, 3)}); total ${fmt(t.total, 2)} mL, vessel ${fmt(await page.evaluate(() => window.tidal!.ml), 1)} mL`);
    expect(right.x, 'gravityX when tilted right').toBeGreaterThan(0.3);
    expect(left.x, 'gravityX when tilted left').toBeLessThan(-0.3);
    expect(deviation(t.total)).toBeLessThanOrEqual(0.005);
    expect(await page.evaluate(() => window.tidal!.ml), 'the vessel still holds the whole litre').toBeGreaterThan(995);
  });

  test('webkit on an iPhone: loads without errors into the app or the fallback', async () => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    const browser = await webkit.launch({ headless: true, channel: undefined });
    try {
      const context = await browser.newContext({ ...devices['iPhone 15'] });
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url + m.text())) errors.push(`console: ${m.text()}`); });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.goto(`${BASE}/`);
      await page.waitForFunction(() => document.documentElement.dataset.gpu === 'yes' || document.documentElement.dataset.gpu === 'no', null, { timeout: 20_000 });
      await sleep(1500);
      const s = await page.evaluate(() => ({ gpu: document.documentElement.dataset.gpu, hasNavigatorGpu: 'gpu' in navigator, canvas: document.querySelectorAll('canvas#tank').length, h1: document.querySelector('h1')?.textContent ?? null, isolated: crossOriginIsolated }));
      console.log(`webkit ${browser.version()} iPhone 15: data-gpu=${s.gpu} (${s.gpu === 'yes' ? 'APP' : 'FALLBACK'}), navigator.gpu ${s.hasNavigatorGpu}, crossOriginIsolated ${s.isolated}, canvas#tank ${s.canvas}, h1 ${JSON.stringify(s.h1)}`);
      if (errors.length) console.log('errors:\n  ' + errors.join('\n  '));
      expect(['yes', 'no']).toContain(s.gpu);
      if (s.gpu === 'no') expect(s.h1).toContain('Water that lives');
      else expect(s.canvas).toBe(1);
      expect(errors, 'console errors').toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
