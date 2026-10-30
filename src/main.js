import 'pdfjs-dist/web/pdf_viewer.css';
import 'katex/dist/katex.min.css';
import './styles.css';

import { Viewer } from './viewer.js';
import { AnnotationLayer, COLORS, NOTE_COLOR, annotationAt, selectionAnchor, surroundingText } from './annotations.js';
import { CLAUDE_MODELS, DEFAULT_MODEL, chatStream, systemPrompt, translate } from './ai.js';
import { renderRich, escapeHtml } from './rich.js';
import { exportPdf, exportMarkdown, exportProject } from './export.js';
import { loadSettings, saveSettings, idbGet, idbSet } from './storage.js';
import { Library } from './library.js';

const $ = (sel) => document.querySelector(sel);

const settings = loadSettings();
const state = {
  docKey: null,
  fileName: '',
  title: '',
  bytes: null,
  annotations: [],
  chat: [],
};

// ---------------------------------------------------------------- toast

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- persistence

let saveTimer;
let pendingSave = null;
function persist() {
  if (!state.docKey) return;
  // snapshot now, so switching papers before the timer fires still saves to the right one
  const key = state.docKey;
  const data = { fileName: state.fileName, annotations: state.annotations, chat: state.chat, savedAt: Date.now() };
  library.touch(key, { noteCount: state.annotations.length });
  clearTimeout(saveTimer);
  pendingSave = () => idbSet(`doc:${key}`, data);
  saveTimer = setTimeout(flushSave, 300);
}
function flushSave() {
  clearTimeout(saveTimer);
  const save = pendingSave;
  pendingSave = null;
  return save?.();
}
window.addEventListener('pagehide', flushSave);

// ---------------------------------------------------------------- viewer & annotations

const viewer = new Viewer($('#viewer'), $('#pages'), {
  onPageRendered: (p) => notes.renderPage(p),
  onScale: (s) => {
    $('#zoom-label').textContent = `${Math.round(s * 100)}%`;
    notes.layoutAll();
  },
});

const notes = new AnnotationLayer({
  viewer,
  list: () => state.annotations,
  onChange: persist,
  onAsk: (a) => askAbout({ text: a.text, rects: a.rects }),
  notesListEl: $('#notes-list'),
  countEl: $('#notes-count'),
});

async function openPdf(bytes, fileName) {
  hideMenus();
  await flushSave();
  chatAbort?.abort();
  trAbort?.abort();
  trPop.hidden = true;
  pendingQuote = null;
  $('#quote-chip').hidden = true;
  toast('Opening…', 0);
  try {
    state.bytes = bytes;
    state.fileName = fileName;
    await viewer.open(bytes);
  } catch (e) {
    console.error(e);
    toast(`Could not open this PDF: ${e.message}`, 5000);
    return;
  }
  $('#empty').hidden = true;
  document.title = `${fileName} — Paper Reading Partner`;
  state.docKey = viewer.pdf.fingerprints?.[0] || fileName;
  const saved = await idbGet(`doc:${state.docKey}`);
  state.annotations = saved?.annotations || [];
  state.chat = saved?.chat || [];
  state.title = await viewer.title();
  viewer.setScale(Math.min(1.6, viewer.fitScale()));
  $('#zoom-label').textContent = `${Math.round(viewer.scale * 100)}%`;
  notes.renderAll();
  renderChat();
  await library.add({
    docKey: state.docKey, fileName, title: state.title, pages: viewer.pages.length, bytes, noteCount: state.annotations.length,
  });
  idbSet('lastDoc', state.docKey);
  toast(saved ? `Opened ${fileName} — your notes were restored` : `Opened ${fileName}`);
}

async function openFromLibrary(docKey) {
  const item = library.get(docKey);
  const bytes = await library.bytes(docKey);
  if (!bytes) {
    toast('This PDF is no longer stored in the browser. Please open the file again.', 4000);
    return;
  }
  await openPdf(bytes, item?.fileName || 'paper.pdf');
}

async function deleteFromLibrary(item) {
  const what = item.noteCount ? ` and its ${item.noteCount} highlight${item.noteCount === 1 ? '' : 's'}/notes and AI chat` : ' and its AI chat';
  if (!confirm(`Remove “${item.fileName}”${what} from this browser?\n\nExport it first if you want to keep your notes. 删除后无法恢复。`)) return;
  if (item.docKey === state.docKey) {
    clearTimeout(saveTimer);
    pendingSave = null;
    chatAbort?.abort();
    await viewer.close();
    Object.assign(state, { docKey: null, fileName: '', title: '', bytes: null, annotations: [], chat: [] });
    $('#empty').hidden = false;
    document.title = 'Paper Reading Partner';
    notes.renderList();
    renderChat();
    idbSet('lastDoc', null);
  }
  await library.remove(item.docKey);
  toast(`Removed ${item.fileName}`);
}

