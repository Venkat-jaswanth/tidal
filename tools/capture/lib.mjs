// Shared helpers for the capture scripts: launching Chrome, opening Tidal windows, pulling the
// self-recordings out of the pages, and measuring them with ffprobe.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const BASE = process.env.TIDAL_URL ?? 'http://localhost:5174';
export const ROOT = new URL('../../', import.meta.url).pathname;

/** Headed system Chrome that accepts tab self-capture without a prompt. */
export async function launch(extraArgs = []) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
  const context = await browser.newContext({ viewport: null, colorScheme: 'light' });
  return { browser, context };
}

export function watch(page, name, errors) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${name}: ${e}`));
}

/** Moves and sizes a page's window (outer bounds, screen CSS px) through CDP. */
export async function setBounds(context, page, bounds) {
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
  await cdp.send('Browser.setWindowBounds', { windowId, bounds });
  return { cdp, windowId };
}

/** Opens a popup from `opener` with window.open (sizes are inner sizes) and returns its page. */
export async function openPopup(context, opener, url, { left, top, width, height, name }) {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    opener.evaluate(([u, f, n]) => { window.__opened ??= []; window.__opened.push(window.open(u, n, f)); }, [url, `popup,left=${left},top=${top},width=${width},height=${height}`, name ?? `cap-${Math.random()}`]),
  ]);
  return page;
}

/** The work area of the display a page is on. */
export const workArea = (page) => page.evaluate(() => ({ x: screen.availLeft, y: screen.availTop, w: screen.availWidth, h: screen.availHeight, sw: screen.width, sh: screen.height, dpr: devicePixelRatio }));

/**
 * Stops a recording in a page and writes it next to its log: `<base>.webm` and `<base>.json`.
 * `name` is the recording's name inside the page ('self' for the window's own capture).
 */
export async function saveCapture(page, base, name = 'self', { stop = true } = {}) {
  mkdirSync(dirname(base), { recursive: true });
  const meta = stop
    ? await page.evaluate((n) => window.tidalCapture.stopForTransfer(n), name)
    : await page.evaluate((n) => { const r = window.tidalCapture.results.get(n); const { blob, ...rest } = r; return { ...rest, bytes: blob.size, chunkBytes: 4 * 1024 * 1024, chunks: Math.ceil(blob.size / (4 * 1024 * 1024)) }; }, name);
  return writeCapture(page, base, name, meta);
}

export async function writeCapture(page, base, name, meta) {
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) parts.push(Buffer.from(await page.evaluate(([n, k]) => window.tidalCapture.chunk(n, k), [name, i]), 'base64'));
  const buf = Buffer.concat(parts);
  const ext = meta.mime.startsWith('audio') ? 'weba' : 'webm';
  writeFileSync(`${base}.${ext}`, buf);
  const { timing, ...rest } = meta;
  writeFileSync(`${base}.json`, JSON.stringify({ ...rest, file: `${base.split('/').pop()}.${ext}`, timing: { ...timing, frameArrivals: undefined, frameStamps: undefined }, arrivals: timing.frameArrivals, stamps: timing.frameStamps }));
  return { file: `${base}.${ext}`, bytes: buf.length, meta };
}

/** Frame count, rate and gaps of a recording, from its packet timestamps. */
export function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,codec_name', '-show_entries', 'packet=pts_time', '-of', 'json', file], { maxBuffer: 1 << 28 }).toString();
  const j = JSON.parse(out);
  const s = j.streams?.[0] ?? {};
  const pts = (j.packets ?? []).map((p) => Number(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = pts.slice(1).map((t, i) => (t - pts[i]) * 1000);
  const span = pts.length > 1 ? pts[pts.length - 1] - pts[0] : 0;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const pct = (q) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10 : null;
  return {
    codec: s.codec_name, width: s.width, height: s.height, frames: Number(s.nb_read_frames), seconds: Math.round(span * 1000) / 1000,
    fps: span ? Math.round(((pts.length - 1) / span) * 10) / 10 : null,
    gapP50: pct(0.5), gapP95: pct(0.95), gapMax: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
    over25ms: gaps.filter((g) => g > 25).length,
    missedFrames: Math.round(gaps.reduce((a, g) => a + Math.max(0, Math.round(g / 16.667) - 1), 0)),
  };
}

export function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- scenes

/**
 * Tidal page URL for capture. `capture` loads the recorder; `nokeys` makes the page ignore the keyboard
 * (headed windows here can catch keystrokes typed elsewhere: L changes the liquid, S the sound, arrows
 * slosh); `tier=0` keeps full quality (no automatic quality ladder mid-film); `inactive` opens it sitting
 * out of the world.
 */
export const tidalUrl = ({ inactive = false } = {}) => `${BASE}/?capture&nokeys&tier=0${inactive ? '&inactive' : ''}`;
export const STAGE_URL = `${BASE}/?stage&capture&nokeys`;

/** A take that must be thrown away, with the reason. */
export class Problem extends Error {}

/**
 * Opens the main Tidal page on the display to film on, top left of its work area and clear of every
 * vessel in the clips (the new world pours into it first, and that litre must not already sit inside a
 * vessel). Returns { main, area }.
 */
export async function openMain(context, errors, { width = 620, height = 420 } = {}) {
  const main = await context.newPage();
  watch(main, 'main', errors);
  await main.goto('about:blank');
  const screen = await pickDisplay(context, main);
  await setBounds(context, main, { left: screen.x, top: screen.y, width, height });
  await main.goto(tidalUrl());
  await main.waitForFunction(() => window.tidal?.stats.particles > 0 && window.tidalApp?.sitOut && window.tidalCapture, null, { timeout: 30000 });
  const area = await workArea(main);
  return { main, area };
}

/**
 * Finds the displays by moving a window around (Chrome keeps a window on some display and reports that
 * display's geometry) and returns the work area to film on: a 1920×1080 display at 1x if there is one,
 * so the composite maps it 1:1, otherwise the largest. No permission prompt is involved.
 */
export async function pickDisplay(context, page) {
  const { cdp, windowId } = await setBounds(context, page, { left: 100, top: 100, width: 400, height: 300 });
  const seen = new Map();
  for (const dx of [-2400, -1200, 0, 1200, 2400]) {
    for (const dy of [-1600, -800, 0, 800, 1600]) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: dx + 200, top: dy + 200, width: 400, height: 300 } });
      await sleep(60);
      const a = await workArea(page);
      seen.set(`${a.x},${a.y},${a.w},${a.h}`, a);
    }
  }
  const all = [...seen.values()];
  const want = all.find((a) => a.sw === 1920 && a.sh === 1080 && a.dpr === 1);
  const pick = want ?? all.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  console.log('displays', JSON.stringify(all), '-> filming on', JSON.stringify(pick));
  displays = all;
  return pick;
}
/** Every display seen by the last pickDisplay(). */
export let displays = [];

/** Frames a page did not draw during [from, to] (clock ms), from its log: gaps over 25 ms, and the worst gap. */
export function stalls(meta, from, to) {
  const L = meta.log.filter((e) => e.t >= from && e.t <= to);
  const gaps = L.slice(1).map((e, i) => e.t - L[i].t);
  return { frames: L.length, over25: gaps.filter((g) => g > 25).length, over40: gaps.filter((g) => g > 40).length, worst: Math.round(Math.max(0, ...gaps)), missed: Math.round(gaps.reduce((a, g) => a + Math.max(0, Math.round(g / 16.667) - 1), 0)) };
}

/** The stage backdrop, filling the work area. It keeps the desktop out of sight while filming; the composite redraws its look. */
export async function openStage(context, main, area, errors) {
  const stage = await openPopup(context, main, STAGE_URL, { left: area.x, top: area.y, width: area.w, height: area.h, name: 'tidal-stage' });
  watch(stage, 'stage', errors);
  await stage.waitForFunction(() => document.documentElement.dataset.stage === 'yes');
  return stage;
}

/** Takes a window out of the world, or puts it back, through the app's supported switch. */
export const sitOut = (page, out = true) => page.evaluate((o) => window.tidalApp.sitOut(o), out);

/** Opens a vessel popup with this outer rectangle and waits until it is drawn, at exactly that rectangle. */
export async function openVessel(context, opener, { x, y, w, h }, name, errors, { inactive = false, titleBar = 67 } = {}) {
  const p = await openPopup(context, opener, tidalUrl({ inactive }), { left: x, top: y, width: w, height: h - titleBar, name });
  if (errors) watch(p, name, errors);
  await p.waitForFunction(() => window.tidal?.stats.fps > 0 && window.tidalCapture && window.tidalApp && window.tidal.meta, null, { timeout: 30000 });
  // window.open can land a pixel short; settle on the exact outer rectangle
  await p.evaluate(([x, y, w, h]) => { resizeTo(w, h); moveTo(x, y); }, [x, y, w, h]);
  await reach(p, name, { x, y, w, h });
  return p;
}

/** Waits until a window stands at this outer rectangle; a Problem if it never gets there. */
export async function reach(page, name, { x, y, w, h }, timeout = 4000) {
  const ok = await page.waitForFunction(([x, y, w, h]) => screenX === x && screenY === y && (w == null || outerWidth === w) && (h == null || outerHeight === h), [x, y, w ?? null, h ?? null], { timeout }).then(() => true, () => false);
  if (!ok) {
    const got = await page.evaluate(() => [screenX, screenY, outerWidth, outerHeight]);
    throw new Problem(`${name} never reached its place: wanted ${x},${y} ${w ?? '?'}×${h ?? '?'}, got ${got[0]},${got[1]} ${got[2]}×${got[3]}`);
  }
}

/** Waits until nothing is raining (the new world's pour-in, or a sit-out) and then `afterMs` more, so the solver comes to rest. */
export async function waitForRest(main, { afterMs = 6000, maxMs = 30000 } = {}) {
  const t = Date.now();
  await main.waitForFunction(() => (window.tidal.meta?.rainMl ?? 1) < 1, null, { timeout: maxMs, polling: 100 });
  await sleep(afterMs);
  return { ms: Date.now() - t, ...(await main.evaluate(() => ({ ml: window.tidal.meta.ml.map((v) => Math.round(v * 100) / 100).filter((v) => v > 0), energy: window.tidal.meta.energy.reduce((a, b) => a + b, 0) }))) };
}

/** Starts logging the world's total volume in the leader every 100 ms; `readVolumes` returns the samples. */
export const logVolumes = (main) => main.evaluate(() => {
  window.__volumes = [];
  window.__volumeTimer = setInterval(() => {
    const m = window.tidal.meta;
    if (m) window.__volumes.push({ t: performance.timeOrigin + performance.now(), total: m.ml.reduce((a, b) => a + b, 0) + m.rainMl, rain: m.rainMl, ml: m.ml.slice(0, 6) });
  }, 100);
});
export const readVolumes = (main) => main.evaluate(() => { clearInterval(window.__volumeTimer); return window.__volumes; });

export const clockOf = (page) => page.evaluate(() => performance.timeOrigin + performance.now());

export function writeJob(dir, job) {
  writeFileSync(`${dir}/job.json`, JSON.stringify(job, null, 1));
  return `${dir}/job.json`;
}

// ---------------------------------------------------------------- checks

const secs = (t, t0) => `${((t - t0) / 1000).toFixed(2)} s`;

/**
 * One window's log over [from, to]: the worst gap between drawn frames (a stall over `limit` ms is a
 * problem), and the liquid and sound state, which must stay as expected throughout.
 */
export function checkLog(id, meta, { from, to, t0, liquid, sound, limit = 60 }) {
  const L = meta.log.filter((e) => e.t >= from && e.t <= to);
  const problems = [];
  if (L.length < 2) return { problems: [`${id}: no frames logged between ${secs(from, t0)} and ${secs(to, t0)}`], worst: Infinity };
  let worst = 0, at = from;
  for (let i = 1; i < L.length; i++) { const g = L[i].t - L[i - 1].t; if (g > worst) { worst = g; at = L[i].t; } }
  if (worst > limit) problems.push(`${id}: a ${Math.round(worst)} ms stall at ${secs(at, t0)} (limit ${limit} ms)`);
  // a steady low rate has no single long gap: count the frames too
  const fps = ((L.length - 1) * 1000) / (L[L.length - 1].t - L[0].t);
  if (limit !== Infinity && fps < 54) problems.push(`${id}: drew only ${fps.toFixed(1)} frames a second between ${secs(from, t0)} and ${secs(to, t0)} (54 at least)`);
  if (liquid) {
    const odd = L.find((e) => e.liquid !== undefined && e.liquid !== liquid);
    if (odd) problems.push(`${id}: the liquid changed to "${odd.liquid}" at ${secs(odd.t, t0)} (expected ${liquid} throughout)`);
  }
  if (sound !== undefined) {
    const odd = L.find((e) => (e.sound !== undefined && e.sound !== sound) || (e.soundShown !== undefined && e.soundShown !== sound));
    if (odd) problems.push(`${id}: the sound was ${odd.sound ? 'on' : 'off'} (shown ${odd.soundShown ? 'on' : 'off'}) at ${secs(odd.t, t0)}, expected ${sound ? 'on' : 'off'} throughout`);
  }
  return { problems, worst: Math.round(worst), fps: Math.round(fps * 10) / 10 };
}

/** Hold segments of a sampled pose track ([{ t, x, y, w, h }], clock ms): stretches at least `minMs` long where the pose does not change. */
export function holdsOf(samples, minMs = 250) {
  const holds = [];
  let i = 0;
  while (i < samples.length) {
    let j = i;
    const a = samples[i];
    while (j + 1 < samples.length && samples[j + 1].x === a.x && samples[j + 1].y === a.y && samples[j + 1].w === a.w && samples[j + 1].h === a.h) j++;
    if (samples[j].t - a.t >= minMs) holds.push({ from: a.t, to: samples[j].t, x: a.x, y: a.y, w: a.w, h: a.h });
    i = j + 1;
  }
  return holds;
}

/**
 * Every frame from 150 ms into each hold to 100 ms before its end must show the window at the hold's
 * outer rectangle (±2 px). The margins allow for a window that moves itself on its own frame clock, which
 * can run a frame or two ahead of the frame times logged here.
 */
export function checkHolds(id, meta, holds, t0) {
  const problems = [];
  for (const h of holds) {
    const L = meta.log.filter((e) => e.t >= h.from + 150 && e.t <= h.to - 100);
    if (!L.length) { problems.push(`${id}: no frames logged during its hold from ${secs(h.from, t0)}`); continue; }
    const bad = L.find((e) => Math.abs(e.outer.x - h.x) > 2 || Math.abs(e.outer.y - h.y) > 2 || (h.w && Math.abs(e.outer.w - h.w) > 1) || (h.h && Math.abs(e.outer.h - h.h) > 1));
    if (bad) problems.push(`${id}: not at its pose at ${secs(bad.t, t0)}: wanted ${h.x},${h.y} ${h.w ?? '?'}×${h.h ?? '?'}, was ${bad.outer.x},${bad.outer.y} ${bad.outer.w}×${bad.outer.h}`);
  }
  return problems;
}

/** The litre must stay a litre: every sample of (all vessels + rain in flight) within 0.5 % of 1000 mL. */
export function checkVolume(samples, from, to, t0) {
  const S = samples.filter((v) => v.t >= from && v.t <= to);
  if (!S.length) return [`volume: no samples between ${secs(from, t0)} and ${secs(to, t0)}`];
  const worst = S.reduce((a, v) => (Math.abs(v.total - 1000) > Math.abs(a.total - 1000) ? v : a));
  return Math.abs(worst.total - 1000) > 5 ? [`volume: the world held ${worst.total.toFixed(1)} mL at ${secs(worst.t, t0)} (1000 mL ± 0.5 % expected)`] : [];
}

/** Facts of an encoded output, and problems if it is not 1920×1080 at 60 fps, the right length, with or without sound as asked. */
export function checkOutput(file, { min, max, audio, width = 1920, height = 1080 }) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames', '-show_entries', 'format=duration,size', '-of', 'json', file]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(j.format.duration);
  const facts = { file: file.replace(ROOT, ''), codec: v?.codec_name, width: v?.width, height: v?.height, fps: v?.r_frame_rate, frames: Number(v?.nb_read_frames), duration, bytes: Number(j.format.size), audio: !!a };
  const problems = [];
  if (!v || v.width !== width || v.height !== height) problems.push(`${facts.file}: ${v?.width}×${v?.height}, expected ${width}×${height}`);
  if (v?.r_frame_rate !== '60/1') problems.push(`${facts.file}: ${v?.r_frame_rate} fps, expected 60/1`);
  if (Math.abs(facts.frames - Math.round(duration * 60)) > 1) problems.push(`${facts.file}: ${facts.frames} frames for ${duration} s at 60 fps`);
  if (duration < min || duration > max) problems.push(`${facts.file}: ${duration} s long, expected ${min}–${max} s`);
  if (audio !== undefined && facts.audio !== audio) problems.push(`${facts.file}: ${facts.audio ? 'has' : 'has no'} sound, expected ${audio ? 'sound' : 'none'}`);
  return { facts, problems };
}

/**
 * Runs a take up to `attempts` times, each in a fresh browser, until its checks pass, and returns what
 * the passing take returned. `take` returns { problems: string[], ... } or throws a Problem. When no take
 * passes, prints why and exits the process non-zero.
 */
export async function shoot(name, take, { attempts = Number(process.env.CAPTURE_ATTEMPTS ?? 3) } = {}) {
  const rejected = [];
  for (let a = 1; a <= attempts; a++) {
    console.log(`== ${name}: take ${a} of ${attempts}`);
    const errors = [];
    const { browser, context } = await launch();
    let r;
    try {
      r = await take({ context, errors, attempt: a });
    } catch (e) {
      // a bad take is retried; a bug in the script is not
      if (!(e instanceof Problem) && e?.name !== 'TimeoutError') {
        await browser.close().catch(() => {});
        console.error(`\n${name}: FAILED, script error:\n${e?.stack ?? e}`);
        process.exit(2);
      }
      r = { problems: [e.message] };
    } finally {
      await browser.close().catch(() => {});
    }
    const crashes = errors.filter((m) => m.includes('[pageerror]'));
    const problems = [...(r.problems ?? []), ...crashes.map((m) => `page error: ${m}`)];
    const noise = errors.filter((m) => !m.includes('[pageerror]') && !/favicon|status of 404/.test(m));
    if (noise.length) console.log(`  console errors (not fatal): ${[...new Set(noise)].slice(0, 4).join(' | ')}`);
    if (!problems.length) return { ...r, attempts: a, rejected };
    rejected.push({ take: a, problems });
    console.log(`  take ${a} rejected:\n    - ${problems.join('\n    - ')}`);
  }
  console.error(`\n${name}: FAILED, no good take in ${attempts} attempts. Last reasons:\n  - ${rejected[rejected.length - 1].problems.join('\n  - ')}`);
  process.exit(1);
}

/** The take recorded by the last run of a clip script (for `--compose-only`: compose again without shooting). */
export function lastTake(dir) {
  let tj;
  try { tj = JSON.parse(readFileSync(`${dir}/take.json`, 'utf8')); } catch { tj = null; }
  if (!tj || !existsSync(`${dir}/job.json`)) {
    console.error(`--compose-only: no recorded take in ${dir}; shoot it first`);
    process.exit(1);
  }
  return { worst: tj.worstStallMs, attempts: tj.attempts, rejected: tj.rejected ?? [] };
}

/** Ends a clip script: writes take.json for all.mjs, prints the outcome, exits non-zero on any problem. */
export function finish(dir, name, summary, problems) {
  writeFileSync(`${dir}/take.json`, JSON.stringify({ name, ok: !problems.length, problems, ...summary }, null, 1));
  if (problems.length) {
    console.error(`\n${name}: FAILED\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`\n${name}: OK ${JSON.stringify(summary.output ?? {})}`);
}

