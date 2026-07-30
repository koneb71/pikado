/**
 * Colour management: ICC profiles, conversions and soft proofing.
 *
 * **What is supported.** Matrix/TRC RGB profiles and grey profiles — the shape
 * every common working space uses (sRGB, Adobe RGB, Display P3, ProPhoto, Rec.
 * 2020) and the shape almost every profile embedded in a JPEG or PNG on the web
 * uses. A profile like that says three things: where its red, green and blue
 * primaries sit in XYZ, what its white point is, and what tone curve its encoded
 * values follow. That is enough to convert between any two of them exactly.
 *
 * **What is not.** LUT-based profiles (`A2B0`/`B2A0` tables) are parsed far
 * enough to be *recognised and rejected with a reason*, not silently
 * misinterpreted. That rules out CMYK printer profiles and the "perceptual"
 * rendering intent, both of which live entirely in those tables. A matrix profile
 * has no perceptual table to consult, so Perceptual and Saturation are mapped to
 * Relative Colorimetric and say so — every serious CMM does the same thing when
 * handed a matrix profile, and pretending otherwise would mean inventing a gamut
 * compression Adobe's tables do not contain.
 *
 * **Where the numbers live.** `doc.profile` is the document's colour space; it
 * only ever *describes* the pixels. Assign changes the description and therefore
 * the appearance; Convert changes the pixels to preserve the appearance. That
 * distinction is the whole of colour management and the thing people get wrong,
 * so the two are separate commands with separate names, exactly as in Photoshop.
 *
 * Everything internally is 8-bit. A conversion into a much larger space
 * (ProPhoto) and back will show banding that a 16-bit pipeline would not — real,
 * and stated rather than hidden.
 */

/* ------------------------------------------------------------------ */
/* Colour maths                                                        */
/* ------------------------------------------------------------------ */

/** CIE xy chromaticities of the standard illuminants, as XYZ with Y = 1. */
export const WHITE_POINTS = {
  D65: [0.95047, 1, 1.08883],
  D50: [0.96422, 1, 0.82521],
};

const mul3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const mm3 = (a, b) => {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
};

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, (c * h - b * i) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, (c * d - a * f) * k,
    C * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

const BRADFORD = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
];
const BRADFORD_INV = invert3(BRADFORD);

/** Bradford chromatic adaptation from one white point to another. */
export function adaptationMatrix(fromWhite, toWhite) {
  const s = mul3(BRADFORD, fromWhite);
  const d = mul3(BRADFORD, toWhite);
  const scale = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
  return mm3(BRADFORD_INV, mm3(scale, BRADFORD));
}

/**
 * RGB → XYZ for a set of primaries and a white point.
 *
 * The columns of the matrix are the primaries scaled so that RGB (1,1,1) lands
 * exactly on the white point — which is what makes white in one space convert to
 * white in another instead of to a slight tint.
 */
export function primariesToMatrix(primaries, white) {
  const { rx, ry, gx, gy, bx, by } = primaries;
  const m = [
    rx / ry, gx / gy, bx / by,
    1, 1, 1,
    (1 - rx - ry) / ry, (1 - gx - gy) / gy, (1 - bx - by) / by,
  ];
  const inv = invert3(m);
  if (!inv) return null;
  const s = mul3(inv, white);
  return [
    m[0] * s[0], m[1] * s[1], m[2] * s[2],
    m[3] * s[0], m[4] * s[1], m[5] * s[2],
    m[6] * s[0], m[7] * s[1], m[8] * s[2],
  ];
}

/* ------------------------------------------------------------------ */
/* Tone curves                                                         */
/* ------------------------------------------------------------------ */

/**
 * A tone response curve, in both directions.
 *
 * `toLinear(v)` and `fromLinear(v)` both work on 0..1. The sRGB and Rec. 709
 * curves have a linear segment near black, which a plain gamma cannot express and
 * which matters: approximating sRGB as gamma 2.2 puts a visible error into every
 * dark tone.
 */