const library = new Library({
  listEl: $('#lib-list'),
  searchEl: $('#lib-search'),
  footerEl: $('#lib-usage'),
  onOpen: openFromLibrary,
  onDelete: deleteFromLibrary,
});

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast('Please choose a PDF file.');
    return;
  }
  openPdf(new Uint8Array(await file.arrayBuffer()), file.name);
}

$('#btn-open').addEventListener('click', () => $('#file-input').click());
$('#btn-open-2').addEventListener('click', () => $('#file-input').click());
$('#lib-open').addEventListener('click', () => $('#file-input').click());

function applyLibrary() {
  document.body.classList.toggle('no-library', !settings.libraryOpen);
  $('#btn-library').classList.toggle('on', settings.libraryOpen);
  requestAnimationFrame(() => { viewer.centerHorizontally(); viewer.scheduleRender(); });
}
$('#btn-library').addEventListener('click', () => { settings.libraryOpen = !settings.libraryOpen; saveSettings(settings); applyLibrary(); });
$('#library-close').addEventListener('click', () => { settings.libraryOpen = false; saveSettings(settings); applyLibrary(); });
$('#file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  openFile(e.dataTransfer?.files?.[0]);
});

// ---------------------------------------------------------------- toolbar: zoom, font, focus, theme

$('#zoom-in').addEventListener('click', () => viewer.setScale(viewer.scale * 1.15));
$('#zoom-out').addEventListener('click', () => viewer.setScale(viewer.scale / 1.15));
$('#zoom-fit').addEventListener('click', () => viewer.setScale(viewer.fitScale()));
$('#viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !viewer.pdf) return;
  e.preventDefault();
  viewer.setScale(viewer.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
}, { passive: false });

function applyFont() {
  document.documentElement.style.setProperty('--ui-font', `${settings.fontSize}px`);
  $('#font-label').textContent = `${settings.fontSize}px`;
  requestAnimationFrame(() => notes.layoutAll());
}
$('#font-up').addEventListener('click', () => { settings.fontSize = Math.min(24, settings.fontSize + 1); saveSettings(settings); applyFont(); });
$('#font-down').addEventListener('click', () => { settings.fontSize = Math.max(11, settings.fontSize - 1); saveSettings(settings); applyFont(); });

function applyFocus() {
  $('#btn-focus').classList.toggle('on', settings.focus);
  viewer.setFocusEnabled(settings.focus);
}
$('#btn-focus').addEventListener('click', () => { settings.focus = !settings.focus; saveSettings(settings); applyFocus(); });

function setFocusLines(n) {
  settings.focusLines = Math.max(1, Math.min(10, n));
  saveSettings(settings);
  $('#focus-lines').value = String(settings.focusLines);
  viewer.setFocusLines(settings.focusLines);
}
$('#focus-lines').addEventListener('change', (e) => {
  setFocusLines(+e.target.value);
  e.target.blur(); // give the arrow keys back to the paper
});

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  $('#theme').value = settings.theme;
}
$('#theme').addEventListener('change', (e) => { settings.theme = e.target.value; saveSettings(settings); applyTheme(); });

// The AI side bar starts hidden; it slides out when you ask the AI something.
let sidebarOpen = false;
function setSidebar(open) {
  sidebarOpen = open;
  document.body.classList.toggle('no-sidebar', !open);
  $('#btn-sidebar').classList.toggle('on', open);
  requestAnimationFrame(() => { viewer.centerHorizontally(); viewer.scheduleRender(); });
}
$('#btn-sidebar').addEventListener('click', () => setSidebar(!sidebarOpen));
$('#sidebar-close').addEventListener('click', () => setSidebar(false));

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === `tab-${name}`);
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

// ---------------------------------------------------------------- selection / highlight menu

const menu = $('#sel-menu');
let menuAnchor = null; // { text, rects, clientRect }
let menuAnn = null; // annotation when the menu was opened by clicking a highlight

