// The library: every PDF you open is kept in this browser (IndexedDB) together
// with its notes, so it can be reopened from the left side bar without uploading.
import { idbGet, idbSet, idbDelete } from './storage.js';
import { escapeHtml } from './rich.js';

const LIST_KEY = 'library';
const pdfKey = (docKey) => `pdf:${docKey}`;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ts) {
  const s = (ts - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  return 'just now';
}

function size(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class Library {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.listEl
   * @param {HTMLInputElement} opts.searchEl
   * @param {HTMLElement} opts.footerEl
   * @param {(docKey: string) => void} opts.onOpen
   * @param {(item: object) => void} opts.onDelete
   */
  constructor({ listEl, searchEl, footerEl, onOpen, onDelete }) {
    this.listEl = listEl;
    this.searchEl = searchEl;
    this.footerEl = footerEl;
    this.onOpen = onOpen;
    this.onDelete = onDelete;
    this.items = [];
    this.current = null;
    this.saveTimer = 0;
    searchEl.addEventListener('input', () => this.render());
  }

  async load() {
    this.items = (await idbGet(LIST_KEY)) || [];
    this.render();
  }

  get(docKey) {
    return this.items.find((i) => i.docKey === docKey);
  }

  bytes(docKey) {
    return idbGet(pdfKey(docKey));
  }

  /** Remember a PDF (bytes + metadata). Called every time a paper is opened. */
  async add({ docKey, fileName, title, pages, bytes, noteCount }) {
    let item = this.get(docKey);
    if (!item) {
      await idbSet(pdfKey(docKey), bytes);
      item = { docKey, addedAt: Date.now(), size: bytes.byteLength };
      this.items.push(item);
      // ask the browser not to clear our storage when space runs low
      navigator.storage?.persist?.().catch(() => {});
    } else if (!(await idbGet(pdfKey(docKey)))) {
      await idbSet(pdfKey(docKey), bytes);
    }
    Object.assign(item, { fileName, title, pages, noteCount, openedAt: Date.now() });
    this.current = docKey;
    await this.save();
  }

  /** Update counters (notes, chats) for a paper; saved shortly after. */
  touch(docKey, patch) {
    const item = this.get(docKey);
    if (!item) return;
    Object.assign(item, patch, { editedAt: Date.now() });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  async remove(docKey) {
    this.items = this.items.filter((i) => i.docKey !== docKey);
    if (this.current === docKey) this.current = null;
    await Promise.all([idbDelete(pdfKey(docKey)), idbDelete(`doc:${docKey}`)]);
    await this.save();
  }

  async save() {
    await idbSet(LIST_KEY, this.items);
    this.render();
  }

  async renderUsage() {
    const total = this.items.reduce((n, i) => n + (i.size || 0), 0);
    let text = `${this.items.length} paper${this.items.length === 1 ? '' : 's'} · ${size(total)}`;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) text += ` · ${Math.round((est.usage / est.quota) * 100)}% of browser storage`;
    } catch { /* estimate unavailable */ }
    this.footerEl.textContent = text;
  }

  render() {
    const q = this.searchEl.value.trim().toLowerCase();
    const items = [...this.items]
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      .filter((i) => !q || `${i.fileName} ${i.title || ''}`.toLowerCase().includes(q));
    this.renderUsage();
    if (!items.length) {
      this.listEl.innerHTML = `<p class="muted pad">${this.items.length
        ? 'No papers match your search.'
        : 'Papers you open are saved here, with their notes, so you can come back to them without uploading again.<br>打开过的论文会保存在这里。'}</p>`;
      return;
    }
    this.listEl.replaceChildren(...items.map((i) => {
      const row = document.createElement('div');
      row.className = `lib-item${i.docKey === this.current ? ' current' : ''}`;
      row.title = i.title || i.fileName;
      const showTitle = i.title && i.title.toLowerCase() !== i.fileName.replace(/\.pdf$/i, '').toLowerCase();
      row.innerHTML = `
        <div class="lib-name">${escapeHtml(i.fileName)}</div>
        ${showTitle ? `<div class="lib-title">${escapeHtml(i.title)}</div>` : ''}
        <div class="lib-meta">${i.pages ? `${i.pages} p · ` : ''}${i.noteCount ? `${i.noteCount} note${i.noteCount === 1 ? '' : 's'} · ` : ''}${ago(i.editedAt && i.editedAt > (i.openedAt || 0) ? i.editedAt : i.openedAt || i.addedAt)}</div>
        <button class="x lib-del" title="Remove from library · 删除">✕</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.lib-del')) this.onDelete(i);
        else if (i.docKey !== this.current) this.onOpen(i.docKey);
      });
      return row;
    }));
  }
}
