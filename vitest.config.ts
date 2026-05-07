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
    // Use forks pool to prevent SIGSEGV with better-sqlite3 native module
    pool: 'forks',
    singleFork: true,
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,

    // Force test timeout to prevent hanging
    testTimeout: 30000, // 30 seconds max per test
    hookTimeout: 10000, // 10 seconds for hooks

    // Environment configuration
    environment: 'node',

    // Coverage configuration (if needed)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
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
