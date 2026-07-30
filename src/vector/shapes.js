/**
 * The custom shape library.
 *
 * Every shape is stored as SVG-style path data normalised into the unit box
 * (0..1 on both axes). `shapeToSubpaths()` parses it, scales it into a
 * rectangle and returns subpaths in the same format as `src/vector/path.js`.
 *
 * Only M/L/H/V/C/S/Q/T/Z commands are used — no arcs — so the parser stays
 * small and every shape converts losslessly to cubic beziers.
 */

/* ------------------------------------------------------------------ */
/* Generators for the shapes that are tedious to write by hand         */
/* ------------------------------------------------------------------ */

const K = 0.5522847498; // circle-to-bezier constant

function circleD(cx, cy, r) {
  const k = r * K;
  return (
    `M${cx - r} ${cy}` +
    `C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r}` +
    `C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy}` +
    `C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r}` +
    `C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}Z`
  );
}

/** Circle traced the other way round, so nonzero filling punches a hole. */
function holeD(cx, cy, r) {
  const k = r * K;
  return (
    `M${cx - r} ${cy}` +
    `C${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r}` +
    `C${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy}` +
    `C${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r}` +
    `C${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy}Z`
  );
}

function polyD(n, r, rot = -Math.PI / 2, cx = 0.5, cy = 0.5) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI * 2) / n;
    d += `${i ? 'L' : 'M'}${(cx + Math.cos(a) * r).toFixed(4)} ${(cy + Math.sin(a) * r).toFixed(4)}`;
  }
  return `${d}Z`;
}

function starD(points, rOuter, rInner, rot = -Math.PI / 2) {
  let d = '';
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + i * step;
    d += `${i ? 'L' : 'M'}${(0.5 + Math.cos(a) * r).toFixed(4)} ${(0.5 + Math.sin(a) * r).toFixed(4)}`;
  }
  return `${d}Z`;
}

function sunD() {
  let d = circleD(0.5, 0.5, 0.24);
  const rays = 8;
  for (let i = 0; i < rays; i++) {
    const a = (i * Math.PI * 2) / rays - Math.PI / 2;
    const w = 0.13;
    const p = (r, off) => `${(0.5 + Math.cos(a + off) * r).toFixed(4)} ${(0.5 + Math.sin(a + off) * r).toFixed(4)}`;
    d += `M${p(0.3, -w)}L${p(0.5, 0)}L${p(0.3, w)}Z`;
  }
  return d;
}

function flowerD() {
  const petals = 6;
  let d = '';
  for (let i = 0; i < petals; i++) {
    const a = (i * Math.PI * 2) / petals - Math.PI / 2;
    const s = 0.52; // angular half-spread of the petal
    const R = 0.62;
    const at = (r, off) => `${(0.5 + Math.cos(a + off) * r).toFixed(4)} ${(0.5 + Math.sin(a + off) * r).toFixed(4)}`;
    d += `M0.5 0.5C${at(R, -s)} ${at(R, -s * 0.34)} ${at(0.5, 0)}C${at(R, s * 0.34)} ${at(R, s)} 0.5 0.5Z`;
  }
  d += circleD(0.5, 0.5, 0.12);
  return d;
}

function gearD() {
  const teeth = 8;
  const rTip = 0.5;
  const rRoot = 0.37;
  const step = (Math.PI * 2) / teeth;
  let d = '';
  const at = (r, a) => `${(0.5 + Math.cos(a) * r).toFixed(4)} ${(0.5 + Math.sin(a) * r).toFixed(4)}`;
  for (let i = 0; i < teeth; i++) {
    const b = i * step - Math.PI / 2;
    d += `${i ? 'L' : 'M'}${at(rRoot, b)}`;
    d += `L${at(rTip, b + step * 0.12)}`;
    d += `L${at(rTip, b + step * 0.38)}`;
    d += `L${at(rRoot, b + step * 0.5)}`;
  }
  d += 'Z';
  d += holeD(0.5, 0.5, 0.16);
  return d;
}

