import { execFileSync } from 'child_process';
const GIT_TIMEOUT_MS = 5000;
function runGit(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
const UNCOMMITTED_HASH = /^0+$/;
export function resolveFileCommits(repoDir, file, opts = {}) {
    const limit = opts.limit ?? 10;
    try {
        runGit(repoDir, ['rev-parse', '--show-toplevel']);
    }
    catch (err) {
        const code = err.code;
        return { commits: [], abstention: code === 'ENOENT' ? 'git_unavailable' : 'not_a_git_repo' };
    }
    try {
        runGit(repoDir, ['ls-files', '--error-unmatch', '--', file]);
    }
    catch {
        return { commits: [], abstention: 'file_not_tracked' };
    }
    if (opts.line != null) {
        let out;
        try {
            out = runGit(repoDir, ['blame', '-L', `${opts.line},${opts.line}`, '--porcelain', '--', file]);
        }
        catch {
            return { commits: [], abstention: 'line_out_of_range' };
        }
        const hash = out.split('\n')[0]?.split(' ')[0] ?? '';
        if (!/^[a-f0-9]{7,40}$/.test(hash))
            return { commits: [], abstention: 'line_out_of_range' };
        if (UNCOMMITTED_HASH.test(hash))
            return { commits: [], abstention: 'line_uncommitted' };
        const summary = out.split('\n').find((l) => l.startsWith('summary '));
        return { commits: [{ hash, subject: summary?.slice('summary '.length) }], abstention: null };
    }
    let out;
    try {
        out = runGit(repoDir, [
            'log', '-n', String(limit), '--follow', '--format=%H%x09%ad%x09%s', '--date=short', '--', file,
        ]);
    }
    catch {
        return { commits: [], abstention: null };
    }
    const commits = [];
    for (const line of out.split('\n')) {
        if (!line.trim())
            continue;
        const [hash, date, subject] = line.split('\t');
        if (hash && /^[a-f0-9]{7,40}$/.test(hash))
            commits.push({ hash, date, subject });
    }
    return { commits, abstention: null };
}
export function basenameOf(file) {
    return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}
function parseMetadata(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function findCommitEntity(db, hash) {
    const rows = db.prepare(`SELECT id, name, type, title, created_at, metadata FROM entities
     WHERE type = 'commit' AND name LIKE 'commit-%'
       AND length(substr(name, 8)) >= 7
       AND (? LIKE substr(name, 8) || '%' OR substr(name, 8) LIKE ? || '%')
     ORDER BY length(name) DESC`).all(hash, hash);
    if (rows.length === 0)
        return null;
    const row = rows[0];
    return { ...row, metadata: parseMetadata(row.metadata) };
}
function observationsOf(db, entityId) {
    const rows = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entityId);
    return rows.map((r) => r.content);
}
function sessionEntities(db, sessionId) {
    return db.prepare(`SELECT DISTINCT e.id, e.name, e.type, e.title, e.created_at
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status != 'archived'
     ORDER BY e.created_at`).all(`session:${sessionId}`);
}
export function explainCommits(db, input) {
    const basename = basenameOf(input.file);
    const limit = input.limit ?? 10;
    const project = input.project ?? null;
    const commits = [];
    for (const commit of (input.commits ?? []).slice(0, limit)) {
        const abstentions = [];
        const found = findCommitEntity(db, commit.hash);
        let entity = null;
        let session = null;
        if (!found) {
            abstentions.push('no_commit_entity');
        }
        else {
            entity = {
                id: found.id, name: found.name, type: found.type,
                title: found.title, created_at: found.created_at,
                observations: observationsOf(db, found.id),
            };
            const sessionId = found.metadata?.session_id;
            if (typeof sessionId === 'string' && sessionId.length > 0) {
                session = { session_id: sessionId, entities: sessionEntities(db, sessionId) };
            }
            else {
                abstentions.push('no_session_link');
            }
        }
        commits.push({ commit, entity, session, abstentions });
    }
    const noExt = basename.replace(/\.[^.]+$/, '');
    const fileTags = noExt && noExt !== basename
        ? [`file:${basename}`, `file:${noExt}`]
        : [`file:${basename}`];
    const tagPlaceholders = fileTags.map(() => '?').join(',');
    const params = [...fileTags];
    let projectClause = '';
    if (project) {
        projectClause = `AND EXISTS (SELECT 1 FROM tags pt WHERE pt.entity_id = e.id AND pt.tag = ?)`;
        params.push(`project:${project}`);
    }
    const fileMemories = db.prepare(`SELECT DISTINCT e.id, e.name, e.type, e.title, e.created_at
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag IN (${tagPlaceholders})
       AND e.status != 'archived'
       AND e.type != 'commit'
       ${projectClause}
     ORDER BY e.created_at DESC
     LIMIT ?`).all(...params, limit);
    return {
        file: input.file,
        basename,
        project,
        commits,
        file_memories: { basis: 'file-tag', entities: fileMemories },
        abstentions: input.abstentions ?? [],
    };
}
//# sourceMappingURL=why.js.map