/**
 * Build the environment a child process spawned by a release/packaging
 * script should run under: a test-owned HOME/USERPROFILE/MEMESH_DIR/
 * MEMESH_DB_PATH, provider auto-detection turned off, and every provider
 * credential/endpoint variable that could turn it back on stripped from
 * what would otherwise be a full `...baseEnv` spread.
 *
 * Originally written only for `scripts/dashboard-e2e-smoke.mjs` (GitHub
 * issue #271: the packaged Dashboard E2E gave the child runtime an isolated
 * MEMESH_DB_PATH but otherwise spread the maintainer's real process.env, so
 * a shell with a configured provider made the "isolated" server start in
 * Smart Mode against a real LLM). Moved here when `scripts/smoke-packed-
 * artifact.mjs` needed the identical isolation for the same reason: its
 * `nativeEnv` set MEMESH_DIR but left MEMESH_DB_PATH to leak through from
 * `...process.env`, so an ambient MEMESH_DB_PATH sent the installed
 * `memesh-router`'s data directory (`getMemeshDirFromDbPath()` follows
 * MEMESH_DB_PATH, not MEMESH_DIR) to the ambient location while the token
 * file path — built from the isolated MEMESH_DIR — still pointed at a
 * directory nothing had created, producing an ENOENT the smoke could not
 * explain from its own source. Two independent scripts hand-rolling the same
 * isolation is exactly how the second copy drifted; one owner fixes both.
 *
 * Pure and side-effect-free on purpose — `tests/release-scripts-safety.test.ts`
 * imports it directly and calls it with a deliberately polluted `baseEnv` to
 * pin this isolation as a regression test, without spawning `npm pack`,
 * installing a tarball, or launching a browser.
 *
 * The stripped names are exactly what `src/core/config.ts`'s `detectFromEnv`
 * reads (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST`) plus
 * `MEMESH_AUTO_DETECT_LLM` itself. Keeping the two lists in lockstep is the
 * point: a name added to one without the other is exactly the gap GitHub
 * issue #271 found.
 */
export function buildIsolatedRuntimeEnv(baseEnv, { runtimeHome, memeshDir, dbPath }) {
  const isolatedEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    MEMESH_DIR: memeshDir,
    MEMESH_DB_PATH: dbPath,
    MEMESH_AUTO_DETECT_LLM: '0',
  };
  delete isolatedEnv.ANTHROPIC_API_KEY;
  delete isolatedEnv.OPENAI_API_KEY;
  delete isolatedEnv.OLLAMA_HOST;
  return isolatedEnv;
}

/**
 * The other half of the same question: an environment for a child that must
 * resolve its own `~/.memesh` FROM the throwaway HOME, rather than be pointed
 * at one path.
 *
 * `scripts/run-tests-isolated.mjs` explains why the suite must not be handed a
 * MEMESH_DB_PATH — several hook tests exercise the "no database yet" branches,
 * and pointing the variable at an existing file makes them unreachable. So the
 * paths are DELETED here, not set. Everything else is identical to
 * `buildIsolatedRuntimeEnv`, and that is the point: `run-tests-isolated.mjs`,
 * `audit/mutation-sample.mjs` and `audit/measure-injection-tokens.mjs` each
 * hand-rolled this, and two of the three had only pinned HOME — which is not
 * isolation, because `src/core/paths.ts` resolves MEMESH_DIR and
 * MEMESH_DB_PATH BEFORE falling back to HOME. An ambient MEMESH_DB_PATH in the
 * maintainer's shell (a normal state while debugging against a copy) therefore
 * sent a mutation run, or an injection measurement, at the real graph — while
 * each script's own comments promised isolation.
 *
 * One difference from the runtime variant, and it is deliberate: this one does
 * NOT pin `MEMESH_AUTO_DETECT_LLM=0`. Removing the credentials already leaves
 * auto-detection nothing to find, and pinning the flag additionally disables
 * `tests/fixtures/isolated-provider-env.probe.test.ts`'s "still permits an
 * intentional in-test provider fixture" case, which sets `OPENAI_API_KEY`
 * inside the test on purpose. Measured, not reasoned: pinning it turned that
 * test red. A packaged smoke has no such fixtures, so the runtime variant
 * keeps the belt-and-braces flag.
 */
export function buildIsolatedSuiteEnv(baseEnv, { runtimeHome }) {
  const isolatedEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
  };
  delete isolatedEnv.MEMESH_DIR;
  delete isolatedEnv.MEMESH_DB_PATH;
  delete isolatedEnv.ANTHROPIC_API_KEY;
  delete isolatedEnv.OPENAI_API_KEY;
  delete isolatedEnv.OLLAMA_HOST;
  return isolatedEnv;
}
