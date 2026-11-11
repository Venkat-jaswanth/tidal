// WGSL for the 2D MLS-MPM (APIC) solver.
// Units: lengths in grid cells, time in substeps (dt = 1), so velocities are cells per substep.

export const MAX_RECTS = 24;
export const CELL_STRIDE = 4; // i32 per cell: momentum x, momentum y, mass, dye
export const PARTICLE_BYTES = 64;

const common = /* wgsl */ `
const MAX_RECTS = ${MAX_RECTS}u;
const STRIDE = ${CELL_STRIDE}u;
const FP = 4194304.0; // 2^22 fixed point: WGSL has no float atomics

struct Rect {
  box: vec4f,  // min.xy, max.xy in cells
  vel: vec4f,  // wall velocity xy (cells/substep), carry shift xy (cells, applied once per frame)
  info: vec4f, // owner window index, kind (0 window, 1 bridge), rain weight, unused
}

struct Params {
  grid: vec4u,   // grid width, grid height, particle count, rect count
  region: vec4u, // active region origin xy, size xy (cells)
  g: vec4f,      // gravity xy, stiffness, rest density
  mat: vec4f,    // viscosity, eos exponent, max speed, velocity damping per substep
  misc: vec4f,   // time (s), rain active, dye mix rate, seed
  misc2: vec4f,  // cohesion (max negative pressure), wall friction, wall margin, unused
  rects: array<Rect, MAX_RECTS>,
}

struct Particle {
  pos: vec2f,
  vel: vec2f,
  C: vec4f,     // APIC affine matrix, column major
  dye: vec3f,
  state: f32,   // 0 = live, > 0 = held as rain until this time (s)
  win: u32,     // owner window index
  density: f32, // gathered from the grid on the previous substep
  p1: u32, p2: u32,
}

@group(0) @binding(0) var<uniform> P: Params;

fn enc(v: f32) -> i32 { return i32(v * FP); }
fn dec(v: i32) -> f32 { return f32(v) / FP; }

fn cellIndex(c: vec2i) -> i32 {
  if (c.x < 0 || c.y < 0 || c.x >= i32(P.grid.x) || c.y >= i32(P.grid.y)) { return -1; }
  return (c.y * i32(P.grid.x) + c.x) * i32(STRIDE);
}

fn sdBox(p: vec2f, b: vec4f) -> f32 {
  let d = abs(p - (b.xy + b.zw) * 0.5) - (b.zw - b.xy) * 0.5;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

// Signed distance to the union of vessel rects (negative inside), and the index of the nearest rect.
fn sdUnion(p: vec2f) -> vec2f {
  var best = 1e9;
  var bi = 0.0;
  for (var i = 0u; i < P.grid.w; i++) {
    let d = sdBox(p, P.rects[i].box);
    if (d < best) { best = d; bi = f32(i); }
  }
  return vec2f(best, bi);
}

// Which vessel a point belongs to, given the rect nearest to it.
fn ownerOf(pos: vec2f, ri: u32) -> u32 {
  let r = P.rects[ri];
  if (r.info.y < 0.5) { return u32(r.info.x); }
  // inside a bridge: belongs to the nearest real vessel
  var best = 1e9;
  var owner = 0u;
  for (var i = 0u; i < P.grid.w; i++) {
    if (P.rects[i].info.y > 0.5) { continue; }
    let d = sdBox(pos, P.rects[i].box);
    if (d < best) { best = d; owner = u32(P.rects[i].info.x); }
  }
  return owner;
}

fn quadWeights(d: vec2f) -> array<vec2f, 3> {
  return array<vec2f, 3>(
    0.5 * (0.5 - d) * (0.5 - d),
    0.75 - d * d,
    0.5 * (0.5 + d) * (0.5 + d),
  );
}

fn hash(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand(x: u32) -> f32 { return f32(hash(x) >> 8u) / 16777216.0; }
`;

export const commonWGSL = common;

