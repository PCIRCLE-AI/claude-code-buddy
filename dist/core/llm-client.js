import { redactSecrets } from './paths.js';
export class LLMResponseParseError extends Error {
    constructor(provider, detail) {
        super(`${provider}: response parse failed — ${detail}`);
        this.name = 'LLMResponseParseError';
    }
}
export async function callLLM(prompt, config, opts = {}) {
    const chain = [config, ...(opts.fallbacks ?? [])];
    const attempts = [];
    const reportAttempts = () => {
        if (!opts.onAttempt)
            return;
        try {
            opts.onAttempt(attempts);
        }
        catch { }
    };
    let lastErr = null;
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
        }
        catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            const klass = classifyError(e);
            attempts.push({
                provider: cfg.provider, model: cfg.model,
                status: 'fail', latencyMs: Date.now() - t0,
                errorClass: klass, errorMessage: redactSecrets(e.message), index: i,
            });
            lastErr = e;
            if (klass === 'bad_request')
                break;
        }
    }
    reportAttempts();
    throw lastErr ?? new Error('callLLM: no providers configured');
}
const REQUEST_TIMEOUT_MS = 30_000;
function fetchWithTimeout(url, init) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
async function callSingle(prompt, config, maxTokens) {
    if (config.provider === 'anthropic') {
        const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error('Anthropic: no API key configured');
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
        if (!res.ok)
            throw new Error(`Anthropic API error: ${res.status}`);
        const data = await readJsonOrThrow(res, 'anthropic');
        const text = extractAnthropicText(data);
        if (text == null) {
            throw new LLMResponseParseError('anthropic', `missing content[0].text in ${describeShape(data)}`);
        }
        return text;
    }
    if (config.provider === 'openai') {
        const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey)
            throw new Error('OpenAI: no API key configured');
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
        if (!res.ok)
            throw new Error(`OpenAI API error: ${res.status}`);
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
            }),
        });
        if (!res.ok)
            throw new Error(`Ollama error: ${res.status}`);
        const data = await readJsonOrThrow(res, 'ollama');
        const text = extractOllamaText(data);
        if (text == null) {
            throw new LLMResponseParseError('ollama', `missing response field in ${describeShape(data)}`);
        }
        return text;
    }
    throw new Error(`No LLM provider configured (llm.provider is ${config.provider === undefined ? 'unset' : `"${String(config.provider)}"`}). ` +
        'Set one with `memesh config set llm.provider <anthropic|openai|ollama>`.');
}
async function readJsonOrThrow(res, provider) {
    try {
        return await res.json();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new LLMResponseParseError(provider, `body is not valid JSON (${msg})`);
    }
}
function extractAnthropicText(data) {
    if (!isObject(data))
        return null;
    const content = data.content;
    if (!Array.isArray(content) || content.length === 0)
        return null;
    const first = content[0];
    if (!isObject(first))
        return null;
    const text = first.text;
    return typeof text === 'string' ? text : null;
}
function extractOpenAIText(data) {
    if (!isObject(data))
        return null;
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return null;
    const first = choices[0];
    if (!isObject(first))
        return null;
    const message = first.message;
    if (!isObject(message))
        return null;
    const content = message.content;
    return typeof content === 'string' ? content : null;
}
function extractOllamaText(data) {
    if (!isObject(data))
        return null;
    const response = data.response;
    return typeof response === 'string' ? response : null;
}
function isObject(v) {
    return typeof v === 'object' && v !== null;
}
function describeShape(v) {
    if (v == null)
        return String(v);
    if (Array.isArray(v))
        return `array(len=${v.length})`;
    if (typeof v !== 'object')
        return typeof v;
    const keyCount = Object.keys(v).length;
    return `object(${keyCount}-keys)`;
}
export function classifyError(e) {
    if (e instanceof LLMResponseParseError)
        return 'parse';
    const msg = e.message;
    if (/\b(401|403|invalid_api_key|authentication|x-api-key|unauthorized)\b/i.test(msg))
        return 'auth';
    if (/no API key/i.test(msg))
        return 'auth';
    if (/\b(429|rate.?limit|quota)\b/i.test(msg))
        return 'rate_limit';
    if (/\b(50[023]|service unavailable|bad gateway)\b/i.test(msg))
        return 'upstream';
    if (/\b400\b/.test(msg))
        return 'bad_request';
    if (/(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|aborted)/i.test(msg))
        return 'network';
    return 'unknown';
}
//# sourceMappingURL=llm-client.js.map