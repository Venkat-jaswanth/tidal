// Self-capture for the launch films. Loaded only when the URL has `?capture`.
//
// OS screen capture is not used. Each Tidal window records ITSELF (tab self-capture, or its own
// canvas) and logs where it sits on screen once per animation frame; tools/capture/compose.mjs then
// draws the recordings onto a clean stage. A recording can only ever hold this window's own page:
// tab capture is asked for the current tab only, and the captured surface is checked to be this tab
// through a capture handle before anything is recorded.

import { clock } from '../world/registry';

export type CaptureKind = 'tab' | 'canvas';

export interface CaptureOptions {
  /** Also record the tab's sound (tab capture only). Used for the leader window, which plays the sound. */
  audio?: boolean;
  /** Record sound only: the video track is dropped (still needs tab capture to get the sound). */
  audioOnly?: boolean;
  /** Frames per second asked of the source. Default 60. */
  fps?: number;
  /** Video bit rate. Default 25 Mbit/s. */
  bitsPerSecond?: number;
}

export interface CanvasCaptureOptions extends Omit<CaptureOptions, 'audio' | 'audioOnly'> {
  /** Viewport rectangle on screen, CSS px. Default: the window's own estimate. */
  rect?: () => Rect;
  /** Volume to log with each frame, mL. */
  ml?: () => number;
  /** Vessel slot to log with each frame. */
  slot?: () => number;
  /** Name for this recording, so one window can hold several. Default 'canvas'. */
  name?: string;
}

interface Rect { x: number; y: number; w: number; h: number }

export interface LogEntry {
  /** The animation frame's timestamp on the shared clock (performance.timeOrigin + rAF time), ms. Comparable across windows. */
  t: number;
  /** Viewport rectangle in screen CSS px. */
  x: number; y: number; w: number; h: number;
  /** Outer window rectangle in screen CSS px. */
  outer: Rect;
  title: string;
  dpr: number;
  /** This vessel's volume and slot, when the window holds one. */
  ml?: number;
  slot?: number;
  /** The world's liquid and this window's sound switch (as the audio engine and as the Sound control show it), so a take can prove neither changed. */
  liquid?: string;
  sound?: boolean;
  soundShown?: boolean;
}

/** One run of HTML text, for the compositor to redraw over a canvas-only recording. */
export interface TextItem {
  text: string;
  /** Viewport CSS px of the glyph run (a Range around the text). */
  x: number; y: number; w: number; h: number;
  font: string;
  size: number;
  spacing: string;
  color: string;
  /** Product of the opacities up to the chrome's root. */
  alpha: number;
  /** Computed text-shadow (the chrome's paper halo), or 'none'. */
  shadow: string;
}

export interface TextFrame { t: number; items: TextItem[] }

export interface CaptureResult {
  blob: Blob;
  mime: string;
  kind: CaptureKind;
  /** clock() of the first recorded frame, as best it can be told (see `timing`). */
  startedAt: number;
  log: LogEntry[];
  /** HTML text over the canvas, logged when it changes (canvas recordings only). */
  texts: TextFrame[];
  /** Whether the browser delivered an audio track, and whether it was recorded. */
  audio: { requested: boolean; delivered: boolean; label: string };
  settings: MediaTrackSettings | null;
  /** How startedAt was found, and the arrival times of frames at a second reader. */
  timing: { method: string; startCall: number; onstart: number; firstFrame: number | null; frameArrivals: number[]; frameStamps: number[]; requestCalls: number[] };
  /**
   * Canvas recordings only: clock() of the animation frame each recorded frame was asked for. The
   * canvas is captured with captureStream(0) and one requestFrame() per animation frame, so recorded
   * frame i shows what was drawn in the frame requested at requested[i].
   */
  requested: number[];
  /** Source track counters, where the browser has them. */
  trackStats: { delivered?: number; discarded?: number; total?: number } | null;
}

export interface TransferMeta extends Omit<CaptureResult, 'blob'> {
  bytes: number;
  chunkBytes: number;
  chunks: number;
}

const CHUNK_BYTES = 4 * 1024 * 1024;

interface TrackProcessor { readable: ReadableStream<{ timestamp: number; close(): void }> }
type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor;
interface CaptureHandleConfig { exposeOrigin?: boolean; handle?: string; permittedOrigins?: string[] }
type MediaDevicesWithHandle = MediaDevices & { setCaptureHandleConfig?: (c: CaptureHandleConfig) => void };
type CanvasTrack = MediaStreamTrack & { requestFrame(): void };
type TrackWithHandle = MediaStreamTrack & {
  getCaptureHandle?: () => { handle: string; origin?: string } | null;
  stats?: { deliveredFrames?: number; discardedFrames?: number; totalFrames?: number };
};

