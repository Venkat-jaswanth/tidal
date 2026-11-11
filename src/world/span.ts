// "Span screens": with the Window Management permission, new vessels can open on another display,
// against the bezel it shares with this one, so liquid can pour from screen to screen.

export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

interface ScreenDetailsLike {
  screens: (ScreenBox & { isPrimary?: boolean; label?: string })[];
  currentScreen: ScreenBox;
}

declare global {
  interface Window {
    getScreenDetails?: () => Promise<ScreenDetailsLike>;
  }
}

export const spanSupported = (): boolean => 'getScreenDetails' in window;

export interface SpanResult {
  ok: boolean;
  screens: number;
  reason?: 'unsupported' | 'denied' | 'single-screen';
}

let details: ScreenDetailsLike | null = null;

/** Ask for the multi-screen layout. Call from a user gesture; the browser shows a permission prompt. */
export async function requestSpan(): Promise<SpanResult> {
  if (!window.getScreenDetails) return { ok: false, screens: 1, reason: 'unsupported' };
  try {
    details = await window.getScreenDetails();
  } catch {
    return { ok: false, screens: 1, reason: 'denied' };
  }
  if (details.screens.length < 2) return { ok: false, screens: details.screens.length, reason: 'single-screen' };
  return { ok: true, screens: details.screens.length };
}

/**
 * Where to open a vessel of this outer size on a neighbouring screen: inside that screen's work area,
 * pressed against the edge it shares with the current screen and lined up with the anchor window.
 * Returns null when there is no other screen.
 */
export function spotOnOtherScreen(
  screens: readonly ScreenBox[], current: ScreenBox,
  anchor: { x: number; y: number; w: number; h: number }, size: { w: number; h: number }, used = 0,
): { left: number; top: number } | null {
  const others = screens.filter((s) => s.left !== current.left || s.top !== current.top);
  if (others.length === 0) return null;
  const other = others[used % others.length]!;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const maxLeft = other.availLeft + other.availWidth - size.w;
  const maxTop = other.availTop + other.availHeight - size.h;
  let left = clamp(anchor.x, other.availLeft, maxLeft);
  let top = clamp(anchor.y, other.availTop, maxTop);
  if (other.top + other.height <= current.top) top = maxTop;                 // other screen is above: sit on its bottom edge
  else if (other.top >= current.top + current.height) top = other.availTop;   // below: hang from its top edge
  else if (other.left + other.width <= current.left) left = maxLeft;          // to the left: against its right edge
  else if (other.left >= current.left + current.width) left = other.availLeft; // to the right: against its left edge
  return { left: Math.round(left), top: Math.round(top) };
}

/** The spot for the next vessel on another screen, or null if spanning is not granted or not possible. */
export function nextSpanSpot(anchor: { x: number; y: number; w: number; h: number }, size: { w: number; h: number }, used: number): { left: number; top: number } | null {
  if (!details) return null;
  return spotOnOtherScreen(details.screens, details.currentScreen, anchor, size, used);
}
