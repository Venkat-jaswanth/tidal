// Compact particle snapshots: 12 bytes per particle instead of 64.
// Every window keeps the latest one, so a new leader can pick the world up where the old one left it.

import { PARTICLE_BYTES } from '../sim/shaders';
import { SNAP_STRIDE } from './transport';

const POS_SCALE = 64;      // 1/64 cell
const VEL_SCALE = 32767;   // velocities are at most ~1 cell per substep

/** Pack `count` particles (PARTICLE_BYTES each) at world time `time` (s). */
export function encodeSnapshot(particles: ArrayBuffer, count: number, time: number): Uint8Array {
  const f = new Float32Array(particles);
  const u = new Uint32Array(particles);
  const out = new Uint8Array(count * SNAP_STRIDE);
  const v = new DataView(out.buffer);
  const stride = PARTICLE_BYTES / 4;
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const b = i * SNAP_STRIDE;
    v.setUint16(b, Math.max(0, Math.min(65535, Math.round(f[o]! * POS_SCALE))), true);
    v.setUint16(b + 2, Math.max(0, Math.min(65535, Math.round(f[o + 1]! * POS_SCALE))), true);
    v.setInt16(b + 4, Math.round(Math.max(-1, Math.min(1, f[o + 2]!)) * VEL_SCALE), true);
    v.setInt16(b + 6, Math.round(Math.max(-1, Math.min(1, f[o + 3]!)) * VEL_SCALE), true);
    const r = Math.round(Math.max(0, Math.min(1, f[o + 8]!)) * 31);
    const g = Math.round(Math.max(0, Math.min(1, f[o + 9]!)) * 63);
    const bl = Math.round(Math.max(0, Math.min(1, f[o + 10]!)) * 31);
    v.setUint16(b + 8, (r << 11) | (g << 5) | bl, true);
    out[b + 10] = Math.min(255, u[o + 12]!);
    const state = f[o + 11]!;
    out[b + 11] = state > 0 ? Math.max(1, Math.min(255, Math.ceil((state - time) * 100))) : 0;
  }
  return out;
}

/** Unpack into solver particles. Rain keeps its remaining hold time, measured from `time`. */
export function decodeSnapshot(data: Uint8Array, count: number, time: number, restDensity: number): ArrayBuffer {
  const out = new ArrayBuffer(count * PARTICLE_BYTES);
  const f = new Float32Array(out);
  const u = new Uint32Array(out);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stride = PARTICLE_BYTES / 4;
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const b = i * SNAP_STRIDE;
    f[o] = v.getUint16(b, true) / POS_SCALE;
    f[o + 1] = v.getUint16(b + 2, true) / POS_SCALE;
    f[o + 2] = v.getInt16(b + 4, true) / VEL_SCALE;
    f[o + 3] = v.getInt16(b + 6, true) / VEL_SCALE;
    const c = v.getUint16(b + 8, true);
    f[o + 8] = (c >> 11) / 31; f[o + 9] = ((c >> 5) & 63) / 63; f[o + 10] = (c & 31) / 31;
    const rain = data[b + 11]!;
    f[o + 11] = rain > 0 ? time + rain / 100 : 0;
    u[o + 12] = data[b + 10]!;
    f[o + 13] = restDensity;
  }
  return out;
}
