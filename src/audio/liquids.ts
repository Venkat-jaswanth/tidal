// How each liquid sounds. Every number is relative to water unless its comment gives a unit.
// Ink is water carrying dye, so it sounds exactly like water.

export interface SloshTone {
  /** Overall level. */
  level: number;
  /** Band-pass centre in the gentlest and the most violent slosh, Hz. */
  lo: number;
  hi: number;
  /** Band-pass Q in the gentlest and the most violent slosh. */
  qLo: number;
  qHi: number;
  /** Level of the low resonant band, the body of liquid in the tank, against the band-pass. */
  body: number;
  /** Multiplier on the low band's frequency, which otherwise follows the vessel's width. */
  bodyPitch: number;
  /** Depth of the slow random filter movement that makes it gurgle, cents. */
  gurgle: number;
  /** Speed of that movement. */
  gurgleRate: number;
  /** Small bubbles per second carried along by the most violent slosh. */
  bubbles: number;
  /** Top cut, Hz. */
  air: number;
}

export interface DropTone {
  level: number;
  /** Multiplier on the bubble's pitch. */
  pitch: number;
  /** Multiplier on how long it rings. */
  decay: number;
  /** Level of the noise tick at the start. */
  click: number;
  /** Impact above which a slap throws a drop. */
  threshold: number;
}

export interface GlassTone {
  level: number;
  /** Multiplier on how long the glass rings. */
  decay: number;
  /** How strongly the upper partials are struck, 0 to 1. */
  bright: number;
  /** Partials struck, up to 7. */
  partials: number;
  /** Impact above which a slap rings the glass. */
  threshold: number;
}

export interface PourTone {
  level: number;
  /** High-pass on the noise, Hz. */
  hp: number;
  /** The two band-pass centres at the lowest flow, Hz; they rise by about a third with flow. */
  bandA: number;
  bandB: number;
  q: number;
  /** Speed of the burble, relative (1 ≈ 30 to 80 Hz). */
  jitter: number;
  /** Narrow resonance near 3 kHz, dB. */
  metal: number;
  /** Top cut, Hz. */
  air: number;
  /** Bubbles per second where the stream lands. */
  bubbles: number;
}

export interface LiquidTone {
  slosh: SloshTone;
  drop: DropTone;
  glass: GlassTone;
  pour: PourTone;
}

const WATER: LiquidTone = {
  slosh: { level: 1, lo: 300, hi: 1400, qLo: 1.4, qHi: 0.8, body: 1, bodyPitch: 1, gurgle: 520, gurgleRate: 1, bubbles: 7, air: 3200 },
  drop: { level: 1, pitch: 1, decay: 1, click: 0.22, threshold: 0.0005 },
  glass: { level: 1, decay: 1, bright: 0.55, partials: 6, threshold: 0.005 },
  pour: { level: 1, hp: 900, bandA: 1850, bandB: 3350, q: 2.2, jitter: 1, metal: 0, air: 5500, bubbles: 6 },
};

// Dense and cohesive: a heavier, narrower, more metallic slosh, tight bright beads, and a hard strike on the glass.
const MERCURY: LiquidTone = {
  slosh: { level: 0.75, lo: 380, hi: 1700, qLo: 2.4, qHi: 1.5, body: 0.55, bodyPitch: 1.15, gurgle: 300, gurgleRate: 1.4, bubbles: 0, air: 4200 },
  drop: { level: 0.7, pitch: 1.6, decay: 0.5, click: 0.6, threshold: 0.0004 },
  glass: { level: 1.5, decay: 1.25, bright: 0.85, partials: 7, threshold: 0.0035 },
  pour: { level: 0.8, hp: 1100, bandA: 2300, bandB: 3800, q: 3.5, jitter: 0.7, metal: 11, air: 7000, bubbles: 0 },
};

// Slow and viscous: low, dark and quiet, rare heavy blobs, and the glass is damped almost at once.
const HONEY: LiquidTone = {
  slosh: { level: 0.45, lo: 160, hi: 520, qLo: 1, qHi: 0.8, body: 1.4, bodyPitch: 0.8, gurgle: 200, gurgleRate: 0.4, bubbles: 0.8, air: 1200 },
  drop: { level: 0.5, pitch: 0.45, decay: 1.6, click: 0.05, threshold: 0.0012 },
  glass: { level: 0.12, decay: 0.3, bright: 0.2, partials: 4, threshold: 0.008 },
  pour: { level: 0.45, hp: 300, bandA: 900, bandB: 1500, q: 1.4, jitter: 0.45, metal: 0, air: 2400, bubbles: 1 },
};

export const LIQUID_TONES: Readonly<Record<string, LiquidTone>> = { water: WATER, mercury: MERCURY, honey: HONEY, ink: WATER };

export function liquidTone(id: string): LiquidTone {
  return LIQUID_TONES[id] ?? WATER;
}
