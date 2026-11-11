// S6 without Playwright page control: Playwright forces focus/visibility emulation on every page it controls,
// so occlusion / background-tab behaviour is only observable when Chrome is launched directly.
// This script spawns Chrome itself, serves the spike page from a tiny local http server (port 5199) and drives pages
// through an SSE command channel (page evals code, POSTs result back). Window minimise uses raw CDP Browser.* only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// keep the display awake: with the display asleep macOS reports every window as occluded (visibilityState=hidden)
const wake = () => spawn('caffeinate', ['-d', '-u', '-t', '600'], { stdio: 'ignore' }); wake(); const keepAwake = setInterval(() => spawn('caffeinate', ['-u', '-t', '3'], { stdio: 'ignore' }), 5000);
const PORT = 5199, DBG = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const f1 = (x) => (typeof x === 'number' && isFinite(x) ? +x.toFixed(1) : x);
const html = fs.readFileSync('spikes/s6-occlusion/index.html');
const clients = new Map(); const pending = new Map(); let nid = 1;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(':ok\n\n');
    const n = u.searchParams.get('n'); clients.set(n, res); req.on('close', () => { if (clients.get(n) === res) clients.delete(n); }); return;
  }
  if (u.pathname === '/report') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const m = JSON.parse(b); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.err ? p.rej(new Error(m.err)) : p.res(m.res); } res.end('ok'); }); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
async function waitClient(n, ms = 8000) { const t = Date.now(); while (!clients.has(n)) { if (Date.now() - t > ms) throw new Error('no client ' + n); await sleep(50); } }
async function rpc(n, code, ms = 20000) {
  await waitClient(n); const id = nid++;
  return new Promise((res, rej) => { const to = setTimeout(() => { pending.delete(id); rej(new Error('rpc timeout ' + n)); }, ms); pending.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } }); clients.get(n).write(`data: ${JSON.stringify({ id, code })}\n\n`); });
}
const ev = (n, code, arg) => rpc(n, `const A = ${JSON.stringify(arg ?? null)}; ${code}`);

