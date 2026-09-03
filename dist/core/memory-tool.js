import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { removeFromFts, insertFtsRow, indexedObservationText } from '../storage/fts-index.js';
export const MEMORY_ROOT = '/memories';
const NAMESPACES = ['personal', 'team', 'global'];
const FILE_SUFFIX = '.md';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_VIEW_CHARS = 16_000;
const ok = (content) => ({ content, isError: false });
const err = (content) => ({ content, isError: true });
function encodeName(name) {
    return name.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\\/g, '%5C');
}
function decodeName(segment) {
    return segment
        .replace(/%2F/gi, '/')
        .replace(/%5C/gi, '\\')
        .replace(/%25/g, '%');
}
function parsePath(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
        return err('Error: `path` must be a non-empty string.');
    }
    if (raw.includes('\0')) {
        return err('Error: `path` may not contain a NUL byte.');
    }
    if (raw !== MEMORY_ROOT && !raw.startsWith(`${MEMORY_ROOT}/`)) {
        return err(`Error: paths must be under ${MEMORY_ROOT}. The path ${raw} is outside it.`);
    }
    const rest = raw.slice(MEMORY_ROOT.length).replace(/^\//, '');
    if (rest === '')
        return { kind: 'root' };
    const segments = rest.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            return err(`Error: the path ${raw} contains a traversal or empty segment and was refused.`);
        }
        if (/%2e%2e/i.test(segment) || segment.includes('\\')) {
            return err(`Error: the path ${raw} contains a traversal sequence and was refused.`);
        }
    }
    if (segments.length > 2) {
        return err(`Error: ${MEMORY_ROOT} is two levels deep — ${MEMORY_ROOT}/<namespace>/<memory>${FILE_SUFFIX}. ` +
            `The path ${raw} is deeper than that.`);
    }
    const namespace = segments[0];
    if (!NAMESPACES.includes(namespace)) {
        return err(`Error: "${namespace}" is not a memory namespace. Use one of: ${NAMESPACES.join(', ')}.`);
    }
    if (segments.length === 1) {
        return { kind: 'namespace', namespace: namespace };
    }
    const file = segments[1];
    if (!file.endsWith(FILE_SUFFIX)) {
        return err(`Error: memory files end in ${FILE_SUFFIX}. The path ${raw} does not.`);
    }
    const name = decodeName(file.slice(0, -FILE_SUFFIX.length));
    if (name === '') {
        return err(`Error: the path ${raw} names an empty memory.`);
    }
    return { kind: 'entity', namespace: namespace, name };
}
const isResult = (v) => 'content' in v;
function entityPath(namespace, name) {
    return `${MEMORY_ROOT}/${namespace}/${encodeName(name)}${FILE_SUFFIX}`;
}
function renderBody(entity) {
    return entity.observations.join('\n');
}
function lineOwners(observations) {
    const owners = [];
    observations.forEach((observation, index) => {
        const span = observation.split('\n').length;
        for (let i = 0; i < span; i++)
            owners.push(index);
    });
    return owners;
}
function withLineNumbers(body, from = 1) {
    if (body === '')
        return '';
    return body
        .split('\n')
        .map((line, i) => `${String(from + i).padStart(6, ' ')}\t${line}`)
        .join('\n');
}
function humanSize(bytes) {
    if (bytes < 1024)
        return `${bytes}`;
    return `${(bytes / 1024).toFixed(1)}K`;
}
function graph() {
    return new KnowledgeGraph(getDatabase());
}
function listNamespace(namespace) {
    return getDatabase()
        .prepare(`SELECT e.name AS name,
              e.type AS type,
              COALESCE(SUM(LENGTH(o.content)) + MAX(COUNT(o.id) - 1, 0), 0) AS bytes
         FROM entities e
         LEFT JOIN observations o ON o.entity_id = e.id
        WHERE e.status = 'active' AND e.namespace = ?
        GROUP BY e.id
        ORDER BY e.id DESC`)
        .all(namespace);
}
function countNamespace(namespace) {
    return getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE status = 'active' AND namespace = ?")
        .get(namespace).n;
}
function tagsOf(name) {
    return getDatabase()
        .prepare('SELECT tag FROM tags WHERE entity_id = (SELECT id FROM entities WHERE name = ?)')
        .all(name).map((t) => t.tag);
}
function findEntity(kg, namespace, name) {
    const entity = kg.getEntity(name);
    if (!entity || entity.namespace !== namespace)
        return null;
    return entity;
}
function rewriteObservations(kg, entity, observations) {
    getDatabase().transaction(() => {
        kg.clearEntityData(entity.name);
        kg.createEntity(entity.name, entity.type, {
            observations,
            tags: entity.tags,
            namespace: entity.namespace,
        });
    })();
}
function tooLarge(body, path) {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes <= MAX_FILE_BYTES)
        return null;
    return err(`Error: ${path} would be ${humanSize(bytes)}, over the ${humanSize(MAX_FILE_BYTES)} ` +
        `limit for one memory. Split it across several memories.`);
}
function viewRoot() {
    const lines = [`${MEMORY_ROOT}`];
    for (const namespace of NAMESPACES) {
        lines.push(`${MEMORY_ROOT}/${namespace}\t${countNamespace(namespace)} memories`);
    }
    return ok(`Here're the files and directories up to 2 levels deep in ${MEMORY_ROOT}, ` +
        `excluding hidden items and node_modules:\n${lines.join('\n')}`);
}
function viewNamespace(namespace) {
    const lines = listNamespace(namespace).map((row) => {
        const tags = tagsOf(row.name);
        const suffix = tags.length > 0 ? `  tags: ${tags.join(', ')}` : '';
        return `${humanSize(row.bytes)}\t${entityPath(namespace, row.name)}\t(${row.type})${suffix}`;
    });
    return ok(`Here're the files and directories up to 2 levels deep in ${MEMORY_ROOT}/${namespace}, ` +
        `excluding hidden items and node_modules:\n` +
        [`${MEMORY_ROOT}/${namespace}`, ...lines].join('\n'));
}
function viewEntity(namespace, name, range, path) {
    const entity = findEntity(graph(), namespace, name);
    if (!entity) {
        return err(`The path ${path} does not exist. Please provide a valid path.`);
    }
    const body = renderBody(entity);
    const lines = body === '' ? [] : body.split('\n');
    if (range === undefined) {
        if (body.length > MAX_VIEW_CHARS) {
            const kept = [];
            let used = 0;
            for (const line of lines) {
                if (used + line.length + 1 > MAX_VIEW_CHARS)
                    break;
                kept.push(line);
                used += line.length + 1;
            }
            return ok(`Here's the content of ${path} with line numbers:\n${withLineNumbers(kept.join('\n'))}\n` +
                `\n[truncated at ${kept.length} of ${lines.length} lines — ` +
                `use view_range to read from line ${kept.length + 1}]`);
        }
        return ok(`Here's the content of ${path} with line numbers:\n${withLineNumbers(body)}`);
    }
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
        return err('Error: `view_range` must be a two-element array of integers, [start, end].');
    }
    const [start, rawEnd] = range;
    const end = rawEnd === -1 ? lines.length : rawEnd;
    if (start < 1 || start > Math.max(lines.length, 1) || end < start) {
        return err(`Error: Invalid \`view_range\`: [${start}, ${rawEnd}]. ` +
            `It should be within the range of lines of the file: [1, ${lines.length}]`);
    }
    const slice = lines.slice(start - 1, end).join('\n');
    return ok(`Here's the content of ${path} with line numbers:\n${withLineNumbers(slice, start)}`);
}
function createEntityFile(namespace, name, fileText, path) {
    if (typeof fileText !== 'string') {
        return err('Error: `file_text` must be a string.');
    }
    const kg = graph();
    const existing = findEntity(kg, namespace, name);
    const oversize = tooLarge(fileText, path);
    if (oversize)
        return oversize;
    const observations = fileText === '' ? [] : fileText.split('\n');
    if (existing) {
        rewriteObservations(kg, existing, observations);
        return ok(`File created successfully at: ${path}`);
    }
    if (kg.getEntity(name)) {
        return err(`Error: ${path} cannot be created because that memory name already exists in another namespace. ` +
            `Memory names are unique across namespaces.`);
    }
    kg.createEntity(name, 'note', { observations, namespace });
    return ok(`File created successfully at: ${path}`);
}
function strReplace(namespace, name, oldStr, newStr, path) {
    if (typeof oldStr !== 'string' || oldStr === '') {
        return err('Error: `old_str` must be a non-empty string.');
    }
    if (newStr !== undefined && typeof newStr !== 'string') {
        return err('Error: `new_str` must be a string when present.');
    }
    const kg = graph();
    const entity = findEntity(kg, namespace, name);
    if (!entity) {
        return err(`Error: The path ${path} does not exist. Please provide a valid path.`);
    }
    const body = renderBody(entity);
    const first = body.indexOf(oldStr);
    if (first === -1) {
        return err(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`);
    }
    if (body.indexOf(oldStr, first + 1) !== -1) {
        const lines = [];
        let at = first;
        while (at !== -1) {
            lines.push(body.slice(0, at).split('\n').length);
            at = body.indexOf(oldStr, at + 1);
        }
        return err(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` ` +
            `in lines: ${lines.join(', ')}. Please ensure it is unique`);
    }
    const replaced = body.slice(0, first) + (newStr ?? '') + body.slice(first + oldStr.length);
    const oversize = tooLarge(replaced, path);
    if (oversize)
        return oversize;
    const observations = replaced === '' ? [] : replaced.split('\n');
    rewriteObservations(kg, entity, observations);
    const at = replaced.slice(0, first).split('\n').length;
    const from = Math.max(1, at - 2);
    const snippet = replaced.split('\n').slice(from - 1, at + 2).join('\n');
    return ok(`The memory file has been edited. Here's a snippet of ${path} with line numbers:\n` +
        withLineNumbers(snippet, from));
}
function insertLine(namespace, name, atLine, text, path) {
    if (!Number.isInteger(atLine)) {
        return err('Error: `insert_line` must be an integer.');
    }
    if (typeof text !== 'string') {
        return err('Error: `insert_text` must be a string.');
    }
    const kg = graph();
    const entity = findEntity(kg, namespace, name);
    if (!entity)
        return err(`Error: The path ${path} does not exist`);
    const owners = lineOwners(entity.observations);
    const line = atLine;
    if (line < 0 || line > owners.length) {
        return err(`Error: Invalid \`insert_line\` parameter: ${line}. ` +
            `It should be within the range of lines of the file: [0, ${owners.length}]`);
    }
    const insertAfter = line === 0 ? -1 : owners[line - 1];
    const observations = [...entity.observations];
    observations.splice(insertAfter + 1, 0, text.replace(/\n$/, ''));
    const oversize = tooLarge(observations.join('\n'), path);
    if (oversize)
        return oversize;
    rewriteObservations(kg, entity, observations);
    return ok(`The file ${path} has been edited.`);
}
function deletePath(parsed, path) {
    if (parsed.kind === 'root') {
        return err(`Error: ${MEMORY_ROOT} itself cannot be deleted.`);
    }
    if (parsed.kind === 'namespace') {
        return err(`Error: ${path} is a namespace and cannot be deleted. Delete individual memories instead.`);
    }
    const kg = graph();
    const entity = findEntity(kg, parsed.namespace, parsed.name);
    if (!entity)
        return err(`Error: The path ${path} does not exist`);
    kg.archiveEntity(entity.name);
    return ok(`Successfully deleted ${path}`);
}
function renamePath(oldRaw, newRaw) {
    const from = parsePath(oldRaw);
    if (isResult(from))
        return from;
    const to = parsePath(newRaw);
    if (isResult(to))
        return to;
    if (from.kind !== 'entity' || to.kind !== 'entity') {
        return err(`Error: rename moves one memory to another memory path. ` +
            `${MEMORY_ROOT} and its namespaces cannot be renamed.`);
    }
    const kg = graph();
    const source = findEntity(kg, from.namespace, from.name);
    if (!source)
        return err(`Error: The path ${String(oldRaw)} does not exist`);
    if (findEntity(kg, to.namespace, to.name)) {
        return err(`Error: The destination ${String(newRaw)} already exists`);
    }
    if (kg.getEntity(to.name)) {
        return err(`Error: The destination ${String(newRaw)} already exists in another namespace. ` +
            `Memory names are unique across namespaces.`);
    }
    const db = getDatabase();
    const entityId = source.id;
    const obsText = indexedObservationText(db, entityId);
    db.transaction(() => {
        removeFromFts(db, entityId, source.name, obsText, source.title);
        db.prepare('UPDATE entities SET name = ?, namespace = ? WHERE id = ?')
            .run(to.name, to.namespace, entityId);
        if (!source.archived) {
            insertFtsRow(db, entityId, to.name, obsText, source.title);
        }
    })();
    return ok(`Successfully renamed ${String(oldRaw)} to ${String(newRaw)}`);
}
export function handleMemoryCommand(input) {
    if (typeof input !== 'object' || input === null) {
        return err('Error: the memory tool input must be an object.');
    }
    const cmd = input;
    switch (cmd.command) {
        case 'rename':
            return renamePath(cmd.old_path, cmd.new_path);
        case 'view':
        case 'create':
        case 'str_replace':
        case 'insert':
        case 'delete':
            break;
        case undefined:
            return err('Error: the memory tool input has no `command`.');
        default:
            return err(`Error: unknown command ${String(cmd.command)}`);
    }
    const parsed = parsePath(cmd.path);
    if (isResult(parsed))
        return parsed;
    const path = cmd.path;
    if (cmd.command === 'delete')
        return deletePath(parsed, path);
    if (cmd.command === 'view') {
        if (parsed.kind === 'root')
            return viewRoot();
        if (parsed.kind === 'namespace')
            return viewNamespace(parsed.namespace);
        return viewEntity(parsed.namespace, parsed.name, cmd.view_range, path);
    }
    if (parsed.kind !== 'entity') {
        return err(`Error: ${path} is a directory. ${cmd.command} needs a memory file, ` +
            `${MEMORY_ROOT}/<namespace>/<memory>${FILE_SUFFIX}.`);
    }
    switch (cmd.command) {
        case 'create':
            return createEntityFile(parsed.namespace, parsed.name, cmd.file_text, path);
        case 'str_replace':
            return strReplace(parsed.namespace, parsed.name, cmd.old_str, cmd.new_str, path);
        case 'insert':
            return insertLine(parsed.namespace, parsed.name, cmd.insert_line, cmd.insert_text, path);
    }
}
export const MEMORY_TOOL_DEFINITION = {
    type: 'memory_20250818',
    name: 'memory',
};
//# sourceMappingURL=memory-tool.js.map