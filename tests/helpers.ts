// Shared helpers for the Tidal suite: opening a world of windows, placing them, reading totals,
// and collecting console errors. Everything here is display-agnostic: positions are derived from the
// `screen.avail*` rectangle of the display the window is actually on.

import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const WORLD_ML = 1000;
export const TOTAL_TOLERANCE = 0.005;
export const APP_URL = '/';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Rect { x: number; y: number; w: number; h: number }

export interface World {
  context: BrowserContext;
  main: Page;
  popups: Page[];
  /** main first, then popups in the order they were opened. */
  all: Page[];
}

export interface WorldOptions {
  popups?: number;
  /** Query string for the main window, e.g. '?tier=5'. */
  query?: string;
  /** Inner (content) size of each popup, CSS px. */
  popupSize?: { w: number; h: number };
  contextOptions?: Parameters<Browser['newContext']>[0];
}

/** Tracks every context a test opens, collects console errors, and fails the test on any of them. */
export class Lab {
  readonly errors: string[] = [];
  private readonly contexts: BrowserContext[] = [];

  constructor(readonly browser: Browser) {}

  watch(page: Page, name: string): void {
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = m.location().url;
      if (/favicon\.ico/.test(url) || /favicon\.ico/.test(m.text())) return;
      this.errors.push(`${name} console.error: ${m.text()} (${url})`);
    });
    page.on('pageerror', (e) => this.errors.push(`${name} pageerror: ${e.message}`));
  }

  async context(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const context = await this.browser.newContext({ viewport: null, ...options });
    this.contexts.push(context);
    let n = 0;
    context.on('page', (p) => this.watch(p, `page${++n}`));
    return context;
  }

  /** A context with a single main window that has finished starting (leader, particles present). */
  async mainOnly(options: WorldOptions = {}): Promise<World> {
    const context = await this.context(options.contextOptions);
    const main = await context.newPage();
    this.watch(main, 'main');
    await main.goto(APP_URL + (options.query ?? ''));
    await main.waitForFunction(() => (window.tidal?.stats.particles ?? 0) > 0, null, { timeout: 30_000 });
    return { context, main, popups: [], all: [main] };
  }

  /** Main window plus `popups` popup vessels, all running. Windows are not laid out. */
  async world(options: WorldOptions = {}): Promise<World> {
    const w = await this.mainOnly(options);
    const size = options.popupSize ?? { w: 340, h: 263 };
    for (let i = 0; i < (options.popups ?? 0); i++) {
      const p = await openPopup(w.main, w.context, size);
      this.watch(p, `popup${i}`);
      w.popups.push(p);
      w.all.push(p);
    }
    return w;
  }

  async dispose(): Promise<void> {
    for (const c of this.contexts) await c.close().catch(() => undefined);
    this.contexts.length = 0;
  }
}

export const test = base.extend<{ lab: Lab }>({
  lab: async ({ browser }, use, testInfo) => {
    const lab = new Lab(browser);
    await use(lab);
    await lab.dispose();
    if (testInfo.status === testInfo.expectedStatus && lab.errors.length > 0) {
      throw new Error(`console errors:\n${lab.errors.slice(0, 10).join('\n')}`);
    }
  },
});
export { expect };

/** Open one popup vessel from `main` (window.open, as the "+ Vessel" button does) and wait until it is drawing. */
export async function openPopup(main: Page, context: BrowserContext, size = { w: 340, h: 263 }, at?: { left: number; top: number }): Promise<Page> {
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 15_000 }),
    main.evaluate(([s, a]) => {
      const pos = a ? `,left=${a.left},top=${a.top}` : '';
      window.open('/', 'v' + Math.random(), `popup,width=${s.w},height=${s.h + 67}${pos}`);
    }, [size, at ?? null] as const),
  ]);
  await popup.waitForFunction(() => (window.tidal?.stats.fps ?? 0) > 0, null, { timeout: 30_000 });
  return popup;
}

// ------------------------------------------------------------------ geometry

export interface Display { left: number; top: number; w: number; h: number }

