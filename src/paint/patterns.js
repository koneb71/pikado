import { createCanvas, clamp, clamp255 } from '../core/util.js';

/**
 * Built-in pattern library.
 *
 * Every pattern is generated procedurally into a small canvas that tiles
 * seamlessly: the geometric ones are drawn with wrap-around copies (or from a
 * modular per-pixel rule) and the organic ones are built on a *periodic* value
 * noise lattice, so `createPattern(tile, 'repeat')` never shows a seam.
 *
 * Tiles are built lazily and cached — listing the library is cheap.
 */

/* ------------------------------------------------------------------ */
/* Noise plumbing                                                      */
/* ------------------------------------------------------------------ */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function latticeData(n, rng) {
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = rng();
  return a;
}

/** Bilinear+smoothstep sample of a wrapping lattice. `x`/`y` in lattice units. */
function sampleLattice(data, n, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const i0 = ((xi % n) + n) % n, j0 = ((yi % n) + n) % n;
  const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
  const a = data[j0 * n + i0], b = data[j0 * n + i1];
  const c = data[j1 * n + i0], d = data[j1 * n + i1];
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/**
 * Seamless fractal noise over the unit tile. Returns fn(u,v) -> 0..1 where
 * u/v are normalised tile coordinates.
 */
function makeNoise(seed, base = 4, octaves = 4) {
  const rng = mulberry(seed);
  const layers = [];
  let n = base, amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n, amp, data: latticeData(n, rng) });
    total += amp;
    n *= 2;
    amp *= 0.5;
  }
  return (u, v) => {
    let s = 0;
    for (const l of layers) s += l.amp * sampleLattice(l.data, l.n, u * l.n, v * l.n);
    return s / total;
  };
}

/* ------------------------------------------------------------------ */
/* Drawing plumbing                                                    */
/* ------------------------------------------------------------------ */

/** Run `fn` nine times so shapes crossing the tile edge reappear opposite. */
function wrap(ctx, w, h, fn) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * w, oy * h);
      fn(ctx);
      ctx.restore();
    }
  }
}

function fill(ctx, w, h, css) {
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, w, h);
}

function shade(r, g, b, k) {
  return `rgb(${clamp255(Math.round(r * k))},${clamp255(Math.round(g * k))},${clamp255(Math.round(b * k))})`;
}

/** Build a tile from a per-pixel callback returning [r,g,b] (0..255). */
function pixelTile(w, h, fn) {
  const cv = createCanvas(w, h);
  const img = new ImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn(x, y, out);
      const i = (y * w + x) * 4;
      d[i] = clamp255(out[0]);
      d[i + 1] = clamp255(out[1]);
      d[i + 2] = clamp255(out[2]);
      d[i + 3] = 255;
    }
  }
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

/* ------------------------------------------------------------------ */
/* The patterns                                                        */
/* ------------------------------------------------------------------ */

