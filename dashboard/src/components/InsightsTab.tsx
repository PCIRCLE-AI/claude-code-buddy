import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

// Insights tab — surfaces what memesh has automatically generated for
// the user (LLM-driven dreamer + pattern detector output) and routes
// the propose / accept / reject lifecycle through the dashboard
// instead of the CLI-only `memesh dream list`. The backend endpoints
// (GET /v1/dream/proposals[/:id], POST .../accept, POST .../reject)
// landed in commit 883abd4d.

type ProposalStatus = 'pending' | 'applied' | 'rejected';

interface ProposalSummary {
  id: number;
  project: string;
  cluster_key: string;
  source_count: number;
  digest_name: string;
  digest_observations_preview: string;
  status: ProposalStatus;
  created_at: string;
}

interface ProposalDetail {
  id: number;
  project: string;
  cluster_key: string;
  proposed_digest: {
    name: string;
    type: string;
    observations: string[];
    tags: string[];
  } | null;
  source_ids: number[];
  llm_model: string | null;
  prompt_version: string;
  status: ProposalStatus;
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const ts = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = (Date.now() - ts) / 1000;
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function InsightsTab() {
  // Fetch ALL proposals once and filter client-side. The hero stat
  // row needs cross-status counts, so a server-side filter would
  // require a second round-trip per render. The proposal list is
  // small (single-digit to low double-digit per project per week)
  // so client-side filtering is cheap.
  const [allProposals, setAllProposals] = useState<ProposalSummary[]>([]);
  const [filter, setFilter] = useState<'pending' | 'applied' | 'rejected' | 'all'>('pending');
  const [expanded, setExpanded] = useState<Map<number, ProposalDetail>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api<ProposalSummary[]>('GET', `/v1/dream/proposals?status=all`);
      const list = Array.isArray(data) ? data : (data as { data?: ProposalSummary[] })?.data ?? [];
      setAllProposals(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const proposals = filter === 'all' ? allProposals : allProposals.filter(p => p.status === filter);

  const expand = useCallback(async (id: number) => {
    if (expanded.has(id)) {
      const next = new Map(expanded);
      next.delete(id);
      setExpanded(next);
      return;
    }
    try {
      const detail = await api<ProposalDetail>('GET', `/v1/dream/proposals/${id}`);
      const next = new Map(expanded);
      next.set(id, detail);
      setExpanded(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [expanded]);

  const accept = useCallback(async (id: number) => {
    setBusyId(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/accept`);
      window.dispatchEvent(new Event('memesh:data-changed'));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const reject = useCallback(async (id: number) => {
    setBusyId(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/reject`, { reason: 'rejected via dashboard' });
      window.dispatchEvent(new Event('memesh:data-changed'));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const pendingCount = allProposals.filter(p => p.status === 'pending').length;
  const appliedCount = allProposals.filter(p => p.status === 'applied').length;
  const rejectedCount = allProposals.filter(p => p.status === 'rejected').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Hero — what memesh did for you */}
      <div class="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('insights.title')}</h2>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{t('insights.subtitle')}</span>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-2)', fontSize: 13 }}>
          <span><strong style={{ color: 'var(--accent)' }}>{pendingCount}</strong> {t('insights.statPending')}</span>
          <span><strong>{appliedCount}</strong> {t('insights.statApplied')}</span>
          <span><strong>{rejectedCount}</strong> {t('insights.statRejected')}</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['pending', 'applied', 'rejected', 'all'] as const).map(f => (
          <button
            key={f}
            class={`tag ${filter === f ? '' : ''}`}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              border: '1px solid ' + (filter === f ? 'var(--accent)' : 'var(--border)'),
              background: filter === f ? 'rgba(0,214,180,0.12)' : 'transparent',
              color: filter === f ? 'var(--accent)' : 'var(--text-2)',
            }}
            onClick={() => setFilter(f)}
          >
            {t(`insights.filter.${f}`)}
          </button>
        ))}
        <button class="btn btn-ghost" onClick={refresh} style={{ marginLeft: 'auto' }}>{t('insights.refresh')}</button>
      </div>

      {error && <div class="card" style={{ padding: 12, color: 'var(--danger)' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('insights.loading')}</div>}
      {!loading && proposals.length === 0 && (
        <div class="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text-2)' }}>
          {filter === 'pending' ? t('insights.emptyPending') : t('insights.emptyOther')}
        </div>
      )}

      {proposals.map(p => {
        const detail = expanded.get(p.id);
        const isPending = p.status === 'pending';
        const isBusy = busyId === p.id;
        return (
          <div key={p.id} class="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 60%', minWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span class="badge badge-type" style={{ textTransform: 'none' }}>#{p.id}</span>
                  <span style={{ fontWeight: 600 }}>{p.digest_name}</span>
                  <span class="tag" style={{ fontSize: 11 }}>{p.project}</span>
                  <span class="tag" style={{ fontSize: 11 }}>{p.cluster_key}</span>
                  <span class="tag" style={{ fontSize: 11, color: 'var(--text-2)' }}>{p.source_count} {t('insights.sources')}</span>
                  <span class="tag" style={{
                    fontSize: 11,
                    background: p.status === 'pending' ? 'rgba(255,200,0,0.12)' :
                                p.status === 'applied' ? 'rgba(0,214,180,0.12)' : 'rgba(255,80,80,0.12)',
                    color: p.status === 'pending' ? '#FFC800' :
                           p.status === 'applied' ? 'var(--accent)' : '#FF5050',
                  }}>{t(`insights.status.${p.status}`)}</span>
                </div>
                <div style={{ marginTop: 6, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
                  {p.digest_observations_preview}…
                </div>
                <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 11 }}>
                  {formatRelative(p.created_at)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                <button class="btn btn-ghost" onClick={() => expand(p.id)} disabled={isBusy}>
                  {detail ? t('insights.collapse') : t('insights.viewDetail')}
                </button>
                {isPending && (
                  <>
                    <button class="btn btn-primary" onClick={() => accept(p.id)} disabled={isBusy}>
                      {isBusy ? t('insights.applying') : t('insights.accept')}
                    </button>
                    <button class="btn btn-ghost" onClick={() => reject(p.id)} disabled={isBusy} style={{ color: '#FF5050' }}>
                      {t('insights.reject')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {detail && detail.proposed_digest && (
              <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 4, fontSize: 13 }}>
                <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 11 }}>
                  {t('insights.generatedBy')}: <code>{detail.llm_model ?? 'unknown'}</code> · {t('insights.promptVersion')}: <code>{detail.prompt_version}</code>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <strong>{t('insights.observations')}:</strong>
                  <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
                    {detail.proposed_digest.observations.map((obs, i) => (
                      <li key={i} style={{ marginBottom: 6, lineHeight: 1.5 }}>{obs}</li>
                    ))}
                  </ol>
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>{t('insights.tags')}:</strong>{' '}
                  {detail.proposed_digest.tags.map(tag => (
                    <span key={tag} class="tag" style={{ marginLeft: 4, fontSize: 11 }}>{tag}</span>
                  ))}
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 6 }}>
                  {t('insights.sourceIds')}: {detail.source_ids.length} entities ({detail.source_ids.slice(0, 8).join(', ')}{detail.source_ids.length > 8 ? '…' : ''})
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
