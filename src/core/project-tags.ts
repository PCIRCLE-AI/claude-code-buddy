// Project-tag maintenance — heal `project:<name>` tags that were mis-homed
// before project identity became git-based (see paths.ts getProjectName).
//
// The system cannot auto-infer the correct project for an old `basename(cwd)`
// value (entities don't record their originating cwd/repo), so the mapping is
// user-driven: `memesh kg rename-project --from <old> --to <new>`. This is a
// deliberate, opt-in, dry-run-by-default operation — it rewrites real user data.

import type Database from 'better-sqlite3';
import { getDatabase } from '../db.js';

export interface ProjectTagCount {
  project: string;
  count: number;
}

export interface RenameProjectResult {
  fromTag: string;
  toTag: string;
  /** Entities carrying the `from` tag. */
  affectedEntities: number;
  /** Of those, entities that ALREADY had the `to` tag → the `from` row is deleted (merge). */
  merged: number;
  /** Of those, entities that get the tag rewritten `from` → `to` (rename). */
  renamed: number;
  applied: boolean;
  affectedNames: string[];
}

/** All `project:*` tag values with entity counts, most-used first. */
export function listProjectTags(db?: Database.Database): ProjectTagCount[] {
  const conn = db ?? getDatabase();
  const rows = conn.prepare(
    "SELECT tag, COUNT(*) c FROM tags WHERE tag LIKE 'project:%' GROUP BY tag ORDER BY c DESC, tag ASC",
  ).all() as Array<{ tag: string; c: number }>;
  return rows.map((r) => ({ project: r.tag.slice('project:'.length), count: r.c }));
}

/**
 * Rewrite `project:<from>` → `project:<to>` across all entities.
 *
 * Dry-run by default (`apply` false) — computes what WOULD change and writes
 * nothing. With `apply: true`, runs in a single transaction. The tags table has
 * a UNIQUE(entity_id, tag) constraint, so an entity that already carries the
 * `to` tag cannot receive a second copy — for those the `from` row is deleted
 * (a merge) rather than renamed.
 */
export function renameProjectTag(
  from: string,
  to: string,
  opts?: { apply?: boolean; db?: Database.Database },
): RenameProjectResult {
  const conn = opts?.db ?? getDatabase();
  const fromTag = `project:${from}`;
  const toTag = `project:${to}`;

  const affected = conn.prepare(
    'SELECT DISTINCT e.id, e.name FROM entities e JOIN tags t ON t.entity_id = e.id WHERE t.tag = ? ORDER BY e.name',
  ).all(fromTag) as Array<{ id: number; name: string }>;

  const hasTo = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
  const plan = affected.map((e) => ({
    id: e.id,
    action: hasTo.get(e.id, toTag) ? ('merge' as const) : ('rename' as const),
  }));
  const merged = plan.filter((p) => p.action === 'merge').length;
  const renamed = plan.filter((p) => p.action === 'rename').length;

  if (opts?.apply && affected.length > 0) {
    const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
    const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
    const tx = conn.transaction(() => {
      for (const p of plan) {
        if (p.action === 'merge') del.run(p.id, fromTag);
        else upd.run(toTag, p.id, fromTag);
      }
    });
    tx();
  }

  return {
    fromTag,
    toTag,
    affectedEntities: affected.length,
    merged,
    renamed,
    applied: !!opts?.apply,
    affectedNames: affected.map((e) => e.name),
  };
}
