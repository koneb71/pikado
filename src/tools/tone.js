import { registerTool } from './base.js';
import { EffectStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { clamp255 } from '../core/util.js';
import { luminance } from '../core/color.js';
import { BrushToolBase, tweakDefaults } from './brush.js';

/**
 * Toning tools: Dodge, Burn and Sponge.
 */

const TONE_OPTIONS = () => brushOptionDescriptors({ opacity: false, flow: false });

const RANGE_OPTIONS = [
  { value: 'shadows', label: 'Shadows' },
  { value: 'midtones', label: 'Midtones' },
  { value: 'highlights', label: 'Highlights' },
];

/** How strongly a pixel of luminance `l` (0..1) belongs to a tonal range. */
function rangeWeight(range, l) {
  if (range === 'shadows') return Math.exp(-(l * l) / (2 * 0.32 * 0.32));
  if (range === 'highlights') {
    const t = 1 - l;
    return Math.exp(-(t * t) / (2 * 0.32 * 0.32));
  }
  const t = l - 0.5;
  return Math.exp(-(t * t) / (2 * 0.26 * 0.26));
}

/* ================================================================== */
/* Dodge / Burn                                                        */
/* ================================================================== */

class ToneTool extends BrushToolBase {
  /** @param {'dodge'|'burn'} kind */
  constructor(kind, opts) {
    super({
      ...opts,
      cursor: 'crosshair', shortcut: 'O', group: 'tone', groupOrder: 13,
      options: [
        ...tweakDefaults(TONE_OPTIONS(), { size: 60, hardness: 0 }),
        { key: 'range', label: 'Range', type: 'select', options: RANGE_OPTIONS, default: 'midtones' },
        { key: 'exposure', label: 'Exposure', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
        { key: 'protectTones', label: 'Protect Tones', type: 'checkbox', default: true },
      ],
    });
    this.kind = kind;
  }

  makeStroke(e, doc, layer) {
    const kind = this.kind;
    const range = this.state.range;
    const protect = this.state.protectTones;

    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.14 }),
      strength: this.state.exposure / 100,
      op: (region, meta) => {
        const d = region.data;
        // Each dab only nudges: dodging builds up as you keep painting.
        const base = meta.strength * 0.3;
        if (base <= 0.0005) return region;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const l = luminance(r, g, b) / 255;
          const a = base * rangeWeight(range, l);
          if (a <= 0.0005) continue;

          if (protect) {
            const nl = kind === 'dodge' ? l + (1 - l) * a : l * (1 - a);
            const scale = nl / Math.max(l, 1 / 255);
            d[i] = clamp255(r * scale);
            d[i + 1] = clamp255(g * scale);
            d[i + 2] = clamp255(b * scale);
          } else if (kind === 'dodge') {
            d[i] = clamp255(r + (255 - r) * a);
            d[i + 1] = clamp255(g + (255 - g) * a);
            d[i + 2] = clamp255(b + (255 - b) * a);
          } else {
            d[i] = clamp255(r * (1 - a));
            d[i + 1] = clamp255(g * (1 - a));
            d[i + 2] = clamp255(b * (1 - a));
          }
        }
        return region;
      },
    });
  }
}

registerTool(new ToneTool('dodge', {
  id: 'dodge', name: 'Dodge Tool', icon: 'dodge', strokeLabel: 'Dodge',
}));

registerTool(new ToneTool('burn', {
  id: 'burn', name: 'Burn Tool', icon: 'burn', strokeLabel: 'Burn',
}));

/* ================================================================== */
/* Sponge                                                              */
/* ================================================================== */

class SpongeTool extends BrushToolBase {
  constructor() {
    super({
      id: 'sponge', name: 'Sponge Tool', icon: 'sponge', cursor: 'crosshair', shortcut: 'O',
      group: 'tone', groupOrder: 13,
      strokeLabel: 'Sponge',
      options: [
        ...tweakDefaults(TONE_OPTIONS(), { size: 60, hardness: 0 }),
        { key: 'mode', label: 'Mode', type: 'select', default: 'desaturate',
          options: [
            { value: 'saturate', label: 'Saturate' },
            { value: 'desaturate', label: 'Desaturate' },
          ] },
        { key: 'flow', label: 'Flow', type: 'slider', min: 1, max: 100, step: 1, default: 50, unit: '%' },
        { key: 'vibrance', label: 'Vibrance', type: 'checkbox', default: true },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    const saturate = this.state.mode === 'saturate';
    const vibrance = this.state.vibrance;

    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.14 }),
      strength: this.state.flow / 100,
      op: (region, meta) => {
        const d = region.data;
        const base = meta.strength * 0.3;
        if (base <= 0.0005) return region;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          let a = base;
          if (vibrance) {
            // Leave already-vivid colours alone when saturating, and barely
            // touch near-grey pixels when desaturating.
            a *= saturate ? 1 - sat * 0.85 : 0.15 + 0.85 * sat;
          }
          if (a <= 0.0005) continue;
          const k = saturate ? 1 + a : 1 - a;
          const l = luminance(r, g, b);
          d[i] = clamp255(l + (r - l) * k);
          d[i + 1] = clamp255(l + (g - l) * k);
          d[i + 2] = clamp255(l + (b - l) * k);
        }
        return region;
      },
    });
  }
}

registerTool(new SpongeTool());
