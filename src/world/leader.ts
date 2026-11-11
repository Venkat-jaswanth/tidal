// Exactly one visible window simulates. Leadership is a Web Lock: the browser hands it to the next
// waiting window the moment the holder closes, crashes or lets go.

const LOCK = 'tidal-leader';

export class Leadership {
  isLeader = false;
  onGain: (() => void) | null = null;
  onLose: (() => void) | null = null;
  private release: (() => void) | null = null;
  private waiting = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.resign();
      else this.stand();
    });
    if (document.visibilityState === 'visible') this.stand();
  }

  /** Queue for leadership. Resolves into leadership whenever the lock becomes free. */
  stand(): void {
    if (this.waiting || this.isLeader) return;
    this.waiting = true;
    this.request(false);
  }

  /**
   * Take leadership from a holder that has stopped producing frames, for instance a window that is
   * covered but was never told it is hidden. The old holder is told it lost the lock.
   */
  steal(): void {
    if (this.isLeader || document.visibilityState === 'hidden') return;
    this.request(true);
  }

  private request(steal: boolean): void {
    navigator.locks.request(LOCK, steal ? { steal: true } : {}, () => {
      this.waiting = false;
      if (document.visibilityState === 'hidden') return undefined; // went hidden while queued
      this.isLeader = true;
      this.onGain?.();
      return new Promise<void>((resolve) => { this.release = resolve; });
    }).catch(() => {
      // the lock was stolen from this window, or the request was aborted
      this.waiting = false;
      if (this.isLeader) { this.isLeader = false; this.release = null; this.onLose?.(); }
      if (document.visibilityState === 'visible') this.stand();
    });
  }

  /** Give leadership up, for instance when this window is hidden and can no longer keep the world moving. */
  resign(): void {
    if (!this.isLeader) return;
    this.isLeader = false;
    this.onLose?.();
    this.release?.();
    this.release = null;
  }
}