/** Work area of the display a window is on, in the global screen coordinates `moveTo` uses. */
export function displayOf(page: Page): Promise<Display> {
  return page.evaluate(() => {
    const s = window.screen as Screen & { availLeft?: number; availTop?: number };
    return { left: s.availLeft ?? 0, top: s.availTop ?? 0, w: s.availWidth, h: s.availHeight };
  });
}

/** The content rectangle of a window in screen CSS px, as the world sees it. */
export function rectOf(page: Page): Promise<Rect> {
  return page.evaluate(() => window.tidal!.calibrator.rect());
}

/** Send a real pointer move so the window's content offset is calibrated exactly. */
export async function calibrate(page: Page): Promise<void> {
  await page.mouse.move(40, 40);
  await page.mouse.move(60, 60);
}

/**
 * Place a window so its content rectangle is exactly `r` (position and, optionally, size).
 * Popups use window.moveTo/resizeTo; the main window is moved through CDP, which also works for
 * windows that are not popups. The OS may clamp, so the result is read back and corrected twice.
 */
export async function setRect(page: Page, r: { x: number; y: number; w?: number; h?: number }, isMain = false): Promise<Rect> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isMain) {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      const cur = await page.evaluate(() => ({ dx: window.tidal!.calibrator.cal.dx, dy: window.tidal!.calibrator.cal.dy, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight }));
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      const chromeW = cur.ow - cur.iw, chromeH = cur.oh - cur.ih;
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: Math.round(r.x - cur.dx), top: Math.round(r.y - cur.dy), width: Math.round((r.w ?? cur.iw) + chromeW), height: Math.round((r.h ?? cur.ih) + chromeH) },
      });
      await cdp.detach();
    } else {
      await page.evaluate((t) => {
        const cal = window.tidal!.calibrator.cal;
        if (t.w !== undefined && t.h !== undefined) window.resizeTo(t.w + (outerWidth - innerWidth), t.h + (outerHeight - innerHeight));
        window.moveTo(Math.round(t.x - cal.dx), Math.round(t.y - cal.dy));
      }, r);
    }
    await sleep(250);
    const got = await rectOf(page);
    if (Math.abs(got.x - r.x) <= 1 && Math.abs(got.y - r.y) <= 1 && (r.w === undefined || Math.abs(got.w - r.w) <= 1) && (r.h === undefined || Math.abs(got.h - r.h) <= 1)) return got;
  }
  return rectOf(page);
}

export interface Layout {
  display: Display;
  main: Rect;
  popups: Rect[];
}

/**
 * Main window on the left of its display (resized to `mainSize`), popups of `popupSize` placed in a row
 * to the right of it. `gapMain` is the gap between main and the first popup; `gapPopups` between popups
 * (negative would overlap). Content rects are top-aligned unless `alignBottom` puts the popups' floors level with main's.
 */
export async function layoutRow(
  w: World,
  o: { mainSize?: { w: number; h: number }; popupSize?: { w: number; h: number }; gapMain?: number; gapPopups?: number; alignBottom?: boolean } = {},
): Promise<Layout> {
  const d = await displayOf(w.main);
  const mainSize = o.mainSize ?? { w: 620, h: 520 };
  const ps = o.popupSize ?? { w: 340, h: 263 };
  const gapMain = o.gapMain ?? 120;
  const gapPopups = o.gapPopups ?? 0;
  const top = d.top + 40 + 70; // keep the content rect clear of the display's top edge and title bars
  const mainRect = { x: d.left + 20, y: top, w: mainSize.w, h: mainSize.h };
  const mainGot = await setRect(w.main, mainRect, true);
  const popups: Rect[] = [];
  let x = mainRect.x + mainRect.w + gapMain;
  for (const p of w.popups) {
    popups.push(await setRect(p, { x, y: o.alignBottom ? top + mainSize.h - ps.h : top, w: ps.w, h: ps.h }));
    x += ps.w + gapPopups;
  }
  for (const p of w.all) await calibrate(p);
  return { display: d, main: mainGot, popups };
}

// ------------------------------------------------------------------ world reads

export interface Totals { ml: number[]; rainMl: number; total: number; frame: number; leader: string }

