import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  // Use the same Preact JSX pragma the dashboard build uses, so .tsx test
  // files in tests/dashboard/ render Preact components without manual
  // /** @jsx */ pragmas.
  plugins: [preact()],
  // Dedupe Preact so the dashboard component (via dashboard/node_modules)
  // and the test runner (via root node_modules) share one Preact / hooks
  // module — otherwise hooks like useMemo / useRef look up state in the
  // wrong module instance and crash with "__H undefined".
  resolve: {
    dedupe: ['preact', 'preact/hooks'],
  },
  test: {
    // Use forks pool to prevent SIGSEGV with better-sqlite3 native module.
    pool: 'forks',

    // One worker, one file at a time. Several test files share one HOME and
    // therefore one SQLite database, and running them concurrently deadlocks on
    // the write lock — this is load-bearing, not a preference.
    //
    // It used to read `singleFork: true, maxForks: 1, minForks: 1` at this
    // level. **None of those three exists in Vitest 4's config type.** They were
    // silently ignored, and only `fileParallelism` was doing any work. Nothing
    // caught it because `npm run typecheck` pointed at `tsconfig.json`, whose
    // `include` is `src/**/*.ts` — this file had never been type-checked. It is
    // now, via `tsconfig.check.json`, and putting the old keys back fails the
    // check.
    maxWorkers: 1,
    fileParallelism: false,

    // Force test timeout to prevent hanging
    testTimeout: 30000, // 30 seconds max per test
    // 30s, not 10s. Every DB test's afterEach closes SQLite and recursively
    // removes a temp directory, and on Windows that is routinely slower than
    // on POSIX — SQLite leaves -wal/-shm beside the database, and the OS (plus
    // whatever scans files on a CI runner) can hold a handle open for a moment
    // after close. Measured: `tests/core/export-import.test.ts` hit
    // "Hook timed out in 10000ms" on windows-latest / Node 24 in CI, in a
    // docs-only pull request. The removal was not failing, it was slow; a
    // budget that only fits the fastest platform turns that into a red build
    // on an unrelated change. The retries added alongside this (maxRetries /
    // retryDelay on every recursive rmSync in tests/) handle the other half —
    // a handle that is briefly still open.
    hookTimeout: 30000,

    // Environment configuration
    environment: 'node',

    // Node 26 ships the Web Storage API, which shadows happy-dom's
    // localStorage with an undefined one. See the file for the measurement
    // and for why the tidier `--no-experimental-webstorage` route does not
    // work here.
    setupFiles: ['./tests/setup/webstorage.ts'],

    // Coverage. Two things were wrong with this block for its whole life.
    //
    // FIRST, `@vitest/coverage-v8` was never installed, so `vitest --coverage`
    // answered `MISSING DEPENDENCY` and nobody could run it. The block was
    // labelled "(if needed)" and had never been needed, which is how a
    // 2,199-line module reached one assertion without anyone being able to see
    // it.
    //
    // SECOND, and worse once it did run: with no `coverage.include`, v8 reports
    // only files a test IMPORTED. A module no test touches is not 0% — it is
    // absent, and the summary then read **72.05%** while seven of the
    // fifty-three files under `src/` were missing from the report entirely,
    // among them `cli/view-live.ts` (2,199 lines) and `mcp/launcher.ts`, the
    // entry point every MCP client executes. With the globs below the same suite
    // measures **48.86%**. A coverage report that cannot show you a zero is a
    // gate that cannot fail, which is the defect this repository keeps finding
    // in other shapes.
    //
    // `all: true` is NOT the fix here and is not a valid option in Vitest 4 —
    // `include` is what widens the denominator. Verified by running one test
    // file: the denominator stays at 8,593 statements either way.
    coverage: {
      provider: 'v8',
      // Floors, not goals, and the ratchet only turns one way: raise a number
      // when the suite clears it comfortably, never lower one to make a red
      // run green. Measured 2026-08-04 via `npm run test:coverage` on macOS:
      // statements 48.83, branches 45.9, functions 50, lines 50.09 — floors
      // sit 1-2 points under that for platform variance. Before these
      // existed, `test:coverage` had zero automated callers and no threshold:
      // a coverage run that nothing runs and nothing fails is not a gate.
      thresholds: {
        statements: 47,
        branches: 44,
        functions: 48,
        lines: 48,
      },
      include: ['src/**/*.ts', 'scripts/hooks/*.js', 'dashboard/src/**/*.{ts,tsx}'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
        // Build-generated mirrors of src/ modules; the originals are measured.
        'scripts/hooks/_generated/**',
      ],
    },

    // File patterns — .tsx covers dashboard component tests
    include: [
      'src/**/*.test.ts', 'src/**/*.spec.ts',
      'tests/**/*.test.ts', 'tests/**/*.spec.ts',
      'tests/**/*.test.tsx',
      'scripts/**/*.test.js',
    ],
    exclude: ['node_modules', 'dist'],

    // Explicit cleanup on test completion
    teardownTimeout: 5000,

    // Reporters
    reporters: ['default'],
  },
});
