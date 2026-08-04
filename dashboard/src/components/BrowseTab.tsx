import { useState, useEffect, useMemo } from 'preact/hooks';
import { api, fetchProjects, type Entity, type ProjectInfo } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { ProjectRoadmap } from './ProjectRoadmap';
import { t } from '../lib/i18n';
import { clusterOf, timeBucket, extractProject, type TypeCluster, type TimeBucket } from '../lib/entity-display';
import { useSignalMode } from '../lib/signalMode';

const ROADMAP_PREF_KEY = 'memesh.browse.viewMode';

const PAGE_SIZE = 30;

type ClusterKey = TypeCluster | 'all';
type TimeKey = TimeBucket | 'all';
type ValueKey = 'all' | 'recalled' | 'never';
type SortKey = 'recent' | 'most-recalled' | 'created';

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}

function Chip({ label, active, onClick, count }: ChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 14,
        border: '1px solid',
        borderColor: active ? 'rgba(0, 214, 180, 0.5)' : 'rgba(255,255,255,0.08)',
        background: active ? 'rgba(0, 214, 180, 0.15)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-2)',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{ marginLeft: 6, opacity: 0.6, fontFamily: 'var(--mono)', fontSize: 10 }}>
          {count}
        </span>
      )}
    </button>
  );
}

