// Leader to followers: per-vessel field crops, per-frame world meta, and particle snapshots.
// One payload format, two carriers. Windows that share the leader's memory block (the popups it or
// its opener created) read crops straight out of a SharedArrayBuffer; any other window, such as a
// tab opened by hand, gets the same bytes copied over a BroadcastChannel.

import { MAX_VESSELS } from '../world/registry';

export const DATA_CHANNEL = 'tidal-data';
const MAGIC = 0x7469646c;
const SLOT_BYTES = 640 * 1024;            // a 1920×1080 vessel at 6 px cells and 8 bytes per texel is 461 KB
const SLOT_HEAD = 16;                     // Int32 fields per slot
const SNAP_MAX_PARTICLES = 200_000;
export const SNAP_STRIDE = 12;            // bytes per particle in a snapshot
const SNAP_HEAD = 16;                     // Int32 fields
const HEAD_INTS = 8 + MAX_VESSELS * SLOT_HEAD + SNAP_HEAD;
const HEAD_BYTES = HEAD_INTS * 4;
const SNAP_OFFSET = HEAD_BYTES + MAX_VESSELS * SLOT_BYTES;
const BLOCK_BYTES = SNAP_OFFSET + SNAP_MAX_PARTICLES * SNAP_STRIDE;

export interface CropHeader {
  frame: number;
  /** Grid cell of texel (0, 0). */
  cellX: number;
  cellY: number;
  width: number;
  height: number;
  /** World px of the vessel's viewport as it was simulated for this crop. */
  rectX: number;
  rectY: number;
}

export interface FrameMeta {
  type: 'meta';
  leader: string;
  frame: number;
  /** Leader's clock, ms. */
  t: number;
  /** World px of grid cell (0, 0). */
  originX: number;
  originY: number;
  cellPx: number;
  liquid: string;
  gravityX: number;
  gravityY: number;
  /** Millilitres per vessel slot. */
  ml: number[];
  /** Millilitres falling as rain. */
  rainMl: number;
  /** Mean squared speed of each vessel's liquid, per slot (0 at rest, around 0.01 in a hard slosh). */
  energy: number[];
  /** Wall-slap strength per slot this frame (0 when nothing hits the glass). */
  impact: number[];
  /** Liquid moving between vessels, mL per second. */
  flow: number;
}

export interface SnapshotHeader {
  frame: number;
  t: number;
  count: number;
  originX: number;
  originY: number;
  gridW: number;
  gridH: number;
  restDensity: number;
  liquid: string;
}

export interface Snapshot extends SnapshotHeader {
  /** SNAP_STRIDE bytes per particle: u16 x, y (cells × 64), i16 vx, vy (× 32767), u16 dye rgb565, u8 owner, u8 rain. */
  data: Uint8Array;
}

type DataMessage =
  | FrameMeta
  | { type: 'crop'; to: string; head: CropHeader; data: ArrayBuffer }
  | ({ type: 'snapshot'; data: ArrayBuffer } & SnapshotHeader);

const LIQUIDS = ['water', 'mercury', 'honey', 'ink'];

export class Transport {
  readonly channel = new BroadcastChannel(DATA_CHANNEL);
  /** Identifies the shared block; '' when this window has none. */
  group = '';
  meta: FrameMeta | null = null;
  onMeta: ((m: FrameMeta) => void) | null = null;
  private sab: SharedArrayBuffer | null = null;
  private ints: Int32Array | null = null;
  private bytes: Uint8Array | null = null;
  private readonly lastSeq = new Int32Array(MAX_VESSELS).fill(-1);
  private readonly inbox = new Map<number, { head: CropHeader; data: Uint8Array }>();
  private snapshot: Snapshot | null = null;
  private readonly aliases = new Map<string, number>();

  /** Also accept crops addressed to another vessel this window draws. */
  listenFor(id: string, slot: number): void { this.aliases.set(id, slot); }
  stopListening(id: string): void { this.aliases.delete(id); }

  constructor(private readonly selfId: string, private readonly selfSlot: () => number) {
    this.channel.addEventListener('message', (e: MessageEvent<DataMessage>) => {
      const m = e.data;
      if (m.type === 'meta') { this.meta = m; this.onMeta?.(m); }
      else if (m.type === 'crop') {
        const slot = m.to === this.selfId ? this.selfSlot() : this.aliases.get(m.to);
        if (slot !== undefined) this.inbox.set(slot, { head: m.head, data: new Uint8Array(m.data) });
      }
      else if (m.type === 'snapshot') {
        const { data, type: _type, ...head } = m;
        if (!this.snapshot || head.frame > this.snapshot.frame || head.t > this.snapshot.t) this.snapshot = { ...head, data: new Uint8Array(data) };
      }
    });
  }

  /** The shared block, for handing to a popup or picture-in-picture window. */
  get shared(): SharedArrayBuffer | null { return this.sab; }

  /** Create the shared block (first window of a group). Returns false when the page is not cross-origin isolated. */
  create(): boolean {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return false;
    this.adopt(new SharedArrayBuffer(BLOCK_BYTES), true);
    return true;
  }

  /** Use a block received from the opener. */
  adopt(sab: SharedArrayBuffer, fresh = false): void {
    this.sab = sab;
    this.ints = new Int32Array(sab, 0, HEAD_INTS);
    this.bytes = new Uint8Array(sab);
    if (fresh) {
      this.ints[0] = MAGIC;
      this.ints[1] = (Math.random() * 0x7fffffff) | 0;
    }
    this.group = this.ints[0] === MAGIC ? `g${this.ints[1]}` : '';
    if (!this.group) { this.sab = null; this.ints = null; this.bytes = null; }
  }

