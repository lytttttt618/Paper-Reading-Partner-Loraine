// Highlights and notes: creation from a text selection, drawing on pages,
// note cards in the margin beside each page, and the notes list in the side bar.
import { renderRich, escapeHtml } from './rich.js';

export const COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#ffa8a8', '#d0bfff'];
export const NOTE_COLOR = '#74c0fc';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function cleanText(s) {
  return s.replace(/-\s*\n\s*(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
}

/** Merge per-span client rects into one rect per line fragment. */
function mergeRects(rects) {
  rects.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (
      last && last.p === r.p &&
      Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5 &&
      r.x <= last.x + last.w + 0.012
    ) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y1 = Math.min(last.y, r.y);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.w = x2 - last.x;
      last.y = y1;
      last.h = y2 - y1;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Turn the current browser selection inside the paper into an anchor:
 * { text, rects: [{p, x, y, w, h}] } in normalised page coordinates.
 */
export function selectionAnchor(viewer) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const node = common.nodeType === 1 ? common : common.parentElement;
  if (!node || !viewer.pagesEl.contains(node)) return null;
  const text = cleanText(sel.toString());
  if (!text) return null;

  const pageRects = viewer.pages.map((p) => p.pageEl.getBoundingClientRect());
  const rects = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const i = pageRects.findIndex((pr) => cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom);
    if (i < 0) continue;
    const pr = pageRects[i];
    const n = { p: i + 1, x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height };
    if (n.h > 0.06 || n.w > 0.98) continue; // the invisible end-of-content helper
    rects.push(n);
  }
  if (!rects.length) return null;
  return { text, rects: mergeRects(rects), clientRect: range.getBoundingClientRect() };
}

/** Find the annotation (if any) at a point on a page. */
export function annotationAt(annotations, pageNum, x, y) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.rects.some((r) => r.p === pageNum && x >= r.x && x <= r.x + r.w && y >= r.y - 0.002 && y <= r.y + r.h + 0.002)) return a;
  }
  return null;
}

/** Text around a quote on a page, so the AI sees the surrounding paragraph. */
export function surroundingText(pageText, quote, radius = 900) {
  if (!pageText) return '';
  const flat = pageText.replace(/-\s*\n\s*(?=[a-z])/g, '').replace(/\s+/g, ' ');
  const probe = quote.slice(0, 60);
  const i = flat.indexOf(probe);
  if (i < 0) return flat.slice(0, radius * 2);
  return flat.slice(Math.max(0, i - radius), Math.min(flat.length, i + quote.length + radius));
}

export class AnnotationLayer {
  /**
   * @param {object} opts
   * @param {import('./viewer.js').Viewer} opts.viewer
   * @param {() => object[]} opts.list  returns the live annotations array
   * @param {() => void} opts.onChange  persist after edits
   * @param {(a) => void} opts.onAsk    ask AI about an annotation
   */
  constructor({ viewer, list, onChange, onAsk, notesListEl, countEl }) {
    this.viewer = viewer;
    this.list = list;
    this.onChange = onChange;
    this.onAsk = onAsk;
    this.notesListEl = notesListEl;
    this.countEl = countEl;
    this.editing = null;
  }

  get annotations() {
    return this.list();
  }

  add(anchor, { color = COLORS[0], note = null } = {}) {
    const a = {
      id: uid(),
      text: anchor.text,
      rects: anchor.rects,
      color,
      note,
      createdAt: Date.now(),
    };
    this.annotations.push(a);
    if (note !== null && note === '') this.editing = a.id;
    this.changed(a);
    return a;
  }

  update(a, patch) {
    Object.assign(a, patch);
    this.changed(a);
  }

  remove(a) {
    const arr = this.annotations;
    const i = arr.indexOf(a);
    if (i >= 0) arr.splice(i, 1);
    if (this.editing === a.id) this.editing = null;
    this.changed(a);
  }

  changed(a) {
    const pages = a ? new Set(a.rects.map((r) => r.p)) : null;
    for (const p of this.viewer.pages) if (!pages || pages.has(p.num)) this.renderPage(p);
    this.renderList();
    this.onChange();
  }

  renderAll() {
    for (const p of this.viewer.pages) this.renderPage(p);
    this.renderList();
  }

