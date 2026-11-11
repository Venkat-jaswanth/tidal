// Closes the leader window and measures how the remaining windows cope.
// node tools/handoff.mjs [screenshotDir]
import { chromium } from '@playwright/test';
const dir = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=700,560', '--window-position=40,80'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
const errors = [];
const watch = (p, name) => { p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); }); p.on('pageerror', (e) => errors.push(`${name}: ${e}`)); };
watch(page, 'main');
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const popups = [];
for (let i = 0; i < 2; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.click('#add')]);
  watch(p, 'popup' + i);
  await p.waitForLoadState();
  popups.push(p);
}
await page.waitForTimeout(800);
const main = await page.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
await popups[0].evaluate(([x, y]) => { window.moveTo(x, y); window.resizeTo(380, 400); }, [main.x + main.w, main.y + main.h - 400]);
await popups[1].evaluate(([x, y]) => { window.moveTo(x, y); window.resizeTo(380, 300); }, [main.x + 100, main.y + main.h + 40]);
await page.waitForTimeout(5000);
const before = await page.evaluate(() => ({ ml: window.tidal.meta.ml.slice(0, 4).map(Math.round), rain: window.tidal.meta.rainMl, leader: window.tidal.isLeader }));
console.log('before close', JSON.stringify(before));
// record frame gaps and the field's liquid mass in each popup across the handoff
for (const p of popups) await p.evaluate(() => {
  const g = (window.__gaps = { worst: 0, last: performance.now(), frames: 0, t0: performance.now(), lastFrame: window.tidal.meta?.frame ?? 0, frameJumps: [] });
  const tick = (now) => { const d = now - g.last; if (d > g.worst) g.worst = d; g.last = now; g.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(500);
await page.close();
await popups[0].waitForTimeout(4000);
for (const [i, p] of popups.entries()) {
  const s = await p.evaluate(() => ({ leader: window.tidal.isLeader, slot: window.tidal.slot, ml: window.tidal.meta.ml.slice(0, 4).map(Math.round), rainMl: Math.round(window.tidal.meta.rainMl), total: Math.round(window.tidal.meta.ml.reduce((a, b) => a + b, 0) + window.tidal.meta.rainMl), worstGapMs: Math.round(window.__gaps.worst * 10) / 10, fps: Math.round(window.tidal.stats.fps), peers: window.tidal.registry.peers.size }));
  console.log('popup' + i, JSON.stringify(s));
  if (dir) await p.screenshot({ path: `${dir}/handoff-${i}.png` });
}
if (errors.length) console.log('ERRORS\n' + errors.slice(0, 10).join('\n'));
await browser.close();
