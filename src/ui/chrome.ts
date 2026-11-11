// In-window chrome: specimen label, volume readout, specimen line, graduation numerals, controls, gloss,
// shortcut help and credit. Everything is printed on the glass: no plates. The stack and the controls keep a
// hard 1 px knock-out of paper around each glyph; the numerals and the credit are printed plain, in paper
// under a dark ink. The canvas fades its ruling out behind each block of text. The only thing that moves is
// the readout, counting with the water, and every other figure in the stack is derived from what it shows.

import { PX2_PER_ML, WORLD_ML, type Engine } from '../engine';
import { LIQUIDS } from '../liquids';
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
  /** Vessels open across every screen (after a successful span). */
  spanning?: boolean;
  /** The stage backdrop is open. */
  staged?: boolean;
}

export interface Chrome {
  update(state: Partial<ChromeState>): void;
  destroy(): void;
}

type Action = keyof ChromeActions;

/**
 * What a button shows and says. Settings are written KEY value: `lead` is the key, printed a step quieter.
 * The name always starts with the visible words, in order (WCAG 2.5.3, label in name), so speech users can
 * say what they see.
 */
interface Face {
  lead?: string;
  text: string;
  name: string;
}

interface ButtonSpec {
  action: Action;
  key: string;
  /** 1: actions. 2: settings, each KEY value. */
  row: 1 | 2;
  /** Element id, for tests and tools. */
  id: string;
  face(s: ChromeState): Face;
  /** One plain sentence saying what it does: shown under the rows on hover or focus, and the description. */
  gloss(s: ChromeState): string;
  /** The state a toggle reports through aria-pressed. */
  pressed?: 'sound';
  help: string;
}

const BUTTONS: readonly ButtonSpec[] = [
  { action: 'addVessel', key: 'v', row: 1, id: 'add', help: 'Add a vessel',
    face: () => ({ text: '+ Vessel', name: 'Add a vessel' }),
    gloss: () => '+ Vessel: open another window that shares this water.' },
  { action: 'float', key: 'f', row: 1, id: 'float', help: 'Float a tank',
    face: (s) => (s.floating
      ? { text: 'Sink the tank', name: 'Sink the tank: close the floating tank' }
      : { text: 'Float a tank', name: 'Float a tank: open the floating tank' }),
    gloss: (s) => (s.floating
      ? 'Sink the tank: close the floating tank.'
      : 'Float a tank: a small tank that stays on top of your other windows.') },
  { action: 'perform', key: 'p', row: 1, id: 'perform', help: 'Perform',
    face: (s) => (s.performing
      ? { text: 'Stop', name: 'Stop the performance' }
      : { text: 'Perform', name: 'Perform: start the performance' }),
    gloss: (s) => (s.performing
      ? 'Stop the performance.'
      : 'Perform: the windows move by themselves and pour into each other.') },
  { action: 'cycleLiquid', key: 'l', row: 2, id: 'liquid', help: 'Change liquid',
    face: (s) => ({ lead: 'Liquid', text: capital(s.liquid), name: `Liquid: ${s.liquid}. Change liquid` }),
    gloss: () => 'Liquid: change what the vessels hold.' },
  { action: 'toggleSound', key: 's', row: 2, id: 'sound', pressed: 'sound', help: 'Sound on or off',
    face: (s) => ({ lead: 'Sound', text: s.sound ? 'On' : 'Off', name: s.sound ? 'Sound: on. Turn sound off' : 'Sound: off. Turn sound on' }),
    gloss: () => 'Sound: water sounds, made live from the simulation.' },
  { action: 'spanScreens', key: 'm', row: 2, id: 'span', help: 'Screens',
    face: (s) => ({ lead: 'Screens', text: s.spanning ? 'All' : '1', name: s.spanning ? 'Screens: all. Vessels open across your displays' : 'Screens: 1. Let vessels open on your other displays' }),
    gloss: () => 'Screens: let vessels open on your other displays.' },
  { action: 'stage', key: 'g', row: 2, id: 'stage', help: 'Stage',
    face: (s) => ({ lead: 'Stage', text: s.staged ? 'On' : 'Off', name: s.staged ? 'Stage: on. Close the stage backdrop' : 'Stage: off. Open the stage backdrop' }),
    gloss: () => 'Stage: a dark backdrop behind the vessels.' },
];

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