function placeFloating(elm, rect, below = false) {
  elm.hidden = false;
  const w = elm.offsetWidth;
  const h = elm.offsetHeight;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  let top = below ? rect.bottom + 10 : rect.top - h - 10;
  if (top < 56) top = rect.bottom + 10;
  if (top + h > window.innerHeight - 8) top = Math.max(56, window.innerHeight - h - 8);
  elm.style.left = `${left}px`;
  elm.style.top = `${top}px`;
}

function menuButton(label, title, fn, cls = '') {
  const b = document.createElement('button');
  b.innerHTML = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

function colorButtons(onPick, current) {
  const wrap = document.createElement('span');
  wrap.className = 'swatches';
  for (const c of COLORS) {
    const b = menuButton('', 'Highlight 高亮', () => onPick(c), `swatch${c === current ? ' current' : ''}`);
    b.style.setProperty('--c', c);
    wrap.append(b);
  }
  return wrap;
}

function showSelectionMenu(anchor) {
  menuAnchor = anchor;
  menuAnn = null;
  menu.replaceChildren(
    menuButton('Translate<small>翻译</small>', 'Translate (T)', () => doTranslate(anchor)),
    menuButton('Ask AI<small>问 AI</small>', 'Ask Claude (A)', () => askAbout(anchor)),
    colorButtons((c) => doHighlight(anchor, c)),
    menuButton('Note<small>笔记</small>', 'Add a note (N)', () => doNote(anchor)),
    menuButton('Copy<small>复制</small>', 'Copy', () => { navigator.clipboard?.writeText(anchor.text); hideMenus(); toast('Copied'); }),
  );
  placeFloating(menu, anchor.clientRect);
}

function showAnnotationMenu(a, rect) {
  menuAnn = a;
  menuAnchor = { text: a.text, rects: a.rects, clientRect: rect };
  menu.replaceChildren(
    menuButton('Translate<small>翻译</small>', 'Translate', () => doTranslate(menuAnchor)),
    menuButton('Ask AI<small>问 AI</small>', 'Ask Claude', () => askAbout(menuAnchor)),
    colorButtons((c) => { notes.update(a, { color: c }); hideMenus(); }, a.color),
    menuButton(a.note !== null ? 'Edit note<small>编辑</small>' : 'Note<small>笔记</small>', 'Note', () => { hideMenus(); notes.startEdit(a); }),
    menuButton('Delete<small>删除</small>', 'Remove highlight', () => {
      hideMenus();
      if (!a.note || confirm('Delete this highlight and its note?')) notes.remove(a);
    }, 'danger'),
  );
  placeFloating(menu, rect);
}

function hideMenus() {
  menu.hidden = true;
}

function doHighlight(anchor, color) {
  notes.add(anchor, { color });
  window.getSelection()?.removeAllRanges();
  hideMenus();
}

function doNote(anchor) {
  notes.add(anchor, { color: NOTE_COLOR, note: '' });
  window.getSelection()?.removeAllRanges();
  hideMenus();
}

// A plain single click on the paper switches between line focus and normal
// reading. Drags (selections), double-clicks (word selection), clicks on a
// highlight, and clicks that only close an open menu don't count.
let downAt = null;
let clickTimer = 0;
$('#pages').addEventListener('mousedown', (e) => {
  clearTimeout(clickTimer);
  downAt = { x: e.clientX, y: e.clientY, popupOpen: !menu.hidden || !trPop.hidden };
});

$('#pages').addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  setTimeout(() => {
    const anchor = selectionAnchor(viewer);
    if (anchor) { showSelectionMenu(anchor); return; }
    // a plain click: did it land on a highlight?
    const hit = viewer.pageAt(e.clientX, e.clientY);
    if (!hit) return;
    const x = (e.clientX - hit.r.left) / hit.r.width;
    const y = (e.clientY - hit.r.top) / hit.r.height;
    const a = annotationAt(state.annotations, hit.p.num, x, y);
    if (a) { showAnnotationMenu(a, new DOMRect(e.clientX - 1, e.clientY - 10, 2, 20)); return; }
    const wasPopup = downAt?.popupOpen;
    hideMenus();
    const moved = !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (moved || wasPopup || e.detail !== 1) return;
    // wait a moment so the first click of a double-click doesn't toggle
    clickTimer = setTimeout(() => {
      if (window.getSelection()?.isCollapsed === false) return;
      toggleFocus(e.clientX, e.clientY, hit.p);
    }, 280);
  }, 0);
});

