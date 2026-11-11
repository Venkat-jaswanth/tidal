// node spikes/look/shot.mjs <out.png> "<query>" <seconds> [width height]
import { chromium } from '@playwright/test';
const [out, query, secs, w = '900', h = '650'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: [`--window-size=${w},${Number(h) + 90}`, '--window-position=60,60'] });
const page = await (await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5173/spikes/look/index.html?' + query);
await page.waitForFunction((s) => window.__look && (window.__look.t >= s || window.__look.error), Number(secs), { timeout: 60000 });
await page.screenshot({ path: out });
console.log(out, JSON.stringify(await page.evaluate(() => window.__look)), errors.slice(0, 5).join(' | '));
await browser.close();
