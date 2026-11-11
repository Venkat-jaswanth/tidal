// Every Tidal window publishes where its viewport sits on the screen. Together they define the world.

export const CHANNEL = 'tidal';
export const MAX_VESSELS = 12;
const HEARTBEAT_MS = 250;

export interface VesselInfo {
  /** Unique per window, random. */
  id: string;
  /** Small stable number, unique among open windows: the vessel's name and its slot in shared memory. */
  slot: number;
  /** Viewport rectangle in screen CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
  visible: boolean;
  focused: boolean;
  kind: 'main' | 'popup' | 'pip' | 'pocket';
  /** False while the window sits out of the world (the main window during a performance on a stage). */
  active: boolean;
  /** Identifies the shared memory block this window can read, or '' if none. */
  group: string;
  /** Sender's clock (performance.timeOrigin + now), ms. */
  t: number;
}

export type Message =
  | { type: 'state'; info: VesselInfo }
  | { type: 'bye'; id: string }
  | { type: 'who' };

/** Where the content area sits inside the outer window, in CSS px. */
export interface Calibration {
  dx: number;
  dy: number;
  exact: boolean;
}

export const clock = (): number => performance.timeOrigin + performance.now();

/**
 * Tracks the viewport-on-screen offset of one window.
 * `screenX/Y` give the outer window position; the content offset is only known exactly from a pointer event.
 */
export class Calibrator {
  cal: Calibration;

  constructor(private readonly win: Window) {
    this.cal = this.estimate();
    const onPointer = (e: PointerEvent | MouseEvent) => {
      // offset = (screen position of the pointer - its position in the viewport) - outer window position
      const dx = e.screenX - e.clientX - win.screenX;
      const dy = e.screenY - e.clientY - win.screenY;
      if (Number.isFinite(dx) && Number.isFinite(dy) && dx >= -1 && dy >= -1 && dx < 400 && dy < 400) {
        this.cal = { dx, dy, exact: true };
      }
    };
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mouseenter'] as const) {
      win.addEventListener(type, onPointer as EventListener, { passive: true });
    }
    win.addEventListener('resize', () => {
      // Chrome above the content can change with size (toolbars, tab strip); fall back until the next pointer event.
      const est = this.estimate();
      if (!this.cal.exact || Math.abs(est.dy - this.cal.dy) > 1 || Math.abs(est.dx - this.cal.dx) > 1) this.cal = est;
    });
  }

  /** Assumes side borders are equal and everything else is above the content. */
  private estimate(): Calibration {
    const w = this.win;
    const dx = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
    const dy = Math.max(0, w.outerHeight - w.innerHeight - dx);
    return { dx, dy, exact: false };
  }

  rect(): { x: number; y: number; w: number; h: number } {
    const w = this.win;
    return { x: w.screenX + this.cal.dx, y: w.screenY + this.cal.dy, w: w.innerWidth, h: w.innerHeight };
  }
}

export interface SlotClaim {
  slot: number;
  release: () => void;
}

const slotLock = (slot: number): string => `tidal-slot-${slot}`;

/**
 * Holds one of the numbered vessel slots, using a Web Lock per slot. The browser frees the lock when
 * the window goes away, however it goes away, so a held lock is the proof that a vessel still exists.
 */
export async function claimSlot(): Promise<SlotClaim> {
  for (let slot = 0; slot < MAX_VESSELS; slot++) {
    const claim = await new Promise<SlotClaim | null>((resolve) => {
      void navigator.locks.request(slotLock(slot), { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return undefined; }
        return new Promise<void>((release) => resolve({ slot, release }));
      });
    });
    if (claim) return claim;
  }
  return { slot: -1, release: () => {} };
}

export class Registry {
  readonly peers = new Map<string, VesselInfo>();
  readonly channel = new BroadcastChannel(CHANNEL);
  /** Extra vessels this window speaks for (its picture-in-picture tank). */
  readonly proxies = new Map<string, VesselInfo>();
  onChange: (() => void) | null = null;
  private lastSent = 0;
  private lastKey = '';

  constructor(readonly self: VesselInfo) {
    this.channel.addEventListener('message', (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === 'state') {
        const known = this.peers.has(m.info.id);
        this.peers.set(m.info.id, m.info);
        if (!known) { this.announce(true); this.onChange?.(); }
      } else if (m.type === 'bye') {
        if (this.peers.delete(m.id)) this.onChange?.();
      } else if (m.type === 'who') {
        this.announce(true);
      }
    });
    addEventListener('pagehide', () => this.leave());
    this.channel.postMessage({ type: 'who' } satisfies Message);
  }

  /** Publish this window's state: every frame while it changes, otherwise as a slow heartbeat. */
  announce(force = false): void {
    const s = this.self;
    s.t = clock();
    const key = `${s.x},${s.y},${s.w},${s.h},${s.visible},${s.focused},${s.slot},${s.group},${s.active}`;
    if (!force && key === this.lastKey && s.t - this.lastSent < HEARTBEAT_MS) return;
    this.lastKey = key;
    this.lastSent = s.t;
    this.channel.postMessage({ type: 'state', info: { ...s } } satisfies Message);
    for (const p of this.proxies.values()) {
      p.t = s.t;
      this.channel.postMessage({ type: 'state', info: { ...p } } satisfies Message);
    }
  }

  removeProxy(id: string): void {
    if (this.proxies.delete(id)) this.channel.postMessage({ type: 'bye', id } satisfies Message);
  }

  leave(): void {
    for (const id of this.proxies.keys()) this.channel.postMessage({ type: 'bye', id } satisfies Message);
    this.channel.postMessage({ type: 'bye', id: this.self.id } satisfies Message);
  }

  /**
   * Drops peers whose slot lock is no longer held: their window is gone, even if it never said goodbye.
   * Silence alone is not enough, because a covered window stops running timers and frames but still holds water.
   */
  async prune(): Promise<void> {
    const held = new Set((await navigator.locks.query()).held?.map((l) => l.name));
    let changed = false;
    for (const [id, p] of this.peers) {
      if (!held.has(slotLock(p.slot))) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.onChange?.();
  }

  /** Every vessel in the world, this window's included, in slot order. */
  all(): VesselInfo[] {
    return [this.self, ...this.proxies.values(), ...this.peers.values()]
      .filter((v) => v.slot >= 0 && v.active !== false)
      .sort((a, b) => a.slot - b.slot);
  }
}
