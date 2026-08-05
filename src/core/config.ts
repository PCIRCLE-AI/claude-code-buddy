import fs from 'fs';
import path from 'path';
import { memeshDir } from './paths.js';

// --- Config Types ---

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
}

/**
 * Embedding provider config — DELIBERATELY separate from LLMConfig.
 *
 * Earlier memesh tied embedder.provider to llm.provider, so switching
 * LLM (e.g. anthropic → ollama) silently changed the embedder backend
 * and its dimension, which triggered db.ts to drop and rebuild
 * entities_vec, invalidating thousands of vectors. #36 split the two
 * concerns: pick whichever LLM you want for chat completion, and pin
 * embeddings to whatever backend you chose for them.
 *
 * Semantic (meaning-based) recall needs a real embedder — `ollama`
 * (local, e.g. nomic-embed-text 768-dim) or `openai` (hosted,
 * text-embedding-3-small 1536-dim). When none is configured, memesh
 * runs on FTS5 keyword search alone (the `tfidf` capability sentinel);
 * that is a supported mode, not a fault, and needs no download.
 *
 * `apiKey` is read from the corresponding LLMConfig if provider
 * matches (e.g. embedder.provider='openai' uses llm.apiKey when
 * llm.provider='openai'). Sharing the key avoids duplicating
 * secrets between two config nodes.
 */
export interface EmbedderConfig {
  provider: 'openai' | 'ollama';
  model?: string;
}

export interface MeMeshConfig {
  llm?: LLMConfig;
  /**
   * Ordered fallback chain. When the primary `llm` provider fails with
   * an auth, network, or upstream error, callLLM walks this list in
   * order and uses the first provider that succeeds. A 400-class
   * "bad request" error is NOT retried (the prompt itself is broken,
   * a second provider won't fix it).
   *
   * Telemetry on each attempt is reported via `opts.onAttempt` if the
   * caller passes one — see `llm-client.ts`.
   *
   * Common pattern: cloud primary (Anthropic) with local-Ollama fallback
   * for offline / outage / rotated-key resilience. The user explicitly
   * said: "Anthropic key 死了我前幾天不是也加了gemma4, 為啥沒接手？
   * it's the fallback plan" — this field is what wires that intent.
   */
  llmFallbacks?: LLMConfig[];
  /**
   * When omitted, embeddings are keyword-only (FTS5) unless a legacy
   * `llm.provider` of openai/ollama implies one (back-compat). Existing
   * installs stay on whatever provider their entities_vec was last built
   * with — see db.ts `getEmbeddingDimension`.
   */
  embedder?: EmbedderConfig;
  autoCapture?: boolean;     // default: true. Env override: MEMESH_AUTO_CAPTURE=false disables.
  sessionLimit?: number;     // default: 10. Env override: MEMESH_SESSION_LIMIT.
  /**
   * Opt-in switch for the experimental agentic-orchestration protocol's
   * active surfaces (session-start banner, Bash nudge, verify_agent_work
   * telemetry). Default: false. Env override: MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1.
   */
  enableAgenticOrchestration?: boolean;
  /**
   * Auto-update policy applied by the session-start hook.
   *   'off' (default) — never auto-update; manual `memesh update` only.
   *      A deprecation override may still trigger a single patch upgrade
   *      when the installed version has been flagged by maintainers.
   *   'patch' — auto-apply X.Y.Z -> X.Y.Z+N
   *   'minor' — auto-apply patch + X.Y.Z -> X.Y+1.0
   *   'major' — auto-apply any bump
   * Env override: MEMESH_AUTO_UPDATE.
   */
  autoUpdate?: 'off' | 'patch' | 'minor' | 'major';
  /**
   * Output language for LLM-generated user-visible prose (dreamer digests,
   * emergent patterns, lessons, digest-validator reasons). Free-form value —
   * a locale code ('zh-TW') or a language name ('繁體中文') both work, since
   * it is interpolated into the prompt as an instruction, not parsed.
   *
   * Unset = no instruction is added and the model answers in English (the
   * prompts themselves are English). This is the server-side counterpart of
   * the dashboard's client-side locale (localStorage): the dashboard setting
   * translates the UI chrome, this one decides what language the LLM writes
   * *content* in. They are deliberately separate keys because the server
   * cannot read a browser's localStorage.
   *
   * Machine-facing identifiers (entity type slugs, tags, category enums,
   * JSON keys) stay English regardless — see output-language.ts.
   */
  language?: string;
  /**
   * Opt-in switch for scheduled mining of Claude Code session transcripts into
   * memory proposals. Default: false. memesh has no daemon, so enabling this
   * does NOT run anything on its own — it AUTHORISES `memesh dream run
   * --from-transcripts --if-due`, which a user cron/launchd entry fires.
   * `--if-due` no-ops unless this is true AND the min-interval has elapsed since
   * the last mined run, so a scheduled entry is harmless while the switch is off.
   * Env override: MEMESH_TRANSCRIPT_MINING=1/true enables, =0/false disables.
   */
  transcriptMining?: boolean;
  setupCompleted?: boolean;
}