function spiralD() {
  const turns = 2.6;
  const steps = 110;
  const thick = 0.028;
  const outer = [];
  const inner = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2 - Math.PI / 2;
    const r = 0.06 + t * 0.42;
    outer.push([0.5 + Math.cos(a) * (r + thick), 0.5 + Math.sin(a) * (r + thick)]);
    inner.push([0.5 + Math.cos(a) * Math.max(0.004, r - thick), 0.5 + Math.sin(a) * Math.max(0.004, r - thick)]);
  }
  inner.reverse();
  let d = '';
  outer.forEach((p, i) => { d += `${i ? 'L' : 'M'}${p[0].toFixed(4)} ${p[1].toFixed(4)}`; });
  inner.forEach((p) => { d += `L${p[0].toFixed(4)} ${p[1].toFixed(4)}`; });
  return `${d}Z`;
}

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

/**
 * @type {{id:string, name:string, group:string, d:string}[]}
 */
export const CUSTOM_SHAPES = [
  /* --- arrows --- */
  { id: 'arrow-right', name: 'Arrow Right', group: 'Arrows', d: 'M0 0.3H0.6V0.05L1 0.5L0.6 0.95V0.7H0Z' },
  { id: 'arrow-left', name: 'Arrow Left', group: 'Arrows', d: 'M1 0.3H0.4V0.05L0 0.5L0.4 0.95V0.7H1Z' },
  { id: 'arrow-up', name: 'Arrow Up', group: 'Arrows', d: 'M0.3 1V0.4H0.05L0.5 0L0.95 0.4H0.7V1Z' },
  { id: 'arrow-down', name: 'Arrow Down', group: 'Arrows', d: 'M0.3 0V0.6H0.05L0.5 1L0.95 0.6H0.7V0Z' },
  {
    id: 'arrow-curved', name: 'Curved Arrow', group: 'Arrows',
    d: 'M0.06 1C0.06 0.5 0.3 0.22 0.62 0.22L0.62 0.02L1 0.3L0.62 0.58L0.62 0.4C0.42 0.4 0.26 0.6 0.26 1Z',
  },
  {
    id: 'arrow-double', name: 'Double Arrow', group: 'Arrows',
    d: 'M0 0.5L0.24 0.08V0.32H0.76V0.08L1 0.5L0.76 0.92V0.68H0.24V0.92Z',
  },

  /* --- stars --- */
  { id: 'star-5', name: '5-Point Star', group: 'Stars', d: starD(5, 0.5, 0.191) },
  { id: 'star-6', name: '6-Point Star', group: 'Stars', d: starD(6, 0.5, 0.2887) },
  { id: 'star-burst', name: 'Starburst', group: 'Stars', d: starD(12, 0.5, 0.33) },

  /* --- symbols --- */
  {
    id: 'heart', name: 'Heart', group: 'Symbols',
    d: 'M0.5 1C0.5 1 0.02 0.66 0.02 0.3C0.02 0.12 0.16 0.01 0.3 0.01C0.4 0.01 0.47 0.07 0.5 0.15C0.53 0.07 0.6 0.01 0.7 0.01C0.84 0.01 0.98 0.12 0.98 0.3C0.98 0.66 0.5 1 0.5 1Z',
  },
  { id: 'check', name: 'Check Mark', group: 'Symbols', d: 'M0.04 0.5L0.2 0.34L0.4 0.55L0.8 0.11L0.96 0.27L0.4 0.89Z' },
  {
    id: 'cross', name: 'Cross', group: 'Symbols',
    d: 'M0.15 0.02L0.5 0.37L0.85 0.02L0.98 0.15L0.63 0.5L0.98 0.85L0.85 0.98L0.5 0.63L0.15 0.98L0.02 0.85L0.37 0.5L0.02 0.15Z',
  },
  { id: 'plus', name: 'Plus', group: 'Symbols', d: 'M0.35 0H0.65V0.35H1V0.65H0.65V1H0.35V0.65H0V0.35H0.35Z' },
  { id: 'minus', name: 'Minus', group: 'Symbols', d: 'M0 0.38H1V0.62H0Z' },
  {
    id: 'lightning', name: 'Lightning', group: 'Symbols',
    d: 'M0.58 0L0.1 0.56H0.42L0.3 1L0.9 0.4H0.55L0.78 0Z',
  },
  {
    id: 'music-note', name: 'Music Note', group: 'Symbols',
    d: 'M0.42 0L0.98 0.14V0.34L0.55 0.24V0.78C0.55 0.91 0.43 1 0.28 1C0.13 1 0.02 0.92 0.02 0.8C0.02 0.68 0.14 0.59 0.29 0.59C0.34 0.59 0.39 0.6 0.42 0.62Z',
  },
  {
    id: 'shield', name: 'Shield', group: 'Symbols',
    d: 'M0.5 0L1 0.16V0.5C1 0.76 0.78 0.94 0.5 1C0.22 0.94 0 0.76 0 0.5V0.16Z',
  },

  /* --- talk --- */
  {
    id: 'speech-bubble', name: 'Speech Bubble', group: 'Talk',
    d: 'M0.12 0.04H0.88C0.95 0.04 1 0.1 1 0.17V0.63C1 0.7 0.95 0.76 0.88 0.76H0.44L0.2 0.99L0.25 0.76H0.12C0.05 0.76 0 0.7 0 0.63V0.17C0 0.1 0.05 0.04 0.12 0.04Z',
  },
  {
    id: 'speech-oval', name: 'Oval Balloon', group: 'Talk',
    d: 'M0.5 0.02C0.78 0.02 1 0.18 1 0.38C1 0.58 0.78 0.74 0.5 0.74C0.44 0.74 0.38 0.735 0.33 0.725L0.12 0.98L0.17 0.7C0.06 0.62 0 0.51 0 0.38C0 0.18 0.22 0.02 0.5 0.02Z',
  },
  {
    id: 'thought-bubble', name: 'Thought Bubble', group: 'Talk',
    d:
      'M0.32 0.09C0.44 0 0.66 0.01 0.74 0.14C0.9 0.13 1 0.29 0.94 0.42C1 0.54 0.9 0.68 0.76 0.66C0.66 0.76 0.46 0.75 0.38 0.64C0.22 0.68 0.09 0.55 0.13 0.42C0.03 0.32 0.1 0.14 0.32 0.09Z' +
      circleD(0.2, 0.83, 0.075) + circleD(0.07, 0.96, 0.045),
  },

  /* --- nature --- */
  { id: 'sun', name: 'Sun', group: 'Nature', d: sunD() },
  {
    id: 'moon', name: 'Crescent Moon', group: 'Nature',
    d: 'M0.62 0.02C0.28 0.06 0.04 0.26 0.04 0.5C0.04 0.74 0.28 0.94 0.62 0.98C0.38 0.86 0.26 0.7 0.26 0.5C0.26 0.3 0.38 0.14 0.62 0.02Z',
  },
  {
    id: 'cloud', name: 'Cloud', group: 'Nature',
    d: 'M0.24 0.88C0.1 0.88 0 0.77 0 0.64C0 0.52 0.09 0.42 0.2 0.4C0.22 0.22 0.37 0.09 0.55 0.09C0.71 0.09 0.85 0.2 0.89 0.35C0.96 0.39 1 0.48 1 0.58C1 0.75 0.88 0.88 0.74 0.88Z',
  },
  { id: 'flower', name: 'Flower', group: 'Nature', d: flowerD() },
  {
    id: 'leaf', name: 'Leaf', group: 'Nature',
    d: 'M0.02 0.98C0.02 0.5 0.3 0.02 0.98 0.02C0.98 0.5 0.7 0.98 0.02 0.98Z',
  },
  {
    id: 'house', name: 'House', group: 'Objects',
    d: 'M0.5 0L1 0.42H0.86V1H0.6V0.62H0.4V1H0.14V0.42H0Z',
  },
  { id: 'gear', name: 'Gear', group: 'Objects', d: gearD() },
  { id: 'spiral', name: 'Spiral', group: 'Objects', d: spiralD() },

  /* --- geometry --- */
  { id: 'triangle', name: 'Triangle', group: 'Geometry', d: 'M0.5 0L1 1H0Z' },
  { id: 'diamond', name: 'Diamond', group: 'Geometry', d: 'M0.5 0L1 0.5L0.5 1L0 0.5Z' },
  { id: 'pentagon', name: 'Pentagon', group: 'Geometry', d: polyD(5, 0.5) },
  { id: 'hexagon', name: 'Hexagon', group: 'Geometry', d: polyD(6, 0.5) },
  { id: 'octagon', name: 'Octagon', group: 'Geometry', d: polyD(8, 0.5, -Math.PI / 2 + Math.PI / 8) },
  { id: 'circle', name: 'Circle', group: 'Geometry', d: circleD(0.5, 0.5, 0.5) },
  {
    id: 'ring', name: 'Ring', group: 'Geometry',
    d: circleD(0.5, 0.5, 0.5) + holeD(0.5, 0.5, 0.28),
  },
];

