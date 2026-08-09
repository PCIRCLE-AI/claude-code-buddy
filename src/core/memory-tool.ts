// =============================================================================
// Anthropic memory tool adapter — `memory_20250818` over the knowledge graph
//
// Lets an application that calls the Messages API directly hand Claude a
// `{"type": "memory_20250818", "name": "memory"}` tool whose storage IS MeMesh,
// rather than a directory of loose text files. The tool is client-side: Claude
// only REQUESTS file operations, and whoever runs the loop executes them. This
// module is that execution.
//
// Backing it with a database is not a workaround. Anthropic's own contract says
// `/memories` is "a prefix that your handler maps onto real storage, such as a
// per-user directory or keys in a database", and that the returned strings are
// the implementer's to choose. What the model needs is a consistent file-shaped
// view; what it gets here is search, ranking, decay, relations and namespaces
// underneath one.
//
// Deliberately NOT a tenth MCP tool. The nine MCP tools serve an agent that
// already speaks MeMesh; this serves an application that speaks the Messages
// API and knows nothing about entities. Same core, two audiences, no shared
// vocabulary — folding them together would make one surface answer to two
// contracts.
// =============================================================================

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { removeFromFts, insertFtsRow } from '../storage/fts-index.js';
import type { Entity, Namespace } from './types.js';

/** The one prefix every path must sit under. Anything else is refused. */
export const MEMORY_ROOT = '/memories';

/**
 * Namespaces are the directory level.
 *
 * Typed as `readonly Namespace[]` rather than declaring its own union, so that
 * adding a namespace to `core/types.ts` and forgetting this list is a compile
 * error instead of a directory that silently cannot be reached. A second
 * hand-written copy of an enum is the shape that drifts.
 */
const NAMESPACES: readonly Namespace[] = ['personal', 'team', 'global'];

const FILE_SUFFIX = '.md';

/**
 * Caps, both required by the contract's security section ("track memory file
 * sizes and cap how large a file can grow", "consider capping how many
 * characters the view command returns").
 *
 * Without them a model in a loop can grow one memory without bound — every
 * `insert` re-reads and rewrites the whole entity, so the cost is quadratic in
 * the number of appends, and the row lands in the FTS index and the embedding
 * pipeline behind it.
 */
const MAX_FILE_BYTES = 256 * 1024;
/** Matches the 16 000 characters the tool description tells Claude to expect. */
const MAX_VIEW_CHARS = 16_000;

export type MemoryCommand =
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str?: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

/**
 * What goes back in the `tool_result` block.
 *
 * `isError` maps to the block's `is_error: true`. It is a separate field rather
 * than a magic prefix on `content` because the caller has to set it on the
 * block, and a convention like "starts with Error:" is the kind of agreement
 * that holds until someone rewords a message.
 */
export interface MemoryToolResult {
  content: string;
  isError: boolean;
}

const ok = (content: string): MemoryToolResult => ({ content, isError: false });
const err = (content: string): MemoryToolResult => ({ content, isError: true });

// --- Path handling -----------------------------------------------------------

/**
 * Entity names are free text and may contain `/`, which is the one character
 * that would turn a name into extra path segments. Percent-encoding just that
 * character (and `%` itself, first, so the encoding is reversible) keeps names
 * readable to the model — `Project Apollo.md`, not `Project%20Apollo.md` — while
 * making the mapping one-to-one.
 *
 * `\` is encoded too: a Windows-shaped separator in a name would otherwise read
 * as a separator to any caller that normalises paths before handing them over.
 */
function encodeName(name: string): string {
  return name.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\\/g, '%5C');
}

function decodeName(segment: string): string {
  return segment
    .replace(/%2F/gi, '/')
    .replace(/%5C/gi, '\\')
    .replace(/%25/g, '%');
}

type ParsedPath =
  | { kind: 'root' }
  | { kind: 'namespace'; namespace: Namespace }
  | { kind: 'entity'; namespace: Namespace; name: string };

/**
 * Turn a model-supplied path into a location, or refuse it.
 *
 * Traversal validation runs even though nothing here touches a filesystem. Two
 * reasons: `..` would still resolve to a DIFFERENT namespace or entity than the
 * one the model named — a silent wrong-write rather than an escape — and the
 * contract puts this check on the implementer in a warning box. Structural
 * safety plus the stated check, not one instead of the other.
 */
