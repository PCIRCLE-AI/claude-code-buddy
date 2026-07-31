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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  it('the docs gate counts hooks, not build output that lives beside them', () => {
    // `find scripts/hooks -name '*.js' ! -name '_shared.js'` recursed into
    // `scripts/hooks/_generated/`, so when the build mirror landed there the
    // count went 7 -> 9 and the gate reported FAIL on a correct tree. A gate
    // that fails on a healthy repo gets ignored, and then it is not a gate.
    const text = read('scripts/verify-docs-sync.sh');
    expect(text).toMatch(/find scripts\/hooks -maxdepth 1/);
    expect(text).toMatch(/! -name "_\*"/);
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
