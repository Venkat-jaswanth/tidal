import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--auto-accept-this-tab-capture', '--window-size=800,600', '--window-position=80,80'] });
const page = await (await browser.newContext({ viewport: null })).newPage();
await page.goto('http://localhost:5173/spikes/s7-capture/index.html');
for (const kind of ['tab', 'canvas']) {
  await page.evaluate((k) => { window.__kind = k; window.__out = null; }, kind);
  await page.click('#go');
  await page.waitForFunction(() => window.__out, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.__out);
  if (r.error) { console.log(kind, 'ERROR', r.error); continue; }
  const ext = r.mime.includes('mp4') ? 'mp4' : 'webm';
  writeFileSync(`${out}/s7-${kind}.${ext}`, Buffer.from(r.b64, 'base64'));
  console.log(kind, r.mime, JSON.stringify(r.settings), r.bytes, `${out}/s7-${kind}.${ext}`);
}
await browser.close();
