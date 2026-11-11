// Offline, frame-exact compositor. Reads a job written by a clip script (launch/raw/<name>/job.json),
// renders every output frame in tools/capture/compose.html and encodes the PNG sequence with ffmpeg.
// node tools/capture/compose.mjs <job.json> <out.mp4> [firstFrame] [lastFrame]
//
// For output frame k at film time T = t0 + k/fps, each recording shows the last frame whose content
// was drawn at or before T: content time of a frame = startedAt + (pts - firstPts) - latency, where
// latency is the measured delay from drawing to capture (tools/capture/experiment.mjs sync).
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { BASE, ROOT } from './lib.mjs';

/** Draw-to-capture delay, ms, measured with tools/capture/experiment.mjs (canvas.captureStream under load). */
export const LATENCY_MS = { canvas: 8, tab: 27 };

export function packetTimes(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 1 << 26 }).toString();
  return out.split('\n').map((l) => l.trim()).filter((l) => l !== '').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * Pairs recorded frames with the animation frames they were requested in. A WebGPU canvas recording
 * may open with stale frames (the canvas as it was when the recorder started); the recorder counts
 * them by when they arrived (`stale`, before the first requestFrame() call). After them each frame
 * answers one request, in order, except that the encoder may skip a request, the last request may go
 * unrecorded, and the frames' own timestamps jitter (a late frame is often followed by an early one).
 * So the pairing is a monotone alignment of the two timelines, anchored at the first fresh frame and
 * solved by dynamic programming: a frame's timestamp, less the steady capture delay, should land on its
 * request's time; skipping a request costs a little, leaving a frame unmatched costs more.
 * Returns the content time of each recorded frame (its request's time), or NaN for an unmatched one.
 * Without a measured `stale` (older recordings) it is guessed from the pattern of gaps.
 */
export function matchRequested(pts, requested, { stale = null, delay = null } = {}) {
  const n = pts.length, m = requested.length;
  if (!n || !m) return new Array(n).fill(NaN);
  let d = stale;
  if (d == null) {
    const head = Math.min(n, 120);
    let bestCost = Infinity;
    for (let s = -2; s <= 2; s++) {
      let cost = 0;
      for (let i = 1; i < head; i++) {
        const j = i - s;
        if (j < 1 || j >= m) { cost += 50; continue; }
        cost += Math.abs((pts[i] - pts[i - 1]) * 1000 - (requested[j] - requested[j - 1]));
      }
      if (cost < bestCost) { bestCost = cost; d = s; }
    }
  }
  const i0 = Math.max(0, d);
  // the steady delay between a request and its frame's timestamp
  const es = [];
  for (let i = i0; i < Math.min(n, i0 + 120); i++) if (i - d >= 0 && i - d < m) es.push(pts[i] * 1000 - requested[i - d]);
  es.sort((a, b) => a - b);
  // measured (see anchorOf), or else assumed from the first fresh frame answering the first request
  const E = delay ?? es[es.length >> 1] ?? 0;
  const at = (i) => pts[i] * 1000 - E; // where frame i's request should be, on the requests' clock
  const nearest = (t) => { let lo = 0, hi = m - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (requested[mid] < t) lo = mid + 1; else hi = mid; } return lo; };
  const B = 6, SKIP = 30, UNMATCHED = 200, CAP = 100, BACK = 3;
  const cost = (i, j) => Math.min(CAP, Math.abs(at(i) - requested[j]));
  const rows = new Array(n);
  for (let i = i0; i < n; i++) {
    const c = nearest(at(i));
    const row = [];
    for (let j = Math.max(0, c - B); j <= Math.min(m - 1, c + B); j++) {
      // the path starts at the first fresh frame; a later start leaves frames unmatched
      let best = i === i0 ? (delay == null ? j * SKIP : 0) : (i - i0) * UNMATCHED + j * SKIP, back = null;
      for (let q = Math.max(i0, i - BACK); q < i; q++) {
        for (let k = 0; k < rows[q].length; k++) {
          const p = rows[q][k];
          if (p.j >= j) continue;
          const v = p.c + (i - q - 1) * UNMATCHED + (j - p.j - 1) * SKIP;
          if (v < best) { best = v; back = [q, k]; }
        }
      }
      row.push({ j, c: best + cost(i, j), back });
    }
    rows[i] = row;
  }
  // the path may end a few frames early, leaving the last frames unmatched
  let end = null, endCost = Infinity;
  for (let i = Math.max(i0, n - 1 - BACK); i < n; i++) {
    for (let k = 0; k < rows[i].length; k++) {
      const v = rows[i][k].c + (n - 1 - i) * UNMATCHED;
      if (v < endCost) { endCost = v; end = [i, k]; }
    }
  }
  const out = new Array(n).fill(NaN);
  for (let cur = end; cur; ) {
    const e = rows[cur[0]][cur[1]];
    out[cur[0]] = requested[e.j];
    cur = e.back;
  }
  return out;
}

