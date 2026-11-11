// Rain on close: a vessel high on the stage holds the litre; two vessels stand apart beneath it. The
// upper one closes itself and its water rains into the two below. Composes launch/clips/rain-on-close.mp4.
// node tools/capture/rain.mjs [--no-compose | --compose-only]          env CAPTURE_ATTEMPTS (default 3)
import { ROOT, openMain, openStage, openVessel, sitOut, waitForRest, logVolumes, readVolumes, saveCapture, writeJob, clockOf, cleanDir, sleep, probe,
  checkLog, checkHolds, checkVolume, checkOutput, shoot, finish, lastTake } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 6.5;
const CLOSE_AT = 1.2;
const dir = `${ROOT}launch/raw/rain-on-close`;
const OUT = `${ROOT}launch/clips/rain-on-close.mp4`;

const take = process.argv.includes('--compose-only') ? lastTake(dir) : await shoot('rain-on-close', async ({ context, errors }) => {
  cleanDir(dir);
  const problems = [];
  const { main, area } = await openMain(context, errors);
  await openStage(context, main, area, errors);
  const floor = area.y + area.h;
  const mid = area.x + Math.round(area.w / 2);
  const U = { x: mid - 320, y: area.y + 60, w: 640, h: 507 };
  const L1 = { x: mid - 40 - 420, y: floor - 407, w: 420, h: 407 };
  const L2 = { x: mid + 40, y: floor - 407, w: 420, h: 407 };
  // the upper vessel opens alone and takes the whole litre; the lower two open empty afterwards
  const upper = await openVessel(context, main, U, 'U', errors);
  await sitOut(main, true);
  await waitForRest(main, { afterMs: 5000 });
  const low1 = await openVessel(context, main, L1, 'L1', errors);
  const low2 = await openVessel(context, main, L2, 'L2', errors);
  await sleep(1500);
  const filled = await Promise.all([upper, low1, low2].map((p) => p.evaluate(() => Math.round(window.tidal.ml))));
  console.log('filled', JSON.stringify(filled));
  if (filled[0] !== 1000 || filled[1] || filled[2]) problems.push(`the upper vessel should hold the litre and the lower two nothing: ${filled.join(' / ')} mL`);

  for (const p of [upper, low1, low2]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await logVolumes(main);
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;
  const t1 = t0 + SECONDS * 1000;
  while ((await clockOf(main)) < t0 + CLOSE_AT * 1000) await sleep(5);
  // the upper window stops its recording, hands it to the main window and closes itself
  const closedAt = await upper.evaluate(async () => {
    const at = await window.tidalCapture.handOff('U');
    setTimeout(() => window.close(), 0);
    return at;
  });
  while ((await clockOf(main)) < t1 + 400) await sleep(250);
  const volumes = await readVolumes(main);
  await main.waitForFunction(() => window.tidalCapture.results.has('U'), null, { timeout: 10000 });
  const caps = { U: await saveCapture(main, `${dir}/U`, 'U', { stop: false }) };
  for (const [id, p] of [['L1', low1], ['L2', low2]]) caps[id] = await saveCapture(p, `${dir}/${id}`);

  // ---- checks
  const want = { t0, liquid: 'water', sound: false };
  const logs = {
    U: checkLog('U', caps.U.meta, { ...want, from: t0, to: closedAt - 20 }),
    L1: checkLog('L1', caps.L1.meta, { ...want, from: t0, to: t1 }),
    L2: checkLog('L2', caps.L2.meta, { ...want, from: t0, to: t1 }),
  };
  for (const l of Object.values(logs)) problems.push(...l.problems);
  problems.push(...checkHolds('U', caps.U.meta, [{ from: t0, to: closedAt - 20, ...U }], t0));
  problems.push(...checkHolds('L1', caps.L1.meta, [{ from: t0, to: t1, ...L1 }], t0));
  problems.push(...checkHolds('L2', caps.L2.meta, [{ from: t0, to: t1, ...L2 }], t0));
  problems.push(...checkVolume(volumes, t0 - 500, t1, t0));
  // the rain: most of the litre in the air soon after the close, and both lower vessels filled by the end
  const after = volumes.filter((v) => v.t > closedAt && v.t < closedAt + 1500);
  const peakRain = Math.max(0, ...after.map((v) => v.rain));
  const end = volumes.filter((v) => v.t <= t1).at(-1);
  const slots = await Promise.all([low1, low2].map((p) => p.evaluate(() => window.tidal.slot).catch(() => -1)));
  const lows = slots.map((s) => Math.round(end?.ml[s] ?? 0));
  console.log(`U closed at ${((closedAt - t0) / 1000).toFixed(3)} s; rain in the air peaked at ${Math.round(peakRain)} mL; lower vessels end with ${lows.join(' / ')} mL`);
  if (peakRain < 300) problems.push(`hardly any rain after the close (peak ${Math.round(peakRain)} mL in the air)`);
  if (lows.some((v) => v < 350)) problems.push(`the lower vessels did not fill: ${lows.join(' / ')} mL at the end`);
  for (const [id, c] of Object.entries(caps)) console.log(id, JSON.stringify(probe(c.file)), 'worst stall in clip', logs[id].worst, 'ms');
  writeJob(dir, {
    name: 'rain-on-close', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [{ id: 'U', z: 0, visibleUntil: closedAt }, { id: 'L1', z: 1 }, { id: 'L2', z: 2 }],
    closedAt,
  });
  return { problems, worst: Math.max(...Object.values(logs).map((l) => l.worst)) };
});

if (process.argv.includes('--no-compose')) process.exit(0);
const composed = await compose(`${dir}/job.json`, OUT);
const out = checkOutput(OUT, { min: 5, max: 8, audio: false });
finish(dir, 'rain-on-close', { output: out.facts, worstStallMs: take.worst, attempts: take.attempts, rejected: take.rejected }, [...composed.problems, ...out.problems]);
