// In-window chrome: specimen label, volume readout, graduation numerals, controls, shortcut help and credit.
// Static and crisp; the only thing that moves is the readout, counting with the water.

import { PX2_PER_ML, type Engine } from '../engine';
import { BENCH, DARKROOM, type Theme } from '../render/theme';
import { graduationStep } from '../render/water';
import css from './chrome.css?inline';
import { capital, el, isDark } from './dom';

export interface ChromeActions {
  addVessel(): void;
  float(): void;
  perform(): void;
  cycleLiquid(): void;
  toggleSound(): void;
  spanScreens(): void;
  stage(): void;
}

export interface ChromeState {
  liquid: string;
  sound: boolean;
  performing: boolean;
  floating: boolean;
}

export interface Chrome {
  update(state: Partial<ChromeState>): void;
  destroy(): void;
}

type Action = keyof ChromeActions;

interface ButtonSpec {
  action: Action;
  key: string;
  /** Visible text; the liquid button's comes from state. */
  text: string;
  /** Accessible name, when the visible text alone says too little. */
  name?: string;
  pressed?: 'floating' | 'performing' | 'sound';
  help: string;
}

const BUTTONS: readonly ButtonSpec[] = [
  { action: 'addVessel', key: 'v', text: '+ Vessel', name: 'Add a vessel', help: 'Add vessel' },
  { action: 'float', key: 'f', text: 'Float', name: 'Float in picture-in-picture', pressed: 'floating', help: 'Float' },
  { action: 'perform', key: 'p', text: 'Perform', pressed: 'performing', help: 'Perform' },
  { action: 'cycleLiquid', key: 'l', text: '', help: 'Change liquid' },
  { action: 'toggleSound', key: 's', text: 'Sound', pressed: 'sound', help: 'Sound' },
  { action: 'spanScreens', key: 'm', text: 'Span', name: 'Span screens', help: 'Span screens' },
  { action: 'stage', key: 'g', text: 'Stage', name: 'Stage mode', help: 'Stage' },
];

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

/** Left side bearing of each B612 Mono digit, em (measured from public/fonts/b612-mono-400.woff2). */
const DIGIT_LSB = [0.0705, 0.0925, 0.0915, 0.1135, 0.0755, 0.124, 0.0765, 0.0885, 0.0745, 0.075];
/** Round digits overshoot the straight edge they align with, as round letters overshoot a baseline. */
const BOWL = 0.008;
const BOWLS = '0689';
/** Left side bearing of "V" in B612, em. */
const LABEL_LSB = 0.0335;
const MONO_ADVANCE = 0.65;
/** Width of "mL" in B612 including its tracking, em. */
const UNIT_EM = 1.53;
/** Middle of a B612 Mono digit above the centre of a 9/9 px line box, px. */
const TICK_CAP_MID = 9 / 2 - 0.025 * 9;
const STACK_LEFT = 44;
const SIDE_INSET = 12;
/** Readout spring stiffness, rad/s. Critically damped, so it counts without overshoot. */
const SPRING = 9;

interface Sizes { label: number; num: number; unit: number; unitGap: number }
const FULL: Sizes = { label: 11, num: 56, unit: 11, unitGap: 2 };
const COMPACT: Sizes = { label: 10, num: 28, unit: 9, unitGap: 1 };

