// Capture experiment, run before the films:
//  1. sync: one tab records itself while painting its frame number as bars; decoding the recording
//     measures how the recording's timeline lines up with the clock the windows log in.
//  2. load: the stage popup plus three vessel popups all tab-capture themselves at once while the
//     WebGPU water renders and Perform runs; reports each recording's frame rate and missed frames.
// node tools/capture/experiment.mjs [sync|load|both] [canvas]
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { matchRequested } from './compose.mjs';
import { BASE, ROOT, launch, watch, setBounds, openPopup, workArea, saveCapture, probe, cleanDir, sleep } from './lib.mjs';

const which = process.argv[2] ?? 'both';
const kind = process.argv[3] === 'canvas' ? 'canvas' : 'tab';
const dir = `${ROOT}launch/raw/experiment`;
cleanDir(dir);
const errors = [];
const { browser, context } = await launch();
try {
  if (which === 'sync' || which === 'both') await sync();
  if (which === 'load' || which === 'both') await load();
} finally {
  await browser.close();
}
if (errors.length) console.log('ERRORS\n' + [...new Set(errors)].slice(0, 12).join('\n'));

function summary(a) {
  const s = a.slice().sort((x, y) => x - y);
  const q = (f) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 10) / 10;
  return { n: s.length, min: q(0), p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(0.999), exact: s.filter((x) => Math.abs(x) < 1).length };
}

async function sync() {
  const page = await context.newPage();
  watch(page, 'sync', errors);
  await setBounds(context, page, { left: -100, top: -1000, width: 640, height: 400 });
  await page.goto(`${BASE}/tools/capture/sync.html${process.env.SYNC_GPU ? "?gpu" : ""}`);
  await page.waitForFunction(() => window.tidalCapture && window.__painted.length > 30);
  page.on('crash', () => console.log('sync page crashed'));
  page.on('close', () => console.log('sync page closed'));
  for (const k of (process.env.SYNC_KINDS ?? 'tab,canvas').split(',')) {
    const dims = () => page.evaluate(() => ({ x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }));
    console.log('before', k, JSON.stringify(await dims()));
    const started = await page.evaluate((k) => window.tidalCapture.start(k), k);
    await sleep(1000);
    console.log('during', k, JSON.stringify(await dims()));
    await sleep(2000);
    const { meta } = await saveCapture(page, `${dir}/sync-${k}`);
    const paintedList = await page.evaluate(() => window.__painted);
    writeFileSync(`${dir}/sync-${k}.painted.json`, JSON.stringify(paintedList));
    const painted = new Map(paintedList.map(([n, t]) => [n, t]));
    const file = `${dir}/sync-${k}.webm`;
    const ts = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file]).toString()).frames.map((f) => Number(f.best_effort_timestamp_time));
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', 'scale=12:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
    const offsets = [];
    const exact = [];
    const content = meta.requested?.length ? matchRequested(ts, meta.requested) : null;
    for (let i = 0; i < ts.length && (i + 1) * 12 <= raw.length; i++) {
      let n = 0;
      for (let b = 0; b < 12; b++) n = (n << 1) | (raw[i * 12 + b] > 127 ? 1 : 0);
      const t = painted.get(n);
      if (t !== undefined) offsets.push(meta.startedAt + ts[i] * 1000 - t);
      if (t !== undefined && content) exact.push(content[i] - t);
    }
    if (content) console.log(`  requested ${meta.requested.length}, recorded ${ts.length}; content time from requests - paint time, ms: ${JSON.stringify(summary(exact))}`);
    const s = offsets.slice().sort((a, b) => a - b);
    const p = probe(file);
    console.log(`sync ${k}: settings ${JSON.stringify(started.settings && { w: started.settings.width, h: started.settings.height, fps: started.settings.frameRate, surface: started.settings.displaySurface })}`);
    console.log(`  timing method ${meta.timing.method}; firstFrame-startCall ${(meta.timing.firstFrame ?? NaN) - meta.timing.startCall} ms; onstart-startCall ${meta.timing.onstart - meta.timing.startCall} ms; stamps[0] ${meta.timing.frameStamps?.[0]} arrivals[0] ${meta.timing.frameArrivals?.[0]}`);
    console.log(`  frames ${p.frames} fps ${p.fps} gapMax ${p.gapMax} missed ${p.missedFrames}; decoded ${offsets.length}`);
    console.log(`  (startedAt + pts) - paintTime, ms: min ${s[0]?.toFixed(1)} p10 ${s[Math.floor(s.length * 0.1)]?.toFixed(1)} median ${s[s.length >> 1]?.toFixed(1)} p90 ${s[Math.floor(s.length * 0.9)]?.toFixed(1)} max ${s[s.length - 1]?.toFixed(1)}`);
  }
  await page.close();
}

