// The four liquids: how each moves and how each looks.

import type { LiquidDef } from './engine';
import { WATER_LOOK } from './render/theme';
import { WATER } from './sim/mpm';

export const INK_ULTRAMARINE = '#1b2bb5';
export const INK_CADMIUM = '#ff5a0a';

export const LIQUIDS: Record<string, LiquidDef> = {
  water: { id: 'water', physics: WATER, look: WATER_LOOK },
  // Heavy and bright: it holds together in beads, does not wet the glass, and mirrors the room.
  mercury: {
    id: 'mercury',
    physics: { ...WATER, gravityY: 3800, viscosity: 0.05, cohesion: 0.5, damping: 0.999 },
    look: {
      ...WATER_LOOK,
      absorb: [0, 0, 0], tint: '#b9bec6', tintOpacity: 0.1, bodyOpacity: 0.9,
      refraction: 0, magnification: 1, dispersion: 0, caustics: 0,
      meniscus: -5, mirror: 0.2, foam: 0, metal: 1,
    },
  },
  // Thick and slow: it folds and coils instead of splashing.
  honey: {
    id: 'honey',
    physics: { ...WATER, gravityY: 2600, viscosity: 0.9, damping: 0.9985, soundSpeed2: 0.3 },
    look: {
      ...WATER_LOOK,
      absorb: [0.1, 0.42, 1.5], tint: '#b86a12', tintOpacity: 0.5, bodyOpacity: 0.12,
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
      absorb: [0.05, 0.05, 0.05], tint: INK_ULTRAMARINE, inkB: INK_CADMIUM, tintOpacity: 0.5, bodyOpacity: 0.42,
      caustics: 0.3, mirror: 0.55, foam: 0,
    },
  },
};
