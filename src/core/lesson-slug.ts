/**
 * The name key for an explicit lesson: the first eight significant words of
 * the error, lowercased, non-alphanumerics collapsed. Bounded so a
 * paragraph-length error does not become a paragraph-length entity name;
 * long enough that two different lessons do not collide on a shared opening
 * phrase.
 *
 * A leaf module on purpose. `lesson-engine.ts` keys new lessons with it, and
 * `storage/graph-repairs.ts` keys the lessons it splits out of a pre-4.8.2
 * `-other` bucket with it — the two must agree, or a lesson re-learned after
 * the split lands beside its own history instead of on it. The repair runs
 * from `db.ts`, which `lesson-engine.ts` imports, so the shared function has
 * to live below both.
 */
export function lessonSlug(error: string): string {
  const words = error
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const slug = words.join('-');
  return slug.length > 0 ? slug.slice(0, 80) : 'unspecified';
}
