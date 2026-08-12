# Pikado

A browser-based raster and vector image editor in the spirit of Photopea and
Photoshop. Everything runs client-side — no server, no upload, no account.

Two things reach the network, and only these two. **Generative Fill** is off
until you supply your own API key, and then sends the part of your image you
selected to the provider you chose; it asks before the first time. **Web fonts**
are downloaded from Google Fonts when you use one — a download, not an upload,
kept on your device afterwards so it works offline, and switchable off in
Preferences. Nothing else leaves your machine, and everything keeps working
without either.

```bash
git clone https://github.com/koneb71/pikado.git
cd pikado
npm install
npm run dev      # http://localhost:5173 (Vite takes the next free port if busy)
npm run build    # production bundle in dist/
npm test         # opens the regression suite at /tests/
```

Vite is the only dependency. There is no build step to configure, no framework,
and no TypeScript — the source is plain ES modules that a browser could load
directly.

Or with Docker, which builds the bundle and serves it from nginx:

```bash
docker build -t pikado .
docker run --rm -p 8080:80 pikado    # http://localhost:8080
```

Nothing runs server-side, so the image carries no Node at all — just nginx and
about 1.2 MB of static files. The nginx config in `docker/nginx.conf` is not
boilerplate: it caches the content-hashed `/assets/` forever and forbids caching
`index.html` and `sw.js`, because those two name everything else and a stale copy
of either is how a browser ends up asking for asset hashes the server no longer
has.

## Demo
https://pikado.koneb.me

<img width="1799" height="1041" alt="image" src="https://github.com/user-attachments/assets/d999296e-0532-469d-a47b-0f8b63c984b3" />


## What it is

Pikado is a real layered image editor, not a canvas demo. The document model,
compositor, brush engine and history system are built the way a desktop editor
builds them:

- **Layers** — raster, text, shape, group, adjustment and fill layers, with
  masks, clipping masks, blend modes, opacity/fill opacity and layer effects.
- **Compositing** — all 27 Photoshop blend modes. Canvas2D handles the ones it
  natively supports; the rest (Linear Burn, Vivid Light, Divide, Darker Colour,
  …) run in a fragment shader, with an exact CPU path kept for small documents.
- **Selections** — stored as an 8-bit coverage mask, so feathering, antialiasing
  and partial selection are exact rather than approximated by paths. Select and
  Mask refines a boundary with real alpha matting, and Select Subject is a
  graph cut rather than a guess (see below).
- **History** — snapshot-based undo with copy-on-write pixel buffers, so a
  history step costs a few hundred bytes unless pixels actually changed.
- **Non-destructive editing** — adjustment layers re-process the composite
  beneath them on every render; layer effects are generated at composite time.
  Smart Objects keep a real embedded document and re-render from it every time.

## Opening it

There is no blank `Untitled-1` waiting for you. With nothing open you land on a
start screen: a handful of sizes people actually start from, a file picker, and
your recent projects with thumbnails, dimensions, layer counts and when you last
touched them. Drop a file anywhere on the window and it opens — hold Shift to
place it into the current document as a layer instead. Close the last document
and the start screen comes back.

The footer states plainly how many projects are held in this browser and how many
bytes that is, with the browser's own quota estimate in the tooltip — because an
app that stores your work locally owes you a way to see it.

## Your work stays in this browser

