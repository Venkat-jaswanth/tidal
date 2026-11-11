import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5173/spikes/s4-pip/index.html';
const R = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pr = (k, v) => { R[k] = v; console.log(k, JSON.stringify(v)); };

const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  const pagesEvents = [];
  ctx.on('page', (p) => pagesEvents.push('page event ' + p.url()));
  await page.goto(URL);
  pr('env', await page.evaluate(() => ({ crossOriginIsolated, dpip: 'documentPictureInPicture' in window, gpu: !!navigator.gpu,
    screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, availLeft: screen.availLeft, availTop: screen.availTop, dpr: devicePixelRatio },
    openerPos: [screenX, screenY, outerWidth, outerHeight] })));

  // Q1 open
  await page.click('#open');
  await sleep(800);
  const pipPage = ctx.pages().find((p) => p !== page);
  pr('Q1', { requestWindow: await page.evaluate(() => __s4.info), pagesEvents, contextPages: ctx.pages().map((p) => p.url()), pipIsPlaywrightPage: !!pipPage,
    pipTitle: pipPage && (await pipPage.title()) });

  const measure = async (secs = 5) => {
    const a = await page.evaluate(() => ({ ...__s4.cnt, t: performance.now() }));
    await sleep(secs * 1000);
    const b = await page.evaluate(() => ({ ...__s4.cnt, t: performance.now() }));
    const dt = (b.t - a.t) / 1000;
    return { openerHz: +((b.opener - a.opener) / dt).toFixed(1), pipHz: +((b.pip - a.pip) / dt).toFixed(1), renderHz: +((b.render - a.render) / dt).toFixed(1) };
  };
  const focusState = () => page.evaluate(() => ({ openerHasFocus: document.hasFocus(), pipHasFocus: __s4.pip.document.hasFocus(), openerVis: document.visibilityState, pipVis: __s4.pip.document.visibilityState }));
  const focusOpener = async () => { await page.bringToFront(); await page.evaluate(() => window.focus()); await sleep(300); };
  const focusPip = async () => { await pipPage.bringToFront(); await page.evaluate(() => __s4.pip.focus()); await sleep(300); };

  // Q2/3/4 matrix
  const matrix = [];
  for (const [p, raf] of [['A', 'pip'], ['A', 'opener'], ['B', 'pip'], ['B', 'opener']]) {
    const row = { path: p, raf };
    row.setup = await page.evaluate(([p, raf]) => __s4.setup(p, raf), [p, raf]);
    await sleep(1200);
    row.err = await page.evaluate(() => __s4.err);
    row.pixel = await page.evaluate(() => __s4.pixel);
    await focusOpener(); row.focusA = await focusState(); row.openerFocused = await measure(5);
    await focusPip(); row.focusB = await focusState(); row.pipFocused = await measure(5);
    row.pixelAfter = await page.evaluate(() => __s4.pixel);
    matrix.push(row); console.log(JSON.stringify(row));
  }
  R.matrix = matrix;
  try { await pipPage.screenshot({ path: path.join(here, 'pip.png') }); R.pipScreenshot = 'pip.png'; } catch (e) { R.pipScreenshot = 'ERR ' + e.message; }

  // Q5 position
  await page.evaluate(() => __s4.setup('A', 'pip'));
  await focusOpener();
  const posRead = async () => page.evaluate(() => { const w = __s4.pip; return [w.screenX, w.screenY, w.outerWidth, w.outerHeight, w.innerWidth, w.innerHeight]; });
  const pos0 = await posRead();
  const samples0 = await page.evaluate(() => __s4.posSamples);
  await sleep(1000);
  const samples1 = await page.evaluate(() => __s4.posSamples);
  const q5 = { initial: pos0, polledSamplesPerSec: samples1 - samples0, distinctValuesSoFar: await page.evaluate(() => __s4.pos) };
  // moveTo / resizeTo from opener, no gesture
  q5.openerMoveToNoGesture = await page.evaluate(() => { __s4.pip.moveTo(100, 100); return 'called'; }); await sleep(400); q5.afterOpenerMoveNoGesture = await posRead();
  q5.openerResizeToNoGesture = await page.evaluate(() => { __s4.pip.resizeTo(500, 400); return 'called'; }); await sleep(400); q5.afterOpenerResizeNoGesture = await posRead();
  // from inside PiP realm, no gesture
  q5.pipRealmMoveNoGesture = await pipPage.evaluate(() => { try { window.moveTo(100, 100); window.resizeTo(500, 400); return 'called'; } catch (e) { return 'ERR ' + e; } }); await sleep(400); q5.afterPipRealmNoGesture = await posRead();
  // with gesture inside PiP (real click via Playwright)
  await pipPage.evaluate(() => { document.addEventListener('click', () => { try { window.moveTo(100, 100); window.resizeTo(500, 400); window.__gest = 'called'; } catch (e) { window.__gest = 'ERR ' + e; } }, { once: true }); });
  await pipPage.bringToFront(); await pipPage.mouse.click(50, 50); await sleep(600);
  q5.pipGestureResult = await pipPage.evaluate(() => window.__gest); q5.afterPipGesture = await posRead();
  // resize with gesture, moveBy/resizeBy
  await pipPage.evaluate(() => { document.addEventListener('click', () => { try { window.moveBy(50, 50); window.resizeBy(40, 40); window.__gest2 = 'called'; } catch (e) { window.__gest2 = 'ERR ' + e; } }, { once: true }); });
  await pipPage.mouse.click(50, 50); await sleep(600); q5.afterPipGestureMoveByResizeBy = await posRead();
  // opener gesture (click on its own button handler can't be reused; install one on body)
  await page.evaluate(() => { document.addEventListener('click', () => { __s4.pip.moveTo(120, 120); __s4.pip.resizeTo(420, 300); }, { once: true }); });
  await focusOpener(); await page.mouse.click(400, 300); await sleep(600); q5.afterOpenerGesture = await posRead();
  // Does CDP see window bounds (alternative position source)?
  try {
    const bs = await browser.newBrowserCDPSession();
    const tg = (await bs.send('Target.getTargets')).targetInfos.find((t) => t.title === 'Tidal PiP');
    const w = await bs.send('Browser.getWindowForTarget', { targetId: tg.targetId });
    q5.cdpPipWindowBounds = w.bounds;
    q5.cdpPipDragNote = 'Browser.setWindowBounds is available as test-only way to move PiP';
    await bs.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: 300, top: 200 } }); await sleep(500);
    q5.afterCdpSetBounds = await posRead();
    q5.cdpBoundsAfter = (await bs.send('Browser.getWindowBounds', { windowId: w.windowId })).bounds;
    await bs.detach();
  } catch (e) { q5.cdpErr = String(e.message); }
  q5.posUpdateLog = await page.evaluate(() => __s4.pos.slice(-12));
  pr('Q5', q5);

  // Q6 hidden / covered
  const q6 = {};
  await page.evaluate(() => __s4.setup('A', 'pip')); await sleep(1000);
  const bs = await browser.newBrowserCDPSession();
  const targets = (await bs.send('Target.getTargets')).targetInfos;
  const openerTarget = targets.find((t) => t.url === URL);
  // new tab in same window
  await page.evaluate(() => { const a = document.createElement('a'); a.id = 'nt'; a.href = 'about:blank'; a.target = '_blank'; a.textContent = 'newtab'; a.style.cssText = 'display:block;margin:20px;font-size:20px'; document.body.appendChild(a); });
  const nPagesBefore = ctx.pages().length;
  await page.click('#nt'); await sleep(1200);
  const tabPage = ctx.pages().find((p) => p !== page && p !== pipPage);
  q6.newTabOpened = { pagesBefore: nPagesBefore, pagesAfter: ctx.pages().length, tabFound: !!tabPage };
  await sleep(500); q6.tabState = await focusState();
  q6.openerTabHidden_pathA_pipRaf = await measure(5);
  await page.evaluate(() => __s4.setup('A', 'opener')); await sleep(800);
  q6.openerTabHidden_pathA_openerRaf = await measure(5);
  await page.evaluate(() => __s4.setup('B', 'pip')); await sleep(800);
  q6.openerTabHidden_pathB_pipRaf = await measure(5);
  if (tabPage) await tabPage.close(); await sleep(800);
  await page.bringToFront(); await sleep(500); q6.afterTabClosed = await focusState();
  // covered by a new window
  const wOpener = await bs.send('Browser.getWindowForTarget', { targetId: openerTarget.targetId });
  q6.openerBounds = wOpener.bounds;
  let cov; try { cov = await bs.send('Target.createTarget', { url: 'about:blank', newWindow: true }); } catch (e) { q6.covCdpErr = e.message; }
  if (!cov) { const cp = await ctx.newPage(); const tg = (await bs.send('Target.getTargets')).targetInfos; cov = { targetId: tg.filter((t) => t.type === 'page' && t.url === 'about:blank').pop().targetId }; q6.covViaNewPage = true; }
  const wCov = await bs.send('Browser.getWindowForTarget', { targetId: cov.targetId });
  await bs.send('Browser.setWindowBounds', { windowId: wCov.windowId, bounds: { ...wOpener.bounds, windowState: 'normal' } });
  await bs.send('Target.activateTarget', { targetId: cov.targetId }); await sleep(1500);
  q6.coverState = await focusState();
  await page.evaluate(() => __s4.setup('A', 'pip')); await sleep(800);
  q6.covered_pathA_pipRaf = await measure(5);
  await page.evaluate(() => __s4.setup('B', 'pip')); await sleep(800);
  q6.covered_pathB_pipRaf = await measure(5);
  await bs.send('Target.closeTarget', { targetId: cov.targetId }); await sleep(800);
  await page.bringToFront(); await bs.detach();
  pr('Q6', q6);

  // Q8 realm / SAB
  const q8 = {};
  q8.opener = await page.evaluate(() => {
    const w = __s4.pip; const sab = new SharedArrayBuffer(16); const view = new Int32Array(sab);
    let viewFromPipCtor = null; try { viewFromPipCtor = new w.Int32Array(sab); viewFromPipCtor[0] = 7; } catch (e) { viewFromPipCtor = 'ERR ' + e; }
    window.__sab = sab;
    return { pipCrossOriginIsolated: w.crossOriginIsolated, sabSameCtor: w.SharedArrayBuffer === window.SharedArrayBuffer, objectSameCtor: w.Object === Object,
      pipHasSAB: typeof w.SharedArrayBuffer, sabViaPipCtorWrites: typeof viewFromPipCtor === 'string' ? viewFromPipCtor : view[0],
      pipOpener: w.opener === null ? 'null' : (w.opener === window ? 'is opener window' : 'other'), sabInstanceOfPipSAB: sab instanceof w.SharedArrayBuffer };
  });
  q8.pipRealm = await pipPage.evaluate(() => ({ crossOriginIsolated: self.crossOriginIsolated, hasSAB: typeof SharedArrayBuffer, hasGpu: !!navigator.gpu,
    openerAccessible: (() => { try { return window.opener ? 'yes' : 'null'; } catch (e) { return 'ERR ' + e; } })(),
    origin: location.origin, url: location.href }));
  // opener writes into object pip reads (pip realm reads via window.opener or via parent closure)
  q8.sharedObject = await page.evaluate(async () => {
    const w = __s4.pip; w.__shared = new Int32Array(window.__sab); // opener assigns SAB view to a property of pip window
    window.__sab32 = new Int32Array(window.__sab); Atomics.store(window.__sab32, 1, 42);
    return 'assigned';
  });
  q8.pipReadsSab = await pipPage.evaluate(() => { try { return { viaWindowProp: window.__shared ? Atomics.load(window.__shared, 1) : 'missing', instanceOfOwnSAB: window.__shared && window.__shared.buffer instanceof SharedArrayBuffer }; } catch (e) { return 'ERR ' + e; } });
  q8.pipSeesLiveWrite = await (async () => { await page.evaluate(() => Atomics.store(window.__sab32, 1, 99)); return pipPage.evaluate(() => Atomics.load(window.__shared, 1)); })();
  // postMessage SAB via BroadcastChannel
  q8.broadcastChannelSAB = await (async () => {
    try {
      await pipPage.evaluate(() => { window.__bc = new BroadcastChannel('s4'); window.__bcGot = null; window.__bc.onmessage = (e) => { window.__bcGot = { isSAB: e.data instanceof SharedArrayBuffer, v: new Int32Array(e.data)[1] }; }; });
      await page.evaluate(() => { new BroadcastChannel('s4').postMessage(window.__sab); });
      await sleep(400); return await pipPage.evaluate(() => window.__bcGot);
    } catch (e) { return 'ERR ' + e.message; }
  })();
  // opener function executed from pip realm
  q8.pipCallsOpenerFn = await page.evaluate(() => { __s4.pip.__fromOpener = () => 'closure-from-opener-realm'; return __s4.pip.__fromOpener(); });
  pr('Q8', q8);

  // Q7 lifecycle
  const q7 = {};
  await page.evaluate(() => { __s4.events.length = 0; });
  const closedPromise = pipPage.waitForEvent('close', { timeout: 3000 }).then(() => true, () => false);
  await page.evaluate(() => { __s4.pip.close(); });
  q7.pipPageCloseEvent = await closedPromise; await sleep(300);
  q7.afterClose = await page.evaluate(() => ({ windowProp: documentPictureInPicture.window, pipClosedFlag: __s4.pip.closed, events: __s4.events }));
  q7.contextPagesAfterClose = ctx.pages().length;
  // reopen
  await page.bringToFront(); await page.click('#open'); await sleep(800);
  q7.reopen = await page.evaluate(() => ({ ok: __s4.info.openOk, err: __s4.info.openErr || null, windowProp: !!documentPictureInPicture.window, closed: __s4.pip.closed }));
  let pip2 = ctx.pages().find((p) => p !== page); q7.pagesAfterReopen = ctx.pages().length;
  // second requestWindow while open
  await page.evaluate(() => { __s4.events.length = 0; __s4.firstPip = __s4.pip; });
  await page.click('#open'); await sleep(1000);
  q7.second = await page.evaluate(() => ({ events: __s4.events, err: __s4.info.openErr || null, firstClosed: __s4.firstPip.closed, sameWindow: __s4.firstPip === __s4.pip, windowPropIsNew: documentPictureInPicture.window === __s4.pip }));
  q7.pagesAfterSecond = ctx.pages().map((p) => p.url());
  // opener reload with PiP open
  const nBefore = ctx.pages().length;
  await page.reload(); await sleep(1200);
  q7.afterReload = { pagesBefore: nBefore, pagesAfter: ctx.pages().length, dpipWindow: await page.evaluate(() => documentPictureInPicture.window) };
  // opener navigation with PiP open (reopen then navigate away)
  await page.click('#open'); await sleep(800);
  const nb2 = ctx.pages().length;
  await page.goto('http://localhost:5173/spikes/s4-pip/index.html?nav=1'); await sleep(1200);
  q7.afterNavigate = { pagesBefore: nb2, pagesAfter: ctx.pages().length };
  pr('Q7', q7);
} catch (e) {
  console.log('FATAL', e); R.fatal = String(e.stack || e);
} finally {
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(R, null, 2));
  await browser.close();
}
