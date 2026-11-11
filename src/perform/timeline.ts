// The Perform choreography: up to three popup vessels move like glassware in a demonstration.
// Vessel 0 is the large receiving beaker; vessels 1 and 2 are the smaller ones that pour into it.
// Windows with a higher role sit in front, so a pouring vessel always overlaps the one below it.

export interface Rect { x: number; y: number; w: number; h: number }
export type Pose = Rect;

export const PERFORM_SECONDS = 17;
/** Height of a popup's title bar on this platform, measured in spike S1. Vertical pours overlap it. */
const TITLE_BAR = 67;
const POUR_OVERLAP = 72;
const APART = 64;

interface Key { t: number; x: number; y: number }

const ease = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

function at(keys: readonly Key[], t: number): { x: number; y: number } {
  const first = keys[0]!;
  if (t <= first.t) return first;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (t <= b.t) {
      const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return keys[keys.length - 1]!;
}

/** Outer window sizes for each role on a stage of this size. */
export function sizes(stage: Rect): { big: { w: number; h: number }; small: { w: number; h: number } } {
  // grow with the stage, so a performance fills a large display instead of huddling at its foot
  const k = Math.min(1.32, stage.w / 1400, stage.h / 800);
  return {
    big: { w: Math.round(560 * k), h: Math.round(520 * k) },
    small: { w: Math.round(330 * k), h: Math.round(330 * k) },
  };
}

/**
 * Where the vessel with this role should be `t` seconds into the performance.
 * `count` is how many vessels take part (1 to 3). Returns outer window bounds in screen px.
 */
export function poseAt(role: number, count: number, t: number, stage: Rect): Pose | null {
  if (role < 0 || role >= Math.min(count, 3)) return null;
  const { big, small } = sizes(stage);
  const floorBig = stage.y + stage.h - big.h;
  const floorSmall = stage.y + stage.h - small.h;
  const ax = stage.x + Math.round((stage.w - big.w) / 2);
  // resting places for the small vessels: touching the big one, or standing apart from it
  const leftTouch = ax - small.w, leftApart = ax - small.w - APART;
  const rightTouch = ax + big.w, rightApart = ax + big.w + APART;
  // pouring places: above the big vessel, floor level with its content top, overlapping one corner
  const pourY = floorBig + TITLE_BAR - small.h;
  const pourLeft = ax - small.w + POUR_OVERLAP;
  const pourRight = ax + big.w - POUR_OVERLAP;
  // during the fling the small vessels stand well clear, so the big one keeps its liquid
  const room = Math.max(0, ax - stage.x - small.w - APART - 8);
  const fling = Math.min(170, Math.max(40, room - 20));
  const leftClear = Math.max(stage.x, leftApart - fling - 40);
  const rightClear = Math.min(stage.x + stage.w - small.w, rightApart + fling + 40);

  let keys: Key[];
  if (role === 0) {
    keys = [
      { t: 0, x: ax, y: floorBig }, { t: 12.9, x: ax, y: floorBig },
      // the full beaker is shoved aside and back: the big slosh
      { t: 13.3, x: ax - fling, y: floorBig }, { t: 13.9, x: ax - fling, y: floorBig },
      { t: 14.3, x: ax + fling, y: floorBig }, { t: 14.9, x: ax + fling, y: floorBig },
      { t: 15.5, x: ax, y: floorBig },
    ];
    const p = at(keys, t);
    return { x: Math.round(p.x), y: Math.round(p.y), ...big };
  }
  if (role === 1) {
    keys = [
      { t: 0, x: leftApart, y: floorSmall }, { t: 1.4, x: leftApart, y: floorSmall },
      { t: 2.2, x: leftTouch, y: floorSmall }, { t: 3.4, x: leftTouch, y: floorSmall },   // level with the big vessel
      { t: 4.0, x: leftApart, y: floorSmall },
      { t: 5.0, x: leftApart, y: pourY }, { t: 5.8, x: pourLeft, y: pourY },               // lift, then tip in
      { t: 8.6, x: pourLeft, y: pourY },
      { t: 9.3, x: leftApart, y: pourY }, { t: 10.2, x: leftApart, y: floorSmall },
      { t: 11.6, x: leftApart, y: floorSmall }, { t: 12.5, x: leftClear, y: floorSmall },    // stand clear of the fling
      { t: 15.4, x: leftClear, y: floorSmall }, { t: 16.5, x: leftTouch, y: floorSmall },    // rejoin
    ];
  } else {
    keys = [
      { t: 0, x: rightApart, y: floorSmall }, { t: 1.6, x: rightApart, y: floorSmall },
      { t: 2.4, x: rightTouch, y: floorSmall }, { t: 3.4, x: rightTouch, y: floorSmall },
      { t: 4.0, x: rightApart, y: floorSmall }, { t: 8.4, x: rightApart, y: floorSmall },
      { t: 9.4, x: rightApart, y: pourY }, { t: 10.2, x: pourRight, y: pourY },
      { t: 12.3, x: pourRight, y: pourY },
      { t: 12.6, x: rightClear, y: pourY }, { t: 13.6, x: rightClear, y: floorSmall },
      { t: 15.4, x: rightClear, y: floorSmall }, { t: 16.5, x: rightTouch, y: floorSmall },
    ];
  }
  const p = at(keys, t);
  return { x: Math.round(p.x), y: Math.round(p.y), ...small };
}

/** The launch film: one vessel, a second opens beside it and takes water, is flung away, then pours back from above. */
export const HERO_SECONDS = 14.5;

/**
 * Film choreography for two vessels. Role 0 is the first, large vessel; role 1 opens beside it at
 * `HERO_SECOND_OPENS` seconds and should be created at the pose this returns for that time.
 */
export const HERO_SECOND_OPENS = 2;

export function heroPoseAt(role: number, t: number, stage: Rect): Pose | null {
  if (role < 0 || role > 1) return null;
  const { big, small } = sizes(stage);
  const floorBig = stage.y + stage.h - big.h;
  const floorSmall = stage.y + stage.h - small.h;
  const ax = stage.x + Math.round((stage.w - big.w - small.w) / 2) - 60;
  const touch = ax + big.w;
  const flung = Math.min(stage.x + stage.w - small.w, touch + 420);
  const pourY = floorBig + TITLE_BAR - small.h;
  const pourX = ax + big.w - POUR_OVERLAP;
  const fling = Math.min(150, Math.max(40, ax - stage.x - 20));
  if (role === 0) {
    const p = at([
      { t: 0, x: ax, y: floorBig }, { t: 11.2, x: ax, y: floorBig },
      { t: 11.55, x: ax - fling, y: floorBig }, { t: 12.1, x: ax - fling, y: floorBig },
      { t: 12.5, x: ax, y: floorBig },
    ], t);
    return { x: Math.round(p.x), y: Math.round(p.y), ...big };
  }
  const p = at([
    { t: 0, x: touch, y: floorSmall }, { t: 4.1, x: touch, y: floorSmall },      // beside the first: water pours across
    { t: 4.55, x: flung, y: floorSmall }, { t: 6.6, x: flung, y: floorSmall },    // flung away: the wave hits its far wall
    { t: 7.4, x: flung, y: pourY }, { t: 8.2, x: pourX, y: pourY },               // lifted over the first vessel
    { t: 10.9, x: pourX, y: pourY },                                              // tipped in
    { t: 11.2, x: flung, y: pourY }, { t: 12.4, x: flung, y: floorSmall },
    { t: 13.3, x: touch, y: floorSmall },                                         // back beside it
  ], t);
  return { x: Math.round(p.x), y: Math.round(p.y), ...small };
}
