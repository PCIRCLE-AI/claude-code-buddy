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
}

export interface SearchOptions {
  tag?: string;
  limit?: number;
  includeArchived?: boolean;
}

// --- Operation Input Types (what transports pass to core) ---

export interface RememberInput {
  name: string;
  type: string;
  observations?: string[];
  tags?: string[];
  relations?: Array<{ to: string; type: string }>;
}

export interface RecallInput {
  query?: string;
  tag?: string;
  limit?: number;
  include_archived?: boolean;
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
