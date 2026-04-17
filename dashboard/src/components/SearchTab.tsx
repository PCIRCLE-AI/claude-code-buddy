import { useState } from 'preact/hooks';
import { api, type Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';

export function SearchTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function search() {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api('POST', '/v1/recall', { query: query.trim(), limit: 30 });
      const entities = Array.isArray(data) ? data : data.entities || [];
      setResults(entities);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div class="card">
        <div class="card-title">Search Memories</div>
        <div class="search-bar">
          <input
            type="search"
            placeholder='Search your memories… (e.g., "auth", "database", "bug fix")'
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button class="btn btn-primary" onClick={search} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {error && <div class="error-box">{error}</div>}

        {loading && <div class="empty"><div class="loading" /></div>}

        {!loading && results !== null && results.length === 0 && (
          <div class="empty">
            <span class="empty-icon">🔍</span>
            No results for "{query}"
          </div>
        )}

        {!loading && results && results.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
              {results.length} result{results.length !== 1 ? 's' : ''}
            </div>
            {results.map((e) => (
              <div key={e.id} class="card" style={{ padding: 14 }}>
                <MemoryRow entity={e} highlight={query} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
