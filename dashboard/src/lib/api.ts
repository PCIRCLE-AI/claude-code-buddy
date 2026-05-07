import { t } from './i18n';

const TIMEOUT = 10000;
const TOKEN_STORAGE_KEY = 'memesh_token';

/**
 * Auth-token plumbing for the dashboard SPA.
 *
 * The HTTP server protects `/v1/*` with bearer auth whenever a remote
 * bind is in play. Browsers cannot attach an Authorization header on a
 * top-level navigation to /dashboard, so the dashboard HTML is served
 * unauthenticated and the SPA injects the token on every API call from
 * `localStorage`. The user supplies the token once via the
 * `setApiToken` helper (called from the auth-prompt UI when a 401
 * surfaces); it then persists across reloads on the same origin.
 *
 * On a loopback-only deployment (the default), the server requires no
 * token at all, so `getApiToken()` returns null, no header is sent,
 * and the existing zero-config local UX is preserved.
 */
export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* private mode / disabled storage — fall through */
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super('auth_required');
    this.name = 'AuthRequiredError';
  }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getApiToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts: RequestInit = { method, headers, signal: controller.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (res.status === 401) {
      // Distinct error type so the UI can switch into the
      // enter-your-token flow rather than treating this as a generic
      // failure.
      throw new AuthRequiredError();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || t('errors.unknown'));
    return json.data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(t('errors.timeout'));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface Entity {
  id: number;
  name: string;
  type: string;
  created_at: string;
  observations: string[];
  tags: string[];
  relations?: { from: string; to: string; type: string }[];
  archived?: boolean;
  status?: string;
  access_count?: number;
  last_accessed_at?: string;
  confidence?: number;
  namespace?: string;
}

export interface HealthData {
  status: string;
  version: string;
  entity_count: number;
}

export interface UpdateStatusData {
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string | null;
  updateAvailable: boolean;
  checkSucceeded: boolean;
  source: 'fresh' | 'cache' | null;
  freshness: 'fresh' | 'cached' | 'stale' | 'unavailable';
  installChannel: 'npm-global' | 'npm-local' | 'source-checkout' | 'unknown';
  canSelfUpdate: boolean;
  recommendedCommand: string | null;
  /** True when npm has flagged the installed version as deprecated. */
  currentVersionDeprecated: boolean;
  /** Maintainer-supplied deprecation message, or null when not deprecated. */
  deprecationMessage: string | null;
}

export interface StatsData {
  totalEntities: number;
  totalObservations: number;
  totalRelations: number;
  totalTags: number;
  typeDistribution: { type: string; count: number }[];
  tagDistribution: { tag: string; count: number }[];
  statusDistribution: { status: string; count: number }[];
}

export interface LlmConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
}

export interface ConfigData {
  config: { llm?: LlmConfig; setupCompleted?: boolean; theme?: string; autoCapture?: boolean };
  capabilities: { searchLevel: number; llm?: LlmConfig; embeddings: string };
}

export interface HealthFactor {
  score: number;
  weight: number;
  detail: string;
}

export interface AnalyticsData {
  healthScore: number;
  healthFactors: {
    activity: HealthFactor;
    quality: HealthFactor;
    freshness: HealthFactor;
    lessons: HealthFactor;
  };
  timeline: Array<{ date: string; created: number; recalled: number }>;
  valueMetrics: {
    totalRecalls: number;
    lessonsWithWarnings: number;
    lessonCount: number;
    typeDistribution: Array<{ type: string; count: number }>;
  };
  recallEffectiveness: {
    overallHitRate: number;
    totalHits: number;
    totalMisses: number;
    trackedEntities: number;
    topEffective: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
    mostIgnored: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
  } | null;
  cleanup: {
    staleEntities: Array<{
      id: number; name: string; type: string; confidence: number; days_unused: number;
    }>;
    duplicateCandidates: Array<{ name1: string; name2: string; type: string }>;
  };
}

export interface PatternsData {
  workSchedule: {
    hourDistribution: Array<{ hour: number; count: number }>;
    dayDistribution: Array<{ day: string; dayNum: number; count: number }>;
  };
  toolPreferences: Array<{ tool: string; sessions: number }>;
  focusAreas: Array<{ type: string; count: number }>;
  workflow: { avgSessionMinutes: number; commitsPerSession: number; totalSessions: number; totalCommits: number };
  strengths: Array<{ type: string; avgConfidence: number; count: number }>;
  learningAreas: Array<{ tag: string; count: number }>;
}

export interface GraphData {
  entities: Entity[];
  relations: Array<{ from: string; to: string; type: string }>;
}

export async function fetchGraph(): Promise<GraphData> {
  return api<GraphData>('GET', '/v1/graph');
}

export async function fetchLessons(): Promise<Entity[]> {
  const result = await api<Entity[]>('GET', '/v1/entities?type=lesson_learned&limit=100');
  return Array.isArray(result) ? result : [];
}
