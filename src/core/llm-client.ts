// =============================================================================
// LLM client — single dispatch point for anthropic / openai / ollama
// =============================================================================
//
// Three modules use this dispatcher to avoid inlining provider-switch +
// fetch + response shape extraction:
//   - failure-analyzer.ts
//   - auto-tagger.ts
//   - consolidator.ts
//
// (query-expander.ts was a fourth caller until it was retired from the
// recall hot path — Mode A FTS5-only (95.60% R@5 measured through
// recallEnhanced; the 95.40% quoted historically came from the
// benchmark's own reimplementation) won the UX axis
// against a ~30× latency penalty. dreamer.ts and llm-validator.ts also
// call into LLM providers but currently use their own paths.)
//
// Each call site keeps its own prompt construction, output parser, and
// safety wrapper (deliberate-design from the F7 prompt-safety work — output
// validators must stay co-located with their prompts). Only the HTTP
// machinery moves here.
//
// Per-call-site differences worth preserving:
//   - max_tokens varies: 200 (auto-tagger),
//                        300 (failure-analyzer),
//                        500 (consolidator)
//   - model defaults vary by provider
//   - error formatting is provider-specific (Anthropic vs OpenAI vs Ollama)
//
// CROSS-PROVIDER FAILOVER
// ───────────────────────
// `callLLM` walks the primary provider plus an ordered `fallbacks` chain
// and returns the first success. Continues on auth / network / upstream
// errors; STOPS on a 400-class "bad request" because the prompt itself
// is broken and a different provider won't fix it. Each attempt is
// surfaced via `opts.onAttempt(attempt)` so callers can persist
// telemetry without coupling this module to the storage layer. Designed
// to honour the maintainer's "I added gemma4 as fallback, why didn't
// it kick in?" intent: a dead Anthropic key now auto-falls-through to
// Ollama if configured under `llmFallbacks`.

import type { LLMConfig } from './config.js';
import type { AnthropicResponse, OpenAIResponse, OllamaResponse } from './types.js';
import { redactSecrets } from './paths.js';

export type LLMErrorClass =
  | 'auth'         // 401 / 403 — credential rejected; another provider may help
  | 'rate_limit'   // 429 — provider-specific quota; another provider may help
  | 'upstream'     // 5xx / 503 — provider outage; another provider may help
  | 'bad_request'  // 4xx (not 401/403/429) — prompt itself is broken; do NOT retry
  | 'network'      // DNS / connection / timeout — another provider may help
  | 'parse'        // 2xx body did not match expected shape — provider drift; another provider may help
  | 'unknown';     // unclassified — conservatively retried

/**
 * Thrown when a 2xx provider response cannot be coerced into the
 * expected shape (e.g. provider drift, HTML error page returned as
 * 200, JSON whose top-level field renamed). Classified as 'parse' so
 * the failover chain advances instead of treating an empty string as
 * a successful no-op.
 */
export class LLMResponseParseError extends Error {
  constructor(provider: LLMConfig['provider'], detail: string) {
    super(`${provider}: response parse failed — ${detail}`);
    this.name = 'LLMResponseParseError';
  }
}

export interface LLMAttempt {
  provider: LLMConfig['provider'];
  model?: string;
  status: 'ok' | 'fail';
  /** Wall time of the attempt in ms. */
  latencyMs: number;
  /** Defined when status='fail'. */
  errorClass?: LLMErrorClass;
  /** Defined when status='fail'. Provider error string with key/secret patterns redacted. */
  errorMessage?: string;
  /** Index in the chain (0 = primary). */
  index: number;
}

export interface CallLLMOptions {
  /** Per-call-site max-output budget. Defaults to 200. */
  maxTokens?: number;
  /**
   * Ordered fallback chain. Tried in order if `config` (the primary)
   * fails with auth / rate_limit / upstream / network / unknown errors.
   * Empty / undefined preserves the original single-provider semantics.
   */
  fallbacks?: LLMConfig[];
  /**
   * Telemetry hook fired exactly once per call, after either success
   * or chain-exhaustion failure. Receives every attempt in order so
   * callers can persist a complete trace (which providers were tried,
   * which succeeded, error classes for the failures). Errors thrown
   * by this callback are swallowed — telemetry must not crash the call.
   */
  onAttempt?: (attempts: LLMAttempt[]) => void;
}

