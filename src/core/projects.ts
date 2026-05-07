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

import type Database from 'better-sqlite3';

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
 * Strategy: name patterns from the failure-analyzer + lesson-engine generate
 * `lesson-{project}-{errorPattern}` and `{type}-{project}-...`. We strip a
 * known type prefix, then take everything except the trailing slug.
 */
const NAME_PREFIX_TYPES = ['lesson', 'plan', 'decision', 'pattern', 'feature', 'bug', 'note'];

export function extractProjectFromName(name: string): string | null {
  for (const prefix of NAME_PREFIX_TYPES) {
    if (!name.startsWith(`${prefix}-`)) continue;
    const rest = name.slice(prefix.length + 1);
    // Drop the trailing slug (last segment after the last dash).
    const lastDash = rest.lastIndexOf('-');
    if (lastDash <= 0) return null;
    const candidate = rest.slice(0, lastDash);
    // Reject single-segment candidates (probably not a project name)
    if (!candidate.includes('-') || candidate.length < 4) return null;
    return candidate;
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

interface RawEntity {
  id: number;
  name: string;
  type: string;
  tags?: string;
}

export function computeProjects(db: Database.Database): ProjectInfo[] {
  // Single pass: pull every active entity + its tags. We can't aggregate in
  // SQL because the project lookup walks both tags and the name heuristic.
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type,
      (SELECT GROUP_CONCAT(t.tag, '\n') FROM tags t WHERE t.entity_id = e.id) AS tags
    FROM entities e
    WHERE e.status = 'active'
  `).all() as RawEntity[];

  const acc = new Map<string, { count: number; types: Map<string, number>; sources: Set<'tag' | 'heuristic'> }>();

  for (const row of rows) {
    const tagList = row.tags ? row.tags.split('\n') : [];
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
