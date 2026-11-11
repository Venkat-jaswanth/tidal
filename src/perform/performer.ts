// Runs the Perform choreography. Every popup moves itself along the shared timeline, so nothing
// depends on one window holding references to the others. Any input, in any window, stops it.

import type { Engine } from '../engine';
import { clock } from '../world/registry';
import { PERFORM_SECONDS, poseAt, type Rect } from './timeline';

type PerformMessage =
  | { type: 'perform'; t0: number; roles: Record<string, number>; count: number; stage: Rect }
  | { type: 'perform-stop' };

export class Performer {
  performing = false;
  onChange: ((performing: boolean) => void) | null = null;
  /** Window moves during the last run, with the gaps between consecutive moves while in motion. */
  moveStats = { moves: 0, seconds: 0, movingGapsMs: [] as number[] };

  private run: { t0: number; role: number; count: number; stage: Rect } | null = null;
  private startedAt = 0;
  private lastPose = '';
  private lastMoveAt = 0;

  /** `restingActive` says whether this window's vessel belongs in the world when no performance is running. */
  constructor(private readonly engine: Engine, private readonly win: Window, private readonly restingActive: () => boolean = () => true) {
    engine.registry.channel.addEventListener('message', (e: MessageEvent<PerformMessage | { type: string }>) => {
      if (e.data.type === 'perform') this.begin(e.data as Extract<PerformMessage, { type: 'perform' }>);
      else if (e.data.type === 'perform-stop') this.end(false);
    });
    const interrupt = (e: Event) => {
      if (!this.performing || !e.isTrusted) return;
      if (performance.now() - this.startedAt < 350) return; // the gesture that started it
      this.stop();
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      win.addEventListener(type, interrupt, { capture: true, passive: true });
    }
    engine.frameListeners.add(() => this.tick());
  }

  /** Start a performance with the popup vessels that are open. Returns how many take part. */
  start(): number {
    const popups = this.engine.registry.all().filter((v) => v.kind === 'popup').slice(0, 3);
    if (popups.length === 0) return 0;
    const s = this.win.screen as Screen & { availLeft?: number; availTop?: number };
    const stage: Rect = { x: s.availLeft ?? 0, y: s.availTop ?? 0, w: s.availWidth, h: s.availHeight };
    const roles: Record<string, number> = {};
    popups.forEach((v, i) => { roles[v.id] = i; });
    const message: PerformMessage = { type: 'perform', t0: clock() + 250, roles, count: popups.length, stage };
    this.engine.registry.channel.postMessage(message);
    this.begin(message);
    return popups.length;
  }

  stop(): void {
    this.engine.registry.channel.postMessage({ type: 'perform-stop' } satisfies PerformMessage);
    this.end(false);
  }

  private begin(m: Extract<PerformMessage, { type: 'perform' }>): void {
    const role = m.roles[this.engine.id];
    this.run = { t0: m.t0, role: role ?? -1, count: m.count, stage: m.stage };
    this.performing = true;
    this.startedAt = performance.now();
    this.lastPose = '';
    this.lastMoveAt = 0;
    this.moveStats = { moves: 0, seconds: 0, movingGapsMs: [] };
    // a window that is not one of the performing vessels steps out of the world for the duration
    this.engine.setActive(role !== undefined);
    this.onChange?.(true);
  }

  private end(finished: boolean): void {
    if (!this.performing) return;
    this.performing = false;
    this.run = null;
    this.engine.setActive(this.restingActive());
    void finished;
    this.onChange?.(false);
  }

  private tick(): void {
    const run = this.run;
    if (!run) return;
    const t = (clock() - run.t0) / 1000;
    if (t >= PERFORM_SECONDS + 0.5) { this.end(true); return; }
    if (t < 0 || run.role < 0) return;
    const pose = poseAt(run.role, run.count, Math.min(t, PERFORM_SECONDS), run.stage);
    if (!pose) return;
    const key = `${pose.x},${pose.y}`;
    if (this.win.outerWidth !== pose.w || this.win.outerHeight !== pose.h) this.win.resizeTo(pose.w, pose.h);
    if (key !== this.lastPose) {
      this.win.moveTo(pose.x, pose.y);
      this.lastPose = key;
      const now = performance.now();
      // gaps between consecutive moves while in motion (a longer gap is a hold in the choreography)
      if (this.lastMoveAt && now - this.lastMoveAt < 120) this.moveStats.movingGapsMs.push(now - this.lastMoveAt);
      this.lastMoveAt = now;
      this.moveStats.moves++;
    }
    this.moveStats.seconds = t;
  }
}