/** `{value,label}` list for a `select` ParamDescriptor. */
export const CUSTOM_SHAPE_OPTIONS = CUSTOM_SHAPES.map((s) => ({ value: s.id, label: s.name }));

export function getCustomShape(id) {
  return CUSTOM_SHAPES.find((s) => s.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Path-data parser                                                    */
/* ------------------------------------------------------------------ */

const NUM_RE = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const nums = (m[2].match(NUM_RE) || []).map(Number);
    out.push({ cmd: m[1], nums });
  }
  return out;
}

/**
 * Parse unit-space path data into cubic polylines.
 * @returns {{closed:boolean, segs:{p0:number[],c1:number[],c2:number[],p3:number[]}[]}[]}
 */
function parseToCubics(d) {
  const contours = [];
  let cur = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let prevC = null; // last cubic control point, for S
  let prevQ = null; // last quadratic control point, for T

  const start = () => {
    cur = { closed: false, segs: [] };
    contours.push(cur);
  };
  const line = (nx, ny) => {
    if (!cur) start();
    cur.segs.push({ p0: [x, y], c1: [x, y], c2: [nx, ny], p3: [nx, ny], straight: true });
    x = nx; y = ny;
    prevC = null; prevQ = null;
  };
  const cubic = (c1x, c1y, c2x, c2y, nx, ny) => {
    if (!cur) start();
    cur.segs.push({ p0: [x, y], c1: [c1x, c1y], c2: [c2x, c2y], p3: [nx, ny], straight: false });
    prevC = [c2x, c2y];
    prevQ = null;
    x = nx; y = ny;
  };
  const quad = (qx, qy, nx, ny) => {
    cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
    prevQ = [qx, qy];
  };

  for (const { cmd, nums } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      if (cur) { cur.closed = true; x = sx; y = sy; cur = null; }
      continue;
    }
    const per = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 }[up];
    for (let i = 0; i + per <= nums.length; i += per) {
      const n = nums.slice(i, i + per);
      switch (up) {
        case 'M': {
          const nx = rel ? x + n[0] : n[0];
          const ny = rel ? y + n[1] : n[1];
          if (i === 0) {
            cur = null;
            start();
            x = nx; y = ny; sx = nx; sy = ny;
            prevC = null; prevQ = null;
          } else line(nx, ny);
          break;
        }
        case 'L': line(rel ? x + n[0] : n[0], rel ? y + n[1] : n[1]); break;
        case 'H': line(rel ? x + n[0] : n[0], y); break;
        case 'V': line(x, rel ? y + n[0] : n[0]); break;
        case 'C':
          cubic(
            rel ? x + n[0] : n[0], rel ? y + n[1] : n[1],
            rel ? x + n[2] : n[2], rel ? y + n[3] : n[3],
            rel ? x + n[4] : n[4], rel ? y + n[5] : n[5]
          );
          break;
        case 'S': {
          const rx = prevC ? 2 * x - prevC[0] : x;
          const ry = prevC ? 2 * y - prevC[1] : y;
          cubic(rx, ry, rel ? x + n[0] : n[0], rel ? y + n[1] : n[1], rel ? x + n[2] : n[2], rel ? y + n[3] : n[3]);
          break;
        }
        case 'Q':
          quad(rel ? x + n[0] : n[0], rel ? y + n[1] : n[1], rel ? x + n[2] : n[2], rel ? y + n[3] : n[3]);
          break;
        case 'T': {
          const rx = prevQ ? 2 * x - prevQ[0] : x;
          const ry = prevQ ? 2 * y - prevQ[1] : y;
          quad(rx, ry, rel ? x + n[0] : n[0], rel ? y + n[1] : n[1]);
          break;
        }
        default: break;
      }
    }
  }
  return contours.filter((c) => c.segs.length);
}

