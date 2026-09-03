import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
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
  return runDoctorImpl({ embedTextImpl: stubEmbedText, pluginCacheDiscoveryImpl: () => [], ...options });
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

function createPackageRoot(root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-'))): string {
  writeJson(path.join(root, '.claude-plugin', 'mcp.json'), {
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
    // Doctor derives the MCP manifest path from here rather than hardcoding
    // one, so a fixture without this field describes an install whose MCP
    // wiring Claude Code would fall back to auto-discovering at the root.
    mcpServers: './.claude-plugin/mcp.json',
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
    '.claude-plugin/mcp.json',
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
    /** Opt a test into the citation-compliance row. Absent = no accounted
     *  sessions, which is what every test predating that row assumes. */
    citationCounters?: { total?: number; cited?: number };
    /** Auto-capture memories written in the last 24 hours. Defaults to the
     *  shared `count`, so every test that predates the split reads exactly
     *  what it read before. */
    capturedLast24h?: number;
    /** Auto-capture memories written since heartbeat tracking began — the
     *  legacy-hooks branch. Same default, same reason. */
    capturedSinceTracking?: number;
    /** How many active memories the vector index still owes. Default 0 —
     *  every test predating the measured Vector Index row assumes a graph
     *  that is fully embedded. */
    missingVectors?: number;
    /** Make every read of `llm_telemetry` throw — a database from before the
     *  table existed, or one whose table cannot be read. Default false. */
    telemetryUnreadable?: boolean;
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
      // Two queries touch the vector table, and they answer different
      // questions: `SELECT 1 ... LIMIT 1` asks whether THIS PROCESS can use
      // the index at all (a throw is how absence is reported), and the
      // COUNT asks how many active memories it still owes.
      if (sql.includes('entities_vec')) {
        return sql.includes('COUNT(')
          ? { get: () => ({ n: opts.missingVectors ?? 0 }) }
          : { get: () => undefined };
      }
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
      // The citation-compliance row reads two counters the Stop hook keeps.
      // Default is ABSENT for both, which is what every test written before
      // that row assumed: no accounted sessions, so no row is emitted and no
      // verdict moves. `citationCounters` opts a test into the other states.
      if (sql.includes('citation_sessions_total')) {
        return { get: () => (opts.citationCounters?.total === undefined
          ? undefined
          : { value: String(opts.citationCounters.total) }) };
      }
      if (sql.includes('citation_sessions_cited')) {
        return { get: () => (opts.citationCounters?.cited === undefined
          ? undefined
          : { value: String(opts.citationCounters.cited) }) };
      }
      if (sql.includes('source_host')) {
        return { get: () => ({ c: opts.recentClaudeCodeWrites ?? 1 }) };
      }
      // llm_telemetry health (D13): every test in this file predates the
      // row and asserts nothing about it, so the default is "no telemetry
      // recorded" — the same "opt-in options, default absent" convention
      // as citationCounters above. A real predicate (window filtering,
      // per-flow grouping) is exercised against a real database in
      // tests/cli/doctor-llm-telemetry-health.test.ts, not here.
      if (sql.includes('FROM llm_telemetry')) {
        if (opts.telemetryUnreadable) throw new Error('no such table: llm_telemetry');
        return { all: () => [] };
      }
      // Three DIFFERENT questions used to share one canned answer.
      //
      // The default branch below returns `{ c: count }` for every query
      // containing `COUNT(`, so `captured` (auto-capture tag, last 24h),
      // `legacyCaptured` (same tag, since tracking began) and the total
      // entity count all read the same number — and a row that consulted
      // the wrong one of the three produced the right verdict for the wrong
      // reason, with the test unable to tell. Each now has its own value,
      // and a test that wants a specific branch has to seed the specific
      // query that drives it.
      if (sql.includes("e.created_at > datetime('now', '-24 hours')")) {
        return { get: () => ({ c: opts.capturedLast24h ?? count }) };
      }
      if (sql.includes('e.created_at > ?')) {
        return { get: () => ({ c: opts.capturedSinceTracking ?? count }) };
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
    llmSource: 'none',
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
    // This scenario is "an install that has been around a while and STILL
    // has never completed an update check" (a real concern, e.g. no
    // internet ever) — not a brand-new install, which gets a 24h grace
    // period. Without this, the temp dir's install.json would be
    // lazily created with created_at = now, and the fresh-install grace
    // period would turn the WARN this test exists to pin into a PASS.
    writeJson(path.join(memeshDir, 'install.json'), {
      install_id: 'test-established-install',
      created_at: '2020-01-01T00:00:00.000Z',
      schema_version: 1,
    });
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

  it('a fresh install with no update check yet is not a concern (M-10)', async () => {
    // The same "no cache" state as the test above, but on an install
    // still inside its 24h grace period — the same period
    // inspectHookWiring already gives a brand-new hook install. It has
    // not had a CHANCE to check yet, which is not evidence of anything.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-fresh-'));
    tempRoots.push(memeshDir);
    const originalMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = memeshDir;
    // No install.json pre-seeded: getInstallRecord() lazily creates one
    // with created_at = now, which IS the fresh-install shape.

    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.7.1',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => null,
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    if (originalMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalMemeshDir;

    const updateCheck = result.checks.find((check) => check.id === 'update-status');
    expect(updateCheck?.status, `a fresh install should not warn: ${updateCheck?.summary}`).toBe('pass');
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
    fs.writeFileSync(path.join(packageRoot, '.claude-plugin', 'mcp.json'), '{invalid');

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
      // `path.join`, not a literal: the fix line names the ABSOLUTE path of
      // the file to edit, which is what a user needs, and on Windows that
      // carries backslashes. A hardcoded '.claude-plugin/mcp.json' passed on
      // macOS and Linux and failed on both Windows legs of CI — the assertion
      // was platform-dependent, the code was not.
      fix: expect.stringContaining(path.join('.claude-plugin', 'mcp.json')),
    });
  });

  it('fails when the MCP manifest starts a script that is not in the install', async () => {
    // The defect this was written for: the MCP entry point was renamed,
    // `package.json` bin and `npm start` were repointed, and the manifest kept
    // naming the deleted file. Every MCP tool died with
    // `-32000 failed to reconnect` — and doctor reported PASS, because it
    // stopped at "there is a string `command`" and never looked at what the
    // config actually starts. A config that names a file which is not there is
    // not a valid config.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    writeJson(path.join(packageRoot, '.claude-plugin', 'mcp.json'), {
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

  it('passes when the MCP manifest starts a script that IS present', async () => {
    // The guard must not become "always fail": a correct config still passes,
    // and the check really does resolve the path rather than rejecting any
    // config that has args at all. `plugin-marketplace` is the channel where
    // Claude Code really does substitute ${CLAUDE_PLUGIN_ROOT}, so it is the
    // only one on which resolving against `packageRoot` is honest.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'dist', 'mcp', 'server.js'), '// present\n');
    writeJson(path.join(packageRoot, '.claude-plugin', 'mcp.json'), {
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
      getCurrentInstallChannelImpl: () => 'plugin-marketplace',
      getInstallChannelSupportImpl: () => ({
        channel: 'plugin-marketplace', label: 'Claude Code plugin marketplace',
        canSelfUpdate: false, recommendedCommand: 'memesh upgrade-plugin', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    expect(result.checks.find((c) => c.id === 'mcp-config')?.status).toBe('pass');
  });

  it('does NOT claim the entry exists on a channel that never substitutes ${CLAUDE_PLUGIN_ROOT}', async () => {
    // The reason Defect 1 survived three and a half months behind a green row.
    //
    // The check substituted `packageRoot` for ${CLAUDE_PLUGIN_ROOT}
    // unconditionally, on the strength of a comment claiming Claude Code does
    // that. Claude Code does — but only for a `plugin-marketplace` install.
    // On `source-checkout` and `npm-global` the substitution was
    // self-fulfilling: it rebuilt a path that exists by construction, so this
    // branch could not fail, whatever the manifest said. Here the target does
    // NOT exist and the placeholder cannot be resolved, and the row must say
    // so rather than report a pass it did not earn.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    writeJson(path.join(packageRoot, '.claude-plugin', 'mcp.json'), {
      mcpServers: {
        memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] },
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
      getCurrentInstallChannelImpl: () => 'source-checkout',
      getInstallChannelSupportImpl: () => ({
        channel: 'source-checkout', label: 'source checkout', canSelfUpdate: false,
        recommendedCommand: 'git pull', guidance: '',
      }),
      envImpl: {},
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    const check = result.checks.find((c) => c.id === 'mcp-config');
    expect(check?.status).toBe('warn');
    expect(check?.code).toBe('mcp-config.placeholder-unresolved');
    expect(check?.summary).toContain('NOT VERIFIED');
    expect(check?.summary).not.toContain('the script it starts exists');
  });

  it('resolves against CLAUDE_PLUGIN_ROOT when the environment actually provides one', async () => {
    // The other half of the same rule: when something really does define the
    // variable, the check must use THAT value and go back to being able to
    // fail. `packageRoot` here carries the manifest; the plugin root is a
    // different directory that does not carry the script.
    const packageRoot = createPackageRoot();
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-plugin-root-'));
    tempRoots.push(packageRoot, pluginRoot);
    fs.mkdirSync(path.join(packageRoot, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'dist', 'mcp', 'server.js'), '// present\n');
    writeJson(path.join(packageRoot, '.claude-plugin', 'mcp.json'), {
      mcpServers: {
        memesh: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'] },
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
      envImpl: { CLAUDE_PLUGIN_ROOT: pluginRoot },
      nativeBindingProbeImpl: () => ({ ok: true }),
    });

    const check = result.checks.find((c) => c.id === 'mcp-config');
    expect(check?.status).toBe('fail');
    expect(check?.code).toBe('mcp-config.entry-missing');
  });

  it('fails when plugin.json declares an mcpServers path but that file does not exist', async () => {
    // Distinct from the "declares no mcpServers path" case below: here the
    // manifest DOES name a file, it just is not there — a different early
    // return in inspectMcpConfig (existsSyncImpl(mcpPath) false, not
    // relativeManifest === null), and the only test that touches
    // 'mcp-config.missing' before this one exercises the other branch.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    // createPackageRoot() already writes both plugin.json (with this same
    // mcpServers declaration) and .claude-plugin/mcp.json — remove the
    // latter to get the state this test actually needs: declared but gone.
    fs.rmSync(path.join(packageRoot, '.claude-plugin', 'mcp.json'));

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
    expect(check?.code).toBe('mcp-config.missing');
    expect(check?.summary).toContain('.claude-plugin/mcp.json is missing');
  });

  it('fails when .claude-plugin/plugin.json declares no mcpServers path', async () => {
    // With no declared path Claude Code falls back to auto-discovering
    // `.mcp.json` at the plugin root — the project-scoped path where
    // ${CLAUDE_PLUGIN_ROOT} is undefined. Losing the declaration is losing the
    // fix, so it is a failure, not a silent default.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    writeJson(path.join(packageRoot, '.claude-plugin', 'plugin.json'), {
      name: 'memesh',
      version: '4.1.4',
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
    expect(check?.code).toBe('mcp-config.missing');
    expect(check?.summary).toContain('mcpServers');
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
  // F1 (2026-09-02 dogfood) — a cached "is current" claim must name its own
  // age. Repro on a real machine: an npm-global install's cache said
  // latestVersion=4.8.2 (true when written), doctor read it ~23h44m later
  // (inside the 24h STALE_AFTER_MS window, so still 'cached' not 'stale')
  // and printed the unqualified `[PASS] Version 4.8.2 is current.` at the
  // exact moment npm had already published 4.8.3.
  // ===========================================================================
  it('update-status: the cached-PASS branch states how old the check is, not an unqualified "is current"', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.8.2',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        currentVersion: '4.8.2',
        latestVersion: '4.8.2',
        updateAvailable: false,
        lastSuccessfulCheckAt: twoHoursAgo,
        freshness: 'cached',
      }),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });

    const updateCheck = result.checks.find((c) => c.id === 'update-status');
    expect(updateCheck?.status).toBe('pass');
    expect(updateCheck?.summary).toContain('As of the last check');
    expect(updateCheck?.summary).toContain('2 hours ago');
    // The literal bug: this exact sentence, with no way to tell a check made
    // 23h59m ago apart from one made a minute ago.
    expect(updateCheck?.summary).not.toBe(`Version ${'4.8.2'} is current.`);
  });

  it('update-status: the stale branch also names the check age, not just "is stale"', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
    const result = await runDoctor({
      packageRoot,
      packageVersion: '4.8.2',
      openDatabaseImpl: () => makeDatabase() as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck({
        currentVersion: '4.8.2',
        latestVersion: '4.8.2',
        updateAvailable: false,
        lastSuccessfulCheckAt: twoDaysAgo,
        freshness: 'stale',
      }),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: 'This installation can be updated directly from MeMesh.',
      }),
    });

    const updateCheck = result.checks.find((c) => c.id === 'update-status');
    expect(updateCheck?.status).toBe('warn');
    expect(updateCheck?.code).toBe('update-status.stale');
    expect(updateCheck?.summary).toContain('As of the last check');
    expect(updateCheck?.summary).toContain('2 days ago');
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

  it('llm-telemetry health: a telemetry table doctor cannot read is not a finding, and not a crash', async () => {
    // inspectLlmTelemetryHealth swallows the read failure and returns
    // undefined: a database from before `llm_telemetry` existed has nothing
    // to diagnose, and reporting it as broken — or letting the throw escape
    // into runDoctor's outer catch, which would print it as a database
    // failure — would both be claims about a table nobody read. Every other
    // test in this file gives the stub an empty table, so this branch had no
    // test that could go red until this one.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const { result } = await activityCheck(
      hookActivityDoctorArgs(packageRoot, makeDatabase(0, { telemetryUnreadable: true })),
    );
    expect(result.checks.some(c => c.code === 'llm-telemetry.silent-failure')).toBe(false);
    const leaked = result.checks.filter(c => /llm_telemetry/.test(`${c.summary} ${c.fix ?? ''}`));
    expect(leaked.map(c => c.id), 'the read failure must not surface as any check').toEqual([]);
    // The discriminating assertion: `database` is pushed 'pass' before this
    // health check runs, then `dbChecks.length = 0` in runDoctor's outer
    // catch would silently replace it with a 'fail' row if this function's
    // local catch ever let the read failure escape instead of swallowing
    // it — the two assertions above stay green even then, because the
    // outer catch's diagnosis branches on file existence, not on this
    // error's message, so neither ever mentions "llm_telemetry".
    expect(result.checks.find(c => c.id === 'database')?.status).toBe('pass');
  });

  it('hook-activity: the 24h count and the since-tracking count are different questions', async () => {
    // Three probes shared one canned answer in this fixture, so a row that
    // consulted the WRONG query produced the right verdict for the wrong
    // reason and nothing could tell. Here the two counts disagree on
    // purpose: nothing captured in the last 24 hours, five captured since
    // tracking began.
    //
    // A hook that ran two hours ago and captured nothing in that window is
    // the healthy quiet case, and the summary must say so — reading the
    // all-time count instead would report "5 memories captured in the last
    // 24h" about a day in which none were.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);

    const { activity } = await activityCheck({
      ...hookActivityDoctorArgs(packageRoot, makeDatabase(0, {
        hookRuns: [{ hook: 'session-summary', hoursAgo: 2 }],
        capturedLast24h: 0,
        capturedSinceTracking: 5,
      })),
      existsSyncImpl: noMarker,
    });

    expect(activity.status).toBe('pass');
    expect(activity.summary, 'the 24h window reported the all-time count')
      .not.toMatch(/5 memor/);
    expect(activity.summary, 'the quiet-but-alive wording is gone')
      .toMatch(/nothing was worth saving/i);
  });

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

  it('warns when a locale README is missing while at least one sibling is present', async () => {
    // A real dev checkout has every locale present. If it doesn't — a
    // translation was dropped, or a new locale was added to the list and
    // one file forgotten — the AT-LEAST-ONE-PRESENT signal below distinguishes
    // that genuine drift from a packaged install, which has none at all.
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

  it('skips silently when README.md is not present (an even more minimal tarball)', async () => {
    const root = createPackageRoot();
    tempRoots.push(root);
    // No README.md at all.
    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/check skipped/);
  });

  it('skips silently when README.md is present but no locale READMEs are — the real shape of every npm install', async () => {
    // npm always includes README.md in a published tarball (and this
    // package's `files` lists it explicitly too), so it is NOT the signal
    // for "packaged install without docs" the check above treats it as.
    // The locale READMEs are the ones actually absent from `files` — this
    // is what every real end-user's install looks like, and it must not
    // warn "missing: README.de.md, README.zh-TW.md" at them.
    const root = createPackageRoot();
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), buildReadme(15));
    // No locale READMEs at all — the real packaged shape.

    const result = await doctorOn(root);
    const check = result.checks.find(c => c.id === 'readme_locale_parity')!;
    expect(check.status, `a real npm install should never see: ${check.summary}`).toBe('pass');
    expect(check.summary).toMatch(/check skipped/);
  });
});

describe('Install ID (doctor sub-check)', () => {
  it('names the resolved MEMESH_DIR, not a hardcoded ~/.memesh', async () => {
    // Every other row that names a path on disk (database, hook markers)
    // resolves it through memeshDir()/getDbPath(), which respect the
    // MEMESH_DIR override the test harness (and MEMESH_DIR-configured
    // installs) use. This row used to print the literal string
    // `~/.memesh/install.json` regardless of where the file actually was.
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const customMemeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-installid-'));
    tempRoots.push(customMemeshDir);
    const original = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = customMemeshDir;

    try {
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.7.1',
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
      const check = result.checks.find(c => c.id === 'install_id')!;
      expect(check).toBeDefined();
      expect(check.summary).toContain(path.join(customMemeshDir, 'install.json'));
      expect(check.summary).not.toContain('~/.memesh');
    } finally {
      if (original === undefined) delete process.env.MEMESH_DIR;
      else process.env.MEMESH_DIR = original;
    }
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

  describe('shell CLI is a distinct COPY, and can be on a different version (F1b)', () => {
    // `which`/`where` return a PATH entry, and every packaged install ships
    // `memesh` as a symlink into node_modules — `readVersionFromInstalledBinary`
    // follows it with `fs.realpathSync` (not injectable) then walks UP from
    // there looking for package.json via the injected existsSyncImpl /
    // readFileSyncImpl. The fake path here doesn't exist on the real
    // filesystem, so realpathSync throws and the walk falls back to the raw
    // path — exactly the fallback the implementation is written to take —
    // which is why two directories separate the fake binary from its fake
    // package.json below (mirroring a real, if shallower, install layout).
    function fakeShellCli(version: string | null) {
      const shellBin = path.join('/fake-shell-cli-f1b', 'nvm', 'bin', 'memesh');
      const shellPkgPath = path.join('/fake-shell-cli-f1b', 'package.json');
      const existsSyncImpl = ((p: fs.PathLike) => {
        if (p === shellPkgPath) return version !== null;
        return fs.existsSync(p);
      }) as typeof fs.existsSync;
      const readFileSyncImpl = ((p: fs.PathLike, enc?: unknown) => {
        if (p === shellPkgPath) return JSON.stringify({ name: '@pcircle/memesh', version });
        return (fs.readFileSync as (path: fs.PathLike, options?: unknown) => string | Buffer)(p, enc);
      }) as typeof fs.readFileSync;
      return { shellBin, existsSyncImpl, readFileSyncImpl };
    }

    async function runWithShellCli(packageRoot: string, packageVersion: string, shell: ReturnType<typeof fakeShellCli> | { shellBin: string }) {
      return runDoctor({
        packageRoot,
        packageVersion,
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
        resolveShellMemeshImpl: () => shell.shellBin,
        ...('existsSyncImpl' in shell ? { existsSyncImpl: shell.existsSyncImpl, readFileSyncImpl: shell.readFileSyncImpl } : {}),
      });
    }

    it('WARNs and names both versions when the shell CLI is BEHIND this install', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const result = await runWithShellCli(packageRoot, '4.8.3', fakeShellCli('4.8.2'));

      const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
      expect(cliCheck?.status).toBe('warn');
      expect(cliCheck?.summary).toContain('4.8.2');
      expect(cliCheck?.summary).toContain('4.8.3');
      expect(cliCheck?.summary).toContain('behind');
      expect(cliCheck?.fix).toContain('npm install -g @pcircle/memesh@latest');
    });

    it('WARNs and points at the plugin refresh command when THIS (plugin) install is BEHIND the shell CLI', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const result = await runWithShellCli(packageRoot, '4.8.3', fakeShellCli('4.9.0'));

      const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
      expect(cliCheck?.status).toBe('warn');
      expect(cliCheck?.summary).toContain('ahead');
      // This fixture's packageRoot is a bare temp directory, so
      // `detectPluginHost` returns null — the "plugin-marketplace install
      // whose host cannot be determined" case. The advice must not pick one
      // host: `?? 'claude-code'` handed a Codex user `memesh upgrade-plugin`,
      // which does nothing for them, and nothing in the message said it was a
      // guess. Both commands, or neither.
      expect(cliCheck?.fix).toContain('memesh upgrade-plugin');
      expect(cliCheck?.fix, 'the undetectable-host case named only one host')
        .toContain('codex plugin marketplace upgrade');
    });

    it('names ONLY the host it actually detected, when it can detect one', async () => {
      // The other side of the same predicate, and the reason the test above
      // is not simply "always print both": a Claude Code plugin install must
      // not be told to run Codex commands. `detectPluginHost` matches on the
      // plugin cache segment in the resolved path, so a packageRoot under
      // `.claude/plugins/cache/` is a detectable host.
      const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-plugincache-'));
      tempRoots.push(cacheRoot);
      const packageRoot = createPackageRoot(
        path.join(cacheRoot, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh'),
      );
      const result = await runWithShellCli(packageRoot, '4.8.3', fakeShellCli('4.9.0'));

      const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
      expect(cliCheck?.status).toBe('warn');
      expect(cliCheck?.fix).toContain('memesh upgrade-plugin');
      expect(cliCheck?.fix, 'a detected Claude Code host was still offered the Codex command')
        .not.toContain('codex plugin marketplace upgrade');
    });

    it('stays PASS and states the shared version when both copies agree', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const result = await runWithShellCli(packageRoot, '4.8.3', fakeShellCli('4.8.3'));

      const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
      expect(cliCheck?.status).toBe('pass');
      expect(cliCheck?.summary).toContain('both on 4.8.3');
    });

    it('stays PASS but says so honestly when the shell copy\'s version cannot be read — it does not claim agreement', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      // No existsSyncImpl/readFileSyncImpl override: the walk runs against
      // the real filesystem and finds no package.json under this fake path,
      // so the version genuinely cannot be determined.
      const result = await runWithShellCli(packageRoot, '4.8.3', { shellBin: '/fake-shell-cli-unreadable/bin/memesh' });

      const cliCheck = result.checks.find((c) => c.id === 'shell-cli');
      expect(cliCheck?.status).toBe('pass');
      expect(cliCheck?.summary).toContain('could not read');
    });
  });

  describe('plugin-cache: same version is not same code', () => {
    // Claude Code keys the plugin cache by version. A cache staged from an
    // earlier commit under the same version is never refreshed, and every
    // version-based check says it is current. The registry's gitCommitSha
    // against the marketplace checkout's HEAD is the only honest comparison.
    const PLUGIN_SUPPORT = {
      channel: 'plugin-marketplace' as const, label: 'Claude Code plugin marketplace', canSelfUpdate: false,
      recommendedCommand: 'memesh upgrade-plugin', guidance: '',
    };
    function registryWith(packageRoot: string, entry: Record<string, unknown>): string {
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [entry] } }));
      return registry;
    }
    async function run(packageRoot: string, registry: string, marketplaceSha: string | null, channel: 'plugin-marketplace' | 'npm-global' = 'plugin-marketplace', discovery: Array<{ host: 'claude-code' | 'codex'; packageRoot: string; installedPluginsPath?: string }> = [], codexMarketplaceSha: string | null = marketplaceSha) {
      return runDoctor({
        packageRoot,
        packageVersion: '4.8.2',
        openDatabaseImpl: () => makeDatabase(1) as never,
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => channel,
        getInstallChannelSupportImpl: () => PLUGIN_SUPPORT,
        installedPluginsPathImpl: registry,
        marketplaceHeadShaImpl: (host) => host === 'codex' ? codexMarketplaceSha : marketplaceSha,
        pluginCacheDiscoveryImpl: () => discovery,
        nativeBindingProbeImpl: () => ({ ok: true }),
        resolveShellMemeshImpl: () => null,
      });
    }
    async function runWithDefaultDiscovery(
      packageRoot: string,
      marketplaceSha?: string | null,
      codexMarketplaceSha: string | null | undefined = marketplaceSha,
    ) {
      return runDoctor({
        packageRoot,
        packageVersion: '4.8.2',
        openDatabaseImpl: () => makeDatabase(1) as never,
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'npm-global',
        getInstallChannelSupportImpl: () => ({ channel: 'npm-global', label: 'npm global', canSelfUpdate: true, recommendedCommand: 'memesh update', guidance: '' }),
        marketplaceHeadShaImpl: marketplaceSha === undefined
          ? undefined
          : (host) => host === 'codex' ? (codexMarketplaceSha ?? null) : marketplaceSha,
        nativeBindingProbeImpl: () => ({ ok: true }),
        resolveShellMemeshImpl: () => null,
        pluginCacheDiscoveryImpl: undefined,
      });
    }
    async function withIsolatedPluginHome(body: (isolatedHome: string, codexHome: string) => Promise<void>) {
      const previousHome = process.env.HOME;
      const previousCodexHome = process.env.CODEX_HOME;
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-home-'));
      const codexHome = path.join(isolatedHome, 'codex-home');
      tempRoots.push(isolatedHome);
      try {
        process.env.HOME = isolatedHome;
        process.env.CODEX_HOME = codexHome;
        delete process.env.CLAUDE_CONFIG_DIR;
        await body(isolatedHome, codexHome);
      } finally {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
        if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }

    it('WARNs when the cache was staged from an older commit than the marketplace has, same version', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = registryWith(packageRoot, { installPath: packageRoot, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
      const result = await run(packageRoot, registry, 'b'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.stale');
      expect(check?.summary).toContain('aaaaaaaa');
      expect(check?.summary).toContain('bbbbbbbb');
      expect(check?.fix).toContain('memesh upgrade-plugin');
    });

    it('PASSes when the registry commit is the marketplace HEAD', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = registryWith(packageRoot, { installPath: packageRoot, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('pass');
      expect(check?.code).toBeUndefined();
    });

    it('reads the real default Claude marketplace HEAD in an isolated HOME', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const marketplace = path.join(isolatedHome, '.claude', 'plugins', 'marketplaces', 'pcircle-memesh');
        fs.mkdirSync(marketplace, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', args, { cwd: marketplace, encoding: 'utf8' }).trim();
        git('init', '-q');
        fs.writeFileSync(path.join(marketplace, 'fixture.txt'), 'marketplace fixture\n');
        git('add', 'fixture.txt');
        git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
        const marketplaceSha = git('rev-parse', 'HEAD');

        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const registry = registryWith(packageRoot, {
          installPath: packageRoot,
          version: '4.8.2',
          gitCommitSha: marketplaceSha,
        });
        const result = await runDoctor({
          packageRoot,
          packageVersion: '4.8.2',
          openDatabaseImpl: () => makeDatabase(1) as never,
          closeDatabaseImpl: () => undefined,
          detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
          getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
          getUpdateCheckImpl: async () => makeUpdateCheck(),
          getCurrentInstallChannelImpl: () => 'plugin-marketplace',
          getInstallChannelSupportImpl: () => PLUGIN_SUPPORT,
          installedPluginsPathImpl: registry,
          nativeBindingProbeImpl: () => ({ ok: true }),
          resolveShellMemeshImpl: () => null,
        });

        const check = result.checks.find((c) => c.id === 'plugin-cache');
        expect(check?.status).toBe('pass');
        expect(check?.summary).toContain(marketplaceSha.slice(0, 8));
      });
    });

    it('honors CLAUDE_CONFIG_DIR for default Claude discovery and marketplace lookup', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const claudeConfig = path.join(isolatedHome, 'relocated-claude-config');
        process.env.CLAUDE_CONFIG_DIR = claudeConfig;
        const marketplace = path.join(claudeConfig, 'plugins', 'marketplaces', 'pcircle-memesh');
        fs.mkdirSync(marketplace, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', args, { cwd: marketplace, encoding: 'utf8' }).trim();
        git('init', '-q');
        fs.writeFileSync(path.join(marketplace, 'fixture.txt'), 'relocated marketplace fixture\n');
        git('add', 'fixture.txt');
        git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
        const marketplaceSha = git('rev-parse', 'HEAD');

        const claudeRoot = path.join(claudeConfig, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        fs.mkdirSync(claudeRoot, { recursive: true });
        writeJson(path.join(claudeConfig, 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [{ installPath: claudeRoot, gitCommitSha: marketplaceSha }] },
        });
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);

        const result = await runWithDefaultDiscovery(packageRoot);
        const check = result.checks.find(c => c.id === 'plugin-cache-claude-code');
        expect(check, JSON.stringify(result.checks.map(c => c.id))).toBeDefined();
        expect(check?.status).toBe('pass');
        expect(check?.summary).toContain(marketplaceSha.slice(0, 8));
        const wiring = result.checks.find(c => c.id === 'hook-wiring');
        expect(wiring?.status).toBe('pass');
        expect(wiring?.summary).toMatch(/plugin runtime/i);
      });
    });

    it('WARNs instead of using a sole registry entry that names another install', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = registryWith(packageRoot, {
        installPath: '/another/plugin/cache/4.8.2',
        version: '4.8.2',
        gitCommitSha: 'a'.repeat(40),
      });
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toMatch(/only memesh entry.*another install/i);
    });

    it('WARNs when a sole legacy registry entry has no installPath to bind it to this cache', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = registryWith(packageRoot, { version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toMatch(/no usable installPath/i);
    });

    it('WARNs "could not tell" rather than PASS when the registry carries no commit', async () => {
      // Absence is not evidence: a registry written by an older Claude Code
      // (or by hand) has no gitCommitSha, and "unknown" must not read as current.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = registryWith(packageRoot, { installPath: packageRoot, version: '4.8.2' });
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
    });

    it('names an unreadable installed_plugins.json instead of saying only that its commit is missing', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, '{broken');
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.summary).toMatch(/installed_plugins\.json could not be read or parsed/i);
    });

    it('names a missing installed_plugins.json precisely', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const missingRegistry = path.join(packageRoot, 'missing-installed-plugins.json');
      const result = await run(packageRoot, missingRegistry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.summary).toMatch(/installed_plugins\.json does not exist/i);
      expect(check?.summary).toContain(missingRegistry);
    });

    it('names a readable Claude registry with no MeMesh key precisely', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'other@marketplace': [] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.summary).toMatch(/has no memesh@pcircle-memesh entry/i);
    });

    it('WARNs instead of throwing when the Claude registry contains a non-array MeMesh entry', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({
        plugins: { 'memesh@pcircle-memesh': { installPath: packageRoot, gitCommitSha: 'a'.repeat(40) } },
      }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toMatch(/malformed memesh entry/i);
    });

    it('names an empty Claude registry entry as no active install', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.summary).toMatch(/records no active memesh install/i);
    });

    it('WARNs instead of passing when a valid Claude entry is mixed with malformed data', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
        { installPath: packageRoot, version: '4.8.2', gitCommitSha: 'a'.repeat(40) },
        null,
      ] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toMatch(/malformed memesh entry/i);
    });

    it('Codex: WARNs from the .codex-marketplace-install.json revision, and the fix is upgrade + add', async () => {
      // Codex has no installed_plugins.json; it copies the marketplace's
      // install record into the cache.
      const src = createPackageRoot();
      tempRoots.push(src);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-codex-'));
      tempRoots.push(base);
      const packageRoot = path.join(base, '.codex', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
      fs.cpSync(src, packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, '.codex-marketplace-install.json'), JSON.stringify({ source_type: 'git', revision: 'a'.repeat(40) }));
      const seenHosts: string[] = [];
      const result = await runDoctor({
        packageRoot,
        packageVersion: '4.8.2',
        openDatabaseImpl: () => makeDatabase(1) as never,
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'plugin-marketplace',
        getInstallChannelSupportImpl: () => PLUGIN_SUPPORT,
        installedPluginsPathImpl: path.join(base, 'no-such-registry.json'),
        marketplaceHeadShaImpl: (host) => { seenHosts.push(host); return 'b'.repeat(40); },
        nativeBindingProbeImpl: () => ({ ok: true }),
        resolveShellMemeshImpl: () => null,
      });
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(seenHosts).toEqual(['codex']);
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.stale');
      expect(check?.summary).toContain('Codex');
      expect(check?.fix).toMatch(/codex plugin marketplace upgrade pcircle-memesh && codex plugin add memesh@pcircle-memesh/);
      // `add` replaces a same-version cache atomically (verified on codex-cli
      // 0.150.1); a `remove` first would leave nothing installed if `add` failed.
      expect(check?.fix).not.toContain('remove');
      expect(check?.fix).not.toContain('upgrade-plugin');
      expect(check?.params).toMatchObject({ host: 'Codex', installed: 'aaaaaaaa', marketplace: 'bbbbbbbb' });
    });

    it('reads the real default Codex marketplace revision without an injected reader', async () => {
      await withIsolatedPluginHome(async (_isolatedHome, codexHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const codexRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        const marketplaceRoot = path.join(codexHome, '.tmp', 'marketplaces', 'pcircle-memesh');
        fs.mkdirSync(codexRoot, { recursive: true });
        fs.mkdirSync(marketplaceRoot, { recursive: true });
        writeJson(path.join(codexRoot, '.codex-marketplace-install.json'), { revision: 'a'.repeat(40) });
        writeJson(path.join(marketplaceRoot, '.codex-marketplace-install.json'), { revision: 'b'.repeat(40) });

        const result = await runWithDefaultDiscovery(packageRoot);
        const check = result.checks.find(c => c.id === 'plugin-cache-codex');
        expect(check, JSON.stringify(result.checks.map(c => c.id))).toBeDefined();
        expect(check?.status).toBe('warn');
        expect(check?.code).toBe('plugin-cache.stale');
        expect(check?.summary).toContain('aaaaaaaa');
        expect(check?.summary).toContain('bbbbbbbb');
        expect(check?.fix).toContain('codex plugin marketplace upgrade pcircle-memesh');
      });
    });

    it('reads the registry entry for THIS install when several scopes are listed', async () => {
      // Claude Code keeps one entry per scope (user / project / local).
      // entries[0] on a two-scope machine is another cache: here it is stale
      // while this install's entry is current, so entries[0] would WARN.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
        { installPath: '/somewhere/else/4.8.2', version: '4.8.2', scope: 'project', gitCommitSha: 'c'.repeat(40) },
        { installPath: packageRoot, version: '4.8.2', scope: 'user', gitCommitSha: 'a'.repeat(40) },
      ] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('pass');
    });

    it('WARNs instead of passing when duplicate entries name the same install path', async () => {
      // A duplicated registry row is not two independently valid scopes: both
      // claim to be the identity for this exact cache. Picking matching[0]
      // would let a current first row hide a stale or corrupted duplicate.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
        { installPath: packageRoot, version: '4.8.2', scope: 'user', gitCommitSha: 'a'.repeat(40) },
        { installPath: packageRoot, version: '4.8.2', scope: 'project', gitCommitSha: 'b'.repeat(40) },
      ] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toMatch(/2 memesh entries.*this install/i);
    });

    it('WARNs "could not tell" when several entries are listed and none is this install', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
        { installPath: '/x/4.8.2', version: '4.8.2', gitCommitSha: 'a'.repeat(40) },
        { installPath: '/y/4.8.2', version: '4.8.2', gitCommitSha: 'a'.repeat(40) },
      ] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40));
      const check = result.checks.find((c) => c.id === 'plugin-cache');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
      expect(check?.summary).toContain('none of them is this install');
    });

    it('reports distinct Claude PASS and Codex stale WARN checks from npm-global', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const claudeRoot = createPackageRoot();
      const codexRoot = createPackageRoot();
      tempRoots.push(claudeRoot, codexRoot);
      const registry = registryWith(claudeRoot, { installPath: claudeRoot, version: '4.8.2', gitCommitSha: 'a'.repeat(40) });
      const codexMarker = path.join(codexRoot, '.codex-marketplace-install.json');
      fs.writeFileSync(codexMarker, JSON.stringify({ revision: 'a'.repeat(40) }));
      const result = await run(packageRoot, registry, 'a'.repeat(40), 'npm-global', [
        { host: 'claude-code', packageRoot: claudeRoot, installedPluginsPath: registry },
        { host: 'codex', packageRoot: codexRoot },
      ], 'b'.repeat(40));
      expect(result.checks.find((c) => c.id === 'plugin-cache-claude-code')?.status).toBe('pass');
      expect(result.checks.find((c) => c.id === 'plugin-cache-codex')?.status).toBe('warn');
      expect(result.checks.find((c) => c.id === 'plugin-cache-codex')?.code).toBe('plugin-cache.stale');
      expect(result.checks.find((c) => c.id === 'plugin-cache-codex')?.fix).toContain('codex plugin marketplace upgrade pcircle-memesh');
    });

    it('WARNs an installed host when either revision is unverifiable', async () => {
      const packageRoot = createPackageRoot();
      const claudeRoot = createPackageRoot();
      tempRoots.push(packageRoot, claudeRoot);
      const registry = registryWith(claudeRoot, { installPath: claudeRoot, version: '4.8.2', gitCommitSha: 'not-a-revision' });
      const result = await run(packageRoot, registry, 'a'.repeat(40), 'npm-global', [
        { host: 'claude-code', packageRoot: claudeRoot, installedPluginsPath: registry },
      ]);
      const check = result.checks.find((c) => c.id === 'plugin-cache-claude-code');
      expect(check?.status).toBe('warn');
      expect(check?.code).toBe('plugin-cache.unverifiable');
    });

    it('omits plugin cache checks when no host is installed', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const result = await run(packageRoot, path.join(packageRoot, 'missing.json'), 'b'.repeat(40), 'npm-global');
      expect(result.checks.some((c) => c.id.startsWith('plugin-cache-'))).toBe(false);
    });

    it('default discovery omits Claude when its valid registry has no MeMesh install', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        // A leftover MeMesh cache is not an active Claude install when the
        // host-owned registry truthfully lists only another plugin.
        fs.mkdirSync(path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.1'), { recursive: true });
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'other@marketplace': [{ installPath: '/tmp/other' }] },
        });
        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        expect(result.checks.some(c => c.id.startsWith('plugin-cache-claude-code'))).toBe(false);
      });
    });

    it('default discovery treats an empty Claude MeMesh registry array as absent unless a cache remains', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [] },
        });

        const withoutCache = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        expect(withoutCache.checks.some(c => c.id.startsWith('plugin-cache-claude-code'))).toBe(false);

        fs.mkdirSync(path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), { recursive: true });
        const withCache = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const check = withCache.checks.find(c => c.id.startsWith('plugin-cache-claude-code'));
        expect(check?.status).toBe('warn');
        expect(check?.code).toBe('plugin-cache.unverifiable');
        expect(check?.summary).toMatch(/records no active memesh install/i);
      });
    });

    it('default discovery never passes a valid Claude entry mixed with malformed data', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const claudeRoot = path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        fs.mkdirSync(claudeRoot, { recursive: true });
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [
            { installPath: claudeRoot, version: '4.8.2', gitCommitSha: 'a'.repeat(40) },
            null,
          ] },
        });

        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const checks = result.checks.filter(c => c.id.startsWith('plugin-cache-claude-code'));
        expect(checks).toHaveLength(1);
        expect(checks[0]?.status).toBe('warn');
        expect(checks[0]?.code).toBe('plugin-cache.unverifiable');
        expect(checks[0]?.summary).toMatch(/malformed memesh entry/i);
      });
    });

    it('default discovery warns for an unreadable Claude registry only when a MeMesh cache exists', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const registry = path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json');
        fs.mkdirSync(path.dirname(registry), { recursive: true });
        fs.writeFileSync(registry, '{broken');

        const withoutCache = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        expect(withoutCache.checks.some(c => c.id.startsWith('plugin-cache-claude-code'))).toBe(false);

        fs.mkdirSync(path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), { recursive: true });
        const withCache = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const check = withCache.checks.find(c => c.id.startsWith('plugin-cache-claude-code'));
        expect(check?.status).toBe('warn');
        expect(check?.code).toBe('plugin-cache.unverifiable');
      });
    });

    it('default discovery warns when the Claude registry is missing but a MeMesh cache exists', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        fs.mkdirSync(path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'), { recursive: true });

        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const check = result.checks.find(c => c.id.startsWith('plugin-cache-claude-code'));
        expect(check?.status).toBe('warn');
        expect(check?.code).toBe('plugin-cache.unverifiable');
        expect(check?.summary).toMatch(/installed_plugins\.json does not exist/i);
      });
    });

    it('discovers both hosts from an isolated HOME by default', async () => {
      await withIsolatedPluginHome(async (isolatedHome, codexHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const claudeRoot = path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        const codexRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        fs.mkdirSync(claudeRoot, { recursive: true });
        fs.mkdirSync(codexRoot, { recursive: true });
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [{ installPath: claudeRoot, gitCommitSha: 'a'.repeat(40) }] },
        });
        writeJson(path.join(codexRoot, '.codex-marketplace-install.json'), { revision: 'a'.repeat(40) });
        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const claudeCheck = result.checks.find(c => c.id === 'plugin-cache-claude-code');
        const codexCheck = result.checks.find(c => c.id === 'plugin-cache-codex');
        expect(claudeCheck?.status).toBe('pass');
        expect(codexCheck?.status).toBe('pass');
        expect(claudeCheck?.label).toContain('Claude Code');
        expect(codexCheck?.label).toContain('Codex');
        const report = formatDoctorReport(result, '4.8.2').join('\n');
        expect(report).toContain('Plugin cache source record is current (Claude Code)');
        expect(report).toContain('Plugin cache source record is current (Codex)');
      });
    });

    it('default discovery warns instead of guessing when several Codex cache versions exist', async () => {
      await withIsolatedPluginHome(async (_isolatedHome, codexHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
        const olderRoot = path.join(cacheRoot, '4.8.1');
        const newerRoot = path.join(cacheRoot, '4.8.2');
        fs.mkdirSync(olderRoot, { recursive: true });
        fs.mkdirSync(newerRoot, { recursive: true });
        writeJson(path.join(olderRoot, '.codex-marketplace-install.json'), { revision: 'a'.repeat(40) });
        writeJson(path.join(newerRoot, '.codex-marketplace-install.json'), { revision: 'b'.repeat(40) });

        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40), 'b'.repeat(40));
        const checks = result.checks.filter(c => c.id.startsWith('plugin-cache-codex'));
        expect(checks).toHaveLength(1);
        expect(checks[0]?.status).toBe('warn');
        expect(checks[0]?.code).toBe('plugin-cache.unverifiable');
        expect(checks[0]?.summary).toMatch(/several versioned Codex plugin cache directories/i);
      });
    });

    it('default discovery emits one warning for duplicate rows naming one Claude cache', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const claudeRoot = path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        fs.mkdirSync(claudeRoot, { recursive: true });
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [
            { installPath: claudeRoot, gitCommitSha: 'a'.repeat(40) },
            { installPath: claudeRoot, gitCommitSha: 'b'.repeat(40) },
          ] },
        });
        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        const checks = result.checks.filter(c => c.id.startsWith('plugin-cache-claude-code'));
        expect(checks).toHaveLength(1);
        expect(checks[0]?.status).toBe('warn');
        expect(checks[0]?.code).toBe('plugin-cache.unverifiable');
        expect(checks[0]?.summary).toMatch(/2 memesh entries.*this install/i);
      });
    });

    it('checks every Claude scope instead of collapsing registry entries', async () => {
      const packageRoot = createPackageRoot();
      const first = createPackageRoot();
      const second = createPackageRoot();
      tempRoots.push(packageRoot, first, second);
      const registry = path.join(packageRoot, 'installed_plugins.json');
      fs.writeFileSync(registry, JSON.stringify({ plugins: { 'memesh@pcircle-memesh': [
        { installPath: first, gitCommitSha: 'a'.repeat(40) },
        { installPath: second, gitCommitSha: 'b'.repeat(40) },
      ] } }));
      const result = await run(packageRoot, registry, 'a'.repeat(40), 'npm-global', [
        { host: 'claude-code', packageRoot: first, installedPluginsPath: registry },
        { host: 'claude-code', packageRoot: second, installedPluginsPath: registry },
      ]);
      expect(result.checks.find(c => c.id === 'plugin-cache-claude-code')?.status).toBe('pass');
      expect(result.checks.find(c => c.id === 'plugin-cache-claude-code-2')?.status).toBe('warn');
    });

    it('default discovery warns for a missing cache and mixed invalid scope', async () => {
      await withIsolatedPluginHome(async (isolatedHome) => {
        const packageRoot = createPackageRoot();
        tempRoots.push(packageRoot);
        const validRoot = path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
        fs.mkdirSync(validRoot, { recursive: true });
        const missingRoot = path.join(isolatedHome, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.3');
        writeJson(path.join(isolatedHome, '.claude', 'plugins', 'installed_plugins.json'), {
          plugins: { 'memesh@pcircle-memesh': [
            { installPath: validRoot, gitCommitSha: 'a'.repeat(40) },
            { installPath: missingRoot, gitCommitSha: 'a'.repeat(40) },
            { gitCommitSha: 'a'.repeat(40) },
          ] },
        });
        const result = await runWithDefaultDiscovery(packageRoot, 'a'.repeat(40));
        expect(result.checks.find(c => c.id === 'plugin-cache-claude-code')?.status).toBe('pass');
        expect(result.checks.find(c => c.id === 'plugin-cache-claude-code-2')?.code).toBe('plugin-cache.unverifiable');
        expect(result.checks.find(c => c.id === 'plugin-cache-claude-code-3')?.code).toBe('plugin-cache.unverifiable');
        expect(result.checks.find(c => c.id === 'plugin-cache-claude-code-2')?.fix).toContain('memesh upgrade-plugin');
      });
    });
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

describe('npm-global vs. discovered plugin-cache version skew (F3/F5)', () => {
  // The #247 incident (see project memory / CHANGELOG) was about the SHA a
  // cache was staged from vs the marketplace HEAD. This is the sibling gap:
  // a discovered plugin cache and the npm-global process asking about it can
  // simply be on different VERSIONS, with the plugin's own auto-updater
  // structurally unable to reach the npm-global copy — see
  // `annotateNpmGlobalPluginCacheVersion`'s docstring on doctor.ts.
  function registryWithEntry(packageRoot: string, entry: Record<string, unknown>): string {
    const registry = path.join(packageRoot, 'installed_plugins.json');
    writeJson(registry, { plugins: { 'memesh@pcircle-memesh': [entry] } });
    return registry;
  }

  async function runNpmGlobal(
    packageRoot: string,
    packageVersion: string,
    discovery: Array<{ host: 'claude-code' | 'codex'; packageRoot: string; installedPluginsPath?: string; unverifiableReason?: string }>,
    marketplaceSha: string | null = null,
  ) {
    return runDoctor({
      packageRoot,
      packageVersion,
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
      marketplaceHeadShaImpl: () => marketplaceSha,
      pluginCacheDiscoveryImpl: () => discovery,
      nativeBindingProbeImpl: () => ({ ok: true }),
      resolveShellMemeshImpl: () => null,
    });
  }

  it('WARNs and names both versions when the npm-global process is behind the discovered Claude Code plugin cache', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const installPath = path.join(packageRoot, 'claude-cache', 'memesh', '4.8.3');
    fs.mkdirSync(installPath, { recursive: true });
    const sha = 'a'.repeat(40);
    const registry = registryWithEntry(packageRoot, { installPath, version: '4.8.3', gitCommitSha: sha });

    const result = await runNpmGlobal(packageRoot, '4.8.2', [
      { host: 'claude-code', packageRoot: installPath, installedPluginsPath: registry },
    ], sha); // SHA matches — commit-currency ALONE would say PASS.

    const check = result.checks.find((c) => c.id === 'plugin-cache-claude-code');
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('4.8.2');
    expect(check?.summary).toContain('4.8.3');
    expect(check?.summary).toContain('npm-global');
    expect(check?.fix).toContain('memesh update');
  });

  it('stays PASS when the npm-global process and the discovered plugin cache agree on version', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const installPath = path.join(packageRoot, 'claude-cache', 'memesh', '4.8.2');
    fs.mkdirSync(installPath, { recursive: true });
    const sha = 'b'.repeat(40);
    const registry = registryWithEntry(packageRoot, { installPath, version: '4.8.2', gitCommitSha: sha });

    const result = await runNpmGlobal(packageRoot, '4.8.2', [
      { host: 'claude-code', packageRoot: installPath, installedPluginsPath: registry },
    ], sha);

    const check = result.checks.find((c) => c.id === 'plugin-cache-claude-code');
    expect(check?.status).toBe('pass');
    expect(check?.summary).not.toContain('npm-global install is on');
  });

  it('does not claim a version skew when the discovery is unverifiable (honest absence of an answer, not a crash)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const installPath = path.join(packageRoot, 'claude-cache', 'memesh', '4.8.3');
    fs.mkdirSync(installPath, { recursive: true });

    const result = await runNpmGlobal(packageRoot, '4.8.2', [
      { host: 'claude-code', packageRoot: installPath, unverifiableReason: 'installed_plugins.json has a malformed memesh entry' },
    ]);

    const check = result.checks.find((c) => c.id === 'plugin-cache-claude-code');
    expect(check?.status).toBe('warn');
    expect(check?.code).toBe('plugin-cache.unverifiable');
    expect(check?.summary).not.toContain('npm-global install is on');
  });

  it('adds an informational note, not a status change, when more than two versioned copies are cached (F5)', async () => {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const cacheRoot = path.join(packageRoot, 'claude-cache', 'memesh');
    for (const v of ['4.8.0', '4.8.1', '4.8.2', '4.8.3']) {
      fs.mkdirSync(path.join(cacheRoot, v), { recursive: true });
    }
    const installPath = path.join(cacheRoot, '4.8.2');
    const sha = 'c'.repeat(40);
    const registry = registryWithEntry(packageRoot, { installPath, version: '4.8.2', gitCommitSha: sha });

    const result = await runNpmGlobal(packageRoot, '4.8.2', [
      { host: 'claude-code', packageRoot: installPath, installedPluginsPath: registry },
    ], sha);

    const check = result.checks.find((c) => c.id === 'plugin-cache-claude-code');
    // Same version, same SHA — nothing here should warn; this is purely
    // informational disk-usage bookkeeping.
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('4 versioned copies');
    expect(check?.summary).toContain('rm -rf');
  });
});

