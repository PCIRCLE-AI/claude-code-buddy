import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, fetchProjects, type Entity, type HealthData, type ProjectInfo } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { EmptyLibraryState } from './EmptyLibraryState';
import { Chip } from './Chip';
import { ExpandedBody, SeverityBadge } from './LessonCards';
import { t, getLocale } from '../lib/i18n';
import { actionFailureMessage, classifyLoadError, failureMessage } from '../lib/failure';
import { clusterOf, timeBucket, extractProject, CLUSTER_DOT, type TypeCluster, type TimeBucket } from '../lib/entity-display';
import { useSignalMode } from '../lib/signalMode';
import { layerOf } from '../../../src/core/work-topology.js';

const PAGE_SIZE = 30;

/** What load() asks /v1/entities for. At exactly this count the list is
 *  (almost certainly) truncated and the header must say so instead of
 *  letting "N active" silently contradict the header's entity_count. */
const FETCH_LIMIT = 2000;

/** What a deep search asks /v1/recall for — server-ranked, so no paging. */
const RECALL_LIMIT = 30;

/**
 * The single "which subset am I looking at" axis. Layer scopes come from
 * `WORK_LAYER_TYPES` via `layerOf()` — the SAME whitelist the graph and the
 * session-start injection use, per the work-topology plan. Cluster scopes
 * come from the composition legend. Archived is its own shelf. The three
 * kinds are mutually exclusive on purpose: layer chips and cluster legend
 * both answer "which subset", and two simultaneous answers would be a
 * filter nobody can predict.
 */
type Scope =
  | { kind: 'layer'; v: 'work' | 'evidence' | 'all' }
  | { kind: 'cluster'; v: TypeCluster }
  | { kind: 'archived' };

type TimeKey = TimeBucket | 'all';
type ValueKey = 'all' | 'recalled' | 'never';
type SortKey = 'recent' | 'most-recalled' | 'created';

const CLUSTERS: TypeCluster[] = ['knowledge', 'activity', 'session', 'reference'];

function isArchivedEntity(e: Entity): boolean {
  return Boolean(e.archived) || e.status === 'archived';
}

