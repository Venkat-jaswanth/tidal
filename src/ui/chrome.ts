// In-window chrome: specimen label, volume readout, specimen line, graduation numerals, controls, shortcut
// help and credit. Everything is printed on the glass: no plates, only a tight paper-coloured halo that keeps
// the text legible over paper and over any liquid. The only thing that moves is the readout, counting with
// the water.

import { PX2_PER_ML, WORLD_ML, type Engine } from '../engine';
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

/** What a button shows and says. `lead` is a word printed before the value ("Liquid" Water). The name always
 *  contains the visible words, in order (WCAG 2.5.3, label in name), so speech users can say what they see. */
interface Face {
  lead?: string;
  /** The lead is printed at a lower contrast than the value. */
  quietLead?: boolean;
  text: string;
  name: string;
}

interface ButtonSpec {
  action: Action;
  key: string;
  /** 1: actions, full ink. 2: settings, quieter. */
  row: 1 | 2;
  /** Element id, for tests and tools. */
  id?: string;
  face(s: ChromeState): Face;
  /** The state a toggle reports through aria-pressed. */
  pressed?: 'sound';
  help: string;
}

const BUTTONS: readonly ButtonSpec[] = [
  { action: 'addVessel', key: 'v', row: 1, id: 'add', help: 'Add a vessel',
    face: () => ({ text: '+ Vessel', name: 'Add a vessel' }) },
  { action: 'float', key: 'f', row: 1, id: 'float', help: 'Float',
    face: (s) => (s.floating ? { text: 'Unfloat', name: 'Unfloat: close the floating tank' } : { text: 'Float', name: 'Float: open the floating tank' }) },
  { action: 'perform', key: 'p', row: 1, id: 'perform', help: 'Perform',
    face: (s) => (s.performing ? { text: 'Stop', name: 'Stop the performance' } : { text: 'Perform', name: 'Perform: start the performance' }) },
  { action: 'cycleLiquid', key: 'l', row: 2, id: 'liquid', help: 'Change liquid',
    face: (s) => ({ lead: 'Liquid', quietLead: true, text: capital(s.liquid), name: `Liquid: ${s.liquid}. Change liquid` }) },
  { action: 'toggleSound', key: 's', row: 2, id: 'sound', pressed: 'sound', help: 'Sound on or off',
    face: (s) => ({ lead: 'Sound', text: s.sound ? 'On' : 'Off', name: s.sound ? 'Sound on. Turn sound off' : 'Sound off. Turn sound on' }) },
  { action: 'spanScreens', key: 'm', row: 2, id: 'span', help: 'Span screens',
    face: () => ({ text: 'Span', name: 'Span: place vessels on another screen' }) },
  { action: 'stage', key: 'g', row: 2, id: 'stage', help: 'Stage',
    face: () => ({ text: 'Stage', name: 'Open the stage backdrop' }) },
];

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

// Side bearings, em, measured from public/fonts (canvas measureText on the loaded faces).
/** Left side bearing of each B612 Mono digit. */
const DIGIT_LSB = [0.0705, 0.0925, 0.0915, 0.1135, 0.0755, 0.124, 0.0765, 0.0885, 0.0745, 0.075];
/** Right side bearing of each B612 Mono digit. */
const DIGIT_RSB = [0.0695, 0.081, 0.0915, 0.09, 0.0745, 0.1015, 0.0715, 0.09, 0.074, 0.0785];
/** Left side bearing of the capitals that can start a line in B612. */
const CAP_LSB: Record<string, number> = { T: 0.04, V: 0.0335, W: 0.0335, M: 0.086, H: 0.0755, I: 0.08 };
/** Left side bearing of "m" in B612. */
const M_LSB = 0.1;
/** Round digits overshoot the straight edge they align with, as round letters overshoot a baseline. */
const BOWL = 0.008;
const BOWLS = '0689';
const MONO_ADVANCE = 0.65;
/** Middle of a B612 Mono digit above the centre of a 9/9 px line box, px. */
const TICK_CAP_MID = 9 / 2 - 0.025 * 9;
/** The controls' right edge (their box; the ink stops a pixel further in), px. */
const SIDE_RIGHT = 17;
/** Least clear space between the specimen stack and the controls, px. */
const GUTTER = 24;
/** Readout spring stiffness, rad/s. Critically damped, so it counts without overshoot. */
const SPRING = 9;
/** The specimen line changes at most this often. */
const SPEC_EVERY_MS = 250;
/** Rain is worth a line above this much in the air, mL; the line stays this long after it falls below. */
const RAIN_ML = 5;
const RAIN_HOLD_MS = 750;

