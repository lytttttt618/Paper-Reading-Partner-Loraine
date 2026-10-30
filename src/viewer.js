// PDF rendering (pdf.js), lazy page rendering, zoom, and the line-focus band.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/** Text of a page, used as context for the AI. */
function pageText(textContent) {
  return textContent.items.map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join('');
}

/**
 * Group the rendered text spans into visual lines (normalised 0..1 page coordinates).
 * Spans are merged when they overlap vertically and the horizontal gap is small, so
 * the two columns of a two-column paper stay separate lines.
 */
function computeLines(textLayer, pageEl) {
  const pr = pageEl.getBoundingClientRect();
  if (!pr.width || !pr.height) return [];
  const boxes = [];
  for (const s of textLayer.querySelectorAll('span')) {
    if (s.classList.contains('markedContent') || !s.textContent.trim()) continue;
    const r = s.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const b = {
      l: (r.left - pr.left) / pr.width,
      r: (r.right - pr.left) / pr.width,
      t: (r.top - pr.top) / pr.height,
      b: (r.bottom - pr.top) / pr.height,
    };
    if (b.b - b.t > 0.1) continue; // huge decorative glyphs
    boxes.push(b);
  }
  boxes.sort((a, b) => a.t + a.b - (b.t + b.b) || a.l - b.l);

  const aspect = pr.height / pr.width;
  const lines = [];
  for (const bx of boxes) {
    const h = bx.b - bx.t;
    const maxGap = Math.min(Math.max(h * aspect * 1.2, 0.008), 0.02);
    let target = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 40; k--) {
      const L = lines[k];
      const overlap = Math.min(L.b, bx.b) - Math.max(L.t, bx.t);
      if (overlap < 0.5 * Math.min(h, L.b - L.t)) continue;
      const gap = bx.l > L.r ? bx.l - L.r : bx.r < L.l ? L.l - bx.r : 0;
      if (gap <= maxGap) { target = L; break; }
    }
    if (target) {
      target.l = Math.min(target.l, bx.l);
      target.r = Math.max(target.r, bx.r);
      // keep the line's height anchored to the main text, not super/subscripts
      if (h >= (target.b - target.t) * 0.8) {
        target.t = Math.min(target.t, bx.t);
        target.b = Math.max(target.b, bx.b);
      }
    } else {
      lines.push({ ...bx });
    }
  }
  return lines;
}

