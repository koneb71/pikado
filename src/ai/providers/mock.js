import { registerProvider } from './index.js';
import { createCanvas, ctx2d } from '../../core/util.js';

/**
 * A provider that generates procedurally, with no key and no network.
 *
 * This is not a stub standing in for a real feature — it is how the whole UI path
 * is exercised. Setup, consent, progress, cancellation and every error code can
 * be driven end to end in the browser test suite, which has no network, and by
 * hand with `?ai=mock` on the dev server. Without it, the only way to see the
 * dialog behave would be to spend money on a real API, and the failure paths
 * would never be tested at all because they are the hard ones to provoke
 * deliberately.
 *
 * It answers with something obviously synthetic. A mock that returned plausible
 * imagery would eventually be mistaken for the real thing in a screenshot.
 */

/** Milliseconds the mock pretends to take. Tests override it to zero. */
export const MOCK_DELAY = { ms: 400 };

/** Set to a GEN_ERRORS code to make the mock fail that way. Tests use this. */
export const MOCK_FAILURE = { code: null };

function drawSynthetic(size, prompt) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  const hue = [...String(prompt || '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const grad = c.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, `hsl(${hue} 70% 55%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 35%)`);
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  // Diagonal hatching, so nobody mistakes the output for a real generation.
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = Math.max(1, size / 128);
  for (let i = -size; i < size * 2; i += Math.max(8, size / 16)) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i - size, size); c.stroke();
  }
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.font = `${Math.max(11, Math.round(size / 24))}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.fillText('mock generation', size / 2, size / 2);
  return cv;
}

registerProvider({
  id: 'mock',
  name: 'Mock (offline)',
  needsKey: false,
  endpoint: '',
  keyHint: '',
  sizes: [1024, 512, 256],
  maskPolarity: 'alpha-holes',

  async generate({ prompt, size, signal }) {
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      const t = setTimeout(resolve, MOCK_DELAY.ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }
    });
    if (MOCK_FAILURE.code) {
      const { GenerationError } = await import('../errors.js');
      throw new GenerationError(MOCK_FAILURE.code, 'mock failure', { provider: 'Mock (offline)' });
    }
    return { image: drawSynthetic(size, prompt) };
  },
});
