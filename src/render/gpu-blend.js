/**
 * GPU implementation of the blend modes Canvas2D does not provide.
 *
 * The CPU path in `blendCPU` reads the whole backdrop with `getImageData`, does
 * the blend in JS, and writes it back with `putImageData`. On a 4000x3000
 * document that is ~1 second *per recomposite* — including every brush frame —
 * so a single Vivid Light layer made the editor unusable.
 *
 * Here both surfaces are uploaded as textures and the blend runs in a fragment
 * shader, so nothing crosses back into JS. The result is copied to the target
 * with `drawImage`, which stays on the GPU.
 *
 * Two backends, tried in order:
 *   1. WebGPU, on the device every other GPU module shares (gpu-device.js),
 *      running the WGSL in gpu-blend-wgsl.js;
 *   2. WebGL2, its own context, for browsers without WebGPU (Firefox on macOS
 *      and Linux, blocklisted adapters, and the moments before the WebGPU
 *      device exists). Created only the first time WebGPU declines.
 * Both mirror `blendCPU` and round where it rounds, so the paths agree pixel
 * for pixel within 8-bit rounding; `blendCPU` remains the fallback when neither
 * is available or the document exceeds the maximum texture size.
 */

import { BLEND_MODE_IDS, BLEND_WGSL } from './gpu-blend-wgsl.js';
import { WGSL_MATH } from './wgsl-math.js';
import {
  getGPUDevice, fitsTexture, uploadCanvas, beginPresent, endPresentTo, presentFormat, pipelineCache,
} from './gpu-device.js';

/** mode id -> shader branch. Shared by the WGSL and the GLSL below. */
const MODE_IDS = BLEND_MODE_IDS;

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform sampler2D uBase;
uniform sampler2D uSrc;
uniform int uMode;
uniform float uOpacity;
uniform float uSeed;

in vec2 vUV;
out vec4 outColor;

float lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

float hash(vec2 p, float seed) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + seed) * 43758.5453123);
}

// Separable blend functions, all operating on 0..1 channel values.
float sep(int mode, float b, float s) {
  if (mode == 1) return b + s - 1.0;                       // linear burn
  if (mode == 2) {                                          // vivid light
    if (s <= 0.5) return s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s));
    return s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s)));
  }
  if (mode == 3) return b + 2.0 * s - 1.0;                  // linear light
  if (mode == 4) return s <= 0.5 ? min(b, 2.0 * s)          // pin light
                                 : max(b, 2.0 * s - 1.0);
  if (mode == 5) return (b + 2.0 * s - 1.0) >= 0.5 ? 1.0 : 0.0; // hard mix
  if (mode == 6) return b - s;                              // subtract
  if (mode == 7) return s <= 0.0 ? 1.0 : min(1.0, b / s);   // divide
  return s;
}

// Both textures hold the canvases' own premultiplied bytes. blendCPU sees
// those pixels through getImageData, which unpremultiplies and rounds each
// channel to a whole byte, so do exactly that here. Leaving it to the browser's
// WebGL upload instead rounds however that browser happens to: Safari's upload
// and Safari's getImageData disagree, and Vivid Light, which divides by the
// source, turned the disagreement into errors of over 170 counts.
vec3 unpremultiply(vec4 p) {
  float a = floor(p.a * 255.0 + 0.5);
  if (a <= 0.0) return vec3(0.0);
  vec3 c = floor(p.rgb * 255.0 + 0.5);
  return min(floor(c * 255.0 / a + 0.5), vec3(255.0)) / 255.0;
}