/** Viewport rectangle of a window that has no engine: side borders equal, everything else above. */
function estimateRect(win: Window): Rect {
  const dx = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  const dy = Math.max(0, win.outerHeight - win.innerHeight - dx);
  return { x: win.screenX + dx, y: win.screenY + dy, w: win.innerWidth, h: win.innerHeight };
}

function selfRect(): Rect {
  const tidal = window.tidal;
  return tidal ? tidal.calibrator.rect() : estimateRect(window);
}

/** Every visible run of text in the in-window chrome, in viewport px. Visually hidden text (screen-reader only) is left out. */
function collectTexts(doc: Document): TextItem[] {
  const root = doc.querySelector('.tc');
  const view = doc.defaultView;
  if (!root || !view) return [];
  const items: TextItem[] = [];
  const range = doc.createRange();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (e: Element): CSSStyleDeclaration => {
    let cs = styles.get(e);
    if (!cs) { cs = view.getComputedStyle(e); styles.set(e, cs); }
    return cs;
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = n.textContent ?? '';
    const first = data.search(/\S/);
    if (first < 0) continue;
    const last = data.length - (data.length - data.trimEnd().length);
    const el = n.parentElement;
    if (!el) continue;
    let alpha = 1;
    let hidden = false;
    for (let e: Element | null = el; e; e = e === root ? null : e.parentElement) {
      const cs = style(e);
      if (cs.display === 'none' || cs.visibility !== 'visible' || (cs.clipPath && cs.clipPath !== 'none') || (cs.clip && cs.clip !== 'auto')) { hidden = true; break; }
      alpha *= Number(cs.opacity);
    }
    if (hidden || alpha < 0.005) continue;
    range.setStart(n, first);
    range.setEnd(n, last);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = style(el);
    let text = data.slice(first, last);
    if (cs.whiteSpace !== 'pre' && cs.whiteSpace !== 'pre-wrap') text = text.replace(/\s+/g, ' ');
    if (cs.textTransform === 'uppercase') text = text.toUpperCase();
    else if (cs.textTransform === 'lowercase') text = text.toLowerCase();
    items.push({
      text, x: r.left, y: r.top, w: r.width, h: r.height,
      font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size: parseFloat(cs.fontSize),
      spacing: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing, color: cs.color,
      alpha: Math.round(alpha * 1000) / 1000, shadow: cs.textShadow,
    });
  }
  return items;
}

class Recording {
  private recorder: MediaRecorder | null = null;
  private readonly chunks: Blob[] = [];
  private readonly log: LogEntry[] = [];
  private readonly texts: TextFrame[] = [];
  private lastTextKey = '';
  private logging = false;
  private readonly timing: CaptureResult['timing'] = { method: 'onstart', startCall: 0, onstart: 0, firstFrame: null, frameArrivals: [], frameStamps: [], requestCalls: [] };
  private stopped: Promise<void> | null = null;
  private reader: ReadableStreamDefaultReader<{ timestamp: number; close(): void }> | null = null;
  private mime = '';
  private audioInfo: CaptureResult['audio'] = { requested: false, delivered: false, label: '' };
  private settings: MediaTrackSettings | null = null;
  private videoTrack: TrackWithHandle | null = null;
  /** Canvas capture driven frame by frame from the log loop. */
  private manual: CanvasTrack | null = null;
  private capturing = false;
  private readonly requested: number[] = [];
  private fps = 60;
  private observer: MutationObserver | null = null;

  constructor(
    readonly kind: CaptureKind,
    private readonly view: Window,
    private readonly rect: () => Rect,
    private readonly ml: (() => number) | null,
    private readonly withTexts: boolean,
    private readonly slotOf: (() => number) | null = null,
  ) {}

  get audio(): CaptureResult['audio'] { return this.audioInfo; }
  get videoSettings(): MediaTrackSettings | null { return this.settings; }

