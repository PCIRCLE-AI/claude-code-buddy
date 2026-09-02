import { getDatabase } from '../db.js';
import { AGENT_MESSAGE_PROJECT_TABLES } from './agent-scope-id.js';
export function listProjectTags(db) {
    const conn = db ?? getDatabase();
    const rows = conn.prepare("SELECT tag, COUNT(*) c FROM tags WHERE tag LIKE 'project:%' GROUP BY tag ORDER BY c DESC, tag ASC").all();
    return rows.map((r) => ({ project: r.tag.slice('project:'.length), count: r.c }));
}
export function renameProjectTag(from, to, opts) {
    const conn = opts?.db ?? getDatabase();
    const fromTag = `project:${from}`;
    const toTag = `project:${to}`;
    const affected = conn.prepare('SELECT DISTINCT e.id, e.name FROM entities e JOIN tags t ON t.entity_id = e.id WHERE t.tag = ? ORDER BY e.name').all(fromTag);
    const hasTo = conn.prepare('SELECT 1 FROM tags WHERE entity_id = ? AND tag = ?');
    const plan = affected.map((e) => ({
        id: e.id,
        action: hasTo.get(e.id, toTag) ? 'merge' : 'rename',
    }));
    const merged = plan.filter((p) => p.action === 'merge').length;
    const renamed = plan.filter((p) => p.action === 'rename').length;
    const messagePlan = AGENT_MESSAGE_PROJECT_TABLES.map((table) => {
        try {
            const rows = conn.prepare(`SELECT rowid AS rid FROM ${table} WHERE project = ?`)
                .all(from);
            return { table, rowIds: rows.map((r) => r.rid) };
        }
        catch {
            return { table, rowIds: [] };
        }
    });
    const messageRows = messagePlan.reduce((n, t) => n + t.rowIds.length, 0);
    let messageRowsBlocked = 0;
    if (opts?.apply && (affected.length > 0 || messageRows > 0)) {
        const del = conn.prepare('DELETE FROM tags WHERE entity_id = ? AND tag = ?');
        const upd = conn.prepare('UPDATE tags SET tag = ? WHERE entity_id = ? AND tag = ?');
        const tx = conn.transaction(() => {
            for (const p of plan) {
                if (p.action === 'merge')
                    del.run(p.id, fromTag);
                else
                    upd.run(toTag, p.id, fromTag);
            }
            for (const { table, rowIds } of messagePlan) {
                if (rowIds.length === 0)
                    continue;
                const move = conn.prepare(`UPDATE ${table} SET project = ? WHERE rowid = ?`);
                for (const rid of rowIds) {
                    try {
                        move.run(to, rid);
                    }
                    catch {
                        messageRowsBlocked += 1;
                    }
                }
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
        messageRows,
        messageRowsBlocked,
    };
}
//# sourceMappingURL=project-tags.js.map