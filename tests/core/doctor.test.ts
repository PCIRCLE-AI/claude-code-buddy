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

    // The new hook-wiring check (added for #25) needs a marker
    // file at MEMESH_DIR/install-hooks.json AND a memesh-attributed
    // entity in the past 24h. Set up both via env override + the
    // existing makeDatabase factory (count=7 → activity check
    // returns PASS).
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-mdir-'));
    tempRoots.push(memeshDir);
    const settingsPath = path.join(memeshDir, 'fake-settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'fake', _memesh: true }] }],
      },
    });
    writeJson(path.join(memeshDir, 'install-hooks.json'), {
      installed_at: '2026-05-08T00:00:00.000Z',
      version: '4.1.4',
      plugin_root: packageRoot,
      scope: 'user',
      settings_path: settingsPath,
    });
    const originalMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;

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

    // Cleanup — restore MEMESH_DIR for downstream tests
    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalMemeshDir;
  });

  it('reports PASS_WITH_CONCERNS when no config or cached update metadata exists yet', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    // Isolate from the real ~/.memesh so inspectHookWiring reads a
    // fresh dir with no install-hooks.json → returns warn, not fail.
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-mdir-'));
    tempRoots.push(memeshDir);
    const originalMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;

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

    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalMemeshDir;

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

  it('surfaces deprecation even when freshness is unavailable (codex round 33)', async () => {
    // Codex round 31's fix made `checkForUpdate` persist a real
    // deprecation flag even when the latest-version lookup itself
    // failed. In that scenario the cache has
    // `currentVersionDeprecated: true` but
    // `lastSuccessfulCheckAt: null`, so freshness comes back as
    // 'unavailable'. Round 33 caught that doctor's old early-return
    // for unavailable freshness ran BEFORE the deprecation branch,
    // suppressing the security signal exactly when it just
    // arrived. Doctor must escalate to fail with the deprecation
    // warning even when freshness is 'unavailable'.
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
        latestVersion: null,
        lastSuccessfulCheckAt: null,
        lastError: 'version lookup timed out',
        checkSucceeded: false,
        source: 'fresh',
        freshness: 'unavailable',
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
    expect(updateCheck?.summary).not.toContain('No successful cached');
    expect(result.status).not.toBe('PASS');
  });

  it('always recommends `memesh update` for npm-global, even when deprecated has no upgrade target (codex rounds 32/35/39)', async () => {
    // Round 32 originally added a "no upgrade target yet" message
    // for the case where `latestVersion === currentVersion` came
    // from a fresh lookup. Round 35 tightened it to require
    // freshness === 'fresh'. Round 39 then noted that doctor calls
    // getUpdateCheck with `preferFresh: false`, so the fresh-only
    // gate made the branch dead code in production. Resolution:
    // doctor always recommends `memesh update` for self-updatable
    // channels — `npm install -g @latest` is harmless when there
    // truly is no target, and immediately applies a freshly-
    // published fix when one ships. The "no upgrade target yet"
    // wording lives only in `memesh status` (which CAN do a fresh
    // lookup) and in the dashboard (after a Check now click).
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
        source: 'fresh',
        freshness: 'fresh',
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
    expect(updateCheck?.fix ?? '').toMatch(/`memesh update`/);
    expect(updateCheck?.fix ?? '').not.toMatch(/no upgrade target/i);
  });

  it('keeps `memesh update` available when latest=current came from cached data (codex round 35)', async () => {
    // Round 35: only a FRESH registry lookup can confirm "no
    // upgrade target". When `latestVersion === packageVersion` came
    // from a cached or stale check, the registry could have
    // published a replacement since — telling the user to wait
    // would withhold the actionable command for a security advisory
    // that may already have a fix. Doctor should keep
    // `memesh update` in the fix message in this uncertain state.
    // Round 39 generalized this to ALL freshness states for
    // doctor, since the cache-only read path means freshness can
    // never be 'fresh' there anyway.
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
        latestVersion: '4.1.2',
        updateAvailable: false,
        currentVersionDeprecated: true,
        deprecationMessage: 'Security: please upgrade as soon as a fix ships.',
        source: 'cache',
        freshness: 'cached', // ← key difference from round 32 test
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
    expect(updateCheck?.fix ?? '').toMatch(/`memesh update`/);
    expect(updateCheck?.fix ?? '').not.toMatch(/no upgrade target/i);
  });

  // ===========================================================================
  // #25 — runtime hook wiring + activity checks
  // ===========================================================================

  function setupMemeshDir(opts: {
    marker?: object | string | false;
    settingsContent?: object | string | false;
  } = {}): { memeshDir: string; settingsPath: string; restoreEnv: () => void } {
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mdir-'));
    tempRoots.push(memeshDir);
    const settingsPath = path.join(memeshDir, 'fake-settings.json');
    if (opts.settingsContent !== false && opts.settingsContent !== undefined) {
      if (typeof opts.settingsContent === 'string') {
        fs.writeFileSync(settingsPath, opts.settingsContent);
      } else {
        writeJson(settingsPath, opts.settingsContent);
      }
    }
    if (opts.marker !== false && opts.marker !== undefined) {
      const markerPath = path.join(memeshDir, 'install-hooks.json');
      if (typeof opts.marker === 'string') {
        fs.writeFileSync(markerPath, opts.marker);
      } else {
        writeJson(markerPath, opts.marker);
      }
    }
    const original = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;
    return {
      memeshDir,
      settingsPath,
      restoreEnv: () => {
        if (original === undefined) delete process.env.MEMESH_DIR;
        else process.env.MEMESH_DIR = original;
      },
    };
  }

  it('hook-wiring: WARN when no install-hooks marker exists (fresh install)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({}); // no marker, no settings

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring).toBeDefined();
    expect(wiring!.status).toBe('warn');
    expect(wiring!.summary).toMatch(/install-hooks marker/i);
    expect(wiring!.fix).toMatch(/memesh install-hooks/);
  });

  it('hook-wiring: PASS when marker + settings + memesh hook entry all present', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({
      settingsContent: {
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'fake', _memesh: true }] }],
        },
      },
      marker: {
        installed_at: '2026-05-08T00:00:00.000Z',
        version: '4.1.4',
        plugin_root: packageRoot,
        scope: 'user',
        settings_path: path.join(env_settingsPathPlaceholder()), // see below
      },
    });
    // Re-write the marker now that we know the settings path
    writeJson(path.join(env.memeshDir, 'install-hooks.json'), {
      installed_at: '2026-05-08T00:00:00.000Z',
      version: '4.1.4',
      plugin_root: packageRoot,
      scope: 'user',
      settings_path: env.settingsPath,
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(5) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring!.status).toBe('pass');
    expect(wiring!.summary).toMatch(/Wired in/);
    expect(wiring!.summary).toContain(env.settingsPath);
  });

  it('hook-wiring: FAIL when marker references settings that drifted (no _memesh entries)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({
      // Settings exists but has only NON-memesh hooks (user manually
      // removed memesh entries via direct edit, leaving the marker
      // dangling — exact case the FAIL surfaces).
      settingsContent: {
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.js' }] }],
        },
      },
    });
    writeJson(path.join(env.memeshDir, 'install-hooks.json'), {
      installed_at: '2026-05-08T00:00:00.000Z',
      version: '4.1.4',
      plugin_root: packageRoot,
      scope: 'user',
      settings_path: env.settingsPath,
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring!.status).toBe('fail');
    expect(wiring!.summary).toMatch(/Settings drifted|no _memesh:true/i);
    expect(result.status).toBe('FAIL');
  });

  it('hook-activity: WARN when no memesh-attributed entities in past 24h AND no install-hooks marker (grace period inapplicable)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never, // ← key: 0 entities
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      // No marker → grace period cannot fire → warn must surface.
      existsSyncImpl: ((p: fs.PathLike) => {
        if (typeof p === 'string' && p.endsWith('install-hooks.json')) return false;
        return fs.existsSync(p);
      }) as typeof fs.existsSync,
    });

    const activity = result.checks.find(c => c.id === 'hook-activity');
    expect(activity!.status).toBe('warn');
    expect(activity!.summary).toMatch(/No memesh-attributed entities/i);
    expect(activity!.fix).toMatch(/Claude Code session|commit/);
  });

  it('hook-activity: PASS via grace period when install-hooks marker is fresh and 0 entities', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never, // 0 entities
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      // Fresh marker exists → grace period kicks in → no warn.
      existsSyncImpl: ((p: fs.PathLike) => {
        if (typeof p === 'string' && p.endsWith('install-hooks.json')) return true;
        return fs.existsSync(p);
      }) as typeof fs.existsSync,
      statSyncImpl: ((p: fs.PathLike) => {
        if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
          return { mtimeMs: Date.now() - 60_000 } as fs.Stats; // 1 min old
        }
        return fs.statSync(p);
      }) as typeof fs.statSync,
    });

    const activity = result.checks.find(c => c.id === 'hook-activity');
    expect(activity!.status).toBe('pass');
    expect(activity!.summary).toMatch(/recently|fresh install/i);
  });

  it('hook-activity: WARN when install-hooks marker is older than the grace window AND 0 entities', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      existsSyncImpl: ((p: fs.PathLike) => {
        if (typeof p === 'string' && p.endsWith('install-hooks.json')) return true;
        return fs.existsSync(p);
      }) as typeof fs.existsSync,
      statSyncImpl: ((p: fs.PathLike) => {
        if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
          // 48h old — well past the 24h grace window
          return { mtimeMs: Date.now() - 48 * 60 * 60 * 1000 } as fs.Stats;
        }
        return fs.statSync(p);
      }) as typeof fs.statSync,
    });

    const activity = result.checks.find(c => c.id === 'hook-activity');
    expect(activity!.status).toBe('warn');
  });
});

