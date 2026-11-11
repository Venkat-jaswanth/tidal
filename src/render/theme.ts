// Visual tokens. Colours are sRGB hex; the renderer works in display space.

export interface Theme {
  name: string;
  paper: string;
  /** Grid pitch in CSS px. */
  gridStep: number;
  gridFine: string;
  gridFineAlpha: number;
  gridBold: string;
  gridBoldAlpha: number;
  boldEvery: number;
  fineWidth: number;
  boldWidth: number;
  grain: number;
  ink: string;
  inkAlpha: number;
  highlight: string;
  highlightStrength: number;
  /** Extra light on graduations, for dark themes. */
  glow: number;
  /** How this theme adjusts a liquid's look (a dark field needs the body to carry some light). */
  liquid?: Partial<LiquidLook>;
}

export interface LiquidLook {
  /** Absorption per 100 px of depth, per channel. */
  absorb: [number, number, number];
  tint: string;
  /** Opacity the body reaches at depth (0 for clear liquids). */
  tintOpacity: number;
  /** Opacity the body has everywhere, even when shallow. */
  bodyOpacity: number;
  refraction: number;
  magnification: number;
  dispersion: number;
  caustics: number;
  meniscus: number;
  mirror: number;
  foam: number;
  /** Second ink colour. When set, the field's third channel is the mix between `tint` and this. */
  inkB?: string;
  /** How strongly the body mirrors its surroundings (mercury). */
  metal?: number;
}

export const WATER_LOOK: LiquidLook = {
  absorb: [0.095, 0.024, 0.028],
  tint: '#bfe6ea', tintOpacity: 0, bodyOpacity: 0,
  refraction: 10, magnification: 1.09, dispersion: 0.06, caustics: 1,
  meniscus: 11, mirror: 0.8, foam: 1,
};

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Warm bench-notebook paper, a fine cool-grey ruling with ten divisions to the major line, graphite marks. */
export const BENCH: Theme = {
  name: 'bench',
  paper: '#f1eee6', gridStep: 8,
  gridFine: '#93a1b0', gridFineAlpha: 0.24,
  gridBold: '#7b8a9a', gridBoldAlpha: 0.4, boldEvery: 10,
  fineWidth: 0.6, boldWidth: 0.8, grain: 0.012,
  ink: '#2a2d32', inkAlpha: 0.78,
  highlight: '#ffffff', highlightStrength: 0.95, glow: 0,
};

/** Darkroom: a near-black field where only the graduations and the liquid carry light. */
export const DARKROOM: Theme = {
  name: 'darkroom',
  paper: '#0b0d0f', gridStep: 8,
  gridFine: '#3d5753', gridFineAlpha: 0.16,
  gridBold: '#5f8a82', gridBoldAlpha: 0.26, boldEvery: 10,
  fineWidth: 0.6, boldWidth: 0.8, grain: 0.005,
  ink: '#c9f2e6', inkAlpha: 0.72,
  highlight: '#eafff8', highlightStrength: 0.85, glow: 0.5,
  liquid: { absorb: [0.04, 0.0, 0.0], tint: '#11302f', tintOpacity: 0.42, bodyOpacity: 0.07, caustics: 0.5, mirror: 0.5 },
};

/** Dense millimetre paper with a red index line every centimetre. */
export const MILLIMETRE: Theme = {
  name: 'millimetre',
  paper: '#f6f4ef', gridStep: 6,
  gridFine: '#a9b7c4', gridFineAlpha: 0.38,
  gridBold: '#c0553f', gridBoldAlpha: 0.5, boldEvery: 10,
  fineWidth: 0.6, boldWidth: 0.9, grain: 0.01,
  ink: '#23262b', inkAlpha: 0.82,
  highlight: '#ffffff', highlightStrength: 0.95, glow: 0,
};

export const THEMES: Record<string, Theme> = { bench: BENCH, darkroom: DARKROOM, millimetre: MILLIMETRE };
