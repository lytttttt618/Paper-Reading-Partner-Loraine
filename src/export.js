// Export: original PDF + highlight annotations + rendered notes in a widened
// right margin + the AI conversation as appendix pages. Also Markdown / JSON.
import { PDFDocument, PDFName, PDFHexString, rgb } from 'pdf-lib';
import html2canvas from 'html2canvas';
import { renderRich, escapeHtml } from './rich.js';

const MARGIN_W = 230; // pt added to the right of pages that carry notes
const CARD_W = 206; // pt
const CSS_W = 320; // px width the note card is laid out at before rasterising

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Lay out HTML offscreen and rasterise it to a PNG. */
async function rasterise(html, widthPx, extraClass = '') {
  const host = document.createElement('div');
  host.className = `export-sheet rich ${extraClass}`;
  host.style.width = `${widthPx}px`;
  host.innerHTML = html;
  document.body.append(host);
  try {
    await document.fonts?.ready;
    const canvas = await html2canvas(host, { scale: 2, backgroundColor: '#ffffff', logging: false });
    return canvas;
  } finally {
    host.remove();
  }
}

async function embedCanvas(pdf, canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return pdf.embedPng(await blob.arrayBuffer());
}

function noteHtml(a) {
  return `<div class="ex-note" style="--c:${a.color}">
    <div class="ex-quote">p.${a.rects[0].p} · “${escapeHtml(a.text.slice(0, 140))}${a.text.length > 140 ? '…' : ''}”</div>
    <div>${renderRich(a.note || '')}</div></div>`;
}

function addHighlight(pdf, page, a, box) {
  const { x: ox, y: oy, width: W, height: H } = box;
  const rects = a.rects.filter((r) => r.p === page.num).map((r) => ({
    l: ox + r.x * W, r: ox + (r.x + r.w) * W, t: oy + (1 - r.y) * H, b: oy + (1 - r.y - r.h) * H,
  }));
  if (!rects.length) return;
  const [cr, cg, cb] = hexToRgb(a.color);
  const bbox = [
    Math.min(...rects.map((r) => r.l)), Math.min(...rects.map((r) => r.b)),
    Math.max(...rects.map((r) => r.r)), Math.max(...rects.map((r) => r.t)),
  ];
  const ctx = pdf.context;
  // An explicit appearance stream makes the highlight show up in every viewer.
  const ops = [`/GS0 gs ${cr.toFixed(3)} ${cg.toFixed(3)} ${cb.toFixed(3)} rg`]
    .concat(rects.map((r) => `${r.l.toFixed(2)} ${r.b.toFixed(2)} ${(r.r - r.l).toFixed(2)} ${(r.t - r.b).toFixed(2)} re f`))
    .join('\n');
  const ap = ctx.register(ctx.stream(ops, {
    Type: 'XObject', Subtype: 'Form', BBox: bbox,
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: 0.45, CA: 0.45 } } },
  }));
  const dict = ctx.obj({
    Type: 'Annot', Subtype: 'Highlight', Rect: bbox, F: 4,
    QuadPoints: rects.flatMap((r) => [r.l, r.t, r.r, r.t, r.l, r.b, r.r, r.b]),
    C: [cr, cg, cb], CA: 0.45,
    AP: { N: ap },
  });
  dict.set(PDFName.of('T'), PDFHexString.fromText('Paper Reading Partner'));
  dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ? `${a.note}` : a.text));
  page.page.node.addAnnot(ctx.register(dict));
}

/** Pack rasterised blocks onto new A4 pages, splitting blocks taller than a page. */
async function appendBlocks(pdf, title, canvases) {
  const PW = 595.28, PH = 841.89, M = 42;
  const contentW = PW - 2 * M;
  let page = null;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    y = PH - M;
  };
  const headerCanvas = await rasterise(`<h2>${escapeHtml(title)}</h2>`, 640);
  const blocks = [headerCanvas, ...canvases];
  newPage();
  for (const c of blocks) {
    const ptPerPx = contentW / c.width;
    let srcY = 0;
    while (srcY < c.height) {
      const room = y - M;
      const remainingPt = (c.height - srcY) * ptPerPx;
      if (remainingPt > room && room < 120) { newPage(); continue; }
      const takePx = Math.min(c.height - srcY, Math.floor(room / ptPerPx));
      const slice = document.createElement('canvas');
      slice.width = c.width;
      slice.height = takePx;
      slice.getContext('2d').drawImage(c, 0, srcY, c.width, takePx, 0, 0, c.width, takePx);
      const img = await embedCanvas(pdf, slice);
      const h = takePx * ptPerPx;
      page.drawImage(img, { x: M, y: y - h, width: contentW, height: h });
      y -= h + 10;
      srcY += takePx;
      if (srcY < c.height) newPage();
    }
  }
}

