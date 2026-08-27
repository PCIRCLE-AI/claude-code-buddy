/**
 * The release scripts must not touch the maintainer's real data to do their job.
 *
 * `release-verify.sh` used to strip the `llm` block out of
 * `~/.memesh/config.json` so the suite would run without credentials, park the
 * only copy of live API keys in a world-readable `/tmp` file, and rely on an
 * EXIT trap to put them back. A SIGKILL, a crash between the two writes, or a
 * `/tmp` sweep lost them. What the suite needs is an environment with NO LLM
 * credentials — not this machine's environment minus its credentials — so it
 * now runs under a throwaway HOME, which has no config to strip.
 *
 * This is a shell script, so there is no unit to call. The assertions are
 * structural, and they are the ones that matter: the regression is not "the
 * output changed", it is "the script started writing to the real config again".
 * A test that ran the script for real would have to have a real config to
 * damage, which is the thing being prevented.
 *
 * Recorded as unpinned during the mutation sweep of this release, then pinned.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Feature: release scripts never edit the real ~/.memesh', () => {
  const script = 'scripts/release-verify.sh';

  /** The script with full-line comments removed — assertions are about what it DOES. */
  function code(rel: string): string {
    return read(rel)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
  }

  it('runs the suite under a throwaway HOME', () => {
    const text = code(script);
    expect(text).toMatch(/mktemp -d/);
    // The HOME override has to be ON the command. Creating a temp dir and then
    // not using it for the run is the shape this replaced.
    expect(text).toMatch(/HOME="\$\w+"[^\n]*"\$@"/);
    expect(text).toMatch(/with_throwaway_home npx vitest run/);
  });

  it('never names the real config or memesh dir at all', () => {
    // Keyed on WHAT IS TOUCHED, not on which verb touches it.
    //
    // The first version of this test listed the operations it imagined the old
    // script used — `cp`/`mv`/`rm`, a `jq del(.llm)`, a `>` redirect, a `trap`
    // on a line mentioning config.json. Checked against `git show
    // main:scripts/release-verify.sh`, ALL FIVE return false: the real
    // regression used a python3 heredoc and `open(p,'w')`, and its `trap
    // restore_llm EXIT` line never mentions config.json. The test forbade five
    // shapes the bug never had, and would have stayed green if the whole
    // strip/restore block were pasted back in. It was "mutation-verified"
    // against a hand-written imitation of the bug that matched its own regexes
    // — which is not verification.
    //
    // A script that never mentions `$HOME/.memesh` or `config.json` cannot
    // read, write, back up or restore them by any means, in any language it
    // shells out to. That is the property; the verbs are not.
    const text = code(script);
    expect(text).not.toMatch(/\$HOME\/\.memesh/);
    expect(text).not.toMatch(/~\/\.memesh/);
    expect(text).not.toMatch(/config\.json/);
    // `trap` existed only to undo the damage. No damage, no trap.
    expect(text).not.toMatch(/^\s*trap\s/m);
  });

  it('runs every gate that opens the database under the throwaway HOME', () => {
    // `doctor` calls openDatabase(), which runs schema migrations, the FTS
    // rebuild and the telemetry prune — so an unisolated gate MUTATES the
    // maintainer's real knowledge-graph.db as a side effect of verifying a
    // release. The commit that introduced the throwaway HOME isolated the test
    // suite and stopped one gate short, which is why this asserts the set
    // rather than a single call.
    const text = code(script);
    const mustBeIsolated = ['doctor --json', 'install-hooks --dry-run', 'npx vitest run'];
    for (const cmd of mustBeIsolated) {
      const line = text.split('\n').find((l) => l.includes(cmd) && !l.trim().startsWith('#'));
      expect(line, `no line invokes ${cmd}`).toBeDefined();
      expect(line, `${cmd} is not wrapped in with_throwaway_home`).toMatch(/with_throwaway_home/);
    }
  });

  it('clears MEMESH_DIR and MEMESH_DB_PATH, not just HOME', () => {
    // HOME alone is not isolation: paths.ts resolves both of these FIRST, so
    // either one exported in the maintainer's shell routes a "throwaway HOME"
    // run straight back at the real config and the real database.
    expect(code(script)).toMatch(/env -u MEMESH_DIR -u MEMESH_DB_PATH/);
  });

  it('the build-output gate builds before it diffs', () => {
    // Without this the gate has an unenforced precondition, and an unenforced
    // precondition is how it reports the exact defect it exists to catch as a
    // pass: `npm run verify:release` on its own printed "✓ committed build
    // output is current" having built nothing, which is true of ANY tree whose
    // dist/ matches HEAD — including one whose source was edited and never
    // rebuilt. Confirmed by hand: with a one-line edit to
    // `src/core/version-check.ts` and no build, `git diff -- dist` was empty
    // (old gate: green tick) and the current script exits 1 naming the two
    // stale files.
    const text = read('scripts/check-generated-mirror.mjs');
    const buildAt = text.search(/npmSync\(\s*\['run',\s*'build'\]/);
    const diffAt = text.search(/'diff',\s*'--stat'/);
    expect(buildAt, 'the gate does not run the build').toBeGreaterThan(-1);
    expect(diffAt, 'the gate does not diff the build outputs').toBeGreaterThan(-1);
    expect(buildAt, 'the gate diffs before it builds').toBeLessThan(diffAt);
    // A failed build must fail the gate. Reporting "output is current" because
    // the compiler crashed is the same class of lie one level up.
    expect(text).toMatch(/catch[\s\S]{0,200}process\.exit\(1\)/);
  });

  it('installs dashboard deps from the lockfile, not the ranges', () => {
    // `dashboard/dist/index.html` is committed and shipped, and the one moment
    // node_modules is absent — the only moment this branch runs — is a clean CI
    // checkout, i.e. exactly where the dependency set must be pinned. The
    // script used to run `npm install` unconditionally, so the convenience
    // applied where it was never needed and the pinning was missing where it
    // always is.
    const text = read('scripts/build-dashboard.mjs');
    expect(text).toMatch(/package-lock\.json/);
    expect(text).toMatch(/\['ci',/);
  });

  it('the line-ending rule covers every text file, not a list of suffixes', () => {
    // Both Windows CI legs failed on this branch because `.gitattributes`
    // enumerated ten extensions and missed `.css` and `.html`. Windows checked
    // `dashboard/index.html` and `dashboard/src/styles/global.css` out with
    // CRLF, vite INLINED them into the bundle, and the carriage returns landed
    // mid-line inside a committed artifact — a real content difference that
    // line-ending normalisation cannot undo, so `dashboard/dist/index.html`
    // could never be reproduced there.
    const attrs = read('.gitattributes');
    expect(attrs).toMatch(/^\*\s+text=auto\s+eol=lf\s*$/m);
    // ...and binaries stay exempt, or the default corrupts them instead.
    expect(attrs).toMatch(/^\*\.png\s+binary\s*$/m);
  });

  it('the docs gate counts hooks, not build output that lives beside them', async () => {
    // `find scripts/hooks -name '*.js' ! -name '_shared.js'` recursed into
    // `scripts/hooks/_generated/`, so when the build mirror landed there the
    // count went 7 -> 9 and the gate reported FAIL on a correct tree. A gate
    // that fails on a healthy repo gets ignored, and then it is not a gate.
    //
    // Tested by RUNNING the rule against a fixture shaped like the incident,
    // not by regexing the gate's source for three implementation substrings —
    // that pinned the text, and text that is present proves nothing about
    // what executes. The rule lives in scripts/lib/hook-files.mjs and
    // check-doc-claims.mjs imports it (asserted below), so this fixture
    // exercises the code the gate runs.
    const { listHookFiles } = await import('../scripts/lib/hook-files.mjs');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-fixture-'));
    try {
      fs.writeFileSync(path.join(fixture, 'session-start.js'), '');
      fs.writeFileSync(path.join(fixture, 'session-summary.js'), '');
      fs.writeFileSync(path.join(fixture, '_shared.js'), '');
      fs.writeFileSync(path.join(fixture, 'notes.md'), '');
      fs.mkdirSync(path.join(fixture, '_generated'));
      fs.writeFileSync(path.join(fixture, '_generated', 'session-start.js'), '');
      fs.writeFileSync(path.join(fixture, '_generated', 'extra-mirror.js'), '');
      expect(listHookFiles(fixture)).toEqual(['session-start.js', 'session-summary.js']);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    // The one source-level fact still worth pinning: the gate uses this rule,
    // rather than a private copy that could drift back to `find`.
    expect(read('scripts/check-doc-claims.mjs')).toContain("import { listHookFiles } from './lib/hook-files.mjs'");
  });

  it('the docs gate is actually wired into the list both CI and publish run', () => {
    // The reason it moved. `verify-docs-sync.sh` had SIX checks and ZERO
    // callers: not CI, not verify:release, not release-verify.sh, not a
    // package.json script. Its only references were a line in CLAUDE.md telling
    // an assistant to run it by hand and a manual review skill. A gate that
    // never runs cannot fail, which is the same defect as a gate that cannot
    // fail when it runs — and this repository has now found four of those.
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify:release']).toContain('node scripts/check-doc-claims.mjs');
  });

  it('wires the deterministic message release/install sync gate', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify:release']).toContain('node scripts/check-agent-message-sync.mjs');
    const gate = read('scripts/check-agent-message-sync.mjs');
    for (const action of ['send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts']) {
      expect(gate).toContain(`'${action}'`);
    }
    expect(gate).toContain('dist/host-adapters/acp-client.js');
    expect(gate).toContain('dist/transports/agent-messaging.js');
    expect(gate).toContain('dist/core/agent-router.js');
    expect(gate).toContain('dist/host-runtime');
    expect(gate).toContain("'memesh-router'");
    expect(gate).toContain('CLI command');
    expect(gate).toContain('mapped to action');
  });

  it('makes packaged smoke exercise the installed native router path without poll/watch', () => {
    const smoke = read('scripts/smoke-packed-artifact.mjs');
    expect(smoke).toContain("installedBin('memesh-router')");
    expect(smoke).toContain("'dist', 'host-runtime', 'router-client.js'");
    expect(smoke).toContain("'message', 'send'");
    expect(smoke).toContain("'--payload-stdin'");
    expect(smoke).toContain('agent_host_accepts');
    expect(smoke).toContain('stopped-or-missing-host');
    expect(smoke).toContain('without poll/watch');
    expect(smoke).toContain('consumerInstallTimeoutMs');
    expect(smoke).toContain('timeout: consumerInstallTimeoutMs');
  });

  it('fails the sync gate when an installed adapter artifact is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-sync-fixture-'));
    const write = (relative: string, content = '') => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const actions = ['send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts'];
    try {
      write('src/transports/schemas.ts', actions.map(action => `action: z.literal('${action}')`).join('\n') + "\ntarget_kind z.enum(['principal', 'session'])");
      const mcpMessageSchema = "name: 'message' target_kind: { type: 'string', enum: ['principal', 'session'] } name === 'message' MessageSchema executeAgentMessageAction";
      write('src/transports/mcp/handlers.ts', mcpMessageSchema);
      write('src/transports/http/server.ts', "executeAgentMessageAction\ntransport: 'http'");
      const cliMappings = [
        ['send', 'send'], ['watch', 'poll'], ['fetch', 'fetch'], ['intake', 'intake'],
        ['ack', 'ack'], ['disposition', 'disposition'], ['activation', 'activation'], ['receipts', 'receipts'],
      ].map(([command, action]) => `.command('${command}')\n.action(() => ({ action: '${action}' }))`).join('\n');
      const cliRequired = "\n--payload-stdin\nnever argv\nreadCliMessagePayloadFromStdin\nmessageStorageCmd storage report prune automatic_pruning\n'codex-session'\nmode: host === 'codex-session'\n'ordinary-session-native-queue'";
      write('src/transports/cli/cli.ts', cliMappings + cliRequired);
      write('src/transports/agent-messaging.ts', 'target_kind: input.target_kind');
      write('src/core/agent-message-storage.ts', 'protected_unresolved_message_count terminal_prunable_message_count storage_quota_exceeded');
      write('src/core/agent-router.ts', 'principal session generation');
      for (const adapter of ['codex-app-server.ts', 'claude-channel.ts', 'acp-client.ts']) write(`src/host-adapters/${adapter}`, 'adapter');
      write('src/host-adapters/codex-app-server.ts', 'adapter experimentalApi: true thread/queue/add ws://localhost/rpc perMessageDeflate: false');
      const codexQueueAdapter = "dispatch_metadata_only 'queue', '--thread' '--message', marker shell: false";
      write('src/host-adapters/codex-cli-queue.ts', codexQueueAdapter);
      write('dist/mcp/server.js');
      write('dist/transports/mcp/handlers.js', mcpMessageSchema);
      write('dist/transports/http/server.js', 'MessageBody executeAgentMessageAction');
      write('dist/transports/agent-messaging.js', 'executeAgentMessageAction target_kind: input.target_kind');
      write('dist/transports/schemas.js', "target_kind z.enum(['principal', 'session'])");
      write('dist/transports/cli/cli.js', cliMappings + cliRequired);
      write('dist/core/agent-message-storage.js', 'protected_unresolved_message_count terminal_prunable_message_count storage_quota_exceeded');
      for (const artifact of ['dist/host-adapters/codex-app-server.js', 'dist/host-adapters/claude-channel.js', 'dist/host-adapters/acp-client.js']) write(artifact);
      write('dist/host-adapters/codex-app-server.js', 'experimentalApi: true thread/queue/add ws://localhost/rpc perMessageDeflate: false');
      write('dist/host-adapters/codex-cli-queue.js', codexQueueAdapter);
      write('dist/core/agent-router.js', 'class AgentRouter host_accept');
      for (const runtime of ['router', 'router-client', 'config', 'codex', 'codex-session', 'claude', 'acp']) {
        write(`src/host-runtime/${runtime}.ts`);
        for (const extension of ['.js', '.js.map', '.d.ts', '.d.ts.map']) write(`dist/host-runtime/${runtime}${extension}`);
      }
      const codexSession = "CODEX_THREAD_ID hook_event_name !== 'SessionStart' adapter_kind: 'codex-cli-queue' workspace !== cwd";
      write('src/host-runtime/codex-session.ts', codexSession);
      write('dist/host-runtime/codex-session.js', codexSession);
      write('src/host-runtime/acp.ts', 'session_update_file O_NOFOLLOW');
      write('dist/host-runtime/acp.js', 'session_update_file O_NOFOLLOW');
      write('docs/api/API_REFERENCE.md', actions.join(' ') + ' principal session generation Local Cloud message storage storage_quota_exceeded');
      write('docs/platforms/agent-messaging.md', 'principal session generation exact-session principal target Local Cloud Bounded storage and audit retention');
      write('skills/memesh/SKILL.md', 'message polling active compatible managed host stopped, missing, or replaced session message storage report');
      write('llms-install.md', '22.13.0 memesh doctor message memesh-router memesh-host-codex memesh-host-claude memesh-host-acp --config message storage report');
      write('README.md', 'message memesh agent setup codex-session without polling or a human reminder stopped, missing, or disconnected Codex session message storage report');
      write('README.zh-TW.md', 'message memesh agent setup codex-session 沒有輪詢或人工提醒 停止、缺失或斷線 message storage report');
      write('README.de.md', 'message memesh agent setup codex-session ohne Polling oder menschliche Erinnerung gestoppte, fehlende oder getrennte Codex-Session message storage report');
      write('.mcp.json', 'memesh ${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js');
      write('.claude-plugin/plugin.json', '"name": "memesh" "version"');
      write('.claude-plugin/marketplace.json', '"name": "pcircle-memesh" "version"');
      write('hooks/hooks.json', 'session-start.js session-summary.js pre-compact.js user-prompt-intent.js pre-edit-recall.js guard-check.js post-commit.js codex-session.js startup|resume "async": true');
      write('package.json', JSON.stringify({
        engines: { node: '>=22.13.0' },
        scripts: { release: 'check-agent-message-sync.mjs test:packaged' },
        bin: {
          'memesh-router': 'dist/host-runtime/router.js',
          'memesh-host-codex': 'dist/host-runtime/codex.js',
          'memesh-host-codex-session': 'dist/host-runtime/codex-session.js',
          'memesh-host-claude': 'dist/host-runtime/claude.js',
          'memesh-host-acp': 'dist/host-runtime/acp.js',
        },
      }));
      const pass = spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      expect(pass.status).toBe(0);
      write('src/transports/mcp/handlers.ts', "name: 'message' name === 'message' MessageSchema executeAgentMessageAction");
      const missingPublicTargetKind = spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      expect(missingPublicTargetKind.status).toBe(1);
      expect(missingPublicTargetKind.stderr).toContain('public MCP message target_kind principal/session schema');
      write('src/transports/mcp/handlers.ts', mcpMessageSchema);
      write('src/transports/cli/cli.ts', cliMappings.replace(".command('watch')\n.action(() => ({ action: 'poll' }))", ".command('watch')\n.action(() => ({ action: 'fetch' }))") + cliRequired);
      const wrongMapping = spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      expect(wrongMapping.status).toBe(1);
      expect(wrongMapping.stderr).toContain('CLI command "watch" mapped to action "poll"');
      write('src/transports/cli/cli.ts', cliMappings + cliRequired);
      fs.rmSync(path.join(root, 'dist/host-adapters/acp-client.js'));
      const failed = spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('dist/host-adapters/acp-client.js (missing)');
      write('dist/host-adapters/acp-client.js');
      fs.rmSync(path.join(root, 'dist/host-runtime/router.js'));
      const missingRunner = spawnSync(process.execPath, ['scripts/check-agent-message-sync.mjs', '--root', root], { cwd: repoRoot, encoding: 'utf8' });
      expect(missingRunner.status).toBe(1);
      expect(missingRunner.stderr).toContain('dist/host-runtime/router.js (missing)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Title deliberately avoids spelling the forbidden form — the scan below
  // reads this file too, and a test that fails on its own name is noise.
  it('resolves module paths with fileURLToPath, never the URL pathname property', () => {
    // On Windows that returns a leading-slash drive path ("/D:/repo/..."), and
    // `path.join`/`path.resolve` then concatenate it with the cwd drive into
    // "D:\D:\repo\..." — a path that cannot exist. `fileURLToPath` does the
    // OS-correct conversion.
    //
    // This is a structural gate rather than a note because the note already
    // existed: `scripts/check-version-coherence.mjs` carries a paragraph
    // explaining the exact failure, and a test written later in the same
    // release reintroduced it and took both Windows CI legs down. A trap that
    // has bitten twice needs something that fails, not something that explains.
    const roots = ['src', 'scripts', 'tests'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '_generated') continue;
          walk(rel);
        } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name)) {
          const text = read(rel);
          // Skip the line that documents the hazard rather than commits it.
          for (const [i, line] of text.split('\n').entries()) {
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
            if (/new URL\([^)]*\)\s*\.pathname/.test(line)) offenders.push(`${rel}:${i + 1}`);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it('can actually reach its release-only branch', () => {
    // The `[Unreleased]` anchor is a hard error on a release run and a note on
    // a feature branch. The first version keyed that on `MEMESH_RELEASE === '1'`
    // with a comment saying the publish workflow set it. Nothing set it — not
    // the workflow, not prepublishOnly, not a test — so the branch was dead and
    // the one anchor the gate cannot cross-check any other way stayed waived on
    // the publish path. A gate whose trigger never fires is the defect this
    // whole release is about, one level up.
    const text = read('scripts/check-version-coherence.mjs');
    // Inferred from signals npm and GitHub set on their own, not only from an
    // env var a human has to remember.
    expect(text).toMatch(/npm_command === 'publish'/);
    expect(text).toMatch(/GITHUB_EVENT_NAME === 'release'/);
    // ...and the publish workflow states the intent at the call site.
    expect(read('.github/workflows/publish-npm.yml')).toMatch(/MEMESH_RELEASE:\s*'1'/);
  });

  it('the publish path does not build the dashboard twice', () => {
    // ci.yml removed this step because building it once in `npm run build` and
    // again afterwards meant the release gate diffed the artifact produced by
    // the unpinned install. Leaving the copy in the publish workflow is the
    // same two-hand-maintained-lists problem the gate exists to prevent.
    expect(read('.github/workflows/publish-npm.yml')).not.toMatch(/cd dashboard && npm ci/);
  });

  it('the test runner it shares with prepublishOnly also isolates HOME', () => {
    // Same guarantee, other entry point. `prepublishOnly` reaches the suite
    // through run-tests-isolated.mjs rather than this script, and it had the
    // identical hazard until it was extracted.
    const text = read('scripts/run-tests-isolated.mjs');
    expect(text).toMatch(/mkdtempSync/);
    expect(text).toMatch(/HOME:\s*home/);
    // MEMESH_DB_PATH must stay unset — pointing it at an existing file breaks
    // session-start-telemetry's "short-circuits on missing DB" case.
    expect(text).not.toMatch(/MEMESH_DB_PATH:/);
    // ...and must be actively REMOVED from the inherited environment, not just
    // left unset here. Not setting it does nothing if the caller exported it.
    expect(text).toMatch(/delete env\.MEMESH_DIR/);
    expect(text).toMatch(/delete env\.MEMESH_DB_PATH/);
  });
});