  renderPage(p) {
    p.hlLayer.replaceChildren();
    for (const a of this.annotations) {
      for (const r of a.rects) {
        if (r.p !== p.num) continue;
        const d = document.createElement('div');
        d.className = a.note !== null ? 'hl has-note' : 'hl';
        d.dataset.id = a.id;
        d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;--c:${a.color}`;
        p.hlLayer.append(d);
      }
    }
    this.renderMargin(p);
  }

  notesOnPage(num) {
    return this.annotations
      .filter((a) => a.note !== null && a.rects[0]?.p === num)
      .sort((a, b) => a.rects[0].y - b.rects[0].y);
  }

  renderMargin(p) {
    const margin = p.margin;
    margin.replaceChildren();
    for (const a of this.notesOnPage(p.num)) margin.append(this.noteCard(a));
    this.layoutMargin(p);
  }

  /** Place cards next to their anchors, pushing them down so they never overlap. */
  layoutMargin(p) {
    const H = p.pageEl.offsetHeight;
    let next = 0;
    for (const card of p.margin.children) {
      const a = this.annotations.find((x) => x.id === card.dataset.id);
      const want = (a?.rects[0]?.y ?? 0) * H - 6;
      const top = Math.max(want, next);
      card.style.top = `${top}px`;
      next = top + card.offsetHeight + 8;
    }
    // the margin sits outside the row's flow: grow the row so long notes don't run into the next page
    p.row.style.minHeight = `${Math.max(H, next)}px`;
  }

  layoutAll() {
    for (const p of this.viewer.pages) this.layoutMargin(p);
  }

  noteCard(a) {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.dataset.id = a.id;
    card.style.setProperty('--c', a.color);
    const editing = this.editing === a.id;
    card.innerHTML = `
      <div class="note-head">
        <span class="note-quote" title="${escapeHtml(a.text)}">“${escapeHtml(a.text.slice(0, 80))}${a.text.length > 80 ? '…' : ''}”</span>
        <span class="note-actions">
          <button data-act="edit" title="Edit">✎</button>
          <button data-act="ask" title="Ask AI about this">AI</button>
          <button data-act="del" title="Delete note">✕</button>
        </span>
      </div>
      ${editing
        ? `<textarea class="note-input" rows="4" placeholder="Write a note…  Markdown + LaTeX: $\\alpha$, $$\\sum_i x_i$$"></textarea>
           <div class="note-preview rich"></div>
           <div class="note-edit-actions"><span class="muted">Ctrl+Enter to save</span><button data-act="save" class="primary">Save</button></div>`
        : `<div class="note-body rich">${a.note ? renderRich(a.note) : '<span class="muted">Empty note — click ✎ to write.</span>'}</div>`}
    `;

    const pageRow = () => this.viewer.pages[a.rects[0].p - 1];
    card.addEventListener('mouseenter', () => this.flash(a.id, true));
    card.addEventListener('mouseleave', () => this.flash(a.id, false));
    card.querySelector('.note-quote').addEventListener('click', () => this.viewer.scrollToAnchor(a.rects[0].p, a.rects[0].y));
    card.querySelector('[data-act=edit]').addEventListener('click', () => this.startEdit(a));
    card.querySelector('[data-act=ask]').addEventListener('click', () => this.onAsk(a));
    card.querySelector('[data-act=del]').addEventListener('click', () => {
      if (a.note && !confirm('Delete this note?')) return;
      this.remove(a);
    });
    if (!editing) {
      card.querySelector('.note-body').addEventListener('dblclick', () => this.startEdit(a));
      return card;
    }

    const input = card.querySelector('.note-input');
    const preview = card.querySelector('.note-preview');
    input.value = a.note || '';
    const refresh = () => {
      preview.innerHTML = input.value.trim() ? renderRich(input.value) : '';
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + 2}px`;
      this.layoutMargin(pageRow());
    };
    const save = () => {
      this.editing = null;
      if (a.note !== input.value) this.update(a, { note: input.value });
      else this.renderPage(pageRow());
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); save(); }
    });
    card.querySelector('[data-act=save]').addEventListener('click', save);
    requestAnimationFrame(() => { refresh(); input.focus(); });
    return card;
  }

  startEdit(a) {
    if (a.note === null) a.note = '';
    this.editing = a.id;
    const p = this.viewer.pages[a.rects[0].p - 1];
    this.renderPage(p);
    this.viewer.scrollToAnchor(a.rects[0].p, a.rects[0].y);
  }

  flash(id, on) {
    for (const d of this.viewer.pagesEl.querySelectorAll(`.hl[data-id="${id}"]`)) d.classList.toggle('flash', on);
  }

  renderList() {
    const items = [...this.annotations].sort((a, b) => a.rects[0].p - b.rects[0].p || a.rects[0].y - b.rects[0].y);
    this.countEl.textContent = items.length;
    if (!items.length) {
      this.notesListEl.innerHTML = '<p class="muted pad">No highlights or notes yet. Select text in the paper to add one.<br>还没有高亮或笔记。</p>';
      return;
    }
    this.notesListEl.replaceChildren(...items.map((a) => {
      const row = document.createElement('div');
      row.className = 'note-item';
      row.style.setProperty('--c', a.color);
      row.innerHTML = `
        <div class="note-item-head"><span class="dot"></span><span class="muted">p.${a.rects[0].p}</span>
          <span class="spacer"></span><button class="x" title="Delete">✕</button></div>
        <div class="note-item-quote">${escapeHtml(a.text.slice(0, 220))}${a.text.length > 220 ? '…' : ''}</div>
        ${a.note ? `<div class="note-item-note rich">${renderRich(a.note)}</div>` : ''}`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.x')) {
          if (!a.note || confirm('Delete this highlight and its note?')) this.remove(a);
          return;
        }
        this.viewer.scrollToAnchor(a.rects[0].p, a.rects[0].y);
        this.flash(a.id, true);
        setTimeout(() => this.flash(a.id, false), 1400);
      });
      return row;
    }));
  }
}
