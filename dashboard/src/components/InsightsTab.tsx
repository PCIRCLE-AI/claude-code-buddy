import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { PatternCard } from './PatternCard';
import type { JSX } from 'preact';

// Insights tab — surfaces what memesh has automatically generated for
// the user (LLM-driven dreamer + pattern detector output) and routes
// the propose / accept / reject lifecycle through the dashboard
// instead of the CLI-only `memesh dream list`. The backend endpoints
// (GET /v1/dream/proposals[/:id], POST .../accept, POST .../reject)
// landed in commit 883abd4d.
//
// Two proposal kinds share the same lifecycle and table but render
// differently:
//   - 'digest'           — weekly compaction recap (success-green)
//   - 'pattern_emergent' — emerging concern (amber, see PatternCard)
// The kind is plumbed through from the server in `listProposals`
// (commit added `kind` to ProposalSummary).

type ProposalStatus = 'pending' | 'applied' | 'rejected';

interface ProposalSummary {
  id: number;
  project: string;
  cluster_key: string;
  source_count: number;
  digest_name: string;
  digest_observations_preview: string;
  // Strict union is the truth for today; the badge renderer below
  // falls back to a neutral gray for any future status (e.g.
  // 'expired' / 'superseded') the server may add without coordinated
  // dashboard release. Kept narrow at the type so callers using this
  // model still get autocomplete for known values.
  status: ProposalStatus;
  created_at: string;
  // Server returns 'digest' or 'pattern_emergent'. We accept any
  // string at the runtime boundary so unknown future kinds render as
  // a digest (the safe default) rather than crashing the tab.
  kind?: string;
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

// Defensive status -> badge color mapping. The server side
// (dreamer.ts:listProposals) declares `status: string`, so a future
// status value (e.g. 'expired', 'superseded') would silently
// mis-render with the previous strict-union switch. Unknown values
// fall back to a neutral var(--text-3) gray instead of inheriting an
// existing color.
function statusBadgeStyle(status: string): JSX.CSSProperties {
  switch (status) {
    case 'pending':
      return { background: 'rgba(255,200,0,0.12)', color: '#FFC800' };
    case 'applied':
      return { background: 'rgba(0,214,180,0.12)', color: 'var(--accent)' };
    case 'rejected':
      return { background: 'rgba(255,80,80,0.12)', color: '#FF5050' };
    default:
      return { background: 'rgba(160,160,160,0.10)', color: 'var(--text-3)' };
  }
}

// Localised label with a graceful fallback to the raw status string
// when the i18n catalogue doesn't have a key for it (same future-
// status concern as the badge color).
function statusLabel(status: string): string {
  const key = `insights.status.${status}`;
  const label = t(key);
  // t() returns the raw key when no translation exists — surface the
  // server-provided status string in that case rather than the key
  // path itself.
  return label === key ? status : label;
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
  // Whether the user has any LLM provider configured. Without one, the
  // dreamer / pattern detector NEVER produce proposals — so the empty
  // state should point the user to Settings rather than suggesting
  // they "run `memesh dream run`" (which would also no-op).
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  // Set-based in-flight tracking. The earlier scalar `busyId` had a
  // race: clicking accept on A then accept on B before A's
  // `await refresh()` resolved would let B's `setBusyId(B)` overwrite
  // A's busy state, then A's `finally { setBusyId(null) }` would
  // clear B's state mid-flight. With a Set we add on click and
  // remove in the matching finally, so two concurrent ops can each
  // own their own button-disabled state.
  const [inFlight, setInFlight] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // api() already unwraps to json.data, so the response IS the
      // proposal array. The earlier `Array.isArray(data) ? data : ...`
      // unwrap was dead code (unreachable) and confused readers.
      const data = await api<ProposalSummary[]>('GET', `/v1/dream/proposals?status=all`);
      setAllProposals(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // One-shot capability probe — answers "is the empty-state
  // 'configure your LLM' or 'run dream run'?".
  useEffect(() => {
    api<{ capabilities?: { llm?: { provider?: string } | null } }>('GET', '/v1/config')
      .then((d) => setLlmConfigured(!!d?.capabilities?.llm))
      .catch(() => setLlmConfigured(false));
  }, []);

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

  const markBusy = (id: number) => {
    setInFlight(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const clearBusy = (id: number) => {
    setInFlight(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const accept = useCallback(async (id: number) => {
    markBusy(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/accept`);
      window.dispatchEvent(new Event('memesh:data-changed'));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearBusy(id);
    }
  }, [refresh]);

  const reject = useCallback(async (id: number) => {
    markBusy(id);
    try {
      await api('POST', `/v1/dream/proposals/${id}/reject`, { reason: 'rejected via dashboard' });
      window.dispatchEvent(new Event('memesh:data-changed'));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearBusy(id);
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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label={t('insights.title')}>
        {(['pending', 'applied', 'rejected', 'all'] as const).map(f => {
          const active = filter === f;
          return (
            <button
              key={f}
              class={`tag`}
              aria-pressed={active}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
                background: active ? 'rgba(0,214,180,0.12)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-2)',
              }}
              onClick={() => setFilter(f)}
            >
              {t(`insights.filter.${f}`)}
            </button>
          );
        })}
        <button class="btn btn-ghost" onClick={refresh} style={{ marginLeft: 'auto' }}>{t('insights.refresh')}</button>
      </div>

      {error && <div class="card" style={{ padding: 12, color: 'var(--danger)' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('insights.loading')}</div>}
      {!loading && proposals.length === 0 && (
        <div class="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text-2)' }}>
          {filter !== 'pending'
            ? t('insights.emptyOther')
            : llmConfigured === false
              ? t('insights.emptyNoLlm')
              : t('insights.emptyPending')}
        </div>
      )}

      {proposals.map(p => {
        const detail = expanded.get(p.id);
        const isExpanded = expanded.has(p.id);
        const isPending = p.status === 'pending';
        const isBusy = inFlight.has(p.id);

        // Pattern proposals get a distinct visual surface — same
        // lifecycle, different signal class. Anything other than the
        // explicit pattern_emergent kind is rendered as a digest.
        if (p.kind === 'pattern_emergent') {
          return (
            <PatternCard
              key={p.id}
              proposal={p}
              detail={detail}
              expanded={isExpanded}
              inFlight={isBusy}
              onToggleExpand={expand}
              onAccept={accept}
              onReject={reject}
              formatRelative={formatRelative}
              statusBadgeStyle={statusBadgeStyle}
              statusLabel={statusLabel}
            />
          );
        }

        // The server-side default for digest_observations_preview is
        // the literal string '(empty)' when observations[] is empty.
        // Appending an unconditional `…` produces `(empty)…` which
        // reads like garbage; only suffix the ellipsis when there's
        // actual content.
        const previewSuffix = p.digest_observations_preview === '(empty)' ? '' : '…';

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
                  <span class="tag" style={{ fontSize: 11, ...statusBadgeStyle(p.status) }}>
                    {statusLabel(p.status)}
                  </span>
                </div>
                <div style={{ marginTop: 6, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
                  {p.digest_observations_preview}{previewSuffix}
                </div>
                <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 11 }}>
                  {formatRelative(p.created_at)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                <button
                  class="btn btn-ghost"
                  onClick={() => expand(p.id)}
                  disabled={isBusy}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? t('insights.collapse') : t('insights.viewDetail')}
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
