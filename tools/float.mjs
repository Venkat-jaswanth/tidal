// Opens the floating picture-in-picture tank, drags it against the main vessel and reports volumes.
// node tools/float.mjs [screenshotDir]
import { chromium } from '@playwright/test';
const dir = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: [] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto((process.env.TIDAL_URL ?? 'http://localhost:5174/'));
await page.evaluate(() => { window.moveTo(60, 120); window.resizeTo(700, 560); });
await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  document.addEventListener('click', async () => {
    const { openFloat } = await import('/src/pip/float.ts');
    try { window.__float = await openFloat(window.tidal, () => {}, () => { window.__floatClosed = true; }); } catch (e) { window.__floatError = String(e); }
  }, { once: true, capture: true });
});
const [pip] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }).catch(() => null), page.mouse.click(350, 300)]);
await page.waitForFunction(() => window.__float || window.__floatError, null, { timeout: 10000 });
console.log('opened', JSON.stringify(await page.evaluate(() => ({ error: window.__floatError ?? null, slot: window.__float?.view.info.slot, rect: window.__float && (({ x, y, w, h }) => ({ x, y, w, h }))(window.__float.view.info), isPage: null }))), 'playwright page:', !!pip);
const read = () => page.evaluate(() => ({ main: Math.round(window.tidal.ml), pip: Math.round(window.__float.view.ml), total: Math.round(window.tidal.meta.ml.reduce((a, b) => a + b, 0) + window.tidal.meta.rainMl), pipRect: (({ x, y, w, h }) => ({ x, y, w, h }))(window.__float.view.info) }));
await page.waitForTimeout(1000);
console.log('apart   ', JSON.stringify(await read()));
if (pip) {
  // drag the tank so its left edge touches the main vessel's right edge, bottoms level
  const cdp = await context.newCDPSession(pip);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const m = await page.evaluate(() => ({ x: screenX, y: screenY, w: outerWidth, h: outerHeight }));
  const steps = 30;
  const from = await pip.evaluate(() => ({ x: screenX, y: screenY, h: outerHeight }));
  const to = { x: m.x + m.w, y: m.y + m.h - from.h };
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: Math.round(from.x + (to.x - from.x) * i / steps), top: Math.round(from.y + (to.y - from.y) * i / steps) } });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(4000);
  console.log('touching', JSON.stringify(await read()));
  if (dir) { await pip.screenshot({ path: `${dir}/float-pip.png` }); await page.screenshot({ path: `${dir}/float-main.png` }); }
  // shake it: liquid should slosh, volume stay conserved
  for (let i = 0; i < 40; i++) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: to.x + Math.round(40 * Math.sin(i * 0.8)), top: to.y } });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500);
  console.log('shaken  ', JSON.stringify(await read()));
  await page.evaluate(() => window.__float.close());
  await page.waitForTimeout(2500);
  console.log('closed  ', JSON.stringify(await page.evaluate(() => ({ closed: window.__floatClosed, ml: window.tidal.meta.ml.slice(0, 4).map(Math.round), rain: Math.round(window.tidal.meta.rainMl), frame: window.tidal.meta.frame, leader: window.tidal.isLeader, main: Math.round(window.tidal.ml), total: Math.round(window.tidal.meta.ml.reduce((a, b) => a + b, 0) + window.tidal.meta.rainMl), vessels: window.tidal.registry.all().length }))));
}
if (errors.length) console.log('ERRORS\n' + errors.slice(0, 8).join('\n'));
await browser.close();
