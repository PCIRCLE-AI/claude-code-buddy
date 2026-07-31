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

  it('runs the suite under a throwaway HOME', () => {
    const text = read(script);
    expect(text).toMatch(/mktemp -d/);
    // The HOME override has to be ON the test command. Creating a temp dir and
    // then not using it for the run is the shape this replaced.
    expect(text).toMatch(/HOME="\$\w+"\s+npx vitest run/);
  });

  it('does not write to, move, or strip the real config', () => {
    const text = read(script);

    // The specific operations the old version performed. Any of them returning
    // means the credential-handling regressed, whatever the surrounding code
    // looks like.
    const offenders = [
      /\btrap\b[^\n]*config\.json/,
      /(cp|mv|rm)\s[^\n]*\$HOME\/\.memesh/,
      /(cp|mv|rm)\s[^\n]*~\/\.memesh/,
      /jq[^\n]*\bdel\(\.llm\)/,
      />\s*"?\$HOME\/\.memesh\/config\.json/,
    ];
    for (const pattern of offenders) {
      expect(text).not.toMatch(pattern);
    }
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
  });
});
