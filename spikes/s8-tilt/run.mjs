import { chromium, webkit, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5173/spikes/s8-tilt/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const info = {};
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;
const check = (suite, name, ok, detail = '') => { results.push({ suite, name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' [' + suite + '] ' + name + (detail ? '  -> ' + detail : '')); };
const tilt = (page) => page.evaluate(() => { const t = window.__tilt; return { mode: t.mode, permission: t.permission, g: { ...t.g }, beta: t.beta, gamma: t.gamma, angle: t.angle, oe: t.orientationEvents, me: t.motionEvents, shakes: t.shakes, fb: t.fallbackReason, permCalls: t.permCalls, permError: t.permError }; });
// WebKit: DeviceOrientationEvent/DeviceMotionEvent constructors throw "Illegal constructor" -> fall back to a plain Event with the fields defined on it.
const orient = (page, beta, gamma) => page.evaluate(([b, g]) => { let e; try { e = new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g, absolute: false }); } catch { e = new Event('deviceorientation'); Object.defineProperties(e, { alpha: { value: 0 }, beta: { value: b }, gamma: { value: g }, absolute: { value: false } }); } return window.dispatchEvent(e); }, [beta, gamma]);
const motion = (page, x, y, z) => page.evaluate(([x, y, z]) => { let e; try { e = new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x, y, z }, acceleration: null, rotationRate: null, interval: 16 }); } catch { e = new Event('devicemotion'); Object.defineProperties(e, { accelerationIncludingGravity: { value: { x, y, z } }, acceleration: { value: null }, rotationRate: { value: null }, interval: { value: 16 } }); } return window.dispatchEvent(e); }, [x, y, z]);
const stubInit = (mode) => `(() => { const rec = (v) => () => Promise.resolve(v);
  DeviceOrientationEvent.requestPermission = rec(${JSON.stringify(mode)}); DeviceMotionEvent.requestPermission = rec(${JSON.stringify(mode)}); })();`;
const drag = async (page, x0, y0, x1, y1) => { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); await sleep(100); };

async function fresh(browser, device, { stub } = {}) {
  const ctx = await browser.newContext({ ...devices[device] });
  if (stub) await ctx.addInitScript(stubInit(stub));
  const page = await ctx.newPage();
  await page.goto(URL);
  return { ctx, page };
}