export interface Capabilities {
  fts5: true;
  vectorSearch: true;
  scoring: true;
  knowledgeEvolution: true;
  embeddings: 'ollama' | 'anthropic' | 'openai' | 'tfidf';
  llm: LLMConfig | null;
  /**
   * Ordered cross-provider fallback chain — empty unless the user has
   * configured `llmFallbacks` in their config.json. Surfaced here so
   * any callsite that already reads `caps.llm` can also pick up the
   * fallback chain in the same call without a second readConfig().
   */
  llmFallbacks: LLMConfig[];
  searchLevel: 0 | 1;
}

// --- Config File Path ---
//
// Resolved lazily via `memeshDir()` so HOME-first override (used by hermetic
// Windows tests that point HOME at a tmpdir) takes effect on every read /
// write — the previous module-load-time constants captured the pre-test
// HOME value, defeating isolation. See src/core/paths.ts for the precedence
// rules (MEMESH_DIR > <home>/.memesh).
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function configDir(): string {
  return memeshDir();
}

function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

// --- Read/Write ---

// Dedup key for the corrupt-config warning. readConfig() runs on a hot path
// (every hook invocation, every HTTP request), so a genuinely corrupt file
// must trace ONCE per (path, error) rather than flood stderr on every call.
let lastConfigReadWarning: string | null = null;

/**
 * Why a config read produced the settings it did.
 *
 * `absent` and `unreadable` both yield `{}`, but they are not the same fact
 * and callers that act destructively must be able to tell them apart. "No
 * config" means the user is in Core Mode. "Could not read the config" means
 * we do not know what the user configured — and treating unknown as
 * "defaults" is what let a truncated write drop a BYOK user's entire vector
 * index (see `resolveEmbeddingDimension`).
 */
export type ConfigReadState = 'ok' | 'absent' | 'unreadable';

export interface ConfigReadResult {
  config: MeMeshConfig;
  state: ConfigReadState;
}

/**
 * Read the config, reporting WHY the result is what it is.
 *
 * `readConfig()` is the convenience wrapper for the many callers that only
 * need the settings and are fine with `{}`. Anything that deletes data must
 * use this instead and refuse to act on `unreadable`.
 */
export function readConfigResult(): ConfigReadResult {
  const p = configFilePath();
  // A missing file is the normal Core-Mode state, not an error.
  if (!fs.existsSync(p)) return { config: {}, state: 'absent' };
  try {
    return { config: JSON.parse(fs.readFileSync(p, 'utf8')), state: 'ok' };
  } catch (err) {
    // The file EXISTS but could not be read or parsed: corrupt JSON, a bad
    // permission bit, a truncated write. Returning {} disables every
    // Smart-Mode feature; the state field is what stops it ALSO being read as
    // "this user wants the 384-dim default".
    const msg = err instanceof Error ? err.message : String(err);
    const key = `${p}::${msg}`;
    if (key !== lastConfigReadWarning) {
      lastConfigReadWarning = key;
      try {
        process.stderr.write(
          `[memesh config] ${p} exists but could not be read/parsed (${msg}). ` +
            `Every setting in it — LLM provider, fallbacks, embedder — is being ignored, ` +
            `so Smart Mode is off until this is fixed.\n`,
        );
      } catch { /* stderr must never throw the caller */ }
    }
    return { config: {}, state: 'unreadable' };
  }
}

export function readConfig(): MeMeshConfig {
  return readConfigResult().config;
}

