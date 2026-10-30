// Tiny persistence helpers: settings in localStorage, documents in IndexedDB.

const SETTINGS_KEY = 'prp:settings';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  replyLang: 'zh',
  translateProvider: 'auto',
  targetLang: 'zh-CN',
  theme: 'day',
  fontSize: 15,
  focus: true,
  focusLines: 1,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable: settings last for this visit only */ }
}

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('paper-reading-partner', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function idbGet(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function idbSet(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); } catch (e) { console.warn('save failed', e); }
}
