export declare const BEHAVIOURAL_RELATION_TYPES: {
    readonly supersedes: "archives the target entity — use it when this memory replaces an older one";
    readonly contradicts: "flags both memories as a conflict every time either is recalled — use it when two memories cannot both be true";
};
export type BehaviouralRelationType = keyof typeof BEHAVIOURAL_RELATION_TYPES;
export declare const AUTO_CAPTURE_TAG = "source:auto-capture";
export declare const NAMESPACES: readonly ["personal", "team", "global"];
export type Namespace = (typeof NAMESPACES)[number];
export type MergeStrategy = 'skip' | 'overwrite' | 'append';
export type LessonSeverity = 'critical' | 'major' | 'minor';
export type EntityStatus = 'active' | 'archived';
export type LLMProvider = 'anthropic' | 'openai' | 'ollama';
export interface Entity {
    id: number;
    name: string;
    title?: string | null;
    type: string;
    created_at: string;
    metadata?: Record<string, unknown>;
    observations: string[];
    tags: string[];
    relations?: Relation[];
    archived?: boolean;
    match?: {
        source: 'keyword' | 'semantic';
        relevance: number;
    };
    access_count?: number;
    last_accessed_at?: string;
    recall_hits?: number;
    recall_misses?: number;
    confidence?: number;
    namespace: 'personal' | 'team' | 'global' | string;
}
export interface Relation {
    from: string;
    to: string;
    type: string;
}
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
    namespace?: string;
    countAsAccess?: boolean;
}
export interface RememberInput {
    name: string;
    type: string;
    title?: string;
    observations?: string[];
    tags?: string[];
    relations?: Array<{
        to: string;
        type: string;
    }>;
    namespace?: string;
    trustOverride?: 'trusted' | 'untrusted';
    provenanceOverride?: Record<string, unknown>;
    sourceHost?: string;
}
export interface RecallInput {
    query?: string;
    tag?: string;
    limit?: number;
    include_archived?: boolean;
    namespace?: string;
    cross_project?: boolean;
}
export interface ForgetInput {
    name: string;
    observation?: string;
}
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
    relationsCreated?: Array<{
        to: string;
        type: string;
    }>;
    movedFromNamespace?: string;
}
export interface ForgetResult {
    archived?: boolean;
    name?: string;
    message?: string;
    observation_removed?: boolean;
    observation?: string;
    remaining_observations?: number;
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
    truncated?: boolean;
    entities: Array<{
        name: string;
        type: string;
        title?: string | null;
        namespace: string;
        created_at?: string;
        status?: string;
        metadata?: Record<string, unknown>;
        observations: string[];
        tags: string[];
        relations: Array<{
            to: string;
            type: string;
        }>;
    }>;
}
export interface ImportInput {
    data: ExportResult;
    namespace?: string;
    merge_strategy: MergeStrategy;
}
export interface ImportResult {
    imported: number;
    skipped: number;
    appended: number;
    errors: string[];
    skipped_relations: string[];
}
export interface LearnInput {
    error: string;
    fix: string;
    root_cause?: string;
    prevention?: string;
    severity?: LessonSeverity;
    sourceHost?: string;
}
export interface LearnResult {
    learned: boolean;
    name: string;
    type: string;
}
export type EntityRow = {
    id: number;
    name: string;
    title: string | null;
    type: string;
    created_at: string;
    metadata: string | null;
    status: EntityStatus;
    access_count: number;
    last_accessed_at: string | null;
    confidence: number;
    recall_hits: number;
    recall_misses: number;
    namespace: string;
};
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
export interface AnthropicResponse {
    content?: Array<{
        text?: string;
    }>;
}
export interface OpenAIResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
}
export interface OllamaResponse {
    response?: string;
}
//# sourceMappingURL=types.d.ts.map