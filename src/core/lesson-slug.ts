import { createHash } from 'node:crypto';

/**
 * The name key for an explicit lesson: a readable prefix plus a short digest
 * of the whole normalised error. The prefix keeps the key useful to a human;
 * the digest keeps lessons with the same opening words distinct.
 *
 * A leaf module on purpose. `lesson-engine.ts` keys new lessons with it, and
 * `storage/graph-repairs.ts` keys the lessons it splits out of a pre-4.8.2
 * `-other` bucket with it — the two must agree, or a lesson re-learned after
 * the split lands beside its own history instead of on it. The repair runs
 * from `db.ts`, which `lesson-engine.ts` imports, so the shared function has
 * to live below both.
 */
export function lessonSlug(error: string): string {
  const normalized = error.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const words = normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const readable = words.join('-') || 'unspecified';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${readable.slice(0, 71)}-${digest}`;
}
