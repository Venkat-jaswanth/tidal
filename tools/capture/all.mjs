// Shoots every launch film and derives the rest, unattended:
//   hero.mjs, ink.mjs, rain.mjs, pip.mjs, then derive.mjs.
// Each script retries a bad take (CAPTURE_ATTEMPTS, default 3) and exits non-zero when it cannot get a
// good one. Prints one table of the outputs; exits non-zero if anything failed.
// node tools/capture/all.mjs
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { ROOT } from './lib.mjs';

const films = ['hero.mjs', 'ink.mjs', 'rain.mjs', 'pip.mjs'];
const status = {};
const t = Date.now();
for (const script of films) {
  console.log(`\n######## ${script}`);
  const r = spawnSync(process.execPath, [`${ROOT}tools/capture/${script}`], { stdio: 'inherit', env: process.env });
  status[script] = r.status === 0;
}
const filmsOk = Object.values(status).every(Boolean);
if (filmsOk) {
  console.log('\n######## derive.mjs');
  status['derive.mjs'] = spawnSync(process.execPath, [`${ROOT}tools/capture/derive.mjs`], { stdio: 'inherit' }).status === 0;
} else {
  status['derive.mjs'] = false;
  console.log('\nderive.mjs skipped: a film failed');
}

const take = (dir) => (existsSync(`${ROOT}${dir}/take.json`) ? JSON.parse(readFileSync(`${ROOT}${dir}/take.json`, 'utf8')) : null);
const probe = (f) => {
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,width,height', '-show_entries', 'format=duration', '-of', 'json', f]).toString());
    const v = j.streams.find((s) => s.codec_type === 'video');
    return { duration: Number(j.format.duration), fps: v?.r_frame_rate, size: `${v?.width}×${v?.height}`, audio: j.streams.some((s) => s.codec_type === 'audio') };
  } catch { return null; }
};
const rows = [];
const add = (file, stall, still = false) => {
  const p = `${ROOT}${file}`;
  if (!existsSync(p)) { rows.push([file, 'MISSING', '', '', '', '', '']); return; }
  const f = probe(p);
  const [n, d] = (f?.fps ?? '0/1').split('/').map(Number);
  const fps = d ? String(Math.round((n / d) * 100) / 100) : '';
  rows.push([file, still || !f ? '—' : `${f.duration.toFixed(2)} s`, still ? '—' : fps, f?.size ?? '', `${(statSync(p).size / 1e6).toFixed(2)} MB`, still ? '—' : f?.audio ? 'yes' : 'no', stall]);
};
const stallOf = (script, dir) => { const tj = take(dir); return !status[script] ? 'FAILED' : tj ? `${tj.worstStallMs} ms` : '?'; };
add('launch/hero.mp4', stallOf('hero.mjs', 'launch/raw/hero'));
add('launch/clips/pip-float.mp4', stallOf('pip.mjs', 'launch/raw/pip-float'));
add('launch/clips/ink-mix.mp4', stallOf('ink.mjs', 'launch/raw/ink-mix'));
add('launch/clips/rain-on-close.mp4', stallOf('rain.mjs', 'launch/raw/rain-on-close'));
for (const g of ['hero', 'pip-float', 'ink-mix', 'rain-on-close']) add(`launch/clips/${g}.gif`, '—');
add('public/hero.mp4', '—');
add('launch/og.png', '—', true);
add('public/hero-poster.jpg', '—', true);

const head = ['file', 'duration', 'fps', 'frame', 'size', 'audio', 'worst in-clip stall'];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => String(c).padEnd(width[i])).join('  ');
console.log(`\n${line(head)}\n${width.map((w) => '-'.repeat(w)).join('  ')}\n${rows.map(line).join('\n')}`);
console.log(`\n${Object.entries(status).map(([s, ok]) => `${s} ${ok ? 'OK' : 'FAILED'}`).join(' · ')}  (${((Date.now() - t) / 60000).toFixed(1)} min)`);
process.exit(Object.values(status).every(Boolean) ? 0 : 1);