export class Viewer {
  constructor(scrollEl, pagesEl, { onPageRendered, onScale } = {}) {
    this.scrollEl = scrollEl;
    this.pagesEl = pagesEl;
    this.onPageRendered = onPageRendered;
    this.onScale = onScale;
    this.scale = 1.25;
    this.pages = [];
    this.pdf = null;
    this.focusEnabled = true;
    this.mouseDown = false;
    this.activePage = null;
    this.frame = 0;

    scrollEl.addEventListener('scroll', () => this.scheduleRender(), { passive: true });
    window.addEventListener('resize', () => this.scheduleRender());
    pagesEl.addEventListener('mousemove', (e) => this.onMove(e));
    pagesEl.addEventListener('mouseleave', () => this.clearFocus());
    pagesEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.mouseDown = true;
      e.target.closest?.('.textLayer')?.classList.add('selecting');
    });
    this.textLayers = new Map(); // text layer div -> its endOfContent div
    this.installSelectionListener();
  }

  /**
   * Port of pdf.js' TextLayerBuilder selection handling: while selecting, the
   * invisible endOfContent div is moved next to the selection end so dragging
   * across the gaps between words extends the selection instead of losing it.
   */
  installSelectionListener() {
    const reset = (end, layer) => {
      layer.append(end);
      end.style.width = '';
      end.style.height = '';
      layer.classList.remove('selecting');
    };
    const resetAll = () => this.textLayers.forEach(reset);
    document.addEventListener('pointerup', () => { this.mouseDown = false; resetAll(); });
    window.addEventListener('blur', () => { this.mouseDown = false; resetAll(); });
    document.addEventListener('keyup', () => { if (!this.mouseDown) resetAll(); });
    let prevRange = null;
    let isFirefox;
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      if (!sel.rangeCount) { resetAll(); return; }
      const range = sel.getRangeAt(0);
      for (const [layer, end] of this.textLayers) {
        if (range.intersectsNode(layer)) layer.classList.add('selecting');
        else reset(end, layer);
      }
      if (!this.textLayers.size) return;
      isFirefox ??= getComputedStyle(this.textLayers.keys().next().value).getPropertyValue('-moz-user-select') === 'none';
      if (isFirefox) return;
      const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
        || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      const layer = anchor.parentElement?.closest('.textLayer');
      const end = this.textLayers.get(layer);
      if (end) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    });
  }

  async open(bytes) {
    if (this.pdf) await this.pdf.destroy().catch(() => {});
    this.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    this.pagesEl.replaceChildren();
    this.textLayers.clear();
    this.pages = [];
    this.activePage = null;
    for (let num = 1; num <= this.pdf.numPages; num++) {
      const page = await this.pdf.getPage(num);
      const vp = page.getViewport({ scale: 1 });
      const row = el('div', 'page-row');
      const pageEl = el('div', 'page');
      pageEl.dataset.page = num;
      const canvas = el('canvas');
      const hlLayer = el('div', 'hl-layer');
      const textLayer = el('div', 'textLayer');
      const focusLayer = el('div', 'focus-layer');
      const band = el('div', 'focus-band');
      focusLayer.append(band);
      pageEl.append(canvas, hlLayer, textLayer, focusLayer);
      const margin = el('div', 'margin');
      margin.dataset.page = num;
      row.append(pageEl, margin);
      this.pagesEl.append(row);
      this.pages.push({
        num, baseW: vp.width, baseH: vp.height, row, pageEl, canvas, hlLayer, textLayer, band, margin,
        lines: [], text: '', renderedScale: 0, rendering: 0,
      });
    }
    this.applySize();
    this.scrollEl.scrollTop = 0;
    this.scheduleRender();
  }

  async title() {
    try {
      const meta = await this.pdf.getMetadata();
      const t = meta?.info?.Title?.trim();
      if (t && t.length > 4 && !/^untitled|\.(docx?|tex|dvi)$/i.test(t)) return t;
    } catch { /* fall through */ }
    const first = this.pages[0];
    if (first && !first.text) {
      const page = await this.pdf.getPage(1);
      first.text = pageText(await page.getTextContent());
    }
    return (first?.text || '').split('\n').map((s) => s.trim()).find((s) => s.length > 15)?.slice(0, 200) || '';
  }

  fitScale() {
    if (!this.pages.length) return this.scale;
    const marginW = this.pages[0].margin.offsetWidth || 0;
    const avail = this.scrollEl.clientWidth - marginW - 72;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / this.pages[0].baseW));
  }

  applySize() {
    for (const p of this.pages) {
      p.pageEl.style.width = `${p.baseW * this.scale}px`;
      p.pageEl.style.height = `${p.baseH * this.scale}px`;
      p.pageEl.style.setProperty('--scale-factor', this.scale);
    }
  }

  setScale(scale) {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(scale * 100) / 100));
    if (scale === this.scale) return;
    const sc = this.scrollEl;
    const ratio = sc.scrollHeight ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0;
    this.scale = scale;
    this.applySize();
    sc.scrollTop = ratio * sc.scrollHeight - sc.clientHeight / 2;
    this.onScale?.(scale);
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const view = this.scrollEl.getBoundingClientRect();
      const pad = view.height;
      for (const p of this.pages) {
        if (p.renderedScale === this.scale || p.rendering === this.scale) continue;
        const r = p.pageEl.getBoundingClientRect();
        if (r.bottom > view.top - pad && r.top < view.bottom + pad) this.renderPage(p);
      }
    });
  }

  async renderPage(p) {
    const scale = this.scale;
    p.rendering = scale;
    try {
      const page = await this.pdf.getPage(p.num);
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = el('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
      if (scale !== this.scale) return;
      p.canvas.replaceWith(canvas);
      p.canvas = canvas;

      const textContent = await page.getTextContent();
      if (!p.text) p.text = pageText(textContent);
      const textLayer = el('div', 'textLayer');
      await new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport: vp }).render();
      if (scale !== this.scale) return;
      const end = el('div', 'endOfContent');
      textLayer.append(end);
      this.textLayers.delete(p.textLayer);
      this.textLayers.set(textLayer, end);
      p.textLayer.replaceWith(textLayer);
      p.textLayer = textLayer;
      p.lines = computeLines(textLayer, p.pageEl);
      p.renderedScale = scale;
      this.onPageRendered?.(p);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(`page ${p.num}`, e);
    } finally {
      if (p.rendering === scale) p.rendering = 0;
      if (scale !== this.scale) this.scheduleRender();
    }
  }

  pageAt(clientX, clientY) {
    for (const p of this.pages) {
      const r = p.pageEl.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return { p, r };
    }
    return null;
  }

  scrollToAnchor(pageNum, y) {
    const p = this.pages[pageNum - 1];
    if (!p) return;
    const top = p.row.offsetTop + y * p.pageEl.offsetHeight - this.scrollEl.clientHeight / 3;
    this.scrollEl.scrollTo({ top, behavior: 'smooth' });
  }

  // ---- line focus ----------------------------------------------------------

  setFocusEnabled(on) {
    this.focusEnabled = on;
    if (!on) this.clearFocus();
  }

  onMove(e) {
    if (!this.focusEnabled || this.mouseDown) return;
    const pageEl = e.target.closest?.('.page');
    if (!pageEl) return; // in the notes margin: keep the last line focused
    const p = this.pages[pageEl.dataset.page - 1];
    if (!p?.lines.length) return;
    const r = pageEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    let best = null;
    let bestD = Infinity;
    for (const L of p.lines) {
      if (x < L.l - 0.015 || x > L.r + 0.015) continue;
      const d = y < L.t ? L.t - y : y > L.b ? y - L.b : 0;
      if (d < bestD) { bestD = d; best = L; }
    }
    // Between lines or over a figure: keep the current line so the band doesn't flicker.
    if (best && bestD < 0.025) this.showBand(p, best);
  }

  showBand(p, L) {
    if (this.activePage !== p) {
      this.activePage?.pageEl.classList.remove('focus-active');
      p.pageEl.classList.add('focus-active');
      this.activePage = p;
    }
    this.scrollEl.classList.add('focusing');
    const padY = (L.b - L.t) * 0.22;
    const s = p.band.style;
    s.left = `calc(${(L.l * 100).toFixed(3)}% - 5px)`;
    s.width = `calc(${((L.r - L.l) * 100).toFixed(3)}% + 10px)`;
    s.top = `${((L.t - padY) * 100).toFixed(3)}%`;
    s.height = `${((L.b - L.t + 2 * padY) * 100).toFixed(3)}%`;
  }

  clearFocus() {
    this.scrollEl.classList.remove('focusing');
    this.activePage?.pageEl.classList.remove('focus-active');
    this.activePage = null;
  }
}