// Helper used by the wiring tests above. Cannot reference env.settingsPath
// inside the marker object literal at construction time, so this is just
// a dummy stand-in we overwrite immediately after.
function env_settingsPathPlaceholder(): string { return ''; }

describe('README locale parity (doctor sub-check)', () => {
  function buildReadme(h2Count: number, title = 'MeMesh'): string {
    const lines = [`# ${title}`, ''];
    for (let i = 0; i < h2Count; i++) {
      lines.push(`## Section ${i + 1}`, '', `body for section ${i + 1}`, '');
    }
    return lines.join('\n');
  }
  const LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'th', 'vi', 'zh-CN', 'zh-TW'];

  async function doctorOn(packageRoot: string) {
    return runDoctor({
      packageRoot,
      packageVersion: '4.2.3',
      openDatabaseImpl: () => makeDatabase(3) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'onnx' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source', canSelfUpdate: false,
        recommendedCommand: '', guidance: 'source checkout',
      }),
    });
  }

  it('passes when all 10 locale READMEs match the English H2 count', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    for (const loc of LOCALES) fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(15));

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check).toBeDefined();
    expect(check.status).toBe('pass');
    expect(check.summary).toContain('All 10 locale READMEs');
  });

  it('tolerates ±1 H2 drift (locale translators sometimes collapse a heading)', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    for (const loc of LOCALES) fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(14));

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('pass');
  });

  it('warns when a locale has drifted by ≥2 H2 (likely added/removed section)', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    for (const loc of LOCALES) {
      const count = loc === 'ja' ? 12 : 15; // Japanese is stale by 3 sections
      fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(count));
    }

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/README\.ja\.md=12/);
    expect(check.fix).toBeTruthy();
  });

  it('warns when a locale README is missing entirely', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    // omit Korean
    for (const loc of LOCALES.filter(l => l !== 'ko')) {
      fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(15));
    }

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/missing: README\.ko\.md/);
  });

  it('skips silently when README.md is not present (packaged install)', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    // No README.md at all — simulates an npm-published tarball that
    // didn't bundle docs.
    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/check skipped/);
  });
});

