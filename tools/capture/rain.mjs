// Rain on close: a vessel high on the stage holds the litre; two vessels stand apart beneath it. The
// upper one closes itself and its water rains into the two below. Composes launch/clips/rain-on-close.mp4.
// node tools/capture/rain.mjs [--no-compose]
import { BASE, ROOT, launch, openMain, openPopup, openVessel, sitOut, settle, saveCapture, writeJob, clockOf, cleanDir, sleep, probe, stalls } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 6.5;
const CLOSE_AT = 1.2;
const dir = `${ROOT}launch/raw/rain-on-close`;
cleanDir(dir);
const errors = [];
const { browser, context } = await launch();
try {
  const { main, area } = await openMain(context, errors);
  await openPopup(context, main, `${BASE}/?stage&capture`, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'tidal-stage' });
  const floor = area.y + area.h;
  const mid = area.x + Math.round(area.w / 2);
  const U = { x: mid - 320, y: area.y + 60, w: 640, h: 507 };
  const L1 = { x: mid - 40 - 420, y: floor - 407, w: 420, h: 407 };
  const L2 = { x: mid + 40, y: floor - 407, w: 420, h: 407 };
  // the upper vessel opens alone and takes the whole litre; the lower two open empty afterwards
  const upper = await openVessel(context, main, U, 'U', errors);
  await sitOut(main);
  const rest = await settle(upper, { minMs: 7000 });
  const low1 = await openVessel(context, main, L1, 'L1', errors);
  const low2 = await openVessel(context, main, L2, 'L2', errors);
  await sleep(1500);
  console.log('filled', JSON.stringify(rest), JSON.stringify(await Promise.all([upper, low1, low2].map((p) => p.evaluate(() => Math.round(window.tidal.ml))))));

  for (const p of [upper, low1, low2]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;
  while ((await clockOf(main)) < t0 + CLOSE_AT * 1000) await sleep(5);
  // the upper window stops its recording, hands it to the main window and closes itself
  const closedAt = await upper.evaluate(async () => {
    const at = await window.tidalCapture.handOff('U');
    setTimeout(() => window.close(), 0);
    return at;
  });
  console.log('U closed at clip time', ((closedAt - t0) / 1000).toFixed(3));
  const samples = [];
  while ((await clockOf(main)) < t0 + (SECONDS + 0.4) * 1000) {
    samples.push(await main.evaluate(() => ({ t: performance.timeOrigin + performance.now(), ml: window.tidal.meta.ml.slice(0, 5).map(Math.round), rain: Math.round(window.tidal.meta.rainMl) })));
    await sleep(500);
  }
  console.log('volumes', samples.map((s) => `${((s.t - t0) / 1000).toFixed(1)}s ${s.ml.join('/')} rain ${s.rain}`).join(' | '));

  await main.waitForFunction(() => window.tidalCapture.results.has('U'), null, { timeout: 10000 });
  const u = await saveCapture(main, `${dir}/U`, 'U', { stop: false });
  console.log('U', JSON.stringify(probe(u.file)), 'in clip', JSON.stringify(stalls(u.meta, t0, closedAt)));
  for (const [id, p] of [['L1', low1], ['L2', low2]]) {
    const c = await saveCapture(p, `${dir}/${id}`);
    console.log(id, JSON.stringify(probe(c.file)), 'in clip', JSON.stringify(stalls(c.meta, t0, t0 + SECONDS * 1000)));
  }
  writeJob(dir, {
    name: 'rain-on-close', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [{ id: 'U', z: 0, visibleUntil: closedAt }, { id: 'L1', z: 1 }, { id: 'L2', z: 2 }],
    closedAt,
  });
} finally {
  await browser.close();
}
if (errors.length) console.log('PAGE ERRORS\n' + [...new Set(errors)].slice(0, 10).join('\n'));
if (!process.argv.includes('--no-compose')) await compose(`${dir}/job.json`, `${ROOT}launch/clips/rain-on-close.mp4`);
