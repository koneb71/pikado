/**
 * The shared WebGPU device.
 *
 * WebGPU hands out its device asynchronously, but every renderer in Pikado is
 * synchronous — the compositor runs inside a brush frame and must return a
 * canvas. So the request starts the moment this module is imported and
 * `getGPUDevice()` answers synchronously: the device once it exists, `null`
 * until then (or forever, where WebGPU is missing). A caller that gets `null`
 * takes its existing path, exactly as `blendOnGPU` callers fall back to
 * `blendCPU`. The first composites after boot may therefore run on the CPU;
 * that is the trade for never blocking a frame on a promise.
 *
 * Results come back through a `webgpu` canvas drawn into a 2D canvas *in the
 * same task* (`beginPresent` / `endPresent`). Nothing here maps a buffer, so nothing here
 * ever waits.
 */

let device = null;
let pending = null;
let enabled = true;
let generation = 0;
const lostListeners = new Set();

/**
 * Below this many pixels the CPU paths are a few milliseconds and bit-exact, so
 * the WebGPU paths decline. Matches fast-blur's own crossover (~300x300).
 */
export const GPU_MIN_PIXELS = 90000;

/**
 * `?webgpu=off` in the page URL behaves exactly like a browser without WebGPU —
 * the app, or the whole test suite at /tests/?webgpu=off, runs the fallbacks.
 */
let unavailable = (() => {
  try {
    return new URLSearchParams(location.search).get('webgpu') === 'off';
  } catch {
    return false;
  }
})();

/** Ask for the larger limits the adapter offers: an effect field for a 12 MP region is ~48 MB. */
function wantedLimits(adapter) {
  const l = adapter.limits;
  return {
    maxBufferSize: l.maxBufferSize,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxTextureDimension2D: l.maxTextureDimension2D,
  };
}

function request() {
  if (pending) return pending;
  if (unavailable) return Promise.resolve(null);
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    unavailable = true;
    return Promise.resolve(null);
  }
  pending = (async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no adapter');
      const d = await adapter.requestDevice({ requiredLimits: wantedLimits(adapter) });
      d.lost.then((info) => {
        if (device !== d) return;
        device = null;
        pending = null;
        for (const cb of lostListeners) {
          try { cb(info); } catch (err) { console.warn('[gpu] device-lost listener failed:', err); }
        }
        // A deliberate destroy() stays down; anything else (driver reset, GPU
        // switch, the tab sleeping) gets one fresh attempt.
        if (info && info.reason !== 'destroyed') request();
      });
      d.addEventListener?.('uncapturederror', (e) => {
        console.warn('[gpu] uncaptured error:', e.error && e.error.message);
      });
      device = d;
      generation++;
      return d;
    } catch (err) {
      console.warn('[gpu] WebGPU unavailable, using the existing paths:', err && err.message);
      unavailable = true;
      pending = null;
      return null;
    }
  })();
  return pending;
}

request();

/** The device, or null while it is being created, after it was lost, or where WebGPU is missing. */
export function getGPUDevice() {
  return enabled ? device : null;
}

/**
 * Resolves with the device (or null) once the request settles. Tests await this
 * so they exercise the GPU path rather than racing the boot.
 */
export function gpuReady() {
  return request();
}

/**
 * Turn the WebGPU paths off (or back on). Every caller then takes its existing
 * path. For tests that compare the two, and for ruling WebGPU out when
 * something looks wrong.
 */
export function setGPUEnabled(on) {
  enabled = !!on;
}

export function isGPUEnabled() {
  return enabled;
}

/**
 * Increments every time a new device is created. Anything cached against a
 * device (pipelines, buffers) keys on it so a lost device's objects are never reused.
 */
export function gpuGeneration() {
  return generation;
}

/**
 * Call `cb(info)` whenever the device is lost, before a replacement is
 * requested. Returns a function that removes the listener. Whatever a module
 * keeps on the GPU between calls (textures, pools) should be dropped here; the
 * next device has a new `gpuGeneration()`, so nothing stale is reused anyway.
 */
export function onDeviceLost(cb) {
  lostListeners.add(cb);
  return () => lostListeners.delete(cb);
}

/**
 * A Map for pipelines (or anything else built against one device), emptied
 * whenever the device or its generation changes. Callers key it by name:
 * `const c = pipelineCache(d); let p = c.get('blur'); if (!p) c.set('blur', p = ...)`.
 */
