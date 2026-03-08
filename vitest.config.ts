import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CRITICAL: Disable parallelism to prevent worker pool leaks
    // Issue: Worker processes (vitest 1-6) were not being terminated
    // Result: 56 zombie processes accumulating over 10+ hours

    // OPTION 1: Use threads with singleThread mode (recommended)
    pool: 'forks',
    // Vitest 4.x: poolOptions moved to top-level
    singleFork: true,
    // Explicit limits as fallback
    maxForks: 1,
    minForks: 1,

    // OPTION 2: Disable file parallelism entirely
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
    exclude: ['node_modules', 'dist', 'scripts/hooks/__tests__/hooks.test.js'],

    // Explicit cleanup on test completion
    teardownTimeout: 5000,

    // Reporters
    reporters: ['default'],
  },
});
