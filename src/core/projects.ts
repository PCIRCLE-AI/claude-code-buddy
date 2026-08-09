// =============================================================================
// Projects — group entities by project for the dashboard Browse / Lessons UI
// =============================================================================
//
// MeMesh stores memories from multiple projects in one DB. The "project" of
// an entity is encoded two ways, neither of which is enforced at the schema
// level:
//   1) An explicit `project:<name>` tag (the canonical source)
//   2) An implicit prefix in the entity name (e.g. lesson-claude-code-buddy-X
//      where "claude-code-buddy" is the project)
//
// computeProjects() merges both signals and returns a sorted catalogue the
// dashboard can use for filter chips. Pure read-only aggregation; no side
// effects, no caching.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { KNOWN_ERROR_PATTERNS } from './lesson-engine.js';

export interface ProjectInfo {
  /** Canonical project key, suitable for matching against tag values. */
  name: string;
  /** How many entities belong to this project. */
  count: number;
  /** Distinct entity types observed within the project, sorted by count desc. */
  types: string[];
  /** Whether the assignment came from an explicit tag (vs. name-prefix heuristic). */
  source: 'tag' | 'heuristic' | 'mixed';
}

const PROJECT_TAG_PREFIX = 'project:';

/**
 * Heuristic: extract a project hint from an entity name like
 * "lesson-claude-code-buddy-config-error" → "claude-code-buddy".
 * Returns null when the name has no recognisable prefix.
 *
 * The lesson naming convention emitted by `lesson-engine.ts createLesson` is
 * `lesson-{project}-{errorPattern}` where `errorPattern` is itself one of a
 * fixed set produced by `inferErrorPattern()`. Several of those patterns
 * contain a dash (`config-error`, `import-missing`, `null-reference`,
 * `test-failure`, `build-error`), so the previous "split on the last dash"
 * approach was wrong — for `lesson-claude-code-buddy-config-error` it
 * yielded `claude-code-buddy-config` instead of `claude-code-buddy`.
 *
 * Fix: anchor on the fixed pattern set. Match the trailing slug against
 * `KNOWN_ERROR_PATTERNS` and treat everything before it as the project. We
 * intentionally restrict the heuristic to `lesson-` only — other prefixes
 * (`plan-`, `decision-`, etc.) have no fixed naming convention and the old
 * heuristic produced more wrong answers than right ones.
 */
export function extractProjectFromName(name: string): string | null {
  if (!name.startsWith('lesson-')) return null;
  const rest = name.slice('lesson-'.length);
  // Try each known pattern as the trailing slug.
  for (const pattern of KNOWN_ERROR_PATTERNS) {
    const suffix = `-${pattern}`;
    if (rest.endsWith(suffix)) {
      const project = rest.slice(0, rest.length - suffix.length);
      if (project.length >= 2) return project;
    }
  }
  return null;
}

/** Pull the project name out of a single entity's tags + name. */
export function extractProjectFromEntity(
  tags: string[] | null | undefined,
  name: string,
): { project: string | null; source: 'tag' | 'heuristic' | null } {
  if (tags) {
    const tagged = tags.find((t) => t.startsWith(PROJECT_TAG_PREFIX));
    if (tagged) return { project: tagged.slice(PROJECT_TAG_PREFIX.length), source: 'tag' };
  }
  const fromName = extractProjectFromName(name);
  if (fromName) return { project: fromName, source: 'heuristic' };
  return { project: null, source: null };
}

type RawEntity = {
  id: number;
  name: string;
  type: string;
  tags?: string;
};

export function computeProjects(db: MemeshDatabase): ProjectInfo[] {
  // Single pass: pull every active entity + its tags. We can't aggregate in
  // SQL because the project lookup walks both tags and the name heuristic.
  // json_group_array (rather than GROUP_CONCAT with a delimiter) keeps the
  // representation safe even if a tag value contains the delimiter char —
  // tags are user-supplied and the schema does not currently filter
  // newlines or commas.
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type,
      (SELECT json_group_array(t.tag) FROM tags t WHERE t.entity_id = e.id) AS tags
    FROM entities e
    WHERE e.status = 'active'
  `).all() as RawEntity[];

  const acc = new Map<string, { count: number; types: Map<string, number>; sources: Set<'tag' | 'heuristic'> }>();

  for (const row of rows) {
    let tagList: string[] = [];
    if (row.tags) {
      try {
        const parsed = JSON.parse(row.tags);
        if (Array.isArray(parsed)) tagList = parsed.filter((t): t is string => typeof t === 'string');
      } catch {
        /* unexpected non-JSON payload; treat as empty */
      }
    }
    const { project, source } = extractProjectFromEntity(tagList, row.name);
    if (!project || !source) continue;
    let bucket = acc.get(project);
    if (!bucket) {
      bucket = { count: 0, types: new Map(), sources: new Set() };
      acc.set(project, bucket);
    }
    bucket.count++;
    bucket.types.set(row.type, (bucket.types.get(row.type) ?? 0) + 1);
    bucket.sources.add(source);
  }

  return Array.from(acc.entries())
    .map<ProjectInfo>(([name, bucket]) => ({
      name,
      count: bucket.count,
      types: Array.from(bucket.types.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t),
      source: bucket.sources.size === 2 ? 'mixed' : (bucket.sources.has('tag') ? 'tag' : 'heuristic'),
    }))
    .sort((a, b) => b.count - a.count);
}
