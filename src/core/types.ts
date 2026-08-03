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

export type Namespace = 'personal' | 'team' | 'global';
export type MergeStrategy = 'skip' | 'overwrite' | 'append';
export type LessonSeverity = 'critical' | 'major' | 'minor';
export type EntityStatus = 'active' | 'archived';
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

export interface Entity {
  id: number;
  name: string;
  type: string;
  created_at: string;
  metadata?: Record<string, unknown>;
  observations: string[];
  tags: string[];
  relations?: Relation[];
  archived?: boolean;
  access_count?: number;
  last_accessed_at?: string;
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
}

// --- Operation Input Types (what transports pass to core) ---

export interface RememberInput {
  name: string;
  type: string;
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
  type: string;
  observations: number;
  tags: number;
  relations: number;
  superseded?: string[];
  relationErrors?: string[];
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
}

export interface ConsolidateInput {
  name?: string;           // specific entity to consolidate
  tag?: string;            // consolidate all entities with this tag
  min_observations?: number; // minimum observations to trigger (default: 5)
}

export interface ConsolidateResult {
  consolidated: number;
  entities_processed: string[];
  observations_before: number;
  observations_after: number;
  error?: string;
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
}

export interface LearnResult {
  learned: boolean;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// SQLite row types — replace `as any` casts on query results
// ---------------------------------------------------------------------------

export interface EntityRow {
  id: number;
  name: string;
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
  // valid_from / valid_until columns retained in SQLite schema for
  // back-compat with older databases but are no longer read or written
  // (SDD G2 cut, 2026-05). Do not add them back here without also
  // restoring the SELECT clauses in knowledge-graph.ts.
  namespace: string;
}

// ObservationRow / TagRow / RelationRow / FtsRow types lived here
// historically as aspirational shapes for SELECT-result casts but were
// never actually imported. Removed in 2026-05 (SDD G13 cleanup) so the
// canonical SQL row types stay close to the queries that produce them.

export interface CountRow {
  c: number;
}

export interface PragmaColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

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
