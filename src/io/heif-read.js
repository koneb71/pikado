import { createCanvas, ctx2d } from '../core/util.js';
import { tr } from '../core/i18n.js';
import { heifColour } from './heif-info.js';
import { parseICC, getProfile, transformImageData } from '../color/icc.js';
// A URL, not a module: see `loadLibheif`.
import libheifUrl from 'libheif-js/libheif-wasm/libheif-bundle.mjs?url';

/**
 * Reading HEIC / HEIF — the format every iPhone has shot in since iOS 11.
 *
 * Only Safari can decode one natively, so `src/io/decode.js` tries the browser
 * first and comes here when it fails. The pixels are decoded by **libheif**
 * (libheif-js: libheif + libde265 compiled to WebAssembly), loaded on demand: it
 * is about 2 MB, nothing else in Pikado needs it, and a user who never opens a
 * HEIC never downloads it. Grids (an iPhone photo is 48 tiles of 512x512),
 * rotation, mirroring, clean-aperture crops and alpha planes are all libheif's
 * job, and it does them before handing back pixels.
 *
 * What libheif does *not* do is colour management, and that is the part worth
 * getting right. A browser decoding a JPEG with a Display P3 profile hands back
 * sRGB pixels; libheif hands back the P3 numbers untouched. Left alone, every
 * iPhone photo would open visibly duller than the same photo as a JPEG. So the
 * pixels are converted to sRGB here, with the same ICC engine Convert to Profile
 * uses, and from there the document is treated exactly like an opened JPEG: it
 * is sRGB, and `noteSourceProfile` records the profile it came from. One photo,
 * one result, whichever format it arrived in.
 *
 * The colour information comes from `heif-info.js`, which reads the container
 * without decoding anything.
 *
 * Not opened, deliberately: the HDR gain map and depth/matte auxiliary images an
 * iPhone also stores (the SDR primary image is the photo), and every image but
 * the primary one in a burst or sequence.
 */

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

let libheifPromise = null;

/**
 * libheif, initialised once. The import is the whole cost — the WebAssembly is
 * inlined in the module — so a failed load is forgotten and retried next time,
 * which is what a user who opened a HEIC while offline would want.
 *
 * It is shipped as a file and imported by URL rather than bundled. Bundled, the
 * chunker was free to park its own shared helpers inside the 2 MB chunk, and
 * did — which made every page load fetch the decoder. As a plain asset it is
 * outside the module graph entirely, it is the npm package's file byte for
 * byte (the LGPL asks that it stay replaceable), and it still gets a content
 * hash, so the service worker and nginx cache it like any other asset.
 */
function loadLibheif() {
  if (!libheifPromise) {
    libheifPromise = import(/* @vite-ignore */ libheifUrl)
      .then(async (mod) => {
        const lib = await mod.default();
        if (lib && lib.ready && typeof lib.ready.then === 'function') await lib.ready;
        return lib;
      })
      .catch((err) => {
        libheifPromise = null;
        throw err;
      });
  }
  return libheifPromise;
}

/**
 * Decode a HEIC/HEIF to an sRGB canvas with libheif.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} source
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function decodeHEIF(source) {
  const bytes = source instanceof Uint8Array
    ? source
    : new Uint8Array(source instanceof Blob ? await source.arrayBuffer() : source);

  let lib;
  try {
    lib = await loadLibheif();
  } catch (err) {
    console.error('[heif] libheif failed to load', err);
    throw new Error(tr('the HEIC decoder could not be loaded — check your connection and try again'));
  }

  const decoder = new lib.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes) || [];
  } catch (err) {
    console.error('[heif] decode failed', err);
  }
  if (!images.length) throw new Error(tr('this HEIC file has no image the decoder can read'));

  try {
    const image = images.find((im) => typeof im.is_primary === 'function' && im.is_primary()) || images[0];
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error(tr('the image has no pixels'));
    const data = new ImageData(width, height);
    await new Promise((resolve, reject) => {
      image.display(data, (out) => (out ? resolve() : reject(new Error(tr('the HEIC image could not be decoded')))));
    });
    toSRGB(data, heifColour(bytes));
    const canvas = createCanvas(width, height);
    ctx2d(canvas).putImageData(data, 0, 0);
    return canvas;
  } finally {
    for (const im of images) {
      try { im.free(); } catch (err) { /* already freed */ }
    }
  }
}

/**
 * nclx colour primaries this can convert from, by ISO/IEC 23091-2 code. Anything
 * else — including 1 (BT.709, which *is* sRGB's) and 2 (unspecified) — is taken
 * as sRGB, which is what the browser would assume of an untagged image too.
 */
const NCLX_PRIMARIES = { 9: 'rec2020', 12: 'display-p3' };

/**
 * Convert decoded pixels from the file's colour space into sRGB, in place.
 *
 * An ICC profile wins over nclx: it is the more exact description, and it is
 * what Apple writes. A profile that cannot be read leaves the pixels alone —
 * the same quiet fallback a JPEG with an unreadable profile gets.
 */
function toSRGB(data, colour) {
  if (!colour) return;
  let from = null;
  if (colour.icc) {
    const parsed = parseICC(colour.icc);
    if (parsed.ok && parsed.profile.space === 'rgb') from = parsed.profile;
  } else if (colour.nclx && colour.nclx.transfer !== 16 && colour.nclx.transfer !== 18) {
    // 16 and 18 are PQ and HLG: HDR, which an 8-bit document cannot hold. A
    // primaries conversion on top of a tone curve it does not model would only
    // be a second wrong, so those are left as libheif decoded them.
    const id = NCLX_PRIMARIES[colour.nclx.primaries];
    from = id ? getProfile(id) : null;
  }
  if (from) transformImageData(data, from, getProfile('srgb'));
}
