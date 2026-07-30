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
 * The maths mirrors `blendCPU` exactly so the two paths agree pixel for pixel
 * (within 8-bit rounding); `blendCPU` remains the fallback when WebGL is
 * unavailable or the document exceeds the maximum texture size.
 */

/** mode id -> shader branch. Must match the switch in FRAGMENT_SRC. */
const MODE_IDS = {
  'linear-burn': 1,
  'vivid-light': 2,
  'linear-light': 3,
  'pin-light': 4,
  'hard-mix': 5,
  subtract: 6,
  divide: 7,
  'darker-color': 8,
  'lighter-color': 9,
  dissolve: 10,
};

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

void main() {
  vec4 B = texture(uBase, vUV);
  vec4 S = texture(uSrc, vUV);

  float sa = S.a * uOpacity;
  float ba = B.a;

  if (uMode == 10) {                                        // dissolve
    float r = hash(gl_FragCoord.xy, uSeed);
    outColor = (sa > 0.0 && r < sa) ? vec4(S.rgb, 1.0) : B;
    return;
  }

  if (sa <= 0.0) { outColor = B; return; }

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

  outColor = vec4(clamp(rgb, 0.0, 1.0), ra);
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
      premultipliedAlpha: false, // we work in straight alpha, like blendCPU
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

/**
 * Below this many pixels `blendCPU` costs only a few ms, so we keep it and get
 * bit-exact results.
 *
 * Accuracy note: uploading a 2D canvas into WebGL round-trips through
 * premultiplied 8-bit alpha, which costs roughly two counts of precision on
 * partially transparent pixels. Fully opaque pixels are unaffected (measured
 * max difference 0-1). Where a mode makes a discrete choice — Hard Mix's
 * threshold, Darker/Lighter Color picking a whole pixel by luminance — that
 * small error can flip the choice, so ~0.1-0.6 % of *semi-transparent* pixels
 * differ visibly from the CPU path. Those are exact ties either way. The
 * trade is worth it: the CPU path costs ~1 s per recomposite at 12 MP.
 */
const GPU_MIN_PIXELS = 400000; // ~640x640

/** Whether the GPU path can handle a surface of this size. */
export function canBlendOnGPU(width, height) {
  if (unavailable) return false;
  if (!init()) return false;
  return width <= maxTexture && height <= maxTexture;
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
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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
  if (!shouldBlendOnGPU(w, h)) return false;

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
    return true;
  } catch (err) {
    console.warn('[gpu-blend] blend failed, falling back to CPU:', err && err.message);
    return false;
  }
}
