import { rebuildFtsIndex, runOnceMigration } from './schema.js';
import { hasVectorIndex } from './vector-index.js';
import { lessonSlug } from '../core/lesson-slug.js';
export const SESSION_DEDUPE_KEY = 'session_observation_dedupe';
export const ZERO_EDIT_RETRACT_KEY = 'session_zero_edit_retract';
export const FUSED_LESSON_SPLIT_KEY = 'fused_lesson_split';
function observationsOf(db, entityId) {
    return db
        .prepare('SELECT id, content, created_at FROM observations WHERE entity_id = ? ORDER BY id')
        .all(entityId);
}
export function dedupeSessionObservations(db) {
    let removed = -1;
    runOnceMigration(db, {
        key: SESSION_DEDUPE_KEY,
        version: 1,
        describe: 'session observation dedupe',
        migrate: (conn) => {
            const affected = conn
                .prepare(`SELECT DISTINCT e.id FROM entities e JOIN observations o ON o.entity_id = e.id
           WHERE e.name LIKE 'session-%'
           GROUP BY e.id, o.content HAVING COUNT(o.id) > 1`)
                .all();
            removed = 0;
            for (const row of affected) {
                const r = conn
                    .prepare(`DELETE FROM observations WHERE entity_id = ? AND id NOT IN (
               SELECT MIN(id) FROM observations WHERE entity_id = ? GROUP BY content)`)
                    .run(row.id, row.id);
                removed += Number(r.changes);
            }
            if (removed > 0)
                rebuildFtsIndex(conn);
        },
    });
    return removed;
}
const BASH_WRITE_MARKS = ['<<', 'sed -i', 'write_text(', 'writeFileSync(', 'tee '];
export function retractZeroEditClaims(db) {
    let rewritten = -1;
    runOnceMigration(db, {
        key: ZERO_EDIT_RETRACT_KEY,
        version: 1,
        describe: 'session zero-edit retraction',
        migrate: (conn) => {
            const marks = BASH_WRITE_MARKS.map(() => "o2.content LIKE 'Command:%' AND o2.content LIKE ?").join(' OR ');
            const rows = conn
                .prepare(`SELECT o.id, o.content FROM observations o JOIN entities e ON e.id = o.entity_id
           WHERE e.name LIKE 'session-%-summary'
             AND o.content LIKE 'Significant session:%0 files edited%'
             AND EXISTS (SELECT 1 FROM observations o2 WHERE o2.entity_id = e.id AND (${marks}))`)
                .all(...BASH_WRITE_MARKS.map((m) => `%${m}%`));
            const update = conn.prepare('UPDATE observations SET content = ? WHERE id = ?');
            for (const row of rows) {
                update.run(row.content.replace('0 files edited', 'files edited through Bash (count not recorded before 4.8.2)'), row.id);
            }
            rewritten = rows.length;
            if (rewritten > 0)
                rebuildFtsIndex(conn);
        },
    });
    return rewritten;
}
function groupLessons(rows) {
    const groups = [];
    for (const row of rows) {
        if (row.content.startsWith('Error: ')) {
            groups.push({ error: row.content.slice('Error: '.length), rows: [row] });
        }
        else if (groups.length > 0) {
            groups[groups.length - 1].rows.push(row);
        }
    }
    return groups;
}
export function splitFusedLessons(db, deps) {
    let moved = -1;
    runOnceMigration(db, {
        key: FUSED_LESSON_SPLIT_KEY,
        version: 1,
        describe: 'fused lesson split',
        migrate: (conn) => {
            const buckets = conn
                .prepare(`SELECT e.id, e.name, e.type, e.namespace, e.confidence
           FROM entities e
           WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')
             AND (SELECT COUNT(*) FROM observations o WHERE o.entity_id = e.id) > 4`)
                .all();
            moved = 0;
            const vec = hasVectorIndex(conn);
            for (const bucket of buckets) {
                const tags = conn.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(bucket.id)
                    .map((t) => t.tag);
                const project = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length);
                if (!project)
                    continue;
                const rows = observationsOf(conn, bucket.id);
                const groups = groupLessons(rows);
                if (groups.length < 2)
                    continue;
                const severities = tags.filter((t) => t.startsWith('severity:'));
                const carried = tags.filter((t) => !t.startsWith('severity:'));
                if (severities.length === 1)
                    carried.push(severities[0]);
                for (const group of groups.slice(1)) {
                    const name = `lesson-${project}-${lessonSlug(group.error)}`;
                    let target = conn.prepare('SELECT id FROM entities WHERE name = ?').get(name);
                    if (!target) {
                        const contents = group.rows.map((o) => o.content);
                        const title = deps.deriveTitle(bucket.type, contents);
                        const inserted = conn
                            .prepare(`INSERT INTO entities (name, type, created_at, metadata, status, confidence, namespace, title)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
                            .run(name, bucket.type, group.rows[0].created_at, JSON.stringify(title ? { title_source: 'heuristic', split_from: bucket.name } : { split_from: bucket.name }), bucket.confidence, bucket.namespace, title);
                        target = { id: Number(inserted.lastInsertRowid) };
                        const tagStmt = conn.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
                        for (const tag of carried)
                            tagStmt.run(target.id, tag);
                    }
                    const moveStmt = conn.prepare('UPDATE observations SET entity_id = ? WHERE id = ?');
                    for (const row of group.rows)
                        moveStmt.run(target.id, row.id);
                    if (vec)
                        conn.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(target.id));
                    moved += 1;
                }
                if (vec)
                    conn.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(BigInt(bucket.id));
            }
            if (moved > 0) {
                rebuildFtsIndex(conn);
                deps.markReindexOwed(conn);
            }
        },
    });
    return moved;
}
//# sourceMappingURL=graph-repairs.js.map