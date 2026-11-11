// Small helpers for moving AudioParams without clicks and without flooding the automation timeline.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A sample from the exponential distribution with mean 1: the wait until the next event of a Poisson process. */
export const expRand = (): number => -Math.log(1 - Math.random());

/**
 * Glides one AudioParam toward a target with `setTargetAtTime`, and only schedules when the target
 * or the time constant has moved by more than a small tolerance, so calling it every frame is cheap.
 */
export class Glide {
  private last: number;
  private lastTau = 0;

  constructor(private readonly param: AudioParam, private readonly rel: number, private readonly abs: number) {
    this.last = param.value;
  }

  to(value: number, now: number, tau: number): void {
    const last = this.last;
    const near = Math.abs(value - last) <= Math.abs(last) * this.rel + this.abs;
    if (near && tau === this.lastTau && !(value === 0 && last !== 0)) return;
    this.param.setTargetAtTime(value, now, tau);
    this.last = value;
    this.lastTau = tau;
  }
}

/** A straight-line ramp from wherever the param is right now. */
export function rampTo(p: AudioParam, value: number, now: number, seconds: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(now);
  } else {
    const v = p.value;
    p.cancelScheduledValues(now);
    p.setValueAtTime(v, now);
  }
  p.linearRampToValueAtTime(value, now + seconds);
}
