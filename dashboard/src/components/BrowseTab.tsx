import { useState, useEffect } from 'preact/hooks';
import { api, type Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { t } from '../lib/i18n';

const PAGE_SIZE = 30;

export function BrowseTab({ manage }: { manage?: boolean }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api<Entity[]>('GET', '/v1/entities?limit=500&status=all');
      setEntities(data || []);
      setPage(0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Reset page when filter changes
  useEffect(() => { setPage(0); }, [filter]);

  const f = filter.toLowerCase();
  const filtered = entities.filter((e) => {
    if (!f) return true;
    return (
      e.name.toLowerCase().includes(f) ||
      e.type.toLowerCase().includes(f) ||
      e.observations?.some((o) => o.toLowerCase().includes(f)) ||
      e.tags?.some((tg) => tg.toLowerCase().includes(f))
    );
  });

  const active = filtered.filter((e) => !e.archived && e.status !== 'archived');
  const archived = filtered.filter((e) => e.archived || e.status === 'archived');

  // Paginate active items
  const totalPages = Math.ceil(active.length / PAGE_SIZE);
  const pageItems = active.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function handleArchive(name: string) {
    if (!confirm(t('browse.confirmArchive'))) return;
    try {
      await api('POST', '/v1/forget', { name });
      load();
    } catch (e: any) {
      setError(t('browse.archiveFailed', { message: e.message }));
    }
  }

  async function handleRestore(name: string) {
    try {
      await api('POST', '/v1/remember', { name, type: 'restored' });
      load();
    } catch (e: any) {
      setError(t('browse.restoreFailed', { message: e.message }));
    }
  }

  return (
    <div>
      <div class="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div class="card-title" style={{ margin: 0 }}>
              {manage ? t('browse.manage') : t('browse.title')}
            </div>
            {!loading && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                {active.length.toLocaleString()} {t('browse.active')}{archived.length > 0 ? ` · ${archived.length} ${t('browse.archived')}` : ''}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="search"
              placeholder={t('browse.filter')}
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              style={{ width: 260 }}
            />
            <button class="btn btn-sm" onClick={load} title={t('browse.refresh')}>↻</button>
          </div>
        </div>

        {error && <div class="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        {loading && <div class="empty"><div class="loading" /></div>}

        {!loading && filtered.length === 0 && (
          <div class="empty">
            <span class="empty-icon">📭</span>
            {filter ? `${t('browse.noMatch')} "${filter}"` : t('browse.noMemories')}
          </div>
        )}

        {!loading && pageItems.length > 0 && (
          <div>
            {pageItems.map((e) => (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '14px 0' }}>
                <MemoryRow
                  entity={e}
                  highlight={filter}
                  actions={manage ? (
                    <button class="btn btn-danger btn-sm" onClick={() => handleArchive(e.name)}>{t('browse.archive')}</button>
                  ) : undefined}
                />
              </div>
            ))}

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: '16px 0', fontSize: 13 }}>
                <button class="btn btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('browse.prev')}</button>
                <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  {page + 1} / {totalPages}
                </span>
                <button class="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>{t('browse.next')}</button>
              </div>
            )}
          </div>
        )}

        {!loading && archived.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              {t('browse.archived')} ({archived.length})
            </div>
            {archived.slice(0, 10).map((e) => (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '14px 0' }}>
                <MemoryRow
                  entity={e}
                  highlight={filter}
                  actions={manage ? (
                    <button class="btn btn-sm" onClick={() => handleRestore(e.name)}>{t('browse.restore')}</button>
                  ) : undefined}
                />
              </div>
            ))}
            {archived.length > 10 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '12px 0', textAlign: 'center' }}>
                +{archived.length - 10} {t('browse.moreArchived')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