  async begin(stream: MediaStream, opts: CaptureOptions): Promise<void> {
    const video = stream.getVideoTracks()[0] as TrackWithHandle | undefined;
    const audio = stream.getAudioTracks()[0];
    this.audioInfo = { requested: !!(opts.audio || opts.audioOnly), delivered: !!audio, label: audio?.label ?? '' };
    this.videoTrack = video ?? null;
    this.settings = video?.getSettings() ?? null;
    const tracks: MediaStreamTrack[] = [];
    if (video && !opts.audioOnly) tracks.push(video);
    if (audio) tracks.push(audio);
    if (tracks.length === 0) throw new Error('nothing to record');
    const recordStream = new MediaStream(tracks);
    const hasVideo = !opts.audioOnly && !!video;
    this.fps = opts.fps ?? 60;
    if (hasVideo && this.kind === 'canvas' && video && 'requestFrame' in video) this.manual = video as unknown as CanvasTrack;
    // VP9 only: MediaRecorder's MP4/H.264 output of tab capture was corrupt in spike S7.
    const candidates = hasVideo
      ? (audio ? ['video/webm;codecs=vp9,opus'] : ['video/webm;codecs=vp9'])
      : ['audio/webm;codecs=opus'];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error(`unsupported: ${candidates.join(', ')}`);
    this.mime = mime;
    const options: MediaRecorderOptions & { videoKeyFrameIntervalCount?: number } = {
      mimeType: mime,
      audioBitsPerSecond: 192_000,
      ...(hasVideo ? { videoBitsPerSecond: opts.bitsPerSecond ?? 25_000_000, videoKeyFrameIntervalCount: 30 } : {}),
    };
    const rec = new MediaRecorder(recordStream, options);
    this.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    const started = new Promise<void>((resolve) => { rec.onstart = () => { this.timing.onstart = clock(); resolve(); }; });

    // A second reader of the same frames tells when the first recorded frames arrived. For a canvas
    // recording it shows whether the recording opens with a stale frame: one that arrives before the
    // first requestFrame() call can only be the canvas as it was before recording began.
    const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    if (hasVideo && video && Processor) {
      try {
        const clone = video.clone();
        this.reader = new Processor({ track: clone, maxBufferSize: 4 }).readable.getReader();
        const reader = this.reader;
        const pump = async (): Promise<void> => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || !value) break;
            if (this.timing.startCall && (!this.manual || this.timing.frameArrivals.length < 40)) {
              this.timing.frameArrivals.push(clock());
              this.timing.frameStamps.push(value.timestamp);
            }
            value.close();
          }
          clone.stop();
        };
        void pump().catch(() => {});
      } catch { this.reader = null; }
    }

    this.startLog();
    this.timing.startCall = clock();
    rec.start(1000);
    await started;
    this.capturing = true;
    // the first frame after start() is the recorder's first frame too
    await new Promise((r) => setTimeout(r, 120));
    const first = this.manual ? this.requested[0] : this.timing.frameArrivals[0];
    if (first !== undefined) { this.timing.firstFrame = first; this.timing.method = this.manual ? 'requested-frames' : 'first-frame-arrival'; }
  }

  private startLog(): void {
    this.logging = true;
    const doc = this.view.document;
    let lastT = 0;
    // labels are read again only when the chrome's DOM or the viewport changes
    let textsDirty = true;
    if (this.withTexts) {
      const mark = (): void => { textsDirty = true; };
      this.observer = new MutationObserver(mark);
      this.observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      this.view.addEventListener('resize', mark);
      for (const f of Array.from(doc.fonts)) void f.loaded.then(mark, mark);
    }
    const sample = (own: boolean, t: number): void => {
      // the opener's loop only stands in when the picture-in-picture window stops getting frames
      if (!own && t - lastT < 50) return;
      if (t - lastT < 4) return;
      lastT = t;
      if (this.capturing && this.manual && t - (this.requested[this.requested.length - 1] ?? 0) >= 600 / this.fps) {
        if (this.timing.requestCalls.length < 40) this.timing.requestCalls.push(clock());
        this.manual.requestFrame();
        this.requested.push(t);
      }
      const v = this.view;
      const r = this.rect();
      const entry: LogEntry = {
        t, x: r.x, y: r.y, w: r.w, h: r.h,
        outer: { x: v.screenX, y: v.screenY, w: v.outerWidth, h: v.outerHeight },
        title: doc.title, dpr: v.devicePixelRatio,
      };
      if (this.ml) { entry.ml = this.ml(); if (this.slotOf) entry.slot = this.slotOf(); }
      else if (window.tidal && v === window) { entry.ml = window.tidal.ml; entry.slot = window.tidal.slot; }
      if (window.tidal) entry.liquid = window.tidal.liquid.id;
      if (window.tidalApp) {
        entry.sound = window.tidalApp.audio.enabled;
        entry.soundShown = document.querySelector('.tc button[aria-pressed]')?.getAttribute('aria-pressed') === 'true';
      }
      this.log.push(entry);
      if (this.withTexts && textsDirty) {
        textsDirty = false;
        const items = collectTexts(doc);
        const key = JSON.stringify(items);
        if (key !== this.lastTextKey) { this.lastTextKey = key; this.texts.push({ t, items }); }
      }
    };
    // Times are the animation frame's own timestamp (its vsync), on the shared clock: the same for
    // every callback in the tick, so the log, the frame requests and the engine's frame agree.
    const loop = (win: Window, own: boolean) => {
      const origin = win.performance.timeOrigin;
      const step = (now: number): void => {
        if (!this.logging) return;
        sample(own, origin + now);
        win.requestAnimationFrame(step);
      };
      win.requestAnimationFrame(step);
    };
    loop(this.view, true);
    // a picture-in-picture window can stop getting frames of its own; the opener keeps the log going
    if (this.view !== window) loop(window, false);
  }

  async end(): Promise<CaptureResult> {
    const rec = this.recorder;
    if (!rec) throw new Error('not recording');
    const stats = this.videoTrack?.stats;
    const trackStats = stats ? { delivered: stats.deliveredFrames, discarded: stats.discardedFrames, total: stats.totalFrames } : null;
    this.capturing = false;
    if (rec.state !== 'inactive') rec.stop();
    await this.stopped;
    this.logging = false;
    this.observer?.disconnect();
    void this.reader?.cancel().catch(() => {});
    for (const t of rec.stream.getTracks()) t.stop();
    this.videoTrack?.stop();
    const first = this.timing.firstFrame ?? this.timing.onstart;
    return {
      blob: new Blob(this.chunks, { type: this.mime }), mime: this.mime, kind: this.kind,
      startedAt: first, log: this.log, texts: this.texts, audio: this.audioInfo,
      settings: this.settings, timing: this.timing, trackStats, requested: this.requested,
    };
  }
}