describe('Claude Channel registration diagnostic', () => {
  async function runChannelCase(server: unknown, target?: { path: string; mode?: number; content?: string; symlinkTo?: string }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-claude-channel-'));
    tempRoots.push(home);
    const packageRoot = createPackageRoot(path.join(home, '.claude', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      if (target) {
        fs.mkdirSync(path.dirname(target.path), { recursive: true });
        const content = target.content ?? JSON.stringify({
          router_socket: path.join(path.dirname(target.path), 'memesh-router.sock'),
          token_file: path.join(path.dirname(target.path), 'memesh-router.token'),
          project: 'fixture', principal_id: 'claude-reviewer', server_name: 'memesh-channel',
        });
        if (target.symlinkTo) {
          fs.writeFileSync(target.symlinkTo, content);
          fs.symlinkSync(target.symlinkTo, target.path);
        } else {
          fs.writeFileSync(target.path, content);
          fs.chmodSync(target.path, target.mode ?? 0o600);
        }
      }
      writeJson(path.join(home, '.claude.json'), server);
      return await runDoctor({
        packageRoot,
        packageVersion: '4.8.2',
        openDatabaseImpl: () => makeDatabase(1) as never,
        closeDatabaseImpl: () => undefined,
        detectCapabilitiesImpl: () => caps({ searchLevel: 1, embeddings: 'ollama' }),
        getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
        getUpdateCheckImpl: async () => makeUpdateCheck(),
        getCurrentInstallChannelImpl: () => 'plugin-marketplace' as const,
        getInstallChannelSupportImpl: () => ({ channel: 'plugin-marketplace' as const, label: 'Claude Code plugin marketplace', canSelfUpdate: false, recommendedCommand: 'memesh upgrade-plugin', guidance: '' }),
        installedPluginsPathImpl: path.join(packageRoot, 'missing-registry.json'),
        marketplaceHeadShaImpl: () => null,
        nativeBindingProbeImpl: () => ({ ok: true }),
        resolveShellMemeshImpl: () => null,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  }

  function channelRow(result: Awaited<ReturnType<typeof runDoctorImpl>>) {
    return result.checks.find(check => check.id === 'claude-channel');
  }

  function channelTarget(name: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-claude-channel-target-'));
    tempRoots.push(root);
    return path.join(root, name);
  }

  async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      return await run();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }

  it('WARNs when the opt-in channel is absent and does not leak paths', async () => {
    const result = await runChannelCase({ mcpServers: {} });
    const row = channelRow(result)!;
    expect(row.status).toBe('warn');
    expect(row.informational).not.toBe(true);
    expect(row.summary).toMatch(/durable MCP\/inbox.*inactive/i);
    expect(row.summary).not.toMatch(/\/private\/|\/Users\/|memesh-claude-channel-/);
    expect(result.status).toBe('PASS_WITH_CONCERNS');
    const report = formatDoctorReport(result, '4.8.2').join('\n');
    expect(report).toContain('Overall: PASS_WITH_CONCERNS');
    expect(report).toContain('[WARN] Claude Channel registration');
  });

  it('WARNs when a registration points to a missing target', async () => {
    const missing = channelTarget('missing.json');
    const result = await runChannelCase({ mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', missing] } } });
    expect(channelRow(result)).toMatchObject({ status: 'warn' });
    expect(channelRow(result)?.summary).toMatch(/missing, insecure, malformed, or incomplete/i);
    expect(channelRow(result)?.summary).not.toContain(missing);
  });

  it('WARNs malformed registrations', async () => {
    const target = channelTarget('malformed-registration.json');
    const result = await runChannelCase({ mcpServers: { 'memesh-channel': { command: 'other', args: ['--config', target] } } }, { path: target, mode: 0o644 });
    expect(channelRow(result)).toMatchObject({ status: 'warn' });
    expect(channelRow(result)?.summary).toMatch(/malformed/i);
    expect(channelRow(result)?.summary).not.toContain(target);
  });

  it('WARNs an insecure owner config target', async () => {
    const target = channelTarget('insecure.json');
    const result = await runChannelCase({ mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', target] } } }, { path: target, mode: 0o644 });
    expect(channelRow(result)).toMatchObject({ status: 'warn' });
    expect(channelRow(result)?.summary).toMatch(/missing, insecure, malformed, or incomplete/i);
    expect(channelRow(result)?.summary).not.toContain(target);
  });

  it('WARNs a coherent registration on Windows because live notification cannot be established', async () => {
    const target = channelTarget('configured.json');
    const result = await withPlatform('win32', () => runChannelCase(
      { mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', target] } } }, { path: target },
    ));
    const row = channelRow(result)!;
    expect(row).toMatchObject({ status: 'warn' });
    expect(row.informational).not.toBe(true);
    expect(row.summary).toMatch(/missing, insecure, malformed, or incomplete/i);
    expect(row.summary).toMatch(/notification is not established/i);
    expect(row.summary).not.toContain(target);
  });

  it.skipIf(process.platform === 'win32')('reports a coherent registration as CONFIGURED on a supported platform', async () => {
    const target = channelTarget('configured.json');
    const result = await runChannelCase(
      { mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', target] } } }, { path: target },
    );
    const row = channelRow(result)!;
    expect(row).toMatchObject({ status: 'pass', informational: true });
    expect(row.summary).toMatch(/CONFIGURED/);
    expect(row.summary).toMatch(/admission.*not verified/i);
  });

  it('WARNs when the declared target content is malformed or incomplete', async () => {
    const target = channelTarget('malformed-content.json');
    const result = await runChannelCase({ mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', target] } } }, { path: target, content: '{broken' });
    expect(channelRow(result)).toMatchObject({ status: 'warn' });
    expect(channelRow(result)?.summary).toMatch(/missing, insecure, malformed, or incomplete/i);
    expect(channelRow(result)?.summary).not.toContain(target);
  });

  it('WARNs when the declared target is a symlink', async () => {
    const target = channelTarget('link.json');
    const realTarget = path.join(path.dirname(target), 'real.json');
    const result = await runChannelCase({ mcpServers: { 'memesh-channel': { command: 'memesh-host-claude', args: ['--config', target] } } }, { path: target, symlinkTo: realTarget });
    expect(channelRow(result)).toMatchObject({ status: 'warn' });
    expect(channelRow(result)?.summary).toMatch(/missing, insecure, malformed, or incomplete/i);
    expect(channelRow(result)?.summary).not.toContain(realTarget);
  });

  it('does not add a Claude row for a Codex plugin cache', async () => {
    const packageRoot = createPackageRoot(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-')), '.codex', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2'));
    tempRoots.push(path.dirname(path.dirname(path.dirname(path.dirname(packageRoot)))));
    const result = await runDoctor({
      packageRoot, packageVersion: '4.8.2', openDatabaseImpl: () => makeDatabase(1) as never,
      closeDatabaseImpl: () => undefined, detectCapabilitiesImpl: () => caps({ searchLevel: 1 }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'), getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'plugin-marketplace' as const,
      getInstallChannelSupportImpl: () => ({ channel: 'plugin-marketplace' as const, label: 'Codex plugin', canSelfUpdate: false, recommendedCommand: '', guidance: '' }),
      installedPluginsPathImpl: path.join(packageRoot, 'missing.json'), marketplaceHeadShaImpl: () => null,
      nativeBindingProbeImpl: () => ({ ok: true }), resolveShellMemeshImpl: () => null,
    });
    expect(channelRow(result)).toBeUndefined();
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

/**
 * The rows nothing asserted.
 *
 * Measured, not guessed: the C8 detector in
 * `scripts/audit/verification-audit.mjs` lists every `createCheck`/`createInfo`
 * id in `doctor.ts` and asks whether it appears in test code at all. Seven of
 * twenty-four appeared nowhere — including `hooks-config`, which is a FAIL row
 * about an install whose hooks cannot load, and `install_id`, which was
 * rendering as `[PASS]` while verifying nothing.
 *
 * The reason a row can reach that state is worth naming: doctor rows are
 * output, and a test written for a FIX naturally asserts the fix, not the
 * sentence that reports the problem. `vector-generation.open` shipped that way
 * and was found the same way.
 */
describe('doctor rows that had no assertion', () => {
  const envOverrides: Array<[string, string | undefined]> = [];

  function setEnv(key: string, value: string | undefined): void {
    envOverrides.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  /**
   * An isolated MEMESH_DIR. Not optional for these rows: `getInstallRecord()`
   * CREATES `install.json` when it is absent, so without this the install_id
   * cases would write into the developer's own `~/.memesh`.
   */
  function isolateMemeshDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-rows-'));
    tempRoots.push(dir);
    setEnv('MEMESH_DIR', dir);
    return dir;
  }

  afterEach(() => {
    for (const [key, prev] of envOverrides.splice(0)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  /**
   * Enough injected seams to reach the end of `runDoctor` without touching the
   * network, the real database, or the developer's config. Every row below is
   * pushed regardless of what the others report, so a test asserts only its
   * own row and lets the rest land where they may.
   */
  function options(packageRoot: string, overrides: Record<string, unknown> = {}) {
    return {
      packageRoot,
      packageVersion: '4.6.2',
      openDatabaseImpl: () => makeDatabase(3) as never,
      closeDatabaseImpl: () => undefined,
      detectCapabilitiesImpl: () => caps({ searchLevel: 1, llm: null, embeddings: 'ollama' }),
      getConfigPathImpl: () => path.join(packageRoot, 'config.json'),
      getUpdateCheckImpl: async () => makeUpdateCheck(),
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global', label: 'npm global', canSelfUpdate: true,
        recommendedCommand: 'memesh update', guidance: '',
      }),
      nativeBindingProbeImpl: () => ({ ok: true }),
      ...overrides,
    } as unknown as Parameters<typeof runDoctorImpl>[0];
  }

  function row(result: { checks: Array<{ id: string }> }, id: string) {
    const matches = result.checks.filter((c) => c.id === id);
    expect(matches, `doctor emitted ${matches.length} "${id}" rows, expected 1`).toHaveLength(1);
    return matches[0] as {
      id: string; label: string; status: string; summary: string;
      fix?: string; code?: string; informational?: boolean;
    };
  }

  function rootWithHooks(contents: string | null): string {
    const packageRoot = createPackageRoot();
    tempRoots.push(packageRoot);
    const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
    if (contents === null) fs.rmSync(hooksPath);
    else fs.writeFileSync(hooksPath, contents);
    return packageRoot;
  }

  describe('hooks-config', () => {
    it('passes on the shipped configuration, and says how many types it found', async () => {
      // The half that gives the three failures below their meaning.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot)), 'hooks-config');
      expect(check.status).toBe('pass');
      expect(check.code, 'a passing row must not carry a failure code').toBeUndefined();
      expect(check.summary).toContain('5 hook types');
    });

    it('fails when hooks.json is missing entirely', async () => {
      isolateMemeshDir();
      const check = row(await runDoctorImpl(options(rootWithHooks(null))), 'hooks-config');
      expect(check.status).toBe('fail');
      expect(check.code).toBe('hooks-config.missing');
      expect(check.fix).toContain('hooks/hooks.json');
    });

    it('fails on a hooks.json that is not valid JSON, and names the path to fix', async () => {
      isolateMemeshDir();
      const packageRoot = rootWithHooks('{ this is not json');
      const check = row(await runDoctorImpl(options(packageRoot)), 'hooks-config');
      expect(check.status).toBe('fail');
      expect(check.code).toBe('hooks-config.invalid-json');
      expect(check.fix, 'the user is not told WHICH file to fix').toContain(packageRoot);
    });

    it('fails when a hook type is missing, and names the ones that are gone', async () => {
      // A config that parses and has hooks — but not all of them. Silent by
      // construction: Claude Code loads it happily and those events never fire.
      isolateMemeshDir();
      const packageRoot = rootWithHooks(JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-edit-recall.js' }] }],
        },
      }));
      const check = row(await runDoctorImpl(options(packageRoot)), 'hooks-config');
      expect(check.status).toBe('fail');
      expect(check.code).toBe('hooks-config.missing-types');
      expect(check.summary).toContain('SessionStart');
      expect(check.summary, 'a type that IS present was reported missing').not.toContain('PreToolUse');
    });

    it('fails closed when hooks is a JSON-valid array', async () => {
      isolateMemeshDir();
      const packageRoot = rootWithHooks(JSON.stringify({ hooks: [] }));
      const result = await runDoctorImpl(options(packageRoot));

      const config = row(result, 'hooks-config');
      expect(config.status).toBe('fail');
      expect(config.code).toBe('hooks-config.missing-types');

      const scripts = row(result, 'hook-scripts');
      expect(scripts.status).toBe('fail');
      expect(scripts.code).toBe('hook-scripts.none');
      expect(scripts.summary).not.toContain('All 0 hook scripts are present and executable');
    });

    it('fails closed when a hook type has a malformed hooks object', async () => {
      isolateMemeshDir();
      const packageRoot = rootWithHooks(JSON.stringify({ hooks: { PreToolUse: [{ hooks: {} }] } }));
      const result = await runDoctorImpl(options(packageRoot));

      const config = row(result, 'hooks-config');
      expect(config.status).toBe('fail');
      expect(config.code).toBe('hooks-config.missing-types');

      const scripts = row(result, 'hook-scripts');
      expect(scripts.status).toBe('fail');
      expect(scripts.code).toBe('hook-scripts.none');
      expect(scripts.summary).not.toContain('All 0 hook scripts are present and executable');
    });
  });

  describe('llm_probe', () => {
    it('says Core Mode when no LLM is configured, and cannot fail for it', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot)), 'llm_probe');
      expect(check.informational, 'a row that verified nothing counted toward Overall').toBe(true);
      expect(check.summary).toContain('Core Mode');
    });

    it('says NOT VERIFIED — not "working" — when a provider is configured but unprobed', async () => {
      // The whole point of the row: an expired key and a healthy setup must
      // not read the same.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      let probes = 0;

      const check = row(await runDoctorImpl(options(packageRoot, {
        detectCapabilitiesImpl: () => caps({ llm: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' } }),
        probeProviderImpl: async () => { probes++; return { valid: true }; },
      })), 'llm_probe');

      expect(probes, 'doctor made a live provider call without --probe').toBe(0);
      expect(check.informational).toBe(true);
      expect(check.summary).toContain('NOT VERIFIED');
      expect(check.fix).toContain('--probe');
    });

    it('fails — and says features are silently doing nothing — when the probe is refused', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeCapabilities: true,
        detectCapabilitiesImpl: () => caps({ llm: { provider: 'openai', model: 'gpt-4o-mini' } }),
        probeProviderImpl: async () => ({ valid: false, error: 'invalid_api_key' }),
      })), 'llm_probe');

      expect(check.status).toBe('fail');
      expect(check.code).toBe('llm.unreachable');
      expect(check.summary).toContain('invalid_api_key');
      expect(check.informational, 'a real failure must count toward Overall').toBeFalsy();
    });

    it('separates a probe that THREW from one that answered "no"', async () => {
      // Two different fixes: a thrown error is usually a host/network fault,
      // a refusal is usually the key. Collapsing them loses that.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeCapabilities: true,
        detectCapabilitiesImpl: () => caps({ llm: { provider: 'ollama', model: 'llama3' } }),
        probeProviderImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:11434'); },
      })), 'llm_probe');

      expect(check.status).toBe('fail');
      expect(check.code).toBe('llm.threw');
      expect(check.summary).toContain('ECONNREFUSED');
    });
  });

  describe('install-channel', () => {
    it('warns when the install method cannot be identified', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        getCurrentInstallChannelImpl: () => 'unknown',
        getInstallChannelSupportImpl: () => ({
          channel: 'unknown', label: 'unknown', canSelfUpdate: false,
          recommendedCommand: null, guidance: '',
        }),
      })), 'install-channel');

      expect(check.status).toBe('warn');
      expect(check.code).toBe('install-channel.unknown');
      expect(check.fix).toContain('npm install -g @pcircle/memesh');
    });

    it('passes on a channel it knows, with no fix to offer', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot)), 'install-channel');
      expect(check.status).toBe('pass');
      expect(check.code, 'a healthy install carried a warning code').toBeUndefined();
      expect(check.fix, 'a passing row offered a remedy for nothing').toBeUndefined();
      expect(check.summary).toContain('npm global');
    });
  });

  describe('capabilities', () => {
    it('reports configured values only, and cannot fail — the row this rule was written for', async () => {
      // From `DoctorCheck.informational`'s own docstring: this row was
      // hardcoded to 'pass' and merely echoed config, so an expired key could
      // never move doctor off PASS.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot)), 'capabilities');
      expect(check.informational).toBe(true);
      expect(check.summary).toContain('Smart Mode');
      expect(check.summary).toContain('Configured values only');
    });

    it('names Core — not Smart Mode — at search level 0', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        detectCapabilitiesImpl: () => caps({ searchLevel: 0, llm: null, embeddings: 'tfidf' }),
      })), 'capabilities');
      expect(check.summary).toContain('Core');
      expect(check.summary).not.toContain('Smart Mode');
    });
  });

  describe('transcript-mining', () => {
    it('says OFF and how to turn it on, without treating off as a fault', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      setEnv('MEMESH_TRANSCRIPT_MINING', '0');

      const check = row(await runDoctorImpl(options(packageRoot)), 'transcript-mining');
      expect(check.informational, 'an opt-in feature being off is not a fault').toBe(true);
      expect(check.summary).toContain('Off (opt-in)');
      expect(check.summary).toContain('memesh config set transcriptMining true');
    });

    it('changes what it says once it is on', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      setEnv('MEMESH_TRANSCRIPT_MINING', '1');

      const check = row(await runDoctorImpl(options(packageRoot)), 'transcript-mining');
      expect(check.informational).toBe(true);
      expect(check.summary, 'the row reads identically whether mining is on or off')
        .not.toContain('Off (opt-in)');
    });
  });

  describe('Codex ordinary-session notification setup', () => {
    function codexPackageRoot(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-.codex-plugins-cache-'));
      tempRoots.push(root);
      const packageRoot = path.join(root, '.codex', 'plugins', 'cache', 'pcircle-memesh', 'memesh', '4.8.2');
      fs.mkdirSync(packageRoot, { recursive: true });
      createPackageRoot(packageRoot);
      return packageRoot;
    }

    function codexOptions(packageRoot: string, overrides: Record<string, unknown> = {}) {
      return options(packageRoot, {
        getCurrentInstallChannelImpl: () => 'plugin-marketplace',
        getInstallChannelSupportImpl: () => ({
          channel: 'plugin-marketplace', label: 'Codex plugin marketplace', canSelfUpdate: false,
          recommendedCommand: 'codex plugin add memesh@pcircle-memesh', guidance: '',
        }),
        ...overrides,
      });
    }

    it('passes when the explicit session setup config exists', async () => {
      const packageRoot = codexPackageRoot();
      const memeshDir = isolateMemeshDir();
      const configPath = path.join(memeshDir, 'hosts', 'codex-session.json');
      writeJson(configPath, { project: 'ignored', principal: 'ignored', workspace: 'ignored' });

      const result = await runDoctorImpl(codexOptions(packageRoot));
      const check = row(result, 'codex-session-setup');
      expect(check.status).toBe('pass');
      expect(check.label).toBe('Codex ordinary-session notification setup');
      expect(check.summary.toLowerCase()).toContain('durable inbox remains available');
      expect(check.summary).toContain('will not auto-attach');
    });

    it('warns when the session setup config is missing', async () => {
      const packageRoot = codexPackageRoot();
      isolateMemeshDir();

      const result = await runDoctorImpl(codexOptions(packageRoot));
      const check = row(result, 'codex-session-setup');
      expect(check.status).toBe('warn');
      expect(check.code).toBe('codex-session.config-missing');
      expect(check.summary.toLowerCase()).toContain('durable inbox remains available');
      expect(check.summary).toContain('live ordinary-session wakeup is inactive');
      expect(check.summary).toContain('explicit opt-in');
      expect(check.summary).toContain('will not auto-attach');
      expect(check.fix).toBe('Run `memesh agent setup codex-session --project <project> --principal <principal> --workspace <exact-workspace>`, then restart Codex.');
      expect(result.status).toBe('PASS_WITH_CONCERNS');
    });

    it('does not add a row for a non-Codex plugin host', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const result = await runDoctorImpl(codexOptions(packageRoot));
      expect(result.checks.some(check => check.id === 'codex-session-setup')).toBe(false);
    });

    it('reports a discovered Codex cache for an npm-global install', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      const discoveredCodexRoot = codexPackageRoot();

      const result = await runDoctorImpl(options(packageRoot, {
        pluginCacheDiscoveryImpl: () => [{ host: 'codex', packageRoot: discoveredCodexRoot }],
      }));
      const check = row(result, 'codex-session-setup');
      expect(check.status).toBe('warn');
      expect(check.code).toBe('codex-session.config-missing');
    });

    it('uses only existsSync for setup detection and does not probe a router', async () => {
      const packageRoot = codexPackageRoot();
      const memeshDir = isolateMemeshDir();
      const configPath = path.join(memeshDir, 'hosts', 'codex-session.json');
      const readPaths: string[] = [];
      let routerCalls = 0;

      const result = await runDoctorImpl(codexOptions(packageRoot, {
        existsSyncImpl: (candidate: fs.PathLike) => fs.existsSync(candidate),
        readFileSyncImpl: ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
          if (String(candidate) === configPath) readPaths.push(configPath);
          return (fs.readFileSync as any)(candidate, ...args);
        }) as typeof fs.readFileSync,
        messageRouterStatusProbeImpl: async () => {
          routerCalls++;
          return { socket_path: '/tmp/unused.sock', socket: 'missing' as const };
        },
      }));

      expect(result.checks.find(check => check.id === 'codex-session-setup')?.status).toBe('warn');
      expect(readPaths).toEqual([]);
      expect(routerCalls).toBe(0);
    });
  });

  describe('message-capability probe', () => {
    it('is opt-in information and does not invoke a subprocess probe ordinarily', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      let calls = 0;

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageCapability: false,
        messageCapabilityProbeImpl: () => { calls++; return { ok: true }; },
      })), 'message-capability');

      expect(calls).toBe(0);
      expect(check.informational).toBe(true);
      expect(check.summary).toContain('Not verified (opt-in)');
      expect(check.summary).toContain('does not check a live router socket');
    });

    it('reports the injected installed-artifact probe success', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageCapability: true,
        messageCapabilityProbeImpl: () => ({ ok: true }),
      })), 'message-capability');

      expect(check.status).toBe('pass');
      expect(check.informational).toBeFalsy();
      expect(check.summary).toContain('nine-action message schema');
      expect(check.summary).toContain('No live router socket');
    });

    it('reports the injected installed-artifact probe failure with remediation', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageCapability: true,
        messageCapabilityProbeImpl: () => ({ ok: false, message: 'missing dist host adapter' }),
      })), 'message-capability');

      expect(check.status).toBe('fail');
      expect(check.code).toBe('message-capability.probe-failed');
      expect(check.summary).toContain('missing dist host adapter');
      expect(check.fix).toContain('MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1');
    });
  });

  describe('message-router-status probe', () => {
    it('is opt-in and never probes the Local socket by default', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();
      let calls = 0;

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageRouterStatus: false,
        messageRouterStatusProbeImpl: async () => {
          calls++;
          return { socket_path: '/tmp/memesh-router.sock', socket: 'reachable' as const };
        },
      })), 'message-router-status');

      expect(calls).toBe(0);
      expect(check.informational).toBe(true);
      expect(check.summary).toContain('never starts a router');
      expect(check.summary).toContain('wakes a stopped session');
    });

    it('separates reachable router availability from active-host delivery claims', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageRouterStatus: true,
        messageRouterStatusProbeImpl: async () => ({
          socket_path: '/tmp/memesh-router.sock', socket: 'reachable',
        }),
      })), 'message-router-status');

      expect(check.status).toBe('pass');
      expect(check.summary).toContain('router availability');
      expect(check.summary).toContain('does not prove an active host registration');
      expect(check.summary).toContain('host_accept');
    });

    it('reports a missing router as no native host registration rather than stopped-session wakeup', async () => {
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot, {
        probeMessageRouterStatus: true,
        messageRouterStatusProbeImpl: async () => ({
          socket_path: '/tmp/memesh-router.sock', socket: 'missing', detail: 'ENOENT',
        }),
      })), 'message-router-status');

      expect(check.status).toBe('warn');
      expect(check.code).toBe('message-router.socket-missing');
      expect(check.summary).toContain('No active host is registered');
      expect(check.summary).toContain('will not wake a stopped or missing session');
    });
  });

  describe('install_id', () => {
    it('reports the id as INFO, not as a check that passed', async () => {
      // It was `createCheck(..., 'pass', ...)` with no branch that could fail,
      // so it rendered as [PASS] and padded Overall with a row that verified
      // nothing — the exact case `informational` exists for.
      const packageRoot = createPackageRoot();
      tempRoots.push(packageRoot);
      const dir = isolateMemeshDir();

      const check = row(await runDoctorImpl(options(packageRoot)), 'install_id');
      expect(check.informational, 'a row that only echoes a stored value counted as a verification').toBe(true);

      // ...and it reports the id that is actually on disk, in the isolated dir.
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')) as { install_id: string };
      expect(check.summary).toContain(stored.install_id);
      expect(check.summary, 'the privacy sentence is the reason this row exists')
        .toContain('Never transmitted automatically');
    });
  });
});
