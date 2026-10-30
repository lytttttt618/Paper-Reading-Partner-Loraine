import Anthropic from '@anthropic-ai/sdk';

// Claude (Anthropic API) streaming chat + translation helpers.

const LANG_RULE = {
  zh: 'Always answer in Simplified Chinese (简体中文). Keep important technical terms in English in parentheses the first time they appear.',
  both: 'Answer bilingually: write each paragraph in Simplified Chinese first, then the same content in English.',
  en: 'Answer in clear, simple English.',
};

export function systemPrompt(settings, paperTitle) {
  return [
    'You are Claude, a patient, precise reading partner who helps a Chinese graduate student read English research papers.',
    paperTitle ? `The paper being read is: "${paperTitle}".` : '',
    'Explain clearly, define jargon, and connect the passage to the rest of the paper when the provided context allows.',
    'Use Markdown. Write math in LaTeX using $...$ for inline and $$...$$ for display formulas.',
    LANG_RULE[settings.replyLang] || LANG_RULE.zh,
  ].filter(Boolean).join('\n');
}

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best explanations (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — most capable, most expensive' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

// Models that support server-side refusal fallbacks (Haiku has none).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

let client = null;
let clientKey = '';
function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    // The key lives only in this browser (Settings) and requests go straight to
    // Anthropic, so browser use is intended here.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    clientKey = apiKey;
  }
  return client;
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Claude rejected the API key (401). Check the key in Settings — it should start with "sk-ant-".');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error(`Your API key isn't allowed to do this (403): ${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return new Error(`Model not found (404). Pick another model in Settings. ${e.message}`);
  if (e instanceof Anthropic.RateLimitError) return new Error('Too many requests (429) — wait a moment and try again.');
  if (e instanceof Anthropic.BadRequestError) return new Error(`Request rejected (400): ${e.message}. If it mentions your credit balance, add credit at console.anthropic.com → Billing.`);
  if (e instanceof Anthropic.APIConnectionError) return new Error('Could not reach api.anthropic.com. Check your internet connection (or VPN).');
  if (e instanceof Anthropic.APIError) return new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
  return e;
}

/**
 * Stream a Claude reply. `messages` may start with a {role: 'system'} entry,
 * which becomes the system prompt. Calls onDelta(fullTextSoFar) as text arrives
 * and resolves with the full text.
 */
export async function chatStream({ settings, messages, onDelta, signal }) {
  if (!settings.claudeKey) {
    const err = new Error('No Claude API key set. Open Settings and paste your Anthropic API key.');
    err.code = 'NO_KEY';
    throw err;
  }
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  while (turns.length && turns[0].role !== 'user') turns.shift(); // the conversation must start with the user

  const model = settings.claudeModel || DEFAULT_MODEL;
  const params = { model, max_tokens: 64000, system, messages: turns };
  if (FALLBACK_MODELS.has(model)) {
    // if a safety classifier declines, Anthropic retries on its recommended fallback model
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let full = '';
  try {
    const stream = getClient(settings.claudeKey).beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        onDelta?.(full);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      full += `${full ? '\n\n' : ''}*Claude declined to answer this request${final.stop_details?.explanation ? `: ${final.stop_details.explanation}` : '.'}*`;
      onDelta?.(full);
    } else if (final.stop_reason === 'max_tokens') {
      full += '\n\n*(answer cut off — it reached the length limit)*';
      onDelta?.(full);
    }
    return full;
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || e?.name === 'AbortError') {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    throw friendlyError(e);
  }
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
    return { text: await aiTranslate(text, settings, context, onDelta, signal), source: 'Claude' };
  }
  try {
    const out = await googleTranslate(text, settings.targetLang || 'zh-CN');
    onDelta?.(out);
    return { text: out, source: 'Google' };
  } catch (e) {
    if (provider === 'auto' && settings.claudeKey) {
      return { text: await aiTranslate(text, settings, context, onDelta, signal), source: 'Claude' };
    }
    throw new Error(`${e.message}. Google Translate may be unreachable from your network — add a Claude API key in Settings and choose Claude translation.`);
  }
}