const recordings = new Map<string, Recording>();
const results = new Map<string, CaptureResult>();

// ---- sound, without tab capture ----
// Any tab capture puts a "sharing this tab" bar into every window of the browser, which shrinks the
// vessels. So the leader's sound is also recordable straight from its audio graph: everything this
// page connects to the speakers is connected to a recording node as well. Installed when this module
// loads, before the sound is switched on.
const taps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>();
const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => AudioNode | void;
const tapOf = (ctx: BaseAudioContext): MediaStreamAudioDestinationNode | null => {
  if (!(ctx instanceof AudioContext)) return null;
  let tap = taps.get(ctx);
  if (!tap) { tap = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2 }); taps.set(ctx, tap); lastTap = tap; }
  return tap;
};
let lastTap: MediaStreamAudioDestinationNode | null = null;
(AudioNode.prototype as { connect: typeof connect }).connect = function (this: AudioNode, ...args: unknown[]) {
  const r = connect.apply(this, args);
  if (args[0] instanceof AudioDestinationNode) {
    const tap = tapOf(this.context);
    if (tap) connect.call(this, tap, typeof args[1] === 'number' ? args[1] : 0, 0);
  }
  return r;
};

/** Records what this page sends to its speakers. The sound must be on (its graph built) first. */
async function startAudio(): Promise<{ ok: boolean; channels: number }> {
  if (recordings.has('audio')) throw new Error('already recording audio');
  const tap = lastTap;
  if (!tap) throw new Error('no sound graph yet: switch the sound on first');
  const rec = new Recording('tab', window, selfRect, null, false);
  recordings.set('audio', rec);
  try {
    await rec.begin(tap.stream, { audioOnly: true });
  } catch (e) {
    recordings.delete('audio');
    throw e;
  }
  return { ok: true, channels: tap.channelCount };
}