function parsePath(raw: unknown): ParsedPath | MemoryToolResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return err('Error: `path` must be a non-empty string.');
  }
  if (raw.includes('\0')) {
    return err('Error: `path` may not contain a NUL byte.');
  }
  // `/memories` exactly, or `/memories/...` — `/memories-of-you` must not pass.
  if (raw !== MEMORY_ROOT && !raw.startsWith(`${MEMORY_ROOT}/`)) {
    return err(
      `Error: paths must be under ${MEMORY_ROOT}. The path ${raw} is outside it.`
    );
  }

  const rest = raw.slice(MEMORY_ROOT.length).replace(/^\//, '');
  if (rest === '') return { kind: 'root' };

  const segments = rest.split('/');

  // Checked BEFORE decoding, so an encoded `..` cannot arrive as a segment
  // afterwards — `%2e%2e` decodes to `..` only through decodeURIComponent,
  // which is why `decodeName` handles exactly three sequences and not the
  // general case. Percent-decoding everything is what makes traversal
  // reachable in the first place.
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return err(
        `Error: the path ${raw} contains a traversal or empty segment and was refused.`
      );
    }
    if (/%2e%2e/i.test(segment) || segment.includes('\\')) {
      return err(
        `Error: the path ${raw} contains a traversal sequence and was refused.`
      );
    }
  }

  if (segments.length > 2) {
    return err(
      `Error: ${MEMORY_ROOT} is two levels deep — ${MEMORY_ROOT}/<namespace>/<memory>${FILE_SUFFIX}. ` +
        `The path ${raw} is deeper than that.`
    );
  }

  const namespace = segments[0];
  if (!(NAMESPACES as readonly string[]).includes(namespace)) {
    return err(
      `Error: "${namespace}" is not a memory namespace. Use one of: ${NAMESPACES.join(', ')}.`
    );
  }

  if (segments.length === 1) {
    return { kind: 'namespace', namespace: namespace as Namespace };
  }

  const file = segments[1];
  if (!file.endsWith(FILE_SUFFIX)) {
    return err(`Error: memory files end in ${FILE_SUFFIX}. The path ${raw} does not.`);
  }
  const name = decodeName(file.slice(0, -FILE_SUFFIX.length));
  if (name === '') {
    return err(`Error: the path ${raw} names an empty memory.`);
  }
  return { kind: 'entity', namespace: namespace as Namespace, name };
}

const isResult = (v: ParsedPath | MemoryToolResult): v is MemoryToolResult =>
  'content' in v;

function entityPath(namespace: string, name: string): string {
  return `${MEMORY_ROOT}/${namespace}/${encodeName(name)}${FILE_SUFFIX}`;
}

// --- Rendering ---------------------------------------------------------------

/**
 * An entity, as a file.
 *
 * The body is its observations, in `id` order, joined by newlines. Nothing
 * else — no header, no metadata block — because every line the model can count
 * has to be a line it can also address, and a header would put a fixed offset
 * between "line 3" and "the third thing I remember" that only this file knows
 * about. Type and tags live in the directory listing instead.
 *
 * `id` order and not score order, and this is the load-bearing choice in the
 * whole module: `view` and the edit that follows it are two separate turns, and
 * between them a hook can write a new observation or `trackAccess` can change a
 * ranking. If the order the model saw came from a score, the line numbers it
 * read would address different content by the time it sent them back — a
 * silent wrong-write, not an error. Insertion order is immutable, so it cannot.
 */
function renderBody(entity: Entity): string {
  return entity.observations.join('\n');
}

/**
 * Which observation owns each rendered line.
 *
 * Computed from the same text the model was shown rather than assumed to be
 * one-to-one, because an observation may itself contain newlines and then one
 * observation spans several lines. Returns a 1-indexed lookup: line -> index
 * into `observations`.
 */
function lineOwners(observations: string[]): number[] {
  const owners: number[] = [];
  observations.forEach((observation, index) => {
    const span = observation.split('\n').length;
    for (let i = 0; i < span; i++) owners.push(index);
  });
  return owners;
}