function buildCheckerboard() {
  const s = 64, cell = 16;
  const cv = createCanvas(s, s);
  const c = cv.getContext('2d');
  fill(c, s, s, '#f2efe9');
  c.fillStyle = '#3f434a';
  for (let y = 0; y < s / cell; y++) {
    for (let x = 0; x < s / cell; x++) {
      if ((x + y) % 2 === 0) c.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return cv;
}

function buildDots() {
  const s = 64;
  const cv = createCanvas(s, s);
  const c = cv.getContext('2d');
  fill(c, s, s, '#e8e2d6');
  const dot = (cx, cy, r) => {
    wrap(c, s, s, (g) => {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    });
  };
  // Half-drop lattice: two dots per tile gives an even scatter.
  c.fillStyle = '#2f3a45';
  dot(16, 16, 7.5);
  dot(48, 48, 7.5);
  c.fillStyle = '#c65f3a';
  dot(48, 16, 3.5);
  dot(16, 48, 3.5);
  return cv;
}

function buildDiagonalLines() {
  const period = 16, bar = 6;
  return pixelTile(64, 64, (x, y, out) => {
    const t = (((x + y) % period) + period) % period;
    const on = t < bar;
    out[0] = on ? 44 : 234;
    out[1] = on ? 52 : 231;
    out[2] = on ? 64 : 222;
  });
}

function buildCrosshatch() {
  const p = 16, w = 3;
  return pixelTile(64, 64, (x, y, out) => {
    const a = (((x + y) % p) + p) % p < w;
    const b = (((x - y) % p) + p) % p < w;
    const n = (a ? 1 : 0) + (b ? 1 : 0);
    const v = n === 2 ? 46 : n === 1 ? 96 : 240;
    out[0] = v;
    out[1] = v - 2;
    out[2] = v - 8;
  });
}

function buildGrain() {
  const s = 128;
  const fine = makeNoise(0x51ad, 32, 2);
  const broad = makeNoise(0x9ce1, 4, 3);
  const fibre = makeNoise(0x2f70, 8, 2);
  return pixelTile(s, s, (x, y, out) => {
    const u = x / s, v = y / s;
    // Paper: broad tonal drift + fine grain + faint horizontal fibres.
    const base = 226 + (broad(u, v) - 0.5) * 16;
    const g = (fine(u, v) - 0.5) * 22;
    const f = Math.sin(v * Math.PI * 2 * 16 + fibre(u, v) * 9) * 3;
    const val = base + g + f;
    out[0] = val + 4;
    out[1] = val + 1;
    out[2] = val - 6;
  });
}

function buildBricks() {
  const w = 128, h = 128;
  const brickW = 64, brickH = 32, mortar = 4;
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  fill(c, w, h, '#d9d2c4');
  const noise = makeNoise(0x7b31, 16, 3);
  for (let row = 0; row < h / brickH; row++) {
    const offset = row % 2 ? brickW / 2 : 0;
    for (let col = -1; col <= w / brickW; col++) {
      const bx = col * brickW + offset;
      const by = row * brickH;
      const t = noise((col * 0.37 + row * 0.11) % 1, (row * 0.29) % 1);
      const k = 0.86 + t * 0.3;
      wrap(c, w, h, (g) => {
        g.fillStyle = shade(158, 84, 62, k);
        g.fillRect(bx + mortar / 2, by + mortar / 2, brickW - mortar, brickH - mortar);
        // A highlight along the top edge reads as a bevel.
        g.fillStyle = shade(190, 116, 92, k);
        g.fillRect(bx + mortar / 2, by + mortar / 2, brickW - mortar, 2);
      });
    }
  }
  return cv;
}

function buildHerringbone() {
  // Planks are 2W x W. The motif {H at (0,0), V at (2W,0)} tiles the plane on
  // the lattice a=(3W,W), b=(-W,W); (4W,0) and (0,4W) are lattice vectors, so
  // a 4W square tile is seamless.
  const W = 32, s = W * 4;
  const cv = createCanvas(s, s);
  const c = cv.getContext('2d');
  fill(c, s, s, '#2a2018');
  const noise = makeNoise(0x3ad9, 8, 3);
  const plank = (x, y, pw, ph, vertical, seed) => {
    const k = 0.82 + noise((seed * 0.31) % 1, (seed * 0.77) % 1) * 0.4;
    c.fillStyle = shade(150, 104, 62, k);
    c.fillRect(x + 1, y + 1, pw - 2, ph - 2);
    // Grain streaks along the plank.
    c.save();
    c.beginPath();
    c.rect(x + 1, y + 1, pw - 2, ph - 2);
    c.clip();
    c.strokeStyle = shade(150, 104, 62, k * 0.82);
    c.lineWidth = 1;
    const lines = vertical ? pw : ph;
    for (let i = 3; i < lines; i += 4) {
      c.beginPath();
      if (vertical) {
        c.moveTo(x + i + 0.5, y);
        c.lineTo(x + i + 0.5, y + ph);
      } else {
        c.moveTo(x, y + i + 0.5);
        c.lineTo(x + pw, y + i + 0.5);
      }
      c.stroke();
    }
    c.restore();
  };
  let seed = 0;
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const ox = i * 3 * W + j * -W;
      const oy = i * W + j * W;
      seed++;
      if (ox < -2 * W || ox > s + 2 * W || oy < -2 * W || oy > s + 2 * W) continue;
      plank(ox, oy, 2 * W, W, false, seed);
      plank(ox + 2 * W, oy, W, 2 * W, true, seed + 97);
    }
  }
  return cv;
}

function buildGrid() {
  const s = 64, major = 32, minor = 8;
  return pixelTile(s, s, (x, y, out) => {
    const onMajor = x % major === 0 || y % major === 0 || (x + 1) % major === 0 || (y + 1) % major === 0;
    const onMinor = x % minor === 0 || y % minor === 0;
    const v = onMajor ? 70 : onMinor ? 186 : 246;
    out[0] = v;
    out[1] = v;
    out[2] = onMajor ? 96 : v;
  });
}

function buildWaves() {
  const s = 128;
  const noise = makeNoise(0x1ee7, 4, 2);
  return pixelTile(s, s, (x, y, out) => {
    const u = x / s, v = y / s;
    // Both terms are whole numbers of cycles across the tile -> seamless.
    const phase = 2 * Math.PI * (3 * u) + 1.5 * Math.sin(2 * Math.PI * v) + noise(u, v) * 0.8;
    const w = Math.sin(phase);
    const band = 0.5 + 0.5 * w;
    const r = 46 + band * 66;
    const g = 96 + band * 96;
    const b = 132 + band * 92;
    // A crisp crest line lifts it out of "gradient soup".
    const crest = Math.abs(w) > 0.985 ? 26 : 0;
    out[0] = r + crest;
    out[1] = g + crest;
    out[2] = b + crest;
  });
}

