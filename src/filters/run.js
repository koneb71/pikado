import { createCanvas, cloneCanvas, imageDataToCanvas } from '../core/util.js';
import { getFilter, runFilter } from './registry.js';
import { getAdjustment, applyAdjustment } from '../adjustments/registry.js';
import { setLayerPreview } from '../render/compositor.js';
import { paramDialog } from '../ui/dialog.js';
import { app } from '../core/app.js';

/**
 * Runs filters and destructive adjustments against a layer, honouring the
 * active selection, layer masks and the "editing the mask" state.
 *
 * Filters never see the selection themselves — they process a rectangular
 * region and this module blends the result back through the selection mask.
 */

/** The surface a pixel operation should modify for the given layer. */
export function operableSurface(doc, layer) {
  if (!layer) return null;
  if (layer.editingMask && layer.mask) return { canvas: layer.mask, isMask: true };
  if (layer.type === 'adjustment' || layer.type === 'group') {
    return layer.mask ? { canvas: layer.mask, isMask: true } : null;
  }
  return layer.canvas ? { canvas: layer.canvas, isMask: false } : null;
}

/**
 * The rectangle a pixel op should touch: the selection bounds, clipped to the
 * document. Returns the full canvas when nothing is selected.
 */
export function operableRect(doc) {
  const b = doc.selection.active ? doc.selection.bounds() : null;
  if (!b) return { x: 0, y: 0, width: doc.width, height: doc.height };
  return b;
}

/**
 * Produce the processed canvas for a layer without touching the document.
 * @returns {HTMLCanvasElement|null}
 */
export function processSurface(doc, layer, processImageData) {
  const surf = operableSurface(doc, layer);
  if (!surf) return null;
  const src = surf.canvas;
  const rect = operableRect(doc);
  if (rect.width <= 0 || rect.height <= 0) return null;

  const sctx = src.getContext('2d', { willReadFrequently: true });
  const region = sctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  const original = new ImageData(new Uint8ClampedArray(region.data), region.width, region.height);

  let result = processImageData(region, { doc, layer, rect, isMask: surf.isMask });
  if (!(result instanceof ImageData)) result = region;

  // Blend back through the selection coverage.
  if (doc.selection.active) {
    const mask = doc.selection.mask;
    const rd = result.data, od = original.data;
    for (let y = 0; y < rect.height; y++) {
      const my = (y + rect.y) * doc.width + rect.x;
      for (let x = 0; x < rect.width; x++) {
        const cov = mask[my + x] / 255;
        if (cov >= 1) continue;
        const i = (y * rect.width + x) * 4;
        if (cov <= 0) {
          rd[i] = od[i]; rd[i + 1] = od[i + 1]; rd[i + 2] = od[i + 2]; rd[i + 3] = od[i + 3];
        } else {
          rd[i] = od[i] + (rd[i] - od[i]) * cov;
          rd[i + 1] = od[i + 1] + (rd[i + 1] - od[i + 1]) * cov;
          rd[i + 2] = od[i + 2] + (rd[i + 2] - od[i + 2]) * cov;
          rd[i + 3] = od[i + 3] + (rd[i + 3] - od[i + 3]) * cov;
        }
      }
    }
  }

  const out = createCanvas(src.width, src.height);
  const octx = out.getContext('2d');
  octx.drawImage(src, 0, 0);
  octx.clearRect(rect.x, rect.y, rect.width, rect.height);
  octx.putImageData(result, rect.x, rect.y);
  return out;
}

/** Commit a processed surface onto the layer with a history entry. */
export function commitSurface(doc, layer, canvas, label) {
  if (!canvas) return false;
  const surf = operableSurface(doc, layer);
  if (!surf) return false;
  /*
   * Only the surface being replaced needs forking, and strictly speaking neither
   * does — both are assigned outright a line later. The clone is kept because
   * `beginEdit` is also what marks the layer dirty and bumps the mask version,
   * and narrowing it to one surface is the change that stops every filter apply
   * on a masked layer permanently forking a mask nobody touched.
   */
  doc.beginEdit(layer, { surface: surf.isMask ? 'mask' : 'canvas' });
  if (surf.isMask) {
    layer.mask = canvas;
    layer.touchMask();
  } else {
    layer.canvas = canvas;
  }
  doc.commit(label);
  return true;
}

