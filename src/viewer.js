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
  return mergeAcrossWideGaps(lines, boxes);
}

/**
 * Justified text can leave word gaps wider than the threshold above, splitting
 * one line into fragments. Join fragments on the same row unless the gap is the
 * gutter between two columns (an x range that almost no text crosses).
 */
function mergeAcrossWideGaps(lines, boxes) {
  const BINS = 200;
  const cover = new Array(BINS).fill(0);
  for (const b of boxes) {
    for (let i = Math.max(0, Math.floor(b.l * BINS)); i < Math.min(BINS, Math.ceil(b.r * BINS)); i++) cover[i]++;
  }
  const quiet = Math.max(1, boxes.length * 0.004);
  const isGutter = (x1, x2) => {
    for (let i = Math.ceil(x1 * BINS); i < Math.floor(x2 * BINS); i++) {
      if (i / BINS > 0.25 && i / BINS < 0.75 && cover[i] <= quiet) return true;
    }
    return false;
  };
  lines.sort((a, b) => a.t + a.b - (b.t + b.b) || a.l - b.l);
  const out = [];
  for (const L of lines) {
    const prev = out.findLast((M) => {
      const overlap = Math.min(M.b, L.b) - Math.max(M.t, L.t);
      return overlap > 0.6 * Math.min(M.b - M.t, L.b - L.t);
    });
    if (prev && L.l >= prev.r && L.l - prev.r < 0.08 && !isGutter(prev.r, L.l)) {
      prev.r = Math.max(prev.r, L.r);
      prev.t = Math.min(prev.t, L.t);
      prev.b = Math.max(prev.b, L.b);
    } else {
      out.push(L);
    }
  }
  return out;
}

/**
 * Lines in reading order: full-width lines and columns top to bottom, with the
 * left column of a two-column block read before the right one.
 */
