// =============================================================================
// LLM Validator — verify API keys and discover live model lists
// =============================================================================
//
// Probes each provider's models endpoint to:
//   1) confirm the supplied apiKey is accepted (key validation)
//   2) return the up-to-date model catalog so the dashboard can let
//      the user pick from real choices instead of stale hardcoded names
//
// Used by POST /v1/config/test in the HTTP server. Pure async functions,
// no DB / no transport coupling. Never persists secrets.

export interface ModelInfo {
  id: string;
  /** Optional creation/release timestamp from the provider, ISO-8601 if known. */
  created?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  models?: ModelInfo[];
  /** Recommended default — the smallest/cheapest model suitable for short prompts. */
  suggested?: string;
}

const FETCH_TIMEOUT_MS = 8000;
/** Cap upstream-body bytes we'll buffer + parse. Provider error bodies are tiny;
 *  this guards against a hostile/buggy upstream returning multi-MB responses. */
const MAX_BODY_BYTES = 8192;
/** Cap the error string we surface to the dashboard. */
const MAX_ERROR_CHARS = 300;

/** Sanitize a string before surfacing it in our own API: cap length, strip
 *  control chars (DEL + C0 except whitespace) so that a malformed/hostile
 *  upstream can't smuggle escape sequences into client logs or copy-paste. */
function safeErrorString(s: string): string {
  // Intentional control-character class: stripping C0 control chars and
  // DEL is the whole point of this sanitiser, so the no-control-regex
  // warning is exactly what the rule was meant to flag — and exactly
  // what we don't want to silence project-wide.
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, MAX_ERROR_CHARS);
}

/** Try to extract a human-readable message from an Anthropic/OpenAI error body. */
function extractProviderError(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    // Anthropic: { error: { type, message } }
    // OpenAI: { error: { message, type, code } }
    const msg = j?.error?.message;
    const type = j?.error?.type;
    if (msg) return safeErrorString(type ? `${msg} (${type})` : msg);
  } catch {
    // not JSON — fall through to generic
  }
  if (status === 401) return 'Authentication failed — the API key was rejected.';
  if (status === 403) return 'Forbidden — the key may lack permission for this endpoint.';
  if (status === 429) return 'Rate limited or quota exhausted.';
  if (status >= 500) return `Provider returned ${status} (server-side error).`;
  return `HTTP ${status}`;
}

/** Read response body with a hard byte cap so a hostile/buggy upstream can't
 *  force us to buffer a multi-MB response. Returns the (possibly truncated)
 *  body as a UTF-8 string. */
async function readBodyCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text().catch(() => '');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    // If we hit the cap, abort the rest of the stream.
    if (total >= MAX_BODY_BYTES) await reader.cancel().catch(() => {});
  } catch {
    // Network drop mid-read — return what we have.
  }
  const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let off = 0;
  for (const c of chunks) {
    const room = merged.byteLength - off;
    if (room <= 0) break;
    merged.set(c.subarray(0, Math.min(c.byteLength, room)), off);
    off += Math.min(c.byteLength, room);
  }
  return new TextDecoder().decode(merged);
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await readBodyCapped(res).catch(() => '');
      throw new Error(extractProviderError(res.status, body));
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pick the best "small / fast / cheap" model from a list. Used as the
 * recall-and-failure-analysis default — small prompts, no need for the
 * flagship. Heuristic, not perfect; user can override.
 */
export function pickSuggestedModel(models: ModelInfo[]): string | undefined {
  if (models.length === 0) return undefined;
  // Provider-agnostic name patterns that historically map to the small tier.
  const SMALL_HINTS = ['mini', 'nano', 'haiku', 'flash', 'lite', 'small', '8b', '7b', '3b'];
  const candidates = models.filter((m) =>
    SMALL_HINTS.some((h) => m.id.toLowerCase().includes(h)),
  );
  const pool = candidates.length > 0 ? candidates : models;
  // Prefer the most recent (highest "created" if present, else last in list)
  const sorted = [...pool].sort((a, b) => {
    if (a.created && b.created) return b.created.localeCompare(a.created);
    return 0;
  });
  return sorted[0].id;
}