export function readTotals(page: Page): Promise<Totals> {
  return page.evaluate(() => {
    const m = window.tidal!.meta;
    if (!m) return { ml: [], rainMl: 0, total: NaN, frame: -1, leader: '' };
    const sum = m.ml.reduce((a, b) => a + b, 0) + m.rainMl;
    return { ml: m.ml.slice(), rainMl: m.rainMl, total: sum, frame: m.frame, leader: m.leader };
  });
}

export function slotOf(page: Page): Promise<number> {
  return page.evaluate(() => window.tidal!.slot);
}

export function mlOf(page: Page): Promise<number> {
  return page.evaluate(() => window.tidal!.ml);
}

export const deviation = (total: number): number => Math.abs(total - WORLD_ML) / WORLD_ML;

/** Wait until the rain from a restored world (or a closed vessel) has landed. */
export async function waitForNoRain(page: Page, below = 1, timeout = 15_000): Promise<void> {
  await page.waitForFunction((b) => (window.tidal?.meta?.rainMl ?? 99) < b, below, { timeout });
}

/** Wait until the world's total is back at 1000 within tolerance and no rain is falling. */
export async function waitForSettledTotal(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(({ tol }) => {
    const m = window.tidal?.meta;
    if (!m) return false;
    const total = m.ml.reduce((a, b) => a + b, 0) + m.rainMl;
    return m.rainMl < 1 && Math.abs(total - 1000) / 1000 <= tol;
  }, { tol: TOTAL_TOLERANCE }, { timeout });
}

/** Let the water find its level: a fixed settle plus rain wait. */
export async function settle(page: Page, ms = 3000): Promise<void> {
  await page.waitForTimeout(ms);
}

export interface SnapshotShare { count: number; inside: number; rain: number; fraction: number; ageMs: number; rectsUsed: number }

/**
 * The leader publishes a particle snapshot about every 100 ms, so while windows are moving fast it describes where
 * the vessels were a moment ago. Start remembering where every vessel is (page clock, every frame and every 8 ms)
 * so snapshotFraction can compare each snapshot with the rectangles of its own moment.
 */
export function startRectHistory(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __rects?: { t: number; r: { x: number; y: number; w: number; h: number }[] }[] };
    if (w.__rects) return;
    const hist = (w.__rects = [] as { t: number; r: { x: number; y: number; w: number; h: number }[] }[]);
    const note = (): void => {
      const t = performance.timeOrigin + performance.now();
      hist.push({ t, r: window.tidal!.registry.all().map((v) => ({ x: v.x, y: v.y, w: v.w, h: v.h })) });
      while (hist.length > 1 && hist[0]!.t < t - 2000) hist.shift();
    };
    setInterval(note, 8);
    const tick = (): void => { note(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

/**
 * Independent conservation check: decode the particle snapshot in the page and count the particles inside the union of
 * the vessel rectangles (expanded by `margin` px) or flagged as rain. With `startRectHistory` running, the union covers
 * every rectangle the vessels occupied from `slackMs` before the snapshot was requested to `slackMs` after; without it,
 * the current rectangles are used.
 */
export function snapshotFraction(page: Page, margin = 30, slackMs = 120): Promise<SnapshotShare> {
  return page.evaluate(([m, slack]) => {
    const e = window.tidal!;
    const snap = e.transport.latestSnapshot();
    if (!snap || snap.count === 0) return { count: 0, inside: 0, rain: 0, fraction: 0, ageMs: 0, rectsUsed: 0 };
    const hist = (window as unknown as { __rects?: { t: number; r: { x: number; y: number; w: number; h: number }[] }[] }).__rects;
    const now = performance.timeOrigin + performance.now();
    let all = e.registry.all().map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    if (hist && hist.length > 0) {
      const from = snap.t - slack!, to = snap.t + slack!;
      const used = hist.filter((h) => h.t >= from && h.t <= to).flatMap((h) => h.r);
      if (used.length > 0) all = used;
    }
    const rects = all.map((r) => ({ x0: r.x - m!, y0: r.y - m!, x1: r.x + r.w + m!, y1: r.y + r.h + m! }));
    const v = new DataView(snap.data.buffer, snap.data.byteOffset, snap.data.byteLength);
    let inside = 0, rain = 0;
    for (let i = 0; i < snap.count; i++) {
      const b = i * 12;
      if (snap.data[b + 11]! > 0) { rain++; inside++; continue; }
      const px = snap.originX + (v.getUint16(b, true) / 64) * 6;
      const py = snap.originY + (v.getUint16(b + 2, true) / 64) * 6;
      if (rects.some((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1)) inside++;
    }
    return { count: snap.count, inside, rain, fraction: inside / snap.count, ageMs: now - snap.t, rectsUsed: all.length };
  }, [margin, slackMs] as const);
}

// ------------------------------------------------------------------ small maths

export const median = (a: number[]): number => percentile(a, 0.5);

export function percentile(a: number[], p: number): number {
  if (a.length === 0) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]!;
}

export const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export const fmt = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));

