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

function filesSeenBy(project: string): string[] {
  const out = execFileSync(process.execPath, [TSC, '-p', project, '--listFilesOnly'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).map(norm);
}

describe('typecheck scope', () => {
  it('every test file vitest collects is inside a type-check project', () => {
    const collected = walk(path.join(repoRoot, 'tests')).map(norm);
    // Without this the comparison below is "no file was missing from a set of
    // zero", which passes for the wrong reason.
    expect(collected.length).toBeGreaterThan(50);
    expect(collected.some(f => f.endsWith('.test.tsx'))).toBe(true);

    const seen = new Set(PROJECTS.flatMap(filesSeenBy));
    expect(seen.size).toBeGreaterThan(100);

    expect(collected.filter(f => !seen.has(f))).toEqual([]);
  }, 60_000);
});
