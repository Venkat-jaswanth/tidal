// The launch film (spec §3): records the two-vessel 'film' choreography on the stage and composes
// launch/hero.mp4. Every vessel records itself (canvas capture) and logs where it is; nothing records
// the screen. Each take is checked and thrown away if it is not clean (see lib.mjs, shoot()).
// node tools/capture/hero.mjs [--no-compose | --compose-only]          env CAPTURE_ATTEMPTS (default 3)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ROOT, openMain, openStage, openVessel, reach, sitOut, waitForRest, logVolumes, readVolumes, saveCapture, writeJob, clockOf, cleanDir, sleep, probe,
  checkLog, holdsOf, checkHolds, checkVolume, checkOutput, labelDiff, shoot, finish, lastTake } from './lib.mjs';
import { compose, still } from './compose.mjs';

const dir = `${ROOT}launch/raw/hero`;
const OUT = `${ROOT}launch/hero.mp4`;

const take = process.argv.includes('--compose-only') ? lastTake(dir) : await shoot('hero', async ({ context, errors }) => {
  cleanDir(dir);
  const problems = [];
  const { main, area } = await openMain(context, errors);
  await openStage(context, main, area, errors);
  const stage = { x: area.x, y: area.y, w: area.w, h: area.h };
  const film = await main.evaluate(async (stage) => {
    const m = await import('/src/perform/timeline.ts');
    const track = [];
    for (let i = 0; i <= m.HERO_SECONDS * 50; i++) track.push({ s: i / 50, a: m.heroPoseAt(0, i / 50, stage), b: m.heroPoseAt(1, i / 50, stage) });
    return { a: m.heroPoseAt(0, 0, stage), b: m.heroPoseAt(1, m.HERO_SECOND_OPENS, stage), seconds: m.HERO_SECONDS, opens: m.HERO_SECOND_OPENS, track };
  }, stage);
  console.log('work area', JSON.stringify(area), 'A', JSON.stringify(film.a), 'B', JSON.stringify(film.b));

  // vessel A; the new world pours into the main window, which then sits out, so the litre rains into A
  const A = await openVessel(context, main, film.a, 'A', errors);
  await sitOut(main, true);
  const rest = await waitForRest(main, { afterMs: 6000 });
  const restA = await A.evaluate(() => ({ ml: window.tidal.ml, slot: window.tidal.slot, energy: window.tidal.meta.energy[window.tidal.slot] }));
  console.log('at rest', JSON.stringify(rest), 'A', JSON.stringify(restA));
  if (Math.round(restA.ml) !== 1000) problems.push(`A holds ${restA.ml.toFixed(1)} mL before the film, not 1000`);

  // vessel B opens sitting out, parked clear of A, and is put in its place; it joins at 2 s
  const B = await openVessel(context, main, { ...film.b, x: area.x + area.w - film.b.w - 40, y: area.y + 40 }, 'B', errors, { inactive: true });
  await B.evaluate(([x, y]) => moveTo(x, y), [film.b.x, film.b.y]);
  await reach(B, 'B', film.b);
  const bIndex = await main.evaluate(() => window.__opened.length - 1);
  await sleep(1000);
  const bReady = await B.evaluate(() => ({ ml: window.tidal.ml, active: window.tidal.registry.self.active }));
  if (bReady.active || bReady.ml > 0.5) problems.push(`B is not sitting out empty before it joins (${JSON.stringify(bReady)})`);

  // sound through the app's own control, so every window's chrome reads SOUND ON; the leader plays it
  await main.getByRole('button', { name: /sound/i }).click();
  await main.waitForFunction(() => window.tidalApp.audio.enabled && window.tidal.isLeader, null, { timeout: 5000 });
  await main.evaluate(() => window.tidalCapture.startAudio());
  for (const p of [A, B]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await sleep(500);
  // screenshots of the two pages (their own content only), to check the redrawn labels against
  const shots = {};
  for (const [id, p] of [['A', A], ['B', B]]) { shots[id] = await clockOf(p); await p.screenshot({ path: `${dir}/${id}-page.png` }); }
  await logVolumes(main);
  await sleep(300);

  // the film: locked, so nothing interrupts it; B comes into the world and joins at HERO_SECOND_OPENS
  const t0 = await main.evaluate(([bi, opens]) => {
    const app = window.tidalApp;
    app.performer.start('film', true);
    const run = app.performer.current;
    const b = window.__opened[bi];
    setTimeout(() => {
      b.tidalApp.sitOut(false);
      app.performer.join(b.tidal.id, 1);
      window.__bJoinedAt = performance.timeOrigin + performance.now();
    }, run.t0 + opens * 1000 - (performance.timeOrigin + performance.now()));
    return run.t0;
  }, [bIndex, film.opens]);
  const t1 = t0 + film.seconds * 1000;
  while ((await clockOf(main)) < t1 + 600) await sleep(250);
  const joinedAt = await main.evaluate(() => window.__bJoinedAt);
  const volumes = await readVolumes(main);

  const caps = {};
  for (const [id, p] of [['A', A], ['B', B]]) caps[id] = await saveCapture(p, `${dir}/${id}`);
  const au = await saveCapture(main, `${dir}/audio`, 'audio');

  // ---- checks
  if (!joinedAt || Math.abs(joinedAt - t0 - film.opens * 1000) > 25) problems.push(`B joined at ${((joinedAt - t0) / 1000).toFixed(3)} s, not ${film.opens} s`);
  const want = { t0, liquid: 'water', sound: true };
  const logA = checkLog('A', caps.A.meta, { ...want, from: t0, to: t1 });
  const logB = checkLog('B', caps.B.meta, { ...want, from: joinedAt, to: t1 });
  const logMain = checkLog('main (leader)', au.meta, { ...want, from: t0, to: t1, limit: Infinity });
  problems.push(...logA.problems, ...logB.problems, ...logMain.problems);
  const track = (k) => film.track.map((p) => ({ t: t0 + p.s * 1000, ...p[k] }));
  problems.push(...checkHolds('A', caps.A.meta, holdsOf(track('a')), t0));
  problems.push(...checkHolds('B', caps.B.meta, holdsOf(track('b')).filter((h) => h.to > joinedAt).map((h) => ({ ...h, from: Math.max(h.from, joinedAt) })), t0));
  problems.push(...checkVolume(volumes, t0 - 500, t1, t0));
  const first = caps.A.meta.log.find((e) => e.t >= t0);
  if (!first || Math.round(first.ml) !== 1000) problems.push(`the film does not open on 1000 mL in A (${first?.ml})`);
  if (!au.meta.audio.delivered) problems.push('no sound was recorded from the leader');
  const vol = spawnSync('ffmpeg', ['-hide_banner', '-i', au.file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString().match(/max_volume: ([-\d.]+) dB/);
  if (!vol || Number(vol[1]) < -45) problems.push(`the leader's sound is silent (max ${vol?.[1]} dB)`);
  for (const [id, c] of Object.entries(caps)) console.log(id, JSON.stringify(probe(c.file)), 'requests', c.meta.requested.length);
  console.log('worst stall in the film: A', logA.worst, 'ms, B', logB.worst, 'ms; sound max', vol?.[1], 'dB');

  writeJob(dir, {
    name: 'hero', width: 1920, height: 1080, fps: 60, t0, duration: film.seconds,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [{ id: 'A', z: 0 }, { id: 'B', z: 1, visibleFrom: joinedAt }],
    audio: { file: 'audio.weba', startedAt: au.meta.startedAt },
    shots,
  });
  return { problems, worst: Math.max(logA.worst, logB.worst), t0 };
});

if (process.argv.includes('--no-compose')) process.exit(0);
const job = `${dir}/job.json`;
const problems = [];
// the labels the compositor redraws must match the pages: compare a still with the screenshots
const { shots, area } = JSON.parse(readFileSync(job, 'utf8'));
if (Math.min(1920 / area.w, 1080 / area.h) === 1) {
  for (const [id, T] of Object.entries(shots)) {
    await still(job, id, T + 40, `${dir}/${id}-composed.png`);
    const meta = JSON.parse(readFileSync(`${dir}/${id}.json`, 'utf8'));
    const e = meta.log.find((l) => l.t >= T) ?? meta.log[0];
    const d = labelDiff(`${dir}/${id}-page.png`, `${dir}/${id}-composed.png`, { x: Math.round(e.x - area.x), y: Math.round(e.y - area.y) + Math.round((1080 - area.h) / 2), w: Math.round(e.w) });
    console.log(`labels ${id}: mean difference from the page ${d.toFixed(2)} / 255`);
    if (d > 6) problems.push(`the redrawn labels of ${id} differ from the page (mean ${d.toFixed(1)} / 255): see ${dir}/${id}-page.png and ${id}-composed.png`);
  }
} else console.log('labels: not checked (the stage is not mapped 1:1 onto the frame)');
const composed = await compose(job, OUT);
const out = checkOutput(OUT, { min: 10, max: 15, audio: true });
finish(dir, 'hero', { output: out.facts, worstStallMs: take.worst, attempts: take.attempts, rejected: take.rejected }, [...problems, ...composed.problems, ...out.problems]);
