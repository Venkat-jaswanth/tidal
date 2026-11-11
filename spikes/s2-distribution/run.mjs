import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=900,420', '--window-position=60,60'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto('http://localhost:5173/spikes/s2-distribution/index.html');
const followers = [];
for (let i = 0; i < 3; i++) {
  const [p] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
  followers.push(p);
  await p.waitForLoadState();
}
await page.waitForTimeout(8000);
console.log('LEADER', JSON.stringify(await page.evaluate(() => window.__report())));
for (const [i, f] of followers.entries()) console.log('FOLLOWER', i, JSON.stringify(await f.evaluate(() => window.__report())));
// a tab opened by URL (not by window.open) is in another browsing context group: can it get the SAB?
const stranger = await context.newPage();
await stranger.goto('http://localhost:5173/spikes/s2-distribution/index.html?role=follower');
await stranger.waitForTimeout(3000);
console.log('SEPARATE TAB', JSON.stringify(await stranger.evaluate(() => window.__report())));
console.log('SAB over BroadcastChannel:', await page.evaluate(() => { try { new BroadcastChannel('x').postMessage(new SharedArrayBuffer(8)); return 'no throw'; } catch (e) { return String(e); } }));
await browser.close();
