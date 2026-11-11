// Tidal Pocket: on a phone, tilting the device steers gravity and a shake throws a splash.
// When motion sensors are refused or silent, a finger drag stands in for the tilt.
// The logic follows spike S8 (spikes/s8-tilt/RESULT.md).

export interface TiltState {
  mode: 'idle' | 'orientation' | 'touch';
  gravity: [number, number];
  permission: 'unknown' | 'granted' | 'denied' | 'not-needed';
  shakes: number;
}

export interface Tilt {
  readonly state: TiltState;
  /** Call from a user gesture (tap). Requests iOS motion permission if needed, then starts listening. */
  start(): Promise<void>;
  stop(): void;
}

type Vec = [number, number];
type Vec3 = [number, number, number];
type PermissionResult = 'granted' | 'denied' | 'default';
interface PermissionCtor { requestPermission?: () => Promise<PermissionResult> }

/** No valid orientation event within this long after start() → touch fallback. */
const FALLBACK_MS = 1500;
/** Low-pass time constant on the gravity vector. */
const SMOOTH_MS = 80;
/** |g| never drops below this, so the water always settles somewhere. */
const MIN_G = 0.35;
/** Below this raw length the direction is sensor noise (≈3.4° of tilt), so the last direction is kept. */
const DIR_EPS = 0.06;
/** onGravity fires only when the vector moved further than this. */
const EMIT_EPS = 0.004;
const SHAKE_ONSET = 14;        // m/s², gravity removed
const SHAKE_FULL = 40;         // m/s² that counts as the strongest shake
const SHAKE_COOLDOWN_MS = 350;
/** Time constant of the gravity estimate removed from accelerationIncludingGravity. */
const GRAVITY_TRACK_MS = 200;
/** A drag reaches full gravity at this fraction of the smaller viewport side. */
const DRAG_FULL = 0.35;
const RELEASE_MS = 400;

const TYPE_ANGLE: Record<string, number> = {
  'portrait-primary': 0, 'landscape-primary': 90, 'portrait-secondary': 180, 'landscape-secondary': 270,
};

/**
 * How far the screen content is rotated from the device's natural portrait frame, in degrees.
 * `screen.orientation.type` comes first: Playwright's WebKit reports an inverted `.angle`.
 */
export function screenAngle(win: Window): number {
  const so = win.screen?.orientation;
  if (so && so.type in TYPE_ANGLE) return TYPE_ANGLE[so.type]!;
  if (so && typeof so.angle === 'number') return ((so.angle % 360) + 360) % 360;
  const legacy = (win as unknown as { orientation?: unknown }).orientation;
  if (typeof legacy === 'number') return ((legacy % 360) + 360) % 360;
  return 0;
}

/**
 * Gravity projected on the screen (x right, y down) from deviceorientation angles, |g| <= 1.
 * This is (sin γ, sin β) with the x term weighted by cos β, which is the exact projection: a phone held
 * upright gives (0, 1) even while γ swings near vertical, and a phone lying flat gives a short vector.
 */
export function tiltToGravity(beta: number, gamma: number, angleDeg: number): Vec {
  const r = Math.PI / 180;
  const g = Math.max(-90, Math.min(90, gamma)) * r;
  const b = beta * r;
  const dx = Math.sin(g) * Math.cos(b);
  const dy = Math.sin(b);
  const a = angleDeg * r;
  const c = Math.cos(a), s = Math.sin(a);
  return [dx * c + dy * s, -dx * s + dy * c];
}

/** True for coarse-pointer, small-screen devices. */
export function isPocket(win: Window = window): boolean {
  const coarse = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
  const s = win.screen;
  return coarse && !!s && Math.min(s.width, s.height) <= 820;
}

const len = (v: Vec): number => Math.hypot(v[0], v[1]);
const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Scale v so MIN_G <= |v| <= 1; a vanishing vector borrows `dir`. */
function bounded(v: Vec, dir: Vec): Vec {
  const l = len(v);
  if (l < 1e-6) return [dir[0] * MIN_G, dir[1] * MIN_G];
  const k = Math.min(1, Math.max(MIN_G, l)) / l;
  return [v[0] * k, v[1] * k];
}

function isControl(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' &&
    !!el.closest('button, a[href], input, select, textarea, label, summary, [role="button"], [contenteditable="true"]');
}