/**
 * Send a single prompt to the configured LLM provider and return the
 * response as a plain string. Each call site is responsible for parsing
 * the string into its own structured shape (JSON array, object, etc).
 *
 * Provider-specific defaults:
 *   - anthropic: model=claude-haiku-4-5, requires apiKey from config or
 *                ANTHROPIC_API_KEY env
 *   - openai:    model=gpt-4o-mini, requires apiKey from config or
 *                OPENAI_API_KEY env
 *   - ollama:    model=llama3.2, host from OLLAMA_HOST env or localhost
 *
 * If `opts.fallbacks` is set, walks the primary + fallback chain and
 * returns the first successful response. Throws the LAST error if every
 * provider in the chain fails.
 *
 * Returns empty string for unknown provider (caller should treat as no-op).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  opts: CallLLMOptions = {},
): Promise<string> {
  const chain: LLMConfig[] = [config, ...(opts.fallbacks ?? [])];
  const attempts: LLMAttempt[] = [];
  const reportAttempts = () => {
    if (!opts.onAttempt) return;
    try { opts.onAttempt(attempts); } catch { /* telemetry must not crash the call */ }
  };

  let lastErr: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    const cfg = chain[i];
    const t0 = Date.now();
    try {
      const text = await callSingle(prompt, cfg, opts.maxTokens ?? 200);
      attempts.push({
        provider: cfg.provider, model: cfg.model,
        status: 'ok', latencyMs: Date.now() - t0, index: i,
      });
      reportAttempts();
      return text;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const klass = classifyError(e);
      attempts.push({
        provider: cfg.provider, model: cfg.model,
        status: 'fail', latencyMs: Date.now() - t0,
        errorClass: klass, errorMessage: redactSecrets(e.message), index: i,
      });
      lastErr = e;
      // Don't burn through fallbacks for a malformed prompt — that's
      // a caller bug, not a provider outage.
      if (klass === 'bad_request') break;
    }
  }

  reportAttempts();
  throw lastErr ?? new Error('callLLM: no providers configured');
}

/**
 * How long one provider request may take before it is abandoned.
 *
 * The three `fetch` calls below had no timeout at all. `embedder.ts` fixed
 * this on its own path and wrote down what it measured: a provider that
 * accepts the connection and never answers hangs the caller indefinitely.
 * Here the callers are the Stop hook's failure analysis (a 10-second budget
 * before the harness kills it), `memesh dream run`, and the HTTP server's
 * dream route — a hang in the last one holds a connection open forever on a
 * single-threaded event loop.
 *
 * 30s matches the embedder, deliberately: two different ceilings for the same
 * provider on the same machine would be a number nobody could explain.
 * Retries and backoff are NOT copied here — `callLLM` above already owns
 * failover across providers, and adding a second retry layer underneath it
 * would multiply the wait the hook budget cannot afford.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a deadline.
 *
 * `AbortSignal.timeout` rather than a hand-rolled `setTimeout` + controller:
 * it needs no cleanup, cannot leak a timer when the request wins the race,
 * and rejects with a `TimeoutError` that `classifyError` already reads as
 * `network` — the class that lets failover try the next provider.
 */
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** One provider, one HTTP call. Throws on non-2xx. */
async function callSingle(
  prompt: string,
  config: LLMConfig,
  maxTokens: number,
): Promise<string> {
  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic: no API key configured');
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || 'claude-haiku-4-5',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await readJsonOrThrow(res, 'anthropic');
    const text = extractAnthropicText(data);
    if (text == null) {
      throw new LLMResponseParseError('anthropic', `missing content[0].text in ${describeShape(data)}`);
    }
    return text;
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI: no API key configured');
    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await readJsonOrThrow(res, 'openai');
    const text = extractOpenAIText(data);
    if (text == null) {
      throw new LLMResponseParseError('openai', `missing choices[0].message.content in ${describeShape(data)}`);
    }
    return text;
  }

  if (config.provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const res = await fetchWithTimeout(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model || 'llama3.2',
        prompt,
        stream: false,
        // Ollama doesn't expose max_tokens directly; max-output budget is
        // controlled by the model itself or num_predict in raw-mode. The
        // helper accepts maxTokens for parity with cloud providers but
        // doesn't forward it — silently dropped to match prior behavior.
      }),
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await readJsonOrThrow(res, 'ollama');
    const text = extractOllamaText(data);
    if (text == null) {
      throw new LLMResponseParseError('ollama', `missing response field in ${describeShape(data)}`);
    }
    return text;
  }

  // An unrecognised provider used to `return ''`, and the failover loop above
  // treats a returned string as success. So `memesh config set llm.apiKey ...`
  // without `llm.provider` — a plausible thing to type — left every LLM-backed
  // feature doing nothing while reporting that it had run: `dream patterns`
  // counted a call that never happened, auto-tagging quietly produced no tags,
  // and `doctor` said PASS. Same shape as `?? true`: no failure signal is not
  // success. Throwing lets the failover loop move on to a fallback that IS
  // configured, and surfaces the real reason when none is.
  throw new Error(
    `No LLM provider configured (llm.provider is ${config.provider === undefined ? 'unset' : `"${String(config.provider)}"`}). ` +
    'Set one with `memesh config set llm.provider <anthropic|openai|ollama>`.',
  );
}

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------
//
// Earlier these were `res.json() as XxxResponse` casts, and the
// extraction site fell back to `|| ''`. Result: a provider returning
// an HTML error page with content-type: application/json, or a 2xx
// body whose top-level field renamed, silently produced an empty
// string that the failover loop treated as success — the fallback
// chain never engaged. The validators below convert shape drift into
// a thrown LLMResponseParseError so classifyError() routes it through
// the 'parse' decision class and the chain advances normally.
//
// Empty *string* (provider replied with content: "") is still treated
// as a successful call — that's distinct from missing-field drift and
// matches the prior `|| ''` semantics for callers that handle empty
// output (failure-analyzer's "nothing structured to extract" path).