export async function exportPdf({ bytes, annotations, chat, fileName, options, onProgress }) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  const overflow = [];

  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`Page ${i + 1} / ${pages.length}`);
    const page = pages[i];
    const num = i + 1;
    const box = page.getCropBox();
    const rotated = page.getRotation().angle % 360 !== 0;
    const mine = annotations.filter((a) => a.rects.some((r) => r.p === num));

    if (options.highlights && !rotated) {
      for (const a of mine) addHighlight(pdf, { page, num }, a, box);
    }

    const notes = annotations
      .filter((a) => a.note && a.rects[0].p === num)
      .sort((a, b) => a.rects[0].y - b.rects[0].y);
    if (!options.notes || !notes.length) continue;
    if (rotated) { overflow.push(...notes); continue; }

    // Widen the page and draw the note cards in the new right margin.
    const { x: ox, y: oy, width: W, height: H } = box;
    const mediaBox = page.getMediaBox();
    page.setMediaBox(mediaBox.x, mediaBox.y, Math.max(mediaBox.width, ox + W + MARGIN_W - mediaBox.x), mediaBox.height);
    page.setCropBox(ox, oy, W + MARGIN_W, H);
    page.drawRectangle({ x: ox + W, y: oy, width: MARGIN_W, height: H, color: rgb(0.975, 0.975, 0.98) });
    page.drawLine({ start: { x: ox + W, y: oy }, end: { x: ox + W, y: oy + H }, thickness: 0.6, color: rgb(0.85, 0.86, 0.88) });

    let nextTop = oy + H - 12; // PDF y grows upward
    for (const a of notes) {
      const canvas = await rasterise(noteHtml(a), CSS_W, 'ex-card');
      const img = await embedCanvas(pdf, canvas);
      const h = canvas.height * (CARD_W / canvas.width);
      const anchorY = oy + (1 - a.rects[0].y) * H;
      const top = Math.min(anchorY + 6, nextTop);
      if (top - h < oy + 8) { overflow.push(a); continue; }
      const x = ox + W + (MARGIN_W - CARD_W) / 2;
      page.drawImage(img, { x, y: top - h, width: CARD_W, height: h });
      const r0 = a.rects[0];
      const [cr, cg, cb] = hexToRgb(a.color);
      page.drawLine({
        start: { x: ox + W, y: oy + (1 - r0.y - r0.h / 2) * H },
        end: { x, y: top - 8 },
        thickness: 0.7, color: rgb(cr * 0.75, cg * 0.75, cb * 0.75), opacity: 0.7,
      });
      nextTop = top - h - 8;
    }
  }

  if (options.notes && overflow.length) {
    onProgress?.('Notes appendix');
    const canvases = [];
    for (const a of overflow) canvases.push(await rasterise(noteHtml(a), 640, 'ex-card'));
    await appendBlocks(pdf, 'Notes (continued)', canvases);
  }

  if (options.chat && chat.length) {
    onProgress?.('AI conversation');
    const canvases = [];
    for (const m of chat) {
      const who = m.role === 'user' ? 'You · 我' : 'AI assistant · AI 助手';
      const quote = m.quote ? `<blockquote>${escapeHtml(m.quote.text)}</blockquote>` : '';
      const body = m.role === 'user' ? `<p>${escapeHtml(m.content).replace(/\n/g, '<br>')}</p>` : renderRich(m.content);
      canvases.push(await rasterise(`<div class="ex-msg ${m.role}"><div class="ex-who">${who}</div>${quote}${body}</div>`, 640));
    }
    await appendBlocks(pdf, 'AI conversation · AI 对话记录', canvases);
  }

  pdf.setProducer('Paper Reading Partner');
  pdf.setModificationDate(new Date());
  onProgress?.('Saving…');
  const out = await pdf.save();
  download(new Blob([out], { type: 'application/pdf' }), `${baseName(fileName)}-annotated.pdf`);
}

export function exportMarkdown({ annotations, chat, fileName, title }) {
  const lines = [`# Reading notes — ${title || fileName}`, '', `*Exported ${new Date().toLocaleString()}*`, ''];
  const sorted = [...annotations].sort((a, b) => a.rects[0].p - b.rects[0].p || a.rects[0].y - b.rects[0].y);
  for (const a of sorted) {
    lines.push(`## Page ${a.rects[0].p}`, '', `> ${a.text}`, '');
    if (a.note) lines.push(a.note, '');
  }
  if (chat.length) {
    lines.push('---', '', '# AI conversation', '');
    for (const m of chat) {
      lines.push(`**${m.role === 'user' ? 'You' : 'AI'}:**`, '');
      if (m.quote) lines.push(`> ${m.quote.text}`, '');
      lines.push(m.content, '');
    }
  }
  download(new Blob([lines.join('\n')], { type: 'text/markdown' }), `${baseName(fileName)}-notes.md`);
}

export function exportProject(data) {
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${baseName(data.fileName)}-project.json`);
}

function baseName(name = 'paper') {
  return name.replace(/\.pdf$/i, '') || 'paper';
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
