import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
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
 * (ONNX 384-dim → nomic-embed-text 768-dim). The dimension change
 * triggered db.ts to drop and rebuild entities_vec, invalidating
 * thousands of vectors. #36 split the two concerns: pick whichever
 * LLM you want for chat completion, embeddings stay on whatever
 * backend you chose for them (default: ONNX local 384-dim).
 *
 * `apiKey` is read from the corresponding LLMConfig if provider
 * matches (e.g. embedder.provider='openai' uses llm.apiKey when
 * llm.provider='openai'). Sharing the key avoids duplicating
 * secrets between two config nodes.
 */
export interface EmbedderConfig {
  provider: 'onnx' | 'openai' | 'ollama';
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
   * Defaults to ONNX 384-dim if omitted. Existing installs that have
   * never set this field stay on whatever provider their entities_vec
   * was last built with — see db.ts `getEmbeddingDimension`.
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
  setupCompleted?: boolean;
}

export interface Capabilities {
  fts5: true;
  vectorSearch: true;
  scoring: true;
  knowledgeEvolution: true;
  embeddings: 'onnx' | 'ollama' | 'anthropic' | 'openai' | 'tfidf';
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

export function updateConfig(
  partial: Omit<Partial<MeMeshConfig>, 'llm'> & { llm?: LLMConfig | null },
): MeMeshConfig {
  const existing = readConfig();
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
 * fixed in #36, which decoupled embedder from LLM provider. The embedder now
 * defaults to ONNX (384-dim, local) regardless of what LLM is detected, so
 * detecting a remote LLM no longer cascades into a dimension lock.
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
  //   - Embedder: cfg.embedder > legacy back-compat from cfg.llm > onnx
  // Critically, embedder back-compat ONLY consults cfg.llm (explicit user
  // choice), never env-detected LLM. So a user who has OPENAI_API_KEY in
  // their shell gets openai LLM features but keeps onnx embeddings unless
  // they explicitly write embedder.provider=openai to their config.
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
 *   3. ONNX local fallback when @huggingface/transformers is installed.
 *   4. tfidf last-resort.
 *
 * #36 changed default from "follow LLM provider" to "pin to ONNX".
 * Reason: switching LLM (e.g. anthropic → ollama) used to silently
 * invalidate every stored vector when the embedder dim changed.
 * Existing installs with `llm.provider=ollama` and NO embedder field
 * still resolve to ollama embeddings (back-compat); fresh writes with
 * an explicit `embedder.provider` win unconditionally.
 */
function detectEmbeddingSource(llm: LLMConfig | null, embedder?: EmbedderConfig): Capabilities['embeddings'] {
  if (embedder?.provider) return embedder.provider;
  // Back-compat for pre-#36 configs (no embedder field).
  if (llm?.provider === 'openai') return 'openai';
  if (llm?.provider === 'ollama') return 'ollama';
  // No LLM and Anthropic both use local ONNX when available.
  try {
    const require = createRequire(import.meta.url);
    require.resolve('@huggingface/transformers');
    return 'onnx';
  } catch {
    return 'tfidf';
  }
}

// --- Embedding Dimensions ---

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  openai: 1536,    // text-embedding-3-small
  ollama: 768,     // nomic-embed-text (default)
  onnx: 384,       // all-MiniLM-L6-v2
};

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
  return EMBEDDING_DIMENSIONS[source] ?? 384;
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
 */
export function resolveEmbeddingDimension(): { dimension: number; confident: boolean } {
  const { config, state } = readConfigResult();
  return {
    dimension: getEmbeddingDimension(config),
    confident: state !== 'unreadable',
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
}

// --- Config Path Exports (for testing) ---

export function getConfigDir(): string { return configDir(); }
export function getConfigPath(): string { return configFilePath(); }