function toggleFocus(clientX, clientY, page) {
  settings.focus = !settings.focus;
  saveSettings(settings);
  applyFocus();
  if (settings.focus && page) viewer.focusAt(page, clientX, clientY);
  toast(settings.focus ? 'Line focus on · 聚焦模式' : 'Normal reading · 普通模式', 1200);
}

document.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) hideMenus();
});
$('#viewer').addEventListener('scroll', hideMenus, { passive: true });

// ---------------------------------------------------------------- translation

const trPop = $('#tr-pop');
let trAbort = null;
let trAnchor = null;
let trResult = '';

async function doTranslate(anchor) {
  hideMenus();
  trAbort?.abort();
  trAbort = new AbortController();
  trAnchor = anchor;
  trResult = '';
  trPop.querySelector('.tr-source').textContent = anchor.text.length > 300 ? `${anchor.text.slice(0, 300)}…` : anchor.text;
  trPop.querySelector('.tr-src').textContent = '';
  const body = trPop.querySelector('.tr-body');
  body.innerHTML = '<span class="muted">Translating… 翻译中…</span>';
  placeFloating(trPop, anchor.clientRect, true);
  const p = viewer.pages[anchor.rects[0].p - 1];
  try {
    const { text, source } = await translate(anchor.text, settings, {
      context: surroundingText(p?.text, anchor.text, 250),
      signal: trAbort.signal,
      onDelta: (t) => { trResult = t; body.innerHTML = renderRich(t); },
    });
    trResult = text;
    body.innerHTML = renderRich(text);
    trPop.querySelector('.tr-src').textContent = `via ${source}`;
  } catch (e) {
    if (e.name === 'AbortError') return;
    body.innerHTML = `<span class="error">${escapeHtml(e.message)}</span>`;
  }
  placeFloating(trPop, anchor.clientRect, true);
}

trPop.querySelector('.x').addEventListener('click', () => { trAbort?.abort(); trPop.hidden = true; });
trPop.querySelector('[data-act=note]').addEventListener('click', () => {
  if (!trAnchor || !trResult) return;
  notes.add(trAnchor, { color: NOTE_COLOR, note: trResult });
  window.getSelection()?.removeAllRanges();
  trPop.hidden = true;
  toast('Saved as a note beside the paper');
});
trPop.querySelector('[data-act=ask]').addEventListener('click', () => {
  if (trAnchor) askAbout(trAnchor);
  trPop.hidden = true;
});

// ---------------------------------------------------------------- AI chat

const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
let pendingQuote = null; // { text, rects }
let chatAbort = null;

function askAbout(anchor) {
  hideMenus();
  pendingQuote = { text: anchor.text, rects: anchor.rects };
  const chip = $('#quote-chip');
  chip.querySelector('.quote-text').textContent = anchor.text;
  chip.hidden = false;
  setSidebar(true);
  showTab('chat');
  chatInput.focus();
}

$('#quote-chip .x').addEventListener('click', () => { pendingQuote = null; $('#quote-chip').hidden = true; });

for (const b of document.querySelectorAll('.quick button')) {
  b.addEventListener('click', () => sendChat(b.dataset.q));
}

function messageEl(m, i) {
  const div = document.createElement('div');
  div.className = `msg ${m.role}`;
  const quote = m.quote
    ? `<blockquote class="msg-quote" data-i="${i}" title="Jump to this passage">${escapeHtml(m.quote.text.slice(0, 400))}${m.quote.text.length > 400 ? '…' : ''}</blockquote>`
    : '';
  if (m.role === 'user') {
    div.innerHTML = `${quote}<div class="msg-text">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`;
  } else {
    div.innerHTML = `<div class="msg-text rich">${m.content ? renderRich(m.content) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
      <div class="msg-actions">
        <button data-act="copy">Copy</button>
        ${m.anchor ? '<button data-act="note">Save as note</button>' : ''}
      </div>`;
  }
  div.querySelector('.msg-quote')?.addEventListener('click', () => {
    const r = m.quote.rects?.[0];
    if (r) viewer.scrollToAnchor(r.p, r.y);
  });
  div.querySelector('[data-act=copy]')?.addEventListener('click', () => { navigator.clipboard?.writeText(m.content); toast('Copied'); });
  div.querySelector('[data-act=note]')?.addEventListener('click', () => {
    notes.add({ text: m.anchor.text, rects: m.anchor.rects }, { color: NOTE_COLOR, note: m.content });
    toast('Saved as a note beside the paper');
  });
  return div;
}

