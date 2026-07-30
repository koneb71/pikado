import { app } from '../../core/app.js';
import { el, loadImage } from '../../core/util.js';
import { paramDialog } from '../dialog.js';
import {
  isSmartLayer, getSmartTransform, decomposeMatrix, composeMatrix,
  setSmartTransform, replaceContents,
} from '../../core/smart.js';

/**
 * Dialogs for Smart Objects: numeric placement and "Replace Contents".
 *
 * Both are thin shells over `src/core/smart.js` — the placement dialog only
 * ever writes a matrix, so the pixels keep coming from the embedded source.
 */

/**
 * Layer > Smart Objects > Transform… — position, scale and rotation applied to
 * the embedded contents, previewed live and committed as one history step.
 * @returns {Promise<boolean>} whether the transform was applied
 */
export async function showSmartTransformDialog(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const s = layer.smart;
  const before = getSmartTransform(layer);
  const d = decomposeMatrix(before, s.sourceWidth, s.sourceHeight);

  const state = {
    x: Math.round(d.centerX * 100) / 100,
    y: Math.round(d.centerY * 100) / 100,
    scaleX: Math.round(d.scaleX * 10000) / 100,
    scaleY: Math.round(d.scaleY * 10000) / 100,
    angle: Math.round((d.angle * 180) / Math.PI * 100) / 100,
    linked: Math.abs(d.scaleX - d.scaleY) < 1e-6,
  };

  const matrixFor = (v) => composeMatrix({
    centerX: Number(v.x) || 0,
    centerY: Number(v.y) || 0,
    scaleX: (Number(v.scaleX) || 0) / 100,
    scaleY: (Number(v.linked ? v.scaleX : v.scaleY) || 0) / 100,
    angle: ((Number(v.angle) || 0) * Math.PI) / 180,
  }, s.sourceWidth, s.sourceHeight);

  const result = await paramDialog({
    title: 'Transform Smart Object',
    width: 340,
    state,
    params: [
      { key: 'x', label: 'Center X', type: 'number', step: 1, unit: 'px' },
      { key: 'y', label: 'Center Y', type: 'number', step: 1, unit: 'px' },
      { key: 'linked', label: 'Constrain proportions', type: 'checkbox' },
      { key: 'scaleX', label: 'Width', type: 'number', min: 0.1, max: 4000, step: 0.1, unit: '%' },
      { key: 'scaleY', label: 'Height', type: 'number', min: 0.1, max: 4000, step: 0.1, unit: '%', when: (v) => !v.linked },
      {
        key: 'angle', label: 'Rotate', type: 'angle',
        hint: `Source is ${s.sourceWidth} × ${s.sourceHeight} px — every change resamples it from scratch.`,
      },
    ],
    onPreview: (v) => {
      if (!v) {
        setSmartTransform(doc, layer, before, { commit: false });
        return;
      }
      setSmartTransform(doc, layer, matrixFor(v), { commit: false });
    },
  });

  if (!result) {
    setSmartTransform(doc, layer, before, { commit: false });
    return false;
  }
  setSmartTransform(doc, layer, matrixFor(result), { label: 'Transform Smart Object' });
  return true;
}

/**
 * Layer > Smart Objects > Replace Contents — swaps the embedded document for a
 * picked image, keeping the smart layer's placement and its smart filters.
 * @returns {Promise<boolean>}
 */
export async function showReplaceContentsDialog(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const file = await pickImageFile();
  if (!file) return false;
  return app.busy('Replace Contents', async () => {
    const img = await loadImage(file);
    replaceContents(doc, layer, img, 'Replace Contents');
    app.toast(`Replaced with "${file.name}".`, 'ok');
    return true;
  });
}

/** One-shot hidden file input. Resolves to null when the user cancels. */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      style: { position: 'fixed', left: '-9999px', width: '1px', height: '1px' },
    });
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file || null);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0]));
    // `cancel` is not universal; the focus fallback keeps the promise from
    // hanging forever when the picker is dismissed.
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', () => setTimeout(() => finish(input.files && input.files[0]), 400), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
