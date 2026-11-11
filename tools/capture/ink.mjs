// Ink mixing clip: two vessels on the stage, one ultramarine, one cadmium orange, pushed together; the
// raised one pours into the other and the colours swirl. Composes launch/clips/ink-mix.mp4.
// node tools/capture/ink.mjs [--no-compose | --compose-only]          env CAPTURE_ATTEMPTS (default 3)
import { ROOT, openMain, openStage, openVessel, sitOut, waitForRest, logVolumes, readVolumes, saveCapture, writeJob, clockOf, cleanDir, sleep, probe,
  checkLog, checkHolds, checkVolume, checkOutput, inkShares, dyeCensus, shoot, finish, lastTake } from './lib.mjs';
import { compose } from './compose.mjs';

const SECONDS = 7;
const PUSH = [0.8, 0.6];     // starts at, lasts (s)
const SHAKE = [3.6, 0.64];
const dir = `${ROOT}launch/raw/ink-mix`;
const OUT = `${ROOT}launch/clips/ink-mix.mp4`;

const take = process.argv.includes('--compose-only') ? lastTake(dir) : await shoot('ink-mix', async ({ context, errors }) => {
  cleanDir(dir);
  const problems = [];
  const { main, area } = await openMain(context, errors);
  await openStage(context, main, area, errors);
  const floor = area.y + area.h;
  // L stands on the floor; R is smaller and stands 140 px higher, so when they touch R pours into L
  const L = { x: area.x + 520, y: floor - 420, w: 460, h: 420 };
  const R = { x: area.x + 980 + 260, y: floor - 140 - 380, w: 420, h: 380 };
  const rTouch = area.x + 980;
  const left = await openVessel(context, main, L, 'L', errors);
  const right = await openVessel(context, main, R, 'R', errors);
  await sitOut(main, true); // the main window's litre rains into the two, shared by width
  await waitForRest(main, { afterMs: 3000 });
  await main.evaluate(() => window.tidal.command({ type: 'cmd', cmd: 'liquid', value: 'ink' }));
  await sleep(3000);
  const filled = await Promise.all([left, right].map((p) => p.evaluate(() => ({ slot: window.tidal.slot, ml: Math.round(window.tidal.ml), liquid: window.tidal.liquid.id }))));
  console.log('filled', JSON.stringify(filled));
  if (filled.some((f) => f.ml < 300)) problems.push(`a vessel holds too little to show its ink before they meet: ${JSON.stringify(filled)}`);

  for (const p of [left, right]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await logVolumes(main);
  await sleep(400);
  const t0 = (await clockOf(main)) + 300;
  const t1 = t0 + SECONDS * 1000;
  // R moves itself: a push into contact, then a small vertical shake that keeps the edge in contact
  await right.evaluate(([t0, x0, x1, y, push, shake]) => {
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
    run(t0 + push[0] * 1000, push[1] * 1000, (u) => moveTo(Math.round(x0 + (x1 - x0) * ease(u)), y));
    run(t0 + shake[0] * 1000, shake[1] * 1000, (u) => moveTo(x1, Math.round(y + 16 * Math.sin(u * Math.PI * 6) * (1 - u))));
  }, [t0, R.x, rTouch, R.y, PUSH, SHAKE]);
  // what the simulation says each vessel holds: once before they meet, then while they mix
  const census = [];
  for (const s of [0.4, 2, 3, 4, 5]) {
    while ((await clockOf(main)) < t0 + s * 1000) await sleep(20);
    census.push({ s, ...(await dyeCensus(main)) });
  }
  while ((await clockOf(main)) < t1 + 400) await sleep(250);
  const volumes = await readVolumes(main);
  const caps = {};
  for (const [id, p] of [['L', left], ['R', right]]) caps[id] = await saveCapture(p, `${dir}/${id}`);

  // ---- checks
  const want = { t0, from: t0, to: t1, liquid: 'ink', sound: false };
  const logs = Object.fromEntries(Object.entries(caps).map(([id, c]) => [id, checkLog(id, c.meta, want)]));
  for (const l of Object.values(logs)) problems.push(...l.problems);
  const at = (s) => t0 + s * 1000;
  problems.push(...checkHolds('L', caps.L.meta, [{ from: t0, to: t1, ...L }], t0));
  problems.push(...checkHolds('R', caps.R.meta, [
    { from: t0, to: at(PUSH[0]), ...R },
    { from: at(PUSH[0] + PUSH[1]), to: at(SHAKE[0]), ...R, x: rTouch },
    { from: at(SHAKE[0] + SHAKE[1]), to: t1, ...R, x: rTouch },
  ], t0));
  problems.push(...checkVolume(volumes, t0 - 500, t1, t0));
  // the inks, from the simulation: each vessel one ink before they meet, then the other ink in L
  const [sL, sR] = filled.map((f) => f.slot);
  const ink = (c, slot) => c.by?.[slot] ?? { first: 0, second: 0 };
  const b0 = census[0];
  const own = (c) => (c.first >= 0.95 ? 'first' : c.second >= 0.95 ? 'second' : null);
  const inkL = own(ink(b0, sL)), inkR = own(ink(b0, sR));
  if (!inkL || !inkR || inkL === inkR) problems.push(`before they meet the vessels do not hold one ink each: L ${JSON.stringify(ink(b0, sL))}, R ${JSON.stringify(ink(b0, sR))}`);
  else for (const c of census.slice(1)) {
    const l = ink(c, sL);
    if (l[inkR] < 0.03 || l[inkL] < 0.3) problems.push(`no mixing in L at ${c.s} s: ${Math.round(l[inkL] * 100)} % its own ink, ${Math.round(l[inkR] * 100)} % R's`);
  }
  console.log('inks by slot (share of the first / second ink):', census.map((c) => `${c.s}s L ${ink(c, sL).first}/${ink(c, sL).second} R ${ink(c, sR).first}/${ink(c, sR).second}`).join(' · '));
  for (const [id, c] of Object.entries(caps)) console.log(id, JSON.stringify(probe(c.file)), 'worst stall in clip', logs[id].worst, 'ms');
  writeJob(dir, {
    name: 'ink-mix', width: 1920, height: 1080, fps: 60, t0, duration: SECONDS,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [{ id: 'L', z: 0 }, { id: 'R', z: 1 }],
    regions: { L: { x: L.x - area.x, y: L.y + 67 - area.y + Math.round((1080 - area.h) / 2), w: L.w, h: L.h - 67 }, R: { x: R.x - area.x, y: R.y + 67 - area.y + Math.round((1080 - area.h) / 2), w: R.w, h: R.h - 67 } },
  });
  return { problems, worst: Math.max(...Object.values(logs).map((l) => l.worst)) };
});

if (process.argv.includes('--no-compose')) process.exit(0);
const composed = await compose(`${dir}/job.json`, OUT);
const out = checkOutput(OUT, { min: 5, max: 8, audio: false });
const problems = [...composed.problems, ...out.problems];
// the colours must read on film: one vessel orange and one blue before they meet, then both colours
// swirling in the vessel that receives the pour for at least 3 s
const { regions } = (await import(`${dir}/job.json`, { with: { type: 'json' } })).default;
const lower = (r, f = 0.55) => ({ x: r.x + 4, y: r.y + Math.round(r.h * (1 - f)), w: r.w - 8, h: Math.round(r.h * f) - 4 });
const before = { L: inkShares(OUT, 0.5, lower(regions.L)), R: inkShares(OUT, 0.5, lower(regions.R)) };
const solo = (s) => (s.orange > 0.3 && s.blue < 0.05 ? 'orange' : s.blue > 0.3 && s.orange < 0.05 ? 'blue' : 'mixed');
console.log('before they meet:', JSON.stringify(before));
if (new Set([solo(before.L), solo(before.R)]).size !== 2 || solo(before.L) === 'mixed' || solo(before.R) === 'mixed') problems.push(`before they meet the two vessels are not one orange and one blue: ${JSON.stringify(before)}`);
const swirl = [];
for (const s of [2.0, 3.0, 4.0, 5.0]) {
  const v = inkShares(OUT, s, lower(regions.L, 0.8));
  swirl.push({ s, ...v });
  if (v.orange < 0.02 || v.blue < 0.02) problems.push(`no visible swirl in L at ${s} s (orange ${(v.orange * 100).toFixed(1)} %, blue ${(v.blue * 100).toFixed(1)} %)`);
}
console.log('swirl in L:', JSON.stringify(swirl.map((v) => ({ s: v.s, orange: Math.round(v.orange * 100), blue: Math.round(v.blue * 100) }))));
finish(dir, 'ink-mix', { output: out.facts, worstStallMs: take.worst, attempts: take.attempts, rejected: take.rejected, inks: { before, swirl } }, problems);
