import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, createCanvas, ctx2d } from '../../core/util.js';
import { iconEl } from '../icons.js';
import { compositeDocument } from '../../render/compositor.js';
import {
  DELAY_PRESETS, framesOf, activeFrame, frameIndex, ensureTimeline, applyFrame,
  addFrame, removeFrame, moveFrame, setFrameDelay, updateFrame, framesFromLayers,
  tweenFrames, reverseFrames, clearTimeline,
} from '../../core/animation.js';
import './panels.css';
import './timeline.css';

/**
 * The Timeline panel — frame animation.
 *
 * Each frame is a thumbnail with its delay underneath. Selecting one applies its
 * record to the layers, so the canvas shows that frame and the Layers panel shows
 * the visibility and opacity it stored. Editing anything after that writes back
 * into the selected frame, which is what makes the panel feel like Photoshop's:
 * you select a frame, then work normally.
 *
 * **Writing back.** The panel listens for `doc-change` and `doc-structure` and
 * calls `updateFrame`, so toggling a layer's eye updates the frame you are on
 * rather than silently diverging from it. The one thing it must not do is write
 * back while it is itself applying a frame — that would copy the frame onto
 * itself and, worse, copy the *previous* frame's state onto the new one. The
 * `applying` flag is that guard.
 *
 * **Playback.** `MessageChannel` rather than `setTimeout`, because a backgrounded
 * tab throttles timers to roughly one a minute — the same trap that once made the
 * test harness appear to hang. Playback in a hidden tab is pointless anyway, so
 * it stops when the tab is hidden and does not silently drift.
 */

const THUMB_W = 54;
const THUMB_H = 40;

/**
 * A small composite of the document as the given frame shows it.
 *
 * This deliberately does *not* go through `applyFrame`. `applyFrame` ends with
 * `doc.invalidate()`, which emits `change`, which the app re-emits as
 * `doc-change`, which this panel listens to — so drawing a thumbnail queued
 * another full render, which drew five more thumbnails, and the main thread
 * disappeared into a render storm that made playback crawl. Setting the layer
 * properties directly and putting them back keeps the whole thing silent.
 */
