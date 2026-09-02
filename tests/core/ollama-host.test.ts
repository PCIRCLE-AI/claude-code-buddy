import { describe, it, expect } from 'vitest';
import { resolveOllamaHost, UnsafeOllamaHostError } from '../../src/core/ollama-host.js';

// #137: the value handed to fetch must be rebuilt from literals, never the
// configured string itself. These pin the observable contract of that rebuild.
describe('resolveOllamaHost — configured (untrusted) hosts', () => {
  it('returns a bare loopback origin for each allowed hostname', () => {
    expect(resolveOllamaHost('http://localhost:11434')).toBe('http://localhost:11434');
    expect(resolveOllamaHost('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(resolveOllamaHost('http://[::1]:11434')).toBe('http://[::1]:11434');
    expect(resolveOllamaHost('https://localhost')).toBe('https://localhost');
  });

  it('canonicalises a trailing slash and a numeric port', () => {
    expect(resolveOllamaHost('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(resolveOllamaHost('http://localhost:0011434')).toBe('http://localhost:11434');
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['http://attacker.example:11434', 'http://0.0.0.0:11434', 'http://10.0.0.5:11434']) {
      expect(() => resolveOllamaHost(host)).toThrow(UnsafeOllamaHostError);
      expect(() => resolveOllamaHost(host)).toThrow(/must be loopback/);
    }
  });

  it('rejects a path, query, fragment, credentials, or non-http scheme instead of forwarding them', () => {
    for (const host of [
      'http://localhost:11434/proxy',
      'http://localhost:11434/?x=1',
      'http://localhost:11434/#frag',
      'http://user:pw@localhost:11434',
      'ftp://localhost:11434',
      'not a url',
    ]) {
      expect(() => resolveOllamaHost(host)).toThrow(UnsafeOllamaHostError);
    }
  });
});

describe('resolveOllamaHost — operator OLLAMA_HOST (trusted, unchanged)', () => {
  it('forwards a remote operator host with its trailing slash stripped', () => {
    expect(resolveOllamaHost(undefined, 'http://operator-ollama.example:11434/')).toBe('http://operator-ollama.example:11434');
  });
  it('falls back to the default when nothing is configured', () => {
    expect(resolveOllamaHost(undefined, undefined)).toBe('http://localhost:11434');
  });
  it('prefers a configured loopback host over the operator host', () => {
    expect(resolveOllamaHost('http://127.0.0.1:11434', 'http://operator-ollama.example:11434')).toBe('http://127.0.0.1:11434');
  });
});