export function writeConfig(config: MeMeshConfig): void {
  const dir = configDir();
  const p = configFilePath();
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only.
  }
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: PRIVATE_FILE_MODE });
  try {
    fs.chmodSync(p, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

/**
 * Thrown when a read-modify-write is asked to run on a config that could not be
 * read. Callers surface it; they must not fall back to `{}`.
 */
export class ConfigUnreadableError extends Error {
  constructor(p: string) {
    super(
      `Refusing to modify ${p}: the existing config could not be read, so saving ` +
        `would silently delete every setting already in it. Fix or remove the file, then retry.`
    );
    this.name = 'ConfigUnreadableError';
  }
}

export function updateConfig(
  partial: Omit<Partial<MeMeshConfig>, 'llm'> & { llm?: LLMConfig | null },
): MeMeshConfig {
  // Read-modify-write, so it must use the tri-state read. `readConfig()`
  // collapses "no config" and "config could not be read" into `{}`, and this
  // function then WRITES that `{}` back merged with one field — silently
  // deleting every other setting the file held.
  //
  // That is not a cosmetic loss. `embedder.provider` is what pins the vector
  // dimension: drop it and the next `openDatabase()` resolves 384 with
  // `confident: true`, disagrees with the stored 1536, and DROPs entities_vec.
  // So a BYOK user with a momentarily corrupt config who runs `memesh config
  // set` — or clicks Save in the dashboard — loses every embedding, through the
  // front door, past the guard added to prevent exactly that.
  const { config: existing, state } = readConfigResult();
  if (state === 'unreadable') throw new ConfigUnreadableError(configFilePath());
  // F17: explicit null on `llm` removes the provider entirely (Core Mode).
  // Used by the dashboard "Remove provider" action to drop apiKey + provider
  // + model so memesh falls back to either env-var auto-detect or no LLM.
  // Build the new config explicitly so the Partial<...> & null union doesn't
  // leak into the MeMeshConfig output type.
  const { llm: partialLlm, ...partialRest } = partial;
  const config: MeMeshConfig = { ...existing, ...partialRest };
  if (partialLlm === null) {
    delete config.llm;
  } else if (partialLlm && existing.llm) {
    // Deep-merge llm object to preserve apiKey when only provider/model change
    config.llm = { ...existing.llm, ...partialLlm };
  } else if (partialLlm) {
    config.llm = partialLlm;
  }
  writeConfig(config);
  return config;
}

// --- API Key Masking ---

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

// --- Capability Detection ---

/**
 * Detect a candidate LLM config from environment variables.
 *
 * Priority: remote (anthropic > openai) > local (ollama). Rationale: when a
 * user has supplied a remote API key, they have implicitly opted in to a
 * higher-quality, lower-latency LLM. Local ollama is the fallback for the
 * "fully offline" install, used only when no remote credential is present.
 *
 * Auto-detection is now safe by default (no opt-in env var required). The
 * pre-4.1.0 ship-blocker — fresh-install OPENAI_API_KEY in env locking the
 * entities_vec table to 1536-dim and silently corrupting vector writes — was
 * fixed in #36, which decoupled embedder from LLM provider. An env-detected
 * LLM never selects an embedder: without an explicit `embedder.provider`
 * (or a legacy `llm.provider` in config.json), embeddings stay keyword-only
 * (FTS5), so detecting a remote LLM no longer cascades into a dimension lock.
 *
 * Explicit `cfg.llm` in config.json still takes precedence (see
 * `detectCapabilities`) — env auto-detect only fires when the user has not
 * set a provider in their config.
 */
/**
 * Is env auto-detect switched off by the user?
 *
 * History: auto-detect used to be OPT-IN behind `MEMESH_AUTO_DETECT_LLM=1`,
 * because an auto-detected `OPENAI_API_KEY` locked embeddings to 1536-dim
 * and broke vector writes. #36 fixed that properly by decoupling the
 * embedder from the LLM provider, and F17 then removed the gate — correctly,
 * since its reason for existing was gone.
 *
 * But the flag was carrying a SECOND promise that nobody re-homed: the
 * README told users "without this flag set, an OPENAI_API_KEY lying around
 * in your shell is ignored". After F17 that became false — a stray key in
 * the shell is silently used for every LLM write flow (consolidation,
 * failure analysis, auto-tagging, dream), which costs the user money and
 * sends their memory content to a provider they never chose here.
 *
 * Re-adding the opt-in would undo F17's deliberate decision and silently
 * turn Smart Mode off for everyone relying on env detection today. So the
 * flag becomes an explicit OPT-OUT instead: auto-detect stays the default,
 * and anyone who does not want their shell key spent can say so.
 */
function envAutoDetectDisabled(): boolean {
  const raw = process.env.MEMESH_AUTO_DETECT_LLM;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function detectFromEnv(): LLMConfig | null {
  if (envAutoDetectDisabled()) return null;
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.OLLAMA_HOST) {
    return { provider: 'ollama', model: 'llama3.2' };
  }
  return null;
}

export function detectCapabilities(config?: MeMeshConfig): Capabilities {
  const cfg = config ?? readConfig();

  // F17: LLM and embedder are detected independently to prevent the
  // pre-4.1.0 ship-blocker where env-detected OPENAI_API_KEY locked
  // entities_vec to 1536-dim and broke vector writes on fresh installs.
  //   - LLM: cfg.llm > env auto-detect (anthropic > openai > ollama)
  //   - Embedder: cfg.embedder > legacy back-compat from cfg.llm > keyword-only (tfidf)
  // Critically, embedder back-compat ONLY consults cfg.llm (explicit user
  // choice), never env-detected LLM. So a user who has OPENAI_API_KEY in
  // their shell gets openai LLM features but keeps keyword-only embeddings
  // unless they explicitly write embedder.provider=openai to their config.
  const llm = cfg.llm ?? detectFromEnv() ?? null;
  const embeddings = detectEmbeddingSource(cfg.llm ?? null, cfg.embedder);

  return {
    fts5: true,
    vectorSearch: true,
    scoring: true,
    knowledgeEvolution: true,
    embeddings,
    llm,
    llmFallbacks: cfg.llmFallbacks ?? [],
    searchLevel: llm ? 1 : 0,
  };
}

/**
 * Determine the actual embedding source.
 *
 * Priority order:
 *   1. config.embedder.provider — explicit user choice (added in #36)
 *   2. legacy fallback derived from llm.provider — only when embedder
 *      isn't set, preserves backward compat with pre-#36 configs that
 *      had no embedder field.
 *   3. keyword-only (tfidf) — no neural embedder; FTS5 alone.
 *
 * A legacy `embedder.provider: "onnx"` (the local model memesh shipped
 * before it standardised on ollama) is treated as keyword-only. That
 * degrades gracefully rather than erroring, and — because keyword-only
 * resolves to the same 384-dim default an old ONNX table was built at
 * (see getEmbeddingDimension) — it does NOT drop that user's existing
 * vector index. The vectors simply stop being read/written until the
 * user configures ollama or an openai embedder and reindexes.
 *
 * Existing installs with `llm.provider=ollama` and NO embedder field
 * still resolve to ollama embeddings (back-compat); fresh writes with
 * an explicit `embedder.provider` win unconditionally.
 */
function detectEmbeddingSource(llm: LLMConfig | null, embedder?: EmbedderConfig): Capabilities['embeddings'] {
  const provider = embedder?.provider as string | undefined;
  // An embedder field that is PRESENT decides the answer on its own — it must
  // NEVER fall through to the llm back-compat below. Falling through is a
  // data-loss path: a legacy `onnx`, a typo (`Onnx`, `olama`), an empty or
  // whitespace-only string, or any removed provider would otherwise inherit the
  // llm's dimension (e.g. 768 for ollama) and disagree with a table built at
  // another width, which makes db.ts DROP every embedding. Anything not exactly
  // openai/ollama resolves to keyword-only (tfidf), whose 384-dim default keeps
  // a legacy 384 table intact. An empty/whitespace value is treated as an
  // explicit-but-invalid embedder, NOT as "unset" — only a genuinely absent
  // field (undefined) reaches the llm back-compat.
  if (provider !== undefined && provider !== null) {
    if (provider === 'openai' || provider === 'ollama') return provider;
    return 'tfidf';
  }
  // No embedder field: back-compat for pre-#36 configs derives it from llm.
  if (llm?.provider === 'openai') return 'openai';
  if (llm?.provider === 'ollama') return 'ollama';
  // No embedder and no legacy openai/ollama LLM: keyword-only (FTS5).
  return 'tfidf';
}

// --- Embedding Dimensions ---

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  openai: 1536,    // text-embedding-3-small
  ollama: 768,     // nomic-embed-text (default)
};

/**
 * The vector width to declare `entities_vec` at when no neural embedder is
 * selected (keyword-only / tfidf, and the removed local ONNX embedder mapped
 * onto it). It is deliberately 384 — the width the old default ONNX table was
 * built at — so a keyword-only resolution does NOT disagree with a legacy
 * 384-dim table and trigger db.ts to drop it. The table simply sits unused
 * until a real embedder is configured and the index is rebuilt.
 */
const KEYWORD_ONLY_DIMENSION = 384;

/**
 * Get the current embedding vector dimension based on configured provider.
 * Used by db.ts to create/migrate the entities_vec table.
 */
export function getEmbeddingDimension(config?: MeMeshConfig): number {
  const cfg = config ?? readConfig();
  // F17: only consult cfg.llm (explicit) for embedder back-compat — never
  // env-detected LLM. This keeps entities_vec dimension stable across
  // shell envs that have OPENAI_API_KEY set for unrelated tools.
  const source = detectEmbeddingSource(cfg.llm ?? null, cfg.embedder);
  return EMBEDDING_DIMENSIONS[source] ?? KEYWORD_ONLY_DIMENSION;
}

/**
 * Whether scheduled transcript mining is authorised.
 * Precedence: env > config > default(false) — mirrors the agentic-orchestration
 * switch. Only `1/true/yes/on` (env) or `transcriptMining: true` (config) turns
 * it on; anything else, including an unparseable env value, is off. This gates
 * `dream run --from-transcripts --if-due`, so "off" must be the safe default —
 * a scheduled entry pointed at a disabled install does nothing.
 */
export function isTranscriptMiningEnabled(config?: MeMeshConfig): boolean {
  const env = process.env.MEMESH_TRANSCRIPT_MINING;
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === '') return false;
    // Unrecognised env value: ignore it and fall through to the config field,
    // rather than guessing — an "on" guess would run an LLM job nobody asked for.
  }
  const cfg = config ?? readConfig();
  return cfg.transcriptMining === true;
}

