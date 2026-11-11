// Ink mixing clip: two vessels on the stage, one ultramarine, one cadmium orange, pushed together; the
// raised one pours into the other and the colours swirl. Composes launch/clips/ink-mix.mp4.
// node tools/capture/ink.mjs [--no-compose]
import { BASE, ROOT, launch, openMain, openPopup, openVessel, sitOut, settle, saveCapture, writeJob, clockOf, cleanDir, sleep, probe, stalls } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 7;
const dir = `${ROOT}launch/raw/ink-mix`;
cleanDir(dir);
const errors = [];
const { browser, context } = await launch();
try {
  const { main, area } = await openMain(context, errors);
  await openPopup(context, main, `${BASE}/?stage&capture`, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'tidal-stage' });
  const floor = area.y + area.h;
  // L stands on the floor; R is smaller and stands 140 px higher, so when they touch R pours into L
  const L = { x: area.x + 520, y: floor - 420, w: 460, h: 420 };
  const R = { x: area.x + 980 + 260, y: floor - 140 - 380, w: 420, h: 380 };
  const rTouch = area.x + 980;
  const left = await openVessel(context, main, L, 'L', errors);
  const right = await openVessel(context, main, R, 'R', errors);
  await sitOut(main); // the main window's litre rains into the two, shared by width
  const rest = await settle(left, { minMs: 6000 });
  await settle(right, { minMs: 0 });
  await main.evaluate(() => window.tidal.command({ type: 'cmd', cmd: 'liquid', value: 'ink' }));
  await settle(left, { minMs: 2500, quietMs: 1000 });
  console.log('filled', JSON.stringify(rest), JSON.stringify(await Promise.all([left, right].map((p) => p.evaluate(() => ({ slot: window.tidal.slot, ml: Math.round(window.tidal.ml), liquid: window.tidal.liquid.id }))))));

  for (const p of [left, right]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;
  // R moves itself: a 0.6 s push into contact at 0.8 s, then a small vertical shake at 3.6 s
  await right.evaluate(([t0, x0, x1, y]) => {
    const now = () => performance.timeOrigin + performance.now();
    const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    const run = (start, ms, fn) => {
      const step = () => {
        const u = Math.min(1, Math.max(0, (now() - start) / ms));
        if (now() >= start) fn(u);
        if (u < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    run(t0 + 800, 600, (u) => moveTo(Math.round(x0 + (x1 - x0) * ease(u)), y));
    run(t0 + 3600, 640, (u) => moveTo(x1, Math.round(y + 16 * Math.sin(u * Math.PI * 6) * (1 - u))));
  }, [t0, R.x, rTouch, R.y]);
  while ((await clockOf(main)) < t0 + (SECONDS + 0.4) * 1000) await sleep(250);
  console.log('end', JSON.stringify(await Promise.all([left, right].map((p) => p.evaluate(() => ({ ml: Math.round(window.tidal.ml), outer: [screenX, screenY] }))))));

  for (const [id, p] of [['L', left], ['R', right]]) {
    const c = await saveCapture(p, `${dir}/${id}`);
    console.log(id, JSON.stringify(probe(c.file)), 'in clip', JSON.stringify(stalls(c.meta, t0, t0 + SECONDS * 1000)));
  }
  writeJob(dir, {
    name: 'ink-mix', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [{ id: 'L', z: 0 }, { id: 'R', z: 1 }],
  });
} finally {
  await browser.close();
}
if (errors.length) console.log('PAGE ERRORS\n' + [...new Set(errors)].slice(0, 10).join('\n'));
if (!process.argv.includes('--no-compose')) await compose(`${dir}/job.json`, `${ROOT}launch/clips/ink-mix.mp4`);
