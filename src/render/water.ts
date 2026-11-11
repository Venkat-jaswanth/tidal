// Draws one vessel: graph paper refracted through the liquid field.

import { rgb, type LiquidLook, type Theme } from './theme';
import { waterWGSL } from './water.wgsl';

export interface ViewState {
  /** Viewport top-left in world (screen CSS) px. */
  originX: number;
  originY: number;
  /** Viewport size in CSS px. */
  width: number;
  height: number;
  dpr: number;
  time: number;
  /** World px of the field texture's texel (0, 0) corner. */
  cropX: number;
  cropY: number;
  cellPx: number;
  px2PerMl: number;
  gravityX: number;
  gravityY: number;
  /** Quality tier, 0 (everything) to 5: see `Engine.tier`. */
  tier: number;
  column: Column;
  quiet: readonly QuietZone[];
}

const UNIFORM_FLOATS = 84;

/** A rectangle of the viewport, in CSS px, where text sits. */
export interface QuietZone { x: number; y: number; w: number; h: number }

/**
 * The liquid is weakly compressible: under its own weight its density at depth d (px) below the
 * surface is rest × (1 + a·d)^(1/gamma). A tall column therefore stands a little lower than its
 * volume alone would suggest, and the graduations are drawn to match, so the scale reads true.
 */
export interface Column { a: number; gamma: number }

/** Share of the ideal height a shallow column really reaches (rest-density calibration and the hidden margin behind the glass). */
export const COLUMN_FILL = 1 / 0.95;

/** Height of a resting column whose uncompressed height would be `ideal` px. */
export function columnHeight(ideal: number, c: Column): number {
  const e = (c.gamma + 1) / c.gamma;
  return (Math.pow(1 + (e * c.a * ideal * COLUMN_FILL), 1 / e) - 1) / c.a;
}

/** Millilitres between graduations so they sit at least `minPx` apart in a vessel of this width. */
export function graduationStep(viewWidth: number, px2PerMl: number, minPx = 7): { tickMl: number; major: number } {
  const pxPerMl = px2PerMl / viewWidth;
  for (const [tickMl, major] of [[5, 10], [10, 5], [20, 5], [25, 4], [50, 4], [100, 5], [250, 4]] as const) {
    if (tickMl * pxPerMl >= minPx) return { tickMl, major };
  }
  return { tickMl: 500, major: 2 };
}

export class WaterRenderer {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniforms: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly data = new Float32Array(UNIFORM_FLOATS);
  private group: GPUBindGroup | null = null;
  private boundView: GPUTextureView | null = null;
  /** GPU time of the last measured render pass, ms (null without timestamp queries). */
  gpuMs: number | null = null;
  private readonly querySet: GPUQuerySet | null;
  private readonly queryResolve: GPUBuffer | null;
  private readonly queryRead: GPUBuffer | null;
  private queryBusy = false;
  private frames = 0;

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ label: 'water', code: waterWGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'water', layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    this.uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const timed = device.features.has('timestamp-query');
    this.querySet = timed ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
    this.queryResolve = timed ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
    this.queryRead = timed ? device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  draw(encoder: GPUCommandEncoder, target: GPUTextureView, field: GPUTextureView, view: ViewState, theme: Theme, look: LiquidLook): void {
    const d = this.data;
    const { tickMl, major } = graduationStep(view.width, view.px2PerMl);
    d[0] = Math.round(view.width * view.dpr); d[1] = Math.round(view.height * view.dpr); d[2] = view.dpr; d[3] = view.time;
    d[4] = view.originX; d[5] = view.originY; d[6] = view.width; d[7] = view.height;
    d[8] = view.cropX; d[9] = view.cropY; d[10] = view.cellPx; d[11] = view.px2PerMl;
    d[12] = view.gravityX; d[13] = view.gravityY; d[14] = tickMl; d[15] = major;
    const v4 = (i: number, c: readonly [number, number, number], w: number) => { d.set(c, 16 + i * 4); d[19 + i * 4] = w; };
    v4(0, rgb(theme.paper), theme.gridStep);
    v4(1, rgb(theme.gridFine), theme.gridFineAlpha);
    v4(2, rgb(theme.gridBold), theme.gridBoldAlpha);
    v4(3, rgb(theme.ink), theme.inkAlpha);
    v4(4, look.absorb, look.bodyOpacity);
    v4(5, rgb(look.tint), look.tintOpacity);
    v4(6, rgb(theme.highlight), theme.highlightStrength);
    v4(7, [look.refraction, look.magnification, look.dispersion], look.caustics);
    v4(8, [look.meniscus, look.mirror, look.foam], theme.glow);
    v4(9, [theme.boldEvery, theme.fineWidth, theme.boldWidth], theme.grain);
    v4(10, rgb(look.inkB ?? look.tint), look.inkB ? 1 : 0);
    d[59] = look.inkB ? 1 : (look.metal ?? 0) > 0 ? -(look.metal ?? 0) : 0; // > 0: two inks; < 0: metal amount
    // quality ladder, rungs 3 to 5: cheaper refraction, then no caustics, then no foam
    for (let i = 0; i < 4; i++) {
      const z = view.quiet[i];
      d.set(z ? [z.x, z.y, z.x + z.w, z.y + z.h] : [0, 0, 0, 0], 68 + i * 4);
    }
    d[64] = view.column.a; d[65] = view.column.gamma; d[66] = COLUMN_FILL; d[67] = 0;
    d[60] = view.tier >= 3 ? 0 : 1; d[61] = view.tier >= 4 ? 0 : 1; d[62] = view.tier >= 5 ? 0 : 1; d[63] = 0;
    this.device.queue.writeBuffer(this.uniforms, 0, d);

    if (this.boundView !== field) {
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: field },
          { binding: 2, resource: this.sampler },
        ],
      });
      this.boundView = field;
    }
    // time one frame in eight, when the previous reading has been collected
    const measure = this.querySet !== null && !this.queryBusy && (this.frames++ & 7) === 0;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      ...(measure ? { timestampWrites: { querySet: this.querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group!);
    pass.draw(3);
    pass.end();
    if (measure) {
      this.queryBusy = true;
      encoder.resolveQuerySet(this.querySet!, 0, 2, this.queryResolve!, 0);
      encoder.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 16);
      void this.device.queue.onSubmittedWorkDone().then(() => this.queryRead!.mapAsync(GPUMapMode.READ)).then(() => {
        const t = new BigUint64Array(this.queryRead!.getMappedRange());
        this.gpuMs = Number(t[1]! - t[0]!) / 1e6;
        this.queryRead!.unmap();
      }).catch(() => {}).finally(() => { this.queryBusy = false; });
    }
  }
}
