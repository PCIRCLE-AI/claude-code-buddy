import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDoctorReport, runDoctor } from '../../src/core/doctor.js';
import type { UpdateCheck } from '../../src/core/version-check.js';

function makeUpdateCheck(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    currentVersion: '4.0.3',
    latestVersion: '4.0.3',
    checkedAt: '2026-04-25T00:00:00.000Z',
    lastAttemptAt: '2026-04-25T00:00:00.000Z',
    lastSuccessfulCheckAt: '2026-04-25T00:00:00.000Z',
    lastError: null,
    updateAvailable: false,
    checkSucceeded: true,
    source: 'cache',
    freshness: 'cached',
    ...overrides,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createPackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-'));

  writeJson(path.join(root, '.mcp.json'), {
    mcpServers: {
      memesh: {
        command: 'memesh-mcp',
      },
    },
  });

  writeJson(path.join(root, 'hooks', 'hooks.json'), {
    hooks: {
      PreToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js' }] }],
      SessionStart: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js' }] }],
      PostToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-commit.js' }] }],
      Stop: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }] }],
      PreCompact: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.js' }] }],
    },
  });

  for (const file of [
    'scripts/hooks/pre-edit-recall.js',
    'scripts/hooks/session-start.js',
    'scripts/hooks/post-commit.js',
    'scripts/hooks/session-summary.js',
    'scripts/hooks/pre-compact.js',
  ]) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '#!/usr/bin/env node\n');
    fs.chmodSync(fullPath, 0o755);
  }

  fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), '<html></html>');

  return root;
}

function makeDatabase(count = 3) {
  return {
    prepare(sql: string) {
      expect(sql).toContain('COUNT(*)');
      return {
        get: () => ({ c: count }),
      };
    },
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('doctor', () => {
  it('reports PASS when local install checks all succeed', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const configPath = path.join(packageRoot, 'config.json');
    writeJson(configPath, {
      llm: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      probeHttp: true,
      httpBaseUrl: 'http://127.0.0.1:3737',
      openDatabaseImpl: () => makeDatabase(7) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({
        searchLevel: 1,
        llm: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        embeddings: 'openai',
      }),
      getConfigPathImpl: () => configPath,
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global',
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    });

    expect(result.status).toBe('PASS');
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);

    const lines = formatDoctorReport(result, '4.0.3');
    expect(lines).toContain('Overall: PASS');
    expect(lines.some((line) => line.includes('HTTP server is reachable'))).toBe(true);
  });

  it('reports PASS_WITH_CONCERNS when no config or cached update metadata exists yet', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({
        searchLevel: 0,
        llm: null,
        embeddings: 'disabled',
      }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        latestVersion: null,
        checkSucceeded: false,
        freshness: 'unavailable',
        lastSuccessfulCheckAt: null,
        lastError: 'registry offline',
      }),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout',
        label: 'source checkout',
        canSelfUpdate: false,
        recommendedCommand: null,
        guidance: 'Update this source checkout from its repository and rebuild it.',
      }),
    });

    expect(result.status).toBe('PASS_WITH_CONCERNS');
    expect(result.checks.find((check) => check.id === 'config')?.status).toBe('pass');
    expect(result.checks.find((check) => check.id === 'update-status')?.status).toBe('warn');
  });

  it('fails when the MCP config is invalid JSON', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    fs.writeFileSync(path.join(packageRoot, '.mcp.json'), '{invalid');

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({
        searchLevel: 0,
        llm: null,
        embeddings: 'disabled',
      }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global',
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });

    expect(result.status).toBe('FAIL');
    expect(result.checks.find((check) => check.id === 'mcp-config')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('.mcp.json'),
    });
  });

  it('fails when a required hook script is missing', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    fs.rmSync(path.join(packageRoot, 'scripts/hooks/pre-edit-recall.js'));

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({
        searchLevel: 0,
        llm: null,
        embeddings: 'disabled',
      }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global',
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });

    expect(result.status).toBe('FAIL');
    expect(result.checks.find((check) => check.id === 'hook-scripts')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('pre-edit-recall.js'),
    });
  });
});