async function start(kind: CaptureKind, opts: CaptureOptions = {}): Promise<{ audio: CaptureResult['audio']; settings: MediaTrackSettings | null }> {
  if (recordings.has('self')) throw new Error('already recording');
  const fps = opts.fps ?? 60;
  let stream: MediaStream;
  if (kind === 'tab') {
    // Mark this tab, ask for the current tab only, then check the captured surface is this tab.
    const handle = `tidal-capture-${crypto.randomUUID()}`;
    (navigator.mediaDevices as MediaDevicesWithHandle).setCaptureHandleConfig?.({ exposeOrigin: true, handle, permittedOrigins: [location.origin] });
    const wantAudio = !!(opts.audio || opts.audioOnly);
    stream = await navigator.mediaDevices.getDisplayMedia({
      preferCurrentTab: true,
      selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude', systemAudio: 'exclude',
      // Capped at the viewport's device size: without a cap Chrome raises the captured tab's
      // devicePixelRatio to fill the screen-sized default, which re-renders the water at 2x.
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { max: Math.ceil(innerWidth * devicePixelRatio) },
        height: { max: Math.ceil(innerHeight * devicePixelRatio) },
      },
      audio: wantAudio ? { suppressLocalAudioPlayback: false } : false,
    } as DisplayMediaStreamOptions);
    const video = stream.getVideoTracks()[0] as TrackWithHandle | undefined;
    const surface = (video?.getSettings() as MediaTrackSettings & { displaySurface?: string } | undefined)?.displaySurface;
    const got = video?.getCaptureHandle?.()?.handle;
    if (!video || surface !== 'browser' || (video.getCaptureHandle && got !== handle)) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error(`refused: captured surface is not this tab (${surface ?? 'none'}, ${got ?? 'no handle'})`);
    }
  } else {
    const canvas = document.querySelector<HTMLCanvasElement>('#tank');
    if (!canvas) throw new Error('no #tank canvas');
    stream = canvas.captureStream(0);
  }
  const rec = new Recording(kind, window, selfRect, null, kind === 'canvas');
  recordings.set('self', rec);
  try {
    await rec.begin(stream, opts);
  } catch (e) {
    recordings.delete('self');
    for (const t of stream.getTracks()) t.stop();
    throw e;
  }
  return { audio: rec.audio, settings: rec.videoSettings };
}

/** Records a canvas that lives in another window this one draws (the picture-in-picture tank). */
async function startCanvas(canvas: HTMLCanvasElement, opts: CanvasCaptureOptions = {}): Promise<string> {
  const name = opts.name ?? 'canvas';
  if (recordings.has(name)) throw new Error(`already recording ${name}`);
  const view = canvas.ownerDocument.defaultView;
  if (!view) throw new Error('canvas has no window');
  const rec = new Recording('canvas', view, opts.rect ?? (() => estimateRect(view)), opts.ml ?? null, true, opts.slot ?? null);
  recordings.set(name, rec);
  try {
    await rec.begin(canvas.captureStream(0), opts);
  } catch (e) {
    recordings.delete(name);
    throw e;
  }
  return name;
}

async function stop(name = 'self'): Promise<CaptureResult> {
  const rec = recordings.get(name);
  if (!rec) throw new Error(`not recording ${name}`);
  recordings.delete(name);
  const result = await rec.end();
  results.set(name, result);
  return result;
}

/** Stops a recording and keeps it here for `chunk()`; returns everything but the video bytes. */
async function stopForTransfer(name = 'self'): Promise<TransferMeta> {
  const r = await stop(name);
  return meta(r);
}

function meta(r: CaptureResult): TransferMeta {
  const { blob, ...rest } = r;
  return { ...rest, bytes: blob.size, chunkBytes: CHUNK_BYTES, chunks: Math.ceil(blob.size / CHUNK_BYTES) };
}

/** One slice of a stopped recording as base64, so a test driver can write it to disk. */
async function chunk(name: string, index: number): Promise<string> {
  const r = results.get(name);
  if (!r) throw new Error(`no result ${name}`);
  const buf = new Uint8Array(await r.blob.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
  return btoa(s);
}

/** Accept a finished recording from another window (one that is about to close). */
function adopt(name: string, r: CaptureResult): TransferMeta {
  results.set(name, r);
  return meta(r);
}

const HANDOFF = 'tidal-capture-handoff';
addEventListener('message', (e: MessageEvent<{ type?: string; name?: string; result?: CaptureResult }>) => {
  if (e.origin !== location.origin || e.data?.type !== HANDOFF || !e.data.name || !e.data.result) return;
  results.set(e.data.name, e.data.result);
});

/**
 * Stops this window's recording and hands it to the window that opened it, so this window can close
 * itself straight after (the rain-on-close clip). Returns clock() at the hand-off.
 */
async function handOff(name: string): Promise<number> {
  const opener = window.opener as Window | null;
  if (!opener) throw new Error('no opener to hand the recording to');
  const result = await stop('self');
  opener.postMessage({ type: HANDOFF, name, result }, location.origin);
  return clock();
}

export const tidalCapture = { start, startCanvas, startAudio, stop, stopForTransfer, chunk, adopt, handOff, results, recording: (name = 'self') => recordings.has(name) };

declare global {
  interface Window {
    tidalCapture?: typeof tidalCapture;
  }
}

window.tidalCapture = tidalCapture;
