# Pikado — architecture contract

Read this before writing any module. It is the authoritative description of
every shared API. Where this document and the code disagree, the code wins —
read the file named in each section.

Plain ES modules, no TypeScript, no framework, bundled by Vite. Import paths
are relative and **must include the `.js` extension**.

---

## Golden rules

1. **`doc.layers[0]` is the TOP-most layer.** The compositor walks the array
   backwards. Groups nest through `layer.children`, same ordering.
2. **Never draw into `layer.canvas` or `layer.mask` without calling
   `doc.beginEdit(layer)` first.** History snapshots share those buffers;
   `beginEdit` swaps in a private copy. Then call `doc.commit('Label')` to
   record the undo step, or `doc.touch()` for a live preview with no history.
3. **Layer buffers are always document-sized** (`doc.width × doc.height`).
   There are no per-layer offsets; moving a layer moves its pixels.
4. Masks are stored as **greyscale RGBA canvases** (white = visible). Use
   `layer.maskAlphaCanvas()` when you need an alpha-only clip source.
5. Every module **self-registers on import** — `src/main.js` imports it purely
   for the side effect. Do not export a `register()` that main must call.
6. Long loops over pixels: get a `willReadFrequently` context via
   `ctx2dRead(canvas)` from `src/core/util.js`.

---

## `src/core/util.js`

`uid`, `createCanvas(w,h)`, `ctx2d`, `ctx2dRead`, `cloneCanvas`, `clearCanvas`,
`resizeCanvas`, `getImageData`, `putImageData`, `imageDataToCanvas`, `clamp`,
`clamp255`, `lerp`, `deg2rad`, `rad2deg`, `ZOOM_STEPS`, `nextZoom`,
`formatBytes`, `download(blob,name)`, `loadImage(blobOrUrl)`,
`readFileAsArrayBuffer`, `readFileAsText`, `rafThrottle`, `debounce`, and
**`el(spec, attrs, ...children)`**.

`el` is the DOM helper used everywhere:

```js
el('div.pk-row#main', { onclick: fn, style: {gap: '4px'}, text: 'Hi' }, childNode)
```
Attrs: `text`, `html`, `style` (object), `dataset` (object), `onclick`/`oninput`/…
(any `on*` function becomes a listener), anything else becomes an attribute.

## `src/core/app.js` — the singleton `app`

```
app.docs[]  app.activeDoc  app.viewport  app.tool
app.foreground / app.background   // {r,g,b,a}, a in 0..1
app.swatches[]  app.clipboard  app.lastFilter  app.transformSession
app.showGuides / showGrid / showRulers / snap / gridSize / gridSubdivisions
app.units  app.ready  app.previousToolId / app.tempToolId
app.patterns[]                 // user-defined patterns, created lazily by src/edit/fill-stroke.js
app.lastFilterParams           // {[filterId]: params} — reopened dialogs restore these
app.view                       // the CanvasView (src/ui/canvas-view.js) — assigned by main.js, not app.js
app._views                     // Map<doc.id, viewport.serialize()> — per-tab view state

app.addDocument(doc, activate?)   app.newDocument({width,height,name,fill})
app.closeDocument(doc)            app.setActiveDoc(doc)   app.fitView(maxScale?)
app.setTool(id)                   app.pushTempTool(id) / app.popTempTool()
app.setForeground(c) / setBackground(c) / swapColors() / resetColors()
app.toast(msg, kind?, ms?)        kind: 'info'|'error'|'warn'|'ok'
await app.busy(label, async fn)   // shows the spinner, catches + toasts errors
app.requestRender()               // rAF-coalesced repaint
```

Events (`app.on(name, fn)`): `render`, `view-change`, `tool-change`,
`tool-options`, `color-change`, `docs-change`, `active-doc`, `doc-change`,
`doc-structure`, `doc-selection`, `doc-resize`, `history-change`,
`cursor-move`, `toast`, `busy`, `ready`, `command-done`.

**`app.view` vs the `view` a tool receives.** `app.view` is the `CanvasView`
instance — the DOM-facing object that owns the `<canvas>`, draws the composite
and normalises pointer events. It is set by `src/main.js` (`app.view = view`),
*not* by `app.js`, so it is undefined until `boot()` runs. The `view` argument
handed to `Tool.drawOverlay(ctx, view)` is **`app.viewport`, a `Viewport`** —
`CanvasView.draw()` passes `app.viewport` straight through. So inside an overlay
`view.toScreen(...)` / `view.scale` are the Viewport's; there is no
`view.canvas` there.

