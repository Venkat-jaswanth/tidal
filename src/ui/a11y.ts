// Words for the water: a description on the canvas and a polite live region that reports changes,
// without chattering.

import { WORLD_ML, type Engine } from '../engine';
import type { VesselInfo } from '../world/registry';
import { capital } from './dom';

const LABEL_EVERY_MS = 1000;
const SAY_EVERY_MS = 4000;
const SAY_CHANGE_ML = 10;
const FLOW_ML_PER_S = 8;
const RAIN_ML = 5;
/** Rates are measured over this much history. */
const RATE_WINDOW_MS = 1000;
/** A neighbour must be changing at least this fast, the other way, to be named as the source. */
const NEIGHBOUR_ML_PER_S = 1;

const VISUALLY_HIDDEN =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;' +
  'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';

type Flow = 'in' | 'out' | 'steady';
type Side = 'left' | 'right' | 'above' | 'below';

const FROM: Record<Side, string> = { left: 'from the left', right: 'from the right', above: 'from above', below: 'from below' };
const TO: Record<Side, string> = { left: 'to the left', right: 'to the right', above: 'into the vessel above', below: 'into the vessel below' };

const millilitres = (n: number): string => `${n} ${n === 1 ? 'millilitre' : 'millilitres'}`;

/** Where `other` sits relative to `self`, by the centres of their rectangles. */
function sideOf(self: VesselInfo, other: VesselInfo): Side {
  const dx = other.x + other.w / 2 - (self.x + self.w / 2);
  const dy = other.y + other.h / 2 - (self.y + self.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'above' : 'below';
}

export function mountA11y(doc: Document, engine: Engine): () => void {
  const canvas = doc.querySelector('canvas');
  const before = canvas ? { role: canvas.getAttribute('role'), label: canvas.getAttribute('aria-label') } : null;
  canvas?.setAttribute('role', 'img');

  const live = doc.createElement('div');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.style.cssText = VISUALLY_HIDDEN;
  doc.body.append(live);

  const describe = (e: Engine): string => {
    const base = `Vessel ${e.slot + 1}, a tank of ${e.liquid.id} on graph paper`;
    return e.meta ? `${base}, holding ${millilitres(Math.round(e.ml))} of the world's ${WORLD_ML}.` : `${base}.`;
  };

  let label = '';
  let labelAt = -Infinity;
  const samples: { t: number; ml: number[] }[] = [];
  let said: { ml: number; flow: string } | null = null;
  let saidAt = -Infinity;

  const onFrame = (e: Engine) => {
    const now = performance.now();
    if (canvas && now - labelAt >= LABEL_EVERY_MS) {
      labelAt = now;
      const text = describe(e);
      if (text !== label) { label = text; canvas.setAttribute('aria-label', text); }
    }

    const m = e.meta;
    if (!m || e.slot < 0) return;
    samples.push({ t: now, ml: m.ml.slice() });
    while (samples.length > 2 && now - samples[0]!.t > RATE_WINDOW_MS) samples.shift();
    const first = samples[0]!;
    const span = (now - first.t) / 1000;
    if (span < RATE_WINDOW_MS / 2000) return;
    const rate = (slot: number) => ((m.ml[slot] ?? 0) - (first.ml[slot] ?? 0)) / span;

    const self = e.registry.self;
    const own = rate(self.slot);
    const flow: Flow = own > FLOW_ML_PER_S ? 'in' : own < -FLOW_ML_PER_S ? 'out' : 'steady';
    // the source (or destination) is the vessel changing fastest the other way
    let side: Side | null = null;
    if (flow !== 'steady') {
      let best = NEIGHBOUR_ML_PER_S;
      for (const v of e.registry.all()) {
        if (v.id === self.id) continue;
        const opposite = flow === 'in' ? -rate(v.slot) : rate(v.slot);
        if (opposite > best) { best = opposite; side = sideOf(self, v); }
      }
    }
    const raining = flow === 'in' && m.rainMl > RAIN_ML;
    const ml = Math.round(e.ml);
    const flowKey = `${flow} ${side ?? ''} ${raining}`;

    // the first reading is the baseline; only changes are worth saying
    if (!said) { said = { ml, flow: flowKey }; saidAt = now; return; }
    if (now - saidAt < SAY_EVERY_MS) return;
    if (Math.abs(ml - said.ml) < SAY_CHANGE_ML && flowKey === said.flow) return;
    said = { ml, flow: flowKey };
    saidAt = now;

    const name = capital(e.liquid.id);
    const parts = [`Vessel ${e.slot + 1} holds ${millilitres(ml)}.`];
    if (flow === 'in') {
      if (side || !raining) parts.push(`${name} is flowing in${side ? ` ${FROM[side]}` : ''}.`);
      if (raining) parts.push(`${name} is raining in from above.`);
    } else if (flow === 'out') {
      parts.push(`${name} is flowing out${side ? ` ${TO[side]}` : ''}.`);
    } else {
      parts.push('The level is steady.');
    }
    live.textContent = parts.join(' ');
  };
  engine.frameListeners.add(onFrame);

  return () => {
    engine.frameListeners.delete(onFrame);
    live.remove();
    if (canvas && before) {
      if (before.role === null) canvas.removeAttribute('role'); else canvas.setAttribute('role', before.role);
      if (before.label === null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', before.label);
    }
  };
}
