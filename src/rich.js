// Markdown + LaTeX rendering for notes, AI answers and translations.
import katex from 'katex';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render Markdown with $inline$, $$display$$, \( \) and \[ \] math to safe HTML. */
export function renderRich(src = '') {
  const maths = [];
  const text = String(src).replace(MATH_RE, (m, a, b, c, d) => {
    const tex = a ?? b ?? c ?? d;
    const displayMode = a != null || b != null;
    let html;
    try {
      html = katex.renderToString(tex.trim(), { displayMode, throwOnError: false, output: 'html' });
    } catch {
      html = `<code>${escapeHtml(m)}</code>`;
    }
    maths.push(html);
    return `KATEXPH${maths.length - 1}ENDPH`;
  });
  const html = DOMPurify.sanitize(marked.parse(text));
  return html.replace(/KATEXPH(\d+)ENDPH/g, (_, i) => maths[+i]);
}
