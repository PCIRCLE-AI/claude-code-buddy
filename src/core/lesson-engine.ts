import type { StructuredLesson } from './failure-analyzer.js';
import { remember } from './operations.js';
import type { LessonSeverity } from './types.js';
import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { lessonSlug } from './lesson-slug.js';

/**
 * Create or update a structured lesson entity.
 * Uses lesson-{project}-{errorPattern} naming for upsert dedup.
 * Same error pattern = same entity = observations appended (not duplicated).
 *
 * SECURITY: this path runs from session-summary.js → analyzeFailure (LLM
 * paraphrasing of error text from a session transcript). The transcript
 * may contain attacker-controlled content (e.g. a malicious dependency
 * printing prompt-injection text in its error output). The resulting
 * lesson is therefore marked `trust: 'untrusted'` so
 * `isTrustedForAutoContext()` filters it out of session-start auto-context
 * injection. The lesson still lives in the DB and is searchable via
 * explicit `recall`, but it does NOT get surfaced as proactive guidance
 * unless a maintainer reviews it.
 */
export function createLesson(
  lesson: StructuredLesson,
  projectName: string
): { name: string; isNew: boolean } {
  const name = `lesson-${projectName}-${lesson.errorPattern}`;

  // Check existence BEFORE remember() so we can reliably detect new vs upsert.
  //
  // By NAME, not by recall. This used to be `recall({ query: name, limit: 1
  // })` — a fuzzy search, to answer a question about an exact key. It cost
  // three things: it matched some OTHER memory whenever the lesson did not
  // exist yet (the `existing[0].name !== name` clause below is the evidence
  // that its author knew), it ran the whole ranking stack for one lookup,
  // and — because a search counts as a use — it bumped `access_count` and
  // stamped `last_accessed_at` on that unrelated memory. Every LLM-generated
  // lesson therefore manufactured one "memory reused this week", which is
  // the dashboard's headline number.
  const isNew = new KnowledgeGraph(getDatabase()).getEntity(name) === null;

  remember({
    name,
    type: 'lesson_learned',
    observations: [
      `Error: ${lesson.error}`,
      `Root cause: ${lesson.rootCause}`,
      `Fix: ${lesson.fix}`,
      `Prevention: ${lesson.prevention}`,
    ],
    tags: [
      `project:${projectName}`,
      `error-pattern:${lesson.errorPattern}`,
      `fix-pattern:${lesson.fixPattern}`,
      `severity:${lesson.severity}`,
      'source:auto-learned',
    ],
    trustOverride: 'untrusted',
    provenanceOverride: { source: 'auto-learned' },
  });

  return { name, isNew };
}

/**
 * Create a lesson from explicit user input (for the learn tool).
 * Does not require LLM — user provides the structured fields.
 */
export function createExplicitLesson(
  error: string,
  fix: string,
  projectName: string,
  opts?: {
    rootCause?: string;
    prevention?: string;
    severity?: LessonSeverity;
    errorPattern?: string;
    sourceHost?: string;
  }
): { name: string } {
  const errorPattern = opts?.errorPattern || inferErrorPattern(error);
  // Keyed on the lesson's own content, not on the nine-value error enum.
  //
  // `lesson-${project}-${errorPattern}` is the right key for an LLM-derived
  // lesson from a RECURRING runtime error: same pattern, same entity, the
  // observations accumulate. It is the wrong key for an explicit lesson,
  // where the categories are all code-level runtime errors and anything about
  // test design, a security boundary, or a process falls into `other` — one
  // bucket per project. Measured on a real graph: one `-other` entity holding
  // 68 observations, roughly seventeen unrelated lessons fused, retrieved 61
  // times and matched 3. Re-submitting the SAME error text still lands on the
  // same slug, so the append/dedupe contract for a repeated lesson holds.
  //
  // A caller that passes an explicit `errorPattern` is the recurring-error
  // path (dreamer / failure-analyzer), where "same pattern = same entity" is
  // the contract and confidence-reset-on-reconfirm depends on the key being
  // stable. Only the unkeyed explicit `learn` gets the content slug.
  const name = opts?.errorPattern
    ? `lesson-${projectName}-${errorPattern}`
    : `lesson-${projectName}-${lessonSlug(error)}`;

  remember({
    name,
    type: 'lesson_learned',
    observations: [
      `Error: ${error}`,
      `Root cause: ${opts?.rootCause || 'Not specified'}`,
      `Fix: ${fix}`,
      `Prevention: ${opts?.prevention || 'Review similar code paths'}`,
    ],
    tags: [
      `project:${projectName}`,
      `error-pattern:${errorPattern}`,
      `severity:${opts?.severity || 'minor'}`,
      'source:explicit',
    ],
    sourceHost: opts?.sourceHost,
  });

  // Explicit user `learn` = highest-trust signal: user asserted "this
  // happened, here's the fix." Reset confidence to 1.0 so a freshly
  // re-confirmed lesson is not held back by the lifecycle decay applied
  // before the re-confirmation.
  getDatabase()
    .prepare('UPDATE entities SET confidence = 1.0 WHERE name = ?')
    .run(name);

  return { name };
}

// `findProjectLessons` was removed in 2026-05 (SDD G8 cleanup). The
// session-start hook (scripts/hooks/session-start.js) does not use it
// — that path executes its own raw SQL with a trust filter
// (`isTrustedForAutoContext`) the helper did not enforce. Keeping the
// helper around as "documentation that this query exists" only invited
// future drift between two separate lookup paths. Use the hook's
// query directly if a similar lookup is needed elsewhere.

/**
 * Infer error pattern from error description text.
 * Simple heuristic — used when user doesn't specify pattern.
 */
/**
 * The fixed set of error patterns `inferErrorPattern` can return.
 * Exported so other modules (notably `projects.ts`) can anchor on the
 * same set instead of duplicating the strings — preventing silent
 * drift if a new pattern is added here.
 */
export const KNOWN_ERROR_PATTERNS = [
  'null-reference',
  'type-error',
  'import-missing',
  'config-error',
  'test-failure',
  'build-error',
  'other',
] as const;

function inferErrorPattern(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('null') || lower.includes('undefined') || lower.includes('cannot read prop')) return 'null-reference';
  if (lower.includes('type') && (lower.includes('error') || lower.includes('mismatch'))) return 'type-error';
  if (lower.includes('import') || lower.includes('module not found') || lower.includes('cannot find')) return 'import-missing';
  if (lower.includes('config') || lower.includes('env') || lower.includes('environment')) return 'config-error';
  if (lower.includes('test') && (lower.includes('fail') || lower.includes('assert'))) return 'test-failure';
  if (lower.includes('build') || lower.includes('compile') || lower.includes('tsc')) return 'build-error';
  return 'other';
}

// Export for testing
export { inferErrorPattern, lessonSlug };
