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
        // Node 20+ web standard globals
        URL: 'readonly',
        URLSearchParams: 'readonly',
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
      // Hooks use the canonical pattern `try { stderr.write(...) } catch {}`
      // so even logging a failure cannot crash the hook itself. Allow
      // empty `catch {}`; any other empty block (e.g. empty if-body)
      // still warns.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
      'no-control-regex': 'warn',
    },
  },
);