Pikado autosaves. Open documents survive a refresh, a crash, and a laptop lid.
There is no server and no account, and nothing is uploaded — with the single,
opt-in exception of [Generative Fill](#generative-fill), which needs your own API
key and asks before it sends anything.

- **Where.** IndexedDB, with the metadata and the payload in *separate* object
  stores: a small record per project (name, size, layer count, timestamp,
  thumbnail) on one side, the project bytes on the other. IndexedDB hands back
  whole records, so keeping a 50 MB payload out of the metadata store is what
  lets the start screen list twenty projects instantly.
- **What.** The payload is a `.pkd` blob — byte for byte the same lossless format
  `File > Save` writes. Persistence and export share one serialiser, so there is
  no second "autosave schema" to drift out of step and no format you cannot open
  again by hand. Undo history is deliberately not persisted: Photoshop does not
  either, and it would multiply the payload by the number of history states.
- **When.** This is the part that needed thought. Serialising a large document
  takes one to two seconds — every layer is PNG-encoded — and `beforeunload`
  cannot wait for asynchronous storage, so a save triggered *by* the refresh
  would never finish. Saving on a timer instead: 1.2 s after you stop editing,
  never more often than every four seconds per document, and immediately when the
  tab is hidden, which is the last reliable moment before a reload or a close.
  That bounds what a refresh can cost you to the few seconds since the last quiet
  moment, without spending a drag-heavy session encoding PNGs.
- **Limits, stated.** A single project over 320 MB is not autosaved, and says so
  in a toast rather than failing quietly. The store is capped at 1.2 GB; past
  that, the least recently touched projects are evicted, and anything currently
  open is never evicted. Removing a project from the start screen deletes the
  stored copy for good, behind a confirmation. Some private-browsing modes refuse
  IndexedDB entirely — then autosave stays off, and the refresh confirmation
  prompt comes back, because in that one case a refresh really would lose work.

## Offline, and installable

Pikado never needed the network to do its work — every pixel is processed in the
tab. "Offline" only ever meant the shell could not be downloaded. A service
worker fixes that: the first visit caches the app, every later visit runs from
the cache, and a cold start with no network works.

The worker is hand-written rather than generated, because Vite hashes asset
filenames and a precache manifest would have to be built alongside them. It picks
a strategy per URL: navigations are network-first (the newest `index.html` names
the current hashed assets), `/assets/…` is cache-first (a content hash means the
bytes behind that name can never change), everything else same-origin is
stale-while-revalidate. Cross-origin requests are never intercepted. It is
registered in production builds only — in front of the dev server it would answer
module requests from its own cache and make your edits appear to do nothing.

A web manifest makes it installable as a standalone app. Losing the network gets
a quiet pill in the menu bar and one reassuring line, not a red banner, because
in an app that keeps your work locally it is not an error. When a new version has
been fetched you get an "Update ready" button; Pikado will not reload the page on
your behalf, since you might be halfway through a brush stroke.

## Selecting the hard things

Most selection tools answer "which pixels look like the one I clicked". Select
and Mask answers a harder question — "where does this object end" — and it does
it with two classical algorithms rather than a model.

**The cut.** Paint a few strokes to say what is definitely subject and definitely
background. Pikado fits a five-component Gaussian mixture to each set of colours,
builds a graph where every pixel is a node whose links to its neighbours are
cheap across an edge and expensive across flat colour, and takes the minimum cut
with the Boykov–Kolmogorov max-flow algorithm. Then it refits both mixtures from
the result and cuts again. That is GrabCut, and it is genuinely good at finding
where one material stops and another starts.

**The matte.** A cut is binary, and real edges are not. Set a Radius and Pikado
stops trusting the cut inside a band around the boundary and asks the image
instead: given the foreground and background colours typical of this
neighbourhood, what mixture is this pixel? The closed-form answer to the
compositing equation is what recovers hair, fur and motion blur. Where it cannot
tell — where the two sides are the same colour — it keeps the cut's answer rather
than inventing a number.

Then the familiar controls: Smooth, Feather, Contrast, Shift Edge, and
Decontaminate Colors to pull the green screen out of the fringe. Seven view modes
(Onion Skin, Marching Ants, Overlay, On Black, On White, Black & White, On
Layers), and five outputs — selection, layer mask, new layer, new layer with
mask, new document.

Everything upstream stays live while you work: the sliders re-run from the cut,
the cut re-runs from your strokes, and nothing is baked until you press OK. So
you can reach for Radius after twenty brush strokes and it behaves as if you had
set it first.

**Select Subject** is the same machinery with the strokes guessed for you, from a
histogram-contrast saliency measure and a centre prior. It works on a subject
that stands out from its background. It does not know what a person is, and when
saliency finds nothing convincing it says so instead of selecting the whole
frame.

## Camera Raw

A develop module: white balance, exposure, the four tone-region sliders, contrast,
a tone curve, texture, clarity, dehaze, an eight-band colour mixer, colour
grading, sharpening, noise reduction, grain and vignette. `Shift+Ctrl+A`, or
Filter > Camera Raw Filter.

It is registered as an ordinary filter, and that is the interesting part: a filter
is what a Smart Object's filter stack stores, so on a Smart Object the whole
develop module becomes non-destructive — re-editable, re-orderable, switchable
off — with no extra machinery. At its defaults it renders the source *byte for
byte*, so adding it costs nothing until you move something.

Everything tonal runs in linear light, which is where exposure is a multiply:
+1 EV takes a mid grey from 128 to 176, not to 255. The tone-region sliders work
on encoded lightness instead, because that is what makes them feel linear — the
same gain applied to linear light is invisible in deep shadow.

Two honest notes. This is the Camera Raw *filter*, working on 8-bit RGB, so
highlight and black recovery has an 8-bit ceiling: what is clipped in the file is
gone, and no slider can invent it. And Temperature is a relative −100…+100 slider
rather than a Kelvin reading, because a rendered sRGB image has no sensor white
balance to set — the same choice Photoshop makes for this filter on a non-raw
layer.

## Generative Fill

Select a region, describe what should be there, and the result arrives as a new
layer masked to your selection — non-destructive, so you can generate three
attempts and keep the one that works. It sits next to Content-Aware Fill in the
Edit menu, because they are the same job done two ways.

**This is the only part of Pikado that can send your work anywhere.** (Web
fonts also use the network, but only ever to fetch a font — see
[Fonts](#fonts).) So it is built to be refused easily:

- **You bring the key.** Pikado ships no API credentials — in a static
  client-side app there is no such thing as a secret key, because anything in the
  bundle is readable in devtools. The key is yours, and Pikado never sees a
  server that could hold one on your behalf. **OpenAI** and **Gemini** are both
  supported; keys are held per provider, so switching between them cannot send
  one vendor's key to the other's endpoint.
- **The key is not stored unless you ask.** By default it lives in the tab's
  memory and a refresh forgets it. "Remember on this device" puts it in
  IndexedDB, in plain text, and the dialog says exactly that rather than implying
  browser storage protects anything from a script running on the page.
- **It cannot end up in your files.** The key is never a property of a document
  or a layer, so it cannot reach a `.pkd`, an autosave, a history state or a PSD
  export. The module exports no way to read the key back; the only thing it can
  do is write itself into a request header, which is what stops it appearing in a
  URL, a log line, or an error message on screen.
- **Consent is separate from the key.** Pasting a key is not agreeing to upload a
  picture, so the first send to any host asks again, names the host, and lists
  what leaves and what does not. Consent is per host, so agreeing to send to one
  provider says nothing about the other.
- **The key travels in a header, never a URL.** That is worth stating because
  Google's own quickstart puts the key in a query string, and query strings end
  up in proxy access logs, browser history and `Referer` headers. Pikado uses
  `x-goog-api-key`, and a test asserts the URL has no query string at all.
- **Nothing runs by accident.** With no key and no consent the operation refuses
  before it builds a request, and that check lives in the AI layer rather than
  the dialog, so calling the command directly cannot get around it.

- **You pick the model, and how hard it works.** Edit > AI Settings holds both,
  per provider. OpenAI offers GPT Image 2 (the default), 1.5 and 1 mini with a
  **Quality** of auto, low, medium or high; Gemini offers 3.1 Flash Image, 3.1
  Flash Lite, 3 Pro and the legacy 2.5 Flash, with a **Thinking** level on the
  two that accept one. The effort control also appears in the Generative Fill
  dialog itself, since that is the moment the choice costs something — it is the
  same stored setting, not a second one.

  Two things about that are deliberate. **There is no "reasoning effort" here,
  because image models do not have one** — that is a text-model parameter, and
  sending it would simply be an unknown field. Quality and thinking level are
  the real dials, so those are the names used. And the effort control is
  attached to the *model*, not the provider: Gemini takes a thinking level on
  its 3.1 image models, has no documented control for it on 3 Pro, and rejects
  it outright on 2.5 Flash — so the control disappears on the models that cannot
  take it rather than sending a field that fails.

One difference between the two is worth knowing: OpenAI's edit endpoint takes a
real mask, and Gemini's does not — so for Gemini the selected region is knocked
out of the image before sending and the prompt asks for it back. Gemini may
return a whole new frame rather than only the missing piece, which is why the
result is composited through the layer mask either way: anything it repaints
outside your selection is masked off rather than silently replacing your picture.

There is also a Mock (offline) provider that generates a hatched placeholder with
no key and no network. It exists so the whole path — setup, consent, progress,
cancellation and every error — can be exercised in the test suite and by hand;
add `?ai=mock` to the URL to get it. It is not in the normal dropdown, because
beside two real providers a test double reads as a third one that is broken.

**Help > Using Generative Fill** has the whole thing as instructions, in the app,
for the same reason it needs them: the setup lives in a different dialog from the
feature, and it is the one thing here that spends money.

What actually gets sent is the selection plus the pixels around it, squared off
and scaled to the provider's size. Where the document allows, the crop grows to
the full request size rather than upscaling a tight bounding box, so a small
selection in a large image is sent at native resolution with real context around
it instead of a blurry enlargement.

## Frame animation

Window > Timeline gives you a filmstrip. A frame is a *record of layer state* —
which layers are visible and at what opacity — not a copy of the picture, so a
twenty-frame animation costs twenty small objects rather than twenty canvases,
and painting on a layer updates every frame that shows it.

Select a frame and work normally: what you change is written back into the frame
you are on. Make Frames From Layers turns a stack of drawings into an animation
in one click, Tween fills in the frames between two, and each frame carries its
own delay. Export as GIF and it animates automatically, with each frame given its
own colour table so a changing palette does not band.

What it does not animate is *position*: layer buffers here are always
document-sized with no per-layer offset, so there is nowhere for a per-frame
position to live. Move something by duplicating the layer, or cross-fade by
animating opacity.

## Colour management

Six working spaces (sRGB, Adobe RGB 1998, Display P3, ProPhoto RGB, Rec. 2020,
Gray Gamma 2.2), Assign Profile and Convert to Profile under the Image menu, and
soft proofing with a gamut warning under View.

The distinction the two commands exist to make: **Assign** relabels the pixels
without moving them, so the picture looks different; **Convert** moves the pixels
so it looks the same. Convert clips whatever the destination cannot hold, which is
why converting into a smaller space is lossy and converting back does not bring it
back — and why the dialog says so before you press the button.

Soft proofing is a *view*: `Ctrl+Y` simulates another space on screen, `Shift+Ctrl+Y`
paints grey over everything that space cannot reproduce. The document's pixels
never change, so Save, Export and every filter keep reading the real numbers.

The maths is checked against published values rather than against itself: the sRGB
primaries have to reproduce the published sRGB→XYZ matrix, RGB (1,1,1) has to land
exactly on each profile's white point, a profile-to-itself transform has to be the
identity to floating-point precision, and a round trip through a wider gamut has
to be lossless.

Embedded profiles are read from JPEG (APP2) and PNG (iCCP) when you open a file.
Matrix/TRC profiles only — LUT-based profiles are declined with a reason rather
than misinterpreted, and since Perceptual and Saturation live entirely in those
tables, those two intents behave as Relative Colorimetric and the dialog tells you
so.

## Right-click does the right thing

Right-clicking the canvas asks the active tool what it can do *here*, at the
point you clicked. Right-click an anchor with the Pen and you get Delete Anchor
Point and Convert to Corner/Smooth; right-click a segment and you get Add Anchor
Point; either way followed by Make Selection, Fill Path, Stroke Path. Move lists
every layer under the cursor so you can pick the one you meant, then Duplicate,
Delete, Group, Merge Down and Rasterize. A selection tool offers the selection
workflow — Deselect, Select Inverse, Feather/Expand/Contract, Layer via Copy or
Cut, Fill, Stroke, Content-Aware Fill — and with no selection yet it offers the
ways to get one instead. Mid-polygon it is just Close Path and Cancel, because
that is all that makes sense mid-gesture. The Ruler offers Clear Measurement.

Every menu also carries a short shared tail (Free Transform, Fit on Screen,
100%), so right-click is never a dead gesture even on a tool with nothing
specific to say.

Entries are mostly references to existing commands, so labels, keyboard shortcuts
and enabled state come from one place and cannot disagree with the menu bar.
Items that cannot apply right now are dropped rather than shown greyed, and the
separators around them close up.

## Fonts

Thirty families are built in. The rest of Google Fonts — 1,941 of them — is
behind **Type ▸ Manage Fonts**, with search, category filters, and a specimen of
each rendered in its own face. The same list is the last row of every font
picker, because "which font?" and "is there another font?" are the same
question.

**A font you download is kept.** The bytes go into IndexedDB and are registered
again on the next visit, so a family works with the network off — including when
you reopen a document that uses it. That is the reason downloading is byte-level
rather than a stylesheet link: a link works while you are online and silently
does not afterwards.

Only the Latin faces are fetched. This is not a nicety — Noto Sans JP is 124
separate files and about 5 MB for a single weight, of which exactly one is
Latin, so the difference is a 43 KB download against a 5 MB one.

A `.pkd` records which families its text uses, with their category and weights —
a reference, never the font file. Reopening fetches what is missing; if it
cannot, the text renders in a substitute of the right shape (a serif for a
serif) and one message names what is missing. The layer keeps naming the font it
wants, so the document heals the moment the family turns up rather than being
permanently rewritten to the substitute.

The catalogue itself is generated at build time by
`scripts/fetch-google-fonts.mjs` and committed — 1,941 families in 15 KB
gzipped, loaded only when the browser opens. There is no API key anywhere: the
endpoint that lists them is unreachable from a browser, and a key in a
client-side bundle is not a secret.

## Things line up

Drag a layer, pull out a selection, draw a shape, slide a crop box or move a
transform box, and it catches on what is near it: the guides you placed, the
document's own edges and centre, the grid, and the edges and centres of the
other layers. When two candidates are equally close a guide beats a document
edge beats a neighbouring layer beats the grid — otherwise a guide sitting one
unit off a grid line would be unreachable. Hold <kbd>Ctrl</kbd> to place
something exactly where you dropped it, or turn the whole thing off with
<kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>;</kbd>.

Magenta lines show what the drag is currently lined up with, and if it lines up
with three things at once you see all three. They are drawn from what the
solver reports it aligned, so they cannot claim an alignment that did not
happen.

The tolerance is six *screen* pixels, converted to document units by the
caller. That distinction is the whole feature: a fixed document-space tolerance
is an invisible twitch at 800% zoom and a sixty-unit leap at 10%.

Each drag snaps the thing it is actually moving — a corner being pulled out
snaps as a point, a box being slid snaps as a rectangle, so its far edge
catches a guide as readily as its near one. A rotated crop box and a rotated or
skewed transform deliberately do not snap: they work in their own space, and a
guide is a line in the document's.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full API contract. The short
version:

```
src/
  core/        document, layer, selection, history, colour, blend modes,
               smart objects, snapping, app singleton
  render/      compositor, viewport, GPU blend shader, GPU blur
  paint/       brush engine, patterns, gradients
  tools/       one module per toolbar group
  filters/     filter registry + implementations by menu
  adjustments/ adjustment registry + implementations
  effects/     layer style renderers + the Layer Style dialog
  select/      graph-cut segmentation, alpha matting, edge refinement
  color/       ICC profiles, conversions, soft proofing
  vector/      path model, geometry, shape rasterizing
  text/        text layout, rasterizing, the font catalogue and downloader
  layers/      layer operations (merge, group, mask, rasterize…)
  edit/        clipboard, fill & stroke
  commands/    command registry + every menu command
  io/          open/save, PSD read & write, SVG, GIF, native .pkd format,
               IndexedDB store, session autosave, offline registration
  ui/          menubar, toolbar, options bar, panels, dialogs, canvas view,
               start screen, canvas context menu, brand
public/        service worker, web manifest, install icons
tests/         the regression suite (see below)
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

## Tests

```bash
npm test          # or just open /tests/ on the dev server
```

The suite runs in a real browser, not Node — essentially every subsystem here
depends on working Canvas2D or WebGL, and a jsdom canvas would make the whole
thing meaningless. The runner boots the genuine app off-screen first, so tool
registration, panels and menus are exercised on the way in, then asserts against
the live registries. It reports counts at the top of the page and leaves the full
report on `window.__pikadoTests` for automation.

The assertions are about measurements, not smoke: exact pixel values, mean
absolute difference between before and after, pixel counts, and timings with
upper bounds. See the *Test suite* section of
[ARCHITECTURE.md](ARCHITECTURE.md#the-test-suite) for the harness API and the two
traps the suite is built to avoid.

## File formats

| Format | Open | Save |
|---|---|---|
| PNG / JPEG / WebP | yes | yes |
| GIF | first frame (all frames where `ImageDecoder` exists) | yes — animated, per-frame palettes + LZW |
| PSD / PSB | yes — layers, groups, masks, blend modes, text, adjustments | yes — layered, see caveats below |
| SVG | yes — rasterized, with simple shapes kept as editable paths | yes |
| `.pkd` (Pikado native) | yes | yes — lossless, preserves everything |

`.pkd` is the format to use when you care about keeping your work intact. PSD
export writes real layer records — including adjustment layers, masks, group
nesting, blend modes and fill opacity — but see the limits below.

<!-- ============================================================
     OWNED BY THE LEAD — DO NOT EDIT THIS SECTION.

     The "What is *not* implemented" section below is being closed out by
     several agents in parallel. The lead rewrites it in one pass whenever a
     wave lands, once every gap in that wave is either closed or confirmed
     still open. Editing it mid-flight produces conflicting claims about what
     ships.

     If you close one of these items, say so in your report and leave the
     section alone.
     ============================================================ -->

## What is *not* implemented

Stated plainly so you don't find out by clicking:

- **On-device AI.** Generative Fill (above) works by asking a cloud provider with
  your own key. Nothing in Pikado runs a model locally yet, so every AI feature
  needs a network and an account somewhere else. Subject selection, upscaling and
  denoising are all things a browser could genuinely run on-device with a small
  ONNX model, and none of them are here — which means Select Subject stays
  classical, below, and there is no key-free AI at all.
- **Raw decoding, the 3D workspace, and video.** Camera Raw is present as a
  develop module (above), but Pikado cannot *decode* a raw file — CR2/NEF/ARW need
  per-sensor demosaicing and calibration data, and that is not here. No 3D
  workspace, and no video import or export.
- **A trained model behind Select Subject.** Photoshop's is a neural network;
  Pikado's is classical computer vision — histogram-contrast saliency to guess
  where the subject is, then GrabCut (iterated graph cuts over Gaussian mixture
  colour models) to find its boundary. That is a real algorithm with real
  behaviour, not a stub: it finds the boundary between two *colour
  distributions*, so it does well on a subject that stands out from its
  background and honestly not well on one that shares its palette. A few brush
  strokes in Select and Mask fix that, which is how GrabCut is designed to be
  used. It has no idea what a person or a cat is.
- **CMYK and Lab as document modes, and 16-bit.** Colour management is present
  for RGB and grey (above), but everything is 8-bit internally, CMYK and Lab exist
  as colour maths rather than as modes, and 16-bit PSDs open by converting down.
  LUT-based ICC profiles — which is what a CMYK printer profile is — are
  recognised and declined with a reason rather than misread. A convert into a much
  larger space and back therefore costs a little precision that a 16-bit pipeline
  would not (the test suite pins it under 2.2 mean absolute difference).
- **Position in a frame animation.** The timeline animates visibility and opacity.
  Layer buffers here are always document-sized with no per-layer offset, so there
  is nowhere for a per-frame position to live and nothing in the compositor that
  would honour one — a control that stored a number and moved nothing would be
  worse than its absence. Duplicate the layer to move something, or animate
  opacity to cross-fade.
- **Face-aware Liquify.** Everything else in Liquify is there — Forward Warp,
  Reconstruct, Smooth, both Twirls, Pucker, Bloat, Push Left, and Freeze/Thaw
  masking, all ten tools with a live mesh preview — but there is no face
  detection driving the eye and mouth sliders.
- **How Adobe reads our PSDs.** A Pikado → PSD → Pikado round trip is lossless
  and byte-identical from the first save onward, and that is verified: layers,
  groups, masks, blend modes, fill opacity, layer styles (`lfx2`), live text
  (`TySh` with real EngineData, including warps), live vector shapes
  (`vmsk`/`vstk`/`vogk` — rectangles, rounded rectangles, ellipses, polygons,
  stars and lines, with their side counts, indents, weights, arrowheads and dash
  presets), adjustment layers, saved alpha channels, guides, vector paths and the
  active selection all survive. What could *not* be tested is Photoshop itself —
  no install was available here. Two specifics worth knowing: the PostScript face
  names are the documented constants of the shipping font files rather than names
  read off a real install, and the `keyOriginPoly*` origination keys for live
  polygons are not publicly documented, so a polygon may open in Photoshop as an
  editable path rather than a live shape. Neither affects geometry — the path is
  always authoritative. Six adjustment kinds (Invert, Posterize, Threshold,
  Brightness/Contrast, Levels, Curves) are written as native Photoshop
  adjustments; the other 18 open there as correctly named, correctly masked but
  inert layers, and round-trip exactly through Pikado via a private block
  Photoshop safely ignores.
- **Smart Objects** are non-destructive: `layer.smart.source` is a
  real embedded `PikaDocument`, every render restarts from it, and scaling to 10%
  and back is *pixel-exact* (measured mean absolute difference 0.0000, versus ~32
  for the equivalent destructive resample) — including when a perspective or a
  warp mesh is applied on top.

  Duplicating one gives a **linked** copy, as in Photoshop: edit either
  instance's contents and both update. The instances are found by a shared id
  rather than by sharing one document object, which is what makes it work — a
  contents edit *replaces* the source rather than mutating it (so a history
  snapshot holding the previous document really is the previous state), and a
  shared reference would therefore leave every other instance pointing at the
  contents as they used to be. Appearance stays per instance: transform,
  filters and mask are yours alone. **New Smart Object via Copy** makes an
  independent one, and **Unlink Contents** separates an instance you have
  already duplicated.

  Skew Y reads back as Skew Y, which takes a little care: an affine matrix has
  one shear degree of freedom and centre, scale and rotation spend the other
  five, so the matrix genuinely cannot record which of the two fields you typed
  into. The authored pair is remembered alongside it and checked against it
  before it is believed — so anything else moving the layer (Free Transform, an
  undo, a script) is detected and the canonical form shown instead, which at
  that point is the honest answer.

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
progressive, and every one of them degrades to a working editor rather than an
error:

| Feature | Used for | Without it |
|---|---|---|
| File System Access API | Save straight back to the opened file | Save downloads a copy |
| `ImageDecoder` | multi-frame GIF import | first frame only |
| `navigator.clipboard.write` | copying pixels to the OS clipboard | internal clipboard still works |
| IndexedDB | autosave, session restore, recent projects | autosave off, and the refresh warning comes back |
| `navigator.storage.persist` | asking not to be evicted under disk pressure | best effort; Safari and private windows say no |
| Service workers | offline start, installability | needs a network to load, then works as normal |
| WebGL2 | the ten non-native blend modes at speed | exact CPU path, slower on large documents |
| Canvas2D `filter` | GPU Gaussian blur | JS box-blur passes |

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
covers the setup, and — more usefully — the two conventions that are easy to
violate by accident here: every test must be shown to fail against the bug it
claims to catch, and the docs are not allowed to describe features that do not
exist. Both exist because this project has been bitten by their absence.

## Licence

[MIT](LICENSE). Photoshop and Photopea are trademarks of their respective
owners; Pikado is an independent implementation and is not affiliated with
either.