/** The `view` line format the contract specifies: 6 wide, right-aligned, tab. */
function withLineNumbers(body: string, from = 1): string {
  if (body === '') return '';
  return body
    .split('\n')
    .map((line, i) => `${String(from + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

// --- Storage helpers ---------------------------------------------------------

function graph(): KnowledgeGraph {
  return new KnowledgeGraph(getDatabase());
}

/** One row of a directory listing. Deliberately not an `Entity`. */
type Listing = {
  name: string;
  type: string;
  bytes: number;
};

/**
 * List a namespace WITHOUT touching it.
 *
 * `KnowledgeGraph.listRecent()` was the obvious call and is the wrong one here,
 * for two reasons that both bite hardest on this exact code path.
 *
 * It calls `trackAccess()`, which runs
 * `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ?`
 * over every row it returns. The API injects "ALWAYS VIEW YOUR MEMORY DIRECTORY
 * BEFORE DOING ANYTHING ELSE" into the system prompt, so a directory view is
 * the FIRST call of EVERY conversation — which meant every conversation
 * incremented the access count of every memory in the database. Measured: five
 * untouched memories went from 0 to 4 apiece after three root views and one
 * namespace view. `frequency` carries 0.18 of the ranking score and
 * `last_accessed_at` feeds `recency` at 0.25, so a read was quietly flattening
 * both signals and defeating auto-decay at the same time. A listing is a
 * catalogue read; nobody looked at those memories.
 *
 * It also hydrates: observations, tags and relations for every row, to produce
 * a name and a size. This asks SQLite for the two facts a listing needs.
 */
function listNamespace(namespace: Namespace): Listing[] {
  return getDatabase()
    .prepare(
      `SELECT e.name AS name,
              e.type AS type,
              COALESCE(SUM(LENGTH(o.content)) + MAX(COUNT(o.id) - 1, 0), 0) AS bytes
         FROM entities e
         LEFT JOIN observations o ON o.entity_id = e.id
        WHERE e.status = 'active' AND e.namespace = ?
        GROUP BY e.id
        ORDER BY e.id DESC`
    )
    .all(namespace) as Listing[];
}

function countNamespace(namespace: Namespace): number {
  return (
    getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM entities WHERE status = 'active' AND namespace = ?"
      )
      .get(namespace) as { n: number }
  ).n;
}

function tagsOf(name: string): string[] {
  return (
    getDatabase()
      .prepare('SELECT tag FROM tags WHERE entity_id = (SELECT id FROM entities WHERE name = ?)')
      .all(name) as Array<{ tag: string }>
  ).map((t) => t.tag);
}

function findEntity(kg: KnowledgeGraph, namespace: string, name: string): Entity | null {
  const entity = kg.getEntity(name);
  // Entity names are unique database-wide, so a name that exists in another
  // namespace is a real miss for THIS path rather than a hit to be borrowed.
  if (!entity || entity.namespace !== namespace) return null;
  return entity;
}

/**
 * Replace an entity's observations with exactly this list, in this order.
 *
 * `insert` can put an observation in the middle, and `id` is what defines
 * order, so there is no id to hand out between two existing rows. Rewriting the
 * whole list is the honest way to get the requested order; `clearEntityData`
 * plus `createEntity` is used rather than raw SQL so that the contentless FTS5
 * delete-then-insert and the tag handling stay with the code that owns them.
 * Tags are read back first because `clearEntityData` drops those too.
 */
function rewriteObservations(
  kg: KnowledgeGraph,
  entity: Entity,
  observations: string[]
): void {
  // One transaction, because the two halves are a delete and a restore. On its
  // own, `clearEntityData` removes every observation AND every tag; if
  // `createEntity` then threw — a disk-full, a lock lost to one of the seven
  // hooks, a constraint — the memory would be left empty and untagged, with
  // the tool having reported nothing. Losing the content while editing it is
  // worse than refusing the edit.
  getDatabase().transaction(() => {
    kg.clearEntityData(entity.name);
    kg.createEntity(entity.name, entity.type, {
      observations,
      tags: entity.tags,
      namespace: entity.namespace,
    });
  })();
}

/** Reject a write that would push the memory past the size cap. */
function tooLarge(body: string, path: string): MemoryToolResult | null {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= MAX_FILE_BYTES) return null;
  return err(
    `Error: ${path} would be ${humanSize(bytes)}, over the ${humanSize(MAX_FILE_BYTES)} ` +
      `limit for one memory. Split it across several memories.`
  );
}

// --- Commands ----------------------------------------------------------------

function viewRoot(): MemoryToolResult {
  const lines = [`${MEMORY_ROOT}`];
  for (const namespace of NAMESPACES) {
    lines.push(`${MEMORY_ROOT}/${namespace}\t${countNamespace(namespace)} memories`);
  }
  return ok(
    `Here're the files and directories up to 2 levels deep in ${MEMORY_ROOT}, ` +
      `excluding hidden items and node_modules:\n${lines.join('\n')}`
  );
}

