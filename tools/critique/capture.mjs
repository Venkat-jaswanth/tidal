// Captures the key states of a single vessel for a design critique.
// node tools/critique/capture.mjs <outDir> [light|dark]
import { chromium } from '@playwright/test';
const out = process.argv[2];
const scheme = process.argv[3] ?? 'light';
const url = process.env.TIDAL_URL ?? 'http://localhost:5174/';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=920,760'] });
async function open() {
  const context = await browser.newContext({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.tidal?.stats.particles > 0, null, { timeout: 20000 });
  return { context, page };
}
const kick = (page, x, y) => page.evaluate(([x, y]) => window.tidal.command({ type: 'cmd', cmd: 'impulse', x, y }), [x, y]);
const liquid = (page, id) => page.evaluate((id) => window.tidal.command({ type: 'cmd', cmd: 'liquid', value: id }), id);

{ // rest and a slosh, as a strip of frames
  const { context, page } = await open();
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `${out}/${scheme}-rest.png` });
  for (let i = 0; i < 7; i++) { await kick(page, 1, -0.15); await page.waitForTimeout(100); }
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(150); await page.screenshot({ path: `${out}/${scheme}-slosh-${i}.png` }); }
  await context.close();
}
if (scheme === 'light') {
  for (const id of ['ink', 'mercury', 'honey']) {
    const { context, page } = await open();
    await page.waitForTimeout(2500);
    await liquid(page, id);
    await page.waitForTimeout(2500);
    if (id === 'ink') { // two inks need two bodies: recolour half by hand through a second vessel is not available here, so just slosh
    }
    for (let i = 0; i < 6; i++) { await kick(page, -1, -0.15); await page.waitForTimeout(100); }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${scheme}-${id}-slosh.png` });
    await page.waitForTimeout(12000);
    await page.screenshot({ path: `${out}/${scheme}-${id}-rest.png` });
    await context.close();
  }
}
await browser.close();
console.log('captured to', out);
