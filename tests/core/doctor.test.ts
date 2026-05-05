import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
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
    currentVersionDeprecated: false,
    deprecationMessage: null,
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

  // F4: doctor verifies dist/skills-manifest.json. The fixture must
  // include one matching the on-disk hook stubs, otherwise the new
  // skills-manifest check fires and the overall status downgrades.
  const tracked = [
    'scripts/hooks/pre-edit-recall.js',
    'scripts/hooks/session-start.js',
    'scripts/hooks/post-commit.js',
    'scripts/hooks/session-summary.js',
    'scripts/hooks/pre-compact.js',
    'hooks/hooks.json',
    '.mcp.json',
  ];
  const entries = tracked.map(rel => {
    const buf = fs.readFileSync(path.join(root, rel));
    return {
      path: rel,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'skills-manifest.json'),
    JSON.stringify({
      schema: 'memesh.skills-manifest/v1',
      generated_at: '2026-05-04T00:00:00.000Z',
      entries,
    }, null, 2) + '\n',
  );

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

  it('detects skills-manifest tampering (F4)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    // Tamper with one of the tracked files. Manifest still references
    // the original SHA, so doctor must flag the mismatch.
    fs.writeFileSync(
      path.join(packageRoot, 'scripts/hooks/pre-edit-recall.js'),
      '#!/usr/bin/env node\n// EVIL OVERLAY\n',
    );

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
    });

    expect(result.checks.find((c) => c.id === 'skills-manifest')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('tampered'),
    });
  });

  it('warns (not fails) when manifest is missing — source-checkout case (F4)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    fs.rmSync(path.join(packageRoot, 'dist', 'skills-manifest.json'));

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
    });

    expect(result.checks.find((c) => c.id === 'skills-manifest')).toMatchObject({
      status: 'warn',
    });
  });

  it('escalates the update-status check to FAIL when the installed version is deprecated', async () => {
    // Doctor is the place a user runs when they suspect something
    // wrong. A maintainer-flagged installed version (typically a
    // security advisory) should land here as a hard failure with the
    // exact deprecation message — not get downgraded to the regular
    // "update available" warning that an unsuspecting user might
    // dismiss.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.1',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        currentVersion: '4.1.1',
        latestVersion: '4.1.2',
        updateAvailable: true,
        currentVersionDeprecated: true,
        deprecationMessage: 'Security: HIGH polynomial-redos. Upgrade to 4.1.2+.',
      }),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
    });

    const updateCheck = result.checks.find((c) => c.id === 'update-status');
    expect(updateCheck?.status).toBe('fail');
    expect(updateCheck?.summary).toContain('DEPRECATED');
    expect(updateCheck?.summary).toContain('4.1.1');
    expect(updateCheck?.summary).toContain('polynomial-redos');
    // Overall doctor status must reflect the escalation.
    expect(result.status).not.toBe('PASS');
  });

  it('does not recommend `memesh update` when deprecated version has no upgrade target (codex round 32)', async () => {
    // Codex round 32: when the maintainer deprecates the latest
    // release before publishing the replacement (security advisory
    // disclosed before the fix is on npm), `memesh update` would
    // no-op. The doctor used to emit "This installation can be
    // updated directly from MeMesh" — pointing the user at a dead
    // end in exactly the security-advisory scenario this branch
    // exists to handle. The fix should explicitly tell the user
    // there's no upgrade target yet rather than reuse the generic
    // self-update guidance.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.2',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        currentVersion: '4.1.2',
        latestVersion: '4.1.2', // no replacement on npm yet
        updateAvailable: false,
        currentVersionDeprecated: true,
        deprecationMessage: 'Security: please upgrade as soon as a fix ships.',
      }),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });

    const updateCheck = result.checks.find((c) => c.id === 'update-status');
    expect(updateCheck?.status).toBe('fail');
    expect(updateCheck?.fix ?? '').not.toMatch(/`memesh update`/);
    expect(updateCheck?.fix ?? '').not.toContain('updated directly from MeMesh');
    expect(updateCheck?.fix ?? '').toMatch(/no upgrade target/i);
  });
});
