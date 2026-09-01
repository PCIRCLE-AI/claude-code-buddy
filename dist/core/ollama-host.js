const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const UNSAFE_OLLAMA_HOST_ERROR = 'Ollama host must be loopback (localhost / 127.0.0.1 / ::1) and a bare origin such as http://localhost:11434 — no path, query, or credentials. For non-local Ollama, set the OLLAMA_HOST environment variable on the server.';
export class UnsafeOllamaHostError extends Error {
    constructor() {
        super(UNSAFE_OLLAMA_HOST_ERROR);
        this.name = 'UnsafeOllamaHostError';
    }
}
function canonicalLoopbackOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    let protocol;
    switch (url.protocol) {
        case 'http:':
            protocol = 'http:';
            break;
        case 'https:':
            protocol = 'https:';
            break;
        default: return null;
    }
    let hostname;
    switch (url.hostname) {
        case 'localhost':
            hostname = 'localhost';
            break;
        case '127.0.0.1':
            hostname = '127.0.0.1';
            break;
        case '[::1]':
            hostname = '[::1]';
            break;
        default: return null;
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
        return null;
    if (url.pathname !== '/' && url.pathname !== '')
        return null;
    let port = '';
    if (url.port !== '') {
        const parsed = Number.parseInt(url.port, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
            return null;
        port = `:${parsed}`;
    }
    return `${protocol}//${hostname}${port}`;
}
export function resolveOllamaHost(configuredHost, operatorHost = process.env.OLLAMA_HOST) {
    if (configuredHost) {
        const origin = canonicalLoopbackOrigin(configuredHost);
        if (origin === null)
            throw new UnsafeOllamaHostError();
        return origin;
    }
    return (operatorHost || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
}
//# sourceMappingURL=ollama-host.js.map