export const TRC = {
  srgb: {
    name: 'sRGB',
    toLinear: (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
    fromLinear: (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
  },
  rec709: {
    name: 'Rec. 709',
    toLinear: (v) => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45)),
    fromLinear: (v) => (v < 0.018 ? v * 4.5 : 1.099 * v ** 0.45 - 0.099),
  },
  /** A pure power curve. */
  gamma(g) {
    return {
      name: `Gamma ${g}`,
      toLinear: (v) => (v <= 0 ? 0 : v ** g),
      fromLinear: (v) => (v <= 0 ? 0 : v ** (1 / g)),
    };
  },
  /** A sampled curve from an ICC `curv` tag, with linear interpolation. */
  table(samples) {
    const n = samples.length;
    const toLinear = (v) => {
      if (n === 0) return v;
      if (n === 1) return v <= 0 ? 0 : v ** samples[0];
      const x = Math.max(0, Math.min(1, v)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(x));
      return samples[i] + (samples[i + 1] - samples[i]) * (x - i);
    };
    // The inverse of a sampled curve is found by bisection: 12 steps gives an
    // error below one part in 4096, which is beyond 8-bit precision.
    const fromLinear = (target) => {
      let lo = 0, hi = 1;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (toLinear(mid) < target) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    return { name: 'Curve', toLinear, fromLinear, samples };
  },
};

/* ------------------------------------------------------------------ */
/* Built-in profiles                                                   */
/* ------------------------------------------------------------------ */

/**
 * The working spaces Pikado ships with.
 *
 * A profile here is `{id, name, space, white, primaries, trc}` and the matrix is
 * derived rather than stored, so the primaries stay readable and there is no
 * chance of the two disagreeing.
 */
export const BUILTIN_PROFILES = [
  {
    id: 'srgb',
    name: 'sRGB IEC61966-2.1',
    space: 'rgb',
    white: WHITE_POINTS.D65,
    primaries: { rx: 0.64, ry: 0.33, gx: 0.30, gy: 0.60, bx: 0.15, by: 0.06 },
    trc: TRC.srgb,
  },
  {
    id: 'adobe-rgb',
    name: 'Adobe RGB (1998)',
    space: 'rgb',
    white: WHITE_POINTS.D65,
    primaries: { rx: 0.64, ry: 0.33, gx: 0.21, gy: 0.71, bx: 0.15, by: 0.06 },
    trc: TRC.gamma(563 / 256),
  },
  {
    id: 'display-p3',
    name: 'Display P3',
    space: 'rgb',
    white: WHITE_POINTS.D65,
    primaries: { rx: 0.680, ry: 0.320, gx: 0.265, gy: 0.690, bx: 0.150, by: 0.060 },
    trc: TRC.srgb,
  },
  {
    id: 'prophoto',
    name: 'ProPhoto RGB',
    space: 'rgb',
    white: WHITE_POINTS.D50,
    primaries: { rx: 0.7347, ry: 0.2653, gx: 0.1596, gy: 0.8404, bx: 0.0366, by: 0.0001 },
    trc: TRC.gamma(1.8),
  },
  {
    id: 'rec2020',
    name: 'Rec. ITU-R BT.2020',
    space: 'rgb',
    white: WHITE_POINTS.D65,
    primaries: { rx: 0.708, ry: 0.292, gx: 0.170, gy: 0.797, bx: 0.131, by: 0.046 },
    trc: TRC.rec709,
  },
  {
    id: 'gray-22',
    name: 'Gray Gamma 2.2',
    space: 'gray',
    white: WHITE_POINTS.D65,
    trc: TRC.gamma(2.2),
  },
];

export const DEFAULT_PROFILE_ID = 'srgb';

export function getProfile(id) {
  return BUILTIN_PROFILES.find((p) => p.id === id) || null;
}

/** The document's profile, defaulting to sRGB — which is what 8-bit RGB is. */
export function profileOf(doc) {
  if (!doc) return getProfile(DEFAULT_PROFILE_ID);
  if (doc.profile && doc.profile.primaries) return doc.profile;
  if (typeof doc.profile === 'string') return getProfile(doc.profile) || getProfile(DEFAULT_PROFILE_ID);
  return getProfile(DEFAULT_PROFILE_ID);
}

/** The RGB → XYZ matrix for a profile, cached on it. */
export function matrixOf(profile) {
  if (!profile) return null;
  if (profile._matrix) return profile._matrix;
  const m = profile.matrix
    ? profile.matrix
    : profile.primaries ? primariesToMatrix(profile.primaries, profile.white || WHITE_POINTS.D65) : null;
  if (m) Object.defineProperty(profile, '_matrix', { value: m, enumerable: false, configurable: true });
  return m;
}

/* ------------------------------------------------------------------ */
/* Transforms                                                          */
/* ------------------------------------------------------------------ */

export const INTENTS = [
  { value: 'relative', label: 'Relative Colorimetric' },
  { value: 'absolute', label: 'Absolute Colorimetric' },
  { value: 'perceptual', label: 'Perceptual' },
  { value: 'saturation', label: 'Saturation' },
];

/**
 * Which intents a matrix/TRC profile can actually distinguish.
 *
 * Perceptual and Saturation are defined by tables a matrix profile does not have,
 * so they behave as Relative Colorimetric. `intentIsExact` is what the UI uses to
 * say so instead of implying four different results.
 */
export function intentIsExact(intent) {
  return intent === 'relative' || intent === 'absolute';
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Build a colour transform between two profiles.
 *
 * Relative colorimetric adapts the source white point to the destination's, so
 * white maps to white. Absolute does not, so a D50 document shown in a D65 space
 * keeps its warm cast — which is the point of it.
 *
 * Black point compensation scales the linear range so the source's black lands on
 * the destination's rather than being clipped. With two matrix profiles both
 * blacks are zero, so it is a no-op; it is kept because a parsed profile can carry
 * a real black point in its `bkpt` tag.
 *
 * @returns {(rgb:number[]) => number[]} 0..1 in, 0..1 out
 */
export function makeTransform(from, to, opts = {}) {
  const { intent = 'relative', blackPoint = true } = opts;
  const srcMatrix = matrixOf(from);
  const dstMatrix = matrixOf(to);
  const srcTRC = from.trc || TRC.srgb;
  const dstTRC = to.trc || TRC.srgb;

  // Grey profiles have no primaries: treat their single channel as luminance.
  const srcGray = from.space === 'gray' || !srcMatrix;
  const dstGray = to.space === 'gray' || !dstMatrix;

  /*
   * The white-point adaptation applies to ANY conversion that passes through XYZ,
   * which includes grey-to-RGB and RGB-to-grey. An earlier version guarded it with
   * `!srcGray && !dstGray`, so a D50 grey profile converted to sRGB skipped the
   * adaptation entirely and came back with a warm cast. It went unnoticed because
   * the only grey profile that ships is D65, the same white point as sRGB, so
   * every test of it compared two spaces that had nothing to adapt — the bug was
   * only reachable through an *embedded* grey profile, which ICC puts in D50.
   *
   * Grey-to-grey is the one case that genuinely skips it: nothing but luminance
   * survives the trip, and luminance is what the adaptation preserves.
   */
  let adapt = null;
  if (!(srcGray && dstGray) && intent !== 'absolute') {
    const sw = from.white || WHITE_POINTS.D65;
    const dw = to.white || WHITE_POINTS.D65;
    const same = Math.abs(sw[0] - dw[0]) < 1e-6 && Math.abs(sw[2] - dw[2]) < 1e-6;
    if (!same) adapt = adaptationMatrix(sw, dw);
  }
  const dstInv = dstGray ? null : invert3(dstMatrix);

  const srcBlack = blackPoint && from.blackPoint ? from.blackPoint : 0;
  const dstBlack = blackPoint && to.blackPoint ? to.blackPoint : 0;
  const scaleBlack = srcBlack !== dstBlack;

  return (rgb) => {
    // 1. encoded -> linear
    let lin;
    if (srcGray) {
      const g = srcTRC.toLinear(clamp01(rgb[0]));
      lin = [g, g, g];
    } else {
      lin = [srcTRC.toLinear(clamp01(rgb[0])), srcTRC.toLinear(clamp01(rgb[1])), srcTRC.toLinear(clamp01(rgb[2]))];
    }

    // 2. through XYZ, adapting the white point unless the intent says not to
    let out;
    if (srcGray && dstGray) {
      out = lin;
    } else {
      let xyz = srcGray
        ? [lin[0] * (from.white || WHITE_POINTS.D65)[0], lin[0], lin[0] * (from.white || WHITE_POINTS.D65)[2]]
        : mul3(srcMatrix, lin);
      if (adapt) xyz = mul3(adapt, xyz);
      out = dstGray ? [xyz[1], xyz[1], xyz[1]] : mul3(dstInv, xyz);
    }

    // 3. black point compensation, on the linear range
    if (scaleBlack) {
      for (let i = 0; i < 3; i++) {
        out[i] = dstBlack + (out[i] - srcBlack) * ((1 - dstBlack) / (1 - srcBlack));
      }
    }

    // 4. clip to the destination gamut, then re-encode
    if (dstGray) {
      const v = dstTRC.fromLinear(clamp01(out[0]));
      return [v, v, v];
    }
    return [
      dstTRC.fromLinear(clamp01(out[0])),
      dstTRC.fromLinear(clamp01(out[1])),
      dstTRC.fromLinear(clamp01(out[2])),
    ];
  };
}

/**
 * A 3×256³ transform is far too big; a per-channel table is not enough, because a
 * matrix mixes channels. So the transform runs per pixel, but memoised on the
 * exact 24-bit colour — real images have far fewer distinct colours than pixels,
 * and a flat area or a gradient hits the cache almost every time.
 *
 * @param {ImageData} image mutated in place
 */
export function transformImageData(image, from, to, opts = {}) {
  const fn = makeTransform(from, to, opts);
  const d = image.data;
  const cache = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let hit = cache.get(key);
    if (hit === undefined) {
      const out = fn([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
      hit = (Math.round(clamp01(out[0]) * 255) << 16)
        | (Math.round(clamp01(out[1]) * 255) << 8)
        | Math.round(clamp01(out[2]) * 255);
      cache.set(key, hit);
    }
    d[i] = (hit >> 16) & 0xff;
    d[i + 1] = (hit >> 8) & 0xff;
    d[i + 2] = hit & 0xff;
  }
  return image;
}

/**
 * Is a colour inside a profile's gamut?
 *
 * Answered by converting and checking whether anything had to be clipped, which
 * is what a gamut warning actually means.
 */
export function isInGamut(rgb, from, to, tolerance = 1 / 255) {
  const srcMatrix = matrixOf(from);
  const dstMatrix = matrixOf(to);
  if (!srcMatrix || !dstMatrix) return true;
  const srcTRC = from.trc || TRC.srgb;
  const lin = [srcTRC.toLinear(rgb[0]), srcTRC.toLinear(rgb[1]), srcTRC.toLinear(rgb[2])];
  let xyz = mul3(srcMatrix, lin);
  const sw = from.white || WHITE_POINTS.D65;
  const dw = to.white || WHITE_POINTS.D65;
  if (Math.abs(sw[0] - dw[0]) > 1e-6 || Math.abs(sw[2] - dw[2]) > 1e-6) {
    xyz = mul3(adaptationMatrix(sw, dw), xyz);
  }
  const out = mul3(invert3(dstMatrix), xyz);
  return out.every((v) => v >= -tolerance && v <= 1 + tolerance);
}

/* ------------------------------------------------------------------ */
/* ICC parsing                                                         */
/* ------------------------------------------------------------------ */

const s15Fixed = (dv, offset) => dv.getInt32(offset) / 65536;

/** Four-character tag signature at an offset. */
const sig = (bytes, offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

/**
 * Parse an ICC profile.
 *
 * Matrix/TRC profiles are converted into the same shape as the built-ins.
 * Anything else — a LUT profile, a CMYK profile, a truncated file — is *rejected
 * with a reason* rather than half-read: a profile that is silently misread
 * produces colour that is wrong in a way nobody can debug.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{ok:true, profile:object} | {ok:false, reason:string, description?:string}}
 */
export function parseICC(buffer) {
  // Every bound below is checked, but this is a parser for untrusted bytes and the
  // caller is a file-open handler: the contract is that it RETURNS a failure, so a
  // profile that finds a gap in the checks must not become an exception either.
  try {
    return parseICCInner(buffer);
  } catch (err) {
    return { ok: false, reason: `the profile could not be read (${(err && err.message) || err})` };
  }
}

function parseICCInner(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 132) return { ok: false, reason: 'the file is too short to be an ICC profile' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const size = dv.getUint32(0);
  if (sig(bytes, 36) !== 'acsp') return { ok: false, reason: 'this is not an ICC profile (no "acsp" signature)' };
  if (size > bytes.length) return { ok: false, reason: `the profile claims ${size} bytes but only ${bytes.length} are present` };

  const deviceClass = sig(bytes, 12);
  const dataSpace = sig(bytes, 16);
  const pcs = sig(bytes, 20);

  const tagCount = dv.getUint32(128);
  if (132 + tagCount * 12 > bytes.length) return { ok: false, reason: 'the tag table runs past the end of the file' };
  /*
   * Every tag's extent is checked against the buffer HERE, once, so nothing
   * downstream has to. The offsets and sizes come from the file, which is
   * untrusted: a tag claiming to start at 4 GB or to be 2 GB long is a
   * two-line edit away in any hex editor, and the readers below index straight
   * off `tag.offset`. A tag that does not fit is dropped rather than trusted,
   * which degrades to "profile has no rXYZ" — a clean rejection — instead of a
   * RangeError thrown out of a file-open handler.
   */
  const tags = new Map();
  let droppedTags = 0;
  for (let i = 0; i < tagCount; i++) {
    const at = 132 + i * 12;
    const offset = dv.getUint32(at + 4);
    const size = dv.getUint32(at + 8);
    if (offset < 128 || size < 8 || offset + size > bytes.length) { droppedTags++; continue; }
    tags.set(sig(bytes, at), { offset, size });
  }
  if (droppedTags) console.info(`[icc] ${droppedTags} tag(s) pointed outside the file and were ignored`);

  const description = readTextTag(bytes, dv, tags.get('desc')) || 'Embedded profile';

  if (dataSpace !== 'RGB ' && dataSpace !== 'GRAY') {
    return { ok: false, reason: `${dataSpace.trim()} profiles are not supported — only RGB and grey`, description };
  }
  if (pcs !== 'XYZ ' && pcs !== 'Lab ') {
    return { ok: false, reason: `an unexpected connection space (${pcs.trim()})`, description };
  }

  /* --- grey --- */
  if (dataSpace === 'GRAY') {
    const trc = readCurveTag(bytes, dv, tags.get('kTRC'));
    if (!trc) return { ok: false, reason: 'the grey profile has no tone curve (kTRC)', description };
    return {
      ok: true,
      profile: {
        id: 'embedded', name: description, space: 'gray',
        white: readXYZTag(dv, tags.get('wtpt')) || WHITE_POINTS.D50,
        trc, embedded: true, deviceClass,
      },
    };
  }

  /* --- RGB matrix/TRC --- */
  const r = readXYZTag(dv, tags.get('rXYZ'));
  const g = readXYZTag(dv, tags.get('gXYZ'));
  const b = readXYZTag(dv, tags.get('bXYZ'));
  if (!r || !g || !b) {
    const lut = tags.has('A2B0') || tags.has('B2A0');
    return {
      ok: false,
      description,
      reason: lut
        ? 'this is a LUT-based profile; Pikado reads matrix/TRC profiles only'
        : 'the profile has no primary colorant tags (rXYZ/gXYZ/bXYZ)',
    };
  }

  // Per-channel curves are allowed to differ, but a single TRC covers every
  // profile in practice and mixing three curves into one transform would need a
  // per-channel path everywhere. Take the red curve and say so if they differ.
  const rTRC = readCurveTag(bytes, dv, tags.get('rTRC'));
  const gTRC = readCurveTag(bytes, dv, tags.get('gTRC'));
  const bTRC = readCurveTag(bytes, dv, tags.get('bTRC'));
  if (!rTRC) return { ok: false, reason: 'the profile has no tone curve (rTRC)', description };
  const perChannel = !!(gTRC && bTRC
    && (JSON.stringify(rTRC.samples) !== JSON.stringify(gTRC.samples)
      || JSON.stringify(rTRC.samples) !== JSON.stringify(bTRC.samples)));

  // The colorant tags are relative to the profile connection space, which for an
  // ICC v2/v4 matrix profile is always D50 — the wtpt tag records the *media*
  // white, not the space the matrix is in.
  const matrix = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];

  return {
    ok: true,
    profile: {
      id: 'embedded',
      name: description,
      space: 'rgb',
      white: WHITE_POINTS.D50,
      matrix,
      trc: rTRC,
      perChannelTRC: perChannel,
      embedded: true,
      deviceClass,
    },
  };
}

function readXYZTag(dv, tag) {
  if (!tag || tag.size < 20) return null;
  const at = tag.offset;
  return [s15Fixed(dv, at + 8), s15Fixed(dv, at + 12), s15Fixed(dv, at + 16)];
}

/**
 * A `curv` or `para` tone curve.
 *
 * `curv` with a count of 0 is the identity, with a count of 1 a gamma in u8Fixed8,
 * and otherwise a table of uint16 samples. `para` is a parametric function; types
 * 0–4 are defined, and 3 is the sRGB shape.
 */
function readCurveTag(bytes, dv, tag) {
  if (!tag || tag.size < 12) return null;
  const type = sig(bytes, tag.offset);
  if (type === 'curv') {
    const count = dv.getUint32(tag.offset + 8);
    if (count === 0) return TRC.gamma(1);
    if (count === 1) {
      if (tag.size < 14) return null;
      return TRC.gamma(dv.getUint16(tag.offset + 12) / 256);
    }
    // The count comes from the file and is not otherwise bounded: a declared
    // count of 0xffffffff would allocate 16 GB and then read past the buffer.
    // A curve is 12 bytes of header plus two per sample, so the tag's own size
    // is the bound.
    const available = Math.floor((tag.size - 12) / 2);
    if (available < 2) return null;
    const n = Math.min(count, available);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = dv.getUint16(tag.offset + 12 + i * 2) / 65535;
    if (n !== count) console.info(`[icc] a curve declared ${count} samples but only ${n} fit its tag`);
    return TRC.table(samples);
  }
  if (type === 'para') {
    const fnType = dv.getUint16(tag.offset + 8);
    const p = [];
    const counts = [1, 3, 4, 5, 7];
    const n = counts[fnType] ?? 0;
    if (!n || tag.size < 12 + n * 4) return null;
    for (let i = 0; i < n; i++) p.push(s15Fixed(dv, tag.offset + 12 + i * 4));
    return parametricCurve(fnType, p);
  }
  return null;
}

/** ICC parametric curve types 0–4. */
function parametricCurve(type, p) {
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (type === 0) return TRC.gamma(p[0] || 1);
  if (type === 3) {
    // The sRGB shape: y = ((a·x + b)^g) for x >= d, else c·x
    const [g, a, b, c, d] = p;
    const toLinear = (x) => (x >= d ? (a * clamp(x) + b) ** g : c * clamp(x));
    const fromLinear = (y) => {
      // Invert by bisection — the closed form has edge cases around d.
      let lo = 0, hi = 1;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (toLinear(mid) < y) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    return { name: 'Parametric sRGB', toLinear, fromLinear };
  }
  // Types 1, 2 and 4 are rarer; approximate by their gamma, which is the term
  // that dominates, rather than refusing the whole profile over a tone curve.
  return TRC.gamma(p[0] || 1);
}

/** `desc` (ICC v2) or `mluc` (v4) text. */
function readTextTag(bytes, dv, tag) {
  if (!tag || tag.size < 12) return null;
  const type = sig(bytes, tag.offset);
  if (type === 'desc') {
    const len = Math.min(dv.getUint32(tag.offset + 8), tag.size - 12);
    let out = '';
    for (let i = 0; i < len - 1 && i < tag.size; i++) {
      const ch = bytes[tag.offset + 12 + i];
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out.trim() || null;
  }
  if (type === 'mluc') {
    if (tag.size < 28) return null;
    const count = dv.getUint32(tag.offset + 8);
    if (!count) return null;
    const len = dv.getUint32(tag.offset + 20);
    const off = dv.getUint32(tag.offset + 24);
    // `off` and `len` are relative to the tag and come from the file: both have
    // to land inside it before a single character is read.
    if (off + len > tag.size) return null;
    let out = '';
    for (let i = 0; i + 1 < len; i += 2) out += String.fromCharCode(dv.getUint16(tag.offset + off + i));
    return out.replace(/\0+$/, '').trim() || null;
  }
  if (type === 'text') {
    let out = '';
    for (let i = 8; i < tag.size; i++) {
      const ch = bytes[tag.offset + i];
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out.trim() || null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Finding an embedded profile in a file                               */
/* ------------------------------------------------------------------ */

/**
 * Extract an embedded ICC profile from JPEG or PNG bytes.
 *
 * JPEG puts it in one or more APP2 segments introduced by `ICC_PROFILE\0`, which
 * have to be concatenated in sequence order. PNG puts it in an `iCCP` chunk,
 * zlib-deflated — and there is no way to inflate it without a decompressor, so
 * that case is reported honestly rather than half-handled. (`DecompressionStream`
 * exists in modern browsers, so it is used where available.)
 *
 * @returns {Promise<Uint8Array|null>}
 */
export async function extractEmbeddedProfile(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8) return extractFromJPEG(b);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return extractFromPNG(b);
  return null;
}

function extractFromJPEG(b) {
  const chunks = [];
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;          // start of scan / end
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe2) {
      const start = i + 4;
      let name = '';
      for (let k = 0; k < 11; k++) name += String.fromCharCode(b[start + k]);
      if (name === 'ICC_PROFILE') {
        const seq = b[start + 12];
        chunks.push({ seq, data: b.subarray(start + 14, i + 2 + len) });
      }
    }
    i += 2 + len;
  }
  if (!chunks.length) return null;
  chunks.sort((x, y) => x.seq - y.seq);
  const total = chunks.reduce((n, c) => n + c.data.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c.data, at); at += c.data.length; }
  return out;
}

async function extractFromPNG(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i);
    // A chunk length of 0xffffffff would overflow `i` into a negative number and
    // loop forever; one longer than the file is malformed either way.
    if (len > b.length) return null;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'iCCP') {
      // `len` is the chunk length the FILE declares. Bound the scan by the real
      // buffer as well, or a chunk claiming to be longer than the file walks off
      // the end of it.
      const end = Math.min(i + 8 + len, b.length);
      let at = i + 8;
      while (at < end && b[at] !== 0) at++;            // profile name
      if (at + 2 >= end) return null;
      const method = b[at + 1];
      const payload = b.subarray(at + 2, end);
      if (method !== 0) return null;
      if (typeof DecompressionStream !== 'function') return null;
      try {
        const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        return null;
      }
    }
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}