async function suiteFor(label, browser, dev, devLandscape, { permStub = null } = {}) {
  const S = label;
  // ---- env
  {
    const { ctx, page } = await fresh(browser, dev, permStub ? { stub: permStub } : {});
    info[S + ' env'] = await page.evaluate(() => ({ ua: navigator.userAgent, gpu: !!navigator.gpu, secure: isSecureContext, hasDOE: typeof DeviceOrientationEvent, doeRequestPermission: typeof DeviceOrientationEvent !== 'undefined' ? typeof DeviceOrientationEvent.requestPermission : 'n/a',
      dmeRequestPermission: typeof DeviceMotionEvent !== 'undefined' ? typeof DeviceMotionEvent.requestPermission : 'n/a', angle: screen.orientation && screen.orientation.angle, orientType: screen.orientation && screen.orientation.type, windowOrientation: window.orientation, doeCtor: (() => { try { new DeviceOrientationEvent('deviceorientation', { beta: 1 }); return 'ok'; } catch (e) { return String(e); } })(), dmeCtor: (() => { try { new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 1, y: 2, z: 3 } }); return 'ok'; } catch (e) { return String(e); } })(), touchPoints: navigator.maxTouchPoints, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, ci: self.crossOriginIsolated }));
    console.log(S, JSON.stringify(info[S + ' env']));
    check(S, 'initial mode idle', (await tilt(page)).mode === 'idle');
    await ctx.close();
  }
  // ---- orientation + shake (portrait)
  {
    const { ctx, page } = await fresh(browser, dev, permStub ? { stub: permStub } : {});
    await page.tap('#enable'); await sleep(200);
    let t = await tilt(page);
    check(S, 'after enable: pending (permission ok)', t.mode === 'pending', JSON.stringify({ mode: t.mode, perm: t.permission, permCalls: t.permCalls }));
    if (permStub) check(S, 'iOS permission APIs invoked in user gesture (both)', t.permCalls.length === 2 && t.permCalls.every((c) => c.userActive === true), JSON.stringify(t.permCalls));
    await orient(page, 0, 0); t = await tilt(page);
    check(S, 'flat -> g=(0,0), mode orientation', near(t.g.x, 0) && near(t.g.y, 0) && t.mode === 'orientation', JSON.stringify(t.g));
    await orient(page, 0, 30); t = await tilt(page); check(S, 'gamma 30 -> gx=0.5', near(t.g.x, 0.5) && near(t.g.y, 0), JSON.stringify(t.g));
    await orient(page, 45, 0); t = await tilt(page); check(S, 'beta 45 -> gy=0.707', near(t.g.x, 0) && near(t.g.y, Math.SQRT1_2), JSON.stringify(t.g));
    await orient(page, -30, -30); t = await tilt(page); check(S, 'beta -30 gamma -30 -> (-0.5,-0.5)', near(t.g.x, -0.5) && near(t.g.y, -0.5), JSON.stringify(t.g));
    await orient(page, 90, 90); t = await tilt(page); check(S, 'beta 90 gamma 90 -> clamped to |g|=1 (0.707,0.707)', near(Math.hypot(t.g.x, t.g.y), 1) && near(t.g.x, Math.SQRT1_2), JSON.stringify(t.g));
    await orient(page, 170, -120); t = await tilt(page); check(S, 'out of range (170,-120) clamped, |g|<=1', Math.hypot(t.g.x, t.g.y) <= 1.0001, JSON.stringify(t.g));
    // null event ignored
    const before = await tilt(page);
    await page.evaluate(() => { const e = new Event('deviceorientation'); Object.defineProperties(e, { alpha: { value: null }, beta: { value: null }, gamma: { value: null } }); window.dispatchEvent(e); });
    t = await tilt(page); check(S, 'all-null orientation event ignored', t.oe === before.oe);
    // shake
    await motion(page, 0, 9.8, 0); await sleep(450); t = await tilt(page);
    check(S, 'motion at rest (9.8) -> no shake', t.shakes === 0 && t.me === 1, `shakes=${t.shakes} me=${t.me}`);
    await motion(page, 20, 20, 20); t = await tilt(page); check(S, 'jump to |a|=34.6 -> shake=1', t.shakes === 1, `shakes=${t.shakes} me=${t.me}`);
    await motion(page, 0, 9.8, 0); await motion(page, 25, 0, 25); await sleep(10); t = await tilt(page); check(S, 'second jump inside cooldown -> still 1', t.shakes === 1, `shakes=${t.shakes}`);
    await sleep(450); await motion(page, 0, 9.8, 0); await motion(page, 30, 0, 0); t = await tilt(page); check(S, 'after cooldown -> shake=2', t.shakes === 2, `shakes=${t.shakes}`);
    await motion(page, 0, 9.9, 0.3); await motion(page, 0.4, 9.7, 0.2); await sleep(450); t = await tilt(page); check(S, 'small jitter -> no extra shake', t.shakes === 2, `shakes=${t.shakes}`);
    // must not fall back after orientation seen
    await sleep(1700); t = await tilt(page); check(S, 'no touch fallback after orientation events seen', t.mode === 'orientation', t.mode);
    await ctx.close();
  }
  // ---- landscape angle
  {
    const { ctx, page } = await fresh(browser, devLandscape, permStub ? { stub: permStub } : {});
    const ang = await page.evaluate(() => ({ 'landscape-primary': 90, 'portrait-primary': 0 })[screen.orientation.type]);
    info[S + ' landscape raw angle/type'] = await page.evaluate(() => [screen.orientation.angle, screen.orientation.type, window.orientation]);
    info[S + ' landscape angle'] = ang;
    await page.tap('#enable'); await sleep(200);
    await orient(page, 0, 30); const t = await tilt(page);
    // angle 90: screen x = device y, screen y = -device x  -> gamma 30 => (0,-0.5)
    check(S, `landscape (screen.orientation.angle=${ang}): gamma 30 -> g follows rotated frame`, ang === 90 ? near(t.g.x, 0) && near(t.g.y, -0.5) : ang === 0 ? near(t.g.x, 0.5) : false, `angle=${ang} g=${JSON.stringify(t.g)}`);
    await orient(page, 30, 0); const t2 = await tilt(page);
    check(S, 'landscape: beta 30 -> screen x', ang === 90 ? near(t2.g.x, 0.5) && near(t2.g.y, 0) : true, JSON.stringify(t2.g));
    await ctx.close();
  }
  // ---- touch fallback (no events)
  {
    const { ctx, page } = await fresh(browser, dev, permStub ? { stub: permStub } : {});
    await page.tap('#enable'); const t0 = Date.now();
    await sleep(1100); let t = await tilt(page); check(S, 'fallback not yet active at 1.1s', t.mode === 'pending', t.mode);
    await sleep(700); t = await tilt(page); const dt = Date.now() - t0;
    check(S, 'fallback to touch after ~1.5s with no events', t.mode === 'touch', `mode=${t.mode} reason=${t.fb} at ~${dt}ms`);
    await drag(page, 100, 300, 160, 300); t = await tilt(page); check(S, 'mouse-drag right 60px -> g=(0.75,0)', near(t.g.x, 0.75, 0.05) && near(t.g.y, 0, 0.05), JSON.stringify(t.g));
    await drag(page, 100, 300, 100, 150); t = await tilt(page); check(S, 'drag up 150px -> g=(0,-1) clamped', near(t.g.x, 0, 0.05) && near(t.g.y, -1, 0.05), JSON.stringify(t.g));
    await drag(page, 200, 300, 140, 360); t = await tilt(page); check(S, 'drag down-left diag -> (-.5,.5)-ish unit-clamped', t.g.x < -0.4 && t.g.y > 0.4 && Math.hypot(t.g.x, t.g.y) <= 1.0001, JSON.stringify(t.g));
    // synthetic touch pointer events (what a real finger produces)
    await page.evaluate(() => { const o = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true }; window.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 150, clientY: 400 })); window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 150, clientY: 440 })); window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 150, clientY: 480 })); window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 150, clientY: 480 })); });
    t = await tilt(page); check(S, 'synthetic touch PointerEvents drag down 80px -> (0,1)', near(t.g.x, 0, 0.05) && near(t.g.y, 1, 0.05), JSON.stringify(t.g));
    // late orientation events take over again
    await orient(page, 0, 20); t = await tilt(page); check(S, 'late orientation event switches back to orientation mode', t.mode === 'orientation' && near(t.g.x, Math.sin(20 * Math.PI / 180)), `mode=${t.mode} g=${JSON.stringify(t.g)}`);
    if (browser.browserType().name() === 'chromium') {
      // real touch via CDP
      const ctx2 = await browser.newContext({ ...devices[dev] }); const p2 = await ctx2.newPage(); await p2.goto(URL); await p2.tap('#enable'); await sleep(1700);
      const cdp = await ctx2.newCDPSession(p2); const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      await tp('touchStart', 100, 300); await tp('touchMove', 100, 340); await tp('touchMove', 100, 380); await tp('touchEnd'); await sleep(100);
      const tt = await tilt(p2); check(S, 'CDP real touch drag down 80px -> (0,1)', tt.mode === 'touch' && near(tt.g.y, 1, 0.05) && near(tt.g.x, 0, 0.05), JSON.stringify(tt.g));
      await ctx2.close();
    }
    await ctx.close();
  }
}