function viewNamespace(namespace: Namespace): MemoryToolResult {
  const lines = listNamespace(namespace).map((row) => {
    const tags = tagsOf(row.name);
    const suffix = tags.length > 0 ? `  tags: ${tags.join(', ')}` : '';
    return `${humanSize(row.bytes)}\t${entityPath(namespace, row.name)}\t(${row.type})${suffix}`;
  });
  return ok(
    `Here're the files and directories up to 2 levels deep in ${MEMORY_ROOT}/${namespace}, ` +
      `excluding hidden items and node_modules:\n` +
      [`${MEMORY_ROOT}/${namespace}`, ...lines].join('\n')
  );
}

function viewEntity(
  namespace: Namespace,
  name: string,
  range: unknown,
  path: string
): MemoryToolResult {
  const entity = findEntity(graph(), namespace, name);
  if (!entity) {
    return err(`The path ${path} does not exist. Please provide a valid path.`);
  }

  const body = renderBody(entity);
  const lines = body === '' ? [] : body.split('\n');

  if (range === undefined) {
    if (body.length > MAX_VIEW_CHARS) {
      // Truncate at a line boundary and say so, rather than returning a
      // memory's worth of text in one tool result. The tool description
      // already tells Claude that long files are truncated and that
      // `view_range` pages through the rest, so this is the behaviour it
      // expects — and it is the cap the contract asks the implementer for.
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length + 1 > MAX_VIEW_CHARS) break;
        kept.push(line);
        used += line.length + 1;
      }
      return ok(
        `Here's the content of ${path} with line numbers:\n${withLineNumbers(kept.join('\n'))}\n` +
          `\n[truncated at ${kept.length} of ${lines.length} lines — ` +
          `use view_range to read from line ${kept.length + 1}]`
      );
    }
    return ok(`Here's the content of ${path} with line numbers:\n${withLineNumbers(body)}`);
  }

  if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
    return err('Error: `view_range` must be a two-element array of integers, [start, end].');
  }
  const [start, rawEnd] = range as [number, number];
  const end = rawEnd === -1 ? lines.length : rawEnd;
  if (start < 1 || start > Math.max(lines.length, 1) || end < start) {
    return err(
      `Error: Invalid \`view_range\`: [${start}, ${rawEnd}]. ` +
        `It should be within the range of lines of the file: [1, ${lines.length}]`
    );
  }
  const slice = lines.slice(start - 1, end).join('\n');
  return ok(
    `Here's the content of ${path} with line numbers:\n${withLineNumbers(slice, start)}`
  );
}

function createEntityFile(
  namespace: Namespace,
  name: string,
  fileText: unknown,
  path: string
): MemoryToolResult {
  if (typeof fileText !== 'string') {
    return err('Error: `file_text` must be a string.');
  }
  const kg = graph();
  const existing = findEntity(kg, namespace, name);
  // The contract calls create "creates or overwrites" and offers the
  // already-exists error as the reference behaviour. Overwriting is chosen
  // here: the model is told it may overwrite, and refusing would leave it
  // unable to rewrite a memory it has just decided is wrong.
  const oversize = tooLarge(fileText, path);
  if (oversize) return oversize;
  const observations = fileText === '' ? [] : fileText.split('\n');

  if (existing) {
    rewriteObservations(kg, existing, observations);
    return ok(`File created successfully at: ${path}`);
  }

  kg.createEntity(name, 'note', { observations, namespace });
  return ok(`File created successfully at: ${path}`);
}

