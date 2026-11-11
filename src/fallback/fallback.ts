// The page shown when WebGPU is missing or will not start: the hero film and one honest line.

import './fallback.css';

export type FallbackReason = 'no-webgpu' | 'no-adapter' | 'error';

const SOURCE_URL = 'https://github.com/Venkat-jaswanth/tidal';
const FONTS_CSS = '/fonts/fonts.css';
/** Fine ruling pitch and major-line spacing, CSS px (matches the renderer's BENCH / DARKROOM themes). */
const FINE = 8;
const MAJOR = 80;
/** The frame may stray this far from 16:9 to land all four edges on the ruling. */
const RATIO_SLACK = 0.02;

/** Replace the app with the static fallback page. Safe to call more than once. */
export function showFallback(doc: Document, reason: FallbackReason): void {
  const root = doc.documentElement;
  root.dataset.gpu = 'no';
  doc.title = 'Tidal';
  ensureFonts(doc);

  doc.getElementById('tank')?.remove();
  doc.getElementById('vessel')?.remove();
  doc.querySelector('.tfb')?.remove();
  for (const el of Array.from(doc.body.children)) {
    if (el instanceof HTMLElement && !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(el.tagName)) {
      el.hidden = true;
      el.setAttribute('inert', '');
    }
  }

  const win = doc.defaultView;
  const still = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  // A zero-size inline box sitting on a line's baseline, so layout can be measured against the ruling.
  const probe = (): HTMLSpanElement => {
    const s = make('span', 'tfb-probe');
    s.setAttribute('aria-hidden', 'true');
    return s;
  };
  const firstLine = <T extends HTMLElement>(el: T): [T, HTMLElement] => { const p = probe(); el.prepend(p); return [el, p]; };

  const page = make('div', 'tfb');
  page.dataset.reason = reason;
  const main = make('main', 'tfb-main');

  const [label, labelBase] = firstLine(make('p', 'tfb-label', 'Tidal'));
  const title = make('h1', 'tfb-title', 'Water that lives across your browser ');
  const lastWord = make('span', 'tfb-nowrap', 'windows.');
  const titleBase = probe();
  lastWord.append(titleBase);
  title.append(lastWord);

  const film = make('div', 'tfb-film');
  const placeholder = make('p', 'tfb-film-label', '10 second film');
  placeholder.setAttribute('aria-hidden', 'true');
  const poster = make('img', 'tfb-poster');
  poster.alt = '';
  poster.decoding = 'async';
  poster.addEventListener('load', () => { if (poster.naturalWidth > 0) film.dataset.poster = 'yes'; });
  poster.src = '/hero-poster.jpg';
  film.append(placeholder, poster, heroVideo(doc, film, still));

  // no-break spaces keep "It" off the end of a line and the last line from being one word
  const need = firstLine(make('p', 'tfb-need', 'Tidal needs WebGPU to simulate the water. It runs in current Chrome, Edge, Safari and Firefox on a computer or phone with a recent graphics chip.'));
  const error = reason === 'error' ? firstLine(make('p', 'tfb-error', 'Something went wrong starting the graphics device. Reloading usually fixes it.')) : null;
  const link = make('a', 'tfb-link', 'Source on GitHub');
  link.href = SOURCE_URL;
  const linkLine = firstLine(link);

  main.append(label, title, film, need[0]);
  if (error) main.append(error[0]);
  main.append(link);
  page.append(main, make('footer', 'tfb-foot', 'Venkat Jaswanth'));
  doc.body.append(page);

  if (!win) return;
  const below = [need, ...(error ? [error] : []), linkLine];
  register(win, page, main, film, () => {
    // Seat the text on the ruling: each block's margin moves by at most 4 px from the design value.
    const filmTop = film.getBoundingClientRect().top;
    seat(film, 40, () => filmTop - top(titleBase));
    seat(title, 24, () => top(titleBase) - top(labelBase));
    for (const [el, base] of below) seat(el, el === link ? 18 : el === error?.[0] ? 8 : 24, () => top(base) - film.getBoundingClientRect().top);
  });
}

