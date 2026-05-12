import { KNOWN_ERROR_PATTERNS } from './lesson-engine.js';
const PROJECT_TAG_PREFIX = 'project:';
export function extractProjectFromName(name) {
    if (!name.startsWith('lesson-'))
        return null;
    const rest = name.slice('lesson-'.length);
    for (const pattern of KNOWN_ERROR_PATTERNS) {
        const suffix = `-${pattern}`;
        if (rest.endsWith(suffix)) {
            const project = rest.slice(0, rest.length - suffix.length);
            if (project.length >= 2)
                return project;
        }
    }
    return null;
}
export function extractProjectFromEntity(tags, name) {
    if (tags) {
        const tagged = tags.find((t) => t.startsWith(PROJECT_TAG_PREFIX));
        if (tagged)
            return { project: tagged.slice(PROJECT_TAG_PREFIX.length), source: 'tag' };
    }
    const fromName = extractProjectFromName(name);
    if (fromName)
        return { project: fromName, source: 'heuristic' };
    return { project: null, source: null };
}
export function computeProjects(db) {
    const rows = db.prepare(`
    SELECT e.id, e.name, e.type,
      (SELECT json_group_array(t.tag) FROM tags t WHERE t.entity_id = e.id) AS tags
    FROM entities e
    WHERE e.status = 'active'
  `).all();
    const acc = new Map();
    for (const row of rows) {
        let tagList = [];
        if (row.tags) {
            try {
                const parsed = JSON.parse(row.tags);
                if (Array.isArray(parsed))
                    tagList = parsed.filter((t) => typeof t === 'string');
            }
            catch {
            }
        }
        const { project, source } = extractProjectFromEntity(tagList, row.name);
        if (!project || !source)
            continue;
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
        .map(([name, bucket]) => ({
        name,
        count: bucket.count,
        types: Array.from(bucket.types.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([t]) => t),
        source: bucket.sources.size === 2 ? 'mixed' : (bucket.sources.has('tag') ? 'tag' : 'heuristic'),
    }))
        .sort((a, b) => b.count - a.count);
}
//# sourceMappingURL=projects.js.map