function readingOrder(lines) {
  if (lines.order) return lines.order;
  const wide = (L) => L.r - L.l > 0.55;
  const colOf = (L) => (wide(L) ? -1 : (L.l + L.r) / 2 < 0.5 ? 0 : 1);
  // full-width lines split the page into blocks; inside a block read column 0, then 1
  const sorted = [...lines].sort((a, b) => a.t - b.t);
  const order = [];
  let block = [];
  const flush = () => {
    block.sort((a, b) => colOf(a) - colOf(b) || a.t - b.t);
    order.push(...block);
    block = [];
  };
  for (const L of sorted) {
    if (wide(L)) { flush(); order.push(L); } else block.push(L);
  }
  flush();
  lines.order = order;
  return order;
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
    this.focusLines = 1;
    this.mouseDown = false;
    this.activePage = null;
    this.frame = 0;

    scrollEl.addEventListener('scroll', () => this.scheduleRender(), { passive: true });
    window.addEventListener('resize', () => { this.centerHorizontally(); this.scheduleRender(); });
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
    this.current = null;
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

  /** Close the current document and clear the pages. */
  async close() {
    if (this.pdf) await this.pdf.destroy().catch(() => {});
    this.pdf = null;
    this.pagesEl.replaceChildren();
    this.textLayers.clear();
    this.pages = [];
    this.activePage = null;
    this.current = null;
    this.scrollEl.classList.remove('focusing');
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
    // the page is centred, so leave room for the notes margin on both sides
    const marginW = this.pages[0].margin.offsetWidth || 0;
    const avail = this.scrollEl.clientWidth - 2 * marginW - 100;
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
    this.centerHorizontally();
    this.onScale?.(scale);
    this.scheduleRender();
  }

  /** When the page area is wider than the window, keep the page itself in the middle. */
  centerHorizontally() {
    const sc = this.scrollEl;
    sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
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
      if (this.current?.p === p) {
        // re-rendered after a zoom: keep the band on the same line
        const L = this.current.L;
        const same = p.lines.reduce((a, b) => (Math.abs(b.t - L.t) + Math.abs(b.l - L.l) < Math.abs(a.t - L.t) + Math.abs(a.l - L.l) ? b : a), p.lines[0]);
        if (same) this.showBand(p, same);
      }
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
    // ignore the synthetic mousemove browsers fire when the page scrolls under a still mouse
    if (e.clientX === this.lastMouse?.x && e.clientY === this.lastMouse?.y) return;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    const pageEl = e.target.closest?.('.page');
    if (!pageEl) return; // in the notes margin: keep the last line focused
    this.focusAt(this.pages[pageEl.dataset.page - 1], e.clientX, e.clientY);
  }

  /** Focus the line nearest to a screen point on page p. */
  focusAt(p, clientX, clientY) {
    if (!p?.lines.length) return;
    const r = p.pageEl.getBoundingClientRect();
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
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
    this.current = { p, L };
    if (this.activePage !== p) {
      this.activePage?.pageEl.classList.remove('focus-active');
      p.pageEl.classList.add('focus-active');
      this.activePage = p;
    }
    this.scrollEl.classList.add('focusing');
    // the band starts at L and covers the next focusLines - 1 lines of the same column
    const box = { ...L };
    const order = readingOrder(p.lines);
    let prev = L;
    for (let i = order.indexOf(L) + 1, n = 1; n < this.focusLines && i < order.length; i++, n++) {
      const M = order[i];
      const overlap = Math.min(M.r, prev.r) - Math.max(M.l, prev.l);
      const gap = M.t - prev.b;
      if (overlap < 0.3 * Math.min(M.r - M.l, prev.r - prev.l) || gap > 3 * (prev.b - prev.t) || gap < -0.002) break;
      box.l = Math.min(box.l, M.l);
      box.r = Math.max(box.r, M.r);
      box.b = M.b;
      prev = M;
    }
    const padY = (L.b - L.t) * 0.22;
    const s = p.band.style;
    s.left = `calc(${(box.l * 100).toFixed(3)}% - 5px)`;
    s.width = `calc(${((box.r - box.l) * 100).toFixed(3)}% + 10px)`;
    s.top = `${((box.t - padY) * 100).toFixed(3)}%`;
    s.height = `${((box.b - box.t + 2 * padY) * 100).toFixed(3)}%`;
  }

  /** How many lines the focus band shows at once (1–10). */
  setFocusLines(n) {
    this.focusLines = Math.max(1, Math.min(10, n | 0));
    if (this.current && this.activePage) this.showBand(this.current.p, this.current.L);
  }

  /** Move the focus band to the next (dir = 1) or previous (dir = -1) line in reading order. */
  async step(dir) {
    if (!this.focusEnabled || !this.pages.length) return;
    let cur = this.current;
    if (!cur) {
      // start from the first line visible on screen
      const view = this.scrollEl.getBoundingClientRect();
      for (const p of this.pages) {
        const r = p.pageEl.getBoundingClientRect();
        if (r.bottom < view.top || !p.lines.length) continue;
        const top = (view.top - r.top) / r.height;
        const L = readingOrder(p.lines).find((l) => l.t >= top) || p.lines[0];
        this.showBand(p, L);
        this.revealBand();
        return;
      }
      return;
    }
    let { p, L } = cur;
    const order = readingOrder(p.lines);
    const i = order.indexOf(L);
    let next = order[i + dir];
    while (!next) {
      p = this.pages[p.num - 1 + dir];
      if (!p) return;
      if (!p.lines.length || p.renderedScale !== this.scale) {
        p.row.scrollIntoView({ block: dir > 0 ? 'start' : 'end' });
        await this.renderPage(p);
      }
      const o = readingOrder(p.lines);
      next = dir > 0 ? o[0] : o[o.length - 1];
    }
    this.showBand(p, next);
    this.revealBand();
  }

  /** Scroll just enough to keep the focused line comfortably on screen. */
  revealBand() {
    const band = this.current?.p.band;
    if (!band) return;
    const b = band.getBoundingClientRect();
    const v = this.scrollEl.getBoundingClientRect();
    const pad = v.height * 0.2;
    if (b.top < v.top + pad) this.scrollEl.scrollBy({ top: b.top - v.top - pad });
    else if (b.bottom > v.bottom - pad) this.scrollEl.scrollBy({ top: b.bottom - v.bottom + pad });
  }

  clearFocus() {
    this.scrollEl.classList.remove('focusing');
    this.activePage?.pageEl.classList.remove('focus-active');
    this.activePage = null;
  }
}
