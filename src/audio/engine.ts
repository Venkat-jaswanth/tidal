// Tidal's sound: the procedural mix in ./scene, driven from the world meta every frame.
// Only the leader window plays it, so the mix never doubles up across windows. Nothing is created
// until the first enable(), which must come from a user gesture.

import type { Engine } from '../engine';
import { SoundScene } from './scene';

export interface TidalAudioOptions {
  /**
   * Trim after the analysers, before the speakers. Tests use a small value to keep the machine quiet
   * while `debug.rms()` still measures the real mix. Default 1.
   */
  monitorGain?: number;
}

export interface TidalAudioDebug {
  /** RMS of the final mix, both channels. */
  rms(): number;
  /** RMS of the left and right channels. */
  rmsLeft(): number;
  rmsRight(): number;
  /** Plinks and drips played so far. */
  plinks: number;
  /** Glass strikes played so far. */
  slaps: number;
  /** The pour stream is running. */
  pouring: boolean;
}

const FADE_IN = 0.2;
const FADE_OUT = 0.05;
const MUTE_FADE = 0.08;
/** Geometry is read this often, ms; panning glides between reads. */
const GEOMETRY_MS = 50;

type ScreenWithLeft = Screen & { availLeft?: number };

export class TidalAudio {
  readonly debug: TidalAudioDebug;
  private ctx: AudioContext | null = null;
  private scene: SoundScene | null = null;
  private on = false;
  private leader = false;
  private destroyed = false;
  /** Bumped on every gate change, so a stale timer or promise does nothing. */
  private token = 0;
  private lastWall = 0;
  private lastGeometry = -Infinity;

  constructor(private readonly engine: Engine, private readonly options: TidalAudioOptions = {}) {
    const scene = (): SoundScene | null => this.scene;
    this.debug = {
      rms: () => scene()?.rms() ?? 0,
      rmsLeft: () => scene()?.rmsLeft() ?? 0,
      rmsRight: () => scene()?.rmsRight() ?? 0,
      get plinks() { return scene()?.plinks ?? 0; },
      get slaps() { return scene()?.slaps ?? 0; },
      get pouring() { return scene()?.pouring ?? false; },
    };
  }

  get enabled(): boolean { return this.on; }

  /** Call from a user gesture. Creates or resumes the AudioContext. Safe to call repeatedly. */
  async enable(): Promise<void> {
    if (this.destroyed) return;
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    this.on = true;
    this.leader = this.engine.isLeader;
    // resume() inside the gesture, before any await, unlocks the context for later resumes too
    const ready = ctx.state === 'running' ? null : ctx.resume();
    this.gate();
    if (ready) await ready.catch(() => undefined);
  }

  /** Fade out, then suspend the context. */
  disable(): void {
    this.on = false;
    this.gate();
  }

  /** Drive from the frame loop. Cheap: reads the meta, nudges params, and starts a voice only on an event. */
  update(): void {
    const ctx = this.ctx, scene = this.scene;
    if (!ctx || !scene) return;
    const leader = this.engine.isLeader;
    if (leader !== this.leader) {
      this.leader = leader;
      if (leader) scene.reset();
      this.gate();
    }
    const wall = performance.now();
    const dt = this.lastWall ? Math.min(0.1, (wall - this.lastWall) / 1000) : 1 / 60;
    this.lastWall = wall;
    if (!this.on || !leader || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (wall - this.lastGeometry >= GEOMETRY_MS) {
      this.lastGeometry = wall;
      this.readGeometry(scene, now);
    }
    scene.step(this.engine.meta, now, dt);
  }

  destroy(): void {
    this.destroyed = true;
    this.on = false;
    this.token++;
    const ctx = this.ctx;
    this.ctx = null;
    this.scene = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }

  private build(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const monitor = ctx.createGain();
    monitor.gain.value = this.options.monitorGain ?? 1;
    monitor.connect(ctx.destination);
    this.ctx = ctx;
    this.scene = new SoundScene(ctx, monitor);
  }

  /** Open the mix only when sound is on and this window leads; otherwise fade out and suspend. */
  private gate(): void {
    const ctx = this.ctx, scene = this.scene;
    if (!ctx || !scene || ctx.state === 'closed') return;
    const token = ++this.token;
    if (this.on && this.leader) {
      const open = (): void => { if (token === this.token) scene.open(ctx.currentTime, FADE_IN); };
      if (ctx.state === 'running') open();
      else ctx.resume().then(open, () => undefined);
      return;
    }
    const fade = this.on ? FADE_OUT : MUTE_FADE;
    scene.close(ctx.currentTime, fade);
    // a follower or a muted window keeps no audio thread busy
    setTimeout(() => {
      if (token === this.token && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    }, fade * 1000 + (this.on ? 400 : 80));
  }

  private readGeometry(scene: SoundScene, now: number): void {
    const scr = globalThis.screen as ScreenWithLeft | undefined;
    const left = scr?.availLeft ?? 0;
    const width = scr?.width || 1920;
    scene.beginGeometry();
    for (const v of this.engine.registry.all()) scene.setVessel(v.slot, v.x, v.w, left, width, now);
  }
}
