import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every test file vitest runs must be inside one of the two type-check projects.
 *
 * `npm run typecheck` is two `tsc -p` passes, and a file in neither is not
 * "loosely checked" — it is not checked at all, while vitest happily executes
 * it. That hole was real and had exactly the shape this repository keeps
 * finding: `tsconfig.check.json` includes `tests/**\/*.ts` (no `.tsx`) and
 * excludes `tests/dashboard/**`; the dashboard project included only
 * `tests/dashboard/**`. A `.tsx` test in any third directory fell between them.
 * Measured before the fix, with `const broken: number = "string"` planted in
 * `tests/transports/zz.test.tsx`: both passes exited 0.
 *
 * Asked of tsc rather than of the config files. Comparing `include` globs to a
 * list of expected globs would be restating the configuration, which is the
 * failure mode where a check degrades into a copy of the thing it checks —
 * `--listFilesOnly` reports what the compiler actually read.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECTS = ['tsconfig.check.json', 'tsconfig.check-dashboard.json'];

/** Suffixes vitest collects under `tests/` — see `vitest.config.ts`'s `include`. */
const COLLECTED = ['.test.ts', '.test.tsx', '.spec.ts'];

function norm(p: string): string {
  const abs = path.resolve(p).split(path.sep).join('/');
  // tsc prints `C:/…` while `path.resolve` yields `C:\…`, and the drive letter's
  // case is not stable between the two on Windows. Compare case-insensitively
  // there, where the filesystem is anyway.
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return COLLECTED.some(s => e.name.endsWith(s)) ? [full] : [];
  });
}

/**
 * `node node_modules/typescript/bin/tsc`, not `npx tsc`.
 *
 * `execFileSync('npx', …)` is the Windows trap this repository has already paid
 * for twice: npx is `npx.cmd` there, `execFile` does not consult `PATHEXT`, and
 * naming the `.cmd` explicitly then fails `EINVAL` because Node refuses to spawn
 * one without a shell (CVE-2024-27980). `scripts/lib/npm-bin.mjs` exists to own
 * that, and its own comment says "one owner, so a third caller cannot get it
 * wrong a third way" — this file was the third caller, and CI went red on
 * windows-latest for exactly that reason.
 *
 * Running the compiler's entry point through `process.execPath` sidesteps it
 * entirely: one real executable, an argument array, no shell on any platform.
 */
const TSC = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Split tsc's `--listFilesOnly` output into normalised absolute paths.
 *
 * Its own function so the line-ending handling can be tested on a machine that
 * does not produce the problem. `\r?\n`, not `\n`: tsc terminates its lines with
 * CRLF on Windows, and splitting on `\n` alone leaves a trailing `\r` glued to
 * every path. That does not make the set empty — so a size check still looked
 * healthy while not one entry compared equal, and CI went red on
 * windows-latest with all 103 files reported missing at once.
 */
function parseListFiles(out: string): string[] {
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(norm);
}

function filesSeenBy(project: string): string[] {
  return parseListFiles(
    execFileSync(process.execPath, [TSC, '-p', project, '--listFilesOnly'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  );
}

describe('typecheck scope', () => {
  it('reads the compiler output the same way on CRLF and LF', () => {
    // The Windows failure this pins had no local symptom: macOS and Linux tsc
    // emit LF, so the bug was invisible until a runner produced CRLF. Feeding
    // both endings to the parser directly reproduces it anywhere.
    const paths = ['/a/one.ts', '/a/two.tsx', '/a/three.ts'];
    const lf = parseListFiles(paths.join('\n') + '\n');
    const crlf = parseListFiles(paths.join('\r\n') + '\r\n');
    expect(lf).toEqual(paths.map(norm));
    expect(crlf).toEqual(lf);
  });

  it('every test file vitest collects is inside a type-check project', () => {
    const collected = walk(path.join(repoRoot, 'tests')).map(norm);
    // Without this the comparison below is "no file was missing from a set of
    // zero", which passes for the wrong reason.
    expect(collected.length).toBeGreaterThan(50);
    expect(collected.some(f => f.endsWith('.test.tsx'))).toBe(true);

    const seen = new Set(PROJECTS.flatMap(p => filesSeenBy(p)));
    expect(seen.size).toBeGreaterThan(100);
    // A size check does not prove the entries are comparable — a line-ending
    // difference kept every path distinct-but-unequal and `seen.size` stayed
    // large. This file is inside one of the two projects by construction, so if
    // it is not in the set the parsing is wrong, not the configuration.
    expect(seen.has(norm(fileURLToPath(import.meta.url)))).toBe(true);

    expect(collected.filter(f => !seen.has(f))).toEqual([]);
  }, 60_000);
});