function buildWeave() {
  const s = 64, cell = 16, gap = 2;
  const cv = createCanvas(s, s);
  const c = cv.getContext('2d');
  fill(c, s, s, '#b9a483');
  const warp = '#e0cba6';
  const weft = '#a5875c';
  for (let j = 0; j < s / cell; j++) {
    for (let i = 0; i < s / cell; i++) {
      const over = (i + j) % 2 === 0;
      const x = i * cell, y = j * cell;
      // Under-thread first, then the one that crosses over it.
      c.fillStyle = over ? weft : warp;
      if (over) c.fillRect(x, y + gap, cell, cell - gap * 2);
      else c.fillRect(x + gap, y, cell - gap * 2, cell);
      c.fillStyle = over ? warp : weft;
      if (over) c.fillRect(x + gap, y, cell - gap * 2, cell);
      else c.fillRect(x, y + gap, cell, cell - gap * 2);
      // Soft shading on the raised thread.
      c.fillStyle = 'rgba(0,0,0,.10)';
      if (over) c.fillRect(x + gap, y, cell - gap * 2, 2);
      else c.fillRect(x, y + gap, 2, cell - gap * 2);
    }
  }
  return cv;
}

function buildWood() {
  const s = 128;
  const turb = makeNoise(0x6c4a, 4, 4);
  const fine = makeNoise(0xa93b, 16, 2);
  return pixelTile(s, s, (x, y, out) => {
    const u = x / s, v = y / s;
    // Rings marching along x, warped by turbulence; 4 whole cycles -> seamless.
    const rings = Math.sin(2 * Math.PI * 4 * u + (turb(u, v) - 0.5) * 9);
    const g = 0.5 + 0.5 * rings;
    const grain = (fine(u * 1, v) - 0.5) * 0.22;
    const t = clamp(g * 0.8 + grain + 0.12, 0, 1);
    out[0] = 96 + t * 92;
    out[1] = 58 + t * 74;
    out[2] = 30 + t * 48;
  });
}

function buildMarble() {
  const s = 128;
  const turb = makeNoise(0x4f21, 4, 5);
  const speck = makeNoise(0xbe07, 32, 2);
  return pixelTile(s, s, (x, y, out) => {
    const u = x / s, v = y / s;
    const vein = Math.sin(2 * Math.PI * (2 * u + 2 * v) + (turb(u, v) - 0.5) * 11);
    // Sharp dark veins on a pale stone body.
    const veinAmt = Math.pow(clamp(1 - Math.abs(vein), 0, 1), 6);
    const body = 214 + (turb(v, u) - 0.5) * 26 + (speck(u, v) - 0.5) * 10;
    const val = body - veinAmt * 118;
    out[0] = val + 3;
    out[1] = val + 1;
    out[2] = val - 2;
  });
}

function buildHexagons() {
  // Squashed hex: width 32, height 32, rows step 24 with a 16px row offset,
  // so a 96x96 tile holds exactly 3 columns and 4 half-offset rows.
  const w = 96, h = 96, hw = 16, hq = 8;
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  fill(c, w, h, '#20252e');
  const hexPath = (g, cx, cy) => {
    g.beginPath();
    g.moveTo(cx, cy - hw);
    g.lineTo(cx + hw, cy - hq);
    g.lineTo(cx + hw, cy + hq);
    g.lineTo(cx, cy + hw);
    g.lineTo(cx - hw, cy + hq);
    g.lineTo(cx - hw, cy - hq);
    g.closePath();
  };
  for (let row = -1; row <= h / 24 + 1; row++) {
    for (let col = -1; col <= w / 32 + 1; col++) {
      const cx = col * 32 + (row % 2 ? 16 : 0);
      const cy = row * 24;
      const tone = (row + col) % 3;
      const css = tone === 0 ? '#3d7f8c' : tone === 1 ? '#2f6472' : '#4d99a4';
      wrap(c, w, h, (g) => {
        g.fillStyle = css;
        hexPath(g, cx, cy);
        g.fill();
        g.strokeStyle = '#20252e';
        g.lineWidth = 2;
        g.stroke();
      });
    }
  }
  return cv;
}