async function readJsonOrThrow(res: Response, provider: LLMConfig['provider']): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LLMResponseParseError(provider, `body is not valid JSON (${msg})`);
  }
}

function extractAnthropicText(data: unknown): string | null {
  if (!isObject(data)) return null;
  const content = (data as AnthropicResponse).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isObject(first)) return null;
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

function extractOpenAIText(data: unknown): string | null {
  if (!isObject(data)) return null;
  const choices = (data as OpenAIResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isObject(first)) return null;
  const message = (first as { message?: unknown }).message;
  if (!isObject(message)) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

function extractOllamaText(data: unknown): string | null {
  if (!isObject(data)) return null;
  const response = (data as OllamaResponse).response;
  return typeof response === 'string' ? response : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Cheap shape summary for the LLMResponseParseError message. Reports
 * only the structural type and a count — never the actual key names —
 * so custom or self-hosted providers (e.g. Ollama on a private endpoint
 * with non-standard internal fields) cannot leak field identifiers into
 * error messages that may later land in telemetry, logs, or user-facing
 * output.
 */
function describeShape(v: unknown): string {
  if (v == null) return String(v);
  if (Array.isArray(v)) return `array(len=${v.length})`;
  if (typeof v !== 'object') return typeof v;
  const keyCount = Object.keys(v as Record<string, unknown>).length;
  return `object(${keyCount}-keys)`;
}

/**
 * Map an error message to one of the failover decision classes. The
 * error messages thrown by `callSingle` follow the pattern
 * `<Provider> <error category>: <status>` so the regex-on-message
 * approach is sufficient and avoids needing each provider branch to
 * structure its own error type.
 */
export function classifyError(e: Error): LLMErrorClass {
  // Response shape drift — the prompt + creds were fine, the provider
  // body just didn't match what we expected. Try the next provider.
  if (e instanceof LLMResponseParseError) return 'parse';
  const msg = e.message;
  // Auth — credential rejected
  if (/\b(401|403|invalid_api_key|authentication|x-api-key|unauthorized)\b/i.test(msg)) return 'auth';
  // No API key configured at all — same decision as auth (try the next provider)
  if (/no API key/i.test(msg)) return 'auth';
  // Quota / rate
  if (/\b(429|rate.?limit|quota)\b/i.test(msg)) return 'rate_limit';
  // Provider outage
  if (/\b(50[023]|service unavailable|bad gateway)\b/i.test(msg)) return 'upstream';
  // Bad prompt — DO NOT retry on a different provider, it'll have the
  // same problem.
  if (/\b400\b/.test(msg)) return 'bad_request';
  // Network — DNS, connect, abort
  if (/(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|aborted)/i.test(msg)) return 'network';
  return 'unknown';
}

// Error messages are redacted with the canonical redactSecrets from
// core/paths.ts before landing in telemetry: provider error bodies sometimes
// echo the supplied key (OpenAI does; Anthropic does not). A private copy
// used to live here covering only sk-/Bearer shapes — same name, a fraction
// of the strength — which is exactly how a future caller picks the wrong one.
