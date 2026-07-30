/**
 * Tool base class + registry.
 *
 * A tool receives *normalised* pointer events:
 *   {
 *     x, y,             // document-space coordinates (floats, may be off-canvas)
 *     sx, sy,           // screen-space coordinates within the canvas element
 *     dx, dy,           // document-space delta since the previous event
 *     pressure,         // 0..1 (1 for mouse)
 *     button, buttons,
 *     shiftKey, altKey, ctrlKey, metaKey,
 *     native,           // the original PointerEvent
 *   }
 *
 * Tools draw their own on-canvas UI in `drawOverlay(ctx, view)` where `ctx` is
 * in *screen* space (already translated for the canvas element) and `view` is
 * the Viewport.
 */

/** @type {Map<string, Tool>} */
export const tools = new Map();
/** Tool groups shown as fly-outs in the toolbar, in order. */
export const toolGroups = [];

export function registerTool(tool) {
  if (!tool || !tool.id) throw new Error('Tool needs an id');
  tools.set(tool.id, tool);
  let g = toolGroups.find((x) => x.id === (tool.group || tool.id));
  if (!g) {
    g = { id: tool.group || tool.id, order: tool.groupOrder == null ? 999 : tool.groupOrder, tools: [] };
    toolGroups.push(g);
  }
  if (tool.groupOrder != null && tool.groupOrder < g.order) g.order = tool.groupOrder;
  g.tools.push(tool);
  toolGroups.sort((a, b) => a.order - b.order);
  return tool;
}

export function getTool(id) {
  return tools.get(id) || null;
}

export class Tool {
  constructor(opts = {}) {
    this.id = opts.id;
    this.name = opts.name || opts.id;
    this.icon = opts.icon || '';
    this.cursor = opts.cursor || 'default';
    this.shortcut = opts.shortcut || '';
    this.group = opts.group || opts.id;
    this.groupOrder = opts.groupOrder;
    /** Option descriptors rendered into the options bar. Same shape as filter params. */
    this.options = opts.options || [];
    /** Live option values. */
    this.state = {};
    for (const o of this.options) if (o.key !== undefined) this.state[o.key] = o.default;
    this.app = null;
    this.dragging = false;
  }

  /** Called once when the app boots, with the app singleton. */
  init(app) {
    this.app = app;
  }

  get doc() {
    return this.app ? this.app.activeDoc : null;
  }

  /** Cursor to display, may depend on state. */
  getCursor(e) {
    return this.cursor;
  }

  onActivate() {}
  onDeactivate() {}

  onPointerDown(e) {}
  onPointerMove(e) {}
  onPointerUp(e) {}
  onDoubleClick(e) {}
  onWheel(e) { return false; } // return true to consume

  onKeyDown(e) { return false; }
  onKeyUp(e) { return false; }

  /** Commit any in-progress interaction (Enter, tool switch, etc.). */
  commit() {}
  /** Abandon any in-progress interaction (Escape). */
  cancel() {}

  /** Screen-space overlay drawing. */
  drawOverlay(ctx, view) {}

  /** Called when an options-bar control changes. */
  onOptionChange(key, value) {}

  setOption(key, value) {
    this.state[key] = value;
    this.onOptionChange(key, value);
    if (this.app) this.app.emit('tool-options', this);
  }

  /** Convenience: the layer tools should paint into, with lock checks. */
  targetLayer() {
    const doc = this.doc;
    if (!doc) return null;
    const l = doc.activeLayer();
    if (!l) return null;
    return l;
  }

  /** True when the active layer is editable as pixels. */
  canPaint(warn = true) {
    const doc = this.doc;
    const l = doc && doc.activeLayer();
    if (!l) {
      if (warn && this.app) this.app.toast('No layer selected.');
      return false;
    }
    if (l.locked.all || l.locked.pixels) {
      if (warn && this.app) this.app.toast(`Layer "${l.name}" is locked.`);
      return false;
    }
    if (l.editingMask && l.mask) return true;
    if (l.type === 'group') {
      if (warn && this.app) this.app.toast('Cannot paint on a group. Select a layer inside it.');
      return false;
    }
    if (l.type === 'adjustment' && !l.mask) {
      if (warn && this.app) this.app.toast('Adjustment layers can only be painted on their mask.');
      return false;
    }
    if (l.type === 'text' && !l.editingMask) {
      if (warn && this.app) this.app.toast('Rasterize the text layer before painting on it.');
      return false;
    }
    return true;
  }
}
