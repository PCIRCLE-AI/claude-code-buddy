import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDoctorReport, hoursSince, runDoctor as runDoctorImpl } from '../../src/core/doctor.js';
import type { UpdateCheck } from '../../src/core/version-check.js';
import type { Capabilities } from '../../src/core/config.js';

/**
 * Stand-in for the real embedder. 768 dims = nomic-embed-text's output.
 *
 * Every doctor test MUST inject this. The real `embedText()` makes a live
 * provider call (ollama socket / openai HTTP), which a diagnostic test must
 * not depend on. A deterministic stub keeps the probe rows testable offline.
 */
const stubEmbedText = async (): Promise<Float32Array> => new Float32Array(768);

/**
 * All tests go through this wrapper so no call site can accidentally reach
 * the real embedder. A test that wants different embedding behaviour passes
 * its own `embedTextImpl` — the spread means it wins.
 */
function runDoctor(options: Parameters<typeof runDoctorImpl>[0]) {
  return runDoctorImpl({ embedTextImpl: stubEmbedText, ...options });
}

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

  // `.claude-plugin/plugin.json` is listed in package.json's `files`, so it is
  // inside the tarball and exists on EVERY install. The fixture used to omit
  // it, and that omission hid a real defect for three releases: the
  // hook-wiring check treated the file's presence as proof that Claude Code
  // had loaded the hooks, so a plain `npm i -g` with nothing wired reported
  // PASS. A fixture that does not carry what ships cannot see that.
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), {
    name: 'memesh',
    version: '4.1.4',
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

  // Stub the sqlite-vec directory so the native-binding existence
  // check passes. The probe itself is overridden per-test via
  // `nativeBindingProbeImpl`, so no real native module is touched here.
  fs.mkdirSync(path.join(root, 'node_modules', 'sqlite-vec'), { recursive: true });

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

/**
 * Stand-in for the knowledge-graph database.
 *
 * This dispatches on the statement instead of asserting one shape, because it
 * has to answer more than one question now and an unrecognised statement must
 * be LOUD. The previous version asserted `sql` contained `COUNT(*)` and
 * returned `{ c: count }` for literally anything — so the moment doctor started
 * issuing a second query, the stub answered it with an entity count. That is
 * the failure this file is meant to catch, not cause: a check reading a
 * nonsense value and reporting `pass`.
 *
 * The `fts_segmentation` queries default to "healthy index" so every other test
 * sees only the check it is about. `unsegmentedCount` flips that row on.
 *
 * What a stub can pin here is the MESSAGE. What it cannot pin is the DETECTION:
 * dispatching on `sql.includes(...)` never executes the statement, so mutating
 * `length(term) > 2` to `length(term) > 200`, or the `sqlite_master` guard to
 * `if (true)`, both left all 45 tests green. The SQL predicate is the fix, and
 * it is pinned in `tests/fts-segmentation-doctor.test.ts` against a real FTS5
 * index.
 */
function makeDatabase(
  count = 3,
  opts: {
    unsegmentedCount?: number;
    /**
     * `hook_runs` rows. `null` or `[]` = the table is empty (no hook has ever
     * run). `hoursAgo` may be negative (a future timestamp — wrong clock) and
     * `rawLastRunAt` bypasses timestamp generation for corrupt-value cases.
     */
    hookRuns?: Array<{ hook: string; hoursAgo?: number; rawLastRunAt?: string }> | null;
    /** Age of the `hook_runs_since` marker. `null` = the key is absent. */
    trackingSinceHours?: number | null;
    /** Raw `hook_runs_since` value, for corrupt-marker cases. */
    trackingSinceRaw?: string;
    /** Set to true when the self-heal UPDATE of hook_runs_since runs. */
    onMetadataUpdate?: () => void;
    /**
     * Result of the source_host corroboration query (the >72h branch asks
     * "did Claude Code itself write anything recently?"). Defaults to 1 —
     * agent in use — so the stale-fail tests exercise the provable red;
     * pass 0 for the moved-to-another-agent hedge.
     */
    recentClaudeCodeWrites?: number;
  } = {},
) {
  const sqliteTs = (hoursAgo: number) =>
    new Date(Date.now() - hoursAgo * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  // Default to a healthy heartbeat so the many tests that are about OTHER
  // checks do not have to know this one exists. Tests that are about hook
  // activity pass it explicitly.
  const hookRuns = opts.hookRuns === undefined
    ? [{ hook: 'session-summary', hoursAgo: 1 }]
    : (opts.hookRuns ?? []);
  const trackingSinceHours = opts.trackingSinceHours === undefined ? 720 : opts.trackingSinceHours;
  return {
    prepare(sql: string) {
      if (sql.includes('sqlite_master')) return { get: () => ({ present: 1 }) };
      if (sql.includes('fts_vocab')) {
        return { get: () => ({ c: opts.unsegmentedCount ?? 0 }) };
      }
      if (sql.includes('FROM hook_runs')) {
        return {
          all: () => hookRuns.map((r) => ({
            hook: r.hook,
            last_run_at: r.rawLastRunAt ?? sqliteTs(r.hoursAgo ?? 1),
          })),
        };
      }
      // The self-heal path rewrites a corrupt hook_runs_since. Dispatch on the
      // statement kind BEFORE the key-name check below, which would also match.
      if (sql.startsWith('UPDATE memesh_metadata')) {
        return { run: () => { opts.onMetadataUpdate?.(); } };
      }
      if (sql.includes('hook_runs_since')) {
        return {
          get: () => {
            if (opts.trackingSinceRaw !== undefined) return { value: opts.trackingSinceRaw };
            return trackingSinceHours === null ? undefined : { value: sqliteTs(trackingSinceHours) };
          },
        };
      }
      if (sql.includes('source_host')) {
        return { get: () => ({ c: opts.recentClaudeCodeWrites ?? 1 }) };
      }
      // hook-activity counts entities carrying the auto-capture provenance
      // tag, so its statement is `COUNT(DISTINCT e.id)` over a join. This
      // stub cannot tell the two counts apart — it never runs the SQL. The
      // predicate itself is covered against a real database in
      // `tests/cli/doctor-honest-pass.test.ts`.
      expect(sql).toMatch(/COUNT\(/);
      return {
        get: () => ({ c: count }),
      };
    },
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// The doctor's capability stubs used to be object literals missing four of
// `Capabilities`' required fields. They compiled only because nothing type
// -checked this file: `tsconfig.json`'s exclude carries `**/*.test.ts`, so
// `npm run typecheck` skipped every test in the repository. A stub narrower
// than the interface it stands in for is a stub that stops standing in for it
// the moment doctor reads one of the missing fields.
function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    fts5: true,
    vectorSearch: true,
    scoring: true,
    knowledgeEvolution: true,
    embeddings: 'ollama',
    llm: null,
    llmFallbacks: [],
    searchLevel: 0,
    ...overrides,
  };
}

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
      detectCapabilitiesImpl: () => caps({
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
      // Fixture stubs node_modules/sqlite-vec as an empty dir, so the real
      // probe would fail. Inject success since this test is verifying the
      // overall-PASS flow, not the binding probe itself.
      nativeBindingProbeImpl: () => ({ ok: true }),
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
      detectCapabilitiesImpl: () => caps({
        searchLevel: 0,
        llm: null,
        embeddings: 'tfidf',
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
      // Fixture's sqlite-vec dir is an empty stub; let the binding
      // check pass so this test focuses on the update-status WARN.
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalMemeshDir;

    expect(result.status).toBe('PASS_WITH_CONCERNS');
    expect(result.checks.find((check) => check.id === 'config')?.status).toBe('pass');
    expect(result.checks.find((check) => check.id === 'update-status')?.status).toBe('warn');
  });

  it('the Config row agrees with the Capabilities row when an env key enables Smart Mode', async () => {
    // QA on the packaged CLI: with NO config file and an API key in the shell —
    // a common developer setup — the Config row said "MeMesh will run in Core
    // mode" while the Capabilities row two sections later said "Search level 1
    // (Smart Mode)". One report, two answers. The Config check used to hardcode
    // Core mode whenever the file was absent, never asking the detector that
    // the Capabilities row already consulted. The dream gate had fixed this
    // same pattern; doctor's own check had not.
    const packageRoot = createPackageRoot();
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-smart-'));
    tempRoots.push(memeshDir);
    const originalMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      // Env-detected Smart Mode: a key is present, no file names a provider.
      detectCapabilitiesImpl: () => caps({
        searchLevel: 1,
        llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' },
        embeddings: 'tfidf',
      }),
      // The file does NOT exist — that is the whole scenario.
      getConfigPathImpl: () => path.join(memeshDir, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        latestVersion: null, checkSucceeded: false, freshness: 'unavailable',
        lastSuccessfulCheckAt: null, lastError: 'registry offline',
      }),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source checkout', canSelfUpdate: false,
        recommendedCommand: null, guidance: 'Update this source checkout from its repository and rebuild it.',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalMemeshDir;

    const config = result.checks.find((check) => check.id === 'config');
    expect(config?.status).toBe('pass');
    expect(config?.summary, 'the Config row still claims Core mode while the detector says Smart Mode')
      .not.toContain('Core mode');
    // Pin the TRUTH of the sentence, not only the absence of the old one. The
    // first version said "an API key in the environment" — a mutation replacing
    // that phrase with nonsense survived, because only 'Smart Mode' was asserted.
    expect(config?.summary, 'the row must name the provider the environment supplied')
      .toContain('names openai');
    expect(config?.summary).toContain('via its API key');
  });

  it('the Config row names OLLAMA_HOST, not an API key, when that is what enabled Smart Mode', async () => {
    // Review finding: OLLAMA_HOST yields a provider with NO apiKey, and the
    // sentence sent the user hunting for a key that does not exist.
    const packageRoot = createPackageRoot();
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-ollama-'));
    tempRoots.push(memeshDir);
    const originalMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;
    const result = await runDoctor({
      packageRoot, packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never, closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, llm: { provider: 'ollama', model: 'llama3.2' }, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(memeshDir, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({ latestVersion: null, checkSucceeded: false, freshness: 'unavailable', lastSuccessfulCheckAt: null, lastError: 'registry offline' }),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({ channel: 'source-checkout', label: 'source checkout', canSelfUpdate: false, recommendedCommand: null, guidance: 'Update this source checkout from its repository and rebuild it.' }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });
    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR; else process.env.MEMESH_DIR = originalMemeshDir;
    const config = result.checks.find((check) => check.id === 'config');
    expect(config?.summary, 'told the user an API key enabled Smart Mode when OLLAMA_HOST did').not.toContain('API key');
    expect(config?.summary).toContain('names ollama');
    expect(config?.summary).toContain('via OLLAMA_HOST');
  });

  it('reports a count for an unsegmented index and leaks no memory text', async () => {
    // Only the MESSAGE. Whether the check FINDS anything is pinned against a
    // real FTS5 index in `tests/fts-segmentation-doctor.test.ts` — see the
    // note on `makeDatabase` for why a stub cannot do it here.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase(3, { unsegmentedCount: 4 }) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({
        searchLevel: 0,
        llm: null,
        embeddings: 'tfidf',
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

    const row = result.checks.find((check) => check.id === 'fts_segmentation');
    expect(row).toMatchObject({
      status: 'warn',
      summary: expect.stringContaining('4 unsegmented term'),
      fix: expect.stringContaining('reindex --fts'),
    });
    // The count is the whole payload. `memesh feedback` and the dashboard
    // widget copy every check summary verbatim into a pre-filled PUBLIC GitHub
    // issue body, with diagnostics opt-OUT — so an example term lifted from
    // fts_vocab would be a line of the user's own memories staged for
    // publication. An earlier version embedded one.
    expect(row!.summary).not.toMatch(/[\u3400-\u9FFF\u0E01-\u0E5B\uFF66-\uFF9D]/);
    // ...and it still tells them how to know it worked.
    expect(row!.summary).toMatch(/should be 0/);
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
      detectCapabilitiesImpl: () => caps({
        searchLevel: 0,
        llm: null,
        embeddings: 'tfidf',
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

  it('fails when .mcp.json starts a script that is not in the install', async () => {
    // The defect this was written for: the MCP entry point was renamed,
    // `package.json` bin and `npm start` were repointed, and `.mcp.json` kept
    // naming the deleted file. Every MCP tool died with
    // `-32000 failed to reconnect` — and doctor reported PASS, because it
    // stopped at "there is a string `command`" and never looked at what the
    // config actually starts. A config that names a file which is not there is
    // not a valid config.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    writeJson(path.join(packageRoot, '.mcp.json'), {
      mcpServers: {
        memesh: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/launcher.js'],
        },
      },
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace', label: 'Claude Code plugin marketplace',
        canSelfUpdate: false, recommendedCommand: 'memesh upgrade-plugin', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    const check = result.checks.find((c) => c.id === 'mcp-config');
    expect(check?.status).toBe('fail');
    expect(check?.summary).toContain('dist/mcp/launcher.js');
    expect(result.status).toBe('FAIL');
  });

  it('passes when .mcp.json starts a script that IS present', async () => {
    // The guard must not become "always fail": a correct config still passes,
    // and the check really does resolve the path rather than rejecting any
    // config that has args at all.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'dist', 'mcp', 'server.js'), '// present\n');
    writeJson(path.join(packageRoot, '.mcp.json'), {
      mcpServers: {
        memesh: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'],
        },
      },
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    expect(result.checks.find((c) => c.id === 'mcp-config')?.status).toBe('pass');
  });

  it('fails when hooks.json yields zero hook script commands', async () => {
    // All five expected hook types present, so the hooks-config check passes —
    // but no entry carries a `hooks` array, so zero scripts are extracted.
    // Every downstream check filters FROM that set and passes vacuously; this
    // used to report "All 0 hook scripts are present and executable" with an
    // overall PASS for an install whose hooks can never fire.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    writeJson(path.join(packageRoot, 'hooks', 'hooks.json'), {
      hooks: {
        PreToolUse: [{ matcher: '*' }],
        SessionStart: [{ matcher: '*' }],
        PostToolUse: [{ matcher: '*' }],
        Stop: [{ matcher: '*' }],
        PreCompact: [{ matcher: '*' }],
      },
    });

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.0.3',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({
        searchLevel: 0,
        llm: null,
        embeddings: 'tfidf',
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
      summary: expect.stringContaining('zero hook script commands'),
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
      detectCapabilitiesImpl: () => caps({
        searchLevel: 0,
        llm: null,
        embeddings: 'tfidf',
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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

  it('hook-wiring: PASS with no marker when this IS a plugin-marketplace install', async () => {
    // The other half of the C1 fix. `install-hooks` never runs on the plugin
    // path, so the marker is legitimately absent and PASS is correct there —
    // without this case, deleting the branch entirely leaves the suite green
    // while every Claude Code plugin user is told to run a command they must
    // not run. The fixture is identical to the WARN case below except for the
    // channel, which is the whole point: the channel is the only signal.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({}); // no marker, no settings

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace', label: 'Claude Code plugin marketplace', canSelfUpdate: false,
        recommendedCommand: 'memesh upgrade-plugin',
        guidance: 'Reinstall the plugin from the Claude Code /plugin UI.',
      }),
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring!.status).toBe('pass');
    expect(wiring!.summary).toMatch(/plugin-marketplace install/);
    expect(wiring!.fix).toBeUndefined();
  });

  it('hook-wiring: WARN when no install-hooks marker exists (fresh install)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({}); // no marker, no settings

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      // The registry consult reads the REAL machine by default; a dev box
      // with the plugin installed would flip this test without the seam.
      installedPluginsPathImpl: path.join(packageRoot, 'no-such-registry.json'),
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
    // Plain-language copy (the old text led with "install-hooks marker" —
    // an internal implementation detail the user cannot act on).
    expect(wiring!.summary).toMatch(/not connected to Claude Code/i);
    expect(wiring!.fix).toMatch(/memesh install-hooks/);
    expect(wiring!.code).toBe('hook-wiring.no-marker');
  });

  it('hook-wiring: PASS from the npm copy when the PLUGIN registry has memesh (the contradiction fix)', async () => {
    // The real-machine shape this repairs: plugin manages hooks, user also
    // has the npm CLI. install-hooks correctly bails with "hooks are
    // active"; doctor used to WARN "not connected" from the same machine —
    // one machine, two answers. The registry is machine-level truth.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const registry = path.join(packageRoot, 'installed_plugins.json');
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'memesh@pcircle-memesh': [{ installPath: '/x', version: '9.9.9', scope: 'user' }] },
    }));
    const env = setupMemeshDir({}); // no marker — npm copy never ran install-hooks

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      installedPluginsPathImpl: registry,
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring!.status).toBe('pass');
    expect(wiring!.summary).toMatch(/plugin runtime/i);
    // No i18n code on a PASS row — the catalogue gate only covers warn/fail.
    expect(wiring!.code).toBeUndefined();
  });

  it('fixId rides only the branches --fix may act on', async () => {
    // The identifier is attached at the diagnosing branch, never parsed from
    // the human fix string. The no-marker WARN carries install-hooks; the
    // plugin-managed PASS carries nothing.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const env = setupMemeshDir({});
    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => makeDatabase(0) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      installedPluginsPathImpl: path.join(packageRoot, 'no-such-registry.json'),
    });
    env.restoreEnv();

    const wiring = result.checks.find(c => c.id === 'hook-wiring');
    expect(wiring!.status).toBe('warn');
    expect(wiring!.fixId).toBe('install-hooks');
    // Nothing else in this run may carry a fixId the whitelist would act on
    // unprompted — vector_index in particular must never (paid re-embed).
    const vector = result.checks.find(c => c.id === 'vector_index');
    if (vector) expect(vector.fixId).toBeUndefined();
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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

  // ── hook-activity ────────────────────────────────────────────────────────
  //
  // The check measures whether a capture hook RAN, not whether it saved
  // anything. Before `hook_runs` existed it could only count captured rows,
  // which made "a quiet Tuesday" and "capture has been dead for a month"
  // produce the same WARN — so the dashboard suppressed the code entirely and
  // the one signal that mattered could never reach a user. Each case below
  // pins one of the states that were previously indistinguishable.

  /** Everything a runDoctor call needs that is not about hook activity. */
  function hookActivityDoctorArgs(packageRoot: string, database: unknown) {
    return {
      packageRoot,
      packageVersion: '4.1.4',
      openDatabaseImpl: () => database as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global' as const,
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global' as const, label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: 'This installation can be updated directly from MeMesh.',
      }),
      // The wiring check consults the plugin registry, and its default path
      // reads the REAL machine — a dev box with the plugin installed would
      // silently flip every no-marker branch here.
      installedPluginsPathImpl: path.join(packageRoot, 'no-such-registry.json'),
    };
  }

  const noMarker = ((p: fs.PathLike) => {
    if (typeof p === 'string' && p.endsWith('install-hooks.json')) return false;
    return fs.existsSync(p);
  }) as typeof fs.existsSync;

  const markerAged = (ageMs: number) => ({
    existsSyncImpl: ((p: fs.PathLike) => {
      if (typeof p === 'string' && p.endsWith('install-hooks.json')) return true;
      return fs.existsSync(p);
    }) as typeof fs.existsSync,
    statSyncImpl: ((p: fs.PathLike) => {
      if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
        return { mtimeMs: Date.now() - ageMs } as fs.Stats;
      }
      return fs.statSync(p);
    }) as typeof fs.statSync,
  });

  /**
   * A variant whose hook WIRING passes: the plugin-marketplace channel wires
   * through the plugin runtime, so inspectHookWiring reports PASS without an
   * install-hooks marker. The never-ran FAIL only exists when wiring is in
   * place — without it the hook-wiring row owns the story.
   */
  function wiredDoctorArgs(packageRoot: string, database: unknown) {
    return {
      ...hookActivityDoctorArgs(packageRoot, database),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace' as const,
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace' as const, label: 'Claude Code plugin', canSelfUpdate: false,
        recommendedCommand: '/plugin update memesh',
        guidance: 'Update through the Claude Code plugin marketplace.',
      }),
    };
  }

  async function activityCheck(args: Parameters<typeof runDoctorImpl>[0]) {
    const result = await runDoctor(args);
    return { result, activity: result.checks.find(c => c.id === 'hook-activity')! };
  }

  it('hook-activity: PASS when session-summary ran recently even though it captured NOTHING', async () => {
    // The crying-wolf case, and the reason the old code was unusable. A hook
    // that ran and found nothing worth saving is the single most common
    // healthy state, and it used to raise the same warning as a dead loop.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'session-summary', hoursAgo: 2 }] })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status, 'a quiet but living capture loop was reported as a problem').toBe('pass');
    expect(activity.summary).toMatch(/session-summary/);
    expect(activity.summary).toMatch(/nothing was worth saving/i);
  });

  it('hook-activity: PASS and names the count when only an event hook has stamped', async () => {
    // post-commit alone: session-summary has never stamped (no real session
    // ended yet) but a commit proves the machinery runs. Alive, with a note.
    // Tracking is young here (48h) on purpose — past 72h the same shape stops
    // being explicable by quiet sessions and becomes stop-silent, below.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(4, {
        hookRuns: [{ hook: 'post-commit', hoursAgo: 1 }],
        trackingSinceHours: 48,
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('pass');
    expect(activity.summary).toMatch(/post-commit/);
    expect(activity.summary).toMatch(/4 memories captured/);
  });

  it('hook-activity: WARN stop-silent when commits stamp daily but session-summary has NEVER run', async () => {
    // The masked-death this check exists to expose: a permanently silent Stop
    // hook hiding behind fresh post-commit stamps. Quiet sessions cannot
    // explain it past 72h of tracking — the low-signal bails stamp too — so
    // the note escalates to a bannerable warn. Not a fail: the machinery
    // provably runs, and absence of one hook's stamp is not proof of death.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'post-commit', hoursAgo: 1 }],
        trackingSinceHours: 200,
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('warn');
    expect(activity.code).toBe('hook-activity.stop-silent');
    expect(activity.params?.hook).toBe('post-commit');
    expect(activity.params?.hours).toBe(200);
    expect(activity.fix, 'stop-silent without a fix cannot reach the banner').toBeTruthy();
    expect(activity.summary).toMatch(/session-summary/);
  });

  it('hook-activity: the stop-silent threshold holds at 72h, not wherever the constant drifts', async () => {
    // The far-side fixtures (48h pass / 200h warn) survive the constant
    // drifting anywhere between them — same reason the staleness tiers got
    // near-boundary pins.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity: justUnder } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'post-commit', hoursAgo: 1 }],
        trackingSinceHours: 71.5,
      })),
      existsSyncImpl: noMarker,
    });
    expect(justUnder.status, '71.5h of tracking is still inside the quiet-sessions explanation').toBe('pass');

    const { activity: justOver } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'post-commit', hoursAgo: 1 }],
        trackingSinceHours: 73,
      })),
      existsSyncImpl: noMarker,
    });
    expect(justOver.status, '73h must already be past the stop-silent threshold').toBe('warn');
    expect(justOver.code).toBe('hook-activity.stop-silent');
  });

  it('hook-activity: a dead session-summary is NOT masked by a living post-commit', async () => {
    // The cross-model adversarial finding on this PR's first draft: the check
    // read only the single newest row, so any healthy hook hid any dead one —
    // and session-summary, the hook that carries session memory, is the one
    // most likely to break alone (it is by far the most complex). Its silence
    // owns the verdict whenever it has ever stamped.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [
          { hook: 'post-commit', hoursAgo: 1 },
          { hook: 'session-summary', hoursAgo: 96 },
        ],
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status, 'a living post-commit masked a session-summary dead for 4 days').toBe('fail');
    expect(activity.code).toBe('hook-activity.stale');
    expect(activity.params?.hook).toBe('session-summary');
    expect(activity.summary).toMatch(/session-summary/);
  });

  it('hook-activity: staleness has two tiers — a weekend is a warn, not a red banner', async () => {
    // >24h flat used to FAIL, which turned every Monday morning into a red
    // "capture has stopped". 24–72h is a warn; beyond 72h it is the FAIL.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    for (const [hoursAgo, expected] of [[23.5, 'pass'], [48, 'warn'], [71.5, 'warn'], [96, 'fail']] as const) {
      const { activity } = await activityCheck({
        ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'session-summary', hoursAgo }] })),
        existsSyncImpl: noMarker,
      });
      expect(activity.status, `session-summary ${hoursAgo}h ago must be ${expected}`).toBe(expected);
      if (expected !== 'pass') {
        expect(activity.code).toBe('hook-activity.stale');
        expect(activity.fix, 'warn-tier staleness must still carry a fix to banner').toBeTruthy();
      }
    }
  });

  it('hook-activity: the 24h and 72h thresholds hold near the boundary', async () => {
    // Far-side fixtures (2h / 96h) survive a constant drifting to 95 — these
    // pin the constants themselves.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity: justUnder } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'session-summary', hoursAgo: 24.5 }] })),
      existsSyncImpl: noMarker,
    });
    expect(justUnder.status, '24.5h must already be past the alive threshold').toBe('warn');

    const { activity: justOver } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'session-summary', hoursAgo: 72.5 }] })),
      existsSyncImpl: noMarker,
    });
    expect(justOver.status, '72.5h must already be past the warn tier').toBe('fail');
  });

  it('hook-activity: >72h holds at WARN when Claude Code itself has written nothing either', async () => {
    // The cross-host hole: this database is shared by MCP hosts, and a user
    // who moved to Codex or Gemini stops triggering Claude Code's Stop hook
    // forever — a permanent, unfixable red under the flat >72h rule. The red
    // needs positive evidence the agent is in use: recent entities stamped
    // source_host=claude-code. No writes is NOT proof of death (a session can
    // save nothing), so absence only holds the verdict at warn.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity: hedged } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', hoursAgo: 96 }],
        recentClaudeCodeWrites: 0,
      })),
      existsSyncImpl: noMarker,
    });
    expect(hedged.status, 'no corroborating writes must hold the verdict at warn').toBe('warn');
    // Its own code, not a tail on hook-activity.stale: locales render by
    // code, and the glued-on English tail dropped the "this may be fine"
    // hedge in all 10 non-English dashboards.
    expect(hedged.code).toBe('hook-activity.stale-unconfirmed');
    expect(hedged.params?.hook).toBe('session-summary');
    expect(hedged.summary).toMatch(/another agent|Codex/);

    // And the corroborated side, pinned explicitly rather than by default:
    // one recent claude-code write proves the agent is in use while its Stop
    // hook is silent — that is the provable red.
    const { activity: corroborated } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', hoursAgo: 96 }],
        recentClaudeCodeWrites: 1,
      })),
      existsSyncImpl: noMarker,
    });
    expect(corroborated.status).toBe('fail');
    expect(corroborated.code).toBe('hook-activity.stale');
  });

  it('hook-activity: small negative ages are clock jitter, not corruption', async () => {
    // Two processes stamp and read with different clocks; a stamp 2 minutes
    // "in the future" is jitter and must read as alive. Beyond the tolerance
    // it is a wrong clock and must read as unknown (tested below).
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', hoursAgo: -2 / 60 }],
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status, 'a 2-minute clock skew must not read as a corrupt timestamp').toBe('pass');
  });

  it('hook-activity: event-only rows with unreadable timestamps fail as unknown, deterministically', async () => {
    // Every row unreadable and none of them session-summary: the old code
    // indexed [0] of an insertion-ordered map, so the named hook depended on
    // row order. Sorted now — post-commit before pre-compact, always.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [
          { hook: 'pre-compact', rawLastRunAt: 'garbage' },
          { hook: 'post-commit', rawLastRunAt: 'garbage' },
        ],
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('fail');
    expect(activity.code).toBe('hook-activity.stale-unknown');
    expect(activity.params?.hook).toBe('post-commit');
  });

  it('hook-activity: a hook name we never wrote is neither echoed nor counted', async () => {
    // hook_runs is user-writable SQLite, so a foreign row's name is
    // untrusted twice over. It must not ride a diagnostic into the
    // pre-filled PUBLIC GitHub issue body (`memesh feedback`) — and it must
    // not COUNT: the first draft sanitized the name to 'unknown-hook' but
    // kept the timestamp as liveness evidence, so one fresh foreign row
    // turned a dead capture loop permanently green (four independent
    // reviews converged on this). Foreign rows are not evidence, in either
    // direction.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const injected = 'session-summary`; DROP TABLE users; my-secret-project';

    // Fresh foreign row: must NOT read as "auto-capture is alive".
    const { activity: fresh } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: injected, hoursAgo: 1 }],
        trackingSinceHours: 200,
      })),
      existsSyncImpl: noMarker,
    });
    expect(fresh.status, 'a foreign row must not certify the capture loop alive').not.toBe('pass');
    expect(fresh.summary).not.toContain('my-secret-project');
    expect(String(fresh.params?.hook ?? '')).not.toContain('my-secret-project');

    // Corrupt foreign row: same fall-through — our hooks have never stamped,
    // and that is the story the verdict tells (never-ran family), without
    // the foreign name anywhere in it.
    const { activity: garbage } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: injected, rawLastRunAt: 'garbage' }],
        trackingSinceHours: 200,
      })),
      existsSyncImpl: noMarker,
    });
    expect(garbage.summary).not.toContain('my-secret-project');
    expect(garbage.status).not.toBe('pass');
  });

  it('hook-activity: WARN never-ran-legacy when captures land but no hook has ever stamped', async () => {
    // Version skew between ship channels: an upgraded CLI starts tracking
    // while still-old hooks (predating the heartbeat) keep capturing without
    // stamping. Entities ARE landing, so the never-ran FAIL's "nothing is
    // being remembered" would be flatly false — but the tag is hand-typeable,
    // so this stays a warn, never a pass.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...wiredDoctorArgs(packageRoot, makeDatabase(5, { hookRuns: null, trackingSinceHours: 200 })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('warn');
    expect(activity.code).toBe('hook-activity.never-ran-legacy');
    expect(activity.params?.captured).toBe(5);
    expect(activity.fix, 'the fix must point at updating the hooks').toMatch(/update/i);
  });

  it('hook-activity: a stale event hook alone caps at WARN — absence of commits is not evidence of death', async () => {
    // With only post-commit stamped, its staleness is ambiguous forever: no
    // commits means no runs, dead or alive. The first draft escalated to FAIL
    // at 96h, which turned every week of non-git work (research, writing,
    // another VCS) into a red "capture has stopped" — an unfixable false
    // alarm. Event-hook staleness never outranks warn on its own.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    for (const hoursAgo of [30, 96, 500]) {
      const { activity } = await activityCheck({
        ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'post-commit', hoursAgo }] })),
        existsSyncImpl: noMarker,
      });
      expect(activity.status, `post-commit alone at ${hoursAgo}h must cap at warn`).toBe('warn');
      expect(activity.code).toBe('hook-activity.stale');
      expect(activity.params?.hook).toBe('post-commit');
    }
  });

  it('hook-activity: PASS when tracking itself only just started (the upgrade day)', async () => {
    // Every existing database has an empty `hook_runs` the moment this ships.
    // Reporting that as a dead capture loop would be the old bug with a louder
    // voice, so `hook_runs_since` records when we first COULD tell.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 3 })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status, 'an upgraded database was accused of having dead hooks').toBe('pass');
    expect(activity.summary).toMatch(/only just started/i);
  });

  it('hook-activity: the tracking grace ends at 24h, not wherever the constant drifts', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity: inGrace } = await activityCheck({
      ...wiredDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 23.5 })),
      existsSyncImpl: noMarker,
    });
    expect(inGrace.status).toBe('pass');

    const { activity: outOfGrace } = await activityCheck({
      ...wiredDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 25 })),
      existsSyncImpl: noMarker,
    });
    expect(outOfGrace.status, 'tracking 25h old with wiring in place must be past the grace').toBe('fail');
    expect(outOfGrace.code).toBe('hook-activity.never-ran');
  });

  it('hook-activity: PASS via the fresh-install grace when hooks were wired today', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
      ...markerAged(60_000), // wired one minute ago
    });
    expect(activity.status).toBe('pass');
    expect(activity.summary).toMatch(/fresh install/i);
  });

  it('hook-activity: an OLD install marker does not grant the fresh-install grace', async () => {
    // The boundary this rewrite once lost: install-hooks.json persists
    // forever, so `marker exists` alone would make never-ran unreachable for
    // exactly the population the check targets — wired, but not executing.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    // The marker exists (48h old), and wiring genuinely passes: the marker
    // parses, the settings it names exist and carry a _memesh hook entry.
    // Without the full stub the wiring row degrades to warn and never-ran
    // legitimately downgrades — which is a different test, below.
    const settingsPath = path.join(packageRoot, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ _memesh: true, command: 'memesh-hook' }] }] },
    }));
    const aged = markerAged(48 * 60 * 60 * 1000); // wired two days ago
    const readFileSyncImpl = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
        return JSON.stringify({ settings_path: settingsPath, plugin_root: packageRoot, version: '1', scope: 'user' });
      }
      return (fs.readFileSync as (...a: unknown[]) => string | Buffer)(p, ...rest);
    }) as typeof fs.readFileSync;

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
      ...aged,
      readFileSyncImpl,
    });
    expect(activity.status, 'a 48h-old marker must not grant the 24h grace').toBe('fail');
    expect(activity.code).toBe('hook-activity.never-ran');
  });

  it('hook-activity: FAIL when wired, watched for days, and nothing has ever run', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { result, activity } = await activityCheck({
      ...wiredDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
      existsSyncImpl: noMarker,
    });
    // FAIL, not warn: the dashboard only banners fails and warns carrying a
    // fix, and this being a warn is how it stayed invisible for so long.
    expect(activity.status).toBe('fail');
    expect(activity.code).toBe('hook-activity.never-ran');
    expect(activity.fix).toBeTruthy();
    // Pins the copy too: formatHoursAgo output is embedded in a sentence that
    // once read "in the 8 days ago since tracking began".
    expect(activity.summary).toMatch(/since tracking began 8 days ago/);
    expect(result.status).toBe('FAIL');
  });

  it('hook-wiring: a wired entry pointing at a DELETED script is a fail, not a healthy wiring', async () => {
    // Upgrade residue: a release retires a hook, the package deletes the
    // script, but the absolute-path entry a previous `install-hooks` wrote
    // into settings.json survives — the agent then invokes a nonexistent
    // file on every matching event. install-hooks now prunes these, but
    // nothing runs install-hooks automatically on a package upgrade, so
    // doctor is where the state must be caught and named.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const settingsPath = path.join(packageRoot, 'claude-settings.json');
    const ghostScript = path.join(packageRoot, 'scripts', 'hooks', 'retired-hook.js'); // never created
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ _memesh: true, command: ghostScript }] }] },
    }));
    const aged = markerAged(48 * 60 * 60 * 1000);
    const readFileSyncImpl = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
        return JSON.stringify({ settings_path: settingsPath, plugin_root: packageRoot, version: '1', scope: 'user' });
      }
      return (fs.readFileSync as (...a: unknown[]) => string | Buffer)(p, ...rest);
    }) as typeof fs.readFileSync;

    const result = await runDoctor({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0)),
      ...aged,
      readFileSyncImpl,
    });
    const wiring = result.checks.find(c => c.id === 'hook-wiring')!;
    expect(wiring.status, 'a wiring that invokes a missing file must not read as healthy').toBe('fail');
    expect(wiring.code).toBe('hook-wiring.script-missing');
    expect(String(wiring.params?.path)).toContain('retired-hook.js');
  });

  it('hook-activity: a SessionStart-only wiring does not arm the never-ran FAIL', async () => {
    // The wiring row passes on ANY _memesh entry — including a recall-only
    // wiring with nothing under Stop/PostToolUse/PreCompact. That is a real
    // wiring, but not evidence that capture hooks should be executing, and
    // the never-ran FAIL claims exactly that. Without the capture-event
    // gate, every recall-only install went permanently red after the grace
    // period.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const settingsPath = path.join(packageRoot, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ _memesh: true, command: 'memesh-hook' }] }] },
    }));
    const aged = markerAged(48 * 60 * 60 * 1000); // wired two days ago — grace expired
    const readFileSyncImpl = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith('install-hooks.json')) {
        return JSON.stringify({ settings_path: settingsPath, plugin_root: packageRoot, version: '1', scope: 'user' });
      }
      return (fs.readFileSync as (...a: unknown[]) => string | Buffer)(p, ...rest);
    }) as typeof fs.readFileSync;

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
      ...aged,
      readFileSyncImpl,
    });
    expect(activity.status, 'a recall-only wiring must not produce the capture-hooks-dead red').toBe('warn');
    expect(activity.code).toBe('hook-activity.not-wired');
  });

  it('hook-activity: never-ran downgrades to a quiet warn when wiring is absent', async () => {
    // MCP-only installs (Codex / Gemini) never wire hooks: for them a
    // permanent never-ran FAIL would be unfixable red, and for everyone else
    // the hook-wiring row above already tells this story with its own fix.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
      existsSyncImpl: noMarker, // npm-global channel + no marker → wiring warn
    });
    expect(activity.status).toBe('warn');
    expect(activity.code).toBe('hook-activity.not-wired');
  });

  it('hook-activity: env-disabled capture gets its OWN message — doctor cannot vouch for the agent\'s env', async () => {
    // Deliberately off is not a failure — but the env var is per-process:
    // doctor seeing MEMESH_AUTO_CAPTURE=false in ITS shell says nothing
    // certain about the agent's hooks (the agent may run without it, or
    // with it while doctor's shell is clean). The env-sourced pass is a
    // distinct code whose message says exactly that, instead of borrowing
    // the config message's machine-wide confidence.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const original = process.env.MEMESH_AUTO_CAPTURE;
    process.env.MEMESH_AUTO_CAPTURE = 'false';
    try {
      const { activity } = await activityCheck({
        ...wiredDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
        existsSyncImpl: noMarker,
      });
      expect(activity.status).toBe('pass');
      expect(activity.code).toBe('hook-activity.disabled-env');
      expect(activity.summary).toMatch(/environment/i);
    } finally {
      if (original === undefined) delete process.env.MEMESH_AUTO_CAPTURE;
      else process.env.MEMESH_AUTO_CAPTURE = original;
    }
  });

  it('hook-activity: config autoCapture:false disables the check, and the env var outranks the config', async () => {
    // isAutoCaptureOff reads the real config file (not the stubbed impls), so
    // this test redirects MEMESH_DIR at a temp dir. Precedence is env > config
    // — the same order every hook applies — so MEMESH_AUTO_CAPTURE=true must
    // bring the real verdict back even while the config still says false.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const memeshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-config-'));
    tempRoots.push(memeshTmp);
    fs.writeFileSync(path.join(memeshTmp, 'config.json'), JSON.stringify({ autoCapture: false }));

    const originalDir = process.env.MEMESH_DIR;
    const originalCapture = process.env.MEMESH_AUTO_CAPTURE;
    process.env.MEMESH_DIR = memeshTmp;
    delete process.env.MEMESH_AUTO_CAPTURE;
    try {
      const { activity: disabled } = await activityCheck({
        ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: null, trackingSinceHours: 200 })),
        existsSyncImpl: noMarker,
      });
      expect(disabled.status).toBe('pass');
      expect(disabled.code).toBe('hook-activity.disabled');

      process.env.MEMESH_AUTO_CAPTURE = 'true';
      const { activity: reEnabled } = await activityCheck({
        ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, { hookRuns: [{ hook: 'session-summary', hoursAgo: 1 }] })),
        existsSyncImpl: noMarker,
      });
      expect(reEnabled.code, 'env=true must outrank config autoCapture:false').not.toBe('hook-activity.disabled');
      expect(reEnabled.status).toBe('pass');
      expect(reEnabled.summary).toMatch(/alive/);
    } finally {
      if (originalDir === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = originalDir;
      if (originalCapture === undefined) delete process.env.MEMESH_AUTO_CAPTURE;
      else process.env.MEMESH_AUTO_CAPTURE = originalCapture;
    }
  });

  it('hook-activity: a corrupt hook_runs_since is reported, and doctor itself never writes', async () => {
    // Unreadable-or-future tracking marker used to satisfy `measuringHours
    // === null || < 24` forever — a fail-open. The healer is NOT doctor:
    // doctor is reachable via an unauthenticated loopback GET /v1/doctor,
    // where a state-changing side effect has no place, so the restamp moved
    // into ensureHookRunsSince on the write-path opens (pinned against a
    // real database in tests/hooks/write-hook-invariants.test.ts). Doctor
    // only reports that the next write-path open will heal it.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    let wrote = false;
    const { activity } = await activityCheck({
      ...wiredDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: null,
        trackingSinceRaw: 'garbage',
        onMetadataUpdate: () => { wrote = true; },
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('pass');
    expect(activity.summary).toMatch(/re-stamped automatically/i);
    expect(wrote, 'doctor is a reader — the diagnostic must not write to the database it inspects').toBe(false);
  });

  it('hook-activity: FAIL query-failed (with a fix) when the database cannot be read', async () => {
    // This branch had no test, which meant reverting it to the old
    // warn-without-fix — invisible to the dashboard banner — left the whole
    // suite green. Unknown is not healthy, and it must be VISIBLE.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, undefined),
      openDatabaseImpl: (() => { throw new Error('SQLITE_BUSY: database is locked'); }) as never,
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('fail');
    expect(activity.code).toBe('hook-activity.query-failed');
    expect(activity.fix, 'query-failed without a fix cannot reach the banner').toBeTruthy();
    expect(activity.params?.detail).toMatch(/locked/);
  });

  it('hook-activity: a SQLite timestamp is read as UTC on any machine timezone', () => {
    // A break-test found this one. SQLite writes `datetime('now')` as
    // `YYYY-MM-DD HH:MM:SS` in UTC, which is NOT ISO-8601 — the engines that
    // accept it in `new Date(...)` read it as LOCAL time. Swapping the UTC
    // parse for a local one left all 50 tests in this file green, because CI
    // runs in UTC where the two agree and every fixture here is relative. On a
    // UTC+8 machine the same row measures eight hours older, which is enough
    // to flip a living capture loop to "stopped" — and everyone with a non-UTC
    // clock is on such a machine, which is most people.
    //
    // Asserted against the parse function directly, with the timezone moved
    // underneath it. Going through runDoctor cannot pin this: its fixture
    // timestamps are relative, so both readings land in the same bucket.
    const original = process.env.TZ;
    try {
      const fiveHoursAgo = new Date(Date.now() - 5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
      for (const tz of ['UTC', 'Asia/Taipei', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        expect(hoursSince(fiveHoursAgo), `TZ=${tz} changed how the timestamp reads`).toBeCloseTo(5, 1);
      }
      // Guard the guard: if this runtime ignored the TZ changes, the loop above
      // proved nothing. Two zones 8 hours apart must disagree on a local-time
      // construction.
      process.env.TZ = 'UTC';
      const utcNoon = new Date(2026, 0, 1, 12, 0, 0).getTime();
      process.env.TZ = 'Asia/Taipei';
      const taipeiNoon = new Date(2026, 0, 1, 12, 0, 0).getTime();
      expect((utcNoon - taipeiNoon) / 3600_000, 'this runtime ignores process.env.TZ; the loop above is vacuous').toBe(8);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('hook-activity: an unreadable timestamp is not reported as healthy', async () => {
    // A corrupt `last_run_at` must not collapse to "just now". The whole point
    // of the check is that unknown and healthy are different answers. And it
    // gets its own code with NO hours param: the earlier `-1` sentinel was
    // decoded by the CLI but interpolated literally by every dashboard locale
    // — "ran about -1 hours ago".
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', rawLastRunAt: 'not-a-timestamp' }],
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status).toBe('fail');
    expect(activity.code).toBe('hook-activity.stale-unknown');
    expect(activity.params?.hook).toBe('session-summary');
    expect(activity.params?.hours, 'no hours param — the -1 sentinel rendered literally in 11 locales').toBeUndefined();
  });

  it('hook-activity: a FUTURE timestamp is unknown, not "recently"', async () => {
    // Three MCP hosts share this database; a machine with a fast clock stamps
    // into the future, and a negative age satisfied `<= 24` — a dead loop hid
    // behind it until the wall clock caught up.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', hoursAgo: -3 }],
      })),
      existsSyncImpl: noMarker,
    });
    expect(activity.status, 'a future timestamp must not read as alive').toBe('fail');
    expect(activity.code).toBe('hook-activity.stale-unknown');
  });

  it('hoursSince: rolled-over pseudo-dates are rejected, not normalised', () => {
    // Date.UTC never rejects out-of-range components — `2026-99-99` becomes a
    // real date years away (usually in the future, where a negative age can
    // pass a recency check). The round-trip validation catches exactly these.
    expect(hoursSince('2026-99-99 00:00:00')).toBeNull();
    expect(hoursSince('2026-02-30 10:00:00')).toBeNull();
    expect(hoursSince('2026-01-01 24:61:00')).toBeNull();
    // …and does not reject the values SQLite actually writes.
    expect(hoursSince('2026-02-28 23:59:59')).not.toBeNull();
  });

  it('hoursSince: trailing suffixes are rejected — a timezone offset is the worst of them', () => {
    // The regex is anchored at BOTH ends. Unanchored, '…+08:00' parsed its
    // prefix as UTC and silently ignored the offset — measured 8 hours wrong,
    // enough to flip a living loop to "stopped" (or a dead one to alive).
    expect(hoursSince('2026-08-10 12:00:00+08:00')).toBeNull();
    expect(hoursSince('2026-08-10 12:00:00Z')).toBeNull();
    expect(hoursSince('2026-08-10 12:00:00.123')).toBeNull();
    expect(hoursSince('2026-08-10 12:00:00 extra')).toBeNull();
    expect(hoursSince('junk 2026-08-10 12:00:00')).toBeNull();
    // The 'T' separator is the one variant we do accept.
    expect(hoursSince('2026-02-28T23:59:59')).not.toBeNull();
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
  // Must mirror doctor.ts LOCALE_README_FILES — the locale set was reduced
  // to en + zh-TW + de in commit bc6d8553.
  const LOCALES = ['de', 'zh-TW'];

  async function doctorOn(packageRoot: string) {
    return runDoctor({
      packageRoot,
      packageVersion: '4.2.3',
      openDatabaseImpl: () => makeDatabase(3) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source', canSelfUpdate: false,
        recommendedCommand: '', guidance: 'source checkout',
      }),
    });
  }

  it('passes when all locale READMEs match the English H2 count', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    for (const loc of LOCALES) fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(15));

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check).toBeDefined();
    expect(check.status).toBe('pass');
    expect(check.summary).toContain('All 2 locale READMEs');
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
      const count = loc === 'de' ? 12 : 15; // German is stale by 3 sections
      fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(count));
    }

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/README\.de\.md=12/);
    expect(check.fix).toBeTruthy();
  });

  it('warns when a locale README is missing entirely', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    // omit 繁體中文
    for (const loc of LOCALES.filter(l => l !== 'zh-TW')) {
      fs.writeFileSync(path.join(root, `README.${loc}.md`), buildReadme(15));
    }

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/missing: README\.zh-TW\.md/);
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
        detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
      // The registry consult reads the REAL machine by default; a dev box
      // with the plugin installed would flip this test without the seam.
      installedPluginsPathImpl: path.join(packageRoot, 'no-such-registry.json'),
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: (p: fs.PathLike) => p === dbPath || p === dbDir,
        // `statSync` is overloaded (it can return BigIntStats), so a
        // single-signature stub needs the two-step assertion TypeScript names
        // in the error rather than a direct one.
        statSyncImpl: ((p: fs.PathLike) => {
          if (p === dbPath) return { mode: 0o000, size: 1024 } as fs.Stats; // No permissions
          if (p === dbDir) return { mode: 0o700, size: 4096 } as fs.Stats;
          throw new Error('ENOENT');
        }) as unknown as typeof fs.statSync,
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
        detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({
          channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
          recommendedCommand: 'memesh update', guidance: '',
        }),
        existsSyncImpl: (p: fs.PathLike) => p === dbPath || p === dbDir,
        statSyncImpl: ((p: fs.PathLike) => {
          if (p === dbPath) return { mode: 0o600, size: 0 } as fs.Stats; // Empty file
          if (p === dbDir) return { mode: 0o700, size: 4096 } as fs.Stats;
          throw new Error('ENOENT');
        }) as unknown as typeof fs.statSync,
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
        detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
        detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
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

