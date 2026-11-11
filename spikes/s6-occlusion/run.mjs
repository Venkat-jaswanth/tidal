import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = 'http://localhost:5173/spikes/s6-occlusion/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f1 = (x) => (typeof x === 'number' && isFinite(x) ? +x.toFixed(1) : x);
const args = ['--window-position=' + (process.env.WINPOS || '0,0')];
if (process.env.EXTRA) args.push(...process.env.EXTRA.split(' '));
const browser = await chromium.launch({ channel: 'chrome', headless: false, args, ignoreDefaultArgs: process.env.IGNORE ? process.env.IGNORE.split(' ') : undefined });
const R = { env: { WINPOS: process.env.WINPOS, EXTRA: process.env.EXTRA, IGNORE: process.env.IGNORE } };
const log = (...a) => console.log(...a);
try {
  const context = await browser.newContext({ viewport: null });
  await context.route('**/@vite/client', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const main = await context.newPage();
  await main.goto(BASE + '?r=main'); await sleep(500);
  const bcdp = await browser.newBrowserCDPSession();
  const scr = await main.evaluate(() => ({ w: screen.width, h: screen.height, L: screen.availLeft, T: screen.availTop, dpr: devicePixelRatio }));
  R.screen = scr; const { L, T } = scr; log('screen', JSON.stringify(scr));
  async function openPopup(name, x, y, w, h, role) {
    await main.evaluate((r) => { window.__req = r; }, { name, url: `index.html?r=${role}&n=${name}`, features: `popup,width=${w},height=${h},left=${L + x},top=${T + y}` });
    const [p] = await Promise.all([context.waitForEvent('page'), main.click('#go')]);
    await p.waitForLoadState(); await main.evaluate(([n, x, y]) => refs[n].moveTo(x, y), [name, L + x, T + y]); await sleep(300); return p;
  }
  const mv = (n, x, y) => main.evaluate(([n, x, y]) => refs[n].moveTo(x, y), [n, L + x, T + y]);
  const rs = (n, w, h) => main.evaluate(([n, w, h]) => refs[n].resizeTo(w, h), [n, w, h]);
  const winOf = async (p) => { const cs = await context.newCDPSession(p); const { targetInfo } = await cs.send('Target.getTargetInfo'); const { windowId, bounds } = await bcdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId }); return { windowId, bounds }; };

  const S = await openPopup('S', 1150, 700, 300, 200, 'sender');
  const P0 = await openPopup('P0', 100, 100, 400, 300, 'mon');
  const P1 = await openPopup('P1', 620, 100, 400, 300, 'mon');
  await sleep(1500);
  R.p0pos = await P0.evaluate(() => pos()); log('P0 pos', R.p0pos);

  async function phase(label, setup, waitMs, target = P0, measureS = 5) {
    await target.evaluate(() => setMC(true));
    const t0 = Date.now();
    await setup();
    await sleep(waitMs);
    const t1 = Date.now();
    const lo = t0 - 3000, w = 500;
    const prof = await target.evaluate(([a, b, w]) => prof(a, b, w), [lo, t1, w]);
    const ev = await target.evaluate(() => { setMC(false); return events(); });
    const nb = prof.raf.length; const per = w / 1000;
    const hz = (k, i0, i1) => f1(prof[k].slice(i0, i1).reduce((x, y) => x + y, 0) / ((i1 - i0) * per));
    const iPre = 0, iChg = Math.round(3000 / w);
    const base = hz('raf', 0, iChg);
    // last measureS seconds
    const iEnd = nb - 1, iStart = Math.max(iChg, iEnd - Math.round(measureS * 1000 / w));
    const gaps = await target.evaluate(([a, b]) => rafGaps(a, b, 300), [t0 - 500, t1]);
    const firstGap = gaps.find(g => g[0] >= t0 - 100);
    const events = ev.vis.filter(v => v[0] >= t0 - 100).map(v => [v[1], Math.round(v[0] - t0)]);
    const focEv = ev.foc.filter(v => v[0] >= t0 - 100).map(v => [v[1], Math.round(v[0] - t0)]);
    const row = {
      label, baselineRaf_Hz: base, steadyRaf_Hz: hz('raf', iStart, iEnd), steadyTimeout0_Hz: hz('to', iStart, iEnd), steadyInterval10ms_Hz: hz('iv', iStart, iEnd), steadyMsgChannel_Hz: hz('mc', iStart, iEnd), steadyBC_Hz: hz('bc', iStart, iEnd),
      vis: ev.state, hasFocus: ev.focus, visEvents: events, focusEvents: focEv,
      throttleOnset_ms: firstGap ? Math.round(firstGap[0] - t0) : null, firstGapLen_ms: firstGap ? Math.round(firstGap[1]) : null,
      rafPer500ms: prof.raf.slice(iChg - 2).join(','), toPer500: prof.to.slice(iChg - 2).map(x => Math.round(x / 10) / 1 ).join(','),
    };
    log(JSON.stringify(row)); (R.phases ||= []).push(row); return row;
  }
  // 1
  await phase('1 visible+focused (P0 brought to front)', () => P0.bringToFront(), 6000);
  // 2
  await phase('2 visible, unfocused (P1 brought to front, disjoint)', () => P1.bringToFront(), 6000);
  // 3 fully covered
  const covered = await phase('3 fully covered by bigger P1', async () => { await rs('P1', 700, 500); await mv('P1', 50, 50); await P1.bringToFront(); }, 12000);
  R.p1posCover = await P1.evaluate(() => pos());
  // uncover and measure recovery time
  const recT0 = Date.now();
  await mv('P1', 620, 100); await rs('P1', 400, 300); await sleep(3000);
  { const g = await P0.evaluate(([a, b]) => rafBetween(a, b), [recT0, recT0 + 3000]);
    const gp = await P0.evaluate(([a]) => { const out = []; return rafGaps(a, a + 3000, 300); }, [recT0 - 15000]);
    R.uncoverRecovery = { raf_in_3s_after_uncover: g, bigGapsSince: gp.slice(-3).map(x => [Math.round(x[0] - recT0), Math.round(x[1])]) }; log('uncover', JSON.stringify(R.uncoverRecovery)); }
  // 4 partly covered (P1 covers right half of P0)
  await phase('4 partly covered (P1 over right half)', async () => { await rs('P1', 700, 500); await mv('P1', 300, 100); await P1.bringToFront(); }, 10000);
  await mv('P1', 620, 100); await rs('P1', 400, 300); await sleep(1500);
  // 5 off-screen
  {
    const tries = [];
    for (const [x, y] of [[-5000, 100], [100, -5000], [20000, 100]]) { await mv('P0', x, y); await sleep(500); tries.push({ moveTo: [x, y], got: await P0.evaluate(() => pos()) }); }
    R.offscreenMoveTo = tries; log('offscreen moveTo', JSON.stringify(tries));
    await mv('P0', 100, 100); await sleep(500);
    try {
      const w = await winOf(P0); R.cdpWindow = w;
      const row = await phase('5 off-screen via CDP Browser.setWindowBounds left=+20000', async () => { await bcdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: L + 20000, top: T + 100 } }); }, 12000);
      R.offscreenCdpPos = await P0.evaluate(() => pos()); log('p0 pos after cdp offscreen', JSON.stringify(R.offscreenCdpPos));
      await bcdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: L + 100, top: T + 100 } });
      await sleep(1500);
    } catch (e) { R.offscreenCdpErr = String(e); log('cdp offscreen err', String(e)); }
  }
  // 7 minimize (before 6 to keep tab test clean)
  try {
    const w = await winOf(P0);
    await phase('7 minimized (CDP windowState=minimized)', async () => { await bcdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } }); }, 10000);
    await bcdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
    await sleep(2500);
    R.afterRestore = await P0.evaluate(() => ({ pos: pos(), ev: events() }));
    log('restore', JSON.stringify(R.afterRestore.pos));
  } catch (e) { R.minErr = String(e); log('min err', String(e)); }
  // 6 background tab (target = main page; open normal tab from main)
  {
    let tab;
    await phase('6 background tab (main page after opening a new tab in same window)', async () => {
      await main.evaluate(() => { window.__req = { name: 'TAB', url: 'index.html?r=mon&n=tab' }; });
      [tab] = await Promise.all([context.waitForEvent('page'), main.click('#go')]);
    }, 10000, main);
    const tabState = await tab.evaluate(() => events()); R.newTabState = tabState.state;
    await tab.close(); await sleep(1500);
    R.afterTabClose = await main.evaluate(() => events().state);
  }
  // BC latency
  R.bcLatency_P0 = await P0.evaluate(() => bcLatStats());
  R.bcLatency_P1 = await P1.evaluate(() => bcLatStats());

  // ---------- Web Locks ----------
  const lockRes = [];
  for (let trial = 0; trial < 6; trial++) {
    const mode = ['close()', 'close()', 'close()', 'opener-ref.close()', 'opener-ref.close()', 'navigate-away'][trial];
    const A = await openPopup('LA', 100, 450, 300, 200, 'mon');
    const Bp = await openPopup('LB', 450, 450, 300, 200, 'mon');
    await A.evaluate(() => holdLock('tidal-leader')); await sleep(200);
    await Bp.evaluate(() => waitLock('tidal-leader')); await sleep(800);
    const preAcq = await Bp.evaluate(() => window.lockAcq);
    await main.evaluate(() => stamp());
    if (mode === 'close()') await A.close(); // playwright page.close: CDP Target.closeTarget
    else if (mode === 'opener-ref.close()') await main.evaluate(() => { stamp(); refs.LA.close(); });
    else await A.goto('about:blank');
    let acq = null; for (let k = 0; k < 100; k++) { acq = await main.evaluate(() => window.lkRecv && (window.lkRecv - window.t0)); if (acq) break; await sleep(20); }
    lockRes.push({ trial, mode, acquiredBeforeClose: !!preAcq, handoffMs_upperBound: acq ? f1(acq) : null });
    log('lock', JSON.stringify(lockRes.at(-1)));
    await Bp.close(); if (mode === 'navigate-away') await A.close().catch(() => {}); await sleep(300);
  }
  R.locks = lockRes;
  // lock handoff when waiter is fully covered
  {
    const A = await openPopup('LA', 100, 450, 300, 200, 'mon');
    const Bp = await openPopup('LB', 450, 450, 300, 200, 'mon');
    await A.evaluate(() => holdLock('tidal-leader')); await sleep(200);
    await Bp.evaluate(() => waitLock('tidal-leader'));
    await rs('P1', 900, 400); await mv('P1', 400, 440); await P1.bringToFront(); await sleep(7000);
    const vis = await Bp.evaluate(() => events().state);
    await main.evaluate(() => stamp());
    await A.close();
    let acq = null; for (let k = 0; k < 100; k++) { acq = await main.evaluate(() => window.lkRecv && (window.lkRecv - window.t0)); if (acq) break; await sleep(20); }
    R.lockWaiterCovered = { waiterVis: vis, handoffMs_upperBound: acq ? f1(acq) : null }; log('lock covered', JSON.stringify(R.lockWaiterCovered));
    await Bp.close();
  }
  fs.writeFileSync('spikes/s6-occlusion/results' + (process.env.TAG ? '-' + process.env.TAG : '') + '.json', JSON.stringify(R, null, 1));
  await S.close(); await P0.close(); await P1.close();
} finally { await browser.close(); }
