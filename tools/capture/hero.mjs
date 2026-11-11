// The launch film (spec §3): records the two-vessel 'film' choreography on the stage and composes
// launch/hero.mp4. Every vessel records itself (canvas capture) and logs where it is; nothing records
// the screen. node tools/capture/hero.mjs [--no-compose]
import { BASE, ROOT, launch, openMain, openPopup, openVessel, sitOut, gate, settle, saveCapture, writeJob, clockOf, cleanDir, sleep, probe, stalls } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { compose, still } from './compose.mjs';

const dir = `${ROOT}launch/raw/hero`;
cleanDir(dir);
const errors = [];
const { browser, context } = await launch();
let t0;
try {
  const { main, area } = await openMain(context, errors);
  console.log('work area', JSON.stringify(area));
  // the backdrop: it keeps the desktop out of sight while filming; the composite redraws its look
  await openPopup(context, main, `${BASE}/?stage&capture`, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'tidal-stage' });
  const film = await main.evaluate(async (stage) => {
    const m = await import('/src/perform/timeline.ts');
    return { a: m.heroPoseAt(0, 0, stage), b: m.heroPoseAt(1, m.HERO_SECOND_OPENS, stage), seconds: m.HERO_SECONDS, opens: m.HERO_SECOND_OPENS };
  }, { x: area.x, y: area.y, w: area.w, h: area.h });
  console.log('poses', JSON.stringify(film));

  // vessel A, and all the water rains into it
  const A = await openVessel(context, main, film.a, 'A', errors);
  await sitOut(main);
  const restA = await settle(A, { minMs: 7000, quietMs: 2000 });
  console.log('A settled', JSON.stringify(restA));

  // vessel B waits out of the world, already in its place, so it appears fully drawn at 2 s
  const B = await openVessel(context, main, { ...film.b, x: area.x + area.w - film.b.w - 40, y: area.y + 40 }, 'B', errors);
  await gate(B);
  await B.evaluate(([x, y]) => moveTo(x, y), [film.b.x, film.b.y]);
  const bIndex = await main.evaluate(() => window.__opened.length - 1);
  await sleep(1200);
  console.log('B ready', JSON.stringify(await B.evaluate(() => ({ ml: window.tidal.ml, active: window.tidal.registry.self.active, outer: [screenX, screenY, outerWidth, outerHeight] }))));

  // sound from the leader (the main window), recorded from its own audio graph
  await main.mouse.click(400, 500);
  await main.evaluate(() => window.tidalApp.audio.enable());
  const leader = await main.evaluate(() => window.tidal.isLeader);
  const audio = await main.evaluate(() => window.tidalCapture.startAudio().then((r) => r, (e) => ({ ok: false, error: String(e) })));
  console.log('leader is main:', leader, 'audio', JSON.stringify(audio));

  for (const p of [A, B]) await p.evaluate(() => window.tidalCapture.start('canvas'));
  await sleep(500);
  // real screenshots of the two pages (their own content only), to check the redrawn labels against
  const shots = {};
  for (const [id, p] of [['A', A], ['B', B]]) {
    const at = await clockOf(p);
    await p.screenshot({ path: `${dir}/${id}-page.png` });
    shots[id] = at;
  }

  // the film: locked, so nothing interrupts it; B joins at HERO_SECOND_OPENS
  t0 = await main.evaluate(([bi, opens]) => {
    const app = window.tidalApp;
    app.performer.start('film', true);
    const run = app.performer.current;
    const b = window.__opened[bi];
    setTimeout(() => {
      b.__gate = true;
      b.tidal.setActive(true);
      app.performer.join(b.tidal.id, 1);
      window.__bJoinedAt = performance.timeOrigin + performance.now();
    }, run.t0 + opens * 1000 - (performance.timeOrigin + performance.now()));
    return run.t0;
  }, [bIndex, film.opens]);
  const samples = [];
  while ((await clockOf(main)) < t0 + (film.seconds + 0.6) * 1000) {
    samples.push(await main.evaluate(() => ({ t: Math.round(performance.timeOrigin + performance.now()), ml: window.tidal.meta.ml.slice(0, 4).map(Math.round), rain: Math.round(window.tidal.meta.rainMl) })));
    await sleep(1000);
  }
  const joinedAt = await main.evaluate(() => window.__bJoinedAt);
  console.log('B joined at film time', ((joinedAt - t0) / 1000).toFixed(3), 's');
  console.log('volumes by slot each second', samples.map((s) => `${((s.t - t0) / 1000).toFixed(1)}s ${s.ml.join('/')} rain ${s.rain}`).join(' | '));

  const caps = {};
  for (const [id, p] of [['A', A], ['B', B]]) {
    caps[id] = await saveCapture(p, `${dir}/${id}`);
    console.log(id, JSON.stringify(probe(caps[id].file)), `requests ${caps[id].meta.requested.length}`, 'in film', JSON.stringify(stalls(caps[id].meta, Math.max(t0, id === 'B' ? joinedAt : t0), t0 + film.seconds * 1000)));
  }
  const au = await saveCapture(main, `${dir}/audio`, 'audio');
  console.log('audio', au.bytes, 'bytes', JSON.stringify(au.meta.audio));

  writeJob(dir, {
    name: 'hero', width: 1920, height: 1080, fps: 60, t0, duration: film.seconds,
    area, background: 'stage', stageGrid: { x: area.x, y: area.y + 67 },
    windows: [
      { id: 'A', z: 0 },
      { id: 'B', z: 1, visibleFrom: joinedAt },
    ],
    audio: { file: 'audio.weba', startedAt: au.meta.startedAt },
    shots,
  });
} finally {
  await browser.close();
}
if (errors.length) console.log('PAGE ERRORS\n' + [...new Set(errors)].slice(0, 10).join('\n'));
if (!process.argv.includes('--no-compose')) {
  const { shots } = JSON.parse(readFileSync(`${dir}/job.json`, 'utf8'));
  for (const [id, T] of Object.entries(shots)) await still(`${dir}/job.json`, id, T + 40, `${dir}/${id}-composed.png`);
  await compose(`${dir}/job.json`, `${ROOT}launch/hero.mp4`);
}
