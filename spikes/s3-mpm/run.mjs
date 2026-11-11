// node spikes/s3-mpm/run.mjs [query] [screenshotPath]
import { chromium } from '@playwright/test';
const query = process.argv[2] ?? 'scenario=fling';
const shot = process.argv[3];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1540,1000', '--window-position=40,40'] });
const page = await (await browser.newContext({ viewport: null })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/') + 'spikes/s3-mpm/index.html?' + query);
const shots = (process.argv[4] ?? '').split(',').filter(Boolean).map(Number);
const t0 = Date.now();
for (const s of shots) {
  await page.waitForTimeout(Math.max(0, s * 1000 - (Date.now() - t0)));
  await page.screenshot({ path: shot.replace('.png', `-${s}.png`) });
}
await page.waitForFunction(() => window.__s3?.done, null, { timeout: 90000 }).catch(() => errors.push('timeout'));
const out = await page.evaluate(() => {
  const s = window.__s3;
  const phases = {};
  for (const x of s.samples) {
    const p = (phases[x.phase] ??= { frames: 0, minTotal: Infinity, maxTotal: -Infinity, blowUps: 0, gpu: [] });
    p.frames++; p.minTotal = Math.min(p.minTotal, x.total + x.rain); p.maxTotal = Math.max(p.maxTotal, x.total + x.rain);
    p.blowUps += x.blowUps; if (x.gpuMs !== null) p.gpu.push(x.gpuMs);
  }
  for (const p of Object.values(phases)) { p.gpu.sort((a, b) => a - b); p.gpuP50 = p.gpu[p.gpu.length >> 1]; p.gpuP95 = p.gpu[Math.floor(p.gpu.length * 0.95)]; delete p.gpu; }
  return { summary: s.summary, error: s.error, phases };
});
if (shot) await page.screenshot({ path: shot });
console.log(JSON.stringify(out, null, 1));
if (errors.length) console.log('CONSOLE:', errors.slice(0, 12).join('\n'));
await browser.close();
