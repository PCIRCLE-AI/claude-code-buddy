import { rebuildFtsIndex, runOnceMigration } from './schema.js';
import { lessonSlug } from '../core/lesson-slug.js';
import { AGENT_MESSAGE_SCOPE_COLUMNS, isFilesystemPathScopeId, lastPathSegment, } from '../core/agent-scope-id.js';
import { computeSignalScore } from '../core/signal-scorer.js';
export const SESSION_DEDUPE_KEY = 'session_observation_dedupe';
export const ZERO_EDIT_RETRACT_KEY = 'session_zero_edit_retract';
export const FUSED_LESSON_SPLIT_KEY = 'fused_lesson_split';
const ZERO_EDITS = ', 0 files edited';
const ZERO_EDITS_RETRACTED = ', files edited through Bash (count not recorded before 4.8.2)';
function note(line) {
    process.stderr.write(`MeMesh: ${line}\n`);
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
            const del = conn.prepare(`DELETE FROM observations WHERE entity_id = ? AND id NOT IN (
           SELECT MIN(id) FROM observations WHERE entity_id = ? GROUP BY content)`);
            for (const row of affected)
                removed += Number(del.run(row.id, row.id).changes);
            if (removed > 0) {
                rebuildFtsIndex(conn);
                note(`removed ${removed} duplicate observation(s) from ${affected.length} session entit${affected.length === 1 ? 'y' : 'ies'} (written by 4.8.1 hooks).`);
            }
        },
    });
    return removed;
}
const BASH_WRITE_SHAPES = [
    /(?:^|[^<])>\s*"?([^\s"'>|&;]+)"?\s*<<\s*['"]?\w+['"]?/,
    /\bcat\s*>\s*"?([^\s"'>|&;]+)"?/,
    /\btee\s+(?:-a\s+)?"?([^\s"'>|&;]+)"?/,
    /\bsed\s+-i(?:\s+'')?\s+(?:'[^']*'|"[^"]*")\s+"?([^\s"'>|&;]+)"?/,
    /Path\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_text\(/,
    /writeFileSync\(\s*['"]([^'"]+)['"]/,
];
export function bashWritesFiles(command) {
    for (const re of BASH_WRITE_SHAPES) {
        for (const m of command.matchAll(new RegExp(re.source, 'g'))) {
            if (m[1] && !m[1].startsWith('/dev/') && !m[1].startsWith('/tmp/'))
                return true;
        }
    }
    return false;
}
export function retractZeroEditClaims(db) {
    let rewritten = -1;
    runOnceMigration(db, {
        key: ZERO_EDIT_RETRACT_KEY,
        version: 1,
        describe: 'session zero-edit retraction',
        migrate: (conn) => {
            const candidates = conn
                .prepare(`SELECT o.id, o.content, o.entity_id FROM observations o JOIN entities e ON e.id = o.entity_id
           WHERE e.name LIKE 'session-%-summary'
             AND o.content LIKE 'Significant session:%${ZERO_EDITS}%'`)
                .all();
            const commands = conn.prepare("SELECT content FROM observations WHERE entity_id = ? AND content LIKE 'Command:%'");
            const update = conn.prepare('UPDATE observations SET content = ? WHERE id = ?');
            rewritten = 0;
            for (const row of candidates) {
                const cmds = commands.all(row.entity_id);
                if (!cmds.some((c) => bashWritesFiles(c.content)))
                    continue;
                update.run(row.content.replace(ZERO_EDITS, ZERO_EDITS_RETRACTED), row.id);
                rewritten += 1;
            }
            if (rewritten > 0) {
                rebuildFtsIndex(conn);
                note(`retracted "0 files edited" on ${rewritten} session summar${rewritten === 1 ? 'y' : 'ies'} that recorded a Bash write.`);
            }
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
function legacyReadableLessonSlug(error) {
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
export function splitFusedLessons(db, deps) {
    let moved = -1;
    runOnceMigration(db, {
        key: FUSED_LESSON_SPLIT_KEY,
        version: 2,
        describe: 'fused lesson split',
        migrate: (conn) => {
            const buckets = conn
                .prepare(`SELECT e.id, e.name, e.type, e.namespace, e.confidence, e.metadata
           FROM entities e
           WHERE e.type = 'lesson_learned' AND e.name LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')`)
                .all();
            const tagsOf = conn.prepare('SELECT tag FROM tags WHERE entity_id = ?');
            const obsOf = conn.prepare('SELECT id, content, created_at FROM observations WHERE entity_id = ? ORDER BY id');
            const findTarget = conn.prepare('SELECT id, status FROM entities WHERE name = ?');
            const revive = conn.prepare("UPDATE entities SET status = 'active' WHERE id = ?");
            const insertEntity = conn.prepare(`INSERT INTO entities (name, type, created_at, metadata, status, confidence, namespace, title)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`);
            const insertTag = conn.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
            const moveRow = conn.prepare('UPDATE observations SET entity_id = ? WHERE id = ?');
            const emptied = 'NOT EXISTS (SELECT 1 FROM observations WHERE entity_id = ?)';
            const dropExplicit = conn.prepare(`DELETE FROM tags WHERE entity_id = ? AND tag = 'source:explicit' AND ${emptied}`);
            const archive = conn.prepare(`UPDATE entities SET status = 'archived' WHERE id = ? AND ${emptied}`);
            moved = 0;
            let bucketsTouched = 0;
            let legacyReadableMoved = 0;
            const moveLessonGroups = (source, project, groups, tags) => {
                let inherited = {};
                try {
                    const parsed = source.metadata ? JSON.parse(source.metadata) : {};
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                        inherited = parsed;
                }
                catch { }
                const severities = tags.filter((t) => t.startsWith('severity:'));
                const carried = tags.filter((t) => !t.startsWith('severity:') && !t.startsWith('source:'));
                if (severities.length === 1)
                    carried.push(severities[0]);
                if (!tags.includes('source:auto-learned'))
                    carried.push('source:explicit');
                let movedFromSource = 0;
                for (const group of groups) {
                    const name = `lesson-${project}-${lessonSlug(group.error)}`;
                    let target = findTarget.get(name);
                    if (target) {
                        if (target.status !== 'active')
                            revive.run(target.id);
                    }
                    else {
                        const contents = group.rows.map((o) => o.content);
                        const title = deps.deriveTitle(source.type, contents);
                        const metadata = {
                            ...inherited,
                            split_from: source.name,
                            signal_score: computeSignalScore({ type: source.type, name, observations: contents, tags: carried }),
                        };
                        if (title)
                            metadata.title_source = 'heuristic';
                        else
                            delete metadata.title_source;
                        delete metadata.guard;
                        delete metadata.evidence_for;
                        delete metadata.previous_namespace;
                        const inserted = insertEntity.run(name, source.type, group.rows[0].created_at, JSON.stringify(metadata), source.confidence, source.namespace, title);
                        target = { id: Number(inserted.lastInsertRowid), status: 'active' };
                        for (const tag of carried)
                            insertTag.run(target.id, tag);
                    }
                    for (const row of group.rows)
                        moveRow.run(target.id, row.id);
                    moved += 1;
                    movedFromSource += 1;
                }
                return movedFromSource;
            };
            for (const bucket of buckets) {
                const groups = groupLessons(obsOf.all(bucket.id));
                if (groups.length === 0)
                    continue;
                const tags = tagsOf.all(bucket.id).map((t) => t.tag);
                const project = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length) ??
                    bucket.name.slice('lesson-'.length, -'-other'.length);
                const movedFromBucket = moveLessonGroups(bucket, project, groups, tags);
                dropExplicit.run(bucket.id, bucket.id);
                archive.run(bucket.id, bucket.id);
                if (movedFromBucket > 0)
                    bucketsTouched += 1;
            }
            const legacyReadable = conn
                .prepare(`SELECT e.id, e.name, e.type, e.namespace, e.confidence, e.metadata
           FROM entities e
           WHERE e.status = 'active'
             AND e.type = 'lesson_learned'
             AND e.name LIKE 'lesson-%'
             AND e.name NOT LIKE 'lesson-%-other'
             AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = 'source:explicit')`)
                .all();
            for (const entity of legacyReadable) {
                const rows = obsOf.all(entity.id);
                const groups = groupLessons(rows);
                if (groups.length === 0)
                    continue;
                if (groups.reduce((n, group) => n + group.rows.length, 0) !== rows.length)
                    continue;
                const tags = tagsOf.all(entity.id).map((t) => t.tag);
                const project = tags.find((t) => t.startsWith('project:'))?.slice('project:'.length);
                if (!project)
                    continue;
                const suffix = entity.name.slice(`lesson-${project}-`.length);
                if (tags.includes(`error-pattern:${suffix}`))
                    continue;
                if (!groups.every((group) => `lesson-${project}-${legacyReadableLessonSlug(group.error)}` === entity.name))
                    continue;
                const movedFromEntity = moveLessonGroups(entity, project, groups, tags);
                archive.run(entity.id, entity.id);
                legacyReadableMoved += movedFromEntity;
            }
            if (moved > 0) {
                rebuildFtsIndex(conn);
                deps.markReindexOwed(conn);
                if (legacyReadableMoved === 0) {
                    note(`moved ${moved} lesson(s) out of ${bucketsTouched} "-other" bucket(s) into their own entities; run 'memesh reindex' to refresh their vectors.`);
                }
                else if (bucketsTouched === 0) {
                    note(`moved ${legacyReadableMoved} legacy readable-only lesson(s) into their canonical digest entities; run 'memesh reindex' to refresh their vectors.`);
                }
                else {
                    note(`moved ${moved - legacyReadableMoved} lesson(s) out of ${bucketsTouched} "-other" bucket(s) and ${legacyReadableMoved} legacy readable-only lesson(s) into their canonical digest entities; run 'memesh reindex' to refresh their vectors.`);
                }
            }
        },
    });
    return moved;
}
export const AGENT_SCOPE_PATH_KEY = 'agent_scope_path_identity';
export function normalizeAgentScopePaths(db) {
    let rewritten = -1;
    runOnceMigration(db, {
        key: AGENT_SCOPE_PATH_KEY,
        version: 1,
        describe: 'agent message scope path identities',
        migrate: (conn) => {
            rewritten = 0;
            let merged = 0;
            let blocked = 0;
            let discarded = 0;
            const pairs = new Set();
            for (const { table, columns } of AGENT_MESSAGE_SCOPE_COLUMNS) {
                for (const column of columns) {
                    let values;
                    try {
                        values = conn.prepare(`SELECT DISTINCT ${column} AS v FROM ${table}`).all();
                    }
                    catch {
                        continue;
                    }
                    const update = conn.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
                    const drop = conn.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
                    const ids = conn.prepare(`SELECT rowid AS rid FROM ${table} WHERE ${column} = ?`);
                    const exists = conn.prepare(`SELECT 1 AS hit FROM ${table} WHERE ${column} = ? LIMIT 1`);
                    for (const { v } of values) {
                        if (typeof v !== 'string' || !isFilesystemPathScopeId(v))
                            continue;
                        const target = lastPathSegment(v);
                        if (target === null)
                            continue;
                        const isMerge = exists.get(target) !== undefined;
                        const rows = ids.all(v);
                        for (const { rid } of rows) {
                            try {
                                const changed = Number(update.run(target, rid).changes);
                                rewritten += changed;
                                if (changed > 0 && isMerge)
                                    merged += changed;
                            }
                            catch {
                                if (table === 'agent_message_cursors') {
                                    discarded += Number(drop.run(rid).changes);
                                }
                                else {
                                    blocked += 1;
                                }
                            }
                        }
                        if (rows.length > 0)
                            pairs.add(`${v} → ${target}`);
                    }
                }
            }
            if (rewritten > 0 || discarded > 0) {
                const detail = [...pairs].join(', ');
                note(`rewrote ${rewritten} filesystem-path message scope value(s) to their identity name (${detail})`
                    + `${merged > 0 ? `; ${merged} joined an identity that already existed` : ''}`
                    + `${discarded > 0 ? `; ${discarded} duplicate poll cursor(s) dropped` : ''}`
                    + `${blocked > 0 ? `; ${blocked} left in place because the canonical spelling already holds an equivalent row` : ''}.`);
            }
        },
    });
    return rewritten;
}
//# sourceMappingURL=graph-repairs.js.map