// Side bearings, em, measured from public/fonts (canvas measureText on the loaded faces). Being in em, they
// hold at any size the readout is set in.
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
/** Baseline of 9 px B612 Mono in a 9 px line box: (9 - 1.21 × 9) / 2 + 0.96 × 9. */
const TICK_BASELINE = 7.695;
/** A numeral's baseline sits this far above the centre of its 1 px tick: half the line, then 2 px clear. */
const TICK_LIFT = 2.5;
/** The scale's "mL" sits one line (11 px, baseline to baseline) above the topmost numeral. */
const UNIT_PITCH = 11;
/** The controls' right edge (their box; the ink stops a pixel further in), px. */
const SIDE_RIGHT = 17;
/** Least clear space between the specimen stack and the controls, px. */
const GUTTER = 24;
/** Quiet zones are the text's line boxes plus this much; the canvas adds its own feather. */
const QUIET_PAD = 2;
/** Readout spring stiffness, rad/s. Critically damped, so it counts without overshoot. */
const SPRING = 9;
/** The vessel count, and which text sits under the liquid, change at most this often. */
const SLOW_EVERY_MS = 250;
/**
 * How the plain numerals and credit are printed under a resting liquid on the light theme. Chosen by contrast
 * measured against the rendered body near the floor: paper on ink 8.7 to 11.7:1. Honey and mercury keep ink,
 * but at full strength: the numerals' usual 70% ink falls to 2.1 to 2.7:1 on honey and 2.9 to 3.7:1 on mercury,
 * full ink reaches 5.1 to 6.7:1 and 6.2 to 10.3:1. Clear water keeps the usual ink.
 */
const UNDER: Record<string, 'paper' | 'ink'> = { ink: 'paper', honey: 'ink', mercury: 'ink' };

interface Sizes {
  label: number;
  num: number;
  unit: number;
  /** Clear space between the last digit's ink and the unit's ink, px. */
  unitGap: number;
}
const FULL: Sizes = { label: 11, num: 48, unit: 11, unitGap: 7 };
const COMPACT: Sizes = { label: 10, num: 28, unit: 9, unitGap: 4.5 };

const clampMl = (ml: number): number => Math.min(WORLD_ML, Math.max(0, ml));

interface Rect { left: number; top: number; right: number; bottom: number }

const union = (rs: readonly Rect[]): Rect | null => (rs.length === 0 ? null : {
  left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)),
  right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)),
});