function buildStars() {
  const s = 128;
  const cv = createCanvas(s, s);
  const c = cv.getContext('2d');
  fill(c, s, s, '#1b2340');
  const star = (cx, cy, r, rot, css) => {
    wrap(c, s, s, (g) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.44 : r;
        const a = (Math.PI * i) / 5 - Math.PI / 2;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = css;
      g.fill();
      g.restore();
    });
  };
  star(32, 32, 20, 0, '#f4d371');
  star(96, 96, 20, 0.35, '#f4d371');
  star(96, 32, 11, -0.5, '#7fa4e8');
  star(32, 96, 11, 0.8, '#7fa4e8');
  // Tiny sparkles fill the gaps.
  c.fillStyle = 'rgba(255,255,255,.55)';
  for (const [px, py] of [[64, 8], [8, 64], [64, 72], [72, 64], [120, 8], [8, 120]]) {
    wrap(c, s, s, (g) => {
      g.beginPath();
      g.arc(px, py, 2, 0, Math.PI * 2);
      g.fill();
    });
  }
  return cv;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const DEFS = [
  { id: 'checkerboard', name: 'Checkerboard', build: buildCheckerboard },
  { id: 'dots', name: 'Polka Dots', build: buildDots },
  { id: 'diagonal-lines', name: 'Diagonal Lines', build: buildDiagonalLines },
  { id: 'crosshatch', name: 'Crosshatch', build: buildCrosshatch },
  { id: 'grain', name: 'Paper Grain', build: buildGrain },
  { id: 'bricks', name: 'Brick Wall', build: buildBricks },
  { id: 'herringbone', name: 'Herringbone', build: buildHerringbone },
  { id: 'grid', name: 'Graph Grid', build: buildGrid },
  { id: 'waves', name: 'Waves', build: buildWaves },
  { id: 'weave', name: 'Fabric Weave', build: buildWeave },
  { id: 'wood', name: 'Wood Grain', build: buildWood },
  { id: 'marble', name: 'Marble', build: buildMarble },
  { id: 'hexagons', name: 'Hexagons', build: buildHexagons },
  { id: 'stars', name: 'Stars', build: buildStars },
];

const cache = new Map();

function tileFor(def) {
  let cv = cache.get(def.id);
  if (!cv) {
    cv = def.build();
    cache.set(def.id, cv);
  }
  return cv;
}

function entryFor(def) {
  const e = { id: def.id, name: def.name };
  // Lazy so listing the library for a <select> costs nothing.
  Object.defineProperty(e, 'canvas', { enumerable: true, get: () => tileFor(def) });
  return e;
}

/**
 * The whole library.
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}[]}
 */
export function getPatterns() {
  return DEFS.map(entryFor);
}

/**
 * One pattern by id. Returns null for an empty or unknown id so callers can
 * tell "no pattern chosen" apart from a real one.
 *
 * @param {string} id
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}|null}
 */
export function getPattern(id) {
  if (!id) return null;
  const def = DEFS.find((d) => d.id === id);
  return def ? entryFor(def) : null;
}

/** `[{value,label}]` ready to drop into a `select` ParamDescriptor. */
export function patternOptions() {
  return DEFS.map((d) => ({ value: d.id, label: d.name }));
}

/**
 * Fill a `w x h` canvas with a repeated pattern tile. An id that resolves to
 * nothing yields an empty canvas rather than an arbitrary substitute.
 *
 * @param {string|{canvas:HTMLCanvasElement}|HTMLCanvasElement} pattern id, entry or raw tile
 * @param {number} w
 * @param {number} h
 * @param {number} [scale] 1 = native tile size
 * @param {number} [offsetX] phase shift in destination pixels
 * @param {number} [offsetY]
 * @returns {HTMLCanvasElement}
 */
export function makeTiledCanvas(pattern, w, h, scale = 1, offsetX = 0, offsetY = 0) {
  const entry = typeof pattern === 'string' ? getPattern(pattern) : pattern;
  const tile = entry && entry.canvas ? entry.canvas : entry;
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  if (!tile || !tile.width) return out;

  const s = clamp(scale || 1, 0.05, 24);
  let unit = tile;
  if (Math.abs(s - 1) > 1e-3) {
    const uw = Math.max(1, Math.round(tile.width * s));
    const uh = Math.max(1, Math.round(tile.height * s));
    unit = createCanvas(uw, uh);
    const uc = unit.getContext('2d');
    uc.imageSmoothingEnabled = s < 1;
    uc.imageSmoothingQuality = 'high';
    uc.drawImage(tile, 0, 0, uw, uh);
  }

  const rep = ctx.createPattern(unit, 'repeat');
  const ox = ((Math.round(offsetX) % unit.width) + unit.width) % unit.width;
  const oy = ((Math.round(offsetY) % unit.height) + unit.height) % unit.height;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = rep;
  ctx.fillRect(-ox, -oy, w, h);
  ctx.restore();
  return out;
}