interface Sizes {
  label: number;
  num: number;
  unit: number;
  /** Clear space between the last digit's ink and the unit's ink, px. */
  unitGap: number;
}
const FULL: Sizes = { label: 11, num: 56, unit: 11, unitGap: 9.5 };
const COMPACT: Sizes = { label: 10, num: 28, unit: 9, unitGap: 5 };

const clampMl = (ml: number): number => Math.min(WORLD_ML, Math.max(0, ml));

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

  // TIDAL, an en space, then this vessel's number a step quieter
  const label = el(doc, 'div', 'tc-label');
  const vessel = el(doc, 'span', 'tc-quiet');
  label.append(el(doc, 'span', 'tc-brand', 'Tidal '), vessel);

  const readout = el(doc, 'div', 'tc-readout');
  const num = el(doc, 'span', 'tc-num', '0');
  const unit = el(doc, 'span', 'tc-unit', 'mL');
  readout.append(num, unit);

  // Specimen line: what is in the tank and how much of the world it holds.
  const specimen = el(doc, 'div', 'tc-spec');
  const specLiquid = el(doc, 'span');
  const specShare = el(doc, 'span', 'tc-n', '0');
  specimen.append(specLiquid, ', ', specShare, '% of ', el(doc, 'span', 'tc-n', String(WORLD_ML)), ' ', el(doc, 'span', 'tc-u', 'mL'));

  // Rain in the air: its own line, only while there is any.
  const rain = el(doc, 'div', 'tc-spec tc-rain');
  const rainMl = el(doc, 'span', 'tc-n', '0');
  rain.append(rainMl, ' ', el(doc, 'span', 'tc-u', 'mL'), ' falling');
  rain.dataset.off = '';

  stack.append(label, readout, specimen, rain);

  const side = el(doc, 'section', 'tc-side');
  side.setAttribute('aria-label', 'Controls');
  const rows = {
    1: el(doc, 'div', 'tc-row tc-row-1'),
    2: el(doc, 'div', 'tc-row tc-row-2'),
  } as const;
  rows[1].setAttribute('role', 'group');
  rows[1].setAttribute('aria-label', 'Actions');
  rows[2].setAttribute('role', 'group');
  rows[2].setAttribute('aria-label', 'Settings');

  interface Parts { button: HTMLButtonElement; lead: HTMLSpanElement | null; text: HTMLSpanElement }
  const buttons = new Map<Action, Parts>();
  for (const spec of BUTTONS) {
    const button = el(doc, 'button', 'tc-btn');
    button.type = 'button';
    const face = spec.face(state);
    let lead: HTMLSpanElement | null = null;
    if (face.lead !== undefined) {
      lead = el(doc, 'span', face.quietLead ? 'tc-lead tc-lead-quiet' : 'tc-lead', face.lead);
      button.append(lead, ' ');
    }
    const text = el(doc, 'span', 'tc-value');
    button.append(text);
    button.hidden = !can[spec.action];
    if (spec.id) button.id = spec.id;
    button.title = `Shortcut: ${spec.key.toUpperCase()}`;
    button.setAttribute('aria-keyshortcuts', spec.key.toUpperCase());
    button.addEventListener('click', () => actions[spec.action]());
    buttons.set(spec.action, { button, lead, text });
    rows[spec.row].append(button);
  }
  // a row with nothing that works here is not shown: a popup's settings become its only row
  for (const r of [1, 2] as const) rows[r].hidden = !BUTTONS.some((b) => b.row === r && can[b.action]);

  const help = el(doc, 'section', 'tc-helpbox');
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
  side.append(rows[1], rows[2], help);

  root.append(scale, stack, side);
  if (!limited) {
    const credit = el(doc, 'footer', 'tc-credit');
    credit.append(el(doc, 'span', undefined, 'Venkat Jaswanth'));
    root.append(credit);
  }
  (doc.getElementById('vessel') ?? doc.body).append(root);

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

  let compact = false;
  let sizes = FULL;
  let x = 0;          // spring position, mL
  let v = 0;          // spring velocity, mL/s
  let moving = false;
  let shown = -1;

  const renderNumber = (force = false) => {
    // the world holds 1000 mL; no vessel can show more, whatever a frame's count says
    const n = Math.round(clampMl(x));
    if (n === shown && !force) return;
    shown = n;
    const s = String(n);
    num.textContent = s;
    // optical alignment: the leading digit's ink starts on the stack's edge, round digits a hair past it
    const first = s.charAt(0), last = s.charAt(s.length - 1);
    const lsb = (DIGIT_LSB[s.charCodeAt(0) - 48] ?? 0.07) + (BOWLS.includes(first) ? BOWL : 0);
    num.style.marginLeft = `${(-lsb * sizes.num).toFixed(2)}px`;
    // a constant clear space from the last digit's ink to the unit's ink
    const rsb = (DIGIT_RSB[s.charCodeAt(s.length - 1) - 48] ?? 0.08) + (BOWLS.includes(last) ? BOWL : 0);
    unit.style.marginLeft = `${(sizes.unitGap - rsb * sizes.num - M_LSB * sizes.unit).toFixed(2)}px`;
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
    vessel.textContent = `Vessel ${slot >= 0 ? String(slot + 1).padStart(2, '0') : '--'}`;
  };

  // ---------------------------------------------------------------- specimen line

  let specAt = -Infinity;
  let shareShown = -1;
  let liquidShown = '';
  let rainShown = -1;
  let rainOn = false;
  let rainSeenAt = -Infinity;

  /** A line that starts with a capital starts its ink on the stack's edge. */
  const alignCap = (line: HTMLElement, text: string) => {
    line.style.marginLeft = `${-(CAP_LSB[text.charAt(0).toUpperCase()] ?? 0.05)}em`;
  };
  const alignDigit = (line: HTMLElement, digits: string) => {
    const c = digits.charAt(0);
    line.style.marginLeft = `${-((DIGIT_LSB[digits.charCodeAt(0) - 48] ?? 0.07) + (BOWLS.includes(c) ? BOWL : 0))}em`;
  };

  /** Returns true when the specimen stack changed width. */
  const renderSpec = (e: Engine, now: number): boolean => {
    let changed = false;
    if (state.liquid !== liquidShown) {
      liquidShown = state.liquid;
      const name = capital(state.liquid);
      specLiquid.textContent = name;
      alignCap(specimen, name);
      changed = true;
    }
    const share = Math.round((100 * clampMl(e.ml)) / WORLD_ML);
    if (share !== shareShown) {
      shareShown = share;
      specShare.textContent = String(share);
      changed = true;
    }
    const falling = e.meta?.rainMl ?? 0;
    if (falling > RAIN_ML) rainSeenAt = now;
    const on = falling > RAIN_ML || now - rainSeenAt < RAIN_HOLD_MS;
    if (on) {
      const n = Math.round(falling);
      if (n !== rainShown && falling > RAIN_ML) {
        rainShown = n;
        const s = String(n);
        rainMl.textContent = s;
        alignDigit(rain, s);
        changed = true;
      }
    }
    if (on !== rainOn) {
      rainOn = on;
      rain.toggleAttribute('data-off', !on);
      changed = true;
    }
    return changed;
  };

  // ---------------------------------------------------------------- layout

  let helpOpen = false;
  const setHelp = (open: boolean) => {
    helpOpen = open && !compact;
    help.hidden = !helpOpen;
  };

  /** Numerals beside the major graduations the canvas etches, kept clear of the top edge and the label stack. */
  const buildScale = (w: number, h: number) => {
    const { tickMl, major } = graduationStep(w, PX2_PER_ML);
    const every = tickMl * major;
    // the rain line keeps its place while hidden, so the numerals do not come and go with the rain
    const clear = Math.max(24, stack.getBoundingClientRect().bottom + 8);
    const frag = doc.createDocumentFragment();
    for (let ml = every; engine.heightOfMl(ml, w) <= h; ml += every) {
      const y = h - engine.heightOfMl(ml, w);
      if (y < clear) break;
      const tick = el(doc, 'span', 'tc-tick', String(ml));
      tick.style.top = `${(y - TICK_CAP_MID).toFixed(2)}px`;
      frag.append(tick);
    }
    scale.replaceChildren(frag);
  };

  /** Rows wrap rather than reach over the stack: the first row beside the label, the rest beside the readout. */
  const fit = () => {
    if (compact) return;
    const w = view.innerWidth;
    const right = (e: Element) => e.getBoundingClientRect().right;
    // the readout is fitted at four digits, so the controls do not move as it counts
    const readoutRight = right(readout) + Math.max(0, 4 - String(Math.max(0, shown)).length) * MONO_ADVANCE * sizes.num;
    const lower = Math.max(readoutRight, right(specimen), rainOn ? right(rain) : 0);
    const room = (edge: number) => `${Math.max(0, Math.floor(w - SIDE_RIGHT - edge - GUTTER))}px`;
    let first = true;
    for (const r of [rows[1], rows[2]]) {
      if (r.hidden) continue;
      r.style.maxWidth = room(first ? right(label) : lower);
      first = false;
    }
    // the shortcut list keeps its natural width: narrow enough to clear the stack at any width that shows it
  };

  const layout = () => {
    const w = view.innerWidth, h = view.innerHeight;
    compact = w < 420 || h < 300;
    sizes = compact ? COMPACT : FULL;
    root.toggleAttribute('data-compact', compact);
    if (compact) setHelp(false);
    alignCap(label, compact ? 'V' : 'T');
    renderNumber(true);
    fit();
    if (w > 0 && h > 0) buildScale(w, h);
  };

  // ---------------------------------------------------------------- state

  const render = () => {
    for (const spec of BUTTONS) {
      const parts = buttons.get(spec.action);
      if (!parts) continue;
      const face = spec.face(state);
      if (parts.lead && face.lead !== undefined) parts.lead.textContent = face.lead;
      parts.text.textContent = face.text;
      parts.button.setAttribute('aria-label', face.name);
      if (spec.pressed) parts.button.setAttribute('aria-pressed', String(state[spec.pressed]));
    }
    renderSpec(engine, performance.now());
    fit();
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
  let scaleFor = engine.liquid.id;
  // Listeners are called with the engine itself; this chrome may be mounted on a view of it
  // (the floating tank), so it reads the engine it was given.
  const onFrame = () => {
    const e = engine;
    const now = performance.now();
    if (e.liquid.id !== scaleFor) { scaleFor = e.liquid.id; buildScale(view.innerWidth, view.innerHeight); }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (e.theme !== applied) applyTheme(e.theme);
    if (e.slot !== slotShown) { slotShown = e.slot; renderLabel(e.slot); }
    if (!e.meta) return;
    stepReadout(clampMl(e.ml), dt);
    if (now - specAt >= SPEC_EVERY_MS) {
      specAt = now;
      if (renderSpec(e, now)) fit();
    }
  };

  renderLabel(engine.slot);
  render();
  layout();
  engine.frameListeners.add(onFrame);
  view.addEventListener('resize', layout);
  view.addEventListener('keydown', onKey);
  // line widths depend on the faces; fit again once they have arrived
  let alive = true;
  void doc.fonts.ready.then(() => { if (alive) layout(); });

  return {
    update(patch) {
      Object.assign(state, patch);
      render();
    },
    destroy() {
      alive = false;
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
