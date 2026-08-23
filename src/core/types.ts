// =============================================================================
// Core Types — zero external dependencies
// Imported by: core/operations, transports/mcp, transports/http, transports/cli
// =============================================================================

// --- Entity Model ---

// --- Centralized union types ---
// Promoted from inline string-literal unions to named exports so all
// call sites share one source of truth. Schemas in src/transports/
// continue to declare their own `z.enum([...])` runtime validators —
// these TS-only types do not affect Zod validation.

/**
 * Relation types the code BRANCHES ON, and what each one does.
 *
 * A relation type is otherwise a free string: `createRelation()` accepts
 * anything and most types are inert labels. These two are not. They change what
 * MeMesh does, and one of them destroys something:
 *
 *   - `supersedes` archives the target entity, immediately, on write.
 *   - `contradicts` makes both entities surface as a conflict on every recall.
 *
 * Neither was named anywhere the caller could see. The MCP `remember` schema —
 * the ONLY description a model reads at run time — offered `"implements"` and
 * `"related-to"` as its examples, and both of those are inert. So the two types
 * with consequences were undiscoverable, while the two advertised ones did
 * nothing: `findConflicts()` ran on every single recall and could only ever
 * return `[]`, which every transport renders as "no conflicts" — a checked-and-
 * clean answer to a question nothing could ever answer. And `supersedes`, which
 * archives an entity, was reachable only by guessing the word.
 *
 * This map is the single source of truth. `tests/relation-types-documented.test.ts`
 * fails if the code branches on a relation type that is not listed here, and if
 * a type listed here is missing from the schema description the model reads.
 * Add a behavioural relation type without documenting it and the suite goes red.
 */
export const BEHAVIOURAL_RELATION_TYPES = {
  supersedes:
    'archives the target entity — use it when this memory replaces an older one',
  contradicts:
    'flags both memories as a conflict every time either is recalled — use it when two memories cannot both be true',
} as const;

export type BehaviouralRelationType = keyof typeof BEHAVIOURAL_RELATION_TYPES;

/**
 * The tag every capture hook attaches to what it writes.
 *
 * This is the only honest answer to "did automation produce this memory".
 * `memesh doctor`'s hook-activity row used to answer it from entity TYPE, and
 * one of the types it counted — `lesson_learned` — is what `memesh learn`
 * writes, which a user types by hand. So a fresh HOME with no `.claude`
 * directory reported "auto-capture loop is alive" after one manual command.
 *
 * `tests/auto-capture-provenance.test.ts` fails if a capture hook stops
 * writing it, or if doctor stops counting it.
 */
export const AUTO_CAPTURE_TAG = 'source:auto-capture';

/**
 * The namespaces, as a runtime list.
 *
 * `Namespace` is erased at compile time, so every place that had to REJECT a
 * bad value kept its own copy of the strings — the CLI had one, the Zod
 * schemas have one each. That is fine until one copy is missed, which is
 * exactly what happened: `ImportSchema` validated `namespace` as
 * `z.string().max(50)` while `RememberSchema` used the enum, and once an
 * explicit namespace began MOVING entities that already exist, the loose one
 * became a way to relocate memories into a scope nothing queries.
 */
export const NAMESPACES = ['personal', 'team', 'global'] as const;

export type Namespace = (typeof NAMESPACES)[number];
export type MergeStrategy = 'skip' | 'overwrite' | 'append';
export type LessonSeverity = 'critical' | 'major' | 'minor';
export type EntityStatus = 'active' | 'archived';
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