describe('database failure diagnostics (F15)', () => {
  it('diagnoses insufficient permissions', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const dbPath = path.join(packageRoot, 'test.db');
    const dbDir = path.dirname(dbPath);

    const previousEnv = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;

    try {
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.1.4',
        openDatabaseImpl: () => { throw new Error('SQLITE_CANTOPEN'); },
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: (p: string) => p === dbPath || p === dbDir,
        statSyncImpl: (p: string) => {
          if (p === dbPath) return { mode: 0o000, size: 1024 } as fs.Stats; // No permissions
          if (p === dbDir) return { mode: 0o700, size: 4096 } as fs.Stats;
          throw new Error('ENOENT');
        },
      });

      const dbCheck = result.checks.find(c => c.id === 'database');
      expect(dbCheck!.status).toBe('fail');
      expect(dbCheck!.summary).toMatch(/insufficient permissions/i);
      expect(dbCheck!.fix).toMatch(/chmod 600/);
    } finally {
      if (previousEnv === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousEnv;
    }
  });

  it('diagnoses empty database file', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const dbPath = path.join(packageRoot, 'test.db');
    const dbDir = path.dirname(dbPath);

    const previousEnv = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;

    try {
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.1.4',
        openDatabaseImpl: () => { throw new Error('SQLITE_NOTADB'); },
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: (p: string) => p === dbPath || p === dbDir,
        statSyncImpl: (p: string) => {
          if (p === dbPath) return { mode: 0o600, size: 0 } as fs.Stats; // Empty file
          if (p === dbDir) return { mode: 0o700, size: 4096 } as fs.Stats;
          throw new Error('ENOENT');
        },
      });

      const dbCheck = result.checks.find(c => c.id === 'database');
      expect(dbCheck!.status).toBe('fail');
      expect(dbCheck!.summary).toMatch(/empty.*0 bytes.*corrupted/i);
      expect(dbCheck!.fix).toMatch(/rm.*memesh recall/);
    } finally {
      if (previousEnv === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousEnv;
    }
  });

  it('diagnoses missing database directory', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const dbPath = path.join(packageRoot, 'nonexistent', 'test.db');

    const previousEnv = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;

    try {
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.1.4',
        openDatabaseImpl: () => { throw new Error('SQLITE_CANTOPEN'); },
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: () => false, // DB and directory don't exist
        statSyncImpl: () => { throw new Error('ENOENT'); },
      });

      const dbCheck = result.checks.find(c => c.id === 'database');
      expect(dbCheck!.status).toBe('fail');
      expect(dbCheck!.summary).toMatch(/directory does not exist/i);
      expect(dbCheck!.fix).toMatch(/mkdir -p/);
    } finally {
      if (previousEnv === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousEnv;
    }
  });

  it('provides actionable fix commands for all failure modes', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const dbPath = path.join(packageRoot, 'test.db');

    // Create a DB file that can't be opened. Doctor resolves the DB path
    // via paths.ts (env MEMESH_DB_PATH, then default ~/.memesh/...), not
    // via an injectable option — so use the env override to point at our
    // corrupted fixture. This matches the pattern the sibling F15 tests use.
    fs.writeFileSync(dbPath, 'corrupted');
    const previousEnv = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;

    try {
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.1.4',
        openDatabaseImpl: () => { throw new Error('SQLITE_CORRUPT'); },
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: fs.existsSync,
        statSyncImpl: fs.statSync,
      });

      const dbCheck = result.checks.find(c => c.id === 'database');
      expect(dbCheck!.status).toBe('fail');
      expect(dbCheck!.fix).toBeTruthy();
      // Corrupted non-empty file path produces the "backup and reset" fix.
      // Pattern accepts the three concrete recovery shapes the F15 paths
      // produce: backup+rename, rm+recreate, or chmod fix.
      expect(dbCheck!.fix).toMatch(/mv.*backup|rm.*recall|chmod/);
    } finally {
      if (previousEnv === undefined) delete process.env.MEMESH_DB_PATH;
      else process.env.MEMESH_DB_PATH = previousEnv;
    }
  });
});

describe('database lifecycle preservation (F16 — regression)', () => {
  // Regression: in v4.1.4 release testing, calling /v1/doctor in the
  // running HTTP server caused doctor to close the global database
  // connection mid-flight. Subsequent /v1/* requests then returned 500
  // "Database not opened" until the server was restarted. Doctor must
  // detect that someone else owns the db lifecycle and refuse to close.
  it('does NOT close the database when it was already open before doctor ran', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    let closeCallCount = 0;

    await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => { closeCallCount++; },
      isDatabaseOpenImpl: () => true, // ← simulates server-mode: db already open
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
    });

    // The real closeDatabaseImpl must NEVER be called when db was already
    // open. If it gets called, doctor would set the global db = null
    // and break every subsequent request handler in the HTTP server.
    expect(closeCallCount).toBe(0);
  });

  it('DOES close the database when doctor opened it (CLI mode)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    let closeCallCount = 0;

    await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => { closeCallCount++; },
      isDatabaseOpenImpl: () => false, // ← simulates CLI mode: doctor opens db itself
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
    });

    // CLI mode: doctor opened the db itself, so it must close it to avoid
    // leaking the connection to subsequent CLI commands or test runs.
    expect(closeCallCount).toBeGreaterThan(0);
  });
});