`window.pikado` is the live singleton (set at the bottom of `app.js`). Use it —
and never a fresh `import` of `app.js` — when driving the app from the console
or from automation; see [The test suite](#the-test-suite).

## `src/core/document.js` — `PikaDocument`

```
doc.id doc.width doc.height doc.name doc.resolution doc.colorMode
doc.layers[]  doc.paths[]  doc.activePathId
doc.selection (Selection)   doc.history (History)   doc.alphaChannels[]
doc.guides[]  // {axis:'h'|'v', pos:number}
doc.quickMask  doc.dirty  doc.filePath  doc.fileHandle

doc.flatLayers()          // depth-first, top to bottom
doc.findLayer(id)         doc.locate(layer) -> {list, index, parent}
doc.activeLayer()         doc.selectedLayers()
doc.setActiveLayer(id, additive?, range?)
doc.addLayer(layer, {above?, parent?, index?})
doc.removeLayer(layer)    doc.duplicateLayer(layer)
doc.moveLayer(layer, parent, index)
doc.arrange(layer, 'front'|'forward'|'backward'|'back')
doc.beginEdit(layerOrLayers?)   doc.commit(label)   doc.touch(reason?)
doc.resample(w,h,smoothing?)    doc.resizeCanvasTo(w,h,anchor)
doc.crop(rect)                  doc.transformImage('cw'|'ccw'|'180'|'flip-h'|'flip-v')
doc.memoryUse()
```

`PikaDocument.blank(w,h,name,fill)` and `PikaDocument.fromImage(img,name)`.

### Document fields owned by tools and panels

These are not declared in the constructor — the module that needs them creates
them lazily (`if (!doc.notes) doc.notes = []`). They are still part of the
contract: read them defensively (`Array.isArray(doc.slices) ? … : []`), because
a document that has never met the relevant tool will not have the field at all.

| Field | Shape | Written by | Read by |
|---|---|---|---|
| `doc.globalLight` | `number` — degrees, default 120 | `effects/styles-dialog.js` | `effects/styles.js` → `env.globalLight`, `io/pkd.js` |
| `doc.slices` | `[{x, y, width, height, name}]` | `tools/crop.js` (Slice tool) | `tools/crop.js` |
| `doc.colorSamplers` | `[{x, y}]`, max 10 | `tools/eyedropper.js` | `ui/panels/info.js` |
| `doc.notes` | `[{id, x, y, text, author}]` | `tools/eyedropper.js` (Note tool) | same |
| `doc.artboards` | `[{id, name, x, y, width, height}]` | `tools/move.js` (`addArtboard`), `ui/dialogs/new-document.js` | `tools/move.js` |
| `doc.measurement` | `{x1, y1, x2, y2}` or `null` | `tools/eyedropper.js` (Ruler tool) | `tools/eyedropper.js`, `ui/panels/info.js` |
| `doc.historyBrushSource` | `number` index into `doc.history.states`, or `null` | `ui/panels/history.js` | `tools/history-brush.js` |
| `doc.snapshots` | `[{name, state, thumb}]` — `state` is a `captureState()` result | `ui/panels/history.js` | same |
| `doc.activePathId` | `string` id into `doc.paths`, or `null` | `ui/panels/paths.js`, `tools/path-select.js`, `tools/pen.js` | same, `io/pkd.js` |
| `doc.alphaChannels` | `[{id, name, canvas}]` | `ui/panels/channels.js`, `commands/*`, `io/psd-read.js` | Channels panel, Select > Load Selection |

**Which of these survive undo.** `captureState()` / `restoreState()` are the
authority (`src/core/document.js`). They carry:

- always: `width`, `height`, `layers` (via `Layer.snapshot()`), `activeLayerId`,
  `selectedLayerIds`, `selectionMask`, `alphaChannels`, `paths`, `guides`,
  `quickMask`;
- and the tool-owned values `slices`, `colorSamplers`, `notes`, `artboards`,
  `measurement` — `structuredClone`d, so a history step neither drops them nor
  shares them.

They do **not** carry `globalLight`, `historyBrushSource`, `snapshots` or
`activePathId`. Those are session state, not document state: undo leaves them
exactly as they were. If you add a field that *must* survive undo, it has to go
into `captureState`/`restoreState` — which means a patch to `core/document.js`,
an owned file.

Two sharp edges:

- `alphaChannels` is copied **shallowly** (`{...c}`), so every history state
  shares the same `canvas` objects. Replace `channel.canvas` with a new canvas;
  never draw into an existing one, or you rewrite history.
- `restoreState` rebuilds every `Layer` from its snapshot, so **layer object
  references go stale across undo/redo**. Hold `layer.id` and re-resolve with
  `doc.findLayer(id)`; the id is preserved, the object is not.

## `src/core/layer.js` — `Layer`

```
LayerType = {RASTER, TEXT, SHAPE, GROUP, ADJUSTMENT, SMART}

layer.id name type visible opacity(0..1) fillOpacity blendMode clipped
layer.locked = {all, pixels, position, transparency}
layer.canvas layer.mask layer.maskEnabled layer.maskLinked layer.maskInverted
layer.children (groups)  layer.parent  layer.expanded
layer.styles   // layer effects, see effects/styles.js
layer.text layer.shape layer.adjustment layer.smart   // type payloads
layer.isBackground  layer.editingMask

layer.beginEdit()          // COW — prefer doc.beginEdit(layer)
layer.paintTarget()        // canvas OR mask depending on editingMask
layer.ensureCanvas(w,h)    layer.getContext()
layer.addMask(w,h,fill?)   layer.removeMask()   layer.touchMask()
layer.maskAlphaCanvas()    // cached alpha-only clip source
layer.clone(newIds = true)  layer.contentBounds()  layer.thumbnail(size)
layer.snapshot()           Layer.fromSnapshot(s)   // used by history only
```
What `snapshot()` copies matters. `styles`, `text`, `shape` and `adjustment` are
`structuredClone`d, so editing them in place is safe. `canvas` and `mask` are
shared references — that is the whole point of copy-on-write, hence rule 2.
**`smart` is a shallow copy (`{...this.smart}`)**, so every history state shares
one payload object and its `filters` array; `core/smart.js` therefore always
installs a brand-new payload instead of mutating. `structuredClone` also means
anything you hang off `layer.text`/`shape`/`adjustment` must be structured-clonable
— a canvas, a function or a `Path2D` there will throw on the next history step.

Factories: `createRasterLayer(w,h,name)`, `createGroupLayer(name)`,
`createAdjustmentLayer(kind, params, w, h, name)`.

## `src/core/selection.js` — `Selection`

Coverage mask, `Uint8ClampedArray` of `w*h`, or `null` for "no selection".

```
sel.active  sel.mask  sel.width sel.height  sel.version
sel.at(x,y) -> 0..1        sel.bounds() -> {x,y,width,height}|null
sel.selectAll() sel.clear() sel.invert() sel.set(mask) sel.clone() sel.resize(w,h)
sel.combine(mask, 'replace'|'add'|'subtract'|'intersect'|'xor')
sel.fromPath(path2d, mode, opts)
sel.feather(r) expand(n) contract(n) border(w) smooth(r) translate(dx,dy)
sel.toCanvas()        // greyscale
sel.toAlphaCanvas()   // alpha-only, for destination-in
sel.contourLoops()    // [[{x,y},…], …] traced contour loops
sel.contour()         // Path2D for marching ants, built from contourLoops()
Selection.rasterizePath(path, w, h, opts)  .rectMask(...)  .ellipseMask(...)
Selection.fromCanvas(canvas)
```
Also exported: `boxBlurMask(mask,w,h,r)`, `morph(mask,w,h,r,grow)`.

`rasterizePath` opts are `{antialias = true, fillRule = 'nonzero'}`.
`antialias: false` **genuinely aliases**: the coverage the rasteriser produced is
thresholded at 127, so every output byte is 0 or 255. (It used to set
`imageSmoothingEnabled`, which has no effect on the path rasteriser at all — the
option silently did nothing. Marquee/lasso "Anti-alias" off is now real.)
`rectMask` and `ellipseMask` do not forward opts; they are always antialiased.

## Segmentation and edge refinement — `src/select/`

Three modules, used only by the Select and Mask workspace
(`src/ui/dialogs/select-and-mask.js`), which is loaded on demand.

### `src/select/maxflow.js` — `MaxFlow`

Boykov–Kolmogorov max flow / min cut on a sparse graph.

```
new MaxFlow(nodeCount, arcHint?)
mf.addEdge(i, j, cap, revCap)      // arcs are added in sister pairs; a^1 is the reverse
mf.addTerminal(i, sourceCap, sinkCap)
mf.compute() -> flow
mf.inSource(i) -> boolean           // true = source side of the cut
mf.sourceMask(out?) -> Uint8Array
```

Two invariants worth stating, both of them things that produce a *plausible*
wrong answer rather than a crash:

- a node's `parent` is the arc **from the node to its parent**, so the capacity
  flowing into a node from its parent is the sister arc's (`cap[parent ^ 1]`).
- `addTerminal` collapses source and sink capacity into one signed residual, which
  loses `min(source, sink)` — flow that runs straight through the node no matter
  what. That is a constant, banked in `constantFlow` and added back by `compute`.
  Forgetting it leaves the cut correct and the flow value silently too small.

Verified in `tests/suites/select.test.js` against an independent Edmonds–Karp
implementation over ~190 random graphs, integer and real-valued, plus the
max-flow-min-cut identity on every one.

### `src/select/grabcut.js` — iterated graph cuts

```
TRIMAP = {BG: 0, FG: 1, MAYBE_BG: 2, MAYBE_FG: 3}
grabcut(imageData, trimap, {iterations = 3, diagonals = true, onProgress})
  -> {mask: Uint8ClampedArray, iterations, changed}    // trimap is modified in place
saliencyMap(imageData) -> Float32Array   // 0..1, histogram contrast + centre prior
autoTrimap(imageData, {borderFraction = 0.03}) -> {trimap, confident}
```

`FG` and `BG` are **hard constraints** — a definite label survives every iteration
exactly, which the suite asserts rather than assumes. The two "maybe" states are
what the cut is free to change.

`autoTrimap`'s `confident` flag is not decoration. A featureless image gives every
pixel the same saliency, `sd` is zero, and a naive `>= mean` threshold would mark
the *whole frame* as definite foreground — maximum confidence from no information.
So confidence requires a real spread, a seed above noise, and a seed covering less
than 60% of the frame. When it fails, the definite-foreground seeds are demoted to
"maybe" and the caller is told.

Runs on a downscaled copy (the workspace uses ~0.26 MP); a min-cut is superlinear
in node count.

### `src/select/refine.js` — the Select and Mask controls

```
edgeBand(mask, w, h, radius) -> {band: Uint8Array, dist: Float32Array}
refineRadius(image, mask, radius, {smart}) -> mask    // alpha matting
smoothMask(mask, w, h, radius)      // majority filter, via an integral image
featherMask(mask, w, h, radius)     // boxBlurMask — which RETURNS a mask
contrastMask(mask, amount)          // smoothstep around the midpoint
shiftEdge(mask, w, h, percent)      // threshold shift on a blurred copy
decontaminateColors(image, mask, amount)   // mutates and returns `image`
refineSelection(image, mask, w, h, params) -> mask
```

`refineSelection` applies them in one fixed order — matting, smooth, feather,
contrast, shift — and the suite pins that order by running the steps by hand and
comparing byte for byte. `dist` is signed: positive inside the selection.

Two behaviours are deliberate and read as bugs if you do not know them:

- **feather conserves total coverage.** It is a symmetric blur, so the 50% contour
  does not move; `shiftEdge` is the control that grows or shrinks a selection.
- **matting declines to guess.** Where the local foreground and background are the
  same colour, or there is not enough confident sample on both sides, the pixel
  keeps the cut's own value. `refineRadius` on a flat image is exactly the
  identity.

## `src/core/blend.js`

`BLEND_MODES` (array of `{id,name,gco,group}`), `getBlendMode(id)`,
`blendName(id)`, `isNativeBlend(id)`, `gcoFor(id)`, `blendCPU(base, top, mode, opacity)`.
Group id `'pass-through'` is valid only on group layers.

## `src/core/color.js`

`parseColor(any) -> {r,g,b,a}`, `toHex(c, withAlpha?)`, `toCss(c)`, `rgb(r,g,b,a)`,
`rgb2hsv/hsv2rgb`, `rgb2hsl/hsl2rgb`, `rgb2cmyk/cmyk2rgb`, `rgb2lab/lab2rgb`,
`luminance(r,g,b)`, `colorDistance(a,b)`, `mixColors(a,b,t)`, `DEFAULT_SWATCHES`.

---

## Rendering

### `src/render/compositor.js`
```
compositeDocument(doc, opts?) -> canvas
getComposite(doc)            -> cached canvas
compositeList(list, ctx, doc, opts)
flattenLayers(doc, layers)   -> canvas
blendOnto(ctx, srcCanvas, mode, opacity, doc)
setLayerPreview(layerId, canvas|null)   // live filter/tool preview override
getLayerPreview(layerId)     clearLayerPreviews()
```
`setLayerPreview` overrides a whole layer, so it cannot preview an edit to that
layer's **mask** — the filter runner detects that case and skips the preview
rather than showing the wrong thing.

### `src/render/viewport.js` — `Viewport`
```
vp.scale offsetX offsetY rotation viewWidth viewHeight
vp.toDoc(sx,sy) -> {x,y}    vp.toScreen(x,y) -> {x,y}    vp.matrix()
vp.fit(dw,dh,pad?,maxScale?)  vp.center(dw,dh)  vp.setScale(s, ax?, ay?)
vp.zoomStep(dir, ax, ay)  vp.zoomBy(f, ax, ay)  vp.pan(dx,dy)  vp.setRotation(rad)
vp.fillScreen(dw,dh)  vp.inverse()  vp.visibleDocRect(dw,dh)  vp.setViewSize(w,h)
vp.serialize() -> plain object    vp.restore(obj)
```
`serialize`/`restore` are what `app._views` and the saved session store per tab.

### `src/render/fast-blur.js` — GPU Gaussian blur

The browser's own `ctx.filter = 'blur(Npx)'` is a true Gaussian on the GPU, ~30×
faster end to end than JS box passes and independent of radius. CSS `blur(N)`
uses N as the **standard deviation**, so it matches the sigma convention the JS
paths already used.

```
supportsCanvasFilter() -> bool                  // feature-detected once, cached
blurCanvas(src, sigma, clampEdges = true) -> new canvas
blurImageData(imageData, sigma, jsFallback?) -> the same ImageData, mutated
blurAlphaField(alpha, w, h, sigma, jsFallback?) -> new Float32Array
```

The non-obvious part: **CSS blur treats everything outside the canvas as
transparent black**, which fades the edge of an opaque image, whereas the JS path
clamped. `clampEdges` (default true) replicates the edge pixels into a padded
border first so the two agree. `blurAlphaField` deliberately passes
`clampEdges: false` — a shadow or glow field *must* fade to nothing outside the
layer. Both `blurImageData` and `blurAlphaField` fall through to `jsFallback`
when Canvas2D filters are missing **or the surface is under ~90k px**, where the
ImageData round trip wins nothing; pass the fallback or you get an unblurred
result on small images. Used by `filters/blur.js` and `effects/styles.js`.

### `src/render/gpu-blend.js` — the ten non-native blend modes

Canvas2D provides 17 of the 27 modes. The other ten (`linear-burn`,
`vivid-light`, `linear-light`, `pin-light`, `hard-mix`, `subtract`, `divide`,
`darker-color`, `lighter-color`, `dissolve`) ran per-pixel in JS — ~1 s per
recomposite at 12 MP, on every brush frame. They now run in a fragment shader
whose maths mirrors `blendCPU` exactly.

```
canBlendOnGPU(w, h) -> bool        // WebGL2 present and within max texture size
shouldBlendOnGPU(w, h) -> bool     // ...and >= 400k px, where the GPU actually wins
isGPUModeSupported(mode) -> bool
blendOnGPU(ctx, src, mode, opacity) -> bool   // false = caller must use blendCPU
```

Three things a caller must know. **`blendOnGPU` replaces the destination
wholesale** — the shader already produced the composited result, so it copies
back with `globalCompositeOperation = 'copy'`; do not composite its output again.
**Its return value is not optional**: it returns `false` for an unsupported mode,
a too-small or too-large surface, a lost context or any thrown error, and the
caller must then fall back to `blendCPU` — `compositor.js` does. And **the two
paths are not bit-identical**: uploading a Canvas2D surface into WebGL round-trips
through premultiplied 8-bit alpha, costing ~2 counts of precision on *partially
transparent* pixels (opaque pixels are unaffected). Where a mode makes a discrete
choice — Hard Mix's threshold, Darker/Lighter Color picking by luminance — that
can flip ~0.1–0.6 % of semi-transparent pixels, which were exact ties either way.
Documents under 400k px take the exact CPU path, which is why pixel-exactness
tests use small documents.

---

## Tools — `src/tools/base.js`

```js
import { Tool, registerTool } from './base.js';

class MyTool extends Tool {
  constructor() {
    super({
      id: 'brush', name: 'Brush Tool', icon: 'brush',   // icon = key in ui/icons.js
      cursor: 'crosshair', shortcut: 'B',
      group: 'brush', groupOrder: 8,   // toolbar fly-out group + position
      options: [ /* ParamDescriptor[] — rendered into the options bar */ ],
    });
  }
  onPointerDown(e) {}  onPointerMove(e) {}  onPointerUp(e) {}
  onDoubleClick(e) {}  onWheel(e) { return false }
  onKeyDown(e) { return false }   // return true to consume
  onKeyUp(e) { return false }
  drawOverlay(ctx, view) {}       // ctx is SCREEN space, view is app.viewport
  contextMenu(e) { return [] }    // right-click entries, see below
  onOptionChange(key, value) {}   // an options-bar control changed
  commit() {}  cancel() {}        // Enter / Escape
  onActivate() {}  onDeactivate() {}
  getCursor(e) { return this.cursor }
}
registerTool(new MyTool());
```

Normalised pointer event `e`:
`{x, y, sx, sy, dx, dy, pressure, pointerType, button, buttons, shiftKey,
altKey, ctrlKey, metaKey, native}` — `x/y` are **document** coordinates,
`sx/sy` are **screen** coordinates inside the canvas element.

`this.state` holds live option values (seeded from each descriptor's `default`).
`this.doc` is the active document. `this.canPaint()` validates the active layer
and toasts a reason when it is not paintable.

**Tool ids and groups (fixed — use exactly these):**

| group | groupOrder | tool ids |
|---|---|---|
| `move` | 0 | `move`, `artboard` |
| `marquee` | 1 | `marquee-rect`, `marquee-ellipse`, `marquee-row`, `marquee-col` |
| `lasso` | 2 | `lasso`, `lasso-poly`, `lasso-magnetic` |
| `wand` | 3 | `quick-select`, `wand` |
| `crop` | 4 | `crop`, `crop-perspective`, `slice` |
| `eyedropper` | 5 | `eyedropper`, `color-sampler`, `ruler`, `note` |
| `healing` | 6 | `spot-healing`, `healing-brush`, `patch`, `red-eye` |
| `brush` | 7 | `brush`, `pencil`, `color-replace`, `mixer-brush` |
| `stamp` | 8 | `clone-stamp`, `pattern-stamp` |
| `history-brush` | 9 | `history-brush`, `art-history` |
| `eraser` | 10 | `eraser`, `bg-eraser`, `magic-eraser` |
| `gradient` | 11 | `gradient`, `bucket` |
| `focus` | 12 | `blur`, `sharpen`, `smudge` |
| `tone` | 13 | `dodge`, `burn`, `sponge` |
| `pen` | 14 | `pen`, `pen-free`, `pen-curvature`, `pen-add`, `pen-delete`, `pen-convert` |
| `type` | 15 | `type`, `type-vertical`, `type-mask` |
| `path-select` | 16 | `path-select`, `direct-select` |
| `shape` | 17 | `rectangle`, `rounded-rect`, `ellipse`, `polygon`, `line`, `custom-shape` |
| `nav` | 18 | `hand`, `rotate-view`, `zoom` |

Also exported from `base.js`: the `tools` Map (id → Tool), the `toolGroups`
array (fly-out groups, pre-sorted by `order`) and `getTool(id)`.

## Canvas context menu — `src/ui/canvas-menu.js`

Right-clicking the artboard calls `app.tool.contextMenu(e)` with the normalised
pointer event at the click position, resolves what comes back, appends a shared
tail and shows it through `popupMenu` from `ui/panel-host.js`.

```js
showCanvasMenu(e, nativeMouseEvent)   // build + show; returns the menu node or null
installCanvasMenu(view)               // wire a CanvasView's contextmenu (main.js does this)
resolveItems(items) -> items          // the resolver, exported for tests
cmd(id, over?)                        // {command: id, ...over}
sep()                                 // {separator: true}
closeMenu()                           // re-exported from panel-host.js
```

Accepted item shapes:

| Shape | Behaviour |
|---|---|
| `{command: 'select.deselect'}` | label, `accel`, `checked` and enabled state all read from the command registry; `run` calls `runCommand(id)` |
| `{command: 'x', label, accel, checked}` | same, with those fields overridden |
| `{label, run, checked, disabled, accel}` | an explicit entry; `run` is called with no arguments |
| `{separator: true}` | a rule |
| `{header: 'Text'}` | a non-clickable section label |
| `…, hideWhenDisabled: true` | drop the item entirely instead of greying it |

Non-obvious parts of the resolution, all in `resolveItems`:

- an unknown `command` id is **skipped with a `console.warn`**, not rendered as a
  dead row — so a typo in a tool's menu disappears rather than showing a mystery;
- separators that end up leading, trailing or doubled once items were dropped are
  collapsed, so `hideWhenDisabled` cannot leave a stray rule behind;
- the shared tail (Free Transform, Transform Selection, Fit on Screen, 100%) is
  appended after the tool's items, so returning `[]` — the `Tool` default — still
  produces a useful menu. Right-click is never a dead gesture.
- a throw inside `contextMenu` is caught and logged; the menu still opens with
  just the shared tail.
- `popupMenu` has no submenu support. Flat lists with `header` entries only.

Most tools implement it — `move`, `marquee`, `lasso`, `crop`, `eyedropper`,
`healing`, `brush`, `stamp`, `eraser`, `gradient`, `pen`, `path-select`, `shape`,
`type`, `nav`. Two reusable builders are worth knowing before writing another:
`selectionModifyItems()` on the marquee base class (shared by every selection
tool), and `anchorEditItems(doc, e, tol, live?)` + `pathActionItems(doc, target)`
exported from `src/tools/pen.js` (shared by the pen family and `path-select`).
`anchorEditItems` takes an optional `live` subpath so a path still being drawn —
not yet in `doc.paths` — is right-clickable too.

---

## ParamDescriptor (options bars, filter dialogs, adjustment dialogs)

```js
{ key, label, type, min, max, step, default, options, unit, hint, when(state) }
```
`type`: `slider | number | select | checkbox | color | angle | text | textarea |
radio | label | separator | button | custom`.

That list is exhaustive — it is exactly the `switch` in `buildForm`. There is no
`curve`, `gradient` or `range2` type; an unrecognised `type` renders nothing.

- `select`/`radio` `options`: `['a','b']` or `[{value, label}]`.
- `when(state)` hides the row when it returns false.
- `custom` uses `render(container, state, onChange, descriptor)` and may return
  `{sync(value)}` so the form can push external updates back in.
- `button` uses `onClick()` and has no `key`.

**Curve and gradient editors are `custom` descriptors**, built by their own
modules rather than by `dialog.js`:

```js
import { curveParam } from '../ui/curve-editor.js';       // -> {type:'custom', ...}
import { gradientParam } from '../ui/gradient-editor.js'; // -> {type:'custom', ...}
```

`curve-editor.js` also exports `CURVE_CHANNELS`, `CURVE_PRESETS`,
`normalizeCurves`, `defaultCurves`, `curvesFromPreset`, `isIdentityCurve`,
`evaluateCurve`, `curveToLUT`, `applyCurves`. `gradient-editor.js` exports
`normalizeGradient`, `defaultGradient`, `sampleGradient`, `gradientToLUT`,
`gradientToCss`, `toPaintStops`, `gradientPresets`, `gradientPresetPicker`,
`paintGradientBar`.

Rendered by `buildForm(params, state, onChange)` in `src/ui/dialog.js`.

## `src/ui/dialog.js`

```
new Dialog({title, width, resizable, className})
  .setBody(...nodes).setButtons([{label, value, primary, subtle, onClick}])
  .open() -> Promise<value>   .close(value)   .onClose(fn)
alertDialog(msg, title)   confirmDialog(msg, title, okLabel) -> Promise<bool>
promptDialog(msg, initial, title) -> Promise<string|null>
paramDialog({title, params, state, width, preview, onPreview(params|null), extraButtons})
  -> Promise<state|null>
buildForm(params, state, onChange) -> {node, refresh, controls}
```
`onPreview(null)` means "preview off / dialog closing" — clear your preview.

## `src/ui/icons.js`

`icon(name, {size}) -> svg string`, `iconEl(name, opts) -> SVGElement`,
`hasIcon(name)`, `ICON_NAMES`. Use these names, do not invent inline SVG. Missing
names render a dashed placeholder rather than throwing — which means a typo is
visible but silent, so check with `hasIcon` if the name is computed.

## `src/commands/registry.js`

```js
registerCommand({ id, label, accel, enabled?, checked?, dynamicLabel?, run })
registerCommands([...])
runCommand(id, ...args)   getCommand(id)   isEnabled(id)   isChecked(id)
labelOf(id)   formatAccel(accel)   eventBinding(keyboardEvent)
accelBinding('Ctrl+Shift+S')   buildBindingMap()   IS_MAC
```
`accel` uses `Ctrl` for the primary modifier; it displays as `⌘` on macOS and
binds to `metaKey` there automatically.

## Filters — `src/filters/registry.js`

```js
registerFilter({
  id, name: 'Gaussian Blur...', menu: 'Blur',
  params: [...], preview: true, needsDialog: true, dialogWidth: 400,
  apply(imageData, params, ctx) { /* mutate in place or return new ImageData */ },
});
```
`ctx = {doc, layer, rect, isMask, width, height, app}`. `menu` must be one of
`FILTER_MENUS`: Blur, Distort, Noise, Pixelate, Render, Sharpen, Stylize, Other.
Filters never handle the selection — `src/filters/run.js` masks the result.

Helpers: `makeRandom(seed)`, `sampleBilinear(data,w,h,x,y,out)`,
`separableConvolve(imageData, kernel1d)`, `gaussianKernel(sigma)`.

Runner (`src/filters/run.js`):
`applyFilterCommand(id, preset?)`, `applyAdjustmentCommand(id, preset?)`,
`repeatLastFilter()`, `processSurface(doc, layer, fn)`,
`commitSurface(doc, layer, canvas, label)`, `operableSurface(doc, layer)`,
`operableRect(doc, layer)`.

`filters/registry.js` additionally exports the `filters` Map, `getFilter(id)`,
`listFilters()`, `filtersByMenu()` and `runFilter(id, imageData, params, ctx)`.
The runner remembers the last-used params per filter id on
`app.lastFilterParams`, so reopening a dialog restores your settings; `preview`
routes through `setLayerPreview`, which is why a **mask** edit cannot preview
(the compositor override is per-layer, not per-surface) and `onPreview` skips it.

Do not add a `renderUI` to a filter — nothing reads it. For a custom dialog body,
use a `custom` ParamDescriptor, which `paramDialog` does render.

## Adjustments — `src/adjustments/registry.js`

```js
registerAdjustment({
  id: 'levels', name: 'Levels...', group: 'tone',
  params: [...],           // may include a `custom` descriptor for curve UIs
  apply(imageData, params, ctx) {},
  defaults: {…},           // optional; otherwise derived from the params' `default`
  dialogWidth: 400,        // optional
  layerable: true,         // false = destructive only
});
```
Helpers: `buildLUT(fn)`, `applyLUT(imageData, r, g, b)`, `mixImageData(a,b,t)`,
`defaultParams(id)`, `getAdjustment(id)`, `listAdjustments()`,
`applyAdjustment(id, imageData, params, ctx)`, and the `adjustments` Map.

The JSDoc at the top of `adjustments/registry.js` is stale in two places: it lists
`curve` and `gradient` as ParamDescriptor types (they are `custom` — see above),
and it advertises `renderUI`, which only affects whether a params-less adjustment
opens a dialog at all; the body is never rendered. Believe this file.

**Adjustment ids (fixed):** `brightness-contrast`, `levels`, `curves`,
`exposure`, `vibrance`, `hue-saturation`, `color-balance`, `black-white`,
`photo-filter`, `channel-mixer`, `color-lookup`, `invert`, `posterize`,
`threshold`, `gradient-map`, `selective-color`, `shadows-highlights`,
`desaturate`, `equalize`, `replace-color`, `hdr-toning`, `auto-tone`,
`auto-contrast`, `auto-color`.

## Layer effects — `src/effects/styles.js`

```js
registerEffectRenderer(id, (cfg, env) => canvas|null)
// env = {w, h, alpha: Float32Array, src: canvas, layer, doc, styles, globalLight}
```
Effect ids: `dropShadow`, `innerShadow`, `outerGlow`, `innerGlow`, `bevelEmboss`,
`satin`, `colorOverlay`, `gradientOverlay`, `patternOverlay`, `stroke`.
`DEFAULT_STYLES` holds every default. Helpers: `alphaOf(canvas)`,
`alphaToCanvas(alpha,w,h,color)`, `blurAlpha(alpha,w,h,r)`,
`spreadAlpha(alpha,w,h,amount)`, `offsetAlpha(alpha,w,h,angle,distance)`,
`defaultStyle(id)`, `hasStyles(layer)`, `enabledEffects(styles)`,
`applyLayerStyles(...)`, `belowEffectResults(...)`, `EFFECT_ORDER_BELOW`,
`EFFECT_ORDER_ABOVE`, and the `renderers` Map.
The renderer returns a **document-sized canvas**; `applyLayerStyles` handles
opacity and blend mode from `cfg`. `env.globalLight` is `doc.globalLight` with a
default of 120 degrees, and `blurAlpha` routes through `render/fast-blur.js`.

## Brush engine — `src/paint/brush-engine.js`

```js
const stroke = new PaintStroke({
  doc, layer, target: layer.paintTarget(),
  brush: brushFromOptions(this.state),
  mode: 'paint' | 'erase',
  color: '#ff0000',            // or {r,g,b,a}
  sourceImage, sourceMap,      // clone/pattern stamp
  lockTransparency, selectionClip,
  blendMode: 'multiply',       // optional; default 'normal'
});
stroke.begin(x, y, pressure);  stroke.move(x, y, pressure);  stroke.end();
stroke.flush();                // rebuild layer = base + buffer*opacity
stroke.onFrame = () => doc.touch();  // airbrush repaint hook

new EffectStroke({ doc, layer, target, brush, strength, op(region, meta) {...} })
```
Also `makeTip(spec)`, `DEFAULT_BRUSH`, `brushOptionDescriptors(flags)`,
`brushFromOptions(state, extra)`.

**`PaintStroke` honours `blendMode`.** `flush()` composites the stroke buffer
onto the base with it: native Canvas2D modes go through
`globalCompositeOperation` (`gcoFor(id)`), and the ten modes Canvas2D lacks fall
back to `blendCPU` over the stroke's **dirty rectangle only**, so a CPU-mode
brush stays interactive on a large document. Two consequences for callers:
`mode: 'erase'` ignores `blendMode` (erasing is `destination-out`), and a brush
tool that exposes a Mode dropdown must pass it through — the engine will not read
`this.state` for you.

**`EffectStroke` honours `brush.opacity`.** Per-pixel coverage is
`tipAlpha × perDabFlow × brush.opacity × selectionCoverage`. It used to ignore
opacity, so smudge/blur/dodge tools re-applied it inside their own `op`; doing
that now double-applies it. `op` receives `(region, meta)` where `meta` is:

| field | meaning |
|---|---|
| `x`, `y` | dab centre in document coordinates (float, includes scatter) |
| `size` | dab diameter in px |
| `strength` | `this.strength × dabAlpha` — already pressure-scaled |
| `stroke` | the `EffectStroke`, for state an op wants to carry between dabs |
| `rectX`, `rectY` | top-left of `region` in document coordinates, clamped to the canvas |
| `width`, `height` | dimensions of `region` — **smaller than `size` near an edge** |

Use `rectX`/`rectY`/`width`/`height` for anything positional (sampling another
canvas, generating noise that must not swim between dabs). Deriving the rect from
`x - size/2` is wrong at the canvas border, where clamping has already happened.
`op` may mutate `region` in place or return a new `ImageData` of the same size.

Typical paint tool flow:
```js
onPointerDown(e) {
  if (!this.canPaint()) return;
  const doc = this.doc, layer = doc.activeLayer();
  doc.beginEdit(layer);                       // COW before any pixels change
  this.stroke = new PaintStroke({...});
  this.stroke.onFrame = () => { this.stroke.flush(); doc.touch(); };
  this.stroke.begin(e.x, e.y, e.pressure);
  this.stroke.flush(); doc.touch();
}
onPointerMove(e) { if (this.stroke) { this.stroke.move(e.x,e.y,e.pressure); this.stroke.flush(); this.doc.touch(); } }
onPointerUp() { if (this.stroke) { this.stroke.end(); this.stroke.flush(); this.doc.commit('Brush Tool'); this.stroke = null; } }
```

## Layer operations — `src/layers/ops.js`

`addRasterLayer`, `nextLayerName`, `duplicateLayers`, `deleteLayers`,
`groupLayers`, `ungroupLayers`, `mergeDown`, `mergeSelected`, `mergeVisible`,
`flattenImage`, `stampVisible`, `convertToSmartObject`, `rasterizeLayer`,
`rasterizeLayerStyle`,
`addLayerMask(doc, layer, kind)`, `deleteLayerMask`, `applyLayerMask`,
`toggleMaskEnabled`, `addAdjustmentLayer(doc, kind, params, name)`,
`addFillLayer`, `toggleClipping`, `setLayerProps`,
`convertBackgroundToLayer`, `convertLayerToBackground`, `trimDocument`.
All take `doc` first and record their own history entry.

## Smart Objects — `src/core/smart.js`

`layer.smart` on a `LayerType.SMART` layer:

```js
{
  source: PikaDocument,        // the embedded contents (real layers, masks, groups)
  sourceWidth, sourceHeight,   // the source document size
  sourceVersion: number,       // bumped whenever `source` is replaced
  transform: { matrix: [a,b,c,d,e,f] },   // canvas setTransform order
  filters: [{ id, filterId, name, params, enabled }],
}
```

```
IDENTITY_MATRIX   matrixMultiply(A,B)   // A ∘ B: applies B first
decomposeMatrix(m, sw, sh) -> {centerX, centerY, scaleX, scaleY, angle}
composeMatrix({centerX,centerY,scaleX,scaleY,angle}, sw, sh) -> matrix
isSmartLayer(layer)   smartPayload(layer)   getSmartTransform(layer)
getSmartFilters(layer)   cloneSourceDocument(src, name)
smartSourcePixels(s, layer, cacheHolder)   composeSmartCanvas(s, w, h, layer?, cache?)
renderSmartObject(layer, doc)   invalidateSmartCache(layer)
createSmartObject(doc, layers)  setSmartTransform(doc, layer, matrix, opts?)
resetSmartTransform(doc, layer)
editSmartContents(doc, layer)   isEditingContents(doc, layer)
replaceContents(doc, layer, imageOrDoc, label?)   exportSmartContents(doc, layer)
addSmartFilter / removeSmartFilter / reorderSmartFilters / toggleSmartFilter
setSmartFiltersEnabled(doc, layer, enabled)
editSmartFilter(doc, layer, ref)  promptSmartFilter(doc, layer, filterId, preset?)
```

**Every render starts from `source`**: composite the source document, re-run the
stored filters in order, apply the transform last. `layer.canvas` is only a cache
of that render, which is why scaling down and back up is lossless.

The rule to obey: **`Layer.snapshot()` shallow-copies `layer.smart`**, so history
states share the payload object. Nothing in this module ever edits `layer.smart`
or its `filters` array in place — every mutator installs a brand-new payload with
a new `filters` array. Mutating a payload in place would silently rewrite every
history state that shares it. Note also that `smart.js` is a **dynamic import**
(warmed on idle by `main.js`), so it is not in the boot graph.

## Editing operations — `src/edit/`

### `clipboard.js`

```
copy(doc)  copyMerged(doc)  cut(doc)  clear(doc, {label}?)
await paste(doc)   await pasteInto(doc, {outside}?)   pasteOutside(doc)
purgeClipboard()   hasClipboard()
```
The internal clipboard is `app.clipboard =
{canvas, bounds:{x,y,width,height}, docId, width, height}`; `docId` is what makes
a paste back into its source document land exactly where it was copied from (a
paste into a *different* document centres on the visible view instead). Every copy
also mirrors the pixels onto the OS clipboard as a PNG, best effort. Importing
this module installs a **window-level `paste` listener** so images copied from
other applications arrive; it bails out when `io/open.js` already claimed the
event or the target is a text field. `pasteInto` builds the pasted layer with a
mask from the selection rather than cropping it, so the paste stays adjustable.

### `fill-stroke.js`

```
getPatterns() -> [{id, name, canvas}]      // app.patterns first, then the built-ins
await definePattern(doc)
fillSelection(doc, opts?)     await showFillDialog(doc)
strokeSelection(doc, opts?)   await showStrokeDialog(doc)
contentAwareFill(doc, opts?)  await showContentAwareFillDialog(doc)
```
Everything here builds a *paint* canvas — the colour, pattern or inpainted pixels
limited to the region being filled — and then composites that onto the layer with
a blend mode and opacity, so Fill behaves exactly like painting a solid stroke
with those settings. Non-native blend modes go through `blendCPU`, same as the
brush engine. `definePattern` writes to `app.patterns`, which the module creates
lazily; read patterns through `getPatterns()` rather than touching `app.patterns`.

---

## Persistence, session and offline

Three layers, bottom up: `io/store.js` is the database, `io/session.js` is the
policy, `io/offline.js` + `public/sw.js` make the shell itself work without a
network. Nothing here talks to a server; there is no server.

### `src/io/store.js` — IndexedDB

```
storageAvailable() -> bool           // false in some private modes
await putDoc({id, name, width, height, layers, data: Blob, thumb?: Blob}) -> {id, bytes}
await listDocs() -> meta[]           // newest-updated first
await getDocData(id) -> Blob|null    await getDocMeta(id)
await deleteDoc(id)                  await clearDocs()
await kvSet(key, value)              await kvGet(key)
await usage() -> {bytes, count, quota:{quota,used}|null}
await prune(keepIds = [])            await requestPersistence()
STORE_LIMIT_BYTES (1.2 GB)           DOC_LIMIT_BYTES (320 MB)
```

Database `pikado` v1, three object stores: `docmeta` (`{id, name, width, height,
layers, updatedAt, bytes, thumb}` keyed by `id`, indexed on `updatedAt`), `docdata`
(`{id, data}`) and `kv` (`{key, value}`). **Metadata and payload are separate
stores on purpose** — IndexedDB hands back whole records, so keeping the 50 MB
`.pkd` blob out of `docmeta` lets the welcome screen list recent projects with
thumbnails without reading a single payload. Two other non-obvious details:
`updatedAt` is monotonic (nudged forward on a same-millisecond tie) so the
"newest first" ordering is deterministic; and every read helper swallows failure
and returns `null`/`[]` rather than throwing, because a browser that refuses
storage must not break the editor. `putDoc` is the exception — it throws, with
`err.code === 'too-large'` past `DOC_LIMIT_BYTES`.

### `src/io/session.js` — autosave and restore

```
installSession() -> bool             // wire it up; false when storage is unavailable
await restoreSession() -> number     // how many documents came back
await saveDocNow(doc, {force}?) -> bool
await flushAll()
sessionState() -> {enabled, saving, lastSavedAt, error, restoring}
sessionEvents                        // Emitter: 'state', 'recents-change'
listRecent()   await openRecent(id)   await forgetRecent(id)   storageUsage()
```

Documents are serialised with **`savePKD` from `io/pkd.js`** — the same lossless
writer File > Save uses — so there is one format to trust rather than a parallel
autosave schema. `loadPKD(arrayBuffer)` reads them back.

The timing is the interesting part, and it is deliberate. Serialising a large
document takes 1–2 s (PNG-encoding every layer) and `beforeunload` cannot await
async storage, so a save triggered *by* the refresh would never finish. Instead:
1.2 s after you stop editing (debounce), never more often than every 4 s per
document (throttle floor), and immediately on `visibilitychange`/`pagehide`,
which is the last reliable moment before a reload. Only one document encodes at a
time; a change arriving mid-encode sets `pending` and re-schedules.

Three things a caller must know: **`doc._storeId` is the stable key**, because
`doc.id` is regenerated every time a document is constructed and a restored
document would otherwise be saved under a fresh key while the old copy lingered.
**Undo history is not persisted** — it would multiply the payload by the number of
history states. And closing a document leaves it in the recent list but drops it
from the session pointer, so a refresh does not resurrect something you
deliberately closed.

### `src/io/offline.js` + `public/sw.js` + `public/manifest.webmanifest`

```
installOffline() -> bool    // register the worker, wire the menu-bar pills; idempotent
isOffline() -> bool         // navigator.onLine === false
```

`installOffline` appends two pills to `#menubar` (an "Offline" readout and an
"Update ready" button) — safe because `buildMenubar` only ever replaces the
children of its own nav and title nodes.

**Registration is production-only.** A worker in front of the Vite dev server
answers module requests from its own cache, so source edits appear to do nothing;
in dev the module actively *unregisters* any leftover worker instead. It never
reloads the page on your behalf when an update lands — there may be an uncommitted
brush stroke — it just reveals the pill. `navigator.onLine` is trusted only in the
negative, and the toast is debounced 1.4 s so a Wi-Fi handover announces itself
once.

`public/sw.js` is hand-written: Vite hashes asset filenames, so a precache
manifest would have to be generated at build time. Instead it caches the
navigation shell at install and fills the rest from real traffic — navigations are
network-first (index.html names the hashed assets, so a stale shell would point at
evicted files), `/assets/…` is cache-first (content-hashed, so a hit is always
correct), everything else same-origin is stale-while-revalidate. Cross-origin
requests, non-http(s) schemes and range requests are never intercepted. Bumping
`VERSION` is the entire cache-busting mechanism: activation deletes every
`pikado-*` cache that is not the current one.

`public/manifest.webmanifest` makes it installable: `display: standalone`, relative
`start_url`/`scope`/icon paths so a subdirectory deployment works, and 192/512
PNG icons (iOS ignores the manifest icons, hence the `apple-touch-icon` link in
`index.html`). Because dynamic imports are never fetched during boot, `main.js`
warms `effects/styles-dialog.js`, `core/smart.js` and `ui/dialogs/smart-object.js`
on idle — otherwise the worker would have nothing cached for them and going
offline before opening Layer Styles would give you a 503.

## `src/ui/welcome.js` — the start screen

```
installWelcome(areaEl) -> HTMLElement   // mount into `.pk-canvas-area`
refreshWelcome()                        // re-read recents + storage figures, repaint
```

Shown whenever `app.activeDoc` is null; nothing is created automatically at boot,
so this is what you land on. It offers templates (`app.newDocument`), the shared
hidden `#file-input`, and the recent projects from `io/session.js`.

Two things to know if you touch it: the `app.on(...)` and
`sessionEvents.on('recents-change')` subscriptions are made **once**, guarded by a
module-level `wired` flag, because they read the module-level `root` and would
otherwise fire twice per event after a remount; and thumbnails are `<img>`
elements fed by `URL.createObjectURL`, so every repaint revokes the previous URLs
or they leak. `refreshWelcome` is async and guards against an older repaint
landing after a newer one via a paint token.

## `src/ui/brand.js`

```
BRAND      // {name, tagline, violet, violetDeep, violetLift, cyan, cyanLift}
OVERLAY    // {accent, accentHi, accentSoft, handleFill, handleStroke, guide, warn}
brandMark({size, className, title}?) -> SVG string
brandLock({size, wordSize, className}?) -> HTML string     // mark + wordmark
brandMarkEl(opts) -> SVGElement
faviconDataURI() -> string      installFavicon()
```

**Use `OVERLAY` for anything drawn on the canvas.** On-canvas chrome — transform
handles, guides, crop boxes, brush crosshairs — is drawn with `ctx.strokeStyle`,
which cannot read a CSS custom property, so these are the same values as the
tokens in `styles.css` kept in one place. Hard-coding a colour is how the old
Adobe blue creeps back in.

The mark's gradient and mask ids are **suffixed per instance** (`pk1a`, `pk2a`, …)
because several marks share a page and duplicate ids would make every one of them
use the first mark's gradient. `faviconDataURI` is written out separately for that
reason — it needs no runtime counter.

## `src/io/gif.js`

```
buildPalette(data, maxColors) -> [[r,g,b], …]   // median cut over sampled pixels
lzwEncode(indices, minCodeSize) -> Uint8Array
encodeGIF(canvas, transparent = true) -> Blob   // GIF89a, single frame
```

Canvas cannot write GIF, so the quantiser and the LZW coder are ours. Single
frame only. `transparent` reserves a palette slot, but only if the image actually
has a pixel with alpha < 128 — otherwise all 256 slots go to colour. Shared by
the Export dialog and `exportDocument()` in `io/save.js` so both produce identical
files.

---

## Files each area owns

Never write outside your own list — parallel work depends on it.

- `src/tools/*.js` — one file per tool group (see the table above)
- `src/filters/{blur,distort,noise,pixelate,render,sharpen,stylize,other}.js`
- `src/adjustments/{basic,advanced}.js`
- `src/effects/{effect-renderers,styles-dialog}.js`
- `src/ui/{menubar,toolbar,options-bar,statusbar,tabbar,shortcuts,panel-host}.js`
- `src/ui/panels/*.js`
- `src/ui/dialogs/*.js`
- `src/commands/definitions.js`
- `src/io/{open,save,psd-read,psd-write,svg,pkd,gif}.js`
- `src/io/{store,session,offline}.js` + `public/sw.js`, `public/manifest.webmanifest`
- `src/edit/{clipboard,fill-stroke}.js`
- `src/render/{fast-blur,gpu-blend}.js`
- `src/ui/{welcome,canvas-menu,brand,curve-editor,gradient-editor}.js`
- `src/core/smart.js`
- `src/select/{maxflow,grabcut,refine}.js`
- `src/vector/path.js`, `src/text/text-render.js`

**CSS:** put component styles in a sibling `.css` file and `import './x.css'`
from your module. Vite bundles it. Never edit `src/styles.css`.

Base classes available from `src/styles.css`: `pk-btn`, `pk-btn primary`,
`pk-btn subtle`, `pk-icon-btn`, `pk-input`, `pk-select`, `pk-range`, `pk-num`,
`pk-check`, `pk-radio`, `pk-field`, `pk-form`, `pk-slider-row`, `pk-sep`,
`pk-vsep`, `pk-hint`, `pk-unit`, `pk-scroll`, `pk-truncate`, `pk-spacer`,
`pk-checker`, `pk-empty`, `pk-micro` (small caps label), `pk-tabular` (tabular
numerals — use it for any figure that changes as you drag).
CSS variables: `--bg-0..4`, `--fg`, `--fg-dim`, `--fg-bright`, `--line`,
`--line-soft`, `--accent`, `--accent-hi`, `--accent-dim`, `--accent-soft`,
`--danger`, `--row-h`, `--radius`.

---

## The test suite

**The suite is the contract.** It lives in `tests/`, runs in a real browser, and
must be green before anything ships.

```
tests/index.html      the runner page — also hosts a real, off-screen app shell
tests/run.js          imports /src/main.js to boot the app, then every suite
tests/harness.js      suite() + the assertion context
tests/suites/*.test.js  core, compositor, paint, filters, adjustments, layers,
                        effects, text-vector, io, smart, perf
```

**Running it:** open `http://localhost:5174/tests/` on the dev server. Automation
reads `window.__pikadoTests` (the full report) once `window.__pikadoTestsDone` is
true. Node is not an option: essentially every subsystem depends on working
Canvas2D or WebGL, and a jsdom canvas would make the suite meaningless.
`tests/index.html` boots the genuine app off-screen at 1280×860 so tool
registration, panels, menus and `ResizeObserver` are all exercised.

Writing a suite:

```js
import { suite } from '../harness.js';

suite('my feature', async (t) => {
  const doc = t.doc(100, 100, '#ffffff');   // registered with the app, auto-closed
  t.pixel(canvas, 50, 50, '128,128,64,255', 'multiply is exact');
});
```

`suiteOnly` / `suiteSkip` exist for debugging. Assertions **record and continue**,
so one failure does not hide the rest; a thrown error fails the whole suite and is
reported with its stack.

Assertion context `t`:

| | |
|---|---|
| `t.ok` / `t.notOk` | truthiness |
| `t.eq` / `t.ne` | **deep** structural equality |
| `t.is` / `t.isNot` | reference identity (`===`) |
| `t.close(a, b, tol, msg)` | numeric tolerance |
| `t.lt` / `t.gt` | bounds — use for timings |
| `await t.throws(fn, msg)` | asserts a throw |
| `t.px(canvas, x, y)` | `"r,g,b,a"` string |
| `t.pixel(canvas, x, y, expected, msg)` | exact pixel assertion |
| `t.mad(a, b)` | mean absolute difference of two ImageData/byte buffers |
| `t.bytes(canvas)` / `t.inked(canvas, threshold?)` | raw pixels / count of pixels above an alpha |
| `t.doc(w, h, fill, name)` | scratch document, closed after the suite |
| `t.fill(layer, colour, x, y, w, h)` / `t.detail(layer)` | fixtures |
| `t.time(fn)` | elapsed ms for a synchronous call |
| `t.app` | the **live** app singleton |

### The two traps written into the harness

**1. HMR module duplication.** On the Vite dev server modules are served with an
HMR query string, so a bare `import('/src/core/app.js')` instantiates a *second*
app object with empty registries — tests would silently drive a dead app and pass
vacuously. `harness.js` reaches the singleton through an already-registered tool
(`tools` from `/src/tools/base.js`), falling back to `window.pikado`. Use `t.app`;
never import `app.js` in a test. The same trap applies to any module with
top-level state — registries, the panel host, `app.patterns` — so read those off
the live app too.

**2. Layer references go stale across undo.** `restoreState` rebuilds every
`Layer` from its snapshot, so a reference held across `undo()`/`redo()` points at
an orphan that is no longer in the tree. Asserting on it is a vacuous check: it
still holds the *old* pixels, so the test passes whatever the code did. Hold
`layer.id` and re-resolve with `doc.findLayer(id)` after any history move —
`tests/suites/compositor.test.js` does exactly this throughout, and
`tests/suites/core.test.js` asserts the rebuild itself with `t.isNot`.

A related note on `t.eq`: it is deep, so two distinct objects with identical
contents compare equal. Any assertion about identity ("undo rebuilt the objects",
"the cache returned the same canvas") must use `t.is` / `t.isNot` or it proves
nothing.

Also beware the timer trap the runner itself hit: a backgrounded tab throttles
`setTimeout` to once per second (and after a few minutes, roughly once per
minute), and `requestAnimationFrame` does not fire at all. The runner yields
between suites with a `MessageChannel` task for that reason. Do not build a test —
or any browser verification — around `rAF`.