/**
 * The embedding dimension, plus whether we actually know it.
 *
 * `getEmbeddingDimension()` cannot distinguish "the user configured nothing,
 * so 384" from "the config could not be read, so 384". `openDatabase()` acts
 * on that number by DROPping `entities_vec` when it disagrees with the stored
 * dimension, so the two cases are worlds apart: a BYOK user on OpenAI's
 * 1536-dim embeddings loses every vector in the database — unrecoverable, no
 * backup, no prompt — because a config file was momentarily unreadable.
 * Regenerating them means re-running the whole embedding pipeline and, for an
 * API provider, paying for it again.
 *
 * `confident` is false only for `unreadable`. An absent config is a real
 * answer: it means Core Mode, and 384 is genuinely the right dimension.
 *
 * `configured` reports whether a config file was actually found and parsed, and
 * exists because "absent" is only a real answer when the config we are looking
 * at is the one that belongs to this database. It is not always:
 * `configDir()` follows `MEMESH_DIR`/HOME while `getDbPath()` follows
 * `MEMESH_DB_PATH`, and those resolve independently. A process opening a BYOK
 * user's database under a different HOME — an HTTP server started from
 * launchd/systemd, `sudo memesh doctor`, a script using an isolated HOME with
 * MEMESH_DB_PATH pointed at the real file — reads "no config", concludes a
 * confident 384, disagrees with the stored 1536, and drops every vector.
 * `ensureVecTable` uses this to prefer the dimension the DATABASE records over
 * an absence read from somewhere else on disk.
 */
