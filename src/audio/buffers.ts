// Every sound in Tidal starts from one of these few buffers, made once when the graph is built.

/** Looping noise normalised to `rms`: pink when `pink` is set, white otherwise. The loop seam is cross-faded. */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, pink: boolean, rms: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const fade = Math.floor(0.05 * sr);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  // run the pink filter for a while first so its slow poles have settled
  for (let i = -8192; i < n + fade; i++) {
    const w = Math.random() * 2 - 1;
    let v = w;
    if (pink) {
      // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    if (i >= 0) raw[i] = v;
  }
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, n));
  // the sample after the last one is raw[n], so blend the head in from the tail's continuation
  for (let i = 0; i < fade; i++) {
    const th = (i / fade) * (Math.PI / 2);
    out[i] = raw[i]! * Math.sin(th) + raw[n + i]! * Math.cos(th);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i]!;
  mean /= n;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = out[i]! - mean; out[i] = v; sum += v * v; }
  const k = rms / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  return buf;
}

/**
 * Smooth random movement in [-1, 1] for modulating parameters: value noise with `rate` knots per second
 * plus a finer layer on top. It loops without a seam. Kept at a low sample rate because it is slow.
 */
export function wobbleBuffer(ctx: BaseAudioContext, seconds: number, rate: number): AudioBuffer {
  const sr = 8000;
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  layer(out, Math.max(2, Math.round(seconds * rate)), 0.75);
  layer(out, Math.max(2, Math.round(seconds * rate * 2.7)), 0.35);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const buf = ctx.createBuffer(1, n, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = out[i]! / peak;
  return buf;
}

function layer(out: Float32Array, knots: number, amp: number): void {
  const k = new Float32Array(knots);
  for (let i = 0; i < knots; i++) k[i] = Math.random() * 2 - 1;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const pos = (i / n) * knots;
    const j = Math.floor(pos);
    const s = (1 - Math.cos(Math.PI * (pos - j))) / 2;
    out[i] = out[i]! + amp * (k[j % knots]! * (1 - s) + k[(j + 1) % knots]! * s);
  }
}

/** Short ticks of band-passed noise (about 8 ms, envelope included), from dull to bright. */
export function clickBuffers(ctx: BaseAudioContext, count: number): AudioBuffer[] {
  const sr = ctx.sampleRate;
  const n = Math.round(0.008 * sr);
  const list: AudioBuffer[] = [];
  for (let c = 0; c < count; c++) {
    const u = count > 1 ? c / (count - 1) : 0.5;
    const f = 2500 * Math.pow(2.6, u);
    const tau = 0.0012 - 0.0007 * u;
    // RBJ band-pass, 0 dB peak
    const w0 = (2 * Math.PI * f) / sr;
    const alpha = Math.sin(w0) / (2 * 0.9);
    const a0 = 1 + alpha, a1 = -2 * Math.cos(w0) / a0, a2 = (1 - alpha) / a0, b0 = alpha / a0, b2 = -alpha / a0;
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = (Math.random() * 2 - 1) * (1 - Math.exp(-t / 0.00015)) * Math.exp(-t / tau);
      const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      d[i] = y;
      peak = Math.max(peak, Math.abs(y));
    }
    const tail = Math.round(0.001 * sr);
    for (let i = 0; i < n; i++) d[i] = (d[i]! / peak) * Math.min(1, (n - 1 - i) / tail);
    list.push(buf);
  }
  return list;
}