function renderChat() {
  if (!state.chat.length) {
    chatLog.innerHTML = `<div class="chat-empty">
      <p>Select text in the paper and choose <b>Ask AI</b>, or just type a question below.</p>
      <p class="muted">选中论文中的文字并点击 “Ask AI”，或直接在下方提问。</p>
      ${settings.claudeKey ? '' : '<p class="warn">Add your Claude API key in <b>Settings</b> to use the AI assistant.</p>'}</div>`;
    return;
  }
  chatLog.replaceChildren(...state.chat.map(messageEl));
  chatLog.scrollTop = chatLog.scrollHeight;
}

function apiMessages() {
  const msgs = [{ role: 'system', content: systemPrompt(settings, state.title) }];
  // keep the request small: the last 16 turns are plenty of memory for a reading session
  for (const m of state.chat.slice(-16)) {
    if (m.role === 'assistant') {
      if (m.content) msgs.push({ role: 'assistant', content: m.content });
      continue;
    }
    let content = m.content;
    if (m.quote) {
      const p = viewer.pages[(m.quote.rects?.[0]?.p || 1) - 1];
      const around = surroundingText(p?.text, m.quote.text);
      content = `Selected passage (page ${m.quote.rects?.[0]?.p ?? '?'}):\n"""${m.quote.text}"""\n\n`
        + (around ? `Surrounding text on that page, for context:\n"""${around}"""\n\n` : '')
        + `My question: ${m.content}`;
    }
    msgs.push({ role: 'user', content });
  }
  return msgs;
}

async function sendChat(text) {
  text = (text ?? chatInput.value).trim();
  if (!text && pendingQuote) text = 'Please explain this passage.';
  if (!text || chatAbort) return;
  if (!settings.claudeKey) {
    openSettings();
    toast('Please add your Claude API key first.');
    return;
  }
  const quote = pendingQuote;
  state.chat.push({ role: 'user', content: text, quote });
  const reply = { role: 'assistant', content: '', anchor: quote };
  state.chat.push(reply);
  pendingQuote = null;
  $('#quote-chip').hidden = true;
  chatInput.value = '';
  renderChat();
  const replyEl = chatLog.lastElementChild;
  const textEl = replyEl.querySelector('.msg-text');

  chatAbort = new AbortController();
  $('#chat-send').hidden = true;
  $('#chat-stop').hidden = false;
  let frame = 0;
  try {
    await chatStream({
      settings,
      messages: apiMessages(), // the empty assistant placeholder is skipped
      signal: chatAbort.signal,
      onDelta: (full) => {
        reply.content = full;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
          textEl.innerHTML = renderRich(reply.content);
          if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
        });
      },
    });
  } catch (e) {
    if (e.name !== 'AbortError') reply.content += `${reply.content ? '\n\n' : ''}**Error:** ${e.message}`;
  } finally {
    cancelAnimationFrame(frame);
    if (!reply.content) reply.content = '*(stopped)*';
    chatAbort = null;
    $('#chat-send').hidden = false;
    $('#chat-stop').hidden = true;
    replyEl.replaceWith(messageEl(reply, state.chat.length - 1));
    chatLog.scrollTop = chatLog.scrollHeight;
    persist();
  }
}

$('#chat-send').addEventListener('click', () => sendChat());
$('#chat-stop').addEventListener('click', () => chatAbort?.abort());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  }
});
$('#chat-clear').addEventListener('click', () => {
  if (!state.chat.length || !confirm('Clear the whole AI conversation for this paper?')) return;
  state.chat = [];
  renderChat();
  persist();
});

// ---------------------------------------------------------------- settings

const dlg = $('#settings-dlg');
function openSettings() {
  $('#set-key').value = settings.claudeKey;
  $('#set-model').replaceChildren(...CLAUDE_MODELS.map((m) => new Option(m.label, m.id)));
  $('#set-model').value = CLAUDE_MODELS.some((m) => m.id === settings.claudeModel) ? settings.claudeModel : DEFAULT_MODEL;
  $('#set-lang').value = settings.replyLang;
  $('#set-tr').value = settings.translateProvider;
  $('#set-target').value = settings.targetLang;
  dlg.showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings.claudeKey = $('#set-key').value.trim();
  settings.claudeModel = $('#set-model').value || DEFAULT_MODEL;
  settings.replyLang = $('#set-lang').value;
  settings.translateProvider = $('#set-tr').value;
  settings.targetLang = $('#set-target').value;
  saveSettings(settings);
  if (!state.chat.length) renderChat();
  toast('Settings saved');
});

