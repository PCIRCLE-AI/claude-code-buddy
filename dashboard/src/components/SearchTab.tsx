import { useState } from 'preact/hooks';
import { api, type Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { t } from '../lib/i18n';

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
        <div class="card-title">{t('search.title')}</div>
        <div class="search-bar">
          <input
            type="search"
            placeholder={t('search.placeholder')}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button class="btn btn-primary" onClick={search} disabled={loading}>
            {loading ? t('search.searching') : t('search.button')}
          </button>
        </div>

        {!loading && results === null && !error && (
          <div class="empty" style={{ padding: '32px 20px', color: 'var(--text-3)' }}>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              {t('search.hint')}
            </div>
          </div>
        )}

        {error && <div class="error-box">{error}</div>}

        {loading && <div class="empty"><div class="loading" /></div>}

        {!loading && results !== null && results.length === 0 && (
          <div class="empty">
            <span class="empty-icon">🔍</span>
            {t('search.noResults')} "{query}"
          </div>
        )}

        {!loading && results && results.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
              {results.length} {results.length !== 1 ? t('search.results') : t('search.result')}
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