/** Stale frames at the start of a canvas recording, from when its first frames arrived; null if not measured. */
export function staleFrames(meta) {
  const calls = meta.timing?.requestCalls;
  if (!calls?.length || !meta.arrivals) return null;
  return meta.arrivals.filter((a) => a < calls[0]).length;
}

/**
 * The recording's timeline tied to the requests' clock. A second reader saw the first frames with their
 * own timestamps (which the WebM keeps) and arrival times; the first fresh frame arrives a few ms after
 * the requestFrame() call it answers. That pair gives the delay between a request's time and its frame's
 * timestamp. Returns { stale, delay } or null when it cannot be measured.
 */
export function anchorOf(meta, pts) {
  const calls = meta.timing?.requestCalls, arrivals = meta.arrivals, stamps = meta.stamps;
  if (!calls?.length || !arrivals?.length || !stamps?.length || !meta.requested?.length) return null;
  const stale = arrivals.filter((a) => a < calls[0]).length;
  const k = arrivals.findIndex((a) => a >= calls[0]);
  if (k < 0) return null;
  let j = 0;
  while (j + 1 < calls.length && calls[j + 1] <= arrivals[k]) j++;
  if (arrivals[k] - calls[j] > 14) return null; // too slow to say which request it answered
  // the recording must share the reader's timeline
  const shared = pts.slice(0, 20).filter((p) => stamps.some((s) => Math.abs(s / 1000 - p * 1000) < 1.2)).length;
  if (shared < Math.min(15, pts.length)) return null;
  return { stale, delay: stamps[k] / 1000 - meta.requested[j] };
}

/** Adds cues (a seek index) to a MediaRecorder WebM without re-encoding. */
function remux(src, dst) {
  if (existsSync(dst) && statSync(dst).mtimeMs > statSync(src).mtimeMs) return;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-c', 'copy', dst]);
}

