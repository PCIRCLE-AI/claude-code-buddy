const TIMEOUT = 10000;

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Unknown error');
    return json.data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
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

export interface StatsData {
  totalEntities: number;
  totalObservations: number;
  totalRelations: number;
  totalTags: number;
  typeDistribution: { type: string; count: number }[];
  tagDistribution: { tag: string; count: number }[];
  statusDistribution: { status: string; count: number }[];
}

export interface ConfigData {
  config: { llm?: { provider: string; model?: string; apiKey?: string }; setupCompleted?: boolean; theme?: string; autoCapture?: boolean };
  capabilities: { searchLevel: number; llm: any; embeddings: string };
}

export interface GraphData {
  entities: Entity[];
  relations: Array<{ from: string; to: string; type: string }>;
}

export async function fetchGraph(): Promise<GraphData> {
  return api<GraphData>('GET', '/v1/graph');
}

export async function fetchLessons(): Promise<Entity[]> {
  const result = await api<Entity[] | { entities: Entity[] }>('POST', '/v1/recall', { limit: 100 });
  const entities = Array.isArray(result) ? result : (result as any).entities || [];
  return entities.filter((e: Entity) => e.type === 'lesson_learned');
}
