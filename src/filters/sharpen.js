/**
 * Filter > Sharpen.
 *
 * Every entry here is an unsharp mask: the difference between the image and a
 * blurred copy of it is scaled and added back. The blur runs premultiplied so
 * a soft alpha edge does not grow a dark halo; alpha itself is never touched,
 * which is what Photoshop does too.
 */

import { registerFilter } from './registry.js';
import {
  premultiplyImageData,
  convolveBuffer,
  gaussianBlurBuffer,
  discBlurBuffer,
  motionBlurBuffer,
  luminancePlane,
  sobelMagnitude,
} from './blur.js';

const SOFT3 = new Float32Array([0.25, 0.5, 0.25]);

/**
 * Core unsharp pass.
 * @param {ImageData} imageData
 * @param {(buf: Float32Array, w: number, h: number) => void} blurFn in-place
 *   blur of the premultiplied buffer
 * @param {number} amount multiplier applied to the high-pass difference
 * @param {number} hardThreshold differences below this are discarded outright
 * @param {number} softThreshold differences are shrunk by this before scaling
 * @param {Float32Array|null} [gate] per-pixel 0..1 multiplier on `amount`
 */
function unsharpPass(imageData, blurFn, amount, hardThreshold, softThreshold, gate) {
  const w = imageData.width, h = imageData.height, d = imageData.data;
  const buf = premultiplyImageData(imageData);
  blurFn(buf, w, h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = buf[i + 3];
    if (a <= 0.4) continue;
    const g = gate ? gate[p] : 1;
    if (g <= 0) continue;
    const inv = 255 / a;
    let dr = d[i] - buf[i] * inv;
    let dg = d[i + 1] - buf[i + 1] * inv;
    let db = d[i + 2] - buf[i + 2] * inv;
    if (hardThreshold > 0) {
      if (dr > -hardThreshold && dr < hardThreshold) dr = 0;
      if (dg > -hardThreshold && dg < hardThreshold) dg = 0;
      if (db > -hardThreshold && db < hardThreshold) db = 0;
    }
    if (softThreshold > 0) {
      dr = dr > softThreshold ? dr - softThreshold : dr < -softThreshold ? dr + softThreshold : 0;
      dg = dg > softThreshold ? dg - softThreshold : dg < -softThreshold ? dg + softThreshold : 0;
      db = db > softThreshold ? db - softThreshold : db < -softThreshold ? db + softThreshold : 0;
    }
    const k = amount * g;
    d[i] = d[i] + dr * k;
    d[i + 1] = d[i + 1] + dg * k;
    d[i + 2] = d[i + 2] + db * k;
  }
}

const soft3Blur = (buf, w, h) => convolveBuffer(buf, w, h, SOFT3, 4);

registerFilter({
  id: 'sharpen',
  name: 'Sharpen',
  menu: 'Sharpen',
  params: [],
  needsDialog: false,
  apply(imageData) {
    unsharpPass(imageData, soft3Blur, 1, 0, 0, null);
  },
});

registerFilter({
  id: 'sharpen-more',
  name: 'Sharpen More',
  menu: 'Sharpen',
  params: [],
  needsDialog: false,
  apply(imageData) {
    unsharpPass(imageData, soft3Blur, 2.6, 0, 0, null);
  },
});

registerFilter({
  id: 'sharpen-edges',
  name: 'Sharpen Edges',
  menu: 'Sharpen',
  params: [],
  needsDialog: false,
  apply(imageData) {
    const w = imageData.width, h = imageData.height;
    const n = w * h;
    const mag = sobelMagnitude(luminancePlane(imageData.data, n), w, h);
    // Ramp in over a low-contrast band so flat areas (and their noise) are
    // left completely alone.
    const gate = new Float32Array(n);
    const lo = 6, hi = 26;
    for (let i = 0; i < n; i++) {
      const t = (mag[i] - lo) / (hi - lo);
      gate[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    }
    unsharpPass(imageData, soft3Blur, 2.2, 0, 0, gate);
  },
});

registerFilter({
  id: 'unsharp-mask',
  name: 'Unsharp Mask...',
  menu: 'Sharpen',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: 1, max: 500, step: 1, default: 100, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'slider', min: 0.1, max: 250, step: 0.1, default: 1.5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'slider', min: 0, max: 255, step: 1, default: 0, unit: 'levels' },
  ],
  apply(imageData, p) {
    const sigma = p.radius;
    unsharpPass(
      imageData,
      (buf, w, h) => gaussianBlurBuffer(buf, w, h, sigma, 4),
      p.amount / 100,
      p.threshold,
      0,
      null
    );
  },
});

registerFilter({
  id: 'smart-sharpen',
  name: 'Smart Sharpen...',
  menu: 'Sharpen',
  dialogWidth: 420,
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: 1, max: 500, step: 1, default: 150, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'slider', min: 0.1, max: 64, step: 0.1, default: 1.5, unit: 'px' },
    { key: 'reduceNoise', label: 'Reduce Noise', type: 'slider', min: 0, max: 100, step: 1, default: 20, unit: '%' },
    { key: 'remove', label: 'Remove', type: 'select', default: 'gaussian', options: [
      { value: 'gaussian', label: 'Gaussian Blur' },
      { value: 'lens', label: 'Lens Blur' },
      { value: 'motion', label: 'Motion Blur' },
    ] },
    { key: 'angle', label: 'Angle', type: 'angle', min: -360, max: 360, step: 1, default: 0,
      when: (s) => s.remove === 'motion' },
  ],
  apply(imageData, p) {
    const radius = p.radius;
    const angle = p.angle;
    let blurFn;
    if (p.remove === 'lens') {
      blurFn = (buf, w, h) => discBlurBuffer(buf, w, h, Math.max(1, radius), 4);
    } else if (p.remove === 'motion') {
      blurFn = (buf, w, h) => motionBlurBuffer(buf, w, h, angle, Math.max(2, radius * 2), 4);
    } else {
      blurFn = (buf, w, h) => gaussianBlurBuffer(buf, w, h, radius, 4);
    }
    // "Reduce Noise" is a soft threshold: small differences (grain) shrink to
    // nothing while real edges keep almost all of their contrast.
    unsharpPass(imageData, blurFn, p.amount / 100, 0, (p.reduceNoise / 100) * 22, null);
  },
});
