// ESLint flat config (ESLint 9+)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'dashboard/dist/**',
      'dashboard/node_modules/**',
      '**/*.d.ts',
      'coverage/**',
      '.claude/**',
      '**/*.min.js',  // Minified third-party libraries
      'src/cli/assets/**',  // Dashboard assets (d3, etc.)
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        // Browser globals (for dashboard code)
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // Disable rules that conflict with project style
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // Security: prevent dangerous patterns
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // Code quality
      'no-console': 'off', // CLI tool, console is expected
      'prefer-const': 'warn',
      'no-var': 'error',
      // Technical debt - downgrade to warnings for gradual cleanup
      'no-empty': 'warn', // 10 instances - TODO: fix empty catch blocks
      'no-useless-assignment': 'warn', // 6 instances - TODO: remove unused vars
      'no-useless-escape': 'warn', // 5 instances - TODO: fix regex escapes
      'preserve-caught-error': 'warn', // 3 instances - TODO: preserve error causes
      'no-control-regex': 'warn', // 1 instance - TODO: review regex
    },
  },
);
