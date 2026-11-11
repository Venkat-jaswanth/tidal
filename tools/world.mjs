// Opens the app with N popups laid out side by side and prints each window's state.
// node tools/world.mjs [popups=2] [seconds=6] [screenshotDir]
import { chromium } from '@playwright/test';
const popups = Number(process.argv[2] ?? 2), secs = Number(process.argv[3] ?? 6), dir = process.argv[4];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=700,560', '--window-position=40,80'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
const errors = [];
const watch = (p, name) => { p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); }); p.on('pageerror', (e) => errors.push(`${name}: ${e}`)); };
watch(page, 'main');
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const pages = [page];
for (let i = 0; i < popups; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.click('#add')]);
  watch(p, 'popup' + i);
  await p.waitForLoadState();
  pages.push(p);
}
// lay the popups out touching the main window's right edge, bottoms aligned
await page.waitForTimeout(800);
const main = await page.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
let x = main.x + main.w;
for (const p of pages.slice(1)) {
  await p.evaluate(([x, y]) => { window.moveTo(x, y); }, [x, main.y + main.h - 400]);
  await p.evaluate(() => window.resizeTo(420, 400));
  x += 420;
}
await page.waitForTimeout(secs * 1000);
for (const [i, p] of pages.entries()) {
  const s = await p.evaluate(() => {
    const e = window.tidal;
    return { slot: e.slot, leader: e.isLeader, ml: Math.round(e.ml), group: e.transport.group, cal: e.calibrator.cal, rect: e.calibrator.rect(), fps: Math.round(e.stats.fps), worst: Math.round(e.stats.worstFrameMs), simGpuMs: e.stats.simGpuMs, title: document.title, peers: e.registry.peers.size };
  });
  console.log(i === 0 ? 'main ' : `popup${i - 1}`, JSON.stringify(s));
  if (dir) await p.screenshot({ path: `${dir}/world-${i}.png` });
}
const ml = await page.evaluate(() => window.tidal.meta?.ml.reduce((a, b) => a + b, 0) + (window.tidal.meta?.rainMl ?? 0));
console.log('total ml', ml);
if (errors.length) console.log('ERRORS\n' + errors.slice(0, 10).join('\n'));
await browser.close();