function frameThumb(doc, frame) {
  const cv = createCanvas(THUMB_W, THUMB_H);
  const c = ctx2d(cv);
  c.fillStyle = 'rgba(0,0,0,.25)';
  c.fillRect(0, 0, THUMB_W, THUMB_H);
  const before = doc.flatLayers().map((l) => ({ l, visible: l.visible, opacity: l.opacity }));
  try {
    for (const layer of doc.flatLayers()) {
      const s = frame.state && frame.state[layer.id];
      if (!s) continue;
      layer.visible = s.visible !== false;
      layer.opacity = s.opacity == null ? 1 : s.opacity;
    }
    // A fresh composite, not `getComposite`: the cached one belongs to the frame
    // actually being shown and must not be replaced by a thumbnail's.
    const full = compositeDocument(doc);
    const s = Math.min(THUMB_W / doc.width, THUMB_H / doc.height);
    const w = Math.max(1, doc.width * s), h = Math.max(1, doc.height * s);
    c.imageSmoothingQuality = 'high';
    c.drawImage(full, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  } finally {
    for (const { l, visible, opacity } of before) { l.visible = visible; l.opacity = opacity; }
  }
  return cv;
}

const fmtDelay = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${ms} ms`);

registerPanel({
  id: 'timeline',
  title: 'Timeline',
  icon: 'timeline',
  group: 'bottom',
  order: 40,
  defaultOpen: false,
  // A frame cell is a number, a 40px thumbnail and a delay dropdown; below this
  // the dropdown is clipped.
  minHeight: 156,
  build(body) {
    body.classList.add('pktl-body');

    const strip = el('div.pktl-strip.pk-scroll');
    const bar = el('div.pktl-bar');
    const empty = el('div.pk-empty', { text: 'No animation. Create the first frame to start a timeline.' });
    body.append(strip, bar);

    /** True while the panel is applying a frame, so write-back stays off. */
    let applying = false;
    let playing = false;
    let playTimer = null;
    /** Multi-select, for setting a delay on several frames at once. */
    let selected = new Set();

    const doc = () => app.activeDoc;

    /* --- playback ----------------------------------------------------- */

    // A MessageChannel tick is not throttled the way setTimeout is in a
    // background tab, so the schedule stays honest while the tab is visible.
    const channel = new MessageChannel();
    let pending = null;
    channel.port1.onmessage = () => {
      const fn = pending;
      pending = null;
      if (fn) fn();
    };
    const soon = (fn) => { pending = fn; channel.port2.postMessage(0); };

    function stop() {
      playing = false;
      if (playTimer) { clearTimeout(playTimer); playTimer = null; }
      renderBar();
    }

    function step(by = 1) {
      const d = doc();
      if (!d) return;
      const frames = framesOf(d);
      if (!frames.length) return;
      const next = frames[(frameIndex(d) + by + frames.length) % frames.length];
      select(next);
    }

    function play() {
      const d = doc();
      if (!d || framesOf(d).length < 2) return;
      playing = true;
      renderBar();
      let plays = 0;
      const tick = () => {
        if (!playing || doc() !== d) return stop();
        const frames = framesOf(d);
        const i = frameIndex(d);
        const wrapped = i + 1 >= frames.length;
        if (wrapped) {
          plays++;
          const limit = d.loopCount || 0;
          if (limit && plays >= limit) return stop();
        }
        step(1);
        const delay = Math.max(20, frames[frameIndex(d)].delay || 100);
        playTimer = setTimeout(() => soon(tick), delay);
      };
      const first = Math.max(20, framesOf(d)[frameIndex(d)].delay || 100);
      playTimer = setTimeout(() => soon(tick), first);
    }

    // Playback in a hidden tab would be throttled into nonsense, so stop.
    document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });

    /* --- selection ---------------------------------------------------- */

    function select(frame, { additive = false } = {}) {
      const d = doc();
      if (!d || !frame) return;
      if (additive) {
        if (selected.has(frame.id)) selected.delete(frame.id);
        else selected.add(frame.id);
      } else {
        selected = new Set([frame.id]);
      }
      applying = true;
      try {
        applyFrame(d, frame);
      } finally {
        applying = false;
      }
      d.emit('structure');
      schedule();
    }

    /** Frames the user has selected, in timeline order. */
    function selection() {
      const d = doc();
      if (!d) return [];
      const frames = framesOf(d);
      const picked = frames.filter((f) => selected.has(f.id));
      return picked.length ? picked : [activeFrame(d)].filter(Boolean);
    }

    /* --- commands ----------------------------------------------------- */

    function withCommit(label, fn) {
      const d = doc();
      if (!d) return;
      stop();
      applying = true;
      try {
        fn(d);
      } finally {
        applying = false;
      }
      d.commit(label);
      d.emit('structure');
      schedule();
    }

    const actions = {
      create: () => withCommit('Create Timeline', (d) => { ensureTimeline(d); selected = new Set([d.activeFrameId]); }),
      add: () => withCommit('New Frame', (d) => { const f = addFrame(d); selected = new Set([f.id]); }),
      duplicate: () => withCommit('Duplicate Frame', (d) => { const f = addFrame(d, { copyState: true }); selected = new Set([f.id]); }),
      remove: () => withCommit('Delete Frame', (d) => {
        for (const f of selection()) removeFrame(d, f);
        selected = new Set([d.activeFrameId]);
      }),
      fromLayers: () => withCommit('Make Frames From Layers', (d) => {
        framesFromLayers(d);
        selected = new Set([d.activeFrameId]);
      }),
      reverse: () => withCommit('Reverse Frames', (d) => reverseFrames(d)),
      tween: () => {
        const d = doc();
        if (!d) return;
        const frames = framesOf(d);
        const i = frameIndex(d);
        if (i + 1 >= frames.length) {
          app.toast('Tween needs a frame after this one.', 'info');
          return;
        }
        withCommit('Tween', (dd) => tweenFrames(dd, frames[i], frames[i + 1], 3));
      },
      clear: () => withCommit('Delete Timeline', (d) => clearTimeline(d)),
    };

    /* --- rendering ---------------------------------------------------- */

    function renderBar() {
      const d = doc();
      const frames = d ? framesOf(d) : [];
      const has = frames.length > 0;
      const many = frames.length > 1;

      const iconBtn = (icon, title, onclick, opts = {}) =>
        el('button.pk-icon-btn' + (opts.on ? '.on' : ''), {
          title, onclick, disabled: opts.disabled || false,
        }, iconEl(icon, { size: 14 }));

      const loop = el('select.pk-select.pktl-loop', {
        title: 'How many times to play',
        onchange: (e) => {
          if (!d) return;
          d.loopCount = Number(e.target.value) || 0;
          d.commit('Loop Count');
        },
      });
      for (const [value, label] of [[0, 'Forever'], [1, 'Once'], [2, '2 times'], [3, '3 times'], [5, '5 times'], [10, '10 times']]) {
        loop.appendChild(el('option', { value, text: label }));
      }
      if (d) loop.value = String(d.loopCount || 0);

      bar.replaceChildren(
        iconBtn('play', playing ? 'Stop' : 'Play', () => (playing ? stop() : play()), { on: playing, disabled: !many }),
        iconBtn('chevron-left', 'Previous frame', () => { stop(); step(-1); }, { disabled: !many }),
        iconBtn('chevron-right', 'Next frame', () => { stop(); step(1); }, { disabled: !many }),
        el('span.pk-vsep'),
        loop,
        el('span.pk-spacer'),
        iconBtn('duplicate', 'Duplicate frame', actions.duplicate, { disabled: !has }),
        iconBtn('tween', 'Tween between this frame and the next', actions.tween, { disabled: !many }),
        iconBtn('trash', 'Delete frame', actions.remove, { disabled: !many })
      );
    }

    /**
     * Coalesce renders.
     *
     * Selecting a frame emits `structure` so the Layers panel follows, and that
     * comes straight back here as a render request. Without coalescing, one frame
     * step rendered the strip several times over; with it, a burst of events costs
     * one render. The timer races the frame callback because a hidden tab never
     * fires `requestAnimationFrame` — the same trap as everywhere else in this
     * codebase.
     */
    let renderQueued = false;
    let rendering = false;
    function schedule() {
      if (renderQueued) return;
      renderQueued = true;
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        renderQueued = false;
        render();
      };
      requestAnimationFrame(run);
      setTimeout(run, 40);
    }

    function render() {
      // Re-entrancy guard: rendering composites the document, and anything that
      // touches the document can emit an event that lands back here.
      if (rendering) return;
      rendering = true;
      try {
        renderNow();
      } finally {
        rendering = false;
      }
    }

    function renderNow() {
      const d = doc();
      renderBar();
      if (!d) {
        strip.replaceChildren(el('div.pk-empty', { text: 'No document open.' }));
        return;
      }
      const frames = framesOf(d);
      if (!frames.length) {
        strip.replaceChildren(
          empty,
          el('div.pktl-start', {},
            el('button.pk-btn.primary', { text: 'Create Frame Animation', onclick: actions.create }),
            el('button.pk-btn.subtle', { text: 'Make Frames From Layers', onclick: actions.fromLayers })
          )
        );
        return;
      }

      const activeId = (activeFrame(d) || {}).id;
      const cells = frames.map((frame, i) => {
        const thumb = frameThumb(d, frame);
        const cell = el(
          'div.pktl-cell' + (frame.id === activeId ? '.active' : '') + (selected.has(frame.id) ? '.picked' : ''),
          {
            draggable: true,
            onclick: (e) => { stop(); select(frame, { additive: e.metaKey || e.ctrlKey }); },
            ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(i)); },
            ondragover: (e) => e.preventDefault(),
            ondrop: (e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (!Number.isFinite(from)) return;
              withCommit('Reorder Frames', (dd) => moveFrame(dd, framesOf(dd)[from], i));
            },
          },
          el('span.pktl-num', { text: String(i + 1) }),
          thumb
        );
        thumb.className = 'pktl-thumb';

        const delay = el('select.pktl-delay', {
          title: 'Frame delay',
          onchange: (e) => {
            const ms = Number(e.target.value);
            withCommit('Frame Delay', (dd) => setFrameDelay(dd, ms, selection()));
          },
          onclick: (e) => e.stopPropagation(),
        });
        const values = DELAY_PRESETS.includes(frame.delay) ? DELAY_PRESETS : [...DELAY_PRESETS, frame.delay].sort((a, b) => a - b);
        for (const ms of values) delay.appendChild(el('option', { value: ms, text: fmtDelay(ms) }));
        delay.value = String(frame.delay);
        cell.appendChild(delay);
        return cell;
      });

      strip.replaceChildren(...cells, el('button.pk-icon-btn.pktl-add', {
        title: 'New frame', onclick: actions.add,
      }, iconEl('plus', { size: 14 })));
    }

    /* --- wiring ------------------------------------------------------- */

    const onLayers = () => {
      // Write the live layer state back into the frame being shown — unless we
      // are the ones who just changed it.
      const d = doc();
      if (!d || applying || rendering) { schedule(); return; }
      const frame = activeFrame(d);
      if (frame) updateFrame(d, frame);
      schedule();
    };

    app.on('docs-change', schedule);
    app.on('active-doc', () => { stop(); selected = new Set(); schedule(); });
    app.on('doc-change', onLayers);
    app.on('doc-structure', onLayers);
    app.on('history-change', () => { stop(); schedule(); });

    render();
    return { refresh: schedule };
  },
});