export function mountTilt(win: Window, onGravity: (x: number, y: number) => void, onShake: (strength: number) => void): Tilt {
  const state: TiltState = { mode: 'idle', gravity: [0, 1], permission: 'unknown', shakes: 0 };
  const root = win.document.documentElement;

  let started = false;
  let generation = 0;            // bumps on stop(), so a late permission answer is ignored
  let fallbackTimer = 0;
  let raf = 0;
  let lastFrame = 0;

  let target: Vec = [0, 1];      // where gravity is heading, already bounded
  let dir: Vec = [0, 1];         // last direction that was more than noise
  let smooth: Vec = [0, 1];
  let emitted: Vec = [0, 1];

  let release: { from: Vec; t0: number } | null = null;
  let pointer: number | null = null;
  let touchListening = false;
  let savedTouchAction: string | null = null;

  let lastShake = -Infinity;
  let track: { lp: Vec3; prev: Vec3; t: number } | null = null;

  // ------------------------------------------------------------ output

  const schedule = (): void => {
    if (!raf && started) raf = win.requestAnimationFrame(frame);
  };

  function aim(raw: Vec): void {
    const l = len(raw);
    if (l >= DIR_EPS) dir = [raw[0] / l, raw[1] / l];
    const m = Math.min(1, Math.max(MIN_G, l));
    target = [dir[0] * m, dir[1] * m];
    schedule();
  }

  function frame(now: number): void {
    raf = 0;
    const dt = lastFrame ? Math.min(100, Math.max(0, now - lastFrame)) : 16;
    lastFrame = now;
    if (release) {
      const t = Math.min(1, (now - release.t0) / RELEASE_MS);
      const e = t * t * (3 - 2 * t);
      const a0 = Math.atan2(release.from[1], release.from[0]);
      let da = Math.PI / 2 - a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));           // shortest way round
      const a = a0 + da * e;
      const m = len(release.from) + (1 - len(release.from)) * e;
      dir = [Math.cos(a), Math.sin(a)];
      target = t >= 1 ? [0, 1] : [dir[0] * m, dir[1] * m];
      if (t >= 1) { dir = [0, 1]; release = null; }
    }
    const k = 1 - Math.exp(-dt / SMOOTH_MS);
    smooth = [smooth[0] + (target[0] - smooth[0]) * k, smooth[1] + (target[1] - smooth[1]) * k];
    const out = bounded(smooth, dir);
    state.gravity = out;
    if (dist(out, emitted) > EMIT_EPS) {
      emitted = out;
      onGravity(out[0], out[1]);
    }
    if (release || dist(smooth, target) > 1e-4) schedule();
    else lastFrame = 0;
  }

  // ------------------------------------------------------------ sensors

  const onOrientation = (e: DeviceOrientationEvent): void => {
    const { beta, gamma } = e;
    if (beta == null || gamma == null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return; // desktop Chrome fires an all-null event
    win.clearTimeout(fallbackTimer);
    if (state.mode !== 'orientation') enterOrientation();
    aim(tiltToGravity(beta, gamma, screenAngle(win)));
  };

  const onMotion = (e: DeviceMotionEvent): void => {
    const now = win.performance.now();
    let mag: number;
    const a = e.acceleration;
    if (a && a.x != null && a.y != null && a.z != null) {
      mag = Math.hypot(a.x, a.y, a.z);
    } else {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null) return;
      const v: Vec3 = [g.x, g.y, g.z ?? 0];
      if (!track) { track = { lp: v, prev: v, t: now }; return; }
      // The gravity estimate follows the previous reading for as long as it was held, then the new
      // reading is compared against it: a slow tilt moves both together, a jolt stands out.
      const k = 1 - Math.exp(-Math.max(0, now - track.t) / GRAVITY_TRACK_MS);
      const lp: Vec3 = [
        track.lp[0] + (track.prev[0] - track.lp[0]) * k,
        track.lp[1] + (track.prev[1] - track.lp[1]) * k,
        track.lp[2] + (track.prev[2] - track.lp[2]) * k,
      ];
      mag = Math.hypot(v[0] - lp[0], v[1] - lp[1], v[2] - lp[2]);
      track = { lp, prev: v, t: now };
    }
    if (mag > SHAKE_ONSET && now - lastShake >= SHAKE_COOLDOWN_MS) {
      lastShake = now;
      state.shakes++;
      onShake(Math.min(1, 0.25 + 0.75 * (mag - SHAKE_ONSET) / (SHAKE_FULL - SHAKE_ONSET)));
    }
  };

  // ------------------------------------------------------------ touch fallback

  const toViewport = (x: number, y: number): void => {
    const w = win.innerWidth, h = win.innerHeight;
    const full = DRAG_FULL * Math.min(w, h);
    const dx = x - w / 2, dy = y - h / 2;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) { aim([0, 0]); return; }
    const m = Math.min(1, d / full);
    aim([(dx / d) * m, (dy / d) * m]);
  };

  const onDown = (e: PointerEvent): void => {
    if (state.mode !== 'touch' || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || isControl(e.target)) return;
    pointer = e.pointerId;
    release = null;
    toViewport(e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent): void => {
    if (state.mode !== 'touch' || e.pointerId !== pointer) return;
    toViewport(e.clientX, e.clientY);
  };
  const letGo = (): void => {
    if (pointer === null) return;
    pointer = null;
    if (state.mode !== 'touch') return;
    release = { from: bounded(smooth, dir), t0: win.performance.now() };
    schedule();
  };
  const onUp = (e: PointerEvent): void => { if (e.pointerId === pointer) letGo(); };
  const onBlur = (): void => letGo();

  function enterTouch(): void {
    if (!started || state.mode === 'touch') return;
    state.mode = 'touch';
    // Without this the browser claims a vertical drag for pull-to-refresh and cancels the pointer.
    savedTouchAction = root.style.touchAction;
    root.style.touchAction = 'none';
    if (touchListening) return;
    touchListening = true;
    win.addEventListener('pointerdown', onDown);
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onUp);
    win.addEventListener('blur', onBlur);
  }

  function enterOrientation(): void {
    if (state.mode === 'touch') {
      pointer = null;
      release = null;
      if (savedTouchAction !== null) root.style.touchAction = savedTouchAction;
      savedTouchAction = null;
    }
    state.mode = 'orientation';
  }

  function listen(motion: boolean): void {
    win.addEventListener('deviceorientation', onOrientation);
    if (motion) win.addEventListener('devicemotion', onMotion);
    fallbackTimer = win.setTimeout(() => { if (state.mode === 'idle') enterTouch(); }, FALLBACK_MS);
  }

  // ------------------------------------------------------------ lifecycle

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const gen = generation;
    const doe = (win as unknown as { DeviceOrientationEvent?: PermissionCtor }).DeviceOrientationEvent;
    const dme = (win as unknown as { DeviceMotionEvent?: PermissionCtor }).DeviceMotionEvent;
    if (!doe || typeof doe.requestPermission !== 'function') {
      state.permission = 'not-needed';
      listen(true);
      return;
    }
    // Both requests are issued synchronously, inside the gesture: iOS wants user activation for each call.
    const ask = (c: PermissionCtor | undefined): Promise<PermissionResult> => {
      if (!c || typeof c.requestPermission !== 'function') return Promise.resolve('granted');
      try { return c.requestPermission().catch((): PermissionResult => 'denied'); } catch { return Promise.resolve('denied'); }
    };
    const orientation = ask(doe);
    const motion = ask(dme);
    const [o, m] = await Promise.all([orientation, motion]);
    if (gen !== generation || !started) return;
    state.permission = o === 'granted' ? 'granted' : 'denied';
    if (o !== 'granted') { enterTouch(); return; }
    listen(m === 'granted');     // motion alone refused: tilt still works, shakes don't
  }

  function stop(): void {
    if (!started) return;
    started = false;
    generation++;
    win.clearTimeout(fallbackTimer);
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    lastFrame = 0;
    win.removeEventListener('deviceorientation', onOrientation);
    win.removeEventListener('devicemotion', onMotion);
    if (touchListening) {
      win.removeEventListener('pointerdown', onDown);
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
      win.removeEventListener('blur', onBlur);
      touchListening = false;
    }
    if (savedTouchAction !== null) root.style.touchAction = savedTouchAction;
    savedTouchAction = null;
    pointer = null;
    release = null;
    track = null;
    state.mode = 'idle';
  }

  return { state, start, stop };
}

