// The tab is part of the piece: its title gives this vessel's volume and its favicon is a little beaker
// filled to this vessel's level.

import type { Engine } from '../engine';
import { rgb } from '../render/theme';
import { isDark } from './dom';

const SIZE = 64;
const STEPS = 64;
const MIN_INTERVAL_MS = 250;
const WATER_FILL = '#7fd0d8';
const FILL: Record<string, string> = { water: WATER_FILL, mercury: '#b8bcc4', honey: '#e0a03a', ink: '#2742c9' };
const STROKE_LIGHT = '#2a2d32';
const STROKE_DARK = '#c9f2e6';

// Canvas px. The 4 px strokes are centred on these lines, so at 16 px each wall and the base is one whole pixel.
const LEFT = 14;
const RIGHT = 50;
const BASE = 54;
const RIM = 9;
const LIP = 5;
const CORNER = 3;
const WALL = 4;
const INNER_LEFT = LEFT + WALL / 2;
const INNER_RIGHT = RIGHT - WALL / 2;
const INNER_TOP = RIM + LIP;
const INNER_BOTTOM = BASE - WALL / 2;

function beaker(): Path2D {
  const p = new Path2D();
  p.moveTo(LEFT - LIP, RIM);            // pouring lip
  p.lineTo(LEFT, RIM + LIP);
  p.lineTo(LEFT, BASE - CORNER);
  p.arcTo(LEFT, BASE, LEFT + CORNER, BASE, CORNER);
  p.lineTo(RIGHT - CORNER, BASE);
  p.arcTo(RIGHT, BASE, RIGHT, BASE - CORNER, CORNER);
  p.lineTo(RIGHT, RIM);
  return p;
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex).map((c) => Math.round(255 * (c + (1 - c) * amount)));
  return `rgb(${r} ${g} ${b})`;
}

export function mountTabIcon(doc: Document, engine: Engine): () => void {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const outline = beaker();

  const existing = doc.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const link = existing ?? doc.createElement('link');
  if (!existing) { link.rel = 'icon'; doc.head.append(link); }

  const draw = (level: number, liquid: string, dark: boolean) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (level > 0) {
      const fill = FILL[liquid] ?? WATER_FILL;
      const top = Math.round(INNER_BOTTOM - level * (INNER_BOTTOM - INNER_TOP));
      ctx.fillStyle = fill;
      ctx.fillRect(INNER_LEFT, top, INNER_RIGHT - INNER_LEFT, INNER_BOTTOM + 1 - top);
      ctx.fillStyle = lighten(fill, 0.55);
      ctx.fillRect(INNER_LEFT, top, INNER_RIGHT - INNER_LEFT, 1);
    }
    ctx.strokeStyle = dark ? STROKE_DARK : STROKE_LIGHT;
    ctx.lineWidth = WALL;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(outline);
  };

  let titleMl = NaN;
  let titleAt = -Infinity;
  let iconKey = '';
  let iconAt = -Infinity;

  const onFrame = (e: Engine) => {
    if (!e.meta) return;
    const now = performance.now();
    const ml = Math.round(e.ml);
    if (ml !== titleMl && now - titleAt >= MIN_INTERVAL_MS) {
      titleMl = ml;
      titleAt = now;
      doc.title = `Tidal — ${ml} mL`;
    }
    const cap = e.capacityMl;
    const level = cap > 0 ? Math.min(1, Math.max(0, e.ml / cap)) : 0;
    const q = Math.round(level * STEPS);
    const dark = isDark(e.theme);
    const key = `${q} ${e.liquid.id} ${e.theme.name}`;
    if (key !== iconKey && now - iconAt >= MIN_INTERVAL_MS) {
      iconKey = key;
      iconAt = now;
      draw(q / STEPS, e.liquid.id, dark);
      link.type = 'image/png';
      link.href = canvas.toDataURL('image/png');
    }
  };
  engine.frameListeners.add(onFrame);

  return () => {
    engine.frameListeners.delete(onFrame);
    if (!existing) link.remove();
  };
}