/** Turn parsed cubic contours into anchor/handle subpaths. */
function cubicsToSubpaths(contours, tx) {
  const subpaths = [];
  for (const c of contours) {
    const pts = [];
    const push = (p, inH, outH) => pts.push({
      x: p[0], y: p[1],
      in: inH ? { x: inH[0], y: inH[1] } : null,
      out: outH ? { x: outH[0], y: outH[1] } : null,
      corner: !inH && !outH,
    });
    const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

    const first = c.segs[0];
    push(tx(first.p0), null, first.straight || near(first.c1, first.p0) ? null : tx(first.c1));
    for (let i = 0; i < c.segs.length; i++) {
      const s = c.segs[i];
      const next = c.segs[i + 1];
      const inH = s.straight || near(s.c2, s.p3) ? null : tx(s.c2);
      const isLast = i === c.segs.length - 1;
      if (isLast && c.closed && near(s.p3, c.segs[0].p0)) {
        // The closing point coincides with the start — fold its `in` handle in.
        if (inH) {
          pts[0].in = { x: inH[0], y: inH[1] };
          pts[0].corner = false;
        }
        break;
      }
      const outH = next && !next.straight && !near(next.c1, next.p0) ? tx(next.c1) : null;
      push(tx(s.p3), inH, outH);
    }
    // A closed contour whose last point differs from the first still closes.
    if (pts.length >= 2) subpaths.push({ closed: !!c.closed, points: pts });
  }
  return subpaths;
}