const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-s6-'));
const extra = process.env.EXTRA ? process.env.EXTRA.split(' ') : [];
const chrome = spawn('open', ['-n', '-a', 'Google Chrome', '--args', `--user-data-dir=${profDir}`, `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--window-position=' + (process.env.WINPOS || '0,0'), ...extra, `http://127.0.0.1:${PORT}/?r=main&n=main`], { stdio: 'ignore' });
const R = { mode: 'native chrome, no automation of pages', extraFlags: extra };
const log = (...a) => console.log(...a);
async function cdpBrowser() {
  const v = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  return { send: (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
try {
  await waitClient('main', 15000); await sleep(800);
  const cdp = await cdpBrowser();
  const targetId = async (n) => { const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json(); const t = l.find(x => x.type === 'page' && x.url.includes('n=' + n + '&') || x.url.endsWith('n=' + n)); return t?.id; };
  const winOf = async (n) => (await cdp.send('Browser.getWindowForTarget', { targetId: await targetId(n) })).windowId;
  const scr = await ev('main', 'return {w: screen.width, h: screen.height, L: screen.availLeft, T: screen.availTop, dpr: devicePixelRatio, hz: null}');
  const { L, T } = scr; R.screen = scr; log('screen', JSON.stringify(scr));
  R.mainStart = await ev('main', 'return {focus: document.hasFocus(), vis: document.visibilityState, pos: pos()}'); log('main start', JSON.stringify(R.mainStart));
  { const wid = await winOf('main'); await cdp.send('Browser.setWindowBounds', { windowId: wid, bounds: { left: L + 10, top: T + 10, width: 480, height: 420 } }); await sleep(800); R.mainPos = await ev('main', 'return pos()'); log('main shrunk', JSON.stringify(R.mainPos)); }
  async function openPopup(name, x, y, w, h, role) {
    await ev('main', `refs[A.name] = window.open('/?r=' + A.role + '&n=' + A.name, A.name, A.f); return !!refs[A.name];`, { name, role, f: `popup,width=${w},height=${h},left=${L + x},top=${T + y}` });
    await waitClient(name); await mv(name, x, y); await sleep(300);
  }
  const mv = (n, x, y) => ev('main', 'refs[A[0]].moveTo(A[1], A[2])', [n, L + x, T + y]);
  const rs = (n, w, h) => ev('main', 'refs[A[0]].resizeTo(A[1], A[2])', [n, w, h]);
  const focusPopup = async (n) => { await cdp.send('Target.activateTarget', { targetId: await targetId(n) }); };

  async function phase(label, setup, waitMs, target = 'P0', measureS = 5) {
    await ev(target, 'setMC(true)');
    const t0 = Date.now();
    await setup();
    await sleep(waitMs);
    const t1 = Date.now(); const w = 500, lo = t0 - 3000;
    const { prof, ev: evs, gaps } = await ev(target, `setMC(false); return {prof: prof(A[0], A[1], A[2]), ev: events(), gaps: rafGaps(A[3], A[1], 300)}`, [lo, t1, w, t0 - 500]);
    const nb = prof.raf.length, per = w / 1000, iChg = Math.round(3000 / w), iEnd = nb - 1, iStart = Math.max(iChg, iEnd - Math.round(measureS * 1000 / w));
    const hz = (k, a, b) => f1(prof[k].slice(a, b).reduce((x, y) => x + y, 0) / ((b - a) * per));
    const firstGap = gaps.find(g => g[0] >= t0 - 100);
    const row = {
      label, baselineRaf_Hz: hz('raf', 0, iChg), steadyRaf_Hz: hz('raf', iStart, iEnd), steadyTimeout0_Hz: hz('to', iStart, iEnd), steadyInterval10ms_Hz: hz('iv', iStart, iEnd), steadyMsgChannel_Hz: hz('mc', iStart, iEnd), steadyBC_Hz: hz('bc', iStart, iEnd),
      vis: evs.state, hasFocus: evs.focus, visEvents: evs.vis.filter(v => v[0] >= t0 - 100).map(v => [v[1], Math.round(v[0] - t0)]), focusEvents: evs.foc.filter(v => v[0] >= t0 - 100).map(v => [v[1], Math.round(v[0] - t0)]),
      throttleOnset_ms: firstGap ? Math.round(firstGap[0] - t0) : null, firstGapLen_ms: firstGap ? Math.round(firstGap[1]) : null,
      rafPer500ms_from_m1s: prof.raf.slice(iChg - 2).join(','), intervalPer500ms: prof.iv.slice(iChg - 2).join(','),
    };
    log(JSON.stringify(row)); (R.phases ||= []).push(row); return row;
  }

  await openPopup('S', 1150, 650, 300, 200, 'sender');
  await openPopup('P0', 520, 60, 400, 300, 'mon');
  await openPopup('P1', 960, 60, 400, 300, 'mon');
  await sleep(1500);
  for (const n of ['main', 'P0', 'P1', 'S']) { const b = await cdp.send('Browser.getWindowForTarget', { targetId: await targetId(n) }); const st = await ev(n, 'return [document.visibilityState, document.hasFocus()]'); log('win', n, JSON.stringify(b), JSON.stringify(st)); }
  await focusPopup('P0'); await sleep(1500); log('after activate P0', JSON.stringify(await ev('P0', 'return [document.visibilityState, document.hasFocus(), pos()]')), JSON.stringify(await ev('main', 'return [document.visibilityState, document.hasFocus()]')));
  R.p0pos = await ev('P0', 'return pos()'); log('P0 pos', R.p0pos);
  R.focusAfterOpen = { main: await ev('main', 'return document.hasFocus()'), P0: await ev('P0', 'return document.hasFocus()'), P1: await ev('P1', 'return document.hasFocus()') }; log('focus after open', JSON.stringify(R.focusAfterOpen));

  await phase('1 visible+focused (P0.focus())', () => focusPopup('P0'), 6000);
  await phase('2 visible, unfocused (P1.focus(), disjoint)', () => focusPopup('P1'), 6000);
  await phase('3 fully covered by bigger P1', async () => { await rs('P1', 700, 500); await mv('P1', 470, 20); await focusPopup('P1'); }, 14000);
  R.p1posCover = await ev('P1', 'return pos()'); R.p0posCovered = await ev('main', 'return refs.P0.screenX + "," + refs.P0.screenY + " " + refs.P0.outerWidth + "x" + refs.P0.outerHeight');
  {
    const t = Date.now(); await mv('P1', 960, 60); await rs('P1', 400, 300); await sleep(3000);
    R.uncover = await ev('P0', 'return {rafIn3s: rafBetween(A, A + 3000), gaps: rafGaps(A - 16000, A + 3000, 300).slice(-3).map(g => [Math.round(g[0] - A), Math.round(g[1])]), vis: events().vis.map(v => [v[1], Math.round(v[0] - A)])}', t); log('uncover', JSON.stringify(R.uncover));
  }
  await phase('4 partly covered (P1 over right half)', async () => { await rs('P1', 700, 500); await mv('P1', 720, 60); await focusPopup('P1'); }, 10000);
  await mv('P1', 960, 60); await rs('P1', 400, 300); await sleep(1500);
  {
    const tries = [];
    for (const [x, y] of [[-5000, 100], [20000, 100]]) { await mv('P0', x, y); await sleep(400); tries.push({ moveTo: [x, y], got: await ev('P0', 'return pos()') }); }
    R.offscreenMoveTo = tries; log('offscreen moveTo', JSON.stringify(tries)); await mv('P0', 520, 60); await sleep(500);
    try {
      const wid = await winOf('P0');
      await phase('5 pushed off-screen via CDP Browser.setWindowBounds left=+20000', async () => { await cdp.send('Browser.setWindowBounds', { windowId: wid, bounds: { left: L + 20000, top: T + 60 } }); }, 12000);
      R.offscreenCdpPos = await ev('P0', 'return pos()'); log('P0 pos after cdp offscreen', JSON.stringify(R.offscreenCdpPos));
      await cdp.send('Browser.setWindowBounds', { windowId: wid, bounds: { left: L + 520, top: T + 60 } }); await sleep(1500);
    } catch (e) { R.cdpErr = String(e); log('cdp err', String(e)); }
  }
  try {
    const wid = await winOf('P0');
    await phase('7 minimized (CDP windowState=minimized)', async () => { await cdp.send('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'minimized' } }); }, 12000);
    await cdp.send('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal' } }); await sleep(3000);
    R.afterRestore = await ev('P0', 'return {pos: pos(), ev: events()}'); log('restore', JSON.stringify(R.afterRestore.pos), R.afterRestore.ev.state);
  } catch (e) { R.minErr = String(e); log('min err', String(e)); }
  {
    await phase('6 background tab (main page after window.open(url) opens a tab in the same window)', async () => { await ev('main', `refs.TAB = window.open('/?r=mon&n=TAB'); return 1`); }, 12000, 'main');
    R.tabState = await ev('TAB', 'return events()');
    await ev('main', 'refs.TAB.close()'); await sleep(2500);
    R.afterTabClose = await ev('main', 'return events()');
  }
  R.bcLatency_P0 = await ev('P0', 'return bcLatStats()'); R.bcLatency_P1 = await ev('P1', 'return bcLatStats()');

  // Web Locks
  const lockRes = [];
  for (let trial = 0; trial < 6; trial++) {
    const mode = ['window.close() from opener', 'window.close() from opener', 'window.close() from opener', 'navigate-away (location=about:blank)', 'navigate-away (location=about:blank)', 'Target.closeTarget via CDP'][trial];
    await openPopup('LA', 20, 480, 300, 200, 'mon'); await openPopup('LB', 340, 480, 300, 200, 'mon');
    await ev('LA', `navigator.locks.request('tidal-leader', () => new Promise(() => {})); await new Promise(r => setTimeout(r, 100)); return 1`); 
    await ev('LB', `waitLock('tidal-leader'); return 1`); await sleep(800);
    const pre = await ev('LB', 'return window.lockAcq');
    await ev('main', 'stamp()');
    if (mode.startsWith('window.close')) await ev('main', 'stamp(); refs.LA.close(); return 1');
    else if (mode.startsWith('navigate')) await ev('main', 'stamp(); refs.LA.location = "about:blank"; return 1');
    else { const id = await targetId('LA'); await ev('main', 'stamp()'); await cdp.send('Target.closeTarget', { targetId: id }); }
    let acq = null; for (let k = 0; k < 150; k++) { acq = await ev('main', 'return window.lkRecv && (window.lkRecv - window.t0)'); if (acq) break; await sleep(20); }
    lockRes.push({ trial, mode, acquiredBeforeRelease: !!pre, handoffMs_upperBound: acq ? f1(acq) : null }); log('lock', JSON.stringify(lockRes.at(-1)));
    await ev('main', 'refs.LB.close(); try { refs.LA.close(); } catch (e) {}; return 1'); await sleep(500);
  }
  R.locks = lockRes;
  { // waiter fully covered + unfocused
    await openPopup('LA', 20, 480, 300, 200, 'mon'); await openPopup('LB', 340, 480, 300, 200, 'mon');
    await ev('LA', `navigator.locks.request('tidal-leader', () => new Promise(() => {})); await new Promise(r => setTimeout(r, 100)); return 1`);
    await ev('LB', `waitLock('tidal-leader'); return 1`);
    await rs('P1', 900, 400); await mv('P1', 300, 450); await focusPopup('P1'); await sleep(8000);
    const vis = await ev('LB', 'return document.visibilityState');
    await ev('main', 'stamp(); refs.LA.close(); return 1');
    let acq = null; for (let k = 0; k < 150; k++) { acq = await ev('main', 'return window.lkRecv && (window.lkRecv - window.t0)'); if (acq) break; await sleep(20); }
    R.lockWaiterCovered = { waiterVis: vis, handoffMs_upperBound: acq ? f1(acq) : null }; log('lock covered', JSON.stringify(R.lockWaiterCovered));
  }
  fs.writeFileSync('spikes/s6-occlusion/results-native' + (process.env.TAG ? '-' + process.env.TAG : '') + '.json', JSON.stringify(R, null, 1));
  cdp.close();
} finally {
  spawnSync('pkill', ['-TERM', '-f', profDir]); await sleep(2000); spawnSync('pkill', ['-KILL', '-f', profDir]); await sleep(500);
  clearInterval(keepAwake); server.close(); fs.rmSync(profDir, { recursive: true, force: true });
  process.exit(0);
}
