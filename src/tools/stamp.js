import { registerTool } from './base.js';
import { app } from '../core/app.js';
import { PaintStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { cloneCanvas, clamp } from '../core/util.js';
import { getComposite } from '../render/compositor.js';
import { BrushToolBase, tweakDefaults, brushContextMenu } from './brush.js';
import { makeTiledCanvas, patternOptions } from '../paint/patterns.js';

/**
 * Clone Stamp and Pattern Stamp.
 *
 * Both drive a PaintStroke with a `sourceImage`; the difference is only where
 * the source pixels come from and how the dab centre maps into them.
 */

/* ================================================================== */
/* Clone Stamp                                                         */
/* ================================================================== */

class CloneStampTool extends BrushToolBase {
  constructor() {
    super({
      id: 'clone-stamp', name: 'Clone Stamp Tool', icon: 'stamp',
      cursor: 'crosshair', shortcut: 'S', group: 'stamp', groupOrder: 8,
      strokeLabel: 'Clone Stamp',
      options: [
        ...tweakDefaults(brushOptionDescriptors(), { size: 40, hardness: 100 }),
        { key: 'aligned', label: 'Aligned', type: 'checkbox', default: true },
        { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox', default: false },
      ],
    });
    /** @type {{x:number,y:number}|null} */
    this.source = null;
    /** Offset from the painted point to the sampled point. */
    this.offset = null;
    this.livePoint = null;
  }

  onPointerDown(e) {
    if (e.button === 0 && e.altKey) {
      this.source = { x: e.x, y: e.y };
      this.offset = null;
      app.toast('Clone source set.', 'ok', 1200);
      app.requestRender();
      return;
    }
    super.onPointerDown(e);
  }

  beforeStroke(e) {
    if (!this.source) {
      app.toast('Alt-click to define a clone source first.', 'warn');
      return false;
    }
    return true;
  }

  makeStroke(e, doc, layer) {
    if (!this.state.aligned || !this.offset) {
      this.offset = {
        dx: Math.round(this.source.x - e.x),
        dy: Math.round(this.source.y - e.y),
      };
    }
    const { dx, dy } = this.offset;
    const source = this.state.sampleAllLayers && !layer.editingMask
      ? cloneCanvas(getComposite(doc))
      : cloneCanvas(layer.paintTarget());

    return new PaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state),
      mode: 'paint',
      sourceImage: source,
      sourceMap: (x, y) => ({ x: x + dx, y: y + dy }),
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }

  onPointerMove(e) {
    if (this.stroke && this.offset) {
      this.livePoint = { x: e.x + this.offset.dx, y: e.y + this.offset.dy };
    }
    super.onPointerMove(e);
  }

  onPointerUp() {
    this.livePoint = null;
    super.onPointerUp();
  }

  cancel() {
    this.livePoint = null;
    super.cancel();
  }

  contextMenu() {
    return brushContextMenu(this, [{
      label: 'Reset Clone Source',
      disabled: !this.source,
      run: () => {
        this.source = null;
        this.offset = null;
        this.livePoint = null;
        app.toast('Clone source cleared.', 'info', 1200);
        app.requestRender();
      },
    }]);
  }

  drawOverlay(ctx, view) {
    if (this.livePoint) this.drawCrosshair(ctx, view, this.livePoint.x, this.livePoint.y, '#ffd166');
    else if (this.source) this.drawCrosshair(ctx, view, this.source.x, this.source.y);
    this.drawBrushCursor(ctx, view);
  }
}

registerTool(new CloneStampTool());

/* ================================================================== */
/* Pattern Stamp                                                       */
/* ================================================================== */

let tileMemo = null;

function tiledSource(patternId, w, h, scale, ox, oy) {
  if (
    tileMemo && tileMemo.id === patternId && tileMemo.w === w && tileMemo.h === h &&
    tileMemo.scale === scale && tileMemo.ox === ox && tileMemo.oy === oy
  ) {
    return tileMemo.canvas;
  }
  const canvas = makeTiledCanvas(patternId, w, h, scale, ox, oy);
  tileMemo = { id: patternId, w, h, scale, ox, oy, canvas };
  return canvas;
}

class PatternStampTool extends BrushToolBase {
  constructor() {
    super({
      id: 'pattern-stamp', name: 'Pattern Stamp Tool', icon: 'pattern-stamp',
      cursor: 'crosshair', shortcut: 'S', group: 'stamp', groupOrder: 8,
      strokeLabel: 'Pattern Stamp',
      options: [
        ...tweakDefaults(brushOptionDescriptors(), { size: 60, hardness: 100 }),
        { key: 'pattern', label: 'Pattern', type: 'select', options: patternOptions(), default: 'checkerboard' },
        { key: 'scale', label: 'Scale', type: 'slider', min: 10, max: 400, step: 1, default: 100, unit: '%' },
        { key: 'aligned', label: 'Aligned', type: 'checkbox', default: true },
        { key: 'impressionist', label: 'Impressionist', type: 'checkbox', default: false },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    const scale = this.state.scale / 100;
    // Aligned locks the tiling to the document origin; unaligned starts a fresh
    // tile phase at the point the stroke began.
    const ox = this.state.aligned ? 0 : Math.round(e.x);
    const oy = this.state.aligned ? 0 : Math.round(e.y);
    const source = tiledSource(this.state.pattern, doc.width, doc.height, scale, ox, oy);

    let map = (x, y) => ({ x, y });
    if (this.state.impressionist) {
      // A slow random walk of the sample point smears the pattern into
      // painterly dabs instead of a crisp tiling.
      const reach = Math.max(4, this.state.size * 0.75);
      let wx = 0, wy = 0;
      map = (x, y) => {
        wx = clamp(wx + (Math.random() - 0.5) * reach * 0.7, -reach, reach);
        wy = clamp(wy + (Math.random() - 0.5) * reach * 0.7, -reach, reach);
        return { x: x + wx, y: y + wy };
      };
    }

    return new PaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state),
      mode: 'paint',
      sourceImage: source,
      sourceMap: map,
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }
}

registerTool(new PatternStampTool());