export function BrowseTab({ manage }: { manage?: boolean }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  // Global Signal Mode — when ON, the cluster filter starts on
  // 'knowledge' and the noise types (commit / session_keypoint /
  // weekly-summary) are out of the default view. When OFF, the
  // cluster filter defaults to 'all'. Either way the user can still
  // override per-tab via the chip filter.
  const [signalMode] = useSignalMode();

  // Filter state — defaults tuned for "show me useful things"
  const [cluster, setCluster] = useState<ClusterKey>(signalMode ? 'knowledge' : 'all');
  const [time, setTime] = useState<TimeKey>('all');
  const [value, setValue] = useState<ValueKey>('all');
  const [project, setProject] = useState<string | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('most-recalled');
  // Roadmap view mode — opt-out per project. When a project chip is
  // active and this is true (default), render the ProjectRoadmap instead
  // of the flat list. localStorage persists the per-session override so
  // a user who explicitly switched to list view stays there.
  const [viewMode, setViewMode] = useState<'roadmap' | 'list'>(() => {
    try {
      const saved = localStorage.getItem(ROADMAP_PREF_KEY);
      return saved === 'list' ? 'list' : 'roadmap';
    } catch {
      return 'roadmap';
    }
  });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [data, projs] = await Promise.all([
        api<Entity[]>('GET', '/v1/entities?limit=2000&status=all'),
        fetchProjects().catch(() => []),
      ]);
      // `data || []` let a shape-less `{}` through — `for (const e of entities)`
      // then threw "entities is not iterable". Ask for the array, not for truthiness.
      setEntities(Array.isArray(data) ? data : []);
      setProjects(projs);
      setPage(0);
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(0); }, [filter, cluster, time, value, project, sort]);

  // When the global Signal Mode toggles, snap the cluster filter to
  // the natural default for that mode — but only if the user hasn't
  // already moved it somewhere meaningful within the same tab session.
  // The check `cluster === 'knowledge' || cluster === 'all'` lets a
  // user's deliberate choice (`activity`, `session`, `reference`)
  // survive a global toggle.
  useEffect(() => {
    if (cluster === 'knowledge' || cluster === 'all') {
      setCluster(signalMode ? 'knowledge' : 'all');
    }
  }, [signalMode]);

  // Cluster counts (over the unfiltered set so chip counts don't move with selection)
  const clusterCounts = useMemo(() => {
    const c: Record<ClusterKey, number> = { all: 0, knowledge: 0, activity: 0, reference: 0, session: 0 };
    for (const e of entities) {
      if (e.archived || e.status === 'archived') continue;
      c.all++;
      c[clusterOf(e.type)]++;
    }
    return c;
  }, [entities]);

  // Apply all filters
  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    return entities.filter((e) => {
      if (cluster !== 'all' && clusterOf(e.type) !== cluster) return false;
      if (time !== 'all' && timeBucket(e.last_accessed_at || e.created_at) !== time) return false;
      if (value === 'recalled' && (e.access_count ?? 0) === 0) return false;
      if (value === 'never' && (e.access_count ?? 0) > 0) return false;
      if (project !== 'all' && extractProject(e) !== project) return false;
      if (f) {
        const hay = [e.name, e.type, ...(e.observations ?? []), ...(e.tags ?? [])].join(' ').toLowerCase();
        if (!hay.includes(f)) return false;
      }
      return true;
    });
  }, [entities, cluster, time, value, project, filter]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === 'most-recalled') {
      arr.sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0)
        || (b.last_accessed_at ?? b.created_at).localeCompare(a.last_accessed_at ?? a.created_at));
    } else if (sort === 'created') {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else { // recent (last accessed)
      arr.sort((a, b) =>
        (b.last_accessed_at ?? b.created_at).localeCompare(a.last_accessed_at ?? a.created_at));
    }
    return arr;
  }, [filtered, sort]);

  const active = sorted.filter((e) => !e.archived && e.status !== 'archived');
  const archived = sorted.filter((e) => e.archived || e.status === 'archived');

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div class="card-title" style={{ margin: 0 }}>
              {manage ? t('browse.manage') : t('browse.title')}
            </div>
            {!loading && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                {active.length.toLocaleString()} {t('browse.active')}
                {archived.length > 0 ? ` · ${archived.length} ${t('browse.archived')}` : ''}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="search"
              placeholder={t('browse.filter')}
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              style={{ width: 240 }}
            />
            <button class="btn btn-sm" onClick={load} title={t('browse.refresh')}>↻</button>
          </div>
        </div>

        {/* Cluster chips — primary filter */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center', marginRight: 4 }}>{t('browse.filterCategory')}</span>
          <Chip label={t('cluster.knowledge')} active={cluster === 'knowledge'} onClick={() => setCluster('knowledge')} count={clusterCounts.knowledge} />
          <Chip label={t('cluster.activity')} active={cluster === 'activity'} onClick={() => setCluster('activity')} count={clusterCounts.activity} />
          <Chip label={t('cluster.session')} active={cluster === 'session'} onClick={() => setCluster('session')} count={clusterCounts.session} />
          <Chip label={t('cluster.reference')} active={cluster === 'reference'} onClick={() => setCluster('reference')} count={clusterCounts.reference} />
          <Chip label={t('cluster.all')} active={cluster === 'all'} onClick={() => setCluster('all')} count={clusterCounts.all} />
        </div>

        {/* Time + value + project chips — secondary */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center', marginRight: 4 }}>{t('browse.filterTime')}</span>
          <Chip label={t('browse.timeToday')} active={time === 'today'} onClick={() => setTime(time === 'today' ? 'all' : 'today')} />
          <Chip label={t('browse.timeWeek')} active={time === 'week'} onClick={() => setTime(time === 'week' ? 'all' : 'week')} />
          <Chip label={t('browse.timeMonth')} active={time === 'month'} onClick={() => setTime(time === 'month' ? 'all' : 'month')} />
          <Chip label={t('browse.timeOlder')} active={time === 'older'} onClick={() => setTime(time === 'older' ? 'all' : 'older')} />

          <span style={{ width: 1, background: 'var(--border-subtle)', margin: '0 6px' }} />

          <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center', marginRight: 4 }}>{t('browse.filterValue')}</span>
          <Chip label={t('browse.valueRecalled')} active={value === 'recalled'} onClick={() => setValue(value === 'recalled' ? 'all' : 'recalled')} />
          <Chip label={t('browse.valueNever')} active={value === 'never'} onClick={() => setValue(value === 'never' ? 'all' : 'never')} />
        </div>

        {projects.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center', marginRight: 4 }}>{t('browse.filterProject')}</span>
            <Chip label={t('cluster.all')} active={project === 'all'} onClick={() => setProject('all')} />
            {projects.map((p) => (
              <Chip
                key={p.name}
                label={p.name}
                count={p.count}
                active={project === p.name}
                onClick={() => setProject(p.name)}
              />
            ))}
          </div>
        )}

        {/* Sort dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('browse.filterSort')}</span>
          <select
            value={sort}
            onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)}
            style={{ padding: '3px 8px', fontSize: 12 }}
          >
            <option value="most-recalled">{t('browse.sortMostRecalled')}</option>
            <option value="recent">{t('browse.sortRecent')}</option>
            <option value="created">{t('browse.sortCreated')}</option>
          </select>
        </div>

        {error && <div class="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        {loading && <div class="empty"><div class="loading" /></div>}

        {/* Roadmap view: triggered when a project chip is selected and the
            user hasn't opted into list view. Bypasses pagination because
            the roadmap is intended as a single scrollable narrative. */}
        {!loading && project !== 'all' && viewMode === 'roadmap' && !manage && (
          <ProjectRoadmap
            projectName={project}
            entities={active}
            onSwitchToList={() => {
              setViewMode('list');
              try { localStorage.setItem(ROADMAP_PREF_KEY, 'list'); } catch { /* private mode */ }
            }}
          />
        )}

        {/* List view: shown when no project filter, or when user opted out
            of roadmap, or in manage mode. */}
        {!loading && (project === 'all' || viewMode === 'list' || manage) && active.length === 0 && (
          <div class="empty">
            <span class="empty-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
              {/* Inbox / empty mailbox glyph */}
              <svg width="32" height="32" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 9 L4 4 H12 L14 9 V13 H2 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M2 9 H6 a2 2 0 0 0 4 0 H14" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </span>
            {filter ? `${t('browse.noMatch')} "${filter}"` : t('browse.emptyFilter')}
          </div>
        )}

        {!loading && (project === 'all' || viewMode === 'list' || manage) && pageItems.length > 0 && (
          <div>
            {project !== 'all' && viewMode === 'list' && !manage && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button
                  class="btn btn-sm"
                  onClick={() => {
                    setViewMode('roadmap');
                    try { localStorage.setItem(ROADMAP_PREF_KEY, 'roadmap'); } catch { /* private mode */ }
                  }}
                >
                  {t('roadmap.switchToRoadmap')}
                </button>
              </div>
            )}
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

        {!loading && archived.length > 0 && manage && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              {t('browse.archived')} ({archived.length})
            </div>
            {archived.slice(0, 10).map((e) => (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '14px 0' }}>
                <MemoryRow
                  entity={e}
                  highlight={filter}
                  actions={<button class="btn btn-sm" onClick={() => handleRestore(e.name)}>{t('browse.restore')}</button>}
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
