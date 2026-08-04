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

/**
 * The server ANSWERED — with an error status. It is running; the user must
 * not be sent to check `memesh serve`. Kept distinct from transport-level
 * failures so the dashboard can say which of the two happened.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * The request itself failed — no response at all. A fetch network failure
 * surfaces as a TypeError and a timeout as an abort; both mean "could not
 * reach the server", which is a different user instruction from any error
 * the server sent back.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
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
      // failure — and a window event, because the component whose fetch
      // hit the 401 catches its own errors: without this, a token that
      // expires mid-session surfaced as that one tab's "failed to load"
      // while every other tab kept a stale token. The App listens and
      // swaps in the auth prompt no matter whose request tripped it.
      window.dispatchEvent(new Event('memesh:auth-required'));
      throw new AuthRequiredError();
    }
    if (!res.ok) throw new HttpError(res.status);
    const json = await res.json();
    if (!json.success) {
      // Server error envelopes carry a stable machine `errorCode` next to
      // the English `error` prose (see API_REFERENCE → "Stable error
      // codes"). Prefer the translated message for a KNOWN code; fall back
      // to the raw server prose for unknown codes. Miss-detection is the
      // sanctioned `translated === key` check — t() returns the key itself
      // for uncatalogued keys, and `|| fallback` would hide a real (but
      // empty) translation the same way it hides absence.
      if (typeof json.errorCode === 'string' && json.errorCode) {
        const key = `httpError.${json.errorCode}`;
        const translated = t(key);
        if (translated !== key) throw new Error(translated);
      }
      throw new Error(json.error || t('errors.unknown'));
    }
    return json.data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new NetworkError(t('errors.timeout'));
    // fetch signals a network-level failure as a TypeError; rewrap so
    // callers can tell "no response" from "the server answered badly"
    // without string-matching messages.
    if (err instanceof TypeError) throw new NetworkError(err.message);
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
  metadata?: Record<string, unknown> | null;
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

export type AutoUpdatePolicy = 'off' | 'patch' | 'minor' | 'major';

export interface ConfigData {
  config: {
    llm?: LlmConfig;
    setupCompleted?: boolean;
    autoCapture?: boolean;
    /** Auto-update policy. Mirrors MEMESH_AUTO_UPDATE env var with env > config precedence. */
    autoUpdate?: AutoUpdatePolicy;
    /** Opt-in for the experimental agentic-orchestration protocol. */
    enableAgenticOrchestration?: boolean;
    /**
     * Output language for LLM-generated content (dreamer digests, patterns,
     * lessons). Free-form — the Settings language selector posts the locale's
     * display name so generated memories follow the UI language.
     */
    language?: string;
  };
  capabilities: { searchLevel: number; llm?: LlmConfig; embeddings: string };
}

export interface ConfigTestResult {
  valid: boolean;
  error?: string;
  /**
   * Stable machine code when valid=false: 'auth' | 'network' | 'no_models'
   * | 'bad_host' | 'http_<status>' | 'unknown'. The dashboard translates
   * known codes (settings.testError.*) and keeps `error` as the detail.
   */
  errorCode?: string;
  models?: Array<{ id: string; created?: string }>;
  suggested?: string;
}

export interface HealthFactor {
  score: number;
  weight: number;
  detail: string;
}

export interface LoopMetric {
  reusedThisWeek: number;
  trend: Array<{ date: string; count: number }>;
  computedFrom: 'recall_hits' | 'last_accessed_at_approximation';
}

export interface AnalyticsData {
  healthScore: number;
  healthFactors: {
    activity: HealthFactor;
    quality: HealthFactor;
    freshness: HealthFactor;
    lessons: HealthFactor;
  };
  loopMetric: LoopMetric;
  timeline: Array<{ date: string; created: number; recalled: number }>;
  ageMatrix: Array<{ type: string; bucket: 'week' | 'month' | 'quarter' | 'older'; count: number }>;
  knowledgeRadar: Array<{ axis: string; count: number; types: string[] }>;
}

export interface PatternsData {
  workSchedule: {
    hourDistribution: Array<{ hour: number; count: number }>;
    // dayNum: SQLite strftime %w — 0 = Sunday … 6 = Saturday. Weekday
    // names are rendered client-side via the patterns.day.<n> catalogue keys.
    dayDistribution: Array<{ dayNum: number; count: number }>;
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
  /** Noise type names the server marks as low-priority. Clients default-hide these. */
  noiseTypes: string[];
}

export interface ProjectInfo {
  name: string;
  count: number;
  types: string[];
  source: 'tag' | 'heuristic' | 'mixed';
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const data = await api<ProjectInfo[]>('GET', '/v1/projects');
  return Array.isArray(data) ? data : [];
}

export async function fetchGraph(): Promise<GraphData> {
  return api<GraphData>('GET', '/v1/graph');
}

export async function fetchLessons(): Promise<Entity[]> {
  const result = await api<Entity[]>('GET', '/v1/entities?type=lesson_learned&limit=100');
  return Array.isArray(result) ? result : [];
}
