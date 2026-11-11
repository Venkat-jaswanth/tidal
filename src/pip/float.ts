// "Float": a small always-on-top tank in a Document Picture-in-Picture window.
// The opener draws it with its own GPU device and speaks for it in the registry; dragging it around
// the desktop sloshes its liquid, and touching it to a vessel lets liquid pour across.

import type { Engine, ExtraView } from '../engine';

interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean; preferInitialWindowPlacement?: boolean }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export interface FloatTank {
  readonly window: Window;
  readonly view: ExtraView;
  close(): void;
}

export const floatSupported = (): boolean => 'documentPictureInPicture' in window;

/**
 * Opens the floating tank. Must be called from a user gesture.
 * `decorate` lets the caller mount labels into the new document. `onClose` fires however it closes.
 */
export async function openFloat(
  engine: Engine,
  decorate: (doc: Document, view: ExtraView) => (() => void) | void,
  onClose: () => void,
  size = { width: 360, height: 260 },
): Promise<FloatTank | null> {
  const api = window.documentPictureInPicture;
  if (!api) return null;
  const pip = await api.requestWindow({ ...size, disallowReturnToOpener: true });
  const doc = pip.document;
  doc.documentElement.lang = 'en';
  doc.title = 'Tidal — float';
  const style = doc.createElement('style');
  style.textContent = 'html,body{margin:0;height:100%;overflow:hidden;background:#f1eee6}canvas{display:block;width:100vw;height:100vh}';
  doc.head.append(style);
  const canvas = doc.createElement('canvas');
  canvas.id = 'tank';
  doc.body.append(canvas);

  const view = await engine.addView(pip, canvas, 'pip');
  if (!view) { pip.close(); return null; }
  const undecorate = decorate(doc, view);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (undecorate) undecorate();
    view.remove();
    if (!pip.closed) pip.close();
    onClose();
  };
  // the user closing it, or the opener navigating away, both arrive here
  pip.addEventListener('pagehide', close, { once: true });
  addEventListener('pagehide', close, { once: true });
  return { window: pip, view, close };
}