void main() {
  vec4 Bp = texture(uBase, vUV);
  vec4 Sp = texture(uSrc, vUV);
  vec4 B = vec4(unpremultiply(Bp), Bp.a);
  vec4 S = vec4(unpremultiply(Sp), Sp.a);

  float sa = S.a * uOpacity;
  float ba = B.a;

  // Every result leaves premultiplied, matching the drawing buffer.
  if (uMode == 10) {                                        // dissolve
    float r = hash(gl_FragCoord.xy, uSeed);
    outColor = (sa > 0.0 && r < sa) ? vec4(S.rgb, 1.0) : Bp;
    return;
  }

  if (sa <= 0.0) { outColor = Bp; return; }

  float ra = sa + ba * (1.0 - sa);
  if (ra <= 0.0) { outColor = vec4(0.0); return; }

  vec3 blended;
  if (uMode == 8 || uMode == 9) {                           // darker/lighter colour
    bool takeSrc = uMode == 8 ? lum(S.rgb) < lum(B.rgb) : lum(S.rgb) > lum(B.rgb);
    blended = takeSrc ? S.rgb : B.rgb;
  } else {
    blended = vec3(sep(uMode, B.r, S.r), sep(uMode, B.g, S.g), sep(uMode, B.b, S.b));
  }
  blended = clamp(blended, 0.0, 1.0);

  // Photoshop applies the blend only where the backdrop exists; elsewhere the
  // source shows through unblended.
  vec3 cs = S.rgb * (1.0 - ba) + blended * ba;
  vec3 rgb = (cs * sa + B.rgb * ba * (1.0 - sa)) / ra;

  // blendCPU writes whole bytes through putImageData, which premultiplies them;
  // round to bytes the same way, then premultiply for the drawing buffer.
  vec3 rgb8 = floor(clamp(rgb, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
  float ra8 = floor(ra * 255.0 + 0.5) / 255.0;
  outColor = vec4(rgb8 * ra8, ra8);
}`;

let gl = null;
let glCanvas = null;
let program = null;
let uniforms = null;
let texBase = null;
let texSrc = null;
let maxTexture = 0;
let unavailable = false;

function makeTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`shader compile failed: ${log}`);
  }
  return s;
}

function init() {
  if (gl || unavailable) return !!gl;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = 1;
    glCanvas.height = 1;
    gl = glCanvas.getContext('webgl2', {
      alpha: true,
      // Premultiplied end to end. A canvas stores premultiplied pixels; asking
      // for straight alpha made the browser unpremultiply every upload and
      // premultiply the result again, each time rounding to 8 bits. Chrome's
      // conversions cost ~0.04 counts on translucent pixels; Safari's cost ~0.5
      // on average and up to 171 on Vivid Light, where the blend divides by
      // the source. So the shader divides out alpha itself, in float.
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      desynchronized: false,
    });
    if (!gl) throw new Error('no webgl2');

    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      gl = null;
      program = null;
      unavailable = false; // allow a re-init attempt
    });

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(program);
    uniforms = {
      base: gl.getUniformLocation(program, 'uBase'),
      src: gl.getUniformLocation(program, 'uSrc'),
      mode: gl.getUniformLocation(program, 'uMode'),
      opacity: gl.getUniformLocation(program, 'uOpacity'),
      seed: gl.getUniformLocation(program, 'uSeed'),
    };
    gl.uniform1i(uniforms.base, 0);
    gl.uniform1i(uniforms.src, 1);

    texBase = makeTexture();
    texSrc = makeTexture();
    maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    return true;
  } catch (err) {
    console.warn('[gpu-blend] unavailable, falling back to CPU:', err && err.message);
    unavailable = true;
    gl = null;
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* WebGPU backend                                                      */
/* ------------------------------------------------------------------ */

const WGPU_SRC = /* wgsl */`${WGSL_MATH}${BLEND_WGSL}
struct BlendParams { mode: u32, seed: u32, opacity: f32, _pad: f32 };
@group(0) @binding(0) var baseT: texture_2d<f32>;
@group(0) @binding(1) var srcT: texture_2d<f32>;
@group(0) @binding(2) var<uniform> U: BlendParams;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  let w = textureDimensions(baseT).x;
  let rnd = pk_hash((u32(p.y) * w + u32(p.x)) ^ U.seed);
  return pk_blend(U.mode, textureLoad(baseT, p, 0), textureLoad(srcT, p, 0), U.opacity, rnd);
}
`;

let wgpuBroken = false;
let lastBackend = null;

function wgpuPipeline(d) {
  const cache = pipelineCache(d);
  let s = cache.get('blend');
  if (s) return s;
  d.pushErrorScope('validation');
  const module = d.createShaderModule({ code: WGPU_SRC });
  s = {
    pipeline: d.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: presentFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
    params: d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
  };
  d.popErrorScope().then((err) => {
    if (err) { wgpuBroken = true; console.warn('[gpu-blend] WebGPU pipeline failed:', err.message); }
  });
  cache.set('blend', s);
  return s;
}

/** The WebGPU device when it can take a `w x h` blend, else null. */
function wgpuDeviceFor(w, h) {
  if (wgpuBroken) return null;
  const d = getGPUDevice();
  return d && fitsTexture(d, w, h) ? d : null;
}

function blendOnWebGPU(d, ctx, src, id, opacity) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  try {
    const s = wgpuPipeline(d);
    // The canvases' own premultiplied bytes, unconverted: the shader rounds
    // them as getImageData would (FRAGMENT_SRC above says why that matters).
    const base = uploadCanvas(d, ctx.canvas, { slot: 'blend-base', premultiplied: true });
    const srcTex = uploadCanvas(d, src, { slot: 'blend-src', premultiplied: true });
    const params = new ArrayBuffer(16);
    new Uint32Array(params, 0, 2).set([id, (Math.random() * 0xffffffff) >>> 0]);
    new Float32Array(params, 8, 1)[0] = opacity;
    d.queue.writeBuffer(s.params, 0, params);

    d.pushErrorScope('validation');
    const view = beginPresent(d, w, h);
    const enc = d.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    rp.setPipeline(s.pipeline);
    rp.setBindGroup(0, d.createBindGroup({
      layout: s.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: base.createView() },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: s.params } },
      ],
    }));
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
    d.popErrorScope().then((err) => {
      if (err) { wgpuBroken = true; console.warn('[gpu-blend] WebGPU disabled after a validation error:', err.message); }
    });
    // Replace the backdrop wholesale — the shader already produced the
    // composited result, so compositing it again would double-apply.
    endPresentTo(ctx);
    return true;
  } catch (err) {
    console.warn('[gpu-blend] WebGPU blend failed, trying WebGL2:', err && err.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Choosing a path                                                     */
/* ------------------------------------------------------------------ */

/**
 * Below this many pixels `blendCPU` costs only a few ms, so we keep it and get
 * bit-exact results.
 *
 * Accuracy note: the shader reads the canvases' premultiplied bytes and
 * rounds them exactly as getImageData does, so on translucent pixels the two
 * paths differ only where a browser's own unpremultiply rounding strays from
 * the nearest byte — measured at ~0.04 counts on average in Chrome and Safari,
 * 2-3 at worst, and up to ~25 at a handful of pixels for Vivid Light, which
 * divides by the source. Fully opaque pixels are exact. Where a mode makes a
 * discrete choice — Hard Mix's threshold, Darker/Lighter Color picking a whole
 * pixel by luminance — a one-count difference can still flip an exact tie.
 * The trade is worth it: the CPU path costs ~1 s per recomposite at 12 MP.
 */
const GPU_MIN_PIXELS = 400000; // ~640x640

/** Whether either GPU backend can handle a surface of this size. */
export function canBlendOnGPU(width, height) {
  if (wgpuDeviceFor(width, height)) return true;
  return canBlendOnWebGL(width, height);
}

function canBlendOnWebGL(width, height) {
  if (unavailable) return false;
  if (!init()) return false;
  return width <= maxTexture && height <= maxTexture;
}

/**
 * Which backend took the last `blendOnGPU` call that returned true:
 * 'webgpu' or 'webgl2' (null before the first). For tests and diagnostics.
 */
export function blendBackend() {
  return lastBackend;
}

/** Whether the GPU path is actually worth taking for this surface. */
export function shouldBlendOnGPU(width, height) {
  return width * height >= GPU_MIN_PIXELS && canBlendOnGPU(width, height);
}

export function isGPUModeSupported(mode) {
  return Object.prototype.hasOwnProperty.call(MODE_IDS, mode);
}

function upload(tex, unit, source) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // the canvas's own bytes, unconverted
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/**
 * Blend `src` onto the canvas behind `ctx` using a non-native mode.
 *
 * @param {CanvasRenderingContext2D} ctx destination (also the backdrop)
 * @param {HTMLCanvasElement} src
 * @param {string} mode
 * @param {number} opacity 0..1
 * @returns {boolean} true when the GPU handled it; false means use `blendCPU`
 */
export function blendOnGPU(ctx, src, mode, opacity) {
  const id = MODE_IDS[mode];
  if (id === undefined) return false;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (w * h < GPU_MIN_PIXELS) return false;

  const d = wgpuDeviceFor(w, h);
  if (d && blendOnWebGPU(d, ctx, src, id, opacity)) {
    lastBackend = 'webgpu';
    return true;
  }
  if (!canBlendOnWebGL(w, h)) return false;

  try {
    if (glCanvas.width !== w || glCanvas.height !== h) {
      glCanvas.width = w;
      glCanvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);

    upload(texBase, 0, ctx.canvas);
    upload(texSrc, 1, src);

    gl.uniform1i(uniforms.mode, id);
    gl.uniform1f(uniforms.opacity, opacity);
    gl.uniform1f(uniforms.seed, Math.random() * 1000);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (gl.isContextLost && gl.isContextLost()) return false;

    // Replace the backdrop wholesale — the shader already produced the
    // composited result, so compositing it again would double-apply.
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(glCanvas, 0, 0);
    ctx.restore();
    lastBackend = 'webgl2';
    return true;
  } catch (err) {
    console.warn('[gpu-blend] blend failed, falling back to CPU:', err && err.message);
    return false;
  }
}
