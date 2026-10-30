// ChatGPT (OpenAI-compatible) streaming chat + translation helpers.

const LANG_RULE = {
  zh: 'Always answer in Simplified Chinese (简体中文). Keep important technical terms in English in parentheses the first time they appear.',
  both: 'Answer bilingually: write each paragraph in Simplified Chinese first, then the same content in English.',
  en: 'Answer in clear, simple English.',
};

export function systemPrompt(settings, paperTitle) {
  return [
    'You are a patient, precise reading partner who helps a Chinese graduate student read English research papers.',
    paperTitle ? `The paper being read is: "${paperTitle}".` : '',
    'Explain clearly, define jargon, and connect the passage to the rest of the paper when the provided context allows.',
    'Use Markdown. Write math in LaTeX using $...$ for inline and $$...$$ for display formulas.',
    LANG_RULE[settings.replyLang] || LANG_RULE.zh,
  ].filter(Boolean).join('\n');
}

/** Stream a chat completion. Calls onDelta(fullTextSoFar) as tokens arrive and resolves with the full text. */
export async function chatStream({ settings, messages, onDelta, signal }) {
  if (!settings.apiKey) {
    const err = new Error('No API key set. Open Settings and paste your OpenAI API key.');
    err.code = 'NO_KEY';
    throw err;
  }
  const base = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model || 'gpt-4o-mini', messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error?.message || msg; } catch { /* keep raw text */ }
    throw new Error(`API error ${res.status}: ${msg}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(full);
        }
      } catch { /* ignore keep-alive / partial lines */ }
    }
  }
  return full;
}

const TARGET_NAME = { 'zh-CN': 'Simplified Chinese (简体中文)', 'zh-TW': 'Traditional Chinese (繁體中文)', en: 'English' };

async function googleTranslate(text, target) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate error ${res.status}`);
  const j = await res.json();
  const translation = (j[0] || []).map((x) => x?.[0] || '').join('');
  const dict = (j[1] || []).map((e) => `- *${e[0]}*: ${(e[1] || []).slice(0, 6).join('，')}`);
  return dict.length ? `${translation}\n\n${dict.join('\n')}` : translation;
}

function aiTranslate(text, settings, context, onDelta, signal) {
  const target = TARGET_NAME[settings.targetLang] || TARGET_NAME['zh-CN'];
  const isWord = text.split(/\s+/).length <= 3;
  const ask = isWord
    ? `Translate the term "${text}" into ${target}. Give: the translation that fits the context, IPA pronunciation, part of speech, and one short note on how it is used in this sentence. Be brief.`
    : `Translate the following passage from a research paper into ${target}. Output only the translation, faithful and fluent. Keep math in LaTeX ($...$).\n\n${text}`;
  const messages = [
    { role: 'system', content: 'You are a professional academic translator. Use Markdown; write math in LaTeX with $...$.' },
    { role: 'user', content: context && isWord ? `Context: """${context}"""\n\n${ask}` : ask },
  ];
  return chatStream({ settings, messages, onDelta, signal });
}

/** Translate text. Returns { text, source } and streams partial output through onDelta when using AI. */
export async function translate(text, settings, { context, onDelta, signal } = {}) {
  const provider = settings.translateProvider;
  if (provider === 'ai') {
    return { text: await aiTranslate(text, settings, context, onDelta, signal), source: 'ChatGPT' };
  }
  try {
    const out = await googleTranslate(text, settings.targetLang || 'zh-CN');
    onDelta?.(out);
    return { text: out, source: 'Google' };
  } catch (e) {
    if (provider === 'auto' && settings.apiKey) {
      return { text: await aiTranslate(text, settings, context, onDelta, signal), source: 'ChatGPT' };
    }
    throw new Error(`${e.message}. Google Translate may be unreachable from your network — add an API key in Settings and choose ChatGPT translation.`);
  }
}