describe('SQLite and vector-search probe', () => {
  it('a sqlite-vec that will not load is a WARNING, not a failure', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace',
        label: 'Claude Code plugin marketplace',
        canSelfUpdate: false,
        recommendedCommand: 'memesh upgrade-plugin',
        guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: false, message: 'vec0.dylib could not be loaded' }),
    });

    const bindingCheck = result.checks.find((c) => c.id === 'native-binding');
    expect(bindingCheck).toBeDefined();
    // `warn`, deliberately. sqlite-vec is a supplement: memesh stores and
    // recalls perfectly well without it, on keyword search. Reporting `fail`
    // makes `memesh doctor` exit 1, which breaks every CI step, container
    // healthcheck and install script that gates on it — on a platform this
    // project documents as supported.
    expect(bindingCheck?.status).toBe('warn');
    expect(bindingCheck?.summary).toContain('sqlite-vec could not be loaded');
    // Says what the user LOSES, not just that something broke.
    expect(bindingCheck?.summary).toContain('still saved');
    expect(bindingCheck?.fix).toContain('npm install --omit=dev');
    expect(result.status, 'a supplement being absent must not fail the run').not.toBe('FAIL');
  });

  it('an unresolvable sqlite-vec warns, and names the install command', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({
        ok: false,
        message: "Cannot find module 'sqlite-vec' — code: MODULE_NOT_FOUND",
      }),
    });

    const bindingCheck = result.checks.find((c) => c.id === 'native-binding');
    expect(bindingCheck?.status).toBe('warn');
    expect(bindingCheck?.summary).toContain('not installed');
    expect(bindingCheck?.fix).toContain('npm install');
  });

  it('a Node too old to load extensions FAILS, and says to upgrade Node', async () => {
    // The one case in this row that really is fatal, and the one that used to
    // be misdiagnosed: node:sqlite exists from Node 22.5 but its extension
    // methods only landed in 22.13, so an old runtime yields
    // "enableLoadExtension is not a function" — which matched neither
    // classification branch and got reported as a missing sqlite-vec, sending
    // the user to reinstall a package that was never the problem.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({
        ok: false,
        message: 'memesh:node-sqlite-too-old: node:sqlite in v22.12.0 has no enableLoadExtension',
      }),
    });

    const bindingCheck = result.checks.find((c) => c.id === 'native-binding');
    expect(bindingCheck?.status).toBe('fail');
    expect(bindingCheck?.summary).toContain('22.13');
    expect(bindingCheck?.fix, 'sent the user to reinstall a package instead of upgrading Node')
      .toContain('Upgrade Node');
    expect(bindingCheck?.fix).not.toContain('npm install');
  });

  it('reports PASS when the probe succeeds (database opens + sqlite-vec loads)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.5',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    const bindingCheck = result.checks.find((c) => c.id === 'native-binding');
    expect(bindingCheck?.status).toBe('pass');
  });
});

