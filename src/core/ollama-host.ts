const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

export const UNSAFE_OLLAMA_HOST_ERROR =
  'Ollama host must be loopback (localhost / 127.0.0.1 / ::1) and a bare origin such as http://localhost:11434 — no path, query, or credentials. For non-local Ollama, set the OLLAMA_HOST environment variable on the server.';

export class UnsafeOllamaHostError extends Error {
  constructor() {
    super(UNSAFE_OLLAMA_HOST_ERROR);
    this.name = 'UnsafeOllamaHostError';
  }
}

/**
 * Persisted or request-supplied Ollama hosts are untrusted (they come from a
 * config file or a Dashboard request). Rather than validating the string and
 * then forwarding it, rebuild the origin from literals: the scheme and the
 * hostname are chosen by `switch` on the parsed value, the port is re-parsed
 * as a number. The value handed to `fetch` therefore never contains bytes
 * from the untrusted input. That is what closes CodeQL js/file-access-to-http
 * (#137) — a `Set.has()` check on the raw string did not, because the same
 * tainted string still reached the request.
 *
 * A path, query, fragment, or userinfo on a configured host is refused rather
 * than dropped: silently forwarding a bare origin when the operator wrote a
 * reverse-proxy prefix would be a quiet behaviour change.
 */
function canonicalLoopbackOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  let protocol: 'http:' | 'https:';
  switch (url.protocol) {
    case 'http:': protocol = 'http:'; break;
    case 'https:': protocol = 'https:'; break;
    default: return null;
  }
  let hostname: 'localhost' | '127.0.0.1' | '[::1]';
  switch (url.hostname) {
    case 'localhost': hostname = 'localhost'; break;
    case '127.0.0.1': hostname = '127.0.0.1'; break;
    case '[::1]': hostname = '[::1]'; break;
    default: return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  let port = '';
  if (url.port !== '') {
    const parsed = Number.parseInt(url.port, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    port = `:${parsed}`;
  }
  return `${protocol}//${hostname}${port}`;
}

export function resolveOllamaHost(
  configuredHost?: string,
  operatorHost = process.env.OLLAMA_HOST,
): string {
  if (configuredHost) {
    const origin = canonicalLoopbackOrigin(configuredHost);
    if (origin === null) throw new UnsafeOllamaHostError();
    return origin;
  }
  return (operatorHost || DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
}