/**
 * Apply a filter to the active layer, showing its dialog when it has params.
 * @param {string} id filter id
 * @param {object} [preset] skip the dialog and use these params
 */
export async function applyFilterCommand(id, preset) {
  const doc = app.activeDoc;
  const f = getFilter(id);
  if (!doc || !f) return;
  const layer = doc.activeLayer();
  if (!layer) { app.toast('No layer selected.'); return; }

  // Smart objects stack filters instead of burning them into pixels. Editing
  // the layer's *mask* is still a normal destructive pixel op.
  if (layer.type === 'smart' && layer.smart && layer.smart.source && !(layer.editingMask && layer.mask)) {
    const { promptSmartFilter } = await import('../core/smart.js');
    await promptSmartFilter(doc, layer, id, preset);
    return;
  }

  const surf = operableSurface(doc, layer);
  if (!surf) { app.toast(`Cannot apply "${f.name}" to this layer.`); return; }

  const runWith = (params) =>
    processSurface(doc, layer, (imageData, ctx) =>
      runFilter(id, imageData, params, { ...ctx, width: imageData.width, height: imageData.height, app })
    );

  const label = f.name.replace(/\.\.\.$/, '');

  if (preset || !f.needsDialog) {
    const params = preset || f.defaults;
    await app.busy(label, async () => {
      commitSurface(doc, layer, runWith(params), label);
    });
    app.lastFilter = { id, params: preset || f.defaults, label };
    return;
  }

  const state = { ...f.defaults, ...(app.lastFilterParams?.[id] || {}) };
  const result = await paramDialog({
    title: label,
    params: f.params,
    state,
    width: f.dialogWidth || 400,
    preview: f.preview,
    onPreview: (params) => {
      if (!params) { setLayerPreview(layer.id, null); doc.touch('preview'); return; }
      const cv = runWith(params);
      // Mask edits do not preview through the compositor's layer override.
      setLayerPreview(layer.id, surf.isMask ? null : cv);
      doc.touch('preview');
    },
  });

  setLayerPreview(layer.id, null);
  if (!result) { doc.touch('preview'); return; }

  await app.busy(label, async () => {
    commitSurface(doc, layer, runWith(result), label);
  });
  app.lastFilterParams = { ...(app.lastFilterParams || {}), [id]: result };
  app.lastFilter = { id, params: result, label };
}

/** Apply a destructive adjustment (Image > Adjustments > ...). */
export async function applyAdjustmentCommand(id, preset) {
  const doc = app.activeDoc;
  const a = getAdjustment(id);
  if (!doc || !a) return;
  const layer = doc.activeLayer();
  if (!layer) { app.toast('No layer selected.'); return; }
  const surf = operableSurface(doc, layer);
  if (!surf) { app.toast(`Cannot apply "${a.name}" to this layer.`); return; }

  const runWith = (params) =>
    processSurface(doc, layer, (imageData, ctx) => {
      applyAdjustment(id, imageData, params, { ...ctx, app });
      return imageData;
    });

  const label = a.name.replace(/\.\.\.$/, '');
  const hasUI = (a.params && a.params.length) || a.renderUI;

  if (preset || !hasUI) {
    await app.busy(label, async () => {
      commitSurface(doc, layer, runWith(preset || a.defaults), label);
    });
    return;
  }

  const result = await paramDialog({
    title: label,
    params: a.params || [],
    state: { ...a.defaults },
    width: a.dialogWidth || 400,
    onPreview: (params) => {
      if (!params) { setLayerPreview(layer.id, null); doc.touch('preview'); return; }
      setLayerPreview(layer.id, surf.isMask ? null : runWith(params));
      doc.touch('preview');
    },
  });

  setLayerPreview(layer.id, null);
  if (!result) { doc.touch('preview'); return; }

  await app.busy(label, async () => {
    commitSurface(doc, layer, runWith(result), label);
  });
}

/** Re-run the previous filter (Ctrl+F). */
export async function repeatLastFilter() {
  if (!app.lastFilter) { app.toast('No filter to repeat.'); return; }
  await applyFilterCommand(app.lastFilter.id, app.lastFilter.params);
}
