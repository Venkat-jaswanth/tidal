import { chromium } from '@playwright/test';
import fs from 'node:fs';
const PAGE_URL = 'http://localhost:5173/spikes/s5-moveto/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f = (x, d = 2) => (typeof x === 'number' && isFinite(x) ? +x.toFixed(d) : x);
function rafHz(frames) { const d = []; for (let i = 1; i < frames.length; i++) d.push(frames[i] - frames[i - 1]); return { hz: f(1000 / mean(d), 1), medDtMs: f(med(d)), p95DtMs: f(pct(d, 0.95)), maxDtMs: f(Math.max(...d)), n: frames.length }; }
function analyse(res) {
  const out = { opener_raf: rafHz(res.frames), moveToCost_ms: { mean: f(mean(res.cost), 3), med: f(med(res.cost), 3), p95: f(pct(res.cost, 0.95), 3), max: f(Math.max(...res.cost), 3) }, popups: [] };
  res.logs.forEach((L, i) => {
    const ch = L.log; const ints = []; for (let k = 1; k < ch.length; k++) ints.push(ch[k][0] - ch[k - 1][0]);
    const inst = ints.filter(x => x > 0).map(x => 1000 / x);
    const dur = (ch.at(-1)?.[0] - ch[0]?.[0]) / 1000;
    // latency cmd -> first observation of same pos
    const lat = []; let seen = 0; const cm = res.cmds[i]; let j = 0;
    for (const [tc, x, y] of cm) {
      while (j < ch.length && ch[j][0] < tc) j++;
      for (let k = j; k < Math.min(ch.length, j + 12); k++) if (ch[k][1] === x && ch[k][2] === y) { lat.push(ch[k][0] - tc); seen++; break; }
    }
    // path error: observed positions vs nearest command in time (within last 100ms): min distance to any cmd in [t-150,t]
    const errs = ch.map(o => { let best = Infinity; for (const [tc, x, y] of cm) { if (tc > o[0]) break; if (o[0] - tc < 200) best = Math.min(best, Math.hypot(o[1] - x, o[2] - y)); } return best; }).filter(isFinite);
    out.popups.push({
      i, changes: ch.length, changeRateOverall_Hz: f(ch.length / dur, 1), instMed_Hz: f(med(inst), 1), instP5_Hz: f(pct(inst, 0.05), 1), maxGap_ms: f(Math.max(...ints), 1),
      raf: rafHz(L.frames), cmdsIssued: cm.length, cmdsObservedExactly: seen, latMed_ms: f(med(lat)), latP95_ms: f(pct(lat, 0.95)),
      oneFrameLagErr_px: { mean: f(mean(res.lagErr[i])), max: f(Math.max(...res.lagErr[i])) }, errToRecentCmd_px: { mean: f(mean(errs)), max: f(Math.max(...errs)) }, hasFocusEnd: L.focus, vis: L.vis,
    });
  });
  out.focusBefore = res.focusBefore; out.focusAfter = res.focusAfter; out.openerFocusEnd = res.openerFocus;
  return out;
}
const results = {};
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: process.env.WINPOS ? ['--window-position=' + process.env.WINPOS] : [] });
try {
  const context = await browser.newContext({ viewport: null });
  await context.route('**/@vite/client', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const page = await context.newPage();
  await page.goto(PAGE_URL);
  const pops = [];
  for (let i = 0; i < 3; i++) { const [p] = await Promise.all([context.waitForEvent('page'), page.click('#o' + i)]); await p.waitForLoadState(); pops.push(p); }
  await sleep(800);
  results.screen = await page.evaluate(() => ({ w: screen.width, h: screen.height, aT: screen.availTop, aH: screen.availHeight, dpr: devicePixelRatio }));
  console.log('screen', JSON.stringify(results.screen));
  // warm
  await page.evaluate(() => run('move', 1)); await sleep(500);
  console.log('=== run: moveTo only, 10s');
  results.moveOnly = analyse(await page.evaluate(() => run('move', 10)));
  console.log(JSON.stringify(results.moveOnly, null, 1));
  await sleep(500);
  console.log('=== run: moveTo + resizeTo, 10s');
  results.moveResize = analyse(await page.evaluate(() => run('resize', 10)));
  console.log(JSON.stringify(results.moveResize, null, 1));
  // reset size
  await page.evaluate(() => refs.slice(0, 3).forEach((r, i) => { r.resizeTo(360, 280); r.moveTo(L + 300 + 300 * i, T + 300); })); await sleep(600);

  // clamping
  const clamp = [];
  const L = await page.evaluate(() => L), T = await page.evaluate(() => T);
  const W = results.screen.w, H = results.screen.h; results.origin = [L, T];
  for (const [x, y] of [[-100, 300], [-300, 300], [W - 200, 300], [W - 60, 300], [300, -100], [300, -30], [300, 0], [300, 10], [300, H - 100], [300, H + 200], [W + 50, H + 50]].map(([x, y]) => [x + L, y + T])) {
    await page.evaluate(([x, y]) => refs[0].moveTo(x, y), [x, y]); await sleep(500);
    const r = await pops[0].evaluate(() => pos()); clamp.push({ cmd: [x, y], got: [r[0], r[1]], outer: [r[2], r[3]] });
  }
  results.clamp = clamp; console.log('clamp', JSON.stringify(clamp));
  // resize clamp
  const rs = [];
  for (const [w, h] of [[100, 100], [200, 150], [3000, 2000], [W, H]]) {
    await page.evaluate(([w, h]) => refs[0].resizeTo(w, h), [w, h]); await sleep(500);
    const r = await pops[0].evaluate(() => pos()); rs.push({ cmd: [w, h], outer: [r[2], r[3]], pos: [r[0], r[1]] });
  }
  results.resizeClamp = rs; console.log('resizeClamp', JSON.stringify(rs));
  await page.evaluate(() => { refs[0].resizeTo(360, 280); refs[0].moveTo(L + 300, T + 300); }); await sleep(500);

  // popup moves itself, and popup moveTo of a sibling via window.opener? (self move)
  await pops[1].evaluate(([L, T]) => window.moveTo(L + 900, T + 200), [L, T]); await sleep(400);
  results.selfMove = await pops[1].evaluate(() => pos()); console.log('selfMove', JSON.stringify(results.selfMove));

  // second display
  const other = [];
  for (const [x, y] of [[W + 100, 200], [W + 400, 200], [-400, 200], [-W, 200], [300, -H], [300, H + 300]].map(([x, y]) => [x + L, y + T])) {
    await page.evaluate(([x, y]) => refs[2].moveTo(x, y), [x, y]); await sleep(700);
    const r = await pops[2].evaluate(() => ({ p: pos(), sw: screen.width, dpr: devicePixelRatio, aL: screen.availLeft }));
    other.push({ cmd: [x, y], got: [r.p[0], r.p[1]], sw: r.sw, dpr: r.dpr, availLeft: r.aL });
  }
  results.otherDisplay = other; console.log('other', JSON.stringify(other));

  // without user gesture
  const [pn] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { refs.ng = window.open('index.html?p=ng', 'png', 'popup,width=360,height=280,left=' + (L + 100) + ',top=' + (T + 500)); })]);
  await pn.waitForLoadState(); await sleep(600);
  const before = await pn.evaluate(() => pos());
  await page.evaluate(() => refs.ng.moveTo(L + 500, T + 600)); await sleep(500);
  const after = await pn.evaluate(() => pos());
  results.noGesturePopup = { before, after }; console.log('noGesture', JSON.stringify(results.noGesturePopup));
  await pn.close();
  // normal tab
  const [tab] = await Promise.all([context.waitForEvent('page'), page.click('#otab')]);
  await tab.waitForLoadState(); await sleep(600);
  const tb = await tab.evaluate(() => pos());
  await page.evaluate(() => { refs.tab.moveTo(L + 500, T + 400); refs.tab.resizeTo(500, 400); }); await sleep(500);
  const ta = await tab.evaluate(() => pos());
  results.normalTab = { before: tb, after: ta }; console.log('tab', JSON.stringify(results.normalTab));
  // tab self moveTo
  await tab.evaluate(() => window.moveTo(500, 400)); await sleep(300);
  results.normalTab.afterSelf = await tab.evaluate(() => pos());
  await tab.close();

  // focus: which page has focus, then move a popup and see
  await sleep(300);
  await pops[0].bringToFront().catch(() => {});
  await sleep(300);
  const f0 = await Promise.all([page.evaluate(() => document.hasFocus()), ...pops.map(p => p.evaluate(() => document.hasFocus()))]);
  await page.evaluate(() => { for (let k = 0; k < 20; k++) refs[1].moveTo(L + 500 + k * 5, T + 300); }); await sleep(400);
  const f1 = await Promise.all([page.evaluate(() => document.hasFocus()), ...pops.map(p => p.evaluate(() => document.hasFocus()))]);
  results.focusEvents = await Promise.all([page.evaluate(() => fev.length), ...pops.map(p => p.evaluate(() => fev.length))]);
  results.focus = { beforeMoveOpenerP0P1P2: f0, afterMovingP1: f1 }; console.log('focus', JSON.stringify(results.focus));

  fs.writeFileSync('spikes/s5-moveto/results' + (process.env.WINPOS ? '-' + process.env.WINPOS : '') + '.json', JSON.stringify(results, null, 1));
  for (const p of pops) await p.close();
} finally { await browser.close(); }