// ================= Chromium / Pixel 7 =================
let b = await chromium.launch({ channel: 'chrome', headless: false });
try {
  info.chromeVersion = b.version();
  await suiteFor('chromium Pixel 7', b, 'Pixel 7', 'Pixel 7 landscape');
  // CDP sensor emulation
  const S = 'chromium CDP';
  const { ctx, page } = await fresh(b, 'Pixel 7');
  const cdp = await ctx.newCDPSession(page);
  await page.evaluate(() => { window.__raw = []; addEventListener('deviceorientation', (e) => window.__raw.push([e.alpha, e.beta, e.gamma, e.absolute])); });
  let t;
  try { await cdp.send('Emulation.setDeviceOrientationOverride', { alpha: 10, beta: 20, gamma: 30 }); info.legacyCdpOrientationOverride = 'accepted'; } catch (e) { info.legacyCdpOrientationOverride = 'REMOVED: ' + e.message; console.log('INFO legacy override:', info.legacyCdpOrientationOverride); }
  // Modern path: virtual sensors. deviceorientation = Rz(alpha)*Rx(beta)*Ry(gamma) quaternion on 'relative-orientation'.
  const q = (alpha, beta, gamma) => { const d = Math.PI / 180; const h = (v) => [Math.cos(v * d / 2), Math.sin(v * d / 2)];
    const [cz, sz] = h(alpha), [cx, sx] = h(beta), [cy, sy] = h(gamma);
    const mul = (a, b) => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w });
    return mul(mul({ w: cz, x: 0, y: 0, z: sz }, { w: cx, x: sx, y: 0, z: 0 }), { w: cy, x: 0, y: sy, z: 0 }); };
  try {
    for (const type of ['relative-orientation', 'absolute-orientation', 'accelerometer', 'gravity', 'linear-acceleration', 'gyroscope']) await cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type, metadata: { available: true } });
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'relative-orientation', reading: { quaternion: q(10, 20, 30) } });
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'absolute-orientation', reading: { quaternion: q(10, 20, 30) } });
    await page.tap('#enable');   // listener attached AFTER the virtual sensors exist
    await sleep(1200);
    t = await tilt(page); const raw2 = await page.evaluate(() => window.__raw.slice(-2));
    info.cdpSensorOrientation = { tilt: t, raw: raw2 };
    check(S, 'setSensorOverride relative-orientation delivers real deviceorientation (beta~20,gamma~30)', t.oe > 0 && raw2.length > 0 && Math.abs(raw2[raw2.length - 1][1] - 20) < 1 && Math.abs(raw2[raw2.length - 1][2] - 30) < 1, JSON.stringify({ oe: t.oe, raw2, g: t.g }));
    check(S, 'gravity follows virtual-sensor orientation (0.5, 0.342)', near(t.g.x, 0.5, 0.02) && near(t.g.y, Math.sin(20 * Math.PI / 180), 0.02), JSON.stringify(t.g));
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'relative-orientation', reading: { quaternion: q(0, -40, -10) } }); await sleep(700);
    t = await tilt(page); check(S, 'second reading updates gravity (beta -40)', near(t.g.y, Math.sin(-40 * Math.PI / 180), 0.03), JSON.stringify(t.g));
  } catch (e) { check(S, 'setSensorOverride relative-orientation', false, e.message); }
  try {
    await page.evaluate(() => { window.__mot = []; addEventListener('devicemotion', (e) => window.__mot.push(e.accelerationIncludingGravity ? [e.accelerationIncludingGravity.x, e.accelerationIncludingGravity.y, e.accelerationIncludingGravity.z] : null)); });
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'accelerometer', reading: { xyz: { x: 0, y: 9.8, z: 0 } } });
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'linear-acceleration', reading: { xyz: { x: 0, y: 0, z: 0 } } });
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'gyroscope', reading: { xyz: { x: 0, y: 0, z: 0 } } });
    await sleep(800);
    const mot = await page.evaluate(() => window.__mot.slice(-2)); info.cdpSensorMotion = mot; t = await tilt(page);
    check(S, 'setSensorOverride accelerometer delivers non-null devicemotion (y=9.8)', mot.length > 0 && mot.at(-1) && Math.abs(mot.at(-1)[1] - 9.8) < 0.5, JSON.stringify(mot));
    await cdp.send('Emulation.setSensorOverrideReadings', { type: 'accelerometer', reading: { xyz: { x: 30, y: 9.8, z: 0 } } }); await sleep(600); t = await tilt(page);
    check(S, 'virtual accelerometer jump triggers shake detection', t.shakes >= 1, `shakes=${t.shakes} me=${t.me}`);
  } catch (e) { check(S, 'setSensorOverride accelerometer', false, e.message); }
  await ctx.close();
  // clear override sanity: desktop (non-emulated) context gets no real events -> touch fallback
  const ctx3 = await b.newContext({ viewport: { width: 400, height: 700 } }); const p3 = await ctx3.newPage(); await p3.goto(URL); await p3.click('#enable'); await sleep(1800);
  t = await tilt(p3); check('chromium desktop (no emulation)', 'no sensor -> touch fallback', t.mode === 'touch', JSON.stringify({ mode: t.mode, oe: t.oe }));
  await ctx3.close();
} catch (e) { console.log('FATAL chromium', e); check('chromium', 'suite crashed', false, String(e)); } finally { await b.close(); }