// ---------------------------------------------------------------- pictures

const gray = (file, vf) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-vf', `${vf},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });

/**
 * How far the compositor's redrawn labels are from the page itself: mean absolute luma difference (0–255)
 * between a screenshot of the page and the same window cut out of a composed still, over the window's
 * top `rows` px, where the labels are. The liquid must be at rest when the screenshot is taken.
 */
export function labelDiff(pagePng, composedPng, { x, y, w, rows = 140 }) {
  const a = gray(pagePng, `crop=${w}:${rows}:0:0`);
  const b = gray(composedPng, `crop=${w}:${rows}:${x}:${y}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Share of a frame region (at `t` s) that reads as orange and as blue, by hue: cadmium orange and
 * ultramarine at any depth or thinness (deep ultramarine is nearly navy, thin ink is pale), never the
 * paper or the ruling, which have little saturation.
 */
export function inkShares(file, t, { x, y, w, h }) {
  const rgb = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(t), '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  let orange = 0, blue = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
    if (max < 0.12 || c / max < 0.3) continue; // black, paper and grey ruling have no hue to speak of
    let hue = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
    hue = (hue * 60 + 360) % 360;
    if (hue >= 5 && hue <= 45) orange++;
    else if (hue >= 210 && hue <= 260) blue++;
  }
  return { orange: orange / n, blue: blue / n };
}

/**
 * The inks each vessel holds, from the simulation itself: the share of each vessel's particles that are
 * the first ink, the second, or a mix. The latest snapshot carries 12 bytes a particle: the dye as rgb565
 * at byte 8 (its red, the mix between the two inks: 0 the first, 31 the second) and the owner slot at 10.
 */
export const dyeCensus = (main) => main.evaluate(() => {
  const s = window.tidal.transport.latestSnapshot();
  if (!s) return null;
  const v = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
  const by = {};
  for (let i = 0; i < s.count; i++) {
    const r5 = v.getUint16(i * 12 + 8, true) >> 11;
    const slot = s.data[i * 12 + 10];
    const c = (by[slot] ??= { n: 0, first: 0, second: 0 });
    c.n++;
    if (r5 <= 6) c.first++; else if (r5 >= 25) c.second++;
  }
  for (const c of Object.values(by)) { c.first = Math.round((c.first / c.n) * 1000) / 1000; c.second = Math.round((c.second / c.n) * 1000) / 1000; }
  return { frame: s.frame, t: s.t, by };
});
