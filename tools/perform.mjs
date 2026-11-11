// Runs the Perform choreography with three popup vessels and reports motion, frame rate and volume.
// node tools/perform.mjs [screenshotDir]
import { chromium } from '@playwright/test';
const dir = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
const errors = [];
const watch = (p, name) => { p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); }); p.on('pageerror', (e) => errors.push(`${name}: ${e}`)); };
watch(page, 'main');
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const popups = [];
for (let i = 0; i < 3; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open(location.href, 'v' + Math.random(), 'popup,width=330,height=263,left=200,top=200'); })]);
  watch(p, 'popup' + i);
  await p.waitForFunction(() => window.tidal?.stats.fps > 0, null, { timeout: 20000 });
  popups.push(p);
}
const all = [page, ...popups];
for (const p of all) await p.waitForFunction(() => window.tidalApp);
for (const p of all) await p.evaluate(async () => {
  window.__performer = window.tidalApp.performer;
  window.__frames = { n: 0, worst: 0, last: 0, gaps: [] };
  const tick = (now) => { const f = window.__frames; if (f.last && window.__performer.performing) { const d = now - f.last; f.n++; f.gaps.push(d); if (d > f.worst) f.worst = d; } f.last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(1500);
const count = await page.evaluate(() => window.__performer.start());
console.log('performing with', count, 'vessels; stage', JSON.stringify(await page.evaluate(() => ({ w: screen.availWidth, h: screen.availHeight, left: screen.availLeft, top: screen.availTop }))));
const samples = [];
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({ ml: window.tidal.meta?.ml.slice(0, 5).map(Math.round), rain: Math.round(window.tidal.meta?.rainMl ?? 0), total: Math.round((window.tidal.meta?.ml.reduce((a, b) => a + b, 0) ?? 0) + (window.tidal.meta?.rainMl ?? 0)), performing: window.__performer.performing }));
  samples.push(s);
  if (dir && [5, 13, 21, 27].includes(i)) for (const [k, p] of popups.entries()) await p.screenshot({ path: `${dir}/perform-${i}-${k}.png` }).catch(() => {});
}
console.log('volume by slot every 2 s:');
samples.filter((_, i) => i % 4 === 3).forEach((s, i) => console.log(`  t=${(i + 1) * 2}s`, JSON.stringify(s)));
console.log('total min/max', Math.min(...samples.map((s) => s.total)), Math.max(...samples.map((s) => s.total)));
for (const [i, p] of popups.entries()) {
  const r = await p.evaluate(() => {
    const f = window.__frames; const g = f.gaps.slice().sort((a, b) => a - b);
    const m = window.__performer.moveStats;
    const mg = m.movingGapsMs.slice().sort((a, b) => a - b);
    return { moves: m.moves, moveHzMedian: Math.round(1000 / mg[mg.length >> 1]), moveHzP5: Math.round(1000 / mg[Math.floor(mg.length * 0.95)]), worstMoveGapMs: Math.round(mg[mg.length - 1]), fps: Math.round(1000 * f.n / g.reduce((a, b) => a + b, 0)), frameMsP50: Math.round(g[g.length >> 1] * 10) / 10, frameMsP95: Math.round(g[Math.floor(g.length * 0.95)] * 10) / 10, worstFrameMs: Math.round(f.worst), leader: window.tidal.isLeader, end: { x: screenX, y: screenY, w: outerWidth, h: outerHeight } };
  });
  console.log('popup' + i, JSON.stringify(r));
}
console.log('main', JSON.stringify(await page.evaluate(() => ({ leader: window.tidal.isLeader, active: window.tidal.registry.self.active, simGpuMs: window.tidal.stats.simGpuMs }))));
if (errors.length) console.log('ERRORS\n' + errors.slice(0, 8).join('\n'));
await browser.close();