export async function probeAnthropic(apiKey: string): Promise<ValidationResult> {
  if (!apiKey) return { valid: false, error: 'API key is empty' };
  try {
    const data = await fetchJson<{ data: Array<{ id: string; created_at?: string }> }>(
      'https://api.anthropic.com/v1/models?limit=200',
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
    );
    const models: ModelInfo[] = (data.data ?? []).map((m) => ({
      id: m.id,
      created: m.created_at,
    }));
    // A 200 whose body carries no models is NOT a verified LLM — it is what a
    // corporate proxy, an auth-portal interstitial, or a truncated body looks
    // like. The Ollama probe below has always rejected the empty list; these
    // two probes defaulted it to `[]` and answered `valid: true`, which made
    // "answered with nothing" indistinguishable from "verified working" in
    // both `memesh doctor --probe` and the dashboard connection test.
    if (models.length === 0) {
      return { valid: false, error: 'Anthropic answered, but returned no models — a proxy or gateway may be intercepting the request. Check the endpoint and API key.' };
    }
    return { valid: true, models, suggested: pickSuggestedModel(models) };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeOpenAI(apiKey: string): Promise<ValidationResult> {
  if (!apiKey) return { valid: false, error: 'API key is empty' };
  try {
    const data = await fetchJson<{ data: Array<{ id: string; created?: number }> }>(
      'https://api.openai.com/v1/models',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    // OpenAI returns chat + embedding + audio etc. Filter to chat-capable models
    // by excluding obvious non-chat families. We err toward "show more" rather
    // than "hide possibly-good models" — the user can still pick anything.
    const NON_CHAT_PREFIXES = ['whisper', 'tts-', 'dall-e', 'davinci-codex', 'text-embedding', 'text-similarity', 'omni-moderation'];
    const models: ModelInfo[] = (data.data ?? [])
      .filter((m) => !NON_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
      .map((m) => ({
        id: m.id,
        created: m.created ? new Date(m.created * 1000).toISOString() : undefined,
      }));
    // Same rule as the Anthropic and Ollama probes: zero models back is not a
    // verified provider, whatever the status code said.
    if (models.length === 0) {
      return { valid: false, error: 'OpenAI answered, but returned no chat-capable models — a proxy or gateway may be intercepting the request. Check the endpoint and API key.' };
    }
    return { valid: true, models, suggested: pickSuggestedModel(models) };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Allowed Ollama hostnames. Caller-supplied `host` is restricted to these to
 * prevent the server from being used as an SSRF probe against arbitrary
 * internal addresses. Operators who genuinely run Ollama on a non-loopback
 * host should set the `OLLAMA_HOST` environment variable on the server side
 * — that path is privileged (operator-controlled), not user-supplied.
 */
const OLLAMA_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isSafeOllamaHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return OLLAMA_LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function probeOllama(host?: string): Promise<ValidationResult> {
  // Operator-set env wins; otherwise fall back to caller-supplied host (vetted)
  // or the default loopback URL. Caller-supplied non-loopback URLs are rejected.
  const envBase = process.env.OLLAMA_HOST;
  const requestedBase = host || envBase || 'http://localhost:11434';
  if (!envBase && host && !isSafeOllamaHost(host)) {
    return {
      valid: false,
      error: `Ollama host must be loopback (localhost / 127.0.0.1). For non-local Ollama, set the OLLAMA_HOST environment variable on the server.`,
    };
  }
  const base = requestedBase;
  try {
    const data = await fetchJson<{ models: Array<{ name: string; modified_at?: string }> }>(
      `${base.replace(/\/$/, '')}/api/tags`,
      { method: 'GET' },
    );
    const models: ModelInfo[] = (data.models ?? []).map((m) => ({
      id: m.name,
      created: m.modified_at,
    }));
    if (models.length === 0) {
      return {
        valid: false,
        error: `Ollama is reachable at ${base} but has no models installed. Run \`ollama pull <model>\` first.`,
      };
    }
    return { valid: true, models, suggested: pickSuggestedModel(models) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return { valid: false, error: `Ollama not reachable at ${base}. Is it installed and running?` };
    }
    return { valid: false, error: msg };
  }
}

export async function probeProvider(
  provider: 'anthropic' | 'openai' | 'ollama',
  apiKey?: string,
  host?: string,
): Promise<ValidationResult> {
  if (provider === 'anthropic') return probeAnthropic(apiKey ?? '');
  if (provider === 'openai') return probeOpenAI(apiKey ?? '');
  if (provider === 'ollama') return probeOllama(host);
  return { valid: false, error: `Unknown provider: ${provider}` };
}
