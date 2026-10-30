# Paper Reading Partner · 论文阅读伙伴

A focused PDF reader for research papers, built for non-native English readers who want to keep their place and keep going.

## Features

| | |
|---|---|
| **Line focus · 聚焦** | The line under your mouse is outlined and the rest of the paper is greyed out, so you can always find your place. Two-column papers are handled column by column. **Click** the paper (or press **F**) to switch between focus mode and normal reading. Use **↑ / ↓** to move the focus one line at a time, in reading order across columns and pages. |
| **Translate · 翻译** | Double-click a word (or select a sentence or paragraph) and choose **Translate**. Single words also show dictionary meanings. Uses Google Translate for free, or ChatGPT for context-aware translation. |
| **Ask AI · 问 AI** | Select text and choose **Ask AI**. The AI side bar slides out with the explanation, and you can keep asking follow-up questions there. Hide it with **✕**, and bring it back with the **AI · 助手** button. The AI sees the selected passage plus the surrounding text on that page. |
| **Highlight · 高亮** | Five highlight colours. Click a highlight to recolour it, add a note, or delete it. |
| **Notes · 笔记** | Notes appear right beside the paragraph they belong to. They support **Markdown + LaTeX** (`$\alpha$`, `$$\sum_i x_i$$`) with a live preview. |
| **Reading comfort** | The page is centred on screen with your notes beside it. Zoom (buttons, Ctrl +/−, Ctrl + mouse wheel, Fit), adjustable text size for notes and AI answers, and **Day / Eye-care (护眼) / Night (夜间)** modes. |
| **Export · 导出** | Download a standard PDF with real highlight annotations, your notes rendered in a margin next to each page, and the AI conversation as an appendix. It opens in Acrobat, Preview, Edge, Chrome, Zotero and other PDF apps. You can also export notes as Markdown (for Obsidian or Typora) or save a project file to continue later. |
| **Auto-save** | Highlights, notes and chats are saved in your browser per paper. Re-opening the same PDF restores everything. |

## Getting started

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run dev
```

Then open the address it prints (usually http://localhost:5173) and click **Open PDF**, or drag a PDF onto the page.

To build a static version that you can host anywhere (for example GitHub Pages):

```bash
npm run build      # output in dist/
npm run preview    # try the built version locally
```

This repository includes a GitHub Actions workflow that publishes the app to GitHub Pages. To turn it on, go to **Settings → Pages** and set **Source** to **GitHub Actions**.

## Using ChatGPT

Open **Settings** and paste an OpenAI API key (https://platform.openai.com/api-keys). You can also set:

- **Model** — defaults to `gpt-4o-mini`; any chat model name your account supports works.
- **API base URL** — any OpenAI-compatible endpoint, which is useful if `api.openai.com` isn't reachable from your network.
- **Answer language** — Chinese, bilingual, or English.
- **Translate with** — Google (free), ChatGPT, or Auto (Google first, then ChatGPT if Google is unreachable).

Your key is stored only in your browser's local storage and is sent only to the API address you configure.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Click on the paper / `F` | Toggle line focus |
| `↑` / `↓` | Move the focused line up / down |
| `T` / `A` / `H` / `N` | With the selection menu open: Translate / Ask AI / Highlight / Note |
| `Ctrl` `+` / `Ctrl` `−` / `Ctrl` `0` | Zoom in / out / fit width |
| `Ctrl` `Enter` | Save the note you're editing |
| `Enter` / `Shift` `Enter` | Send the chat message / start a new line |
| `Esc` | Close menus and pop-ups |

## Tech

Vite with plain JavaScript. It uses [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, [pdf-lib](https://pdf-lib.js.org) for export, [KaTeX](https://katex.org) and [marked](https://marked.js.org) for notes, and [html2canvas](https://html2canvas.hertzen.com) to render notes into the exported PDF. Everything runs in the browser; there's no server.

```
src/
  main.js         app wiring: toolbar, selection menu, translation, chat, settings, export
  viewer.js       PDF rendering, lazy loading, zoom, line detection and the focus band
  annotations.js  highlights, margin notes, notes list
  export.js       annotated-PDF / Markdown / project export
  ai.js           ChatGPT streaming and translation
  rich.js         Markdown + LaTeX rendering
  storage.js      settings (localStorage) and per-paper data (IndexedDB)
```

## Limitations

- Scanned PDFs (images without a text layer) can't be selected or line-focused.
- On rotated pages, exported notes go to the appendix instead of the margin, and highlights on those pages aren't exported.