export function buildJob(jobPath) {
  const raw = JSON.parse(readFileSync(jobPath, 'utf8'));
  const dir = dirname(resolve(jobPath));
  const url = (p) => `/${relative(ROOT, p)}`;
  const fps = raw.fps ?? 60;
  const frames = Math.round(raw.duration * fps);
  const area = raw.area;
  const scale = Math.min(raw.width / area.w, raw.height / area.h);
  const map = { sx: area.x, sy: area.y, scale, ox: Math.round((raw.width - area.w * scale) / 2), oy: Math.round((raw.height - area.h * scale) / 2) };
  const windows = [];
  for (const w of raw.windows) {
    if (w.kind === 'image') {
      windows.push({ ...w, src: url(`${dir}/${w.file}`), visibleFrom: w.visibleFrom ?? -Infinity, visibleUntil: w.visibleUntil ?? Infinity });
      continue;
    }
    const meta = JSON.parse(readFileSync(`${dir}/${w.id}.json`, 'utf8'));
    const src = `${dir}/${w.id}.webm`;
    const seekable = `${dir}/${w.id}.cues.webm`;
    remux(src, seekable);
    const pts = packetTimes(seekable);
    const latency = w.latency ?? LATENCY_MS[meta.kind] ?? 0;
    const firstPts = pts[0];
    // content time of every recorded frame: the animation frame it was requested in, or else its
    // presentation time after the first frame's measured start
    const anchor = anchorOf(meta, pts);
    const stale = anchor?.stale ?? staleFrames(meta);
    const content = meta.requested?.length ? matchRequested(pts, meta.requested, { stale, delay: anchor?.delay ?? null }) : pts.map((p) => meta.startedAt - latency + (p - firstPts) * 1000);
    const valid = content.filter(Number.isFinite);
    const contentStart = valid[0];
    const lastContent = valid[valid.length - 1];
    const logEnd = meta.log[meta.log.length - 1].t;
    const visibleFrom = Math.max(contentStart, w.visibleFrom ?? -Infinity);
    const visibleUntil = Math.min(w.visibleUntil ?? Infinity, logEnd, lastContent + 1000 / fps);
    // Frames are drawn on the display's vsync, so a window's frame times keep one phase against the
    // output's 60 fps grid. When that phase is near zero, "the last frame drawn at or before T" would
    // flip on sub-millisecond jitter (a repeat, then a skip); then the nearest frame is taken instead,
    // which moves the decision half a frame away from the frame times.
    const P = 1000 / fps;
    const inClip = valid.filter((c) => c >= raw.t0 && c <= raw.t0 + raw.duration * 1000);
    const phases = inClip.map((c) => (((c - raw.t0) % P) + P) % P).map((v) => (v > P / 2 ? v - P : v)).sort((a, b) => a - b);
    const phase = phases.length ? phases[phases.length >> 1] : 0;
    const nearest = Math.abs(phase) < P / 4;
    const slack = nearest ? P / 2 : 1e-3;
    const chosen = new Array(frames).fill(-1);
    let j = 0;
    for (let k = 0; k < frames; k++) {
      const T = raw.t0 + (k * 1000) / fps;
      if (T < visibleFrom || T > visibleUntil) continue;
      // the last frame drawn at or before T (+ slack; frames that answer no request are skipped)
      while (j + 1 < content.length && !(content[j + 1] > T + slack)) j++;
      let i = j;
      while (i >= 0 && !Number.isFinite(content[i])) i--;
      if (i >= 0 && content[i] <= T + slack) chosen[k] = i;
    }
    const used = chosen.filter((p) => p >= 0);
    // the frames the job wants this window in (all of the clip, unless it opens or closes during it)
    let wanted = 0;
    for (let k = 0; k < frames; k++) {
      const T = raw.t0 + (k * 1000) / fps;
      if (T >= (w.visibleFrom ?? -Infinity) && T <= (w.visibleUntil ?? Infinity)) wanted++;
    }
    // repeats the recording explains: output frames inside gaps where the page drew nothing new
    let explained = 0;
    for (let i = 1; i < valid.length; i++) {
      if (valid[i] < visibleFrom || valid[i - 1] > Math.min(visibleUntil, raw.t0 + raw.duration * 1000)) continue;
      explained += Math.max(0, Math.round((valid[i] - valid[i - 1]) / P) - 1);
    }
    // seek targets: the middle of each chosen frame's display interval, robust to timestamp rounding
    const seekTo = chosen.map((i) => (i < 0 ? -1 : i + 1 < pts.length ? (pts[i] + pts[i + 1]) / 2 : pts[i] + 0.008));
    const shownPts = chosen.map((i) => (i < 0 ? -1 : pts[i]));
    const nextPts = chosen.map((i) => (i < 0 ? -1 : i + 1 < pts.length ? pts[i + 1] : pts[i] + 0.016));
    const distinct = new Set(used).size;
    windows.push({
      id: w.id, kind: 'video', src: url(seekable), z: w.z ?? 0, titleBar: w.titleBar ?? null, dark: !!w.dark, fixedTitle: w.title ?? null,
      log: meta.log, texts: w.labels === false ? null : (meta.texts?.length ? meta.texts : null), frames: shownPts, seekTo, nextPts,
      visibleFrom, visibleUntil, dpr: meta.log[0]?.dpr ?? 1,
      report: { method: meta.requested?.length ? `requested (${pts.length} frames / ${meta.requested.length} requests, ${stale ?? '?'} stale, ${anchor ? 'anchored' : 'not anchored'})` : `startedAt-${latency}ms`, pick: `${nearest ? 'nearest' : 'latest'} (phase ${phase.toFixed(2)} ms)`, frames: used.length, wanted, distinctSourceFrames: distinct, repeated: used.length - distinct, explained, visibleFrom: Math.round(visibleFrom - raw.t0), visibleUntil: Math.round(visibleUntil - raw.t0) },
    });
  }
  return { name: raw.name, width: raw.width, height: raw.height, fps, frames, t0: raw.t0, map, background: raw.background ?? 'stage', stageGrid: raw.stageGrid ?? { x: area.x, y: area.y }, windows, audio: raw.audio ?? null, dir };
}

