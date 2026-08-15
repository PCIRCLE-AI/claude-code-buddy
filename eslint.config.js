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
  {
    // Compiled copies of runtime-leaf modules (generate-hook-core.mjs). The
    // SOURCE in src/ is linted in full; these are verbatim tsc output, and
    // tsc does not keep an `eslint-disable-next-line` attached to the line
    // it disabled. `buildReferenceContext`'s control characters are the
    // documented point of that regex (they are the line separators `\s`
    // misses), so the rule is off for the copies rather than restated as a
    // comment the compiler will detach again.
    files: ['scripts/hooks/_generated/**'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Test files, and only test files.
    //
    // `no-explicit-any` is off here because a test's job includes reaching past
    // a type: stubbing an internal, handing a function the malformed payload the
    // type says it cannot receive, casting a spy. There were 201 of them when
    // this directory was first linted, and the alternative to switching the rule
    // off is 201 inline `eslint-disable` comments, which is the same decision
    // written 201 times and read by nobody. In `src/` and `dashboard/src/` the
    // rule stays on.
    //
    // `no-control-regex` is off for the same reason in miniature: several suites
    // exist specifically to prove that control characters are handled, so the
    // regex containing one IS the test.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    // The core engine is where "fake working" lives: a silent `catch {}` here
    // turns a real failure (corrupt config, unreadable transcript, dead LLM
    // call) into an all-green no-op. In src/core an empty catch must carry a
    // one-line reason — `catch { /* why */ }` satisfies the rule, `catch {}`
    // does not. This makes every swallowed error a decision someone wrote down
    // rather than an accident. See docs prevention rule #4 in the audit.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
);
