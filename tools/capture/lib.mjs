// Shared helpers for the capture scripts: launching Chrome, opening Tidal windows, pulling the
// self-recordings out of the pages, and measuring them with ffprobe.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
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

/** Tidal window URL for capture: `?capture` loads the recorder; `tier=0` keeps full quality (no automatic ladder mid-film). */
export const TIDAL = `${BASE}/?capture&tier=0`;

/**
 * Opens the main Tidal page on the display Chrome starts on, inside its work area, and waits until it
 * leads the world. Returns { main, area }.
 */
export async function openMain(context, errors, { width = 620, height = 420 } = {}) {
  const main = await context.newPage();
  watch(main, 'main', errors);
  await main.goto('about:blank');
  const screen = await pickDisplay(context, main);
  // top left, clear of every vessel in the clips: the litre it starts with must not already sit inside one
  await setBounds(context, main, { left: screen.x, top: screen.y, width, height });
  await main.goto(TIDAL);
  await main.waitForFunction(() => window.tidal?.stats.particles > 0 && window.tidalApp && window.tidalCapture, null, { timeout: 30000 });
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

/** Takes the main window out of the world for good: it holds no water (Perform and Stage do the same while they run). */
export const sitOut = (page) => page.evaluate(() => {
  const e = window.tidal;
  const set = e.setActive.bind(e);
  e.setActive = () => set(false);
  set(false);
});

/** Keeps a vessel out of the world until `open(page)`. */
export const gate = (page) => page.evaluate(() => {
  const e = window.tidal;
  const set = e.setActive.bind(e);
  window.__gate = false;
  e.setActive = (a) => set(a && window.__gate);
  set(false);
});

export async function openVessel(context, opener, { x, y, w, h }, name, errors, titleBar = 67) {
  const p = await openPopup(context, opener, TIDAL, { left: x, top: y, width: w, height: h - titleBar, name });
  if (errors) watch(p, name, errors);
  await p.waitForFunction(() => window.tidal?.stats.fps > 0 && window.tidalCapture && window.tidal.meta, null, { timeout: 30000 });
  // window.open can land a pixel short; settle on the exact outer size
  await p.evaluate(([x, y, w, h]) => { resizeTo(w, h); moveTo(x, y); }, [x, y, w, h]);
  await p.waitForFunction(([w, h]) => outerWidth === w && outerHeight === h, [w, h], { timeout: 5000 }).catch(() => {});
  return p;
}

/** Waits until a vessel's liquid has been still for `quietMs` (and at least `minMs` in all). */
export async function settle(page, { minMs = 4000, quietMs = 1500, maxMs = 20000 } = {}) {
  const t = Date.now();
  let quietSince = null;
  for (;;) {
    const s = await page.evaluate(() => ({ e: window.tidal.meta?.energy[window.tidal.slot] ?? 1, ml: window.tidal.ml }));
    const now = Date.now();
    if (s.e < 3e-5) quietSince ??= now; else quietSince = null;
    if (now - t >= minMs && quietSince && now - quietSince >= quietMs) return { ...s, ms: now - t };
    if (now - t > maxMs) return { ...s, ms: now - t, timeout: true };
    await sleep(200);
  }
}

export const clockOf = (page) => page.evaluate(() => performance.timeOrigin + performance.now());

export function writeJob(dir, job) {
  writeFileSync(`${dir}/job.json`, JSON.stringify(job, null, 1));
  return `${dir}/job.json`;
}
