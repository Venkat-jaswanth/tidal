// Runs the Perform choreography. Every popup moves itself along the shared timeline, so nothing
// depends on one window holding references to the others. Any input, in any window, stops it.

import type { Engine } from '../engine';
import { clock } from '../world/registry';
import { HERO_SECONDS, PERFORM_SECONDS, heroPoseAt, poseAt, type Rect } from './timeline';

type PerformMessage =
  | { type: 'perform'; t0: number; roles: Record<string, number>; count: number; stage: Rect; program: Program; locked: boolean }
  | { type: 'perform-stop' };

/** 'perform' is the choreography behind the Perform control; 'film' is the two-vessel launch film. */
export type Program = 'perform' | 'film';

export class Performer {
  performing = false;
  onChange: ((performing: boolean) => void) | null = null;
  /** Window moves during the last run, with the gaps between consecutive moves while in motion. */
  moveStats = { moves: 0, seconds: 0, movingGapsMs: [] as number[] };

  private run: { t0: number; role: number; count: number; stage: Rect; program: Program; locked: boolean } | null = null;
  /** The run in progress, for a window that joins late and needs to know where to stand. */
  get current(): { t0: number; stage: Rect; program: Program } | null { return this.run; }
  private startedAt = 0;
  private lastPose = '';
  private lastMoveAt = 0;

  /** `restingActive` says whether this window's vessel belongs in the world when no performance is running. */
  constructor(private readonly engine: Engine, private readonly win: Window, private readonly restingActive: () => boolean = () => true) {
    engine.registry.channel.addEventListener('message', (e: MessageEvent<PerformMessage | { type: string }>) => {
      if (e.data.type === 'perform') this.begin(e.data as Extract<PerformMessage, { type: 'perform' }>);
      else if (e.data.type === 'perform-stop') this.end(false);
      else if (e.data.type === 'perform-join') {
        const j = e.data as unknown as { id: string; role: number; t0: number; stage: Rect; program: Program; locked: boolean };
        if (j.id === this.engine.id) this.begin({ type: 'perform', t0: j.t0, roles: { [j.id]: j.role }, count: 2, stage: j.stage, program: j.program, locked: j.locked });
      }
    });
    const interrupt = (e: Event) => {
      if (!this.performing || !e.isTrusted || this.run?.locked) return;
      if (performance.now() - this.startedAt < 350) return; // the gesture that started it
      this.stop();
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      win.addEventListener(type, interrupt, { capture: true, passive: true });
    }
    engine.frameListeners.add(() => this.tick());
  }

  /**
   * Start a performance with the popup vessels that are open. Returns how many take part.
   * `locked` makes it ignore input (used when filming, where clicks set up the recording).
   * For the film, `roles` may name a vessel that has not opened yet.
   */
  start(program: Program = 'perform', locked = false, extraRoles: Record<string, number> = {}): number {
    const popups = this.engine.registry.all().filter((v) => v.kind === 'popup').slice(0, program === 'film' ? 2 : 3);
    if (popups.length === 0) return 0;
    const s = this.win.screen as Screen & { availLeft?: number; availTop?: number };
    const stage: Rect = { x: s.availLeft ?? 0, y: s.availTop ?? 0, w: s.availWidth, h: s.availHeight };
    const roles: Record<string, number> = { ...extraRoles };
    popups.forEach((v, i) => { roles[v.id] = i; });
    const message: PerformMessage = { type: 'perform', t0: clock() + 250, roles, count: popups.length, stage, program, locked };
    this.engine.registry.channel.postMessage(message);
    this.begin(message);
    return popups.length;
  }

  /** Give a vessel that opened during a run its role in it (the film's second vessel). */
  join(id: string, role: number): void {
    const run = this.run;
    if (!run) return;
    this.engine.registry.channel.postMessage({ type: 'perform-join', id, role, t0: run.t0, stage: run.stage, program: run.program, locked: run.locked });
  }

  stop(): void {
    this.engine.registry.channel.postMessage({ type: 'perform-stop' } satisfies PerformMessage);
    this.end(false);
  }

  private begin(m: Extract<PerformMessage, { type: 'perform' }>): void {
    const role = m.roles[this.engine.id];
    this.run = { t0: m.t0, role: role ?? -1, count: m.count, stage: m.stage, program: m.program, locked: m.locked };
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
    const length = run.program === 'film' ? HERO_SECONDS : PERFORM_SECONDS;
    if (t >= length + 0.5) { this.end(true); return; }
    if (t < 0 || run.role < 0) return;
    const pose = run.program === 'film' ? heroPoseAt(run.role, Math.min(t, length), run.stage) : poseAt(run.role, run.count, Math.min(t, length), run.stage);
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