async function load() {
  const main = await context.newPage();
  watch(main, 'main', errors);
  await setBounds(context, main, { left: -219, top: -1050, width: 1100, height: 800 });
  await main.goto(`${BASE}/?capture`);
  await main.waitForFunction(() => window.tidal?.stats.particles > 0 && window.tidalApp && window.tidalCapture, null, { timeout: 30000 });
  const area = await workArea(main);
  console.log('work area', JSON.stringify(area));
  const stage = await openPopup(context, main, `${BASE}/?stage&capture`, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'stage' });
  watch(stage, 'stage', errors);
  await stage.waitForFunction(() => window.tidalCapture && document.documentElement.dataset.stage === 'yes');
  const big = { w: 560, h: 520 }, small = { w: 330, h: 330 };
  const floor = area.y + area.h;
  const specs = [
    { left: area.x + 680, top: floor - big.h, width: big.w, height: big.h - 67 },
    { left: area.x + 280, top: floor - small.h, width: small.w, height: small.h - 67 },
    { left: area.x + 1310, top: floor - small.h, width: small.w, height: small.h - 67 },
  ];
  const vessels = [];
  for (const [i, s] of specs.entries()) {
    const p = await openPopup(context, main, `${BASE}/?capture`, { ...s, name: `v${i}` });
    watch(p, `v${i}`, errors);
    await p.waitForFunction(() => window.tidal?.stats.fps > 0 && window.tidalCapture, null, { timeout: 30000 });
    vessels.push(p);
  }
  const syncPage = await openPopup(context, main, `${BASE}/tools/capture/sync.html`, { left: area.x + 1500, top: area.y + 40, width: 300, height: 120, name: 'sync' });
  await syncPage.waitForFunction(() => window.tidalCapture && window.__painted?.length > 30);
  await sleep(3000);
  const dims = (p) => p.evaluate(() => ({ fps: Math.round(window.tidal?.stats.fps ?? 0), x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }));
  console.log('before recording', JSON.stringify(await Promise.all([stage, ...vessels].map(dims))));
  const windows = [...(kind === 'tab' ? [['stage', stage]] : []), ...vessels.map((p, i) => [`v${i}`, p]), ['sync', syncPage]];
  const startedAll = await Promise.all(windows.map(([, p]) => p.evaluate((k) => window.tidalCapture.start(k).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })), kind)));
  await main.mouse.click(300, 300);
  await main.evaluate(() => window.tidalApp.audio.enable());
  const audio = kind === 'tab'
    ? await main.evaluate(() => window.tidalCapture.start('tab', { audio: true, audioOnly: true }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })))
    : await main.evaluate(() => window.tidalCapture.startAudio().then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })));
  startedAll.forEach((s, i) => console.log('start', windows[i][0], JSON.stringify(s.ok ? { w: s.r.settings?.width, h: s.r.settings?.height, fps: s.r.settings?.frameRate } : s)));
  console.log('main audio', JSON.stringify(audio));
  await main.evaluate(() => window.tidalApp.performer.start('perform', true));
  const fpsSamples = [];
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    fpsSamples.push(await Promise.all(vessels.map((p) => p.evaluate(() => Math.round(window.tidal.stats.fps)))));
  }
  const after = await Promise.all([stage, ...vessels].map(dims));
  console.log('render fps per second while recording', JSON.stringify(fpsSamples));
  console.log('viewport after capture start', JSON.stringify(after));
  for (const [name, p] of windows) {
    const { file, bytes, meta } = await saveCapture(p, `${dir}/load-${name}`);
    const pr = probe(file);
    const logGaps = meta.log.slice(1).map((e, i) => e.t - meta.log[i].t).sort((a, b) => a - b);
    if (name === 'sync') {
      const painted = new Map((await p.evaluate(() => window.__painted)).map(([n, t]) => [n, t]));
      const ts = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file]).toString()).frames.map((f) => Number(f.best_effort_timestamp_time));
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', 'scale=12:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
      const off = [];
      for (let i = 0; i < ts.length && (i + 1) * 12 <= raw.length; i++) { let n = 0; for (let b = 0; b < 12; b++) n = (n << 1) | (raw[i * 12 + b] > 127 ? 1 : 0); const t = painted.get(n); if (t !== undefined) off.push(meta.startedAt + ts[i] * 1000 - t); }
      off.sort((a, b) => a - b);
      console.log(`sync under load: latency median ${off[off.length >> 1]?.toFixed(1)} p10 ${off[Math.floor(off.length * 0.1)]?.toFixed(1)} p90 ${off[Math.floor(off.length * 0.9)]?.toFixed(1)} (${off.length} frames)`);
    }
    console.log(`${name}: ${(bytes / 1e6).toFixed(1)} MB ${JSON.stringify(pr)} trackStats ${JSON.stringify(meta.trackStats)} log ${meta.log.length} entries, gap p50 ${logGaps[logGaps.length >> 1]?.toFixed(1)} max ${logGaps[logGaps.length - 1]?.toFixed(1)}`);
  }
  if (audio.ok) {
    const { file, meta } = await saveCapture(main, `${dir}/load-main-audio`, kind === 'tab' ? 'self' : 'audio');
    const a = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate', '-of', 'json', file]).toString();
    const vol = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString().match(/(mean|max)_volume: [-\d.]+ dB/g);
    console.log('audio', JSON.stringify(meta.audio), a.replace(/\s+/g, ''), vol?.join(', '));
  }
}
