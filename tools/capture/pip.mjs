// Float clip: the picture-in-picture tank over a neutral mock editor, dragged with two quick reversals
// so the water sloshes. The Tidal main window stays out of frame and out of the world; a reservoir
// vessel on the other display takes the rest of the litre, so the floating tank is part full.
// The tank's canvas is recorded by the main window that draws it; the editor is a screenshot of the
// mock page. Composes launch/clips/pip-float.mp4.   node tools/capture/pip.mjs [--no-compose]
import { BASE, ROOT, launch, openMain, openPopup, openVessel, sitOut, saveCapture, writeJob, clockOf, cleanDir, sleep, probe, stalls, displays, watch, setBounds } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 6.6;
const PIP = { w: 400, h: 300 };
const dir = `${ROOT}launch/raw/pip-float`;
cleanDir(dir);
const errors = [];
const { browser, context } = await launch();
try {
  const { main, area } = await openMain(context, errors);
  const editor = await openPopup(context, main, `${BASE}/launch/mock-editor/index.html`, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'editor' });
  watch(editor, 'editor', errors);
  await editor.waitForLoadState('load');
  await editor.evaluate(() => document.fonts.ready);
  await sleep(300);
  await editor.screenshot({ path: `${dir}/editor.png` });
  const ed = await editor.evaluate(() => {
    const dx = (outerWidth - innerWidth) / 2;
    return { outer: { x: screenX, y: screenY, w: outerWidth, h: outerHeight }, view: { x: screenX + dx, y: screenY + outerHeight - innerHeight - dx, w: innerWidth, h: innerHeight }, title: document.title };
  });
  console.log('editor', JSON.stringify(ed));

  // Float, from the main window's own control
  const floatButton = main.getByRole('button', { name: /float/i });
  const [pipPage] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }).catch(() => null), floatButton.click()]);
  await main.waitForFunction(() => window.tidalApp.float(), null, { timeout: 10000 });
  if (!pipPage) throw new Error('the floating window did not appear as a page');
  const cdp = await context.newCDPSession(pipPage);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const place = (x, y, size) => cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: Math.round(x), top: Math.round(y), ...(size ? { width: PIP.w, height: PIP.h } : {}) } });
  const start = { x: area.x + 260, y: area.y + 560 };
  await place(start.x, start.y, true);
  await sleep(500);
  const pipInfo = () => main.evaluate(() => { const f = window.tidalApp.float(); const w = f.window; return { slot: f.view.info.slot, ml: Math.round(f.view.ml), outer: [w.screenX, w.screenY, w.outerWidth, w.outerHeight], inner: [w.innerWidth, w.innerHeight], view: (({ x, y, w, h }) => ({ x, y, w, h }))(f.view.info), e: window.tidal.meta.energy[f.view.info.slot] }; });
  console.log('float window', JSON.stringify(await pipInfo()));

  // the reservoir (opened after the tank, so the tank is vessel 02): on the other display, never in frame, never touched by the tank
  // (a popup cannot place itself on another display without the Window Management permission, so CDP moves it)
  const other = displays.find((d) => d.x !== area.x || d.y !== area.y);
  if (other) {
    const res = await openVessel(context, main, { x: area.x + area.w - 1000, y: area.y + 20, w: 980, h: 260 }, 'reservoir', errors);
    await setBounds(context, res, { left: other.x + 40, top: other.y + 30, width: 980, height: 260 });
    await sleep(500);
    console.log('reservoir', JSON.stringify(await res.evaluate(() => [screenX, screenY, outerWidth, outerHeight, devicePixelRatio])));
  }

  await sitOut(main); // the litre rains into the tank and the reservoir, shared by width
  const t = Date.now();
  let quiet = null;
  for (;;) {
    const s = await pipInfo();
    if (s.e < 3e-5) quiet ??= Date.now(); else quiet = null;
    if ((Date.now() - t > 7000 && quiet && Date.now() - quiet > 1500) || Date.now() - t > 20000) { console.log('settled', JSON.stringify(s)); break; }
    if (process.env.PIP_DEBUG && Date.now() - t > 3000 && Date.now() - t < 3300) console.log('world', JSON.stringify(await main.evaluate(() => ({ ml: window.tidal.meta.ml.slice(0, 5).map(Math.round), rain: window.tidal.meta.rainMl, all: window.tidal.registry.all().map((v) => ({ s: v.slot, k: v.kind, x: Math.round(v.x), y: Math.round(v.y), w: v.w, h: v.h, a: v.active })), fps: window.tidal.stats.fps }))));
    await sleep(200);
  }

  await main.evaluate(() => {
    const f = window.tidalApp.float();
    return window.tidalCapture.startCanvas(f.window.document.querySelector('#tank'), {
      name: 'pip',
      rect: () => { const i = window.tidalApp.float().view.info; return { x: i.x, y: i.y, w: i.w, h: i.h }; },
      ml: () => window.tidalApp.float()?.view.ml ?? 0,
      slot: () => window.tidalApp.float()?.view.info.slot ?? -1,
    });
  });
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;

  // the drag: rest, a smooth pull to the right, two quick reversals, a slower drift back, rest
  const keys = [
    [0, 0, 0], [0.6, 0, 0], [2.2, 800, -80], [2.45, 640, -60], [2.75, 860, -90], [3.0, 780, -80], [4.4, 560, 40], [SECONDS, 560, 40],
  ];
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const pathAt = (s) => {
    for (let i = 1; i < keys.length; i++) {
      const [ta, xa, ya] = keys[i - 1], [tb, xb, yb] = keys[i];
      if (s <= tb) { const u = ease(Math.min(1, Math.max(0, (s - ta) / (tb - ta)))); return [xa + (xb - xa) * u, ya + (yb - ya) * u]; }
    }
    return keys[keys.length - 1].slice(1);
  };
  const offset = Date.now() - (await clockOf(main)); // node clock minus page clock
  let last = '';
  for (;;) {
    const s = (Date.now() - offset - t0) / 1000;
    if (s > SECONDS + 0.3) break;
    const [dx, dy] = pathAt(Math.max(0, s));
    const key = `${Math.round(dx)},${Math.round(dy)}`;
    if (key !== last) { await place(start.x + dx, start.y + dy); last = key; }
    await sleep(Math.max(1, 16.7 - ((Date.now() - offset - t0) % 16.7)));
  }

  const c = await saveCapture(main, `${dir}/pip`, 'pip');
  console.log('pip', JSON.stringify(probe(c.file)), 'in clip', JSON.stringify(stalls(c.meta, t0, t0 + SECONDS * 1000)), 'title', c.meta.log[0].title, 'outer', JSON.stringify(c.meta.log[0].outer), 'view', JSON.stringify((({ x, y, w, h }) => ({ x, y, w, h }))(c.meta.log[0])));
  writeJob(dir, {
    name: 'pip-float', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'editor',
    windows: [
      { id: 'editor', kind: 'image', file: 'editor.png', z: 0, dark: true, outer: ed.outer, view: ed.view, title: ed.title },
      // its own chrome shows the main window's numbers (see the report), so the label comes from the log
      { id: 'pip', z: 1, titleBar: 34, relabel: true },
    ],
  });
} finally {
  await browser.close();
}
if (errors.length) console.log('PAGE ERRORS\n' + [...new Set(errors)].slice(0, 10).join('\n'));
if (!process.argv.includes('--no-compose')) await compose(`${dir}/job.json`, `${ROOT}launch/clips/pip-float.mp4`);