const top = (el: Element): number => el.getBoundingClientRect().top;

/**
 * Nudge `el`'s top margin so that `gap()` (which grows one-for-one with that margin) becomes a whole
 * number of fine cells, keeping the margin within 4 px of `design`.
 */
function seat(el: HTMLElement, design: number, gap: () => number): void {
  const current = parseFloat(getComputedStyle(el).marginTop) || design;
  const off = ((gap() % FINE) + FINE) % FINE;
  const miss = off > FINE / 2 ? off - FINE : off;
  // Layout rounds to 1/64 px and centring halves every change, so chasing the last hundredth would
  // ping-pong with the ResizeObserver forever.
  if (Math.abs(miss) < 0.1 && current >= design - FINE / 2 && current < design + FINE / 2) return;
  let m = current - miss;
  while (m < design - FINE / 2) m += FINE;
  while (m >= design + FINE / 2) m -= FINE;
  m = Math.round(m * 100) / 100;
  if (Math.abs(m - current) > 0.01) el.style.marginTop = `${m}px`;
}

function ensureFonts(doc: Document): void {
  const has = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some((l) => l.getAttribute('href') === FONTS_CSS);
  if (has) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS_CSS;
  doc.head.append(link);
}

/** The hero film. It stays invisible until it can actually draw, so a missing file never shows browser error chrome. */
function heroVideo(doc: Document, film: HTMLElement, still: boolean): HTMLVideoElement {
  const video = doc.createElement('video');
  video.className = 'tfb-video';
  video.setAttribute('aria-label', 'A ten second film: water pouring between browser windows');
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute('muted', '');
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.poster = '/hero-poster.jpg';
  const show = (): void => { if (video.isConnected) film.dataset.video = 'yes'; };
  if (still) {
    // reduced motion: no autoplay; the native controls let the viewer choose
    video.controls = true;
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', show, { once: true });
  } else {
    video.autoplay = true;
    // only once frames are moving: a blocked autoplay keeps the poster or the panel instead of a stalled player
    video.addEventListener('playing', show, { once: true });
  }
  video.addEventListener('error', () => {
    delete film.dataset.video;
    video.remove();
  }, { once: true });
  video.src = '/hero.mp4';
  return video;
}

/**
 * Size the film frame so its four edges fall on the ruling, let `align` seat the text, then register
 * the ruling to the frame's top-left corner. The border covers the lines it meets instead of running a
 * hairline beside them.
 */
function register(win: Window, page: HTMLElement, main: HTMLElement, film: HTMLElement, align: () => void): void {
  let busy = false;
  const update = (): void => {
    if (!page.isConnected || busy) return;
    busy = true;
    const avail = main.clientWidth;
    const w = Math.floor((avail - 1) / FINE) * FINE;
    const h = Math.round((w * 9) / 16 / FINE) * FINE;
    if (w >= 6 * FINE && Math.abs(w / h - 16 / 9) / (16 / 9) <= RATIO_SLACK) {
      film.style.width = `${w + 1}px`;
      film.style.height = `${h + 1}px`;
      film.style.aspectRatio = 'auto';
    } else {
      film.style.removeProperty('width');
      film.style.removeProperty('height');
      film.style.removeProperty('aspect-ratio');
    }
    align();
    const dpr = win.devicePixelRatio || 1;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    const mod = (v: number): number => ((v % MAJOR) + MAJOR) % MAJOR;
    const p = page.getBoundingClientRect();
    const f = film.getBoundingClientRect();
    page.style.setProperty('--tfb-gx', `${snap(mod(f.left - p.left))}px`);
    page.style.setProperty('--tfb-gy', `${snap(mod(f.top - p.top))}px`);
    busy = false;
  };
  update();
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(main);
  win.addEventListener('resize', update);
  void win.document.fonts?.ready.then(update);
}