// ------------------------------------------------------------ prompt

const LABEL_STYLE =
  "font:400 11px/1 'B612','Helvetica Neue',Arial,sans-serif;letter-spacing:0.14em;text-transform:uppercase;" +
  'position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);' +
  'margin:0;padding:0 18px;min-height:44px;display:flex;align-items:center;white-space:nowrap;' +
  'border:0;border-radius:0;z-index:10;-webkit-tap-highlight-color:transparent;transition:opacity 140ms ease-out;';

/**
 * A single quiet "Tilt to pour" button near the bottom. Tapping it starts the tilt (inside the gesture,
 * as iOS requires) and removes it. If motion is refused or silent, a short line says so for 4 s.
 * Returns a function that removes whatever is showing.
 */
export function mountTiltPrompt(doc: Document, tilt: Tilt, theme: { ink: string; paper: string }): () => void {
  const win = doc.defaultView;
  const still = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const colours = `color:${theme.ink};background:${theme.paper};`;
  const timers: number[] = [];
  let disposed = false;
  let note: HTMLElement | null = null;

  const later = (fn: () => void, ms: number): void => { timers.push(win ? win.setTimeout(fn, ms) : 0); };
  const fadeOut = (el: HTMLElement): void => {
    if (still) { el.remove(); return; }
    el.style.opacity = '0';
    later(() => el.remove(), 160);
  };

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Tilt to pour';
  button.style.cssText = LABEL_STYLE + colours + 'cursor:pointer;';

  function showNote(): void {
    if (disposed || note) return;
    note = doc.createElement('p');
    note.setAttribute('role', 'status');
    note.style.cssText = LABEL_STYLE + colours + 'pointer-events:none;';
    doc.body.append(note);
    const el = note;
    // filled a moment after insertion, so screen readers announce it
    later(() => { el.textContent = 'Motion is off. Drag to tilt.'; }, 30);
    later(() => fadeOut(el), 4000);
  }

  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    const started = tilt.start();       // synchronous up to the permission request: still inside the gesture
    fadeOut(button);
    void started.then(() => {
      if (disposed) return;
      if (tilt.state.permission === 'denied') showNote();
      else later(() => { if (tilt.state.mode === 'touch') showNote(); }, FALLBACK_MS + 150);
    });
  });
  doc.body.append(button);

  return () => {
    disposed = true;
    for (const t of timers) win?.clearTimeout(t);
    button.remove();
    note?.remove();
  };
}
