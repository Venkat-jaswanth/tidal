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

  var depth = 0.0;
  var gap = 0;
  let dir = -c.gravity;
  for (var k = 1; k < 200; k++) {
    let q = p + vec2i(round(dir * f32(k)));
    if (!inGrid(q)) { break; }
    let cover = clamp((a(q).x - 0.25) * 2.0, 0.0, 1.0);
    depth += cover;
    if (cover < 0.05) { gap++; if (gap > 5) { break; } } else { gap = 0; }
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

export class CropPacker {
  private readonly pipeline: GPUComputePipeline;

  constructor(
    private readonly device: GPUDevice,
    private readonly sim: MpmSim,
  ) {
    this.pipeline = device.createComputePipeline({
      label: 'crop', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'crop', code: packWGSL }), entryPoint: 'main' },
    });
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
