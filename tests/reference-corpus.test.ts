/**
 * Pins the rule that stops a sentence silencing the uncalled-gate detector.
 *
 * C3 in `scripts/audit/verification-audit.mjs` answers "does anything actually
 * run this script?" by counting basename occurrences. It counted raw text, so
 * prose counted. That is not a hypothetical: `measure-injection-tokens.mjs`'s
 * header sentence "Companion to measure-work-topology-baseline.mjs" made the
 * companion look called, and the companion's correct C3 entry was reported as
 * stale and pruned. The finding was then preserved as a WARNING inside the
 * other entry's reason field rather than fixed. It happened a second time the
 * moment a test header named `wait-for-checks.mjs`.
 *
 * Both directions matter here, and the second one more than usual: a
 * `stripComments` that stripped too little re-opens the hole, and one that
 * stripped everything would make every script look uncalled — loud, but
 * useless.
 */
// The fixtures below use INVENTED filenames on purpose. A first version used
// the real ones, and the strings holding them counted as references in exactly
// the detector this file exists to protect — the header comment above is
// stripped, a string literal is not. The property under test is "a comment is
// not a caller"; it does not need real names to be true.
import { describe, it, expect } from 'vitest';
import { stripComments } from '../scripts/lib/reference-corpus.mjs';

describe('a filename in a comment is not a caller', () => {
  it('drops a JS line comment', () => {
    const out = stripComments("// Companion to some-companion-script.mjs\nconst a = 1;", 'x.mjs');
    expect(out).not.toContain('some-companion-script.mjs');
    expect(out).toContain('const a = 1;');
  });

  it('drops a JSDoc block, which is where both real cases lived', () => {
    const out = stripComments('/**\n * Pins the guard in `some-watcher-script.mjs`.\n */\nrun();', 'x.ts');
    expect(out).not.toContain('some-watcher-script.mjs');
    expect(out).toContain('run();');
  });

  it('drops a YAML comment but keeps the command on the same line', () => {
    const out = stripComments('      run: node scripts/smoke-test.mjs # see also scripts/other.mjs\n', 'ci.yml');
    expect(out).toContain('node scripts/smoke-test.mjs');
    expect(out).not.toContain('scripts/other.mjs');
  });

  it('drops a shell comment', () => {
    expect(stripComments('# calls scripts/foo.mjs\nnode scripts/bar.mjs\n', 'x.sh')).not.toContain('foo.mjs');
  });
});

describe('what must survive stripping', () => {
  it('keeps a real invocation', () => {
    const src = "execFileSync('node', ['scripts/some-watcher-script.mjs']);";
    expect(stripComments(src, 'x.mjs')).toContain('scripts/some-watcher-script.mjs');
  });

  it('keeps an import specifier', () => {
    const src = "import { x } from './lib/some-lib-module.mjs';";
    expect(stripComments(src, 'x.mjs')).toContain('some-lib-module.mjs');
  });

  it('does not treat the `//` in a URL as a comment', () => {
    // A URL can legitimately carry a filename, and truncating the line there
    // would delete whatever followed on it.
    const src = "const u = 'https://example.com/a.mjs'; run('scripts/real.mjs');";
    expect(stripComments(src, 'x.mjs')).toContain('scripts/real.mjs');
  });

  it('leaves package.json alone — JSON has no comments to strip', () => {
    const src = '{"scripts": {"test": "node scripts/some-runner-script.mjs"}}';
    expect(stripComments(src, 'package.json')).toBe(src);
  });

  it('returns the text unchanged for an extension it does not know', () => {
    // Never silently lose a reference in a file type this has no rule for.
    const src = 'node scripts/foo.mjs # not necessarily a comment here';
    expect(stripComments(src, 'notes.txt')).toBe(src);
  });

  it('replaces a comment with a space rather than joining its neighbours', () => {
    // `a/* c */b` must not become `ab` — that would manufacture a token that
    // was never in the file.
    expect(stripComments('a/* c */b', 'x.mjs')).toBe('a b');
  });

  it('returns an empty string for a non-string, rather than throwing', () => {
    expect(stripComments(null as unknown as string, 'x.mjs')).toBe('');
  });
});