function strReplace(
  namespace: Namespace,
  name: string,
  oldStr: unknown,
  newStr: unknown,
  path: string
): MemoryToolResult {
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
    return err(
      `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`
    );
  }
  if (body.indexOf(oldStr, first + 1) !== -1) {
    // Line numbers of every occurrence, so the model can widen `old_str`
    // rather than guess. Ambiguity is refused, not resolved by picking one:
    // this is a write, and the wrong one is silent.
    const lines: number[] = [];
    let at = first;
    while (at !== -1) {
      lines.push(body.slice(0, at).split('\n').length);
      at = body.indexOf(oldStr, at + 1);
    }
    return err(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` ` +
        `in lines: ${lines.join(', ')}. Please ensure it is unique`
    );
  }

  const replaced = body.slice(0, first) + (newStr ?? '') + body.slice(first + oldStr.length);
  const oversize = tooLarge(replaced, path);
  if (oversize) return oversize;
  const observations = replaced === '' ? [] : replaced.split('\n');
  rewriteObservations(kg, entity, observations);

  const at = replaced.slice(0, first).split('\n').length;
  const from = Math.max(1, at - 2);
  const snippet = replaced.split('\n').slice(from - 1, at + 2).join('\n');
  return ok(
    `The memory file has been edited. Here's a snippet of ${path} with line numbers:\n` +
      withLineNumbers(snippet, from)
  );
}

function insertLine(
  namespace: Namespace,
  name: string,
  atLine: unknown,
  text: unknown,
  path: string
): MemoryToolResult {
  if (!Number.isInteger(atLine)) {
    return err('Error: `insert_line` must be an integer.');
  }
  if (typeof text !== 'string') {
    return err('Error: `insert_text` must be a string.');
  }
  const kg = graph();
  const entity = findEntity(kg, namespace, name);
  if (!entity) return err(`Error: The path ${path} does not exist`);

  const owners = lineOwners(entity.observations);
  const line = atLine as number;
  if (line < 0 || line > owners.length) {
    return err(
      `Error: Invalid \`insert_line\` parameter: ${line}. ` +
        `It should be within the range of lines of the file: [0, ${owners.length}]`
    );
  }

  // Line -> observation, so "after line N" means "after the observation that
  // owns line N" rather than splitting one observation in half. A memory is
  // the unit here; cutting one apart at a line boundary would leave two
  // fragments that separately mean nothing.
  const insertAfter = line === 0 ? -1 : owners[line - 1];
  const observations = [...entity.observations];
  observations.splice(insertAfter + 1, 0, text.replace(/\n$/, ''));
  const oversize = tooLarge(observations.join('\n'), path);
  if (oversize) return oversize;
  rewriteObservations(kg, entity, observations);

  return ok(`The file ${path} has been edited.`);
}

function deletePath(parsed: ParsedPath, path: string): MemoryToolResult {
  if (parsed.kind === 'root') {
    return err(`Error: ${MEMORY_ROOT} itself cannot be deleted.`);
  }
  if (parsed.kind === 'namespace') {
    return err(
      `Error: ${path} is a namespace and cannot be deleted. Delete individual memories instead.`
    );
  }
  const kg = graph();
  const entity = findEntity(kg, parsed.namespace, parsed.name);
  if (!entity) return err(`Error: The path ${path} does not exist`);

  // Archive, not hard delete. MeMesh never destroys a memory on a forget —
  // archived entities leave search and vector results but stay restorable, and
  // this path is driven by a model rather than by the person whose memory it
  // is. `view` lists only active entities, so from the model's side the file is
  // gone; from the user's side it is recoverable.
  kg.archiveEntity(entity.name);
  return ok(`Successfully deleted ${path}`);
}