// ================= WebKit / iPhone 15 =================
let w;
try {
  w = await webkit.launch();
  info.webkitVersion = w.version();
  const noStub = await fresh(w, 'iPhone 15');
  info['webkit no-stub env'] = await noStub.page.evaluate(() => ({ gpu: !!navigator.gpu, gpuType: typeof navigator.gpu, doeRP: typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission, dmeRP: typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission, secure: isSecureContext, ci: self.crossOriginIsolated, dpip: 'documentPictureInPicture' in window }));
  console.log('webkit native', JSON.stringify(info['webkit no-stub env']));
  await noStub.ctx.close();
  await suiteFor('webkit iPhone 15 (no requestPermission, native)', w, 'iPhone 15', 'iPhone 15 landscape');
  await suiteFor('webkit iPhone 15 (stub granted)', w, 'iPhone 15', 'iPhone 15 landscape', { permStub: 'granted' });
  // denied
  {
    const S = 'webkit iPhone 15 (stub denied)';
    const { ctx, page } = await fresh(w, 'iPhone 15', { stub: 'denied' });
    await page.tap('#enable'); await sleep(300); let t = await tilt(page);
    check(S, 'denied -> immediate touch fallback (no 1.5s wait)', t.mode === 'touch' && t.permission === 'denied' && t.fb === 'permission-denied', JSON.stringify({ mode: t.mode, perm: t.permission, fb: t.fb }));
    check(S, 'permission APIs invoked inside gesture', t.permCalls.length === 2 && t.permCalls.every((c) => c.userActive), JSON.stringify(t.permCalls));
    await orient(page, 0, 40); t = await tilt(page); check(S, 'denied: listeners not attached (orientation event ignored)', t.oe === 0 && t.mode === 'touch', JSON.stringify({ oe: t.oe, mode: t.mode }));
    await drag(page, 100, 300, 100, 360); t = await tilt(page); check(S, 'denied: drag fallback works', near(t.g.y, 0.75, 0.05), JSON.stringify(t.g));
    await ctx.close();
  }
  // orientation granted, motion denied; and rejected promise
  for (const [name, init, expectPerm] of [['orientation granted / motion denied', `DeviceOrientationEvent.requestPermission=()=>Promise.resolve('granted');DeviceMotionEvent.requestPermission=()=>Promise.resolve('denied');`, 'denied'], ['requestPermission rejects (NotAllowedError)', `DeviceOrientationEvent.requestPermission=()=>Promise.reject(new DOMException('x','NotAllowedError'));DeviceMotionEvent.requestPermission=()=>Promise.reject(new DOMException('x','NotAllowedError'));`, 'error']]) {
    const S = 'webkit iPhone 15 (' + name + ')';
    const ctx = await w.newContext({ ...devices['iPhone 15'] }); await ctx.addInitScript(init); const page = await ctx.newPage(); await page.goto(URL);
    await page.tap('#enable'); await sleep(300); const t = await tilt(page);
    check(S, 'treated as ' + expectPerm + ' -> touch fallback', t.permission === expectPerm && t.mode === 'touch', JSON.stringify({ perm: t.permission, mode: t.mode, err: t.permError }));
    await ctx.close();
  }
} catch (e) { console.log('FATAL webkit', e); check('webkit', 'suite crashed', false, String(e)); } finally { if (w) await w.close(); }

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify({ info, results, pass, total: results.length }, null, 2));
