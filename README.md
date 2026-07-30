# Pikado

A browser-based raster and vector image editor in the spirit of Photopea and
Photoshop. Everything runs client-side — no server, no upload, no account.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
```

## What it is

Pikado is a real layered image editor, not a canvas demo. The document model,
compositor, brush engine and history system are built the way a desktop editor
builds them:

- **Layers** — raster, text, shape, group, adjustment and fill layers, with
  masks, clipping masks, blend modes, opacity/fill opacity and layer effects.
- **Compositing** — all 27 Photoshop blend modes. Canvas2D handles the ones it
  natively supports; the rest (Linear Burn, Vivid Light, Divide, Darker Colour,
  …) run through a per-pixel CPU path.
- **Selections** — stored as an 8-bit coverage mask, so feathering, antialiasing
  and partial selection are exact rather than approximated by paths.
- **History** — snapshot-based undo with copy-on-write pixel buffers, so a
  history step costs a few hundred bytes unless pixels actually changed.
- **Non-destructive editing** — adjustment layers re-process the composite
  beneath them on every render; layer effects are generated at composite time.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full API contract. The short
version:

```
src/
  core/        document, layer, selection, history, colour, blend modes, app singleton
  render/      compositor, viewport
  paint/       brush engine, patterns, gradients
  tools/       one module per toolbar group
  filters/     filter registry + implementations by menu
  adjustments/ adjustment registry + implementations
  effects/     layer style renderers + the Layer Style dialog
  vector/      path model, geometry, shape rasterizing
  text/        text layout, rasterizing, font handling
  layers/      layer operations (merge, group, mask, rasterize…)
  edit/        clipboard, fill & stroke
  commands/    command registry + every menu command
  io/          open/save, PSD read & write, SVG, native .pkd format
  ui/          menubar, toolbar, options bar, panels, dialogs, canvas view
```

Three conventions matter throughout:

1. **`doc.layers[0]` is the top layer.** The compositor walks the array
   backwards.
2. **Never touch `layer.canvas` without `doc.beginEdit(layer)` first.** History
   snapshots share those buffers; `beginEdit` swaps in a private copy.
3. **Every module self-registers on import.** `main.js` imports modules purely
   for the side effect; registries do the wiring.

## Adding to it

A new filter is one `registerFilter` call — the dialog, live preview, selection
masking and undo step are all generated for you:

```js
import { registerFilter } from './registry.js';