export interface Entity {
  id: number;
  name: string;
  /**
   * Human-readable display string, distinct from `name` (the machine
   * dedup/append key). Absent on rows written before this field existed
   * and not yet backfilled — display code falls back to
   * pickBestObservation() then typeLabel+date, never to `name`.
   */
  title?: string | null;
  type: string;
  created_at: string;
  metadata?: Record<string, unknown>;
  observations: string[];
  tags: string[];
  relations?: Relation[];
  archived?: boolean;
  /**
   * How recall found this entity. `keyword` = the FTS index matched the
   * query text; `semantic` = the vector index supplied it because nothing
   * (or nothing else) matched lexically. The distinction is load-bearing
   * for presentation: a semantic-only hit CANNOT be certified relevant —
   * measured on this repo's own calibration data (nomic-embed-text, the
   * current embedder), genuine matches land at nearest distance 0.858–1.010
   * while unrelated queries land at 0.983–1.104, so the two distributions
   * overlap around ~1.0 (where MAX_VECTOR_DISTANCE sits) and no threshold
   * cleanly separates them. What geometry cannot decide, the UI must
   * disclose. Absent on non-recall reads.
   */
  match?: { source: 'keyword' | 'semantic'; relevance: number };
  access_count?: number;
  last_accessed_at?: string;
  /** Citation accounting, written by the Stop hook and read by
   *  `rankEntities`'s impact factor. Optional because catalogue reads
   *  (`listByType`, exports) do not hydrate them. */
  recall_hits?: number;
  recall_misses?: number;
  confidence?: number;
  // Temporal validity (`valid_from` / `valid_until`) was removed in
  // 2026-05; the columns remain in the SQLite schema but no code path
  // reads or writes them. See Dashboard-v3 SDD plan G2 for the cut
  // rationale.
  // `namespace` is non-optional on the read side: the DB column has
  // `DEFAULT 'personal'` and getEntity / search always coerce missing
  // values to 'personal', so callers should not need a `?? 'personal'`
  // dance. Producers that want to opt out of namespacing on write use
  // the optional field on RememberInput instead.
  namespace: 'personal' | 'team' | 'global' | string;
}

export interface Relation {
  from: string;
  to: string;
  type: string;
  // Relation-level `metadata` was removed in 2026-05; the column
  // remains in SQLite but no code path uses it. See SDD plan G3.
}

// --- Input Types ---

export interface CreateEntityInput {
  name: string;
  type: string;
  observations?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}

export interface SearchOptions {
  tag?: string;
  limit?: number;
  includeArchived?: boolean;
  namespace?: string;  // filter by namespace; omit to search all namespaces
  /**
   * Whether this read counts as a use of the memories it returns.
   *
   * Default true: a recall IS a use, and `access_count` /
   * `last_accessed_at` are 20% of the ranking. False for reads that are
   * ABOUT the memories rather than uses of them — `export` is the one that
   * had to be corrected, because taking a backup re-ranked up to a thousand
   * memories toward the top and stamped them all as freshly used on the day
   * the backup ran. `listByType` already made the same distinction by
   * simply not calling trackAccess; this is the switch for the paths that
   * share a query with real recalls.
   */
  countAsAccess?: boolean;
}

// --- Operation Input Types (what transports pass to core) ---

export interface RememberInput {
  name: string;
  type: string;
  /** Optional human-readable display string. Auto-capture hooks generate
   *  one heuristically; a deliberate `remember` call may supply its own. */
  title?: string;
  observations?: string[];
  tags?: string[];
  relations?: Array<{ to: string; type: string }>;
  namespace?: string;  // 'personal' | 'team' | 'global' (default: 'personal')
  // Internal-only metadata override. Used by auto-learned lessons (LLM
  // paraphrasing of session errors) to mark themselves `untrusted` so
  // `isTrustedForAutoContext()` excludes them from session-start
  // injection. Not exposed in the transport schemas — only callers
  // inside core can set this.
  trustOverride?: 'trusted' | 'untrusted';
  provenanceOverride?: Record<string, unknown>;
  // Which host/surface wrote this memory — 'claude-code', 'codex', 'cli',
  // 'http', an MCP client's self-declared name. Set by the TRANSPORT, never
  // by the model: it is deliberately absent from the tool schemas, because a
  // provenance field the writer can spoof is not provenance. Stored as
  // metadata.provenance.source_host so it survives federation (phase 03
  // stamps ingested entities the same way).
  sourceHost?: string;
}

export interface RecallInput {
  query?: string;
  tag?: string;
  limit?: number;
  include_archived?: boolean;
  namespace?: string;       // filter by namespace; omit to search all namespaces
  cross_project?: boolean;  // search across all project tags (default: false)
}

export interface ForgetInput {
  name: string;
  observation?: string;
}

// --- Operation Result Types (what core returns to transports) ---