const pipelineCaches = new WeakMap(); // device -> { gen, map }
export function pipelineCache(d) {
  let entry = pipelineCaches.get(d);
  if (!entry || entry.gen !== generation) {
    entry = { gen: generation, map: new Map() };
    pipelineCaches.set(d, entry);
  }
  return entry.map;
}

/** Whether a `w x h` texture fits this device. */
export function fitsTexture(d, w, h) {
  const max = d.limits.maxTextureDimension2D;
  return w >= 1 && h >= 1 && w <= max && h <= max;
}

/** Whether a storage buffer of `bytes` fits this device. */
export function fitsStorage(d, bytes) {
  return bytes <= d.limits.maxStorageBufferBindingSize && bytes <= d.limits.maxBufferSize;
}

/* ------------------------------------------------------------------ */
/* Upload and present                                                  */
/* ------------------------------------------------------------------ */

const sourceTextures = new WeakMap(); // device -> Map(slot -> GPUTexture)

/**
 * Copy a canvas into a reusable `rgba8unorm` texture. Each `slot` names one
 * texture that is reused (and resized) from call to call, so the caller must
 * finish using it before uploading into the same slot again.
 *
 * `premultiplied: false` (the default) gives straight alpha — right for code
 * that only reads alpha, or wants colour as `getImageData` would see it.
 * `premultiplied: true` copies the canvas's own premultiplied bytes without a
 * conversion, so nothing is rounded on the way in; anything that composites
 * canvases (the blend shader) wants this, for the reason gpu-blend.js gives.
 */
export function uploadCanvas(d, canvas, { slot = 'src', premultiplied = false } = {}) {
  const w = canvas.width, h = canvas.height;
  let slots = sourceTextures.get(d);
  if (!slots) sourceTextures.set(d, (slots = new Map()));
  let tex = slots.get(slot);
  if (!tex || tex.width !== w || tex.height !== h) {
    if (tex) tex.destroy();
    tex = d.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    slots.set(slot, tex);
  }
  d.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture: tex, premultipliedAlpha: premultiplied },
    [w, h],
  );
  return tex;
}

let presentCanvas = null;
let presentContext = null;

/** The preferred swap-chain format, which render pipelines targeting `beginPresent` must use. */
export function presentFormat() {
  return navigator.gpu.getPreferredCanvasFormat();
}

/**
 * Start drawing a `w x h` result. Returns the texture view to render into.
 * Pair with `endPresent()` in the same task, after `queue.submit`.
 *
 * Every result gets a canvas of its own. A canvas's current texture lives until
 * the browser next updates the rendering, and Safari serves `drawImage` from
 * the copy it took the first time that texture was read — so with one shared
 * canvas, the second effect rendered in a composite came back as a copy of the
 * first. Chrome re-reads; Safari does not. A fresh canvas is never stale.
 */
export function beginPresent(d, w, h) {
  presentCanvas = document.createElement('canvas');
  presentCanvas.width = w;
  presentCanvas.height = h;
  presentContext = presentCanvas.getContext('webgpu');
  if (!presentContext) throw new Error('no webgpu canvas context');
  presentContext.configure({
    device: d,
    format: presentFormat(),
    alphaMode: 'premultiplied',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return presentContext.getCurrentTexture().createView();
}

/**
 * Copy what was just rendered into an ordinary 2D canvas, then release the
 * webgpu canvas — `unconfigure` frees its texture now rather than whenever the
 * element is collected, which matters at 48 MB a 12 MP result, 60 times a
 * second. Must run in the same task as `beginPresent`. The copy keeps every
 * downstream caller — `getImageData`, the CPU blend path, `drawImage` at an
 * offset — working on a canvas it already understands.
 *
 * `x`/`y` place the result inside `out`; `clear: false` keeps what `out`
 * already holds outside that rectangle.
 */
export function endPresent(out, { x = 0, y = 0, clear = true } = {}) {
  const ctx = out.getContext('2d');
  if (clear) ctx.clearRect(0, 0, out.width, out.height);
  else ctx.clearRect(x, y, presentCanvas.width, presentCanvas.height);
  ctx.drawImage(presentCanvas, x, y);
  release();
  return out;
}

/**
 * Replace everything `ctx` draws to with what was just rendered — the result
 * must be the size of `ctx.canvas`. Transform, alpha, compositing and clip of
 * `ctx` are left as they were.
 */
export function endPresentTo(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(presentCanvas, 0, 0);
  ctx.restore();
  release();
}

function release() {
  presentContext.unconfigure();
  presentCanvas = null;
  presentContext = null;
}
