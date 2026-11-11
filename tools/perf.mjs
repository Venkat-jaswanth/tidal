// Performance of a three-window world on a chosen display.
// node tools/perf.mjs [windowX,windowY] [seconds=20] [query]
// Example for a display above the main one: node tools/perf.mjs 100,-900
import { chromium } from '@playwright/test';
const [wx, wy] = (process.argv[2] ?? '60,80').split(',').map(Number);
const secs = Number(process.argv[3] ?? 20);
const query = process.argv[4] ?? '';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: [`--window-position=${wx},${wy}`, '--window-size=760,640'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/') + query);
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const pages = [page];
for (let i = 0; i < 2; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open(location.href, 'v' + Math.random(), 'popup,width=420,height=360'); })]);
  await p.waitForFunction(() => window.tidal?.stats.fps > 0, null, { timeout: 20000 });
  pages.push(p);
}
// main, then the two popups touching in a row, bottoms level, all on the display the main window is on
const m = await page.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, left: screen.availLeft, top: screen.availTop, sw: screen.availWidth, sh: screen.availHeight, dpr: devicePixelRatio }));
let x = m.x + m.w;
for (const p of pages.slice(1)) { await p.evaluate(([x, y]) => { window.resizeTo(420, 427); window.moveTo(x, y); }, [x, m.y + m.h - 427]); x += 420; }
await page.waitForTimeout(5000);
for (const p of pages) await p.evaluate(() => {
  const s = (window.__perf = { gaps: [], sim: [], render: [], sub: [], last: 0, on: true });
  const tick = (now) => { if (!s.on) return; if (s.last) s.gaps.push(now - s.last); s.last = now; const st = window.tidal.stats; if (st.simGpuMs != null && window.tidal.isLeader) s.sim.push(st.simGpuMs); if (st.renderGpuMs != null) s.render.push(st.renderGpuMs); s.sub.push(st.substeps); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
// gently move the last popup back and forth so water keeps flowing
const last = pages[2];
const base = await last.evaluate(() => ({ x: screenX, y: screenY }));
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  const t = (Date.now() - t0) / 1000;
  await last.evaluate(([x, y]) => window.moveTo(x, y), [Math.round(base.x + 30 * Math.sin(t * 2.2)), base.y]);
  await page.waitForTimeout(16);
}
console.log(`display: ${m.sw}x${m.sh} at ${m.left},${m.top}, dpr ${m.dpr}; ${secs} s; query "${query}"`);
console.log('window  | leader | fps p50 | fps p95 | worst ms | sim GPU p50/p95 ms | render GPU p50/p95 ms | substeps | particles | tier');
for (const [i, p] of pages.entries()) {
  const r = await p.evaluate(() => {
    const s = window.__perf; s.on = false;
    const q = (a, f) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] : null;
    const f1 = (v) => (v == null ? '-' : v.toFixed(2));
    return { leader: window.tidal.isLeader, fps50: (1000 / q(s.gaps, 0.5)).toFixed(1), fps95: (1000 / q(s.gaps, 0.95)).toFixed(1), worst: Math.max(...s.gaps).toFixed(0), sim: `${f1(q(s.sim, 0.5))} / ${f1(q(s.sim, 0.95))}`, render: `${f1(q(s.render, 0.5))} / ${f1(q(s.render, 0.95))}`, sub: q(s.sub, 0.5), particles: window.tidal.stats.particles, tier: window.tidal.stats.tier, total: window.tidal.meta.ml.reduce((a, b) => a + b, 0) + window.tidal.meta.rainMl };
  });
  console.log(`${i === 0 ? 'main   ' : 'popup ' + i} | ${r.leader ? 'yes' : 'no '}    | ${r.fps50}   | ${r.fps95}   | ${r.worst}       | ${r.sim}        | ${r.render}           | ${r.sub}       | ${r.particles}    | ${r.tier}   (total ${r.total.toFixed(1)} mL)`);
}
await browser.close();
