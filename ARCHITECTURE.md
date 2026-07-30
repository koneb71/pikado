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
`getImageData`, `putImageData`, `imageDataToCanvas`, `clamp`, `clamp255`,
`lerp`, `deg2rad`, `rad2deg`, `nextZoom`, `formatBytes`, `download(blob,name)`,
`loadImage(blobOrUrl)`, `readFileAsArrayBuffer`, `readFileAsText`,
`rafThrottle`, `debounce`, and **`el(spec, attrs, ...children)`**.

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
app.view                       // the CanvasView instance (set at boot)

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

## `src/core/document.js` — `PikaDocument`

```
doc.width doc.height doc.name doc.resolution doc.layers[] doc.paths[]
doc.selection (Selection)   doc.history (History)   doc.alphaChannels[]
doc.guides[]  // {axis:'h'|'v', pos:number}
doc.quickMask  doc.dirty

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
layer.addMask(w,h,fill?)   layer.removeMask()   layer.touchMask()
layer.maskAlphaCanvas()    // cached alpha-only clip source
layer.clone()  layer.contentBounds()  layer.thumbnail(size)
```

Factories: `createRasterLayer(w,h,name)`, `createGroupLayer(name)`,
`createAdjustmentLayer(kind, params, w, h, name)`.

## `src/core/selection.js` — `Selection`

Coverage mask, `Uint8ClampedArray` of `w*h`, or `null` for "no selection".

```
sel.active  sel.mask  sel.width sel.height  sel.version
sel.at(x,y) -> 0..1        sel.bounds() -> {x,y,width,height}|null
sel.selectAll() sel.clear() sel.invert() sel.set(mask) sel.clone()
sel.combine(mask, 'replace'|'add'|'subtract'|'intersect'|'xor')
sel.fromPath(path2d, mode, opts)
sel.feather(r) expand(n) contract(n) border(w) smooth(r) translate(dx,dy)
sel.toCanvas()        // greyscale
sel.toAlphaCanvas()   // alpha-only, for destination-in
sel.contour()         // Path2D for marching ants
Selection.rasterizePath(path, w, h, opts)  .rectMask(...)  .ellipseMask(...)
Selection.fromCanvas(canvas)
```
Also exported: `boxBlurMask(mask,w,h,r)`, `morph(mask,w,h,r,grow)`.

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
```

### `src/render/viewport.js` — `Viewport`
```
vp.scale offsetX offsetY rotation viewWidth viewHeight
vp.toDoc(sx,sy) -> {x,y}    vp.toScreen(x,y) -> {x,y}    vp.matrix()
vp.fit(dw,dh,pad?,maxScale?)  vp.center(dw,dh)  vp.setScale(s, ax?, ay?)
vp.zoomStep(dir, ax, ay)  vp.zoomBy(f, ax, ay)  vp.pan(dx,dy)  vp.setRotation(rad)
```

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
  drawOverlay(ctx, view) {}       // ctx is in SCREEN space
  commit() {}  cancel() {}        // Enter / Escape
  onActivate() {}  onDeactivate() {}
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

---

## ParamDescriptor (options bars, filter dialogs, adjustment dialogs)

```js
{ key, label, type, min, max, step, default, options, unit, hint, when(state) }
```
`type`: `slider | number | select | checkbox | color | angle | text | textarea |
radio | label | separator | button | custom`.

- `select`/`radio` `options`: `['a','b']` or `[{value, label}]`.
- `when(state)` hides the row when it returns false.
- `custom` uses `render(container, state, onChange, descriptor)` and may return
  `{sync(value)}` so the form can push external updates back in.

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
`ICON_NAMES`. Use these names, do not invent inline SVG. Missing names render a
dashed placeholder rather than throwing.

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
`commitSurface(doc, layer, canvas, label)`, `operableSurface(doc, layer)`.

## Adjustments — `src/adjustments/registry.js`

```js
registerAdjustment({
  id: 'levels', name: 'Levels...', group: 'tone',
  params: [...],           // may include a `custom` descriptor for curve UIs
  apply(imageData, params, ctx) {},
  layerable: true,         // false = destructive only
});
```
Helpers: `buildLUT(fn)`, `applyLUT(imageData, r, g, b)`, `mixImageData(a,b,t)`,
`defaultParams(id)`, `getAdjustment(id)`, `listAdjustments()`.

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
`spreadAlpha(alpha,w,h,amount)`, `offsetAlpha(alpha,w,h,angle,distance)`.
The renderer returns a **document-sized canvas**; `applyLayerStyles` handles
opacity and blend mode from `cfg`.

## Brush engine — `src/paint/brush-engine.js`

```js
const stroke = new PaintStroke({
  doc, layer, target: layer.paintTarget(),
  brush: brushFromOptions(this.state),
  mode: 'paint' | 'erase',
  color: '#ff0000',            // or {r,g,b,a}
  sourceImage, sourceMap,      // clone/pattern stamp
  lockTransparency, selectionClip,
});
stroke.begin(x, y, pressure);  stroke.move(x, y, pressure);  stroke.end();
stroke.flush();                // rebuild layer = base + buffer*opacity
stroke.onFrame = () => doc.touch();  // airbrush repaint hook

new EffectStroke({ doc, layer, target, brush, strength, op(region, meta) {...} })
```
Also `makeTip(spec)`, `DEFAULT_BRUSH`, `brushOptionDescriptors(flags)`,
`brushFromOptions(state, extra)`.

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
`flattenImage`, `stampVisible`, `rasterizeLayer`, `rasterizeLayerStyle`,
`addLayerMask(doc, layer, kind)`, `deleteLayerMask`, `applyLayerMask`,
`toggleMaskEnabled`, `addAdjustmentLayer(doc, kind, params, name)`,
`addFillLayer`, `toggleClipping`, `setLayerProps`,
`convertBackgroundToLayer`, `convertLayerToBackground`, `trimDocument`.
All take `doc` first and record their own history entry.

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
- `src/io/{open,save,psd-read,psd-write,svg}.js`
- `src/vector/path.js`, `src/text/text-render.js`

**CSS:** put component styles in a sibling `.css` file and `import './x.css'`
from your module. Vite bundles it. Never edit `src/styles.css`.

Base classes available from `src/styles.css`: `pk-btn`, `pk-btn primary`,
`pk-btn subtle`, `pk-icon-btn`, `pk-input`, `pk-select`, `pk-range`, `pk-num`,
`pk-check`, `pk-radio`, `pk-field`, `pk-form`, `pk-slider-row`, `pk-sep`,
`pk-vsep`, `pk-hint`, `pk-unit`, `pk-scroll`, `pk-truncate`, `pk-spacer`,
`pk-checker`, `pk-empty`.
CSS variables: `--bg-0..4`, `--fg`, `--fg-dim`, `--fg-bright`, `--line`,
`--line-soft`, `--accent`, `--accent-soft`, `--danger`, `--row-h`, `--radius`.