export function mountChrome(doc: Document, engine: Engine, actions: ChromeActions, initial: ChromeState): Chrome {
  const view = doc.defaultView ?? window;
  const state: ChromeState = { ...initial };

  // What can work here: popups and picture-in-picture windows only change the liquid and the sound.
  const pip = doc !== document;
  const popup = !pip && view.opener != null;
  const limited = pip || popup;
  const can: Record<Action, boolean> = {
    addVessel: !limited,
    float: !limited && 'documentPictureInPicture' in window,
    perform: !limited,
    cycleLiquid: true,
    toggleSound: true,
    spanScreens: !limited && 'getScreenDetails' in window,
    stage: !limited,
  };

  // ---------------------------------------------------------------- head

  const style = el(doc, 'style', undefined, css);
  style.dataset.tidal = 'chrome';
  doc.head.append(style);
  const fontsHref = `${location.origin}/fonts/fonts.css`;
  let fontLink: HTMLLinkElement | null = null;
  if (!Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some((l) => l.href === fontsHref)) {
    fontLink = el(doc, 'link');
    fontLink.rel = 'stylesheet';
    fontLink.href = fontsHref;
    doc.head.append(fontLink);
  }
  const existingMeta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const themeMeta = existingMeta ?? el(doc, 'meta');
  if (!existingMeta) { themeMeta.name = 'theme-color'; doc.head.append(themeMeta); }

  // ---------------------------------------------------------------- body

  const root = el(doc, 'div', 'tc');

  const scale = el(doc, 'div', 'tc-scale');
  scale.setAttribute('aria-hidden', 'true');

  // The canvas description and the live region speak for the readout; a number that changes every frame would only be noise.
  const stack = el(doc, 'div', 'tc-stack');
  stack.setAttribute('aria-hidden', 'true');
  const label = el(doc, 'div', 'tc-label');
  const readout = el(doc, 'div', 'tc-readout');
  const num = el(doc, 'span', 'tc-num', '0');
  readout.append(num, el(doc, 'span', 'tc-unit', 'mL'));
  stack.append(label, readout);

  const side = el(doc, 'div', 'tc-side');
  const controls = el(doc, 'div', 'tc-controls tc-knock');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Controls');
  const buttons = new Map<Action, { button: HTMLButtonElement; text: HTMLSpanElement }>();
  for (const spec of BUTTONS) {
    const button = el(doc, 'button', 'tc-btn');
    const text = el(doc, 'span', undefined, spec.text);
    button.type = 'button';
    button.append(text);
    button.hidden = !can[spec.action];
    if (spec.name) button.setAttribute('aria-label', spec.name);
    button.setAttribute('aria-keyshortcuts', spec.key.toUpperCase());
    if (spec.action === 'addVessel') button.id = 'add';
    button.addEventListener('click', () => actions[spec.action]());
    buttons.set(spec.action, { button, text });
    controls.append(button);
  }

  const help = el(doc, 'section', 'tc-knock');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  help.hidden = true;
  const keys = el(doc, 'dl', 'tc-help');
  const row = (key: string, what: string) => {
    const dt = el(doc, 'dt');
    dt.append(el(doc, 'span', undefined, key));
    keys.append(dt, el(doc, 'dd', undefined, what));
  };
  for (const spec of BUTTONS) if (can[spec.action]) row(spec.key, spec.help);
  row('Arrows', 'Slosh');
  if (can.perform) row('Esc', 'Stop performing');
  row('H', 'Shortcuts');
  help.append(keys);
  side.append(controls, help);

  root.append(scale, stack, side);
  if (!limited) {
    const credit = el(doc, 'footer', 'tc-credit tc-knock');
    credit.append(el(doc, 'span', undefined, 'Venkat Jaswanth'));
    root.append(credit);
  }
  doc.body.append(root);

  // ---------------------------------------------------------------- theme

  let applied: Theme | null = null;
  const applyTheme = (t: Theme) => {
    applied = t;
    const dark = isDark(t);
    const s = doc.documentElement.style;
    s.setProperty('--paper', t.paper);
    s.setProperty('--ink', t.ink);
    s.colorScheme = dark ? 'dark' : 'light';
    themeMeta.content = t.paper;
    root.toggleAttribute('data-dark', dark);
  };
  applyTheme(engine.theme);
  const schemeQuery = view.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    engine.theme = schemeQuery.matches ? DARKROOM : BENCH;
    applyTheme(engine.theme);
  };
  schemeQuery.addEventListener('change', onScheme);

  // ---------------------------------------------------------------- reduced motion

  const motionQuery = view.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  if (reduced) engine.command({ type: 'cmd', cmd: 'calm', value: true });
  const onMotion = () => {
    reduced = motionQuery.matches;
    engine.command({ type: 'cmd', cmd: 'calm', value: reduced });
  };
  motionQuery.addEventListener('change', onMotion);

  // ---------------------------------------------------------------- readout

  let sizes = FULL;
  let x = 0;          // spring position, mL
  let v = 0;          // spring velocity, mL/s
  let moving = false;
  let shown = -1;

  const renderNumber = (force = false) => {
    const n = Math.max(0, Math.round(x));
    if (n === shown && !force) return;
    shown = n;
    const s = String(n);
    num.textContent = s;
    // optical alignment: the leading digit's ink starts where the label's does
    const lead = s.charAt(0);
    const lsb = (DIGIT_LSB[s.charCodeAt(0) - 48] ?? 0.07) + (BOWLS.includes(lead) ? BOWL : 0);
    num.style.marginLeft = `${(LABEL_LSB * sizes.label - lsb * sizes.num).toFixed(2)}px`;
  };

  /** Critically damped spring towards the true volume; rests when it is within half a millilitre. */
  const stepReadout = (target: number, dt: number) => {
    if (reduced) {
      x = target; v = 0; moving = false;
    } else {
      const e0 = x - target;
      if (!moving && Math.abs(e0) >= 0.5) moving = true;
      if (moving) {
        const k = Math.exp(-SPRING * dt);
        const a = v + SPRING * e0;
        const e1 = (e0 + a * dt) * k;
        v = (v - SPRING * a * dt) * k;
        x = target + e1;
        if (Math.abs(e1) < 0.05 && Math.abs(v) < 0.5) { x = target; v = 0; moving = false; }
      }
    }
    renderNumber();
  };

  const renderLabel = (slot: number) => {
    label.textContent = `Vessel ${slot >= 0 ? String(slot + 1).padStart(2, '0') : '--'}`;
  };

  // ---------------------------------------------------------------- layout

  let helpOpen = false;
  const setHelp = (open: boolean) => {
    helpOpen = open && !root.hasAttribute('data-compact');
    help.hidden = !helpOpen;
  };

  /** Numerals beside the major graduations the canvas etches, kept clear of the top edge and the label stack. */
  const buildScale = (w: number, h: number) => {
    const { tickMl, major } = graduationStep(w, PX2_PER_ML);
    const every = tickMl * major;
    const pxPerMl = PX2_PER_ML / w;
    const clear = Math.max(24, readout.getBoundingClientRect().bottom + 8);
    const frag = doc.createDocumentFragment();
    for (let ml = every; ml * pxPerMl <= h; ml += every) {
      const y = h - ml * pxPerMl;
      if (y < clear) break;
      const tick = el(doc, 'span', 'tc-tick', String(ml));
      tick.style.top = `${(y - TICK_CAP_MID).toFixed(2)}px`;
      frag.append(tick);
    }
    scale.replaceChildren(frag);
  };

  const layout = () => {
    const w = view.innerWidth, h = view.innerHeight;
    const compact = w < 420 || h < 300;
    sizes = compact ? COMPACT : FULL;
    root.toggleAttribute('data-compact', compact);
    if (compact) setHelp(false);
    // the controls wrap rather than reach over a four-digit readout
    const stackRight = STACK_LEFT + 4 * MONO_ADVANCE * sizes.num + sizes.unitGap + UNIT_EM * sizes.unit;
    side.style.maxWidth = `${Math.max(0, Math.floor(w - SIDE_INSET - stackRight - 24))}px`;
    renderNumber(true);
    if (w > 0 && h > 0) buildScale(w, h);
  };

  // ---------------------------------------------------------------- state

  const render = () => {
    const liquid = buttons.get('cycleLiquid');
    if (liquid) {
      const name = capital(state.liquid);
      liquid.text.textContent = name;
      liquid.button.setAttribute('aria-label', `${name}, change liquid`);
    }
    for (const spec of BUTTONS) {
      if (spec.pressed) buttons.get(spec.action)?.button.setAttribute('aria-pressed', String(state[spec.pressed]));
    }
  };

  // ---------------------------------------------------------------- input

  const onKey = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.shiftKey && ev.key !== '?') return;
    // elements may belong to another window's realm, so test by tag rather than instanceof
    const target = ev.target as { tagName?: string; isContentEditable?: boolean } | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

    const arrow = ARROWS[ev.key];
    if (arrow) {
      ev.preventDefault();
      engine.command({ type: 'cmd', cmd: 'impulse', x: arrow[0], y: arrow[1] });
      return;
    }
    if (ev.key === 'Escape') {
      setHelp(false);
      if (state.performing) actions.perform();
      return;
    }
    if (ev.repeat) return;
    const key = ev.key.toLowerCase();
    if (key === '?' || key === 'h') {
      ev.preventDefault();
      setHelp(!helpOpen);
      return;
    }
    const spec = BUTTONS.find((b) => b.key === key);
    if (spec && can[spec.action]) {
      ev.preventDefault();
      actions[spec.action]();
    }
  };

  // ---------------------------------------------------------------- frames

  let last = performance.now();
  let slotShown = engine.slot;
  const onFrame = (e: Engine) => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (e.theme !== applied) applyTheme(e.theme);
    if (e.slot !== slotShown) { slotShown = e.slot; renderLabel(e.slot); }
    if (e.meta) stepReadout(e.ml, dt);
  };

  renderLabel(engine.slot);
  render();
  layout();
  engine.frameListeners.add(onFrame);
  view.addEventListener('resize', layout);
  view.addEventListener('keydown', onKey);

  return {
    update(patch) {
      Object.assign(state, patch);
      render();
    },
    destroy() {
      engine.frameListeners.delete(onFrame);
      view.removeEventListener('resize', layout);
      view.removeEventListener('keydown', onKey);
      schemeQuery.removeEventListener('change', onScheme);
      motionQuery.removeEventListener('change', onMotion);
      root.remove();
      style.remove();
      fontLink?.remove();
      if (!existingMeta) themeMeta.remove();
    },
  };
}
