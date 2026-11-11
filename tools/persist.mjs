// Closes the only window and reopens it: the saved liquid should pour back in.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=800,600', '--window-position=60,80'] });
const context = await browser.newContext({ viewport: null });
let page = await context.newPage();
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
await page.waitForTimeout(4500);
console.log('first visit', JSON.stringify(await page.evaluate(() => ({ restored: window.tidal.restored, ml: Math.round(window.tidal.ml) }))));
await page.close();
page = await context.newPage();
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const samples = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(500);
  samples.push(await page.evaluate(() => ({ inVessel: Math.round(window.tidal.ml), rain: Math.round(window.tidal.meta?.rainMl ?? 0) })));
}
console.log('second visit', JSON.stringify(await page.evaluate(() => ({ restored: window.tidal.restored }))), JSON.stringify(samples));
if (process.argv[2]) { await page.screenshot({ path: process.argv[2] }); }
await browser.close();
