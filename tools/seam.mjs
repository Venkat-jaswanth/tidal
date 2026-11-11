// Seam check: two popup vessels placed edge to edge on one display. Reports the computed gap between
// their content rectangles (estimate and pointer-calibrated) and saves a stitched screenshot, so the
// world-anchored grid can be inspected across the seam.
// node tools/seam.mjs <outDir>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
const dir = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
const pops = [];
for (let i = 0; i < 2; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open(location.href, 'v' + Math.random(), 'popup,width=400,height=300'); })]);
  await p.waitForFunction(() => window.tidal?.stats.fps > 0, null, { timeout: 20000 });
  pops.push(p);
}
const [a, b] = pops;
const rows = [];
for (const [dx, dy] of [[80, 120], [240, 260], [420, 180]]) {
  // both on the display the first popup is on, addressed from that display's work area
  const base = await a.evaluate(() => ({ left: screen.availLeft ?? 0, top: screen.availTop ?? 0 }));
  await a.evaluate(([x, y]) => { window.resizeTo(400, 367); window.moveTo(x, y); }, [base.left + dx, base.top + dy]);
  await a.waitForTimeout(250);
  const A = await a.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight }));
  await b.evaluate(([x, y]) => { window.resizeTo(400, 367); window.moveTo(x, y); }, [A.sx + A.ow, A.sy]);
  await b.waitForTimeout(250);
  // a pointer event in each, for exact calibration
  await a.mouse.move(100, 100); await b.mouse.move(100, 100);
  await a.waitForTimeout(150);
  const get = (p) => p.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, cal: window.tidal.calibrator.cal, rect: window.tidal.calibrator.rect(), est: { dx: (outerWidth - innerWidth) / 2, dy: outerHeight - innerHeight - (outerWidth - innerWidth) / 2 }, screen: { w: screen.width, left: screen.availLeft, top: screen.availTop } }));
  const ra = await get(a), rb = await get(b);
  rows.push({
    aOuter: [ra.sx, ra.sy, ra.ow, ra.oh], bOuter: [rb.sx, rb.sy, rb.ow, rb.oh],
    sameDisplay: ra.screen.left === rb.screen.left && ra.screen.top === rb.screen.top, dpr: [ra.dpr, rb.dpr],
    calA: ra.cal, calB: rb.cal, estA: ra.est, estB: rb.est,
    gapCalibratedPx: rb.rect.x - (ra.rect.x + ra.rect.w), gapEstimatePx: (rb.sx + rb.est.dx) - (ra.sx + ra.est.dx + ra.iw),
    contentTopDeltaPx: rb.rect.y - ra.rect.y,
  });
}
for (const r of rows) console.log(JSON.stringify(r));
if (dir) {
  await a.waitForTimeout(3000);
  await a.screenshot({ path: `${dir}/seam-a.png` }); await b.screenshot({ path: `${dir}/seam-b.png` });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${dir}/seam-a.png`, '-i', `${dir}/seam-b.png`, '-filter_complex', 'hstack', `${dir}/seam.png`]);
  console.log('stitched', `${dir}/seam.png`);
}
await browser.close();
