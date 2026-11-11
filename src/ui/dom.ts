// Small helpers shared by the chrome modules. Everything takes the target document explicitly, because a
// vessel can live in a picture-in-picture window whose document is not the one this script runs in.

import { rgb, type Theme } from '../render/theme';

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A theme is dark when its paper is. */
export function isDark(theme: Theme): boolean {
  const [r, g, b] = rgb(theme.paper);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}

/** "water" → "Water". */
export function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