// ---------------------------------------------------------------- export

const exDlg = $('#export-dlg');
$('#btn-export').addEventListener('click', () => {
  if (!state.bytes) { toast('Open a PDF first.'); return; }
  exDlg.showModal();
});
exDlg.addEventListener('close', async () => {
  if (exDlg.returnValue !== 'go') return;
  const options = { highlights: $('#ex-hl').checked, notes: $('#ex-notes').checked, chat: $('#ex-chat').checked };
  try {
    toast('Exporting…', 0);
    await exportPdf({
      bytes: state.bytes, annotations: state.annotations, chat: state.chat, fileName: state.fileName, options,
      onProgress: (m) => toast(`Exporting… ${m}`, 0),
    });
    toast('PDF downloaded ✓');
  } catch (e) {
    console.error(e);
    toast(`Export failed: ${e.message}`, 6000);
  }
});

const moreMenu = $('#more-menu');
$('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; });
document.addEventListener('click', (e) => { if (!moreMenu.contains(e.target)) moreMenu.hidden = true; });
moreMenu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  moreMenu.hidden = true;
  if (act === 'load-json') { $('#json-input').click(); return; }
  if (!state.bytes) { toast('Open a PDF first.'); return; }
  if (act === 'md') exportMarkdown({ annotations: state.annotations, chat: state.chat, fileName: state.fileName, title: state.title });
  if (act === 'save-json') {
    exportProject({ app: 'paper-reading-partner', version: 1, docKey: state.docKey, fileName: state.fileName, annotations: state.annotations, chat: state.chat });
  }
});
$('#json-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.annotations)) throw new Error('not a project file');
    if (!state.bytes) { toast('Open the matching PDF first, then load the project file.', 4000); return; }
    if (data.docKey && data.docKey !== state.docKey && !confirm('This project file was made for a different PDF. Load it anyway?')) return;
    state.annotations = data.annotations;
    state.chat = data.chat || [];
    notes.renderAll();
    renderChat();
    persist();
    toast('Project loaded');
  } catch (err) {
    toast(`Could not load: ${err.message}`, 4000);
  }
});

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') {
    hideMenus();
    trPop.hidden = true;
    moreMenu.hidden = true;
    return;
  }
  if ((e.ctrlKey || e.metaKey) && viewer.pdf && ['=', '+', '-', '0'].includes(e.key)) {
    e.preventDefault();
    if (e.key === '-') viewer.setScale(viewer.scale / 1.15);
    else if (e.key === '0') viewer.setScale(viewer.fitScale());
    else viewer.setScale(viewer.scale * 1.15);
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && settings.focus && viewer.pdf && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    hideMenus();
    viewer.step(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  const key = e.key.toLowerCase();
  if (/^[0-9]$/.test(key) && menu.hidden) {
    setFocusLines(key === '0' ? 10 : +key);
    toast(`Highlight ${settings.focusLines} line${settings.focusLines > 1 ? 's' : ''} · ${settings.focusLines} 行`, 1000);
    return;
  }
  if (key === 'f') { settings.focus = !settings.focus; saveSettings(settings); applyFocus(); return; }
  if (!menu.hidden && menuAnchor) {
    if (key === 't') doTranslate(menuAnchor);
    else if (key === 'a') askAbout(menuAnchor);
    else if (key === 'h') menuAnn ? hideMenus() : doHighlight(menuAnchor, COLORS[0]);
    else if (key === 'n') menuAnn ? (hideMenus(), notes.startEdit(menuAnn)) : doNote(menuAnchor);
  }
});

// ---------------------------------------------------------------- start

applyTheme();
applyFont();
applyFocus();
setSidebar(false);
setFocusLines(settings.focusLines || 1);
renderChat();
notes.renderList();

applyLibrary();
(async () => {
  await library.load();
  const lastDoc = await idbGet('lastDoc');
  if (lastDoc && library.get(lastDoc)) {
    if (!state.bytes) await openFromLibrary(lastDoc);
    return;
  }
  // papers opened before the library existed were kept under 'last'
  const legacy = await idbGet('last');
  if (legacy?.bytes && !state.bytes) {
    await openPdf(new Uint8Array(legacy.bytes), legacy.fileName);
    idbSet('last', null);
  }
})();
