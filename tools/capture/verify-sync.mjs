// End-to-end check of frame exactness: composes the sync recording made by
// `SYNC_GPU=1 SYNC_KINDS=canvas node tools/capture/experiment.mjs sync` and decodes the counter from
// every output frame. Output frame k must show the last number painted at or before t0 + k/60.
// node tools/capture/verify-sync.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT } from './lib.mjs';
import { compose } from './compose.mjs';

const dir = `${ROOT}launch/raw/experiment`;
const meta = JSON.parse(readFileSync(`${dir}/sync-canvas.json`, 'utf8'));
const painted = JSON.parse(readFileSync(`${dir}/sync-canvas.painted.json`, 'utf8'));
// two output grids: 8 ms after the frame times (the compositor takes the last frame drawn at or before T)
// and 0.7 ms after them (too close to call: it takes the nearest frame)
let failed = 0;
for (const [offset, rule] of [[8, 'latest'], [0.7, 'nearest']]) {
  const t0 = meta.requested[10] + offset;
  const job = {
    name: 'verify-sync', width: 1920, height: 1080, fps: 60, t0, duration: 2,
    area: { x: -219, y: -1050, w: 1920, h: 1050 }, background: 'stage',
    windows: [{ id: 'sync-canvas', z: 0, labels: false }],
  };
  writeFileSync(`${dir}/verify-job.json`, JSON.stringify(job));
  const out = `${dir}/verify-sync.mp4`;
  await compose(`${dir}/verify-job.json`, out);
  // where the window's viewport lands in the frame
  const e = meta.log[0];
  const fx = Math.round(e.x - job.area.x), fy = Math.round(e.y - job.area.y) + 15;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `crop=${Math.round(e.w)}:40:${fx}:${fy + 20},scale=12:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  let ok = 0, bad = 0;
  const misses = [];
  for (let k = 0; k * 12 < raw.length; k++) {
    let n = 0;
    for (let b = 0; b < 12; b++) n = (n << 1) | (raw[k * 12 + b] > 127 ? 1 : 0);
    const T = t0 + (k * 1000) / 60;
    let want = null, best = Infinity;
    for (const [m, t] of painted) {
      if (rule === 'latest' ? t <= T + 1e-3 : Math.abs(t - T) < best) { want = m; best = Math.abs(t - T); }
    }
    if (n === want) ok++; else { bad++; if (misses.length < 6) misses.push({ k, got: n, want }); }
  }
  failed += bad;
  console.log(`frame exactness (${rule} frame, grid ${offset} ms after the frame times): ${ok} of ${ok + bad} output frames show the expected source frame`, misses.length ? JSON.stringify(misses) : '');
  console.log(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,pix_fmt', '-of', 'csv=p=0', out]).toString().trim());
}
process.exit(failed ? 1 : 0);