export interface RememberResult {
  stored: boolean;
  entityId: number;
  name: string;
  title?: string | null;
  type: string;
  observations: number;
  tags: number;
  relations: number;
  superseded?: string[];
  relationErrors?: string[];
  /**
   * The relations that were actually created, not the ones that were asked for.
   *
   * `relations` is only a count and `relationErrors` is only messages, so a
   * caller wanting to report "this memory now contradicts X" had to reconstruct
   * the successful set by subtracting one from the other — and the CLI got that
   * wrong, announcing `conflicts stated: <target>` for a target whose relation
   * had failed in the same call. A caller should not have to do arithmetic to
   * find out what happened.
   */
  relationsCreated?: Array<{ to: string; type: string }>;
  /**
   * Set only when this call MOVED a memory that already existed between
   * namespaces, naming the scope it came from.
   *
   * A move is a real relocation — the memory drops out of every scoped view it
   * used to appear in — and it was invisible: the result said `stored: true`
   * and nothing else, no backup is taken, and the row is overwritten in place.
   * The entity keeps its id, so its vectors and FTS row are untouched; what
   * changes is where it can be found. Pairs with `metadata.previous_namespace`,
   * which makes the move undoable from the row itself.
   */
  movedFromNamespace?: string;
}

export interface ForgetResult {
  // Entity-level archive
  archived?: boolean;
  name?: string;
  message?: string;
  // Observation-level removal
  observation_removed?: boolean;
  observation?: string;
  remaining_observations?: number;
  /** Observation-level only: did the ENTITY exist? Distinguishes "no such
   *  entity" from "that text matched no observation". */
  entity_found?: boolean;
}

export interface ExportInput {
  tag?: string;
  namespace?: string;
  limit?: number;
}

export interface ExportResult {
  version: string;
  exported_at: string;
  entity_count: number;
  entities: Array<{
    name: string;
    type: string;
    /** The human-readable headline. `null` for an untitled entity — absent
     *  in bundles written before titles existed, which import must tolerate. */
    title?: string | null;
    namespace: string;
    observations: string[];
    tags: string[];
    relations: Array<{ to: string; type: string }>;
  }>;
}

export interface ImportInput {
  data: ExportResult;
  namespace?: string;       // override namespace for all imported entities
  merge_strategy: MergeStrategy;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  appended: number;
  errors: string[];
}

export interface LearnInput {
  error: string;
  fix: string;
  root_cause?: string;
  prevention?: string;
  severity?: LessonSeverity;
  // Transport-set, never model-set — see RememberInput.sourceHost.
  sourceHost?: string;
}

export interface LearnResult {
  learned: boolean;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// SQLite row types — replace `as any` casts on query results
// ---------------------------------------------------------------------------

export type EntityRow = {
  id: number;
  name: string;
  title: string | null;
  type: string;
  created_at: string;
  metadata: string | null;
  // Schema column is `TEXT NOT NULL DEFAULT 'active'`. Tightened to the
  // EntityStatus union so a future query that selects this column gets
  // a compile-time error if it tries to write or compare an
  // unrecognised value (e.g. typoed 'archive' instead of 'archived').
  status: EntityStatus;
  access_count: number;
  last_accessed_at: string | null;
  confidence: number;
  // Selected because `rankEntities` reads them. They were in the schema and
  // in the scorer but not in this row type, so the recall hydrator silently
  // returned `undefined` for both and `impactScore(0,0)` was a constant.
  recall_hits: number;
  recall_misses: number;
  // valid_from / valid_until columns retained in SQLite schema for
  // back-compat with older databases but are no longer read or written
  // (SDD G2 cut, 2026-05). Do not add them back here without also
  // restoring the SELECT clauses in knowledge-graph.ts.
  namespace: string;
};

// ObservationRow / TagRow / RelationRow / FtsRow types lived here
// historically as aspirational shapes for SELECT-result casts but were
// never actually imported. Removed in 2026-05 (SDD G13 cleanup) so the
// canonical SQL row types stay close to the queries that produce them.

export type CountRow = {
  c: number;
};

export type PragmaColumnRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

// ---------------------------------------------------------------------------
// LLM API response types — replace `as any` on response.json()
// ---------------------------------------------------------------------------

export interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

export interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface OllamaResponse {
  response?: string;
}
