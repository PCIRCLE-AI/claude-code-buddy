import { execFileSync } from 'node:child_process';

/**
 * Fail if `scripts/hooks/_generated/` is stale.
 *
 * `npm run build` regenerates it from the compiled leaf modules. If someone
 * edited `src/core/paths.ts` or `src/storage/fts-index.ts` without
 * regenerating and committing the hook copy, the build just rewrote it and
 * this diff is non-empty — the F5 mirror has drifted, which is the class of
 * bug behind the P0 FTS omission (a hook wrote an entity but indexed it
 * differently from core, so the memory was stored and unrecallable).
 *
 * MUST run after `npm run build`.
 *
 * Extracted from an inline block in ci.yml because the publish workflow needs
 * the same gate and did not have it. Two hand-maintained copies of "what must
 * be true before this ships" is how the publish path ended up with fewer
 * checks than the PR path — the same shape as the hook and bin lists in
 * scripts/lib/executable-targets.mjs.
 */
const MIRROR_PATH = 'scripts/hooks/_generated';

let diff;
try {
  diff = execFileSync('git', ['--no-pager', 'diff', '--', MIRROR_PATH], { encoding: 'utf8' });
} catch (err) {
  console.error(`✗ could not run git diff on ${MIRROR_PATH}: ${err.message}`);
  process.exit(1);
}

if (diff.trim() !== '') {
  console.error(
    `✗ ${MIRROR_PATH} is stale — run 'npm run build' and commit the regenerated files.\n`
  );
  console.error(diff);
  process.exit(1);
}

console.log(`✓ generated hook-core mirror is committed and current`);
