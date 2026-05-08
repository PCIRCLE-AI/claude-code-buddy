import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

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
  theme?: 'light' | 'dark';
  setupCompleted?: boolean;
}

export interface Capabilities {
  fts5: true;
  vectorSearch: true;
  scoring: true;
  knowledgeEvolution: true;
  embeddings: 'onnx' | 'ollama' | 'anthropic' | 'openai' | 'tfidf';
  llm: LLMConfig | null;
  searchLevel: 0 | 1;
}

// --- Config File Path ---

const CONFIG_DIR = path.join(os.homedir(), '.memesh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// --- Read/Write ---

export function readConfig(): MeMeshConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config: MeMeshConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(CONFIG_DIR, PRIVATE_DIR_MODE);
  } catch {
    // Best-effort hardening only.
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: PRIVATE_FILE_MODE });
  try {
    fs.chmodSync(CONFIG_PATH, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort hardening only.
  }
}

export function updateConfig(partial: Partial<MeMeshConfig>): MeMeshConfig {
  const existing = readConfig();
  // Deep-merge llm object to preserve apiKey when only provider/model change
  const config = { ...existing, ...partial };
  if (partial.llm && existing.llm) {
    config.llm = { ...existing.llm, ...partial.llm };
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
 * IMPORTANT: this is now an opt-in helper. It is only consulted when the user
 * has explicitly enabled it via `MEMESH_AUTO_DETECT_LLM=1`. Without that
 * opt-in, the mere presence of `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`,
 * `OLLAMA_HOST`) in the user's shell does NOT cause memesh to commit to that
 * provider. Many users have those env vars set for other tools but want
 * memesh to default to its local-first behavior.
 *
 * This was a real ship-blocker: pre-4.1.0, having `OPENAI_API_KEY` in env on
 * a fresh install caused `detectCapabilities` to return `embeddings: 'openai'`
 * (1536-dim), which locked the entities_vec table to 1536, then on the first
 * `remember` call the embed-with-provider step would fail (invalid/expired
 * key, network, etc.), fall back to ONNX (384-dim), and emit a confusing
 * "dimension mismatch (got 384, expected 1536)" warning while silently
 * skipping the vector write. Fresh installs should "just work" with local
 * embeddings; cloud providers must be an explicit opt-in via
 * `memesh config set llm.provider <openai|anthropic|ollama>`.
 */
function detectFromEnv(): LLMConfig | null {
  if (process.env.MEMESH_AUTO_DETECT_LLM !== '1') return null;
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

  // Only treat an LLM provider as configured when the user has put it in the
  // config file explicitly (or opted into env-based auto-detection). This
  // keeps fresh installs deterministic: local FTS5 + onnx, no surprise
  // 1536-dim provider lock-in on the entities_vec schema.
  const llm = cfg.llm ?? detectFromEnv() ?? null;

  return {
    fts5: true,
    vectorSearch: true,
    scoring: true,
    knowledgeEvolution: true,
    embeddings: detectEmbeddingSource(llm, cfg.embedder),
    llm,
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
  // Same opt-in semantics as detectCapabilities — env-var auto-detection
  // only fires when MEMESH_AUTO_DETECT_LLM=1. Otherwise fresh installs
  // resolve to onnx (384-dim), keeping entities_vec consistent.
  const llm = cfg.llm ?? detectFromEnv() ?? null;
  const source = detectEmbeddingSource(llm, cfg.embedder);
  return EMBEDDING_DIMENSIONS[source] ?? 384;
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

export function getConfigDir(): string { return CONFIG_DIR; }
export function getConfigPath(): string { return CONFIG_PATH; }
