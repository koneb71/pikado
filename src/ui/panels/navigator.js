import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, clamp, createCanvas } from '../../core/util.js';
import { getComposite } from '../../render/compositor.js';
import { iconEl } from '../icons.js';
import './panels.css';
import './navigator.css';

/**
 * The Navigator panel: a cheap document thumbnail with a draggable view
 * rectangle, plus zoom controls. The thumbnail bitmap is rebuilt at most ten
 * times a second and only when the document actually changed; panning only
 * repaints the (very cheap) overlay.
 */

const VIEW_H = 132;
const PAD = 6;
const MIN_SCALE = 0.01;
const MAX_SCALE = 16;
const LN_MIN = Math.log(MIN_SCALE);
const LN_MAX = Math.log(MAX_SCALE);

const sliderToScale = (v) => Math.exp(LN_MIN + (v / 1000) * (LN_MAX - LN_MIN));
const scaleToSlider = (s) => clamp(((Math.log(clamp(s, MIN_SCALE, MAX_SCALE)) - LN_MIN) / (LN_MAX - LN_MIN)) * 1000, 0, 1000);

registerPanel({
  id: 'navigator',
  title: 'Navigator',
  icon: 'navigator',
  group: 'bottom',
  order: 2,
  defaultOpen: true,
  build(body) {
    body.classList.add('pkn-body');

    const view = el('canvas.pkn-view');
    const image = createCanvas(1, 1);
    let fit = null;          // {scale, ox, oy} document -> thumbnail
    let imageDirty = true;
    let lastBuild = 0;
    let buildTimer = null;

    /* ---- geometry ------------------------------------------------ */

    const sizeCanvas = () => {
      const w = Math.max(40, Math.round(view.clientWidth || body.clientWidth || 240));
      if (view.width !== w || view.height !== VIEW_H) {
        view.width = w;
        view.height = VIEW_H;
        imageDirty = true;
      }
    };

    const computeFit = (doc) => {
      const w = view.width - PAD * 2;
      const h = view.height - PAD * 2;
      const scale = Math.min(w / doc.width, h / doc.height);
      return {
        scale,
        ox: PAD + (w - doc.width * scale) / 2,
        oy: PAD + (h - doc.height * scale) / 2,
      };
    };

    const buildImage = () => {
      const doc = app.activeDoc;
      if (!doc) return;
      sizeCanvas();
      fit = computeFit(doc);
      const w = Math.max(1, Math.round(doc.width * fit.scale));
      const h = Math.max(1, Math.round(doc.height * fit.scale));
      if (image.width !== w || image.height !== h) {
        image.width = w;
        image.height = h;
      }
      const c = image.getContext('2d');
      c.clearRect(0, 0, w, h);
      c.imageSmoothingQuality = 'medium';
      c.drawImage(getComposite(doc), 0, 0, w, h);
      imageDirty = false;
      lastBuild = performance.now();
    };

    /** Rebuild if stale, but never faster than ~10fps. */
    const ensureImage = () => {
      if (!imageDirty || !app.activeDoc) return;
      const now = performance.now();
      const wait = 100 - (now - lastBuild);
      if (wait <= 0) {
        buildImage();
        return;
      }
      if (!buildTimer) {
        buildTimer = setTimeout(() => {
          buildTimer = null;
          if (!body.isConnected) return;
          buildImage();
          paint();
        }, wait);
      }
    };

    const paint = () => {
      sizeCanvas();
      const ctx = view.getContext('2d');
      const doc = app.activeDoc;
      ctx.clearRect(0, 0, view.width, view.height);
      if (!doc) {
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No document', view.width / 2, view.height / 2);
        return;
      }
      if (!fit) fit = computeFit(doc);

      ctx.save();
      ctx.fillStyle = '#111';
      ctx.fillRect(fit.ox, fit.oy, doc.width * fit.scale, doc.height * fit.scale);
      ctx.drawImage(image, fit.ox, fit.oy, doc.width * fit.scale, doc.height * fit.scale);
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fit.ox + 0.5, fit.oy + 0.5, doc.width * fit.scale - 1, doc.height * fit.scale - 1);
      ctx.restore();

      // View rectangle: the screen viewport's corners projected into doc space.
      const vp = app.viewport;
      if (vp.viewWidth > 0 && vp.viewHeight > 0) {
        const corners = [
          vp.toDoc(0, 0), vp.toDoc(vp.viewWidth, 0),
          vp.toDoc(vp.viewWidth, vp.viewHeight), vp.toDoc(0, vp.viewHeight),
        ].map((p) => ({ x: fit.ox + p.x * fit.scale, y: fit.oy + p.y * fit.scale }));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.strokeStyle = '#ff2f2f';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    };

    /* ---- panning -------------------------------------------------- */

    const centerOn = (clientX, clientY) => {
      const doc = app.activeDoc;
      if (!doc || !fit) return;
      const r = view.getBoundingClientRect();
      const sx = (clientX - r.left) * (view.width / Math.max(1, r.width));
      const sy = (clientY - r.top) * (view.height / Math.max(1, r.height));
      const dx = (sx - fit.ox) / fit.scale;
      const dy = (sy - fit.oy) / fit.scale;
      const vp = app.viewport;
      const cur = vp.toScreen(dx, dy);
      vp.offsetX += vp.viewWidth / 2 - cur.x;
      vp.offsetY += vp.viewHeight / 2 - cur.y;
      app.emit('view-change');
      app.requestRender();
      paint();
    };

    view.addEventListener('pointerdown', (e) => {
      if (!app.activeDoc) return;
      view.setPointerCapture?.(e.pointerId);
      centerOn(e.clientX, e.clientY);
      const move = (ev) => centerOn(ev.clientX, ev.clientY);
      const up = () => {
        view.removeEventListener('pointermove', move);
        view.removeEventListener('pointerup', up);
        view.removeEventListener('pointercancel', up);
      };
      view.addEventListener('pointermove', move);
      view.addEventListener('pointerup', up);
      view.addEventListener('pointercancel', up);
      e.preventDefault();
    });

    /* ---- zoom controls -------------------------------------------- */

    const applyScale = (s) => {
      if (!app.activeDoc) return;
      app.viewport.setScale(clamp(s, 0.002, 64));
      app.emit('view-change');
      app.requestRender();
      syncZoom();
      paint();
    };

    const slider = el('input.pk-range.pkn-range', { type: 'range', min: 0, max: 1000, step: 1, value: 500 });
    slider.addEventListener('input', () => applyScale(sliderToScale(Number(slider.value))));

    const pct = el('input.pk-input.pkn-pct', { type: 'number', min: 0.2, max: 6400, step: 1, value: 100 });
    const commitPct = () => {
      const v = Number(pct.value);
      if (Number.isFinite(v) && v > 0) applyScale(v / 100);
    };
    pct.addEventListener('change', commitPct);
    pct.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitPct(); });

    const zoomOut = el('button.pk-icon-btn', {
      type: 'button', title: 'Zoom out',
      onclick: () => { if (app.activeDoc) { app.viewport.zoomStep(-1); app.emit('view-change'); app.requestRender(); syncZoom(); paint(); } },
    }, iconEl('minus'));
    const zoomIn = el('button.pk-icon-btn', {
      type: 'button', title: 'Zoom in',
      onclick: () => { if (app.activeDoc) { app.viewport.zoomStep(1); app.emit('view-change'); app.requestRender(); syncZoom(); paint(); } },
    }, iconEl('plus'));
    const fitBtn = el('button.pk-icon-btn', {
      type: 'button', title: 'Fit on screen',
      onclick: () => { if (app.activeDoc) { app.fitView(); syncZoom(); paint(); } },
    }, iconEl('navigator'));

    const syncZoom = () => {
      const s = app.viewport.scale;
      if (document.activeElement !== pct) pct.value = String(Math.round(s * 10000) / 100);
      if (document.activeElement !== slider) slider.value = String(Math.round(scaleToSlider(s)));
      const on = !!app.activeDoc;
      for (const c of [slider, pct, zoomOut, zoomIn, fitBtn]) c.disabled = !on;
    };

    body.append(
      view,
      el('div.pkn-controls', {},
        el('div.pkn-pctwrap', {}, pct, el('span.pk-unit', { text: '%' })),
        zoomOut, slider, zoomIn, fitBtn
      )
    );

    /* ---- wiring --------------------------------------------------- */

    const markDirty = () => {
      imageDirty = true;
      if (body.isConnected && body.offsetParent !== null) {
        ensureImage();
        paint();
      }
    };

    app.on('doc-change', markDirty);
    app.on('doc-structure', markDirty);
    app.on('doc-resize', () => { fit = null; markDirty(); });
    app.on('active-doc', () => { fit = null; markDirty(); syncZoom(); });
    app.on('view-change', () => {
      if (body.isConnected && body.offsetParent !== null) {
        syncZoom();
        paint();
      }
    });

    const ro = new ResizeObserver(() => {
      sizeCanvas();
      fit = null;
      imageDirty = true;
      ensureImage();
      paint();
    });
    ro.observe(body);

    sizeCanvas();
    if (app.activeDoc) buildImage();
    syncZoom();
    paint();

    return {
      refresh() {
        sizeCanvas();
        imageDirty = true;
        ensureImage();
        syncZoom();
        paint();
      },
    };
  },
});