function renamePath(oldRaw: unknown, newRaw: unknown): MemoryToolResult {
  const from = parsePath(oldRaw);
  if (isResult(from)) return from;
  const to = parsePath(newRaw);
  if (isResult(to)) return to;

  if (from.kind !== 'entity' || to.kind !== 'entity') {
    return err(
      `Error: rename moves one memory to another memory path. ` +
        `${MEMORY_ROOT} and its namespaces cannot be renamed.`
    );
  }

  const kg = graph();
  const source = findEntity(kg, from.namespace, from.name);
  if (!source) return err(`Error: The path ${String(oldRaw)} does not exist`);
  if (findEntity(kg, to.namespace, to.name)) {
    return err(`Error: The destination ${String(newRaw)} already exists`);
  }
  // Checked across ALL namespaces, not just the destination's: entity names are
  // unique database-wide, so a name taken in `team` would make a rename into
  // `personal` fail at the storage layer with a constraint error instead of the
  // message the contract specifies.
  if (kg.getEntity(to.name)) {
    return err(
      `Error: The destination ${String(newRaw)} already exists in another namespace. ` +
        `Memory names are unique across namespaces.`
    );
  }

  const db = getDatabase();
  const entityId = source.id as number;
  const obsText = source.observations.join(' ');

  // A rename changes the NAME. Observations and tags are untouched, so nothing
  // here rewrites them — the only thing that has to move is the FTS row, whose
  // indexed text includes the name.
  //
  // Order matters, and getting it wrong is silent. `entities_fts` is
  // CONTENTLESS: a delete must be issued with the exact text that was indexed,
  // because the table stores none of it. This used to rename the row first and
  // then rebuild the index via `clearEntityData`, which deletes using the
  // CURRENT name — by then the NEW one, never indexed. The delete matched
  // nothing, the insert layered the new name's tokens on top, and the old name
  // stayed searchable. Measured before the fix: after renaming
  // `kangaroo-notes` to `wallaby-notes`, `MATCH kangaroo` still returned the
  // row. Rename a memory to get a wrong label off it, and the label stays.
  //
  // Remove under the OLD name, rename, insert under the NEW one — one
  // transaction, so no reader sees the row half-renamed and a failure anywhere
  // leaves both the table and the index as they were.
  db.transaction(() => {
    removeFromFts(db, entityId, source.name, obsText);
    db.prepare('UPDATE entities SET name = ?, namespace = ? WHERE id = ?')
      .run(to.name, to.namespace, entityId);
    insertFtsRow(db, entityId, to.name, obsText);
  })();

  return ok(`Successfully renamed ${String(oldRaw)} to ${String(newRaw)}`);
}

// --- Entry point -------------------------------------------------------------

/**
 * Execute one `memory` tool call and return what belongs in the `tool_result`.
 *
 * Takes `unknown` rather than a typed command on purpose: the input arrives
 * from a model over the wire, so every field is checked here rather than
 * trusted to match the declared shape.
 */
export function handleMemoryCommand(input: unknown): MemoryToolResult {
  if (typeof input !== 'object' || input === null) {
    return err('Error: the memory tool input must be an object.');
  }
  const cmd = input as Record<string, unknown>;

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
  if (isResult(parsed)) return parsed;
  const path = cmd.path as string;

  if (cmd.command === 'delete') return deletePath(parsed, path);

  if (cmd.command === 'view') {
    if (parsed.kind === 'root') return viewRoot();
    if (parsed.kind === 'namespace') return viewNamespace(parsed.namespace);
    return viewEntity(parsed.namespace, parsed.name, cmd.view_range, path);
  }

  // Everything below writes, and only a memory file can be written.
  if (parsed.kind !== 'entity') {
    return err(
      `Error: ${path} is a directory. ${cmd.command} needs a memory file, ` +
        `${MEMORY_ROOT}/<namespace>/<memory>${FILE_SUFFIX}.`
    );
  }

  // Exhaustive: the switch at the top of this function already refused every
  // other value of `command`, so there is no fallthrough to write here — and
  // TypeScript reports one as unreachable rather than letting it sit as a
  // reassuring line that can never run.
  switch (cmd.command) {
    case 'create':
      return createEntityFile(parsed.namespace, parsed.name, cmd.file_text, path);
    case 'str_replace':
      return strReplace(parsed.namespace, parsed.name, cmd.old_str, cmd.new_str, path);
    case 'insert':
      return insertLine(parsed.namespace, parsed.name, cmd.insert_line, cmd.insert_text, path);
  }
}

/**
 * The `tools` entry to send with the request. Exported so callers cannot
 * mistype the version string — it is the whole configuration, and a wrong one
 * fails as "unknown tool" rather than as anything that names the typo.
 */
export const MEMORY_TOOL_DEFINITION = {
  type: 'memory_20250818',
  name: 'memory',
} as const;
