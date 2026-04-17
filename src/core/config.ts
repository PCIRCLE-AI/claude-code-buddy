import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Config Types ---

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
}

export interface MeMeshConfig {
  llm?: LLMConfig;
  autoCapture?: boolean;     // default: true
  sessionLimit?: number;     // default: 10
  theme?: 'light' | 'dark';
  tips?: { smartModeHint?: 'shown' };
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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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

function detectFromEnv(): LLMConfig | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY };
  }
  return null;
}

function detectOllama(): LLMConfig | null {
  try {
    // Quick sync check — just see if the env var is set
    // Actual connectivity check would be async
    if (process.env.OLLAMA_HOST) {
      return { provider: 'ollama', model: 'llama3.2' };
    }
  } catch {}
  return null;
}

export function detectCapabilities(config?: MeMeshConfig): Capabilities {
  const cfg = config ?? readConfig();

  const llm = cfg.llm ?? detectFromEnv() ?? detectOllama() ?? null;

  return {
    fts5: true,
    vectorSearch: true,
    scoring: true,
    knowledgeEvolution: true,
    embeddings: llm?.provider ?? 'tfidf',
    llm,
    searchLevel: llm ? 1 : 0,
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

export function getConfigDir(): string { return CONFIG_DIR; }
export function getConfigPath(): string { return CONFIG_PATH; }
