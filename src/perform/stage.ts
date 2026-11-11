// Stage mode: a dark, clean backdrop the size of the screen's work area, sitting behind the vessels.
// It exists so that recordings and performances never show the desktop, other apps or notifications.
// It is a popup rather than HTML fullscreen: on macOS a fullscreen window moves to its own Space,
// where the vessel popups could not sit on top of it.

const STAGE_FLAG = 'stage';

export const isStagePage = (): boolean => new URLSearchParams(location.search).has(STAGE_FLAG);

/** Open the backdrop on this window's screen. Must be called from a user gesture. */
export function openStage(): Window | null {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const left = s.availLeft ?? 0, top = s.availTop ?? 0;
  const url = `${location.origin}${location.pathname}?${STAGE_FLAG}`;
  return window.open(url, 'tidal-stage', `popup,left=${left},top=${top},width=${s.availWidth},height=${s.availHeight}`);
}

/** Turn the current document into the backdrop. No vessel, no simulation: only a quiet dark field. */
export function mountStage(doc: Document): void {
  doc.title = 'Tidal — stage';
  doc.documentElement.dataset.stage = 'yes';
  const style = doc.createElement('style');
  style.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0d0f; }
    body {
      background-image:
        linear-gradient(to right, rgba(95, 138, 130, 0.10) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(95, 138, 130, 0.10) 1px, transparent 1px);
      background-size: 80px 80px;
    }
    .stage-note {
      position: fixed; left: 20px; bottom: 16px; margin: 0;
      font: 400 10px/1 'B612', sans-serif; letter-spacing: 0.14em; text-transform: uppercase;
      color: #c9f2e6; opacity: 0.45;
    }
    .stage-note button { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
    .stage-note button:focus-visible { outline: 2px solid #c9f2e6; outline-offset: 3px; }
  `;
  doc.head.append(style);
  doc.querySelector('#vessel')?.remove();
  const main = doc.createElement('main');
  const note = doc.createElement('p');
  note.className = 'stage-note';
  note.append('Stage. ');
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => window.close());
  note.append(close);
  main.append(note);
  doc.body.append(main);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
  // the stage never outlives the window that opened it
  const opener = window.opener as Window | null;
  if (opener) setInterval(() => { if (opener.closed) window.close(); }, 1000);
}
