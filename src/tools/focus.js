import { registerTool } from './base.js';
import { app } from '../core/app.js';
import { EffectStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { clamp, clamp255 } from '../core/util.js';
import { BrushToolBase, tweakDefaults, blurImageData } from './brush.js';

/**
 * Focus tools: Blur, Sharpen and Smudge.
 *
 * All three are EffectStrokes — they transform the pixels already on the layer
 * rather than laying colour down, and the brush tip supplies the coverage
 * mask, so soft brushes fade the effect at the edges.
 */

const FOCUS_OPTIONS = () => brushOptionDescriptors({ opacity: false, flow: false, airbrush: false });

/* ================================================================== */
/* Blur                                                                */
/* ================================================================== */

class BlurTool extends BrushToolBase {
  constructor() {
    super({
      id: 'blur', name: 'Blur Tool', icon: 'blur', cursor: 'crosshair', shortcut: 'R',
      group: 'focus', groupOrder: 12,
      strokeLabel: 'Blur',
      options: [
        ...tweakDefaults(FOCUS_OPTIONS(), { size: 40, hardness: 0 }),
        { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.25 }),
      strength: this.state.strength / 100,
      op: (region, meta) => {
        const sigma = 0.35 + (meta.size / 2) * 0.3 * meta.strength;
        if (sigma <= 0.1) return region;
        const blurred = blurImageData(region, sigma);
        region.data.set(blurred.data);
        return region;
      },
    });
  }
}

registerTool(new BlurTool());

/* ================================================================== */
/* Sharpen                                                             */
/* ================================================================== */

class SharpenTool extends BrushToolBase {
  constructor() {
    super({
      id: 'sharpen', name: 'Sharpen Tool', icon: 'sharpen', cursor: 'crosshair', shortcut: 'R',
      group: 'focus', groupOrder: 12,
      strokeLabel: 'Sharpen',
      options: [
        ...tweakDefaults(FOCUS_OPTIONS(), { size: 40, hardness: 0 }),
        { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
        { key: 'protectDetail', label: 'Protect Detail', type: 'checkbox', default: true,
          hint: 'Softer radius that resists halos and noise' },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    const protect = this.state.protectDetail;
    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.25 }),
      strength: this.state.strength / 100,
      op: (region, meta) => {
        const amount = meta.strength * (protect ? 1.1 : 2.4);
        if (amount <= 0.001) return region;
        // Unsharp mask: original + amount * (original - blurred).
        const sigma = protect ? 1.4 : 0.9;
        const blurred = blurImageData(region, sigma).data;
        const d = region.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          d[i] = clamp255(d[i] + (d[i] - blurred[i]) * amount);
          d[i + 1] = clamp255(d[i + 1] + (d[i + 1] - blurred[i + 1]) * amount);
          d[i + 2] = clamp255(d[i + 2] + (d[i + 2] - blurred[i + 2]) * amount);
        }
        return region;
      },
    });
  }
}

registerTool(new SharpenTool());

/* ================================================================== */
/* Smudge                                                              */
/* ================================================================== */

class SmudgeTool extends BrushToolBase {
  constructor() {
    super({
      id: 'smudge', name: 'Smudge Tool', icon: 'smudge', cursor: 'crosshair', shortcut: 'R',
      group: 'focus', groupOrder: 12,
      strokeLabel: 'Smudge',
      options: [
        ...tweakDefaults(FOCUS_OPTIONS(), { size: 40, hardness: 0, smoothing: 30 }),
        { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
        { key: 'fingerPainting', label: 'Finger Painting', type: 'checkbox', default: false,
          hint: 'Start the smear with the foreground colour' },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    const fingerPainting = this.state.fingerPainting;
    const fg = app.foreground;

    /**
     * The "finger": the pixels picked up by the previous dab, indexed relative
     * to the dab centre they were captured at. Reading them back at the same
     * offset from the *new* dab centre is what drags colour along the stroke —
     * the finger hands over the pixels the brush is coming FROM. `x/y` are the
     * clipped rect origin so an edge-clipped dab still lines up.
     * @type {{x:number,y:number,cx:number,cy:number,w:number,h:number,data:Float32Array}|null}
     */
    let finger = null;

    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      // A steady tip keeps the finger buffer aligned dab to dab.
      brush: brushFromOptions(this.state, { flow: 1, pressureSize: false, sizeJitter: 0, scatter: 0, spacing: 0.06 }),
      strength: this.state.strength / 100,
      op: (region, meta) => {
        const w = region.width, h = region.height, d = region.data;
        const rx = meta.rectX, ry = meta.rectY;
        const cx = Math.round(meta.x), cy = Math.round(meta.y);
        const k = clamp(meta.strength, 0, 0.97);
        const next = new Float32Array(w * h * 4);

        // Local -> finger index shift. Both rects are anchored on their own dab
        // centre, so this is 0 for an unclipped dab and only compensates for
        // clipping at the document edge; it never re-aligns the two dabs onto
        // the same absolute pixel (which would make the smear a no-op).
        const ox = finger ? (rx - cx) - (finger.x - finger.cx) : 0;
        const oy = finger ? (ry - cy) - (finger.y - finger.cy) : 0;

        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const p = (j * w + i) * 4;
            const ca = d[p + 3] / 255;
            const cr = d[p] * ca, cg = d[p + 1] * ca, cb = d[p + 2] * ca, cA = d[p + 3];

            let or_, og, ob, oa;
            if (!finger) {
              if (fingerPainting) { or_ = fg.r; og = fg.g; ob = fg.b; oa = 255; }
              else { or_ = cr; og = cg; ob = cb; oa = cA; }
            } else {
              const fx = i + ox, fy = j + oy;
              if (fx >= 0 && fy >= 0 && fx < finger.w && fy < finger.h) {
                const q = (fy * finger.w + fx) * 4;
                or_ = finger.data[q]; og = finger.data[q + 1]; ob = finger.data[q + 2]; oa = finger.data[q + 3];
              } else {
                or_ = cr; og = cg; ob = cb; oa = cA;
              }
            }

            const nr = or_ * k + cr * (1 - k);
            const ng = og * k + cg * (1 - k);
            const nb = ob * k + cb * (1 - k);
            const na = oa * k + cA * (1 - k);

            next[p] = nr; next[p + 1] = ng; next[p + 2] = nb; next[p + 3] = na;

            const a = na / 255;
            d[p] = a > 0.0015 ? clamp255(nr / a) : 0;
            d[p + 1] = a > 0.0015 ? clamp255(ng / a) : 0;
            d[p + 2] = a > 0.0015 ? clamp255(nb / a) : 0;
            d[p + 3] = clamp255(na);
          }
        }
        finger = { x: rx, y: ry, cx, cy, w, h, data: next };
        return region;
      },
    });
  }
}

registerTool(new SmudgeTool());
