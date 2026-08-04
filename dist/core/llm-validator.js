class ProbeError extends Error {
    errorCode;
    constructor(message, errorCode) {
        super(message);
        this.errorCode = errorCode;
        this.name = 'ProbeError';
    }
}
function codeForStatus(status) {
    if (status === 401 || status === 403)
        return 'auth';
    return `http_${status}`;
}
function probeErrorCode(err) {
    if (err instanceof ProbeError)
        return err.errorCode;
    const msg = err instanceof Error ? err.message : String(err);
    if (/(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|abort)/i.test(msg))
        return 'network';
    return 'unknown';
}
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 8192;
const MAX_ERROR_CHARS = 300;
function safeErrorString(s) {
    return s
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .slice(0, MAX_ERROR_CHARS);
}
function extractProviderError(status, body) {
    try {
        const j = JSON.parse(body);
        const msg = j?.error?.message;
        const type = j?.error?.type;
        if (msg)
            return safeErrorString(type ? `${msg} (${type})` : msg);
    }
    catch {
    }
    if (status === 401)
        return 'Authentication failed — the API key was rejected.';
    if (status === 403)
        return 'Forbidden — the key may lack permission for this endpoint.';
    if (status === 429)
        return 'Rate limited or quota exhausted.';
    if (status >= 500)
        return `Provider returned ${status} (server-side error).`;
    return `HTTP ${status}`;
}
async function readBodyCapped(res) {
    const reader = res.body?.getReader();
    if (!reader)
        return await res.text().catch(() => '');
    const chunks = [];
    let total = 0;
    try {
        while (total < MAX_BODY_BYTES) {
            const { done, value } = await reader.read();
            if (done)
                break;
            chunks.push(value);
            total += value.byteLength;
        }
        if (total >= MAX_BODY_BYTES)
            await reader.cancel().catch(() => { });
    }
    catch {
    }
    const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
    let off = 0;
    for (const c of chunks) {
        const room = merged.byteLength - off;
        if (room <= 0)
            break;
        merged.set(c.subarray(0, Math.min(c.byteLength, room)), off);
        off += Math.min(c.byteLength, room);
    }
    return new TextDecoder().decode(merged);
}
async function fetchJson(url, init) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (!res.ok) {
            const body = await readBodyCapped(res).catch(() => '');
            throw new ProbeError(extractProviderError(res.status, body), codeForStatus(res.status));
        }
        return (await res.json());
    }
    finally {
        clearTimeout(t);
    }
}
export function pickSuggestedModel(models) {
    if (models.length === 0)
        return undefined;
    const SMALL_HINTS = ['mini', 'nano', 'haiku', 'flash', 'lite', 'small', '8b', '7b', '3b'];
    const candidates = models.filter((m) => SMALL_HINTS.some((h) => m.id.toLowerCase().includes(h)));
    const pool = candidates.length > 0 ? candidates : models;
    const sorted = [...pool].sort((a, b) => {
        if (a.created && b.created)
            return b.created.localeCompare(a.created);
        return 0;
    });
    return sorted[0].id;
}
export async function probeAnthropic(apiKey) {
    if (!apiKey)
        return { valid: false, error: 'API key is empty', errorCode: 'auth' };
    try {
        const data = await fetchJson('https://api.anthropic.com/v1/models?limit=200', {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
        });
        const models = (data.data ?? []).map((m) => ({
            id: m.id,
            created: m.created_at,
        }));
        if (models.length === 0) {
            return { valid: false, error: 'Anthropic answered, but returned no models — a proxy or gateway may be intercepting the request. Check the endpoint and API key.', errorCode: 'no_models' };
        }
        return { valid: true, models, suggested: pickSuggestedModel(models) };
    }
    catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err), errorCode: probeErrorCode(err) };
    }
}
export async function probeOpenAI(apiKey) {
    if (!apiKey)
        return { valid: false, error: 'API key is empty', errorCode: 'auth' };
    try {
        const data = await fetchJson('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const NON_CHAT_PREFIXES = ['whisper', 'tts-', 'dall-e', 'davinci-codex', 'text-embedding', 'text-similarity', 'omni-moderation'];
        const models = (data.data ?? [])
            .filter((m) => !NON_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
            .map((m) => ({
            id: m.id,
            created: m.created ? new Date(m.created * 1000).toISOString() : undefined,
        }));
        if (models.length === 0) {
            return { valid: false, error: 'OpenAI answered, but returned no chat-capable models — a proxy or gateway may be intercepting the request. Check the endpoint and API key.', errorCode: 'no_models' };
        }
        return { valid: true, models, suggested: pickSuggestedModel(models) };
    }
    catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err), errorCode: probeErrorCode(err) };
    }
}
const OLLAMA_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
function isSafeOllamaHost(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return false;
        return OLLAMA_LOOPBACK_HOSTS.has(u.hostname);
    }
    catch {
        return false;
    }
}
export async function probeOllama(host) {
    const envBase = process.env.OLLAMA_HOST;
    const requestedBase = host || envBase || 'http://localhost:11434';
    if (!envBase && host && !isSafeOllamaHost(host)) {
        return {
            valid: false,
            error: `Ollama host must be loopback (localhost / 127.0.0.1). For non-local Ollama, set the OLLAMA_HOST environment variable on the server.`,
            errorCode: 'bad_host',
        };
    }
    const base = requestedBase;
    try {
        const data = await fetchJson(`${base.replace(/\/$/, '')}/api/tags`, { method: 'GET' });
        const models = (data.models ?? []).map((m) => ({
            id: m.name,
            created: m.modified_at,
        }));
        if (models.length === 0) {
            return {
                valid: false,
                error: `Ollama is reachable at ${base} but has no models installed. Run \`ollama pull <model>\` first.`,
                errorCode: 'no_models',
            };
        }
        return { valid: true, models, suggested: pickSuggestedModel(models) };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
            return { valid: false, error: `Ollama not reachable at ${base}. Is it installed and running?`, errorCode: 'network' };
        }
        return { valid: false, error: msg, errorCode: probeErrorCode(err) };
    }
}
export async function probeProvider(provider, apiKey, host) {
    if (provider === 'anthropic')
        return probeAnthropic(apiKey ?? '');
    if (provider === 'openai')
        return probeOpenAI(apiKey ?? '');
    if (provider === 'ollama')
        return probeOllama(host);
    return { valid: false, error: `Unknown provider: ${provider}`, errorCode: 'unknown' };
}
//# sourceMappingURL=llm-validator.js.map