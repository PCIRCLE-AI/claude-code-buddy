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
import type { Entity } from './types.js';

/** The one prefix every path must sit under. Anything else is refused. */
export const MEMORY_ROOT = '/memories';

/** Namespaces are the directory level. These are the only ones MeMesh has. */
const NAMESPACES = ['personal', 'team', 'global'] as const;
type Namespace = (typeof NAMESPACES)[number];

const FILE_SUFFIX = '.md';

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
  kg.clearEntityData(entity.name);
  kg.createEntity(entity.name, entity.type, {
    observations,
    tags: entity.tags,
    namespace: entity.namespace,
  });
}

// --- Commands ----------------------------------------------------------------

function viewRoot(): MemoryToolResult {
  const kg = graph();
  const lines = [`${MEMORY_ROOT}`];
  for (const namespace of NAMESPACES) {
    const count = kg.listRecent(10_000, false, namespace).length;
    lines.push(`${MEMORY_ROOT}/${namespace}\t${count} memories`);
  }
  return ok(
    `Here're the files and directories up to 2 levels deep in ${MEMORY_ROOT}, ` +
      `excluding hidden items and node_modules:\n${lines.join('\n')}`
  );
}

function viewNamespace(namespace: Namespace): MemoryToolResult {
  const kg = graph();
  const entities = kg.listRecent(10_000, false, namespace);
  const lines = entities.map((entity) => {
    const size = humanSize(Buffer.byteLength(renderBody(entity), 'utf8'));
    const tags = entity.tags.length > 0 ? `  tags: ${entity.tags.join(', ')}` : '';
    return `${size}\t${entityPath(namespace, entity.name)}\t(${entity.type})${tags}`;
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

  getDatabase()
    .prepare('UPDATE entities SET name = ?, namespace = ? WHERE id = ?')
    .run(to.name, to.namespace, source.id);
  // The name is indexed in FTS5, so the row has to be rewritten under the new
  // one. Going through clearEntityData + createEntity keeps the contentless
  // delete-then-insert with the code that owns it.
  const renamed = kg.getEntity(to.name);
  if (renamed) rewriteObservations(kg, renamed, source.observations);

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
