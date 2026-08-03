/**
 * `memesh config list` must show every settable key, not just llm.* — a user
 * who `config set`s sessionLimit / llmFallbacks / embedder.* used to get
 * "✅ Set" but no trace of it in `list`, which reads as a silent write-drop.
 * And it must never print a raw apiKey (primary or fallback-chain).
 *
 * Spawns the built CLI with HOME pointed at a tmpdir so it reads an isolated
 * config.json (paths.ts is HOME-first).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('memesh config list', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runList(config: object): string {
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify(config));
    return execFileSync('node', [path.resolve('dist/transports/cli/cli.js'), 'config', 'list'], {
      env: { ...process.env, HOME: home, MEMESH_DB_PATH: path.join(home, '.memesh', 'kg.db') },
      encoding: 'utf8',
    });
  }

  it('lists every settable key that is present, not just llm.*', () => {
    const out = runList({
      llm: { provider: 'anthropic', apiKey: 'sk-primary-should-not-print', model: 'claude' },
      sessionLimit: 42,
      autoCapture: false,
      autoUpdate: 'patch',
      llmFallbacks: [{ provider: 'openai', apiKey: 'sk-fallback-should-not-print' }],
    });

    // Previously these were invisible in `list`.
    expect(out).toContain('sessionLimit: 42');
    expect(out).toContain('autoCapture: false');
    expect(out).toContain('autoUpdate: patch');
    expect(out).toContain('llmFallbacks');
    expect(out).toContain('llm.provider: anthropic');
  });

  it('fully redacts apiKeys — no key bytes at all, primary or fallback chain', () => {
    const out = runList({
      llm: { provider: 'anthropic', apiKey: 'sk-primary-abcd-1234-should-not-print' },
      llmFallbacks: [{ provider: 'openai', apiKey: 'sk-fallback-wxyz-9876-should-not-print' }],
    });
    // Not even the first-4/last-4 fragments maskApiKey would reveal.
    expect(out).not.toMatch(/sk-p|rint|sk-f|9876|abcd|wxyz/);
    expect(out).toContain('llm.apiKey: ***');
  });

  it('says nothing is set when the config is empty', () => {
    const out = runList({});
    expect(out).toContain('no keys set');
  });
});