export async function compose(jobPath, outFile, first = 0, last = Infinity) {
  mkdirSync(dirname(outFile), { recursive: true });
  const job = buildJob(jobPath);
  const problems = [];
  const end = Math.min(job.frames - 1, last);
  for (const w of job.windows) if (w.report) console.log(`  ${w.id}: ${JSON.stringify(w.report)}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1000,640', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await (await browser.newContext({ viewport: null })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${BASE}/tools/capture/compose.html`);
    const { dir: _dir, audio: _audio, ...pageJob } = job;
    const init = await page.evaluate((j) => window.compose.init(j), pageJob);
    if (!init.fonts) throw new Error('fonts did not load');

    if (outFile.endsWith('.png')) {
      writeFileSync(outFile, Buffer.from(await page.evaluate((i) => window.compose.frame(i), first), 'base64'));
      return { job, problems };
    }
    const args = ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(job.fps), '-c:v', 'png', '-i', '-'];
    const audio = job.audio;
    if (audio) {
      const offset = (job.t0 + (first * 1000) / job.fps - audio.startedAt) / 1000;
      if (offset >= 0) args.push('-ss', offset.toFixed(4), '-i', `${job.dir}/${audio.file}`);
      else args.push('-itsoffset', (-offset).toFixed(4), '-i', `${job.dir}/${audio.file}`);
      args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad');
    }
    args.push(
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-r', String(job.fps), '-t', ((end - first + 1) / job.fps).toFixed(4), '-movflags', '+faststart', outFile,
    );
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))));
    const t = Date.now();
    for (let k = first; k <= end; k++) {
      const png = Buffer.from(await page.evaluate((i) => window.compose.frame(i), k), 'base64');
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      if ((k - first) % 120 === 0) console.log(`  frame ${k}/${end} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
    ff.stdin.end();
    await done;
    const stats = await page.evaluate(() => window.compose.stats());
    console.log(`  composed ${end - first + 1} frames in ${((Date.now() - t) / 1000).toFixed(0)} s; seek mismatches ${JSON.stringify(stats)}`);
    // every repeated frame must be one the recording explains (the page drew nothing new), give or take two
    for (const w of job.windows) {
      if (w.report && w.report.frames < w.report.wanted - 3) problems.push(`${w.id}: shown in ${w.report.frames} of the ${w.report.wanted} frames it belongs in (its recording does not cover the clip, or its frames could not be matched)`);
      if (w.report && w.report.repeated > w.report.explained + 2) problems.push(`${w.id}: the composite repeats ${w.report.repeated} frames, the recording explains ${w.report.explained}`);
      const st = stats.find((x) => x.id === w.id);
      if (st && st.mismatches > 3) problems.push(`${w.id}: ${st.mismatches} frames could not be seeked exactly`);
    }
    if (errors.length) console.log('  page errors:', errors.slice(0, 5).join(' | '));
    return { job, stats, problems };
  } finally {
    await browser.close();
  }
}

/**
 * Composes one still of a single window at clock time T (a moment a real screenshot of the page was
 * taken), cropped to that window, to compare the redrawn labels with the page itself.
 */
export async function still(jobPath, id, T, outPng) {
  const raw = JSON.parse(readFileSync(jobPath, 'utf8'));
  const tmp = jobPath.replace(/\.json$/, `.still-${id}.json`);
  writeFileSync(tmp, JSON.stringify({ ...raw, t0: T, duration: 1 / (raw.fps ?? 60), windows: raw.windows.filter((w) => w.id === id).map((w) => ({ ...w, visibleFrom: undefined })), audio: undefined }));
  await compose(tmp, outPng);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [jobPath, outFile, a, b] = process.argv.slice(2);
  await compose(jobPath, outFile, a ? Number(a) : 0, b ? Number(b) : Infinity);
}
