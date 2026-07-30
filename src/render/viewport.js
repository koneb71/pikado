import { clamp, nextZoom } from '../core/util.js';

/**
 * View transform for the canvas area: pan, zoom and rotate.
 * Document space -> screen space is:  translate(offset) * rotate * scale
 */
export class Viewport {
  constructor() {
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.rotation = 0; // radians
    this.viewWidth = 0;
    this.viewHeight = 0;
  }

  setViewSize(w, h) {
    this.viewWidth = w;
    this.viewHeight = h;
  }

  matrix() {
    const m = new DOMMatrix();
    m.translateSelf(this.offsetX, this.offsetY);
    if (this.rotation) m.rotateSelf((this.rotation * 180) / Math.PI);
    m.scaleSelf(this.scale, this.scale);
    return m;
  }

  inverse() {
    return this.matrix().inverse();
  }

  toScreen(x, y) {
    const p = this.matrix().transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }

  toDoc(x, y) {
    const p = this.inverse().transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }

  /** Centre `docW x docH` in the viewport at 100% or fit, whichever asked. */
  fit(docW, docH, padding = 40, maxScale = 1) {
    const sw = Math.max(1, this.viewWidth - padding * 2);
    const sh = Math.max(1, this.viewHeight - padding * 2);
    this.rotation = 0;
    this.scale = Math.min(sw / docW, sh / docH, maxScale);
    this.center(docW, docH);
  }

  fillScreen(docW, docH) {
    this.scale = Math.max(this.viewWidth / docW, this.viewHeight / docH);
    this.center(docW, docH);
  }

  center(docW, docH) {
    this.offsetX = (this.viewWidth - docW * this.scale) / 2;
    this.offsetY = (this.viewHeight - docH * this.scale) / 2;
    if (this.rotation) {
      // Re-centre around the rotated bounding box.
      const c = this.toScreen(docW / 2, docH / 2);
      this.offsetX += this.viewWidth / 2 - c.x;
      this.offsetY += this.viewHeight / 2 - c.y;
    }
  }

  setScale(scale, anchorScreenX, anchorScreenY) {
    scale = clamp(scale, 0.002, 64);
    if (anchorScreenX == null) {
      anchorScreenX = this.viewWidth / 2;
      anchorScreenY = this.viewHeight / 2;
    }
    const before = this.toDoc(anchorScreenX, anchorScreenY);
    this.scale = scale;
    const after = this.toScreen(before.x, before.y);
    this.offsetX += anchorScreenX - after.x;
    this.offsetY += anchorScreenY - after.y;
  }

  zoomStep(dir, anchorX, anchorY) {
    this.setScale(nextZoom(this.scale, dir), anchorX, anchorY);
  }

  zoomBy(factor, anchorX, anchorY) {
    this.setScale(this.scale * factor, anchorX, anchorY);
  }

  pan(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  setRotation(rad, docW, docH) {
    const cx = this.viewWidth / 2, cy = this.viewHeight / 2;
    const anchor = this.toDoc(cx, cy);
    this.rotation = rad;
    const after = this.toScreen(anchor.x, anchor.y);
    this.offsetX += cx - after.x;
    this.offsetY += cy - after.y;
  }

  /** Document rect currently visible, for tiled repaint decisions. */
  visibleDocRect(docW, docH) {
    const pts = [
      this.toDoc(0, 0),
      this.toDoc(this.viewWidth, 0),
      this.toDoc(0, this.viewHeight),
      this.toDoc(this.viewWidth, this.viewHeight),
    ];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = clamp(Math.floor(Math.min(...xs)), 0, docW);
    const y0 = clamp(Math.floor(Math.min(...ys)), 0, docH);
    const x1 = clamp(Math.ceil(Math.max(...xs)), 0, docW);
    const y1 = clamp(Math.ceil(Math.max(...ys)), 0, docH);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  serialize() {
    return { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY, rotation: this.rotation };
  }

  restore(s) {
    if (!s) return;
    this.scale = s.scale;
    this.offsetX = s.offsetX;
    this.offsetY = s.offsetY;
    this.rotation = s.rotation || 0;
  }
}
