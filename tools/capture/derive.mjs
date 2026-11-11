// Derived launch files, from the composed films: the GIFs, the poster, the social card and the small
// hero for the fallback page. node tools/capture/derive.mjs [posterSeconds=8.45]
import { execFileSync } from 'node:child_process';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from './lib.mjs';

const at = process.argv[2] ?? '8.45';
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...a]);
const gif = (src, out, chain, colors, dither) => ff('-i', src, '-vf', `${chain},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`, out);
const size = (f) => `${f.replace(ROOT, '')} ${(statSync(f).size / 1e6).toFixed(2)} MB`;

for (const n of ['pip-float', 'ink-mix', 'rain-on-close']) {
  const out = `${ROOT}launch/clips/${n}.gif`;
  ff('-i', `${ROOT}launch/clips/${n}.mp4`, '-vf', 'fps=30,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', out);
  console.log(size(out));
}
// the film uses the lower part of the stage: the GIF keeps the region the windows move through
gif(`${ROOT}launch/hero.mp4`, `${ROOT}launch/clips/hero.gif`, 'crop=1520:820:270:262,fps=20,scale=680:-1:flags=lanczos', 96, 'none');
console.log(size(`${ROOT}launch/clips/hero.gif`));

const tmp = mkdtempSync(`${tmpdir()}/tidal-derive-`);
ff('-ss', at, '-i', `${ROOT}launch/hero.mp4`, '-frames:v', '1', '-update', '1', `${tmp}/frame.png`);
ff('-i', `${tmp}/frame.png`, '-q:v', '2', '-pix_fmt', 'yuvj444p', `${ROOT}public/hero-poster.jpg`);
ff('-i', `${tmp}/frame.png`, '-vf', 'crop=1600:840:64:240,scale=1200:630:flags=lanczos', `${ROOT}launch/og.png`);
rmSync(tmp, { recursive: true, force: true });
ff('-i', `${ROOT}launch/hero.mp4`, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `${ROOT}public/hero.mp4`);
for (const f of ['public/hero-poster.jpg', 'launch/og.png', 'public/hero.mp4']) console.log(size(`${ROOT}${f}`));