export function resolveEmbeddingDimension(): {
  dimension: number;
  confident: boolean;
  configured: boolean;
} {
  const { config, state } = readConfigResult();
  return {
    dimension: getEmbeddingDimension(config),
    confident: state !== 'unreadable',
    configured: state === 'ok',
  };
}

// --- Startup Capability Logging ---

/**
 * Log detected capabilities to stderr on server startup.
 * Uses stderr so it doesn't interfere with MCP stdio transport.
 */
export function logCapabilities(config?: MeMeshConfig): void {
  const caps = detectCapabilities(config);
  process.stderr.write(`MeMesh: Level ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})\n`);
  if (caps.llm) {
    process.stderr.write(`MeMesh: LLM: ${caps.llm.provider} (${caps.llm.model ?? 'default'})\n`);
  }
  // State the SEMANTIC-search capability explicitly, separately from the chat
  // LLM. `searchLevel` above is driven by the LLM only, so before this line a
  // user with no embedder saw nothing telling them meaning-based search was off
  // — a silent capability downgrade. openai/ollama are the only providers that
  // yield vectors; every other state (keyword-only tfidf, anthropic) is FTS5.
  if (caps.embeddings === 'openai' || caps.embeddings === 'ollama') {
    process.stderr.write(`MeMesh: Semantic (meaning-based) search: ON (${caps.embeddings}).\n`);
  } else {
    process.stderr.write(
      `MeMesh: Semantic (meaning-based) search: OFF — keyword search only. ` +
      `Configure ollama or an embedder to enable it.\n`
    );
  }
}

// --- Config Path Exports (for testing) ---

export function getConfigDir(): string { return configDir(); }
export function getConfigPath(): string { return configFilePath(); }