export function MemoriesTab({ health }: { health?: HealthData | null }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  // Global Signal Mode — ON scopes the default view to the work layer
  // (goals/decisions/lessons/plans — the signal); OFF starts on everything.
  // Either way the user can still move per-tab via the chips.
  const [signalMode] = useSignalMode();
  const [scope, setScopeRaw] = useState<Scope>({ kind: 'layer', v: signalMode ? 'work' : 'all' });

  const [time, setTime] = useState<TimeKey>('all');
  const [value, setValue] = useState<ValueKey>('all');
  const [project, setProject] = useState<string | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('most-recalled');

  // Deep search (server-ranked /v1/recall). Non-null results replace the
  // browsing list until the user types again, clears, or picks a chip —
  // any of those reads as "back to browsing".
  const [recallResults, setRecallResults] = useState<Entity[] | null>(null);
  const [recallLoading, setRecallLoading] = useState(false);

  // Expanded rows (the universal detail view), by entity id.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());

  // Monotonic ticket per load(): it is called from mount, the refresh
  // button, and after archive/restore, and two overlapping runs otherwise
  // race on setEntities/setError — whichever RESOLVES last wins, which is
  // not necessarily the one the user asked for last.
  const loadGen = useRef(0);

  async function load() {
    const gen = ++loadGen.current;
    setLoading(true);
    setError('');
    try {
      const [data, projs] = await Promise.all([
        api<Entity[]>('GET', `/v1/entities?limit=${FETCH_LIMIT}&status=all`),
        fetchProjects().catch(() => []),
      ]);
      // A payload that is NOT the array must not dress up as an empty
      // library: "0 memories" from a response nobody could read is a false
      // empty.
      if (gen !== loadGen.current) return;
      if (!Array.isArray(data)) {
        console.warn('[memesh dashboard] /v1/entities answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
        setEntities([]);
        setError(failureMessage('unreadable'));
      } else {
        setEntities(data);
      }
      setProjects(projs);
      setPage(0);
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      if (gen !== loadGen.current) return;
      console.warn('[memesh dashboard] /v1/entities failed to load:', e);
      setError(failureMessage(classifyLoadError(e)));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(0); }, [filter, scope, time, value, project, sort]);

  // Picking any chip is a browsing intent — leave ranked-results mode.
  function setScope(next: Scope) {
    setScopeRaw(next);
    setRecallResults(null);
  }

  // When the global Signal Mode toggles, snap the scope to that mode's
  // natural default — but only if the user hasn't already moved it
  // somewhere deliberate (evidence, a cluster, archived).
  useEffect(() => {
    setScopeRaw((prev) => {
      if (prev.kind === 'layer' && (prev.v === 'work' || prev.v === 'all')) {
        return { kind: 'layer', v: signalMode ? 'work' : 'all' };
      }
      return prev;
    });
  }, [signalMode]);

  const active = useMemo(() => entities.filter((e) => !isArchivedEntity(e)), [entities]);
  const archivedAll = useMemo(() => entities.filter(isArchivedEntity), [entities]);

  // Counts over the unfiltered sets so chip counts don't move with selection.
  const layerCounts = useMemo(() => {
    const c = { work: 0, evidence: 0 };
    for (const e of active) {
      const l = layerOf(e.type);
      if (l === 'work') c.work++;
      else if (l === 'evidence') c.evidence++;
    }
    return c;
  }, [active]);

  const clusterCounts = useMemo(() => {
    const c: Record<TypeCluster, number> = { knowledge: 0, activity: 0, session: 0, reference: 0 };
    for (const e of active) c[clusterOf(e.type)]++;
    return c;
  }, [active]);

  function matchesScope(e: Entity): boolean {
    if (scope.kind === 'archived') return isArchivedEntity(e);
    if (isArchivedEntity(e)) return false;
    if (scope.kind === 'cluster') return clusterOf(e.type) === scope.v;
    if (scope.v === 'all') return true;
    return layerOf(e.type) === scope.v;
  }

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    return entities.filter((e) => {
      if (!matchesScope(e)) return false;
      if (time !== 'all' && timeBucket(e.last_accessed_at || e.created_at) !== time) return false;
      if (value === 'recalled' && (e.access_count ?? 0) === 0) return false;
      if (value === 'never' && (e.access_count ?? 0) > 0) return false;
      if (project !== 'all' && extractProject(e) !== project) return false;
      if (f) {
        const hay = [e.name, e.title ?? '', e.type, ...(e.observations ?? []), ...(e.tags ?? [])].join(' ').toLowerCase();
        if (!hay.includes(f)) return false;
      }
      return true;
    });
  }, [entities, scope, time, value, project, filter]);

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

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageItems = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  async function runDeepSearch() {
    const query = filter.trim();
    if (!query) return;
    setRecallLoading(true);
    setError('');
    try {
      // `/v1/recall` answers with `{ entities, conflicts }` (or a bare
      // array from older servers) — server-ranked, so the results keep
      // their order and skip the client sort entirely.
      const data = await api<Entity[] | { entities?: Entity[] }>(
        'POST', '/v1/recall', { query, limit: RECALL_LIMIT }
      );
      // `data.entities || []` here turned an unreadable payload into a
      // successful search that found nothing — the same masquerade the load()
      // path above refuses by name ("a false empty"). Ranked search reads as
      // "no memory matches that", which is a claim, not an absence of data.
      const ranked = Array.isArray(data) ? data : data.entities;
      if (!Array.isArray(ranked)) {
        console.warn('[memesh dashboard] /v1/recall answered with a shape this bundle cannot read:', data);
        setError(failureMessage('unreadable'));
        return;
      }
      setRecallResults(ranked);
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      setRecallLoading(false);
    }
  }

  async function handleArchive(name: string) {
    if (!confirm(t('browse.confirmArchive'))) return;
    try {
      await api('POST', '/v1/forget', { name });
      load();
    } catch (e) {
      setError(t('browse.archiveFailed', { message: actionFailureMessage(e) }));
    }
  }

  async function handleRestore(name: string) {
    try {
      await api('POST', '/v1/remember', { name, type: 'restored' });
      load();
    } catch (e) {
      setError(t('browse.restoreFailed', { message: actionFailureMessage(e) }));
    }
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function renderRow(e: Entity, highlight: string) {
    const isOpen = expanded.has(e.id);
    const archived = isArchivedEntity(e);
    return (
      <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '12px 0' }}>
        <MemoryRow
          entity={e}
          highlight={highlight}
          actions={(
            <>
              <SeverityBadge entity={e} />
              <button
                class="btn btn-sm"
                style={{ padding: '6px 8px', minHeight: 28 }}
                aria-expanded={isOpen}
                aria-controls={`mem-detail-${e.id}`}
                aria-label={t(isOpen ? 'memories.collapse' : 'memories.expand')}
                onClick={() => toggleExpanded(e.id)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }}>
                  <path d="M6 4 L10 8 L6 12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {archived
                ? <button class="btn btn-sm" onClick={() => handleRestore(e.name)}>{t('browse.restore')}</button>
                : <button class="btn btn-danger btn-sm" onClick={() => handleArchive(e.name)}>{t('browse.archive')}</button>}
            </>
          )}
        />
        {/* Lazy body — rendered on first expand (DESIGN.md expander pattern). */}
        {isOpen && <div id={`mem-detail-${e.id}`}><ExpandedBody entity={e} /></div>}
      </div>
    );
  }

  const narrowed = filter !== '' || time !== 'all' || value !== 'all' || project !== 'all';
  const inRecallMode = recallResults !== null;
  const activeTotal = active.length;

  return (
    <div>
      <div class="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div class="card-title" style={{ margin: 0 }}>{t('browse.title')}</div>
            {!loading && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                <span style={{ fontFamily: 'var(--mono)' }}>{activeTotal.toLocaleString(getLocale())}</span> {t('browse.active')}
                {archivedAll.length > 0 ? <> · <span style={{ fontFamily: 'var(--mono)' }}>{archivedAll.length}</span> {t('browse.archived')}</> : ''}
                {/* The header (via /v1/health) shows the true count; this tab
                    holds at most FETCH_LIMIT rows. When the two disagree, say
                    so — two contradicting numbers with no explanation read as
                    data loss. */}
                {entities.length >= FETCH_LIMIT
                  && (health?.entity_count ?? 0) > entities.length && (
                  <span> · {t('browse.truncated', {
                    shown: entities.length.toLocaleString(getLocale()),
                    total: (health!.entity_count).toLocaleString(getLocale()),
                  })}</span>
                )}
              </div>
            )}
          </div>
          <button class="btn btn-sm" onClick={load} title={t('browse.refresh')}>↻</button>
        </div>

        {/* One search box, two truths: typing filters the loaded window
            instantly (free, no writes); Enter / the button runs the ranked
            server search (/v1/recall — which counts as a real recall). */}
        <div class="search-bar" style={{ marginBottom: 10 }}>
          <input
            type="search"
            placeholder={t('memories.searchPlaceholder')}
            value={filter}
            onInput={(e) => { setFilter((e.target as HTMLInputElement).value); setRecallResults(null); }}
            onKeyDown={(e) => e.key === 'Enter' && runDeepSearch()}
          />
          <button class="btn" onClick={runDeepSearch} disabled={recallLoading || !filter.trim()}>
            {recallLoading ? t('search.searching') : t('search.button')}
          </button>
        </div>

        {/* Scope chips — the work-topology axis, plus the archived shelf. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 4 }}>{t('memories.scopeLabel')}</span>
          <Chip label={t('memories.scopeWork')} active={scope.kind === 'layer' && scope.v === 'work'} onClick={() => setScope({ kind: 'layer', v: 'work' })} count={layerCounts.work} />
          <Chip label={t('memories.scopeEvidence')} active={scope.kind === 'layer' && scope.v === 'evidence'} onClick={() => setScope({ kind: 'layer', v: 'evidence' })} count={layerCounts.evidence} />
          <Chip label={t('memories.scopeAll')} active={scope.kind === 'layer' && scope.v === 'all'} onClick={() => setScope({ kind: 'layer', v: 'all' })} count={activeTotal} />
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-subtle)', margin: '0 6px' }} />
          <Chip label={t('memories.scopeArchived')} active={scope.kind === 'archived'} onClick={() => setScope({ kind: 'archived' })} count={archivedAll.length} />
        </div>

        {/* Composition — what this brain is made of, by cluster. The bar is
            decorative-but-informative; the legend chips are the interactive,
            keyboard-reachable targets (DESIGN.md composition-bar pattern). */}
        {activeTotal > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div aria-hidden="true" style={{ display: 'flex', height: 6, borderRadius: 'var(--radius-hairline)', overflow: 'hidden', background: 'var(--bg-0)', marginBottom: 6 }}>
              {CLUSTERS.map((c) => clusterCounts[c] > 0 && (
                <span key={c} style={{ flex: clusterCounts[c], background: CLUSTER_DOT[c] }} />
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 4 }}>{t('memories.composition')}</span>
              {CLUSTERS.map((c) => (
                <Chip
                  key={c}
                  label={t(`cluster.${c}`)}
                  dot={CLUSTER_DOT[c]}
                  count={clusterCounts[c]}
                  active={scope.kind === 'cluster' && scope.v === c}
                  onClick={() => setScope(scope.kind === 'cluster' && scope.v === c ? { kind: 'layer', v: 'all' } : { kind: 'cluster', v: c })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Time + value chips — secondary */}
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

        {error && <div class="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        {(loading || recallLoading) && <div class="empty"><div class="loading" /></div>}

        {/* Ranked results — server order, no client sort, no paging. */}
        {!loading && !recallLoading && inRecallMode && (
          <div>
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
              <span>
                <span style={{ fontFamily: 'var(--mono)' }}>{recallResults!.length}</span>{' '}
                {recallResults!.length !== 1 ? t('search.results') : t('search.result')} · {t('memories.rankedBy')}
              </span>
              <button class="btn btn-sm" onClick={() => setRecallResults(null)}>✕ {t('memories.backToList')}</button>
            </div>
            {recallResults!.length === 0
              ? <div class="empty" role="status">{t('search.noResults')} "{filter}"</div>
              : recallResults!.map((e) => renderRow(e, filter))}
          </div>
        )}

        {/* Browsing list. Two different empties, two different truths: an
            empty DATABASE must not say "try a different filter" — this is
            the demo's durable second entry point. Gated on !error so an
            unreadable payload never masquerades as a fresh install. */}
        {!loading && !recallLoading && !inRecallMode && (
          entities.length === 0 ? (!error && <EmptyLibraryState />) : sorted.length === 0 ? (
            <div class="empty">
              {scope.kind === 'layer' && scope.v === 'work' && !narrowed ? (
                // The work layer is EXPECTED to be sparse early on (measured
                // 15.9% of a mature graph; zero rows of goal/plan/task-state
                // before the writers ship) — so its empty state guides
                // instead of apologising.
                <>
                  <div style={{ marginBottom: 10 }}>{t('memories.workEmpty')}</div>
                  <Chip label={t('memories.showAll')} active={false} onClick={() => setScope({ kind: 'layer', v: 'all' })} />
                </>
              ) : filter ? (
                <>{t('browse.noMatch')} "{filter}"</>
              ) : (
                <>{t('browse.emptyFilter')}</>
              )}
            </div>
          ) : (
            <div>
              {pageItems.map((e) => renderRow(e, filter))}
              {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: '16px 0', fontSize: 13 }}>
                  <button class="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t('browse.prev')}</button>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {page + 1} / {totalPages}
                  </span>
                  <button class="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t('browse.next')}</button>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