  // ---- leader side ----

  sendMeta(meta: FrameMeta): void {
    this.meta = meta;
    this.channel.postMessage(meta);
  }

  /** Deliver one vessel's crop. `rows` are tightly packed: width × height × 8 bytes. */
  sendCrop(targetId: string, targetSlot: number, targetGroup: string, head: CropHeader, rows: Uint8Array): void {
    if (this.ints && this.bytes && targetGroup === this.group && rows.byteLength <= SLOT_BYTES && targetSlot >= 0 && targetSlot < MAX_VESSELS) {
      const h = 8 + targetSlot * SLOT_HEAD;
      Atomics.add(this.ints, h, 1); // odd while writing
      this.ints[h + 1] = head.frame; this.ints[h + 2] = head.cellX; this.ints[h + 3] = head.cellY;
      this.ints[h + 4] = head.width; this.ints[h + 5] = head.height;
      this.ints[h + 6] = Math.round(head.rectX * 16); this.ints[h + 7] = Math.round(head.rectY * 16);
      this.bytes.set(rows, HEAD_BYTES + targetSlot * SLOT_BYTES);
      Atomics.add(this.ints, h, 1);
      return;
    }
    const copy = rows.slice().buffer;
    this.channel.postMessage({ type: 'crop', to: targetId, head, data: copy } satisfies DataMessage);
  }

  /** Publish a particle snapshot. Shared memory takes every one; other windows get it over the channel when `broadcast` is set. */
  sendSnapshot(head: SnapshotHeader, data: Uint8Array, broadcast: boolean): void {
    this.snapshot = { ...head, data };
    if (this.ints && this.bytes && head.count <= SNAP_MAX_PARTICLES) {
      const h = 8 + MAX_VESSELS * SLOT_HEAD;
      const f = new Float64Array(6);
      f[0] = head.t; f[1] = head.originX; f[2] = head.originY; f[3] = head.restDensity;
      Atomics.add(this.ints, h, 1);
      this.ints[h + 1] = head.frame; this.ints[h + 2] = head.count; this.ints[h + 3] = head.gridW; this.ints[h + 4] = head.gridH;
      this.ints[h + 5] = Math.max(0, LIQUIDS.indexOf(head.liquid));
      new Uint8Array(this.sab!, (h + 8) * 4, 32).set(new Uint8Array(f.buffer, 0, 32));
      this.bytes.set(data.subarray(0, head.count * SNAP_STRIDE), SNAP_OFFSET);
      Atomics.add(this.ints, h, 1);
    }
    if (broadcast) this.channel.postMessage({ type: 'snapshot', ...head, data: data.slice(0, head.count * SNAP_STRIDE).buffer } satisfies DataMessage);
  }

  // ---- follower side ----

  /** The newest crop for a slot, or null if nothing new arrived since the last call. */
  takeCrop(slot: number): { head: CropHeader; data: Uint8Array } | null {
    if (this.ints && this.bytes && slot >= 0 && slot < MAX_VESSELS) {
      const h = 8 + slot * SLOT_HEAD;
      const seq = Atomics.load(this.ints, h);
      if (seq !== this.lastSeq[slot] && (seq & 1) === 0 && seq > 0) {
        const head: CropHeader = { frame: this.ints[h + 1]!, cellX: this.ints[h + 2]!, cellY: this.ints[h + 3]!, width: this.ints[h + 4]!, height: this.ints[h + 5]!, rectX: this.ints[h + 6]! / 16, rectY: this.ints[h + 7]! / 16 };
        const size = head.width * head.height * 8;
        const start = HEAD_BYTES + slot * SLOT_BYTES;
        const data = this.bytes.slice(start, start + size); // private copy, so a later write cannot tear it
        if (Atomics.load(this.ints, h) === seq) {
          this.lastSeq[slot] = seq;
          this.inbox.delete(slot);
          return { head, data };
        }
      }
    }
    const boxed = this.inbox.get(slot);
    if (boxed) { this.inbox.delete(slot); return boxed; }
    return null;
  }

  /** The latest particle snapshot this window knows of, from shared memory or the channel, whichever is newer. */
  latestSnapshot(): Snapshot | null {
    let best = this.snapshot;
    if (this.ints && this.bytes) {
      const h = 8 + MAX_VESSELS * SLOT_HEAD;
      for (let attempt = 0; attempt < 3; attempt++) {
        const seq = Atomics.load(this.ints, h);
        if (seq === 0 || (seq & 1) === 1) continue;
        const f = new Float64Array(new Uint8Array(this.sab!, (h + 8) * 4, 32).slice().buffer);
        const count = this.ints[h + 2]!;
        const snap: Snapshot = {
          frame: this.ints[h + 1]!, t: f[0]!, count, originX: f[1]!, originY: f[2]!,
          gridW: this.ints[h + 3]!, gridH: this.ints[h + 4]!, restDensity: f[3]!,
          liquid: LIQUIDS[this.ints[h + 5]!] ?? 'water',
          data: this.bytes.slice(SNAP_OFFSET, SNAP_OFFSET + count * SNAP_STRIDE),
        };
        if (Atomics.load(this.ints, h) !== seq) continue;
        if (!best || snap.t >= best.t) best = snap;
        break;
      }
    }
    return best;
  }
}