registerFilter({
  id: 'my-filter',
  name: 'My Filter...',
  menu: 'Stylize',
  params: [{ key: 'amount', label: 'Amount', type: 'slider', min: 0, max: 100, default: 50 }],
  apply(imageData, { amount }) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) d[i] = Math.min(255, d[i] * (1 + amount / 100));
  },
});
```

Adjustments (`registerAdjustment`), tools (`registerTool`), panels
(`registerPanel`), commands (`registerCommand`) and layer effects
(`registerEffectRenderer`) follow the same pattern.

## File formats

| Format | Open | Save |
|---|---|---|
| PNG / JPEG / WebP | yes | yes |
| GIF | first frame (all frames where `ImageDecoder` exists) | yes — median-cut palette + LZW |
| PSD / PSB | yes — layers, groups, masks, blend modes, text, adjustments | yes — layered, see caveats below |
| SVG | yes — rasterized, with simple shapes kept as editable paths | yes |
| `.pkd` (Pikado native) | yes | yes — lossless, preserves everything |

`.pkd` is the format to use when you care about keeping your work intact. PSD
export writes real layer records — including adjustment layers, masks, group
nesting, blend modes and fill opacity — but see the limits below.

## What is *not* implemented

Stated plainly so you don't find out by clicking:

- **Camera Raw, the 3D workspace, and the video timeline.** Not present.
- **Select Subject / Select and Mask.** These are machine-learning features in
  Photoshop. Rather than ship a fake, they're omitted. Quick Selection, Magic
  Wand, Color Range and the Magnetic Lasso are all real and do the edge-finding
  work honestly.
- **ICC colour management.** Everything is 8-bit sRGB internally. 16-bit PSDs
  open by converting down to 8-bit. CMYK and Lab exist as colour maths (for the
  Info panel, Selective Color, and so on) but not as document modes.
- **Per-channel view toggling** in the Channels panel. The compositor renders a
  single RGBA composite, so hiding just the Red channel isn't supported. Loading
  a channel as a selection, saving selections as alpha channels and Quick Mask
  all work.
- **PSD export interoperability has known edges.** A Pikado → PSD → Pikado round
  trip is lossless and produces a bit-identical composite: layers, groups,
  masks, blend modes, fill opacity, layer styles (`lfx2`), live text (`TySh`
  with real EngineData), live vector shapes (`vmsk`/`vstk`/`vogk`), adjustment
  layers, saved alpha channels, guides, vector paths and the active selection
  all survive. What is *not* guaranteed is how Adobe reads it — that could not
  be tested here, as no Photoshop install was available. Specific known gaps:
  bold and italic travel as `FauxBold`/`FauxItalic` on the regular PostScript
  face rather than switching to a real bold font file; `vogk` live parametric
  shapes are written only for rectangles and rounded rectangles, so polygons and
  stars open as editable paths but not live shapes; named dash presets reopen
  solid; and a gradient's angle sign convention may render mirrored in
  Photoshop. Six adjustment kinds (Invert, Posterize, Threshold,
  Brightness/Contrast, Levels, Curves) are written as native Photoshop
  adjustments; the other 18 open there as correctly named, correctly masked but
  inert layers, and round-trip exactly through Pikado via a private block
  Photoshop safely ignores.
- **Smart Objects** are fully non-destructive. `layer.smart.source` is a real
  embedded `PikaDocument`, and every render restarts from it: composite the
  source, re-run the stored smart filters in order, then apply the transform.
  Scaling to 10% and back is *pixel-exact* (measured mean absolute difference
  0.0000, versus ~32 for the equivalent destructive resample), and repeated
  cycles never compound. Smart filters can be toggled, reordered, edited and
  removed, and Edit Contents opens the source as a real tab that syncs back.
  Free Transform composes matrices on a smart layer instead of baking pixels.
  What is *not* supported: skew and perspective are preserved if set
  programmatically but the Properties panel cannot author them (it edits
  centre/scale/rotation); Warp still falls back to the destructive path; and
  duplicating a Smart Object produces an **independent** copy rather than
  Photoshop's linked one.
- **Liquify** is a real interactive mesh warp, not Photoshop's full toolset
  (no face-aware liquify, freeze/thaw masking, or reconstruct modes).

PSD writing was verified against Pikado's own parser and at the byte level, but
not against a real Photoshop install — that wasn't available here.

## Performance

Measured on a 4000×3000 (12 MP) document with 8 layers — a realistic photo edit:

| Operation | Time |
|---|---|
| Composite, native blend modes | 0–1 ms |
| Composite, GPU blend modes (Vivid Light, Divide, Hard Mix…) | 2–17 ms |
| Brush stroke, per frame | 3 ms |
| Curves / Levels / any LUT adjustment | 1 ms |
| Gaussian Blur, any radius | 66–99 ms |
| Drop shadow on a small layer, per recomposite | ~106 ms |
| History step (copy-on-write) | 0 ms |

Three things make that possible:

- **Blend modes on the GPU.** Canvas2D implements 17 of the 27 modes natively.
  The other ten used to run per-pixel in JS over the whole document — about
  1 second per recomposite at 12 MP, on *every brush frame*. They now run in a
  fragment shader (`src/render/gpu-blend.js`). The CPU path is kept for small
  documents, where it is already fast and bit-exact.
- **Blur on the GPU.** The browser's own `ctx.filter = 'blur()'` is a true
  Gaussian on the GPU, ~30× faster end-to-end than the equivalent JS box passes
  and independent of radius. Edge pixels are replicated into a padded border
  first so it clamps like the JS path instead of fading to transparent.
- **Region-cropped layer effects.** Effects used to process the full document
  even for a logo covering 5% of it. They now run on the content bounds expanded
  by each effect's reach — worth about 5× on a large canvas.

One deliberate trade-off: uploading a Canvas2D surface into WebGL round-trips
through premultiplied 8-bit alpha, costing ~2 counts of precision on *partially
transparent* pixels. Fully opaque pixels are unaffected. Where a mode makes a
discrete choice (Hard Mix's threshold, Darker/Lighter Color picking by
luminance) that can flip the result on roughly 0.1–0.6% of semi-transparent
pixels — values that were exact ties either way. Documents under ~400k pixels
use the exact CPU path regardless.

## Browser support

Chromium, Firefox and Safari, current versions. Some conveniences are
progressive: the File System Access API (used for Save when present),
`ImageDecoder` (multi-frame GIF import) and `navigator.clipboard.write` (system
clipboard copy) fall back gracefully where unavailable.

## Licence

Provided as-is for the requester. Photoshop and Photopea are trademarks of their
respective owners; Pikado is an independent implementation and is not affiliated
with either.