const _cache = new Map();

/** Unit-space (0..1) subpaths for a shape id, cached. */
export function shapeUnitSubpaths(shapeId) {
  if (_cache.has(shapeId)) return _cache.get(shapeId);
  const s = getCustomShape(shapeId);
  const contours = s ? parseToCubics(s.d) : [];
  const subs = cubicsToSubpaths(contours, (p) => p);
  _cache.set(shapeId, subs);
  return subs;
}

/**
 * Instantiate a custom shape inside a rectangle.
 * @param {string} shapeId key from CUSTOM_SHAPES
 * @param {number} x left edge in document space
 * @param {number} y top edge
 * @param {number} w width (may be negative)
 * @param {number} h height (may be negative)
 * @returns {{closed:boolean, points:object[]}[]} subpaths in document space
 */
export function shapeToSubpaths(shapeId, x, y, w, h) {
  const s = getCustomShape(shapeId);
  if (!s) return [];
  const contours = parseToCubics(s.d);
  const tx = (p) => [x + p[0] * w, y + p[1] * h];
  return cubicsToSubpaths(contours, tx);
}

/**
 * Parse arbitrary SVG path data (M/L/H/V/C/S/Q/T/Z) into subpaths.
 * Used by the shape tools and by any importer that needs the same conversion.
 */
export function pathDataToSubpaths(d, transform) {
  const tx = transform || ((p) => p);
  return cubicsToSubpaths(parseToCubics(d), (p) => {
    const q = tx(p);
    return Array.isArray(q) ? q : [q.x, q.y];
  });
}
