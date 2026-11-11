// Derived launch files, from the composed films: the GIFs (8 MB at most), the poster, the social card
// and the small hero for the fallback page. Exits non-zero if any of them misses its spec.
// node tools/capture/derive.mjs [posterSeconds=8.8] [cardSeconds=2.7]
import { execFileSync } from 'node:child_process';
import { statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT, checkOutput } from './lib.mjs';
import { buildJob } from './compose.mjs';

const posterAt = Number(process.argv[2] ?? 8.8);
const cardAt = Number(process.argv[3] ?? 2.7);
const GIF_MAX = 8_000_000;
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...a]);
const bytes = (f) => statSync(f).size;
const problems = [];
const report = [];

for (const f of ['launch/hero.mp4', 'launch/clips/pip-float.mp4', 'launch/clips/ink-mix.mp4', 'launch/clips/rain-on-close.mp4']) {
  if (!existsSync(`${ROOT}${f}`)) { console.error(`derive: ${f} is missing; compose the films first`); process.exit(1); }
}

/** The first of these GIF settings that fits in 8 MB: full frame first, then smaller, then fewer frames. */
function gif(src, out, settings) {
  for (const s of settings) {
    const chain = `${s.crop ? `crop=${s.crop},` : ''}fps=${s.fps},scale=${s.w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${s.colors}:stats_mode=${s.stats ?? 'full'}[p];[b][p]paletteuse=dither=${s.dither}:diff_mode=rectangle`;
    ff('-i', src, '-vf', chain, out);
    if (bytes(out) <= GIF_MAX) return { ...s, bytes: bytes(out) };
  }
  problems.push(`${out.replace(ROOT, '')}: no setting fits in 8 MB (last ${bytes(out)} bytes)`);
  return null;
}
const ladder = [
  { w: 960, fps: 30, colors: 256, dither: 'sierra2_4a', stats: 'diff' },
  { w: 960, fps: 24, colors: 160, dither: 'bayer:bayer_scale=4' },
  { w: 800, fps: 20, colors: 128, dither: 'none' },
  { w: 720, fps: 20, colors: 96, dither: 'none' },
  { w: 640, fps: 20, colors: 96, dither: 'none' },
  { w: 640, fps: 15, colors: 96, dither: 'none' },
];
for (const n of ['pip-float', 'ink-mix', 'rain-on-close', 'hero']) {
  const src = n === 'hero' ? `${ROOT}launch/hero.mp4` : `${ROOT}launch/clips/${n}.mp4`;
  const out = `${ROOT}launch/clips/${n}.gif`;
  const s = gif(src, out, ladder);
  if (s) report.push(`${out.replace(ROOT, '')}: ${(s.bytes / 1e6).toFixed(2)} MB, ${s.w} px wide, ${s.fps} fps, ${s.colors} colours, dither ${s.dither}`);
}

// the windows' outer rectangles in the hero frame at film time `s`, from their logs
const job = buildJob(`${ROOT}launch/raw/hero/job.json`);
function windowsAt(s) {
  const T = job.t0 + s * 1000;
  const m = job.map;
  const out = [];
  for (const w of job.windows) {
    if (T < w.visibleFrom || T > w.visibleUntil) continue;
    const e = w.log.reduce((a, b) => (Math.abs(b.t - T) < Math.abs(a.t - T) ? b : a));
    out.push({ x: (e.outer.x - m.sx) * m.scale + m.ox, y: (e.outer.y - m.sy) * m.scale + m.oy, w: e.outer.w * m.scale, h: e.outer.h * m.scale });
  }
  return out;
}
/** The 1200:630 crop of the frame that holds every window at `s` with a margin, centred on them. */
function cardCrop(s) {
  const r = windowsAt(s);
  const x0 = Math.min(...r.map((a) => a.x)), y0 = Math.min(...r.map((a) => a.y));
  const x1 = Math.max(...r.map((a) => a.x + a.w)), y1 = Math.max(...r.map((a) => a.y + a.h));
  const aspect = 1200 / 630, pad = 48;
  let h = Math.max(y1 - y0 + 2 * pad, (x1 - x0 + 2 * pad) / aspect);
  h = Math.min(h, job.height, job.width / aspect);
  const w = Math.round(h * aspect); h = Math.round(h);
  const cx = Math.min(Math.max((x0 + x1) / 2, w / 2), job.width - w / 2);
  const cy = Math.min(Math.max((y0 + y1) / 2, h / 2), job.height - h / 2);
  const crop = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
  if (x0 < crop.x || y0 < crop.y || x1 > crop.x + w || y1 > crop.y + h) problems.push(`launch/og.png: the windows at ${s} s do not fit a 1200:630 crop; pick another moment`);
  return crop;
}

const tmp = mkdtempSync(`${tmpdir()}/tidal-derive-`);
ff('-ss', String(posterAt), '-i', `${ROOT}launch/hero.mp4`, '-frames:v', '1', '-update', '1', `${tmp}/poster.png`);
ff('-i', `${tmp}/poster.png`, '-q:v', '2', '-pix_fmt', 'yuvj444p', `${ROOT}public/hero-poster.jpg`);
const c = cardCrop(cardAt);
ff('-ss', String(cardAt), '-i', `${ROOT}launch/hero.mp4`, '-frames:v', '1', '-update', '1', `${tmp}/card.png`);
ff('-i', `${tmp}/card.png`, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1200:630:flags=lanczos`, `${ROOT}launch/og.png`);
rmSync(tmp, { recursive: true, force: true });
ff('-i', `${ROOT}launch/hero.mp4`, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `${ROOT}public/hero.mp4`);

const dims = (f) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
if (dims(`${ROOT}launch/og.png`) !== '1200,630') problems.push(`launch/og.png is ${dims(`${ROOT}launch/og.png`)}, not 1200×630`);
if (dims(`${ROOT}public/hero-poster.jpg`) !== '1920,1080') problems.push('public/hero-poster.jpg is not 1920×1080');
const small = checkOutput(`${ROOT}public/hero.mp4`, { min: 10, max: 15, audio: true, width: 1280, height: 720 });
problems.push(...small.problems);
if (small.facts.bytes > 4_000_000) problems.push(`public/hero.mp4 is ${(small.facts.bytes / 1e6).toFixed(2)} MB, over 4 MB`);
report.push(`public/hero-poster.jpg: frame at ${posterAt} s, ${(bytes(`${ROOT}public/hero-poster.jpg`) / 1e3).toFixed(0)} KB`);
report.push(`launch/og.png: frame at ${cardAt} s, crop ${c.w}×${c.h} at ${c.x},${c.y}, ${(bytes(`${ROOT}launch/og.png`) / 1e3).toFixed(0)} KB`);
report.push(`public/hero.mp4: ${(small.facts.bytes / 1e6).toFixed(2)} MB, 1280×720, ${small.facts.frames} frames, sound ${small.facts.audio ? 'yes' : 'no'}`);
console.log(report.join('\n'));
if (problems.length) { console.error(`\nderive: FAILED\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('\nderive: OK');
