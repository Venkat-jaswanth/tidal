// Per-window renderer: procedural graph paper seen through a refracting body of liquid.
// Everything is evaluated analytically per pixel, so refraction stays crisp at any DPR.

export const waterWGSL = /* wgsl */ `
struct U {
  res: vec2f,          // canvas size in device px
  dpr: f32,
  time: f32,
  viewOrigin: vec2f,   // world (screen CSS px) position of the viewport's top-left
  viewSize: vec2f,     // viewport size in CSS px
  cropOrigin: vec2f,   // world px of the field texture's texel (0, 0) corner
  cellPx: f32,
  px2PerMl: f32,
  gravity: vec2f,      // unit vector, screen space
  tickMl: f32,         // millilitres between minor graduations
  tickMajor: f32,      // minor graduations per major one
  paper: vec4f,        // rgb, grid step in px (w)
  gridFine: vec4f,     // rgb, alpha
  gridBold: vec4f,     // rgb, alpha; bold line every paperB.x fine lines
  ink: vec4f,          // graduations and vessel edge: rgb, alpha
  absorb: vec4f,       // per-channel absorption per 100 px of depth, w = body opacity when shallow
  tint: vec4f,         // liquid body colour (opaque liquids and ink), w = opacity reached at depth
  highlight: vec4f,    // specular colour, w = strength
  optics: vec4f,       // rim refraction px, magnification, dispersion, caustic strength
  optics2: vec4f,      // meniscus px, mirror band strength, foam strength, glow (dark themes)
  paperB: vec4f,       // bold-every, fine line width px, bold line width px, paper grain
  inkB: vec4f,         // second ink colour; w > 0: field.b mixes tint and inkB; w < 0: -w is how metallic the body is
  quality: vec4f,      // 1 = on, 0 = off: full refraction (dispersion and mirror band), caustics, foam and spray, unused
  column: vec4f,       // compressibility a (per px), eos exponent, fill factor, unused: see columnHeight in water.ts
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var field: texture_2d<f32>; // r density, g depth above (px), b foam, a speed
@group(0) @binding(2) var samp: sampler;

const TAU = 6.2831853;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0.0, 1.0);
}

fn hash2(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn hash22(p: vec2f) -> vec2f { return vec2f(hash2(p), hash2(p + 17.17)); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), s.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), s.x), s.y);
}

// Bicubic B-spline lookup built from four bilinear taps: smooth enough to take gradients of.
fn fieldAt(world: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(field));
  let t = (world - u.cropOrigin) / u.cellPx - 0.5;
  let i = floor(t); let f = t - i;
  let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  let w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  let w3 = f * f * f / 6.0;
  let g0 = w0 + w1; let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * textureSampleLevel(field, samp, vec2f(h0.x, h0.y), 0.0) + g1.x * textureSampleLevel(field, samp, vec2f(h1.x, h0.y), 0.0))
       + g1.y * (g0.x * textureSampleLevel(field, samp, vec2f(h0.x, h1.y), 0.0) + g1.x * textureSampleLevel(field, samp, vec2f(h1.x, h1.y), 0.0));
}

fn localOf(world: vec2f) -> vec2f { return world - u.viewOrigin; }

// How far the liquid climbs the glass at this distance from a side wall, px.
fn climb(p: vec2f) -> f32 {
  let wall = max(min(p.x, u.viewSize.x - p.x), 0.0);
  return u.optics2.x * exp(-wall / 8.0);
}

// The field with the vessel's wetting applied: the liquid reaches the glass and climbs it in a concave meniscus.
fn wet(world: vec2f) -> vec4f {
  let p = localOf(world);
  let inward = clamp(p, vec2f(3.0), u.viewSize - vec2f(3.0, 2.0));
  return fieldAt(u.viewOrigin + inward + u.gravity * climb(p));
}

fn gridLine(c: f32, step: f32, width: f32, aa: f32) -> f32 {
  let d = abs(fract(c / step + 0.5) - 0.5) * step;
  return 1.0 - smoothstep(width * 0.5 - aa, width * 0.5 + aa, d);
}

// The sheet of graph paper behind every vessel. World anchored: all windows look onto one sheet.
fn paperAt(world: vec2f, aa: f32) -> vec3f {
  let step = u.paper.w;
  var col = u.paper.rgb;
  col += (vnoise(world * 0.9) - 0.5) * u.paperB.w + (vnoise(world * 0.07) - 0.5) * u.paperB.w * 1.5;
  let a = max(aa, 0.35);
  let fine = max(gridLine(world.x, step, u.paperB.y, a), gridLine(world.y, step, u.paperB.y, a));
  let boldStep = step * u.paperB.x;
  let bold = max(gridLine(world.x, boldStep, u.paperB.z, a), gridLine(world.y, boldStep, u.paperB.z, a));
  // fade the fine ruling before it can alias when refraction minifies it
  let fineFade = clamp((step / a - 2.0) / 3.0, 0.0, 1.0);
  col = mix(col, u.gridFine.rgb, fine * u.gridFine.a * fineFade);
  col = mix(col, u.gridBold.rgb, bold * u.gridBold.a);
  return col;
}

// Etched graduations on the left wall of this vessel: honest millilitres for this vessel's width.
fn graduations(p: vec2f) -> f32 {
  let pxPerMl = u.px2PerMl / u.viewSize.x;
  // millilitres a resting column reaching this height holds (the inverse of columnHeight)
  let h = u.viewSize.y - p.y;
  let e = (u.column.y + 1.0) / u.column.y;
  let ideal = (pow(1.0 + u.column.x * h, e) - 1.0) / (e * u.column.x * u.column.z);
  let k = ideal / pxPerMl / u.tickMl;
  let nearest = round(k);
  if (nearest < 1.0) { return 0.0; }
  // px from the tick's centre line: millilitres off, times the local px per millilitre
  let local = pxPerMl * u.column.z / pow(1.0 + u.column.x * h, e - 1.0);
  let d = abs(k - nearest) * u.tickMl * local;
  let major = step(abs(nearest / u.tickMajor - round(nearest / u.tickMajor)), 0.01);
  let len = mix(8.0, 17.0, major);
  let line = 1.0 - smoothstep(0.35, 0.85, d);
  return line * step(p.x, len) * step(1.5, p.x) * step(p.y, u.viewSize.y - 2.0);
}

// A sharp caustic network: the pattern light makes on a surface behind rippling water.
fn caustic(p: vec2f, t: f32) -> f32 {
  let q = (p - TAU * floor(p / TAU)) - 250.0;
  var i = q;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < 4; n++) {
    let tt = t * (1.0 - (3.5 / f32(n + 1)));
    i = q + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2f(q.x / (sin(i.x + tt) / inten), q.y / (cos(i.y + tt) / inten)));
  }
  c = 1.17 - pow(c / 4.0, 1.4);
  return pow(abs(c), 8.0);
}

// Scattered small discs: returns (distance to the nearest disc edge in px, negative inside; its radius; a random id).
fn discs(world: vec2f, cell: f32, amount: f32) -> vec3f {
  let g = world / cell;
  let base = floor(g);
  var best = vec3f(1e3, 0.0, 0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = base + vec2f(f32(i), f32(j));
      let h = hash22(c);
      let pick = hash2(c + 3.1);
      if (pick > amount) { continue; }
      let centre = (c + 0.15 + 0.7 * h) * cell;
      let radius = cell * (0.16 + 0.26 * hash2(c + 9.7)) * (0.6 + 0.4 * (1.0 - pick / max(amount, 1e-3)));
      let d = length(world - centre) - radius;
      if (d < best.x) { best = vec3f(d, radius, pick); }
    }
  }
  return best;
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = fc.xy / u.dpr;
  let world = u.viewOrigin + p;
  let aa0 = 1.0 / u.dpr;
  let side = vec2f(u.gravity.y, -u.gravity.x);   // across the vessel, perpendicular to gravity

  let f = wet(world);
  let d = f.r;
  let e = 2.0;
  let grad = vec2f(wet(world + vec2f(e, 0.0)).r - wet(world - vec2f(e, 0.0)).r, wet(world + vec2f(0.0, e)).r - wet(world - vec2f(0.0, e)).r) / (2.0 * e);
  let gl = max(length(grad), 1e-4);
  let sd = (d - 0.5) / gl;                       // signed px distance to the surface, positive inside
  let inside = clamp(sd * u.dpr + 0.5, 0.0, 1.0);
  let n = -grad / gl;                            // points out of the liquid

  var col = paperAt(world, aa0);

  if (inside > 0.0) {
    // Depth of liquid above this point, smoothed in both directions.
    let es = 12.0;
    let dl = wet(world - side * es).g;
    let dr = wet(world + side * es).g;
    let du = wet(world - u.gravity * es).g;
    let dd = wet(world + u.gravity * es).g;
    let depth = (dl + dr + du + dd + 2.0 * f.g) / 6.0 + climb(p);
    // How the depth changes across the vessel is the tilt of the surface above this point.
    // A small dead zone keeps a resting surface optically flat.
    let rawSlope = clamp((dr - dl) / (2.0 * es), -2.0, 2.0);
    let slope = sign(rawSlope) * max(abs(rawSlope) - 0.05, 0.0);

    // Lensing: the slab magnifies what is behind it; a tilted surface shears it like a prism; the
    // curved rim of the surface and of the meniscus bends it hardest; moving water makes it shimmer.
    let centre = u.viewOrigin + u.viewSize * 0.5;
    let lens = (world - centre) * (1.0 / u.optics.y - 1.0);
    let prism = side * slope * 22.0 * (1.0 - exp(-depth / 40.0));
    let rim = exp(-max(sd, 0.0) / 7.0);
    let curve = n * rim * u.optics.x;
    let speed = clamp(f.a * 3.0, 0.0, 1.0);
    let wobble = (vec2f(vnoise(world * 0.04 + u.time * 0.9), vnoise(world * 0.04 - u.time * 0.8 + 7.3)) - 0.5) * 16.0 * speed;
    let bend = prism + curve + wobble;
    let aa = aa0 * (1.0 + 2.0 * rim + abs(slope)) / u.optics.y + speed * 1.5;
    // colour fringing only at the curved rim, where a real surface disperses light
    let disp = clamp(curve * u.optics.z, vec2f(-0.8), vec2f(0.8));
    let at = world + lens + bend;
    var seen = paperAt(at, aa);
    if (u.quality.x > 0.5) { seen = vec3f(paperAt(at - disp, aa).r, seen.g, paperAt(at + disp, aa).b); }

    // On a dark field the liquid gathers light: the ruling behind it shows brighter than in air.
    seen = u.paper.rgb + (seen - u.paper.rgb) * (1.0 + 2.6 * u.optics2.w);

    // Caustics on the plane behind the liquid: thin wandering lines of focused light.
    // two layers at unrelated scales and angles, warped, so the pattern never visibly repeats
    var cau = 0.0;
    if (u.quality.y > 0.5) {
      let cw = at + 40.0 * vec2f(vnoise(at * 0.006 + 3.1), vnoise(at * 0.006 + 11.7));
      let c1 = caustic(cw / 170.0 * TAU, u.time * 0.5);
      let c2 = caustic(vec2f(cw.x * 0.8 - cw.y * 0.6, cw.x * 0.6 + cw.y * 0.8) / 113.0 * TAU + 2.0, u.time * 0.37 + 4.0);
      cau = smoothstep(0.1, 0.9, max(c1, c2 * 0.8));
    }
    let lit = u.optics.w * cau * smoothstep(6.0, 70.0, depth) * (0.5 + 0.5 * exp(-depth / 300.0));
    seen = seen * (1.0 + lit * 0.07) + u.highlight.rgb * lit * (0.03 + 0.2 * u.optics2.w);

    // Beer-Lambert absorption along the column of liquid above: a pure multiply.
    var body = seen * exp(-u.absorb.rgb * depth / 100.0);
    let opacity = u.absorb.w + u.tint.a * (1.0 - exp(-depth / 60.0));
    var bodyColour = u.tint.rgb;
    if (u.inkB.w > 0.5) {
      // two inks: mix in a perceptually even way and let thin layers stay bright
      let m = smoothstep(0.04, 0.96, f.b);
      bodyColour = mix(u.tint.rgb, u.inkB.rgb, m) * (1.0 - 0.38 * (1.0 - abs(2.0 * m - 1.0)));
    } else if (u.inkB.w < 0.0) {
      // metal: a mirror. Rims facing up catch the light, rims facing down go dark, and the interior
      // carries a soft, stretched reflection of the paper that slides as the surface tilts.
      let rimf = exp(-max(sd, 0.0) / 13.0);
      let up = -n.y;
      // the mirror shows the ruling around it, squeezed, and sliding as the surface tilts
      // only the major lines survive the squeeze; they bow where the surface tilts and at the rim
      let rc = world * vec2f(0.5, 0.28) + vec2f(slope * 40.0, 0.0) + n * rimf * 46.0;
      let refl = paperAt(rc, 5.0);
      let lines = smoothstep(0.02, 0.09, dot(u.paper.rgb, vec3f(0.333)) - dot(refl, vec3f(0.333)));
      let band = 0.5 + 0.5 * sin(world.y * 0.013 + slope * 1.8 + 1.4 * vnoise(world * 0.005));
      var metal = mix(u.tint.rgb * 0.7, u.tint.rgb * 1.14, band);
      metal = mix(metal, u.tint.rgb * 0.4, lines * 0.42);
      metal = mix(metal, vec3f(0.99, 1.0, 1.0), rimf * smoothstep(0.05, 0.8, up) * 0.92);
      metal = mix(metal, u.tint.rgb * 0.26, rimf * smoothstep(0.05, 0.8, -up) * 0.9);
      metal = mix(metal, u.tint.rgb * 0.42, rimf * (1.0 - abs(up)) * 0.55);
      bodyColour = metal;
    }
    body = mix(body, bodyColour, clamp(opacity, 0.0, 1.0));

    // The floor of the vessel catches the light as a thin bright line broken up by the caustics.
    let floorDist = u.viewSize.y - p.y;
    body += u.highlight.rgb * u.optics.w * (1.0 - smoothstep(1.5, 6.0, floorDist)) * (0.3 + 1.2 * cau) * smoothstep(6.0, 40.0, depth);

    // Seen from just below, the surface is a mirror: a narrow silvery band, wider where it tilts.
    let bandWidth = 2.2 + 3.6 * clamp(abs(n.x) * 1.4, 0.0, 1.0);
    let band = (1.0 - smoothstep(bandWidth - 1.2, bandWidth, sd)) * u.optics2.y;
    if (band > 0.003) {
      var mirrored = u.paper.rgb;
      if (u.quality.x > 0.5) { mirrored = paperAt(world + lens - n * (2.0 * sd + 26.0), aa * 4.0); }
      body = mix(body, mix(mirrored, u.highlight.rgb, 0.28), band);
    }

    // Foam and bubbles, only where the flow has been turbulent.
    let foam = clamp(f.b * u.optics2.z, 0.0, 1.0) * step(u.inkB.w, 0.5) * u.quality.z;
    if (foam > 0.02) {
      // small bright beads of trapped air, thinning out as the foam fades, under a soft froth where it is thickest
      let bub = discs(world, 6.0, foam * 0.6);
      let bead = (1.0 - smoothstep(-0.6, 0.5, bub.x)) * (0.55 + 0.45 * smoothstep(0.0, 1.2, -bub.x));
      let froth = smoothstep(0.6, 1.0, foam) * (0.3 + 0.7 * vnoise(world * 0.8));
      body = mix(body, u.highlight.rgb, clamp(bead * 0.55 * foam + froth * 0.45, 0.0, 0.9));
    }

    // The edge of the liquid. No drawn outline: just inside the surface the liquid shows a darker
    // band (light bent away from the eye), then a specular line that swells where the surface
    // faces the light and vanishes where it turns away, then a soft gloss on thick liquids.
    let upness = clamp(-dot(n, u.gravity), -1.0, 1.0);
    let facing = clamp(dot(n, normalize(vec2f(-0.45, -1.0))), 0.0, 1.0);
    let rimDark = (1.0 - smoothstep(0.0, 5.0, sd)) * (0.1 + 0.12 * (1.0 - facing)) * (1.0 - u.optics2.w);
    body *= 1.0 - rimDark;
    body *= 1.0 - 0.05 * exp(-max(sd, 0.0) / 10.0) * (1.0 - u.optics2.w);
    let calm = 1.0 - speed;
    let hair = (1.0 - smoothstep(0.2, 0.8, abs(sd - 0.3))) * smoothstep(0.2, 0.7, upness) * calm;
    body = mix(body, u.ink.rgb, hair * 0.2 * (1.0 - u.optics2.w));
    let specWidth = mix(0.4, 1.5, facing * facing);
    let spec = (1.0 - smoothstep(specWidth * 0.5, specWidth * 0.5 + 0.7, abs(sd - 1.4 - specWidth * 0.5))) * (0.15 + 0.85 * facing);
    body = mix(body, u.highlight.rgb, clamp(spec * u.highlight.a, 0.0, 1.0));
    let gloss = exp(-pow((sd - 8.0) / 4.5, 2.0)) * facing * u.tint.a * 0.35;
    body = mix(body, u.highlight.rgb, gloss);

    col = mix(col, body, inside);
  } else if (d > 0.04 && d < 0.42 && f.a > 0.1 && u.quality.z > 0.5 && u.optics2.z > 0.5) {
    // Spray: liquid too thin to form a body is drawn as a few small drops, each a tiny lens.
    let apart = smoothstep(12.0, 20.0, -sd);
    let drop = discs(world, 9.0, clamp(d * 1.1, 0.0, 0.6) * apart);
    if (drop.x < 0.75) {
      let cover = 1.0 - smoothstep(-0.75, 0.75, drop.x);
      let r = max(drop.y, 0.5);
      let t = clamp(-drop.x / r, 0.0, 1.0);          // 0 at the rim, 1 at the centre
      // a drop shows the paper upside down, darker towards its rim, with one small glint
      var lensed = paperAt(world + vec2f(0.0, r * 2.4) * (1.0 - t), aa0 * 2.0) * mix(vec3f(0.8, 0.85, 0.87), vec3f(0.98), smoothstep(0.0, 0.8, t));
      lensed = mix(lensed, u.highlight.rgb, smoothstep(0.72, 0.95, t) * 0.7);
      col = mix(col, lensed, cover);
    }
  }

  // The vessel is glass: etched graduations, and an edge with a dark outer line and a light inner one.
  let edge = min(min(p.x, u.viewSize.x - p.x), min(p.y, u.viewSize.y - p.y));
  let outer = 1.0 - smoothstep(0.6, 1.1, edge);
  let inner = (1.0 - smoothstep(0.5, 1.0, abs(edge - 1.9))) * 0.5;
  col = mix(col, u.highlight.rgb, inner * (1.0 - u.optics2.w));
  col = mix(col, u.ink.rgb, max(graduations(p), outer * 0.8) * u.ink.a);
  col += u.optics2.w * u.ink.rgb * graduations(p) * 0.45;

  return vec4f(col, 1.0);
}
`;