// ------------------------------------------------------------------ rAF probe

/** Start recording requestAnimationFrame intervals in the page (idempotent). */
export function startRafProbe(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __raf?: { gaps: number[]; on: boolean; last: number } };
    if (!w.__raf) {
      const r = (w.__raf = { gaps: [] as number[], on: false, last: 0 });
      const tick = (now: number): void => {
        if (r.on && r.last) r.gaps.push(now - r.last);
        r.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    w.__raf.gaps.length = 0;
    w.__raf.on = true;
  });
}

/** Stop and return the rAF intervals (ms) recorded since startRafProbe. */
export function stopRafProbe(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __raf?: { gaps: number[]; on: boolean } };
    if (!w.__raf) return [];
    w.__raf.on = false;
    return w.__raf.gaps.slice();
  });
}

/** Display refresh rate observed from rAF intervals: the modal interval, rounded to a nominal rate. */
export function refreshRate(gaps: number[]): number {
  const m = median(gaps);
  return m > 0 ? Math.round(1000 / m) : NaN;
}

/** fps from rAF intervals: frames counted over the time they took. */
export function fpsOf(gaps: number[]): number {
  const t = gaps.reduce((a, b) => a + b, 0);
  return t > 0 ? (1000 * gaps.length) / t : 0;
}

// ------------------------------------------------------------------ meta recorder

export interface MetaSample { t: number; frame: number; ml: number[]; rainMl: number; total: number; leader: string; energy: number[]; impact: number[] }

/** Record `window.tidal.meta` on every animation frame for `ms` in the page. Await it later; it runs while the test acts. */
export function recordMeta(page: Page, ms: number): Promise<MetaSample[]> {
  return page.evaluate((dur) => new Promise<MetaSample[]>((resolve) => {
    const out: MetaSample[] = [];
    const t0 = performance.now();
    const tick = (now: number): void => {
      const m = window.tidal?.meta;
      if (m) out.push({ t: now - t0, frame: m.frame, ml: m.ml.slice(), rainMl: m.rainMl, total: m.ml.reduce((a, b) => a + b, 0) + m.rainMl, leader: m.leader, energy: m.energy.slice(), impact: m.impact.slice() });
      if (now - t0 < dur) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }), ms);
}

export interface TotalsTrack { frames: number; min: number; max: number; worst: number; maxRain: number }

/** Start tracking the world total on every frame in the page until stopTotals(). */
export function trackTotals(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __tot: { on: boolean; frames: number; min: number; max: number; maxRain: number } };
    const r = (w.__tot = { on: true, frames: 0, min: Infinity, max: -Infinity, maxRain: 0 });
    const tick = (): void => {
      const m = window.tidal?.meta;
      if (m) {
        const t = m.ml.reduce((a, b) => a + b, 0) + m.rainMl;
        r.frames++; r.min = Math.min(r.min, t); r.max = Math.max(r.max, t); r.maxRain = Math.max(r.maxRain, m.rainMl);
      }
      if (r.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function stopTotals(page: Page): Promise<TotalsTrack> {
  const r = await page.evaluate(() => {
    const t = (window as unknown as { __tot: { on: boolean; frames: number; min: number; max: number; maxRain: number } }).__tot;
    t.on = false;
    return { frames: t.frames, min: t.min, max: t.max, maxRain: t.maxRain };
  });
  return { ...r, worst: Math.max(deviation(r.min), deviation(r.max)) };
}
