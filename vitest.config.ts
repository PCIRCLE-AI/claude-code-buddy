import { defineConfig } from 'vitest/config';

export default defineConfig({
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

    // File patterns
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts', 'tests/**/*.spec.ts', 'scripts/**/*.test.js'],
    exclude: ['node_modules', 'dist'],

    // Explicit cleanup on test completion
    teardownTimeout: 5000,

    // Reporters
    reporters: ['default'],
  },
});
