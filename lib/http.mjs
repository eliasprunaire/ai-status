import { HttpError, fail } from './errors.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const DEFAULTS = {
  json: { accept: 'application/json', timeoutMs: 15000 },
  text: { accept: 'text/html,application/json', timeoutMs: 20000 },
  bytes: { accept: 'application/json', timeoutMs: 15000 },
};
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CONFIGURED_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function secureUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw fail('policy', 'URL HTTP invalide', 'invalid HTTP URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw fail('policy', 'URL HTTP non sûre', 'unsafe HTTP URL');
  }
  return url;
}

function redirectOrigin(value) {
  const url = secureUrl(value);
  if (url.origin !== String(value).replace(/\/$/, '')) {
    throw fail('policy', 'origine de redirection invalide', 'invalid redirect origin');
  }
  return url.origin;
}

const tooLarge = (maxBytes) => fail('limit', `${maxBytes} octets maximum`, `${maxBytes} byte maximum`);

async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge(maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Client injecté dans chaque adaptateur : délai total, corps borné et redirections
// manuelles limitées aux origines explicitement prévues
// Contenu externe non fiable : on ne le traite jamais comme des instructions
// Une seule nouvelle tentative, dans le même délai total, sur 429, 5xx ou erreur réseau :
// les pages de statut renvoient des 503 isolés (OpenRouter, ~1 collecte sur 6 en CI)
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1500;
const RETRY_MAX_DELAY_MS = 5000;
const transient = (error) => (error instanceof HttpError && RETRY_STATUS.has(error.status))
  || (error instanceof TypeError && error.message === 'fetch failed');

export async function get(url, { as = 'json', accept, timeoutMs, maxBytes = DEFAULT_MAX_BYTES, redirectOrigins = [] } = {}) {
  const d = DEFAULTS[as] ?? DEFAULTS.json;
  const timeout = timeoutMs ?? d.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw fail('policy', 'délai HTTP invalide', 'invalid HTTP timeout');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CONFIGURED_BYTES) {
    throw fail('policy', 'borne HTTP invalide', 'invalid HTTP limit');
  }
  if (!Array.isArray(redirectOrigins)) throw fail('policy', 'origines de redirection invalides', 'invalid redirect origins');

  const start = secureUrl(url);
  const allowedOrigins = new Set([start.origin, ...redirectOrigins.map(redirectOrigin)]);
  const ctrl = new AbortController();
  const deadline = Date.now() + timeout;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const ensureDeadline = () => {
    if (Date.now() >= deadline) throw new DOMException('The operation was aborted', 'AbortError');
  };

  const attempt = async () => {
    let current = start;
    const seen = new Set();
    for (let redirects = 0; ; redirects += 1) {
      ensureDeadline();
      if (seen.has(current.href)) throw fail('policy', 'boucle de redirection', 'redirect loop');
      seen.add(current.href);

      const response = await fetch(current.href, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: accept ?? d.accept, 'Accept-Language': 'en-US,en;q=0.8' },
      });
      if (REDIRECT_STATUS.has(response.status)) {
        await response.body?.cancel();
        if (redirects >= MAX_REDIRECTS) throw fail('policy', 'trop de redirections', 'too many redirects');
        const location = response.headers.get('location');
        if (!location) throw fail('policy', 'redirection sans destination', 'redirect without location');
        const next = secureUrl(location, current);
        if (!allowedOrigins.has(next.origin)) throw fail('policy', 'origine HTTP non autorisée', 'unauthorized HTTP origin');
        current = next;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        const error = new HttpError(response.status, current.href);
        const header = response.headers.get('retry-after');
        const retryAfter = header === null || header.trim() === '' ? NaN : Number(header);
        if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1000;
        throw error;
      }
      const bytes = await readBody(response, maxBytes);
      ensureDeadline();
      if (as === 'bytes') return bytes;
      const text = new TextDecoder().decode(bytes);
      if (as === 'text') return text;
      // Une page HTML (challenge, erreur) n'est pas une panne réseau : schéma inattendu
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw fail('schema', `réponse non JSON (${response.headers.get('content-type') ?? 'type inconnu'}, ${current.href})`, `non-JSON response (${response.headers.get('content-type') ?? 'unknown type'}, ${current.href})`); }
      ensureDeadline();
      return parsed;
    }
  };

  try {
    try {
      return await attempt();
    } catch (error) {
      if (!transient(error)) throw error;
      const wait = Math.min(error.retryAfterMs ?? RETRY_DELAY_MS, RETRY_MAX_DELAY_MS);
      // Pas de nouvelle tentative si elle ne peut pas aboutir avant le délai total
      if (Date.now() + wait + 1000 >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return await attempt();
    }
  } finally {
    clearTimeout(timer);
  }
}

export const MISTRAL_PROBE_MODEL = 'ministral-3b-2512';

// Seule destination autorisée pour la clé de la sonde, jamais de redirection ni de retry
export async function mistralCompletion(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw fail('unavailable', 'Clé Mistral absente ou invalide', 'Missing or invalid Mistral key');
  const url = 'https://api.mistral.ai/v1/chat/completions';
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: MISTRAL_PROBE_MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, temperature: 0, stream: false }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, url);
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw fail('schema', 'Réponse Mistral non JSON', 'Non-JSON Mistral response');
    }
    const bytes = await readBody(response, 65536);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw fail('schema', 'Réponse Mistral illisible', 'Unreadable Mistral response'); }
  } catch (error) {
    if (error instanceof HttpError || ['schema', 'limit'].includes(error?.code)) throw error;
    if (['AbortError', 'TimeoutError'].includes(error?.name)) throw fail('timeout', 'Sonde Mistral', 'Mistral probe');
    throw fail('network', 'Sonde Mistral', 'Mistral probe');
  }
}