// Applied once per frame: carries water with a vessel for the part of its motion that exceeds the wall speed clamp.
export const carryWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.grid.z) { return; }
  let w = particles[id.x].win;
  for (var i = 0u; i < P.grid.w; i++) {
    let r = P.rects[i];
    if (r.info.y < 0.5 && u32(r.info.x) == w) {
      particles[id.x].pos += r.vel.zw;
      break;
    }
  }
}
`;

const p2g = (dye: boolean) => /* wgsl */ `${common}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> cells: array<atomic<i32>>;

// One scatter pass. The stress uses the density the particle gathered on the previous substep,
// which saves a whole second pass over the particles.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.grid.z) { return; }
  let p = particles[id.x];
  if (p.state > 0.0) { return; }
  let base = floor(p.pos);
  let w = quadWeights(p.pos - (base + 0.5));
  let C = mat2x2f(p.C.xy, p.C.zw);

  let density = select(P.g.w, p.density, p.density > 1e-3);
  let volume = 1.0 / density;
  // Tait equation of state, clamped so the free surface does not clump.
  let pressure = max(-P.misc2.x, P.g.z * (pow(density / P.g.w, P.mat.y) - 1.0));
  let stress = mat2x2f(-pressure, 0.0, 0.0, -pressure) + P.mat.x * (C + transpose(C));
  let term = -volume * 4.0 * stress;

  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let c = vec2i(base) + vec2i(gx - 1, gy - 1);
      let ci = cellIndex(c);
      if (ci < 0) { continue; }
      let weight = w[gx].x * w[gy].y;
      let dist = (vec2f(c) + 0.5) - p.pos;
      let mv = weight * (p.vel + C * dist + term * dist);
      atomicAdd(&cells[ci + 0], enc(mv.x));
      atomicAdd(&cells[ci + 1], enc(mv.y));
      atomicAdd(&cells[ci + 2], enc(weight));
      ${dye ? 'atomicAdd(&cells[ci + 3], enc(weight * p.dye.x));' : ''}
    }
  }
}
`;

// Applied once when ink is poured in: each vessel's liquid takes that vessel's ink (dye.x is the mix between the two inks).
export const recolorWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.grid.z) { return; }
  particles[id.x].dye = vec3f(f32(particles[id.x].win % 2u), 0.0, 0.0);
}
`;

export const p2gWGSL = p2g(false);
export const p2gDyeWGSL = p2g(true);

export const gridWGSL = /* wgsl */ `${common}
@group(0) @binding(2) var<storage, read_write> cells: array<i32>;
@group(0) @binding(3) var<storage, read_write> fieldA: array<vec4f>; // mass / rest density, velocity xy, speed
@group(0) @binding(4) var<storage, read_write> fieldB: array<vec4f>; // dye mix, wall distance, owner, foam

const BAND = 1.5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.region.z || id.y >= P.region.w) { return; }
  let c = vec2i(P.region.xy + id.xy);
  let ci = cellIndex(c);
  if (ci < 0) { return; }
  let fi = ci / i32(STRIDE);
  let mass = dec(cells[ci + 2]);
  // This pass leaves the cell empty for the next substep's scatter, so no separate clear pass is needed.
  let momentum = vec2f(dec(cells[ci + 0]), dec(cells[ci + 1]));
  let dyeMass = dec(cells[ci + 3]);
  for (var k = 0; k < 4; k++) { cells[ci + k] = 0; }
  if (mass <= 0.0 || c.x < 1 || c.y < 1 || c.x >= i32(P.grid.x) - 1 || c.y >= i32(P.grid.y) - 1) {
    fieldA[fi] = vec4f(0.0);
    fieldB[fi] = vec4f(0.0);
    return;
  }
  var v = momentum / mass;
  v += P.g.xy;

  let x = vec2f(c) + 0.5;
  let s = sdUnion(x);
  if (s.x > -BAND) {
    let e = 0.5;
    let grad = vec2f(
      sdUnion(x + vec2f(e, 0.0)).x - sdUnion(x - vec2f(e, 0.0)).x,
      sdUnion(x + vec2f(0.0, e)).x - sdUnion(x - vec2f(0.0, e)).x,
    );
    let wallV = P.rects[u32(s.y)].vel.xy;
    var vr = v - wallV;
    let gl = length(grad);
    if (gl > 1e-5) {
      let n = grad / gl; // points out of the fluid domain
      let vn = dot(vr, n);
      if (vn > 0.0) { vr = (vr - vn * n) * (1.0 - P.misc2.y); }
    }
    v = vr + wallV;
  }
  let sp = length(v);
  if (sp > P.mat.z) { v *= P.mat.z / sp; }

  // Foam: made where the flow is fast and rotating, then lingers and fades over about half a second.
  let gw = i32(P.grid.x);
  let curl = 0.5 * ((fieldA[fi + 1].z - fieldA[fi - 1].z) - (fieldA[fi + gw].y - fieldA[fi - gw].y));
  // only fast, rotating flow aerates; the air is gone again in about a second
  let churn = smoothstep(0.05, 0.18, abs(curl)) * smoothstep(0.22, 0.55, sp);
  let foam = max(fieldB[fi].w * 0.995, churn);

  fieldA[fi] = vec4f(mass / P.g.w, v, sp);
  // dye mix, distance to the nearest wall and the owning vessel: particles deep inside read these
  // instead of searching the vessel rects themselves
  fieldB[fi] = vec4f(dyeMass / mass, s.x, f32(ownerOf(x, u32(s.y))), foam);
}
`;