describe('shell CLI on PATH check (plugin-without-global gotcha)', () => {
  it('WARNs when plugin-marketplace install has no shell-PATH memesh', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.6',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace', label: 'Claude Code plugin marketplace', canSelfUpdate: false,
        recommendedCommand: 'memesh upgrade-plugin', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
      resolveShellMemeshImpl: () => null,
    });

    const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
    expect(cliCheck?.status).toBe('warn');
    expect(cliCheck?.summary).toContain('not on the shell PATH');
    expect(cliCheck?.fix).toContain('npm install -g @pcircle/memesh');
  });

  it('PASSes plugin-marketplace install when a separate shell-PATH memesh exists', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.6',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace', label: 'Claude Code plugin marketplace', canSelfUpdate: false,
        recommendedCommand: 'memesh upgrade-plugin', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
      resolveShellMemeshImpl: () => '/usr/local/bin/memesh',
    });

    const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
    expect(cliCheck?.status).toBe('pass');
    expect(cliCheck?.summary).toContain('/usr/local/bin/memesh');
  });

  it('PASSes npm-global install regardless of which output (running from global = same path)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.6',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
      resolveShellMemeshImpl: () => path.join(packageRoot, 'dist/transports/cli/cli.js'),
    });

    const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
    expect(cliCheck?.status).toBe('pass');
  });

  it('is informational (not WARN) for source-checkout installs without shell CLI', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.2.6',
      openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source checkout', canSelfUpdate: false,
        recommendedCommand: null, guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
      resolveShellMemeshImpl: () => null,
    });

    const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
    expect(cliCheck?.status).toBe('pass');
    expect(cliCheck?.summary).toContain('informational');
  });
});

