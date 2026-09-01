const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const OLLAMA_LOOPBACK_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
]);
export const UNSAFE_OLLAMA_HOST_ERROR = 'Ollama host must be loopback (localhost / 127.0.0.1 / ::1). For non-local Ollama, set the OLLAMA_HOST environment variable on the server.';
export class UnsafeOllamaHostError extends Error {
    constructor() {
        super(UNSAFE_OLLAMA_HOST_ERROR);
        this.name = 'UnsafeOllamaHostError';
    }
}
function isSafeOllamaConfigHost(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && OLLAMA_LOOPBACK_HOSTS.has(url.hostname);
    }
    catch {
        return false;
    }
}
export function resolveOllamaHost(configuredHost, operatorHost = process.env.OLLAMA_HOST) {
    if (configuredHost && !isSafeOllamaConfigHost(configuredHost)) {
        throw new UnsafeOllamaHostError();
    }
    return (configuredHost || operatorHost || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
}
//# sourceMappingURL=ollama-host.js.map