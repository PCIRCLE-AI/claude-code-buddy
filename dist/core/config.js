import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { memeshDir } from './paths.js';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
function configDir() {
    return memeshDir();
}
function configFilePath() {
    return path.join(configDir(), 'config.json');
}
let lastConfigReadWarning = null;
export function readConfigResult() {
    const p = configFilePath();
    if (!fs.existsSync(p))
        return { config: {}, state: 'absent' };
    try {
        return { config: JSON.parse(fs.readFileSync(p, 'utf8')), state: 'ok' };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const key = `${p}::${msg}`;
        if (key !== lastConfigReadWarning) {
            lastConfigReadWarning = key;
            try {
                process.stderr.write(`[memesh config] ${p} exists but could not be read/parsed (${msg}). ` +
                    `Every setting in it — LLM provider, fallbacks, embedder — is being ignored, ` +
                    `so Smart Mode is off until this is fixed.\n`);
            }
            catch { }
        }
        return { config: {}, state: 'unreadable' };
    }
}
export function readConfig() {
    return readConfigResult().config;
}
export function writeConfig(config) {
    const dir = configDir();
    const p = configFilePath();
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
        fs.chmodSync(dir, PRIVATE_DIR_MODE);
    }
    catch {
    }
    fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: PRIVATE_FILE_MODE });
    try {
        fs.chmodSync(p, PRIVATE_FILE_MODE);
    }
    catch {
    }
}
export class ConfigUnreadableError extends Error {
    constructor(p) {
        super(`Refusing to modify ${p}: the existing config could not be read, so saving ` +
            `would silently delete every setting already in it. Fix or remove the file, then retry.`);
        this.name = 'ConfigUnreadableError';
    }
}
export function updateConfig(partial) {
    const { config: existing, state } = readConfigResult();
    if (state === 'unreadable')
        throw new ConfigUnreadableError(configFilePath());
    const { llm: partialLlm, ...partialRest } = partial;
    const config = { ...existing, ...partialRest };
    if (partialLlm === null) {
        delete config.llm;
    }
    else if (partialLlm && existing.llm) {
        config.llm = { ...existing.llm, ...partialLlm };
    }
    else if (partialLlm) {
        config.llm = partialLlm;
    }
    writeConfig(config);
    return config;
}
export function maskApiKey(key) {
    if (key.length <= 8)
        return '***';
    return key.slice(0, 4) + '***' + key.slice(-4);
}
function envAutoDetectDisabled() {
    const raw = process.env.MEMESH_AUTO_DETECT_LLM;
    if (raw === undefined)
        return false;
    const v = raw.trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'no' || v === 'off';
}
function detectFromEnv() {
    if (envAutoDetectDisabled())
        return null;
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
export function detectCapabilities(config) {
    const cfg = config ?? readConfig();
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
function detectEmbeddingSource(llm, embedder) {
    if (embedder?.provider)
        return embedder.provider;
    if (llm?.provider === 'openai')
        return 'openai';
    if (llm?.provider === 'ollama')
        return 'ollama';
    try {
        const require = createRequire(import.meta.url);
        require.resolve('@huggingface/transformers');
        return 'onnx';
    }
    catch {
        return 'tfidf';
    }
}
const EMBEDDING_DIMENSIONS = {
    openai: 1536,
    ollama: 768,
    onnx: 384,
};
export function getEmbeddingDimension(config) {
    const cfg = config ?? readConfig();
    const source = detectEmbeddingSource(cfg.llm ?? null, cfg.embedder);
    return EMBEDDING_DIMENSIONS[source] ?? 384;
}
export function resolveEmbeddingDimension() {
    const { config, state } = readConfigResult();
    return {
        dimension: getEmbeddingDimension(config),
        confident: state !== 'unreadable',
        configured: state === 'ok',
    };
}
export function logCapabilities(config) {
    const caps = detectCapabilities(config);
    process.stderr.write(`MeMesh: Level ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})\n`);
    if (caps.llm) {
        process.stderr.write(`MeMesh: LLM: ${caps.llm.provider} (${caps.llm.model ?? 'default'})\n`);
    }
}
export function getConfigDir() { return configDir(); }
export function getConfigPath() { return configFilePath(); }
//# sourceMappingURL=config.js.map