/**
 * The embedding probe row.
 *
 * Every embedder is now a live provider call (ollama socket / openai HTTP), so
 * the contract is: never probe without `--probe` (a diagnostic must not make a
 * billed or network call on its own), and when it does probe, report the real
 * outcome — pass, empty (degraded to FTS5), or threw — never a silent green.
 * Keyword-only (tfidf) is informational, not a failure.
 */
describe('doctor: embeddings probe', () => {
  function baseOptions(packageRoot: string, embeddings: Capabilities['embeddings']) {
    return {
      packageRoot,
      packageVersion: '4.2.7',
      openDatabaseImpl: () => makeDatabase(3) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, llm: null, embeddings }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source checkout', canSelfUpdate: false,
        recommendedCommand: null, guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    } as unknown as Parameters<typeof runDoctorImpl>[0];
  }

  /** Isolate MEMESH_DIR so each probe test sees only what we put there. */
  function withMemeshDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-embed-probe-'));
    tempRoots.push(dir);
    memeshDirOverrides.push(process.env.MEMESH_DIR);
    process.env.MEMESH_DIR = dir;
    return dir;
  }

  const memeshDirOverrides: (string | undefined)[] = [];

  afterEach(() => {
    for (const prev of memeshDirOverrides.splice(0)) {
      if (prev === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = prev;
    }
  });

  function findProbe(result: { checks: { id: string }[] }) {
    return result.checks.find((c) => c.id === 'embeddings_probe') as
      | { id: string; status: string; summary: string; fix?: string; informational?: boolean }
      | undefined;
  }

  it('does NOT probe a local ollama embedder without --probe (network call)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    let called = 0;
    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'ollama'),
      embedTextImpl: async () => { called++; return new Float32Array(768); },
    });

    const check = findProbe(result)!;
    expect(called).toBe(0);
    expect(check.informational).toBe(true);
    expect(check.summary).toContain('NOT VERIFIED');
    expect(check.fix).toContain('--probe');
  });

  it('does NOT bill the user: a BYOK provider is not probed without --probe', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    let called = 0;
    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'openai'),
      embedTextImpl: async () => { called++; return new Float32Array(1536); },
    });

    const check = findProbe(result)!;
    expect(called).toBe(0);
    expect(check.informational).toBe(true);
    expect(check.summary).toContain('NOT VERIFIED');
    expect(check.fix).toContain('memesh doctor --probe');
  });

  it('probes a BYOK provider once --probe is given', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    let called = 0;
    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'openai'),
      probeCapabilities: true,
      embedTextImpl: async () => { called++; return new Float32Array(1536); },
    });

    const check = findProbe(result)!;
    expect(called).toBe(1);
    expect(check.status).toBe('pass');
    expect(check.informational).toBeFalsy();
    expect(check.summary).toContain('1536-dim');
  });

  it('warns when a probed embedder returns nothing (the silent-degradation case)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'openai'),
      probeCapabilities: true,
      embedTextImpl: async () => null,
    });

    const check = findProbe(result)!;
    expect(check.status).toBe('warn');
    expect(check.informational).toBeFalsy();
    expect(check.summary).toContain('returned nothing');
  });

  it('warns when a probed embedder throws', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'openai'),
      probeCapabilities: true,
      embedTextImpl: async () => { throw new Error('401 invalid api key'); },
    });

    const check = findProbe(result)!;
    expect(check.status).toBe('warn');
    expect(check.summary).toContain('401 invalid api key');
  });

  it('reports no-embedder as informational, not as a failure', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    withMemeshDir();

    let called = 0;
    const result = await runDoctorImpl({
      ...baseOptions(packageRoot, 'tfidf'),
      embedTextImpl: async () => { called++; return new Float32Array(384); },
    });

    const check = findProbe(result)!;
    expect(called).toBe(0);
    expect(check.informational).toBe(true);
    expect(check.status).toBe('pass');
    expect(check.summary).toContain('FTS5');
  });
});
