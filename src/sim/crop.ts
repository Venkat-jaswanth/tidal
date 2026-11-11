// Packs the part of the simulation field under one vessel into a small float16 texture.
// The leader renders its own vessel from this texture and reads the others back to send to followers.

import type { MpmSim } from './mpm';

export const CROP_PAD = 2; // cells of padding around the viewport

const packWGSL = /* wgsl */ `
struct C { origin: vec2i, grid: vec2i, gravity: vec2f, cellPx: f32, ink: f32 }
@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var<storage, read> fieldA: array<vec4f>; // density, velocity xy, speed
@group(0) @binding(2) var out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<storage, read> fieldB: array<vec4f>; // dye mix, wall distance, owner, foam

fn inGrid(p: vec2i) -> bool { return p.x >= 0 && p.y >= 0 && p.x < c.grid.x && p.y < c.grid.y; }
fn a(p: vec2i) -> vec4f { if (!inGrid(p)) { return vec4f(0.0); } return fieldA[p.y * c.grid.x + p.x]; }
fn a_(p: vec2i) -> f32 { return fieldA[p.y * c.grid.x + p.x].x; }
// foam normally; with ink, the mix between the two inks weighted by how much liquid is there
fn extraAt(p: vec2i) -> vec2f {
  if (!inGrid(p)) { return vec2f(0.0); }
  let b = fieldB[p.y * c.grid.x + p.x];
  if (c.ink > 0.5) { let m = fieldA[p.y * c.grid.x + p.x].x; return vec2f(b.x * m, m); }
  return vec2f(b.w, 1.0);
}

// r: density, smoothed where the liquid is calm so a resting surface is flat, left sharp where it is
//    fast so sheets and droplets survive
// g: depth of liquid above this cell (against gravity), px
// b: foam, or with ink the mix between the two inks (0 = first, 1 = second)
// a: speed, cells per substep
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = c.origin + vec2i(id.xy);
  let f = a(p);

  var blur = 0.0;
  var extra = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let w = (2.0 - abs(f32(i))) * (2.0 - abs(f32(j))) / 16.0;
      blur += w * a(p + vec2i(i, j)).x;
      extra += w * extraAt(p + vec2i(i, j));
    }
  }
  let density = mix(blur, f.x, smoothstep(0.06, 0.3, f.w));

  // Depth of liquid above this cell, averaged over a fan of directions around "up". A single
  // straight column would print a hard vertical edge under every overhang.
  var depth = 0.0;
  let up = -c.gravity;
  for (var a = -2; a <= 2; a++) {
    let ang = f32(a) * 0.26;
    let dir = vec2f(up.x * cos(ang) - up.y * sin(ang), up.x * sin(ang) + up.y * cos(ang));
    var d = 0.0;
    var gap = 0;
    for (var k = 1; k < 150; k++) {
      let q = p + vec2i(round(dir * f32(k)));
      if (!inGrid(q)) { break; }
      let cover = clamp((a_(q) - 0.25) * 2.0, 0.0, 1.0);
      d += cover;
      if (cover < 0.05) { gap++; if (gap > 16) { break; } } else { gap = 0; }
    }
    depth += d * (3.0 - abs(f32(a))) / 9.0;
  }
  // the part of this cell's own column above its centre
  depth += 0.5 * clamp((f.x - 0.25) * 2.0, 0.0, 1.0);

  textureStore(out, vec2i(id.xy), vec4f(density, depth * c.cellPx, extra.x / max(extra.y, 1e-4), f.w));
}
`;

export interface Crop {
  texture: GPUTexture;
  view: GPUTextureView;
  /** Grid cell of texel (0, 0). */
  cellX: number;
  cellY: number;
  width: number;
  height: number;
  uniform: GPUBuffer;
  group: GPUBindGroup;
}

const cropPipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
const cropDescriptor = (device: GPUDevice): GPUComputePipelineDescriptor => ({
  label: 'crop', layout: 'auto',
  compute: { module: device.createShaderModule({ label: 'crop', code: packWGSL }), entryPoint: 'main' },
});

/** Compiles the crop pipeline in the background, ahead of a possible promotion to leader. */
export async function warmCropPipeline(device: GPUDevice): Promise<void> {
  if (cropPipelines.has(device)) return;
  const made = await device.createComputePipelineAsync(cropDescriptor(device));
  if (!cropPipelines.has(device)) cropPipelines.set(device, made);
}

export class CropPacker {
  private readonly pipeline: GPUComputePipeline;

  constructor(
    private readonly device: GPUDevice,
    private readonly sim: MpmSim,
  ) {
    let pipeline = cropPipelines.get(device);
    if (!pipeline) { pipeline = device.createComputePipeline(cropDescriptor(device)); cropPipelines.set(device, pipeline); }
    this.pipeline = pipeline;
  }

  /** Returns a crop covering the rect (in cells), reusing `old` when its size still fits. */
  fit(old: Crop | null, x0: number, y0: number, x1: number, y1: number): Crop {
    const cellX = Math.floor(x0) - CROP_PAD;
    const cellY = Math.floor(y0) - CROP_PAD;
    const width = Math.ceil(x1) + CROP_PAD - cellX;
    const height = Math.ceil(y1) + CROP_PAD - cellY;
    if (old && old.width === width && old.height === height) {
      old.cellX = cellX; old.cellY = cellY;
      return old;
    }
    old?.texture.destroy();
    old?.uniform.destroy();
    const texture = this.device.createTexture({
      size: [width, height], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    const view = texture.createView();
    const uniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: this.sim.fieldA } },
        { binding: 2, resource: view },
        { binding: 3, resource: { buffer: this.sim.fieldB } },
      ],
    });
    return { texture, view, cellX, cellY, width, height, uniform, group };
  }

  pack(encoder: GPUCommandEncoder, crops: readonly Crop[], gravityX = 0, gravityY = 1, ink = false): void {
    if (crops.length === 0) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    const data = new ArrayBuffer(32);
    const ints = new Int32Array(data, 0, 4);
    const floats = new Float32Array(data, 16, 4);
    for (const c of crops) {
      ints.set([c.cellX, c.cellY, this.sim.config.gridW, this.sim.config.gridH]);
      floats.set([gravityX, gravityY, this.sim.config.cellPx, ink ? 1 : 0]);
      this.device.queue.writeBuffer(c.uniform, 0, data);
      pass.setBindGroup(0, c.group);
      pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
    }
    pass.end();
  }
}
