import { useState, useEffect } from 'preact/hooks';
import { api, type Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';

export function BrowseTab({ manage }: { manage?: boolean }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api<Entity[]>('GET', '/v1/entities?limit=200&status=all');
      setEntities(data || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const f = filter.toLowerCase();
  const filtered = entities.filter((e) => {
    if (!f) return true;
    return (
      e.name.toLowerCase().includes(f) ||
      e.type.toLowerCase().includes(f) ||
      e.observations?.some((o) => o.toLowerCase().includes(f)) ||
      e.tags?.some((t) => t.toLowerCase().includes(f))
    );
  });

  const active = filtered.filter((e) => !e.archived && e.status !== 'archived');
  const archived = filtered.filter((e) => e.archived || e.status === 'archived');

  async function handleArchive(name: string) {
    if (!confirm(`Archive "${name}"?`)) return;
    try {
      await api('POST', '/v1/forget', { name });
      load();
    } catch (e: any) {
      alert('Error: ' + e.message);
    }
  }

  async function handleRestore(name: string) {
    try {
      await api('POST', '/v1/remember', { name, type: 'restored' });
      load();
    } catch (e: any) {
      alert('Error: ' + e.message);
    }
  }

  return (
    <div>
      <div class="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div class="card-title" style={{ margin: 0 }}>
            {manage ? 'Manage Memories' : 'All Memories'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="search"
              placeholder="Filter…"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              style={{ width: 220 }}
            />
            <button class="btn btn-sm" onClick={load}>↻ Refresh</button>
          </div>
        </div>

        {error && <div class="error-box">{error}</div>}
        {loading && <div class="empty"><div class="loading" /></div>}

        {!loading && filtered.length === 0 && (
          <div class="empty">
            <span class="empty-icon">📭</span>
            {filter ? `No memories matching "${filter}"` : 'No memories yet'}
          </div>
        )}

        {!loading && active.length > 0 && (
          <div>
            {active.map((e) => (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '12px 0' }}>
                <MemoryRow
                  entity={e}
                  highlight={filter}
                  actions={manage ? (
                    <button class="btn btn-danger btn-sm" onClick={() => handleArchive(e.name)}>Archive</button>
                  ) : undefined}
                />
              </div>
            ))}
          </div>
        )}

        {!loading && archived.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
              Archived ({archived.length})
            </div>
            {archived.map((e) => (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '12px 0' }}>
                <MemoryRow
                  entity={e}
                  highlight={filter}
                  actions={manage ? (
                    <button class="btn btn-sm" onClick={() => handleRestore(e.name)}>Restore</button>
                  ) : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
