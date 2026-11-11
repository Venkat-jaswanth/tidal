// Float clip: the picture-in-picture tank over a neutral mock editor, dragged with two quick reversals
// so the water sloshes. The Tidal main window stays out of frame and out of the world; a reservoir
// vessel on another display takes the rest of the litre, so the floating tank is part full (with one
// display, the tank is made larger and takes it all). The tank's canvas is recorded by the main window
// that draws it; the editor is a screenshot of the mock page. Composes launch/clips/pip-float.mp4.
// node tools/capture/pip.mjs [--no-compose | --compose-only]          env CAPTURE_ATTEMPTS (default 3)
import { BASE, ROOT, openMain, openPopup, openVessel, sitOut, waitForRest, logVolumes, readVolumes, saveCapture, writeJob, clockOf, cleanDir, sleep, probe,
  displays, watch, setBounds, checkLog, checkHolds, checkVolume, checkOutput, shoot, finish, lastTake, Problem } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 6.6;
const dir = `${ROOT}launch/raw/pip-float`;
const OUT = `${ROOT}launch/clips/pip-float.mp4`;
// the drag: rest, a smooth pull to the right, two quick reversals, a slower drift back, rest
const KEYS = [[0, 0, 0], [0.6, 0, 0], [2.2, 800, -80], [2.45, 640, -60], [2.75, 860, -90], [3.0, 780, -80], [4.4, 560, 40], [SECONDS, 560, 40]];

const take = process.argv.includes('--compose-only') ? lastTake(dir) : await shoot('pip-float', async ({ context, errors }) => {
  cleanDir(dir);
  const problems = [];
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

  // Float, from the main window's own control
  const [pipPage] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }).catch(() => null), main.getByRole('button', { name: /float/i }).click()]);
  await main.waitForFunction(() => window.tidalApp.float(), null, { timeout: 10000 });
  if (!pipPage) throw new Problem('the floating window did not appear as a page');
  const other = displays.find((d) => d.x !== area.x || d.y !== area.y);
  const PIP = other ? { w: 400, h: 300 } : { w: 640, h: 470 };
  const cdp = await context.newCDPSession(pipPage);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const place = (x, y, size) => cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: Math.round(x), top: Math.round(y), ...(size ? { width: PIP.w, height: PIP.h } : {}) } });
  const start = { x: area.x + 260, y: area.y + 560 };
  await place(start.x, start.y, true);
  await sleep(500);

  // the reservoir (opened after the tank, so the tank is vessel 02): on the other display, never in
  // frame, never touched by the tank. A popup cannot place itself on another display without the Window
  // Management permission, so CDP moves it.
  if (other) {
    const res = await openVessel(context, main, { x: area.x + area.w - 1000, y: area.y + 20, w: 980, h: 260 }, 'reservoir', errors);
    await setBounds(context, res, { left: other.x + 40, top: other.y + 30, width: 980, height: 260 });
    await sleep(500);
    const at = await res.evaluate(() => [screenX, screenY]);
    if (at[0] !== other.x + 40 || at[1] !== other.y + 30) throw new Problem(`the reservoir did not move to the other display (at ${at})`);
  }
  await sitOut(main, true); // the litre rains into the tank (and the reservoir), shared by width
  await waitForRest(main, { afterMs: 5000 });
  const pipInfo = () => main.evaluate(() => { const f = window.tidalApp.float(); const w = f.window; return { slot: f.view.info.slot, ml: f.view.ml, outer: [w.screenX, w.screenY, w.outerWidth, w.outerHeight], inner: [w.innerWidth, w.innerHeight] }; });
  const before = await pipInfo();
  console.log('floating tank', JSON.stringify(before));

  await main.evaluate(() => {
    const f = window.tidalApp.float();
    return window.tidalCapture.startCanvas(f.window.document.querySelector('#tank'), {
      name: 'pip',
      rect: () => { const i = window.tidalApp.float().view.info; return { x: i.x, y: i.y, w: i.w, h: i.h }; },
      ml: () => window.tidalApp.float()?.view.ml ?? 0,
      slot: () => window.tidalApp.float()?.view.info.slot ?? -1,
    });
  });
  await logVolumes(main);
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;
  const t1 = t0 + SECONDS * 1000;
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const pathAt = (s) => {
    for (let i = 1; i < KEYS.length; i++) {
      const [ta, xa, ya] = KEYS[i - 1], [tb, xb, yb] = KEYS[i];
      if (s <= tb) { const u = ease(Math.min(1, Math.max(0, (s - ta) / (tb - ta)))); return [xa + (xb - xa) * u, ya + (yb - ya) * u]; }
    }
    return KEYS[KEYS.length - 1].slice(1);
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
  const volumes = await readVolumes(main);
  const c = await saveCapture(main, `${dir}/pip`, 'pip');

  // ---- checks
  const log = checkLog('floating tank', c.meta, { t0, from: t0, to: t1, liquid: 'water', sound: false });
  problems.push(...log.problems);
  const end = KEYS[KEYS.length - 1];
  problems.push(...checkHolds('floating tank', c.meta, [
    { from: t0, to: t0 + KEYS[1][0] * 1000, x: start.x, y: start.y, w: PIP.w, h: PIP.h },
    { from: t0 + KEYS[KEYS.length - 2][0] * 1000, to: t1, x: start.x + end[1], y: start.y + end[2], w: PIP.w, h: PIP.h },
  ], t0));
  problems.push(...checkVolume(volumes, t0 - 500, t1, t0));
  if (before.ml < 150 || before.ml > 0.85 * (before.inner[0] * before.inner[1]) / 220) problems.push(`the tank holds ${Math.round(before.ml)} mL: too little to slosh, or too full`);
  // its own label must name it and give its volume
  const shown = c.meta.texts.at(-1)?.items.map((i) => i.text) ?? [];
  const name = `VESSEL ${String(before.slot + 1).padStart(2, '0')}`;
  // the readout counts with a spring and rounds its own way: within 1 mL of the volume
  const ml = c.meta.log.at(-1).ml;
  const readout = shown.map(Number).filter((v) => Number.isInteger(v) && Math.abs(v - ml) <= 1.5);
  if (!shown.includes(name) || !readout.length) problems.push(`the tank's label reads ${JSON.stringify(shown.slice(0, 8))}, expected ${name} and ${Math.round(ml)} ± 1`);
  console.log('pip', JSON.stringify(probe(c.file)), 'worst stall in clip', log.worst, 'ms; label', JSON.stringify(shown.filter((t) => /VESSEL|^\d+$/.test(t)).slice(0, 3)));

  writeJob(dir, {
    name: 'pip-float', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'editor',
    windows: [
      { id: 'editor', kind: 'image', file: 'editor.png', z: 0, dark: true, outer: ed.outer, view: ed.view, title: ed.title },
      { id: 'pip', z: 1, titleBar: 34 },
    ],
  });
  return { problems, worst: log.worst };
});

if (process.argv.includes('--no-compose')) process.exit(0);
const composed = await compose(`${dir}/job.json`, OUT);
const out = checkOutput(OUT, { min: 5, max: 8, audio: false });
finish(dir, 'pip-float', { output: out.facts, worstStallMs: take.worst, attempts: take.attempts, rejected: take.rejected }, [...composed.problems, ...out.problems]);
