// =============================================================================
// Core Types — zero external dependencies
// Imported by: core/operations, transports/mcp, transports/http, transports/cli
// =============================================================================

// --- Entity Model ---

export interface Entity {
  id: number;
  name: string;
  type: string;
  created_at: string;
  metadata?: any;
  observations: string[];
  tags: string[];
  relations?: Relation[];
  archived?: boolean;
  access_count?: number;
  last_accessed_at?: string;
  confidence?: number;
  valid_from?: string;
  valid_until?: string;
  namespace?: string;  // 'personal' | 'team' | 'global'
}

export interface Relation {
  from: string;
  to: string;
  type: string;
  metadata?: any;
}

// --- Input Types ---

export interface CreateEntityInput {
  name: string;
  type: string;
  observations?: string[];
  tags?: string[];
  metadata?: any;
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
  merge_strategy: 'skip' | 'overwrite' | 'append';
}

export interface ImportResult {
  imported: number;
  skipped: number;
  appended: number;
  errors: string[];
}
