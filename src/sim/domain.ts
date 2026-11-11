// Builds the solver's boundary rects from vessel viewports: clamps wall speed, splits off the
// excess motion as a carry shift, and bridges vessels that touch or sit within the coupling gap.

import { MAX_RECTS } from './shaders';

/** A vessel viewport in grid cells, with its motion over the coming frame. */
export interface Vessel {
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Displacement over this frame, in cells. */
  dx: number;
  dy: number;
  rainWeight: number;
}

export interface SimRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  vx: number;
  vy: number;
  carryX: number;
  carryY: number;
  owner: number;
  kind: 0 | 1;
  rainWeight: number;
}

export interface DomainOptions {
  /** Coupling gap in cells. */
  gap: number;
  /** Particle wall margin in cells. */
  margin: number;
  /** Largest wall speed the solver sees, in cells per substep. */
  maxWallSpeed: number;
}

interface Moving extends SimRect {
  // position at the start of the frame, after the carry shift
  sx0: number;
  sy0: number;
}

export class DomainPlan {
  private readonly moving: Moving[] = [];

  constructor(
    vessels: readonly Vessel[],
    nSub: number,
    private readonly opts: DomainOptions,
  ) {
    for (const v of vessels) {
      let vx = v.dx / nSub;
      let vy = v.dy / nSub;
      const sp = Math.hypot(vx, vy);
      if (sp > opts.maxWallSpeed) {
        vx *= opts.maxWallSpeed / sp;
        vy *= opts.maxWallSpeed / sp;
      }
      const carryX = v.dx - vx * nSub;
      const carryY = v.dy - vy * nSub;
      this.moving.push({
        x0: v.x0, y0: v.y0, x1: v.x1, y1: v.y1,
        vx, vy, carryX, carryY,
        owner: v.index, kind: 0, rainWeight: v.rainWeight,
        sx0: v.x0 - vx * nSub, sy0: v.y0 - vy * nSub,
      });
    }
  }

  get hasCarry(): boolean {
    return this.moving.some((m) => m.carryX !== 0 || m.carryY !== 0);
  }

  /** Rects as they stand at the end of substep `s` (0-based). */
  rectsAt(s: number): SimRect[] {
    const t = s + 1;
    const out: SimRect[] = this.moving.map((m) => {
      const ox = m.sx0 + m.vx * t;
      const oy = m.sy0 + m.vy * t;
      return { ...m, x0: ox, y0: oy, x1: ox + (m.x1 - m.x0), y1: oy + (m.y1 - m.y0) };
    });
    const n = out.length;
    const pad = this.opts.margin + 2;
    const shallow = -(2 * this.opts.margin + 2);
    for (let i = 0; i < n && out.length < MAX_RECTS; i++) {
      for (let j = i + 1; j < n && out.length < MAX_RECTS; j++) {
        const a = out[i]!;
        const b = out[j]!;
        // negative gap = overlap depth along that axis
        const gx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const gy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
        const base = {
          vx: (a.vx + b.vx) / 2, vy: (a.vy + b.vy) / 2,
          carryX: 0, carryY: 0, owner: a.owner, kind: 1 as const, rainWeight: 0,
        };
        if (gy <= -2 && gx <= this.opts.gap && gx > shallow) {
          out.push({
            ...base,
            x0: Math.min(a.x1, b.x1) - pad, x1: Math.max(a.x0, b.x0) + pad,
            y0: Math.max(a.y0, b.y0), y1: Math.min(a.y1, b.y1),
          });
        } else if (gx <= -2 && gy <= this.opts.gap && gy > shallow) {
          out.push({
            ...base,
            y0: Math.min(a.y1, b.y1) - pad, y1: Math.max(a.y0, b.y0) + pad,
            x0: Math.max(a.x0, b.x0), x1: Math.min(a.x1, b.x1),
          });
        }
      }
    }
    return out;
  }
}
