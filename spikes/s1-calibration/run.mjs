import { chromium } from '@playwright/test';
import fs from 'node:fs';
const PAGE_URL = 'http://localhost:5173/spikes/s1-calibration/index.html';
const out = {};
const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const context = await browser.newContext({ viewport: null });
  const bs = await browser.newBrowserCDPSession();
  try { await bs.send('Browser.setPermission', { permission: { name: 'window-management' }, setting: 'granted', origin: 'http://localhost:5173' }); await bs.send('Browser.grantPermissions', { permissions: ['windowManagement'], origin: 'http://localhost:5173' }); } catch (e) { console.log('grant fail', String(e)); }
  await context.route('**/@vite/client', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const page = await context.newPage();
  page.on('framenavigated', f => console.log('NAV', f.url())); page.on('crash', () => console.log('CRASH')); page.on('console', m => 0);
  await page.goto(PAGE_URL);
  console.log('ua', await page.evaluate(() => navigator.userAgent));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function open(id) {
    const [p] = await Promise.all([context.waitForEvent('page'), page.click(id)]);
    await p.waitForLoadState();
    return p;
  }
  async function measure(p, label) {
    // two mouse moves at different client positions; calibrate from each
    const res = [];
    for (const [x, y] of [[60, 70], [140, 110], [90, 200]]) {
      await p.mouse.move(x, y, { steps: 2 });
      await sleep(80);
      res.push(await p.evaluate(() => window.probe()));
    }
    const r = res[res.length - 1];
    const row = {
      label, screenX: r.screenX, screenY: r.screenY, screenLeft: r.screenLeft, screenTop: r.screenTop,
      outer: `${r.outerWidth}x${r.outerHeight}`, inner: `${r.innerWidth}x${r.innerHeight}`, dpr: r.dpr,
      est: [r.estX, r.estY], cal: [r.calXnow, r.calYnow],
      calRepeat: res.map(q => [q.calXnow, q.calYnow]),
      diff: [r.estX - r.calXnow, r.estY - r.calYnow], mozInner: r.hasMozInner,
      lastEvt: r.last,
    };
    console.log(JSON.stringify(row));
    return row;
  }
  const rows = [];
  // popup A
  const A = await open('#open'); await sleep(500);
  rows.push(await measure(A, 'popupA initial'));
  const tab = await open('#open3'); await sleep(500);
  rows.push(await measure(tab, 'tab(window.open no popup feat) initial'));
  rows.push(await measure(page, 'playwright main window page'));
  for (const [x, y] of [[100, 100], [400, 250], [700, 80]]) {
    await page.evaluate(([x, y]) => refs.a.moveTo(x, y), [x, y]); await sleep(600);
    rows.push(await measure(A, `popupA after moveTo(${x},${y})`));
  }
  await page.evaluate(() => refs.a.resizeTo(700, 500)); await sleep(600);
  rows.push(await measure(A, 'popupA after resizeTo(700,500)'));
  await page.evaluate(() => refs.a.resizeTo(420, 330)); await sleep(600);
  rows.push(await measure(A, 'popupA after resizeTo(420,330)'));
  await page.evaluate(() => refs.t.moveTo(300, 300)); await sleep(500);
  rows.push(await measure(tab, 'tab after moveTo(300,300) [expected no-op]'));
  out.rows = rows;
  // other display attempts
  const disp = [];
  const info = await A.evaluate(() => ({ w: screen.width, h: screen.height, aL: screen.availLeft, aT: screen.availTop, ext: screen.isExtended, dpr: devicePixelRatio }));
  console.log('screen', JSON.stringify(info)); out.screenInfo = info;
  for (const [x, y] of [[info.w + 100, 100], [-900, 100], [info.w + 100, -300], [-1500, 100], [2200, 100]]) {
    await page.evaluate(([x, y]) => refs.a.moveTo(x, y), [x, y]); await sleep(900);
    const r = await A.evaluate(() => ({ sx: screenX, sy: screenY, dpr: devicePixelRatio, sw: screen.width, sh: screen.height, aL: screen.availLeft, aT: screen.availTop, ow: outerWidth, oh: outerHeight }));
    disp.push({ cmd: [x, y], ...r }); console.log('disp', JSON.stringify(disp.at(-1)));
  }
  out.disp = disp;
  // getScreenDetails availability
  out.screenDetails = await A.evaluate(async () => { try { return typeof window.getScreenDetails; } catch (e) { return String(e); } });
  // seam test
  await page.evaluate(() => refs.a.moveTo(200, 150)); await sleep(300);
  const B = await open('#open2'); await sleep(500);
  await page.evaluate(() => refs.a.moveTo(100, 150)); await sleep(500);
  await page.evaluate(() => refs.b.resizeTo(400, 300));
  const seam = [];
  for (const [ax, ay] of [[100, 150], [250, 220], [333, 187]]) {
    await page.evaluate(([x, y]) => { refs.a.moveTo(x, y); }, [ax, ay]); await sleep(500);
    const a0 = await A.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth }));
    await page.evaluate(([x, y]) => refs.b.moveTo(x, y), [a0.sx + a0.ow, a0.sy]); await sleep(600);
    const ma = await measure(A, 'seam A'); const mb = await measure(B, 'seam B');
    const aRight = ma.screenX + ma.cal[0] + ma.inner.split('x')[0] * 1;
    const bLeft = mb.screenX + mb.cal[0];
    const aTop = ma.screenY + ma.cal[1], bTop = mb.screenY + mb.cal[1];
    // also using estimate
    const aRightE = ma.screenX + ma.est[0] + +ma.inner.split('x')[0];
    const bLeftE = mb.screenX + mb.est[0];
    seam.push({ cmd: [ax, ay], Ax: ma.screenX, Aow: a0.ow, Bx: mb.screenX, By: mb.screenY, gapCal: bLeft - aRight, gapEst: bLeftE - aRightE, topDeltaCal: bTop - aTop, calA: ma.cal, calB: mb.cal, estA: ma.est, estB: mb.est });
    console.log('seam', JSON.stringify(seam.at(-1)));
  }
  out.seam = seam;
  // multi-display via Window Management API
  
  const sd = await page.evaluate(async () => {
    try { const d = await Promise.race([getScreenDetails(), new Promise((_, j) => setTimeout(() => j(new Error('timeout 6s (permission prompt?)')), 6000))]); return d.screens.map(s => ({ l: s.left, t: s.top, w: s.width, h: s.height, aL: s.availLeft, aT: s.availTop, aW: s.availWidth, aH: s.availHeight, dpr: s.devicePixelRatio, primary: s.isPrimary, internal: s.isInternal, label: s.label })); } catch (e) { return String(e); }
  });
  console.log('screenDetails', JSON.stringify(sd)); out.screenDetails2 = sd;
  if (Array.isArray(sd) && sd.length > 1) {
    const other = sd.find(s => !s.primary) || sd[1];
    const tries = [];
    for (const [x, y] of [[other.l + 100, other.t + 100], [other.l + 100, other.t + 300]]) {
      await page.evaluate(([x, y]) => refs.a.moveTo(x, y), [x, y]); await sleep(1200);
      const r = await measure(A, `popupA moveTo other display (${x},${y}) w/ permission`);
      tries.push(r);
    }
    out.otherDisplayMoveTo = tries;
    // open fresh popup with left/top on other display
    const [P] = await Promise.all([context.waitForEvent('page'), page.evaluate(([l, t]) => { refs.c = window.open('index.html?p=c', 'pc', `popup,width=400,height=300,left=${l},top=${t}`); }, [other.l + 200, other.t + 150])]);
    await P.waitForLoadState(); await sleep(1000);
    out.openOnOther = await measure(P, 'popup opened via window.open on other display');
    await page.evaluate(() => refs.c.moveTo(0, 0)).catch(() => {});
    await P.close();
  }
  {
    const [P] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { refs.c = window.open('index.html?p=c', 'pc', 'popup,width=400,height=300,left=1700,top=150'); })]).catch(e => [null]);
    if (P) { await P.waitForLoadState(); await sleep(1200);
      out.openAt1700 = await measure(P, 'window.open left=1700 (beyond primary width 1512)');
      await P.close(); }
  }
  fs.writeFileSync('spikes/s1-calibration/results.json', JSON.stringify(out, null, 1));
  await A.close(); await B.close(); await tab.close();
} finally { await browser.close(); }
