import type { StructuredLesson } from './failure-analyzer.js';
import { remember, recall } from './operations.js';
import type { LessonSeverity } from './types.js';
import { getDatabase } from '../db.js';

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
  // recall() returns the entity if it exists; empty array means it's new.
  const existing = recall({ query: name, limit: 1 });
  const isNew = existing.length === 0 || existing[0].name !== name;

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
  }
): { name: string } {
  const errorPattern = opts?.errorPattern || inferErrorPattern(error);
  const name = `lesson-${projectName}-${errorPattern}`;

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

/**
 * Find existing lessons for a project.
 * Used by session-start for proactive warnings.
 */
export function findProjectLessons(
  projectName: string,
  limit: number = 5
): Array<{ name: string; observations: string[]; confidence?: number }> {
  const results = recall({
    tag: `project:${projectName}`,
    limit,
  });

  return results
    .filter(e => e.type === 'lesson_learned')
    .map(e => ({
      name: e.name,
      observations: e.observations,
      confidence: e.confidence,
    }));
}

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
export { inferErrorPattern };
