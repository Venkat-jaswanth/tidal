// The four liquids: how each moves and how each looks.

import type { LiquidDef } from './engine';
import { WATER_LOOK } from './render/theme';
import { WATER } from './sim/mpm';

export const INK_ULTRAMARINE = '#1b2bb5';
export const INK_CADMIUM = '#ff5a0a';

export const LIQUIDS: Record<string, LiquidDef> = {
  water: { id: 'water', physics: WATER, look: WATER_LOOK },
  // Heavy and bright: it falls fast, settles fast, does not wet the glass, and mirrors the ruling around it.
  mercury: {
    id: 'mercury',
    // (No cohesion: letting the pressure go negative makes the solver string the liquid into webs that hang in the air.)
    physics: { ...WATER, gravityY: 4200, viscosity: 0.12, cohesion: 0, damping: 0.9985 },
    look: {
      ...WATER_LOOK,
      absorb: [0, 0, 0], tint: '#b4bac3', tintOpacity: 0.04, bodyOpacity: 0.96,
      refraction: 0, magnification: 1, dispersion: 0, caustics: 0,
      meniscus: -6, mirror: 0.15, foam: 0, metal: 1,
    },
  },
  // Thick and slow: it folds and coils instead of splashing.
  honey: {
    id: 'honey',
    physics: { ...WATER, gravityY: 2600, viscosity: 0.9, damping: 0.9985, soundSpeed2: 0.42 },
    look: {
      ...WATER_LOOK,
      absorb: [0.08, 0.36, 1.3], tint: '#b9731c', tintOpacity: 0.42, bodyOpacity: 0.1,
      refraction: 16, magnification: 1.16, dispersion: 0.03, caustics: 0.35,
      meniscus: 13, mirror: 0.6, foam: 0.25,
    },
  },
  // Two inks, one per vessel, that mix where the liquid meets.
  ink: {
    id: 'ink',
    physics: { ...WATER, dyeMix: 0.006 },
    look: {
      ...WATER_LOOK,
      absorb: [0.05, 0.05, 0.05], tint: INK_ULTRAMARINE, inkB: INK_CADMIUM, tintOpacity: 0.36, bodyOpacity: 0.6,
      caustics: 0.25, mirror: 0.5, foam: 0,
    },
  },
};
