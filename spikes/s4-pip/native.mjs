// Q6 without Playwright's focus/visibility emulation: spawn our own Chrome (temp profile) and drive it by raw CDP.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5173/spikes/s4-pip/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 's4native-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--user-data-dir=' + prof, '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', '--window-position=30,60', URL], { stdio: 'ignore' });
const R = {};
let ws, id = 0; const pend = new Map();
try {
  let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch('http://127.0.0.1:9333/json/version')).json(); break; } catch { await sleep(300); } }
  ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await sleep(2500);
  const find = async (pred) => (await send('Target.getTargets')).targetInfos.find(pred);
  const t = await find((x) => x.type === 'page' && x.url.startsWith(URL));
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const ev = async (expr, sess = S) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: false }, sess); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description)); return r.result.value; };
  // real click for user activation
  R.preState = await ev(`JSON.stringify({vis:document.visibilityState,foc:document.hasFocus()})`);
  R.winState0 = (await send('Browser.getWindowForTarget', { targetId: t.targetId })).bounds;
  const rect = await ev(`(()=>{const r=document.getElementById('open').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  R.frontmostOsascript = spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${chrome.pid}) to true`]).status;
  await send('Page.bringToFront', {}, S); await sleep(1500);
  R.preState2 = await ev(`JSON.stringify({vis:document.visibilityState,foc:document.hasFocus()})`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: rect[0], y: rect[1], button: 'left', clickCount: 1 }, S);
  await sleep(1000);
  R.opened = await ev(`JSON.stringify(__s4.info)`);
  R.afterClickState = await ev(`JSON.stringify({vis:document.visibilityState,pipvis:__s4.pip&&__s4.pip.document.visibilityState})`);
  await sleep(3000);
  R.afterClick3sState = await ev(`JSON.stringify({vis:document.visibilityState,pipvis:__s4.pip&&__s4.pip.document.visibilityState,pip:!!documentPictureInPicture.window})`);
  await ev(`__s4.setup('A','pip')`); await sleep(1000);
  const state = () => ev(`JSON.stringify({openerVis:document.visibilityState,openerFocus:document.hasFocus(),pipVis:__s4.pip.document.visibilityState,pipFocus:__s4.pip.document.hasFocus()})`);
  const measure = async () => { const a = JSON.parse(await ev(`JSON.stringify({...__s4.cnt,t:performance.now()})`)); await sleep(5000); const b = JSON.parse(await ev(`JSON.stringify({...__s4.cnt,t:performance.now()})`)); const d = (b.t - a.t) / 1000; return { openerHz: +((b.opener - a.opener) / d).toFixed(1), pipHz: +((b.pip - a.pip) / d).toFixed(1), renderHz: +((b.render - a.render) / d).toFixed(1) }; };
  R.baseline = { state: await state(), hz: await measure() };
  // new tab in same window (foreground)
  const nt = await send('Target.createTarget', { url: 'about:blank' }); await sleep(1500);
  R.tabHidden = { state: await state(), hz: await measure() };
  await ev(`__s4.setup('A','opener')`); await sleep(800);
  R.tabHidden_pathA_openerRaf = { hz: await measure() };
  await ev(`__s4.setup('B','pip')`); await sleep(800);
  R.tabHidden_pathB_pipRaf = { hz: await measure() };
  await send('Target.closeTarget', { targetId: nt.targetId }); await sleep(1000);
  R.afterTabClosed = await state();
  // cover with a new window sized to opener
  const w1 = await send('Browser.getWindowForTarget', { targetId: t.targetId });
  const cov = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const w2 = await send('Browser.getWindowForTarget', { targetId: cov.targetId });
  await send('Browser.setWindowBounds', { windowId: w2.windowId, bounds: { ...w1.bounds, windowState: 'normal' } });
  await send('Target.activateTarget', { targetId: cov.targetId }); await sleep(2000);
  await ev(`__s4.setup('A','pip')`); await sleep(800);
  R.covered = { bounds: w1.bounds, state: await state(), pathA_pipRaf: await measure() };
  await ev(`__s4.setup('B','pip')`); await sleep(800);
  R.covered.pathB_pipRaf = await measure();
  await ev(`__s4.setup('A','opener')`); await sleep(800);
  R.covered.pathA_openerRaf = await measure();
  await send('Target.closeTarget', { targetId: cov.targetId }); await sleep(500);
  // pip.focus() when pip is focused vs opener (real focus state)
  await send('Page.bringToFront', {}, S); await sleep(500);
  R.finalState = await state();
  console.log(JSON.stringify(R, null, 1));
  try { await send('Browser.close'); } catch {}
} catch (e) { console.log('ERR', e); R.err = String(e); }
finally { fs.writeFileSync(path.join(here, 'results-native.json'), JSON.stringify(R, null, 2)); try { ws?.close(); } catch {} chrome.kill('SIGKILL'); fs.rmSync(prof, { recursive: true, force: true }); }