export function mountChrome(doc: Document, engine: Engine, actions: ChromeActions, initial: ChromeState): Chrome {
  const view = doc.defaultView ?? window;
  const state: ChromeState = { spanning: false, staged: false, ...initial };

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

  // Specimen line: what is in the tank, how much of the litre, among how many vessels.
  const specimen = el(doc, 'div', 'tc-spec tc-spec-main');

  // Liquid in the air: its line is always there, so nothing moves; it shows only while something falls.
  const rain = el(doc, 'div', 'tc-spec tc-rain');
  const rainMl = el(doc, 'span', 'tc-n', '0');
  rain.append(rainMl, ' ', el(doc, 'span', 'tc-u', 'mL'), ' falling');
  rain.dataset.off = '';

  stack.append(label, readout, specimen, rain);

  const side = el(doc, 'section', 'tc-side');
  side.setAttribute('aria-label', 'Controls');
  const controls = el(doc, 'div', 'tc-controls');
  const rows = {
    1: el(doc, 'div', 'tc-row tc-row-1'),
    2: el(doc, 'div', 'tc-row tc-row-2'),
  } as const;
  rows[1].setAttribute('role', 'group');
  rows[1].setAttribute('aria-label', 'Actions');
  rows[2].setAttribute('role', 'group');
  rows[2].setAttribute('aria-label', 'Settings');

  // what a control does, in a sentence, under the rows while it is pointed at or focused
  const gloss = el(doc, 'p', 'tc-gloss');
  gloss.setAttribute('aria-hidden', 'true');
  // the same sentences as descriptions, there at all times for assistive technology
  const descriptions = el(doc, 'div');
  descriptions.hidden = true;

  /** The words of a control, inline: what is measured, underlined and fitted. */
  const inkOf = (face: Face): { ink: HTMLSpanElement; lead: HTMLSpanElement | null; text: HTMLSpanElement } => {
    const ink = el(doc, 'span', 'tc-ink');
    let lead: HTMLSpanElement | null = null;
    if (face.lead !== undefined) {
      lead = el(doc, 'span', 'tc-lead', face.lead);
      ink.append(lead, ' ');
    }
    const text = el(doc, 'span', 'tc-value', face.text);
    ink.append(text);
    return { ink, lead, text };
  };

  interface Parts { button: HTMLButtonElement; ink: HTMLSpanElement; lead: HTMLSpanElement | null; text: HTMLSpanElement; desc: HTMLSpanElement }
  const buttons = new Map<Action, Parts>();
  let hovered: ButtonSpec | null = null;
  let focused: ButtonSpec | null = null;
  for (const spec of BUTTONS) {
    const button = el(doc, 'button', 'tc-btn');
    button.type = 'button';
    const { ink, lead, text } = inkOf(spec.face(state));
    button.append(ink);
    button.hidden = !can[spec.action];
    button.id = spec.id;
    button.title = `Shortcut: ${spec.key.toUpperCase()}`;
    button.setAttribute('aria-keyshortcuts', spec.key.toUpperCase());
    const desc = el(doc, 'span');
    desc.id = `tc-desc-${spec.id}`;
    descriptions.append(desc);
    button.setAttribute('aria-describedby', desc.id);
    button.addEventListener('click', () => actions[spec.action]());
    button.addEventListener('pointerenter', () => { hovered = spec; showGloss(); });
    button.addEventListener('pointerleave', () => { if (hovered === spec) hovered = null; showGloss(); });
    // keyboard focus only: a click also focuses, and the pointer already shows the sentence
    button.addEventListener('focus', () => { focused = button.matches(':focus-visible') ? spec : null; showGloss(); });
    button.addEventListener('blur', () => { if (focused === spec) focused = null; showGloss(); });
    buttons.set(spec.action, { button, ink, lead, text, desc });
    rows[spec.row].append(button);
  }
  // a row with nothing that works here is not shown: a popup's settings become its only row
  for (const r of [1, 2] as const) rows[r].hidden = !BUTTONS.some((b) => b.row === r && can[b.action]);
  controls.append(rows[1], rows[2], gloss);

  // measures each control's words in every state, so the column grid does not move when a state changes
  const ruler = el(doc, 'div', 'tc-ruler');
  ruler.setAttribute('aria-hidden', 'true');

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
  side.append(controls, help, descriptions, ruler);

  root.append(scale, stack, side);
  let credit: HTMLElement | null = null;
  if (!limited) {
    credit = el(doc, 'footer', 'tc-credit');
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
    markUnder();
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
  /** The figure the readout shows: every other number in the stack is derived from it. */
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

  // ---------------------------------------------------------------- specimen and falling lines

  let count = 1;
  let countAt = -Infinity;
  let specShown = '';
  let specWidth = -1;
  let fallingShown = -1;

  /** A line that starts with a capital starts its ink on the stack's edge. */
  const alignCap = (line: HTMLElement, text: string) => {
    line.style.marginLeft = `${-(CAP_LSB[text.charAt(0).toUpperCase()] ?? 0.05)}em`;
  };
  const alignDigit = (line: HTMLElement, digits: string) => {
    const c = digits.charAt(0);
    line.style.marginLeft = `${-((DIGIT_LSB[digits.charCodeAt(0) - 48] ?? 0.07) + (BOWLS.includes(c) ? BOWL : 0))}em`;
  };

  /**
   * The specimen and falling lines, from the figure the readout shows on this same frame, so the three never
   * disagree. Returns true when the specimen line changed width.
   */
  const renderFigures = (now: number): boolean => {
    if (now - countAt >= SLOW_EVERY_MS) { countAt = now; count = Math.max(1, engine.registry.all().length); }
    const d = Math.max(0, shown);

    // "Water, none of the litre", "43% of the litre", "the whole litre"; a part never rounds to none or all
    const amount = d >= WORLD_ML ? 'whole' : d <= 0 ? 'none' : String(Math.min(99, Math.max(1, Math.round(d / 10))));
    const key = `${state.liquid} ${amount} ${count}`;
    let widened = false;
    if (key !== specShown) {
      specShown = key;
      const name = capital(state.liquid);
      const part = amount === 'whole' ? ['the whole litre'] : amount === 'none' ? ['none of the litre']
        : [el(doc, 'span', 'tc-n', amount), '% of the litre'];
      specimen.replaceChildren(name, ', ', ...part, ', ', el(doc, 'span', 'tc-n', String(count)), count === 1 ? ' vessel' : ' vessels');
      alignCap(specimen, name);
      const w = specimen.getBoundingClientRect().width;
      if (w !== specWidth) { specWidth = w; widened = true; }
    }

    // In the air: never more than the litre leaves once this vessel's shown figure and the others' true
    // volumes are counted. A vessel alone in the world holds everything that is not falling.
    let falling = 0;
    const meta = engine.meta;
    if (meta) {
      let others = 0;
      meta.ml.forEach((ml, slot) => { if (slot !== engine.slot) others += ml; });
      falling = count <= 1 && others < 0.5
        ? WORLD_ML - d
        : Math.max(0, Math.min(Math.round(meta.rainMl), Math.floor(WORLD_ML - d - others + 1e-6)));
    }
    if (falling !== fallingShown) {
      // on its way out the line reads 0 while it fades, so it never contradicts the readout
      const s = String(falling);
      rainMl.textContent = s;
      alignDigit(rain, s);
      rain.toggleAttribute('data-off', falling === 0);
      fallingShown = falling;
    }
    return widened;
  };

  // ---------------------------------------------------------------- graduation numerals

  /** Each numeral (and the scale's unit) with the height of its baseline's tick above the floor, px. */
  let marks: { el: HTMLElement; height: number }[] = [];

  /** Numerals just above the major graduations the canvas etches, kept clear of the label stack. */
  const buildScale = (w: number, h: number) => {
    const { tickMl, major } = graduationStep(w, PX2_PER_ML);
    const every = tickMl * major;
    // the falling line keeps its place while hidden, so the numerals do not come and go with the rain
    const clear = Math.max(24, stack.getBoundingClientRect().bottom + 8);
    const placed: { ml: number; height: number; baseline: number }[] = [];
    for (let ml = every; engine.heightOfMl(ml, w) <= h; ml += every) {
      const height = engine.heightOfMl(ml, w);
      const baseline = h - height - TICK_LIFT;
      if (baseline - TICK_BASELINE < clear) break;
      placed.push({ ml, height, baseline });
    }
    // the unit goes once, a line above the topmost numeral; if that would reach the stack, drop that numeral
    const top = placed[placed.length - 1];
    if (top && top.baseline - UNIT_PITCH - TICK_BASELINE < clear) placed.pop();
    const frag = doc.createDocumentFragment();
    marks = [];
    const mark = (text: string, cls: string, baseline: number, height: number) => {
      const m = el(doc, 'span', cls, text);
      m.style.top = `${(baseline - TICK_BASELINE).toFixed(2)}px`;
      frag.append(m);
      marks.push({ el: m, height });
    };
    for (const p of placed) mark(String(p.ml), 'tc-tick', p.baseline, p.height);
    const highest = placed[placed.length - 1];
    if (highest) mark('mL', 'tc-tick tc-tick-unit', highest.baseline - UNIT_PITCH, h - (highest.baseline - UNIT_PITCH));
    scale.replaceChildren(frag);
    markUnder();
  };

  /**
   * On the light theme a deep-coloured liquid needs its own print for the numerals and credit below its
   * resting surface: paper under ink, full ink under honey (see UNDER).
   */
  function markUnder() {
    const w = view.innerWidth, h = view.innerHeight;
    // The resting surface only means something while the liquid rests on the floor: with gravity turned
    // or tilted away, the bottom of the tank is air and paper-coloured text there would vanish.
    const meta = engine.meta;
    const down = !meta || (meta.gravityY > 0 && Math.abs(meta.gravityX) <= 0.5 * meta.gravityY);
    const how = down && !isDark(engine.theme) ? UNDER[engine.liquid.id] : undefined;
    const surface = how ? engine.heightOfMl(clampMl(engine.ml), w) : -Infinity;
    const set = (e: HTMLElement, under: boolean) => {
      if (under && how) e.dataset.under = how; else delete e.dataset.under;
    };
    for (const m of marks) set(m.el, m.height < surface - 0.5);
    if (credit) set(credit, h - credit.getBoundingClientRect().top < surface);
  }

  // ---------------------------------------------------------------- layout

  let helpOpen = false;
  const setHelp = (open: boolean) => {
    helpOpen = open && !compact;
    help.hidden = !helpOpen;
    showGloss();
  };

  /** The readout's box as if it showed four digits, so neither the rows nor the quiet zone move as it counts. */
  const readoutBox = (): Rect => {
    const r = readout.getBoundingClientRect();
    const extra = Math.max(0, 4 - String(Math.max(0, shown)).length) * MONO_ADVANCE * sizes.num;
    return { left: r.left, top: r.top, right: r.right + extra, bottom: r.bottom };
  };

  const shownIn = (r: HTMLElement): HTMLButtonElement[] =>
    (r.hidden ? [] : Array.from(r.querySelectorAll<HTMLButtonElement>('.tc-btn')).filter((b) => !b.hidden));

  /** Each control's widest wording across its states, px. */
  const widths = new Map<HTMLButtonElement, number>();
  const measure = () => {
    const names = new Set([...Object.keys(LIQUIDS), state.liquid]);
    for (const spec of BUTTONS) {
      const parts = buttons.get(spec.action);
      if (!parts || parts.button.hidden) continue;
      const faces = new Map<string, Face>();
      for (const liquid of names) {
        for (const on of [false, true]) {
          const f = spec.face({ liquid, sound: on, performing: on, floating: on, spanning: on, staged: on });
          faces.set(`${f.lead ?? ''}|${f.text}`, f);
        }
      }
      let widest = 0;
      for (const f of faces.values()) {
        const { ink } = inkOf(f);
        ruler.replaceChildren(ink);
        widest = Math.max(widest, ink.getBoundingClientRect().width);
      }
      widths.set(parts.button, Math.ceil(widest));
    }
    ruler.replaceChildren();
  };

  /**
   * The two rows sit on shared column stops, right-aligned, so the actions stand over the last settings with
   * their left edges in line. If that grid would reach the stack, the first setting takes a line of its own
   * above the others ("split"); if even that does not fit, the rows simply wrap, each line clear of the stack.
   */
  const fit = () => {
    if (compact) return;
    const w = view.innerWidth;
    const rect = (e: Element): Rect => e.getBoundingClientRect();
    const lines = [rect(label), readoutBox(), rect(specimen), rect(rain)];
    const lower = Math.max(...lines.slice(1).map((l) => l.right));
    const room = (edge: number) => `${Math.max(0, Math.floor(w - SIDE_RIGHT - edge - GUTTER))}px`;
    const clashes = (r: HTMLElement) => shownIn(r).some((b) => {
      const br = rect(b);
      return lines.some((l) => br.top < l.bottom && br.bottom > l.top && br.left < l.right + GUTTER);
    });
    const r1 = shownIn(rows[1]), r2 = shownIn(rows[2]);
    for (const r of [rows[1], rows[2]]) { r.style.maxWidth = ''; r.style.gridTemplateColumns = ''; }
    gloss.style.maxWidth = room(lower);

    if (r1.length > 0 && r2.length > 0) {
      const k = Math.max(r1.length, r2.length);
      const cw = new Array<number>(k).fill(0);
      for (const items of [r1, r2]) {
        items.forEach((b, i) => { const j = k - items.length + i; cw[j] = Math.max(cw[j] ?? 0, widths.get(b) ?? 0); });
      }
      const columns = (n: number) => cw.slice(k - n).map((c) => `${c}px`).join(' ');
      side.dataset.layout = 'grid';
      rows[1].style.gridTemplateColumns = columns(r1.length);
      rows[2].style.gridTemplateColumns = columns(r2.length);
      if (!clashes(rows[1]) && !clashes(rows[2])) return;
      if (r2.length === r1.length + 1) {
        side.dataset.layout = 'split';
        rows[2].style.gridTemplateColumns = columns(r1.length);
        if (!clashes(rows[1]) && !clashes(rows[2])) return;
      }
      for (const r of [rows[1], rows[2]]) r.style.gridTemplateColumns = '';
    }

    side.dataset.layout = r1.length > 0 && r2.length > 0 ? 'wrap' : 'single';
    let first = true;
    for (const r of [rows[1], rows[2]]) {
      if (r.hidden) continue;
      r.style.maxWidth = room(first ? lines[0]!.right : lines[1]!.right);
      if (clashes(r)) r.style.maxWidth = room(lower);
      first = false;
    }
    // the shortcut list keeps its natural width: narrow enough to clear the stack at any width that shows it
  };

  /**
   * Tell the canvas where text sits, so its ruling fades out behind it instead of striking through: the
   * stack (zone 0, whose bottom also ends the etched graduations), each control row, the credit. Boxes hug
   * the lines; the stack box is as wide as its widest line and always includes the falling line's place.
   */
  const quiet = () => {
    const pad = (r: Rect | null) => (r ? [{
      x: r.left - QUIET_PAD, y: r.top - QUIET_PAD,
      w: r.right - r.left + 2 * QUIET_PAD, h: r.bottom - r.top + 2 * QUIET_PAD,
    }] : []);
    const lines: Rect[] = [label.getBoundingClientRect(), readoutBox()];
    if (!compact) lines.push(specimen.getBoundingClientRect(), rain.getBoundingClientRect());
    const zones = pad(union(lines));
    if (!compact) {
      const inks = (r: HTMLElement) => shownIn(r).map((b) => (b.firstElementChild ?? b).getBoundingClientRect());
      const a = inks(rows[1]), b = inks(rows[2]);
      // the gloss belongs to the controls: it joins the last row's zone while it shows
      if (glossOn) (b.length > 0 ? b : a).push(gloss.getBoundingClientRect());
      zones.push(...pad(union(a)), ...pad(union(b)));
      if (credit) zones.push(...pad(credit.getBoundingClientRect()));
    }
    engine.setQuietZones(zones.slice(0, 4), engine.slot);
  };

  const reflow = () => { fit(); quiet(); };

  // ---------------------------------------------------------------- gloss

  let glossOn = false;
  let glossText = '';
  /** Show the sentence for the control under the pointer, or failing that the one with keyboard focus. */
  function showGloss(force = false) {
    const spec = hovered ?? focused;
    const on = spec != null && !helpOpen && !compact;
    // on its way out the sentence keeps its words while it fades
    const text = on ? spec.gloss(state) : glossText;
    if (!force && on === glossOn && text === glossText) return;
    glossText = text;
    gloss.textContent = text;
    gloss.toggleAttribute('data-on', on);
    glossOn = on;
    quiet();
  }

  const layout = () => {
    const w = view.innerWidth, h = view.innerHeight;
    compact = w < 420 || h < 300;
    sizes = compact ? COMPACT : FULL;
    root.toggleAttribute('data-compact', compact);
    if (compact) setHelp(false);
    alignCap(label, compact ? 'V' : 'T');
    renderNumber(true);
    if (!compact) measure();
    reflow();
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
      parts.desc.textContent = spec.gloss(state);
      if (spec.pressed) parts.button.setAttribute('aria-pressed', String(state[spec.pressed]));
    }
    // the sentence follows the state it describes (Float a tank becomes Sink the tank)
    showGloss(true);
    renderFigures(performance.now());
    reflow();
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
  let slowAt = -Infinity;
  // Listeners are called with the engine itself; this chrome may be mounted on a view of it
  // (the floating tank), so it reads the engine it was given.
  const onFrame = () => {
    const e = engine;
    const now = performance.now();
    // each liquid stands at its own height for a volume, and the etched graduations follow it
    if (e.liquid.id !== scaleFor) { scaleFor = e.liquid.id; buildScale(view.innerWidth, view.innerHeight); }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (e.theme !== applied) { applyTheme(e.theme); markUnder(); }
    if (e.slot !== slotShown) { slotShown = e.slot; renderLabel(e.slot); }
    if (!e.meta) return;
    stepReadout(clampMl(e.ml), dt);
    // the figures follow the readout on the same frame; text only changes when a figure does
    if (renderFigures(now)) reflow();
    if (now - slowAt >= SLOW_EVERY_MS) { slowAt = now; markUnder(); }
  };

  renderLabel(engine.slot);
  render();
  layout();
  engine.frameListeners.add(onFrame);
  view.addEventListener('resize', layout);
  view.addEventListener('keydown', onKey);
  // line widths depend on the faces; measure and fit again once they have arrived
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
      engine.setQuietZones([], engine.slot);
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