export const g2pWGSL = /* wgsl */ `${common}
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> fieldA: array<vec4f>; // density / rest, velocity xy, speed
@group(0) @binding(4) var<storage, read_write> fieldB: array<vec4f>; // dye mix, wall distance, owner, foam
@group(0) @binding(5) var<storage, read_write> counters: array<atomic<u32>>; // per window, [MAX_RECTS] = rain in transit, [MAX_RECTS + 1] = blow-ups,
// then 16 slots of kinetic energy and 16 of wall impact, per owner (fixed point, x256)

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.grid.z) { return; }
  var p = particles[id.x];

  if (p.state > 0.0) {
    if (P.misc.x >= p.state) { p.state = 0.0; particles[id.x] = p; }
    atomicAdd(&counters[MAX_RECTS], 1u);
    return;
  }

  let base = floor(p.pos);
  let w = quadWeights(p.pos - (base + 0.5));
  var v = vec2f(0.0);
  var B = mat2x2f(0.0, 0.0, 0.0, 0.0);
  var dyeSum = vec3f(0.0);
  var massSum = 0.0;
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      let c = vec2i(base) + vec2i(gx - 1, gy - 1);
      let ci = cellIndex(c);
      if (ci < 0) { continue; }
      let weight = w[gx].x * w[gy].y;
      let dist = (vec2f(c) + 0.5) - p.pos;
      let cell = fieldA[ci / i32(STRIDE)];
      let wv = weight * cell.yz;
      v += wv;
      B += mat2x2f(wv * dist.x, wv * dist.y);
      let m = cell.x * P.g.w;
      dyeSum += weight * vec3f(fieldB[ci / i32(STRIDE)].x * m, 0.0, 0.0);
      massSum += weight * m;
    }
  }
  v *= P.mat.w;
  let sp = length(v);
  if (sp > P.mat.z) { v *= P.mat.z / sp; }
  p.vel = v;
  p.C = vec4f(B[0], B[1]) * 4.0;
  // Density for the next substep's stress: what the grid holds here now, advanced by the
  // continuity equation (trace of C is the velocity divergence). Using it un-advanced lags
  // the pressure by a substep, which is unstable at any timestep.
  p.density = massSum * clamp(1.0 - (p.C.x + p.C.w), 0.8, 1.25);
  p.pos += v;
  if (massSum > 1e-4) { p.dye = mix(p.dye, dyeSum / massSum, P.misc.z); }

  // A non-finite position means the solver blew up: park the particle and count it.
  if (!(abs(p.pos.x) < 1e6 && abs(p.pos.y) < 1e6)) {
    let r0 = P.rects[0];
    p.pos = (r0.box.xy + r0.box.zw) * 0.5;
    p.vel = vec2f(0.0);
    p.C = vec4f(0.0);
    atomicAdd(&counters[MAX_RECTS + 1u], 1u);
  }

  // Deep inside a vessel there is nothing to clamp, and the grid already knows the owner.
  let here = cellIndex(vec2i(floor(p.pos)));
  var deep = vec4f(0.0);
  if (here >= 0) { deep = fieldB[here / i32(STRIDE)]; }
  if (deep.y < -2.5) {
    if (massSum > 2.5 * P.g.w) {
      let js = id.x * 4u + u32(P.misc.w);
      p.pos += 0.25 * (vec2f(rand(js), rand(js + 1u)) - 0.5);
    }
    p.win = u32(deep.z);
    particles[id.x] = p;
    atomicAdd(&counters[min(p.win, MAX_RECTS - 1u)], 1u);
    atomicAdd(&counters[MAX_RECTS + 4u + min(p.win, 15u)], u32(dot(p.vel, p.vel) * 256.0));
    return;
  }

  // Keep the particle inside the union of vessels.
  let m = P.misc2.z;
  let s = sdUnion(p.pos);
  let ri = u32(s.y);
  let r = P.rects[ri];
  if (s.x > -m) {
    if (s.x > 3.0 && P.misc.y > 0.5) {
      // Its vessel closed: hold it, then let it fall as rain into a remaining vessel.
      let seed = id.x * 4u + u32(P.misc.w);
      var total = 0.0;
      for (var i = 0u; i < P.grid.w; i++) { total += P.rects[i].info.z; }
      var pick = rand(seed) * total;
      var ti = ri;
      for (var i = 0u; i < P.grid.w; i++) {
        let wgt = P.rects[i].info.z;
        if (wgt <= 0.0) { continue; }
        ti = i;
        if (pick < wgt) { break; }
        pick -= wgt;
      }
      let t = P.rects[ti];
      p.pos = vec2f(mix(t.box.x + m + 1.0, t.box.z - m - 1.0, rand(seed + 1u)), t.box.y + m + 0.5 + 2.0 * rand(seed + 2u));
      // released already falling, so rain leaves the top edge at once instead of gathering there
      p.vel = t.vel.xy + P.g.xy * 150.0;
      p.C = vec4f(0.0);
      p.state = P.misc.x + 0.02 + 1.5 * rand(seed + 3u);
      p.win = ownerOf(p.pos, ti);
      particles[id.x] = p;
      atomicAdd(&counters[MAX_RECTS], 1u);
      return;
    }
    // Clamp with a little jitter: particles clamped to the same point would never separate again.
    let js = id.x * 4u + u32(P.misc.w);
    let lo = r.box.xy + m + 0.06 * vec2f(rand(js), rand(js + 1u));
    let hi = r.box.zw - m - 0.06 * vec2f(rand(js + 2u), rand(js + 3u));
    let q = clamp(p.pos, lo, hi);
    // a fast particle stopped by the glass is a slap: counted for the sound design
    let hit = length(p.vel - r.vel.xy);
    if (hit > 0.22 && any(q != p.pos)) { atomicAdd(&counters[MAX_RECTS + 20u + min(p.win, 15u)], u32(hit * 256.0)); }
    if (s.x > 0.0) { p.vel = r.vel.xy; p.C = vec4f(0.0); }
    p.pos = q;
  } else if (massSum > 2.5 * P.g.w) {
    // Badly over-packed: nudge so coincident particles can be pushed apart by pressure.
    let js = id.x * 4u + u32(P.misc.w);
    p.pos += 0.25 * (vec2f(rand(js), rand(js + 1u)) - 0.5);
  }
  p.win = ownerOf(p.pos, ri);
  particles[id.x] = p;
  atomicAdd(&counters[min(p.win, MAX_RECTS - 1u)], 1u);
  atomicAdd(&counters[MAX_RECTS + 4u + min(p.win, 15u)], u32(dot(p.vel, p.vel) * 256.0));
}
`;
