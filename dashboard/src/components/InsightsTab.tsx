import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { actionFailureMessage, classifyLoadError, failureMessage } from '../lib/failure';
import { relativeDate } from '../lib/entity-display';
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
  /** null when the proposal has no observations (was the '(empty)' sentinel). */
  digest_observations_preview: string | null;
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

// Surfaced when the dreamer was run with `validateBeforeStage: true`
// and the LLM validator returned a 'soften' verdict. Stored on the
// proposed_digest JSON blob in dream_proposals; passes through GET
// /v1/dream/proposals/:id untouched. Absent on validator-pass digests
// and on every digest produced before the validator wiring landed —
// the rendering branch is fully backward-compatible.
interface ValidationWarning {
  claim: string;
  reason: string;
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
    validation_warnings?: ValidationWarning[];
  } | null;
  source_ids: number[];
  llm_model: string | null;
  prompt_version: string;
  status: ProposalStatus;
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

// Proposal timestamps arrive in SQLite's 'YYYY-MM-DD HH:MM:SS' UTC form,
// which Date() refuses without the T/Z normalisation. The relative-time
// wording itself is entity-display's relativeDate — the shared, localised
// formatter — not a hand-rolled English 's/m/h/d ago' ladder.
function formatRelative(iso: string): string {
  if (!iso) return '';
  return relativeDate(iso.includes(' ') ? iso.replace(' ', 'T') + 'Z' : iso);
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
      return { background: 'var(--warning-soft)', color: 'var(--warning)' };
    case 'applied':
      return { background: 'rgba(0,214,180,0.12)', color: 'var(--accent)' };
    case 'rejected':
      return { background: 'var(--danger-soft)', color: 'var(--danger)' };
    default:
      return { background: 'var(--neutral-soft)', color: 'var(--text-3)' };
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
  // Dream-run trigger state for the hero buttons. Two distinct flags
  // so the user sees which mode they kicked off (plain vs +validate)
  // — collapsing both into a single `dreamRunning` boolean would
  // disable BOTH buttons during a fast click and obscure which was
  // pressed. `null` = idle.
  const [dreamRunning, setDreamRunning] = useState<'plain' | 'validate' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // api() already unwraps to json.data, so the response IS the
      // proposal array. The earlier `Array.isArray(data) ? data : ...`
      // unwrap was dead code (unreachable) and confused readers.
      const data = await api<ProposalSummary[]>('GET', `/v1/dream/proposals?status=all`);
      // `?? []` only replaces null/undefined; `{}` passed through and
      // `allProposals.filter` threw "filter is not a function". And a
      // payload that is not the array must not read as "no insights yet" —
      // that is a false empty from a response nobody could parse.
      if (!Array.isArray(data)) {
        console.warn('[memesh dashboard] /v1/dream/proposals answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
        setAllProposals([]);
        setError(failureMessage('unreadable'));
      } else {
        setAllProposals(data);
      }
    } catch (e) {
      console.warn('[memesh dashboard] /v1/dream/proposals failed to load:', e);
      setError(failureMessage(classifyLoadError(e)));
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
      setError(actionFailureMessage(e));
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
      setError(actionFailureMessage(e));
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
      setError(actionFailureMessage(e));
    } finally {
      clearBusy(id);
    }
  }, [refresh]);

  // Trigger a dreamer pass on demand. `mode === 'validate'` plumbs the
  // optional second LLM call through `digest-validator.ts`. Bounded to
  // maxLlmCalls=3 from the dashboard so a casual click can't burn a
  // whole hour of LLM budget — power users still have the CLI for
  // larger passes (`memesh dream run --max-llm-calls 50 --validate`).
  const runDream = useCallback(async (mode: 'plain' | 'validate') => {
    setDreamRunning(mode);
    setError('');
    try {
      await api('POST', '/v1/dream/run', {
        maxLlmCalls: 3,
        validate: mode === 'validate',
      });
      window.dispatchEvent(new Event('memesh:data-changed'));
      await refresh();
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      setDreamRunning(null);
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
          <span><strong style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{pendingCount}</strong> {t('insights.statPending')}</span>
          <span><strong style={{ fontFamily: 'var(--mono)' }}>{appliedCount}</strong> {t('insights.statApplied')}</span>
          <span><strong style={{ fontFamily: 'var(--mono)' }}>{rejectedCount}</strong> {t('insights.statRejected')}</span>
        </div>
        {/* On-demand dream run — closes the v4.2.0 known limitation that
            forced users to drop into a CLI for `memesh dream run --validate`.
            Only enabled when the LLM probe came back with a configured
            provider; without one, runDreamer no-ops anyway and we show
            the empty-state's "configure your LLM" hint instead. */}
        {llmConfigured && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              class="btn btn-primary"
              onClick={() => runDream('plain')}
              disabled={dreamRunning !== null}
              aria-busy={dreamRunning === 'plain'}
            >
              {dreamRunning === 'plain' ? `${t('insights.runDream')}…` : t('insights.runDream')}
            </button>
            <button
              class="btn btn-ghost"
              onClick={() => runDream('validate')}
              disabled={dreamRunning !== null}
              aria-busy={dreamRunning === 'validate'}
            >
              {dreamRunning === 'validate' ? `${t('insights.runDreamWithValidate')}…` : t('insights.runDreamWithValidate')}
            </button>
          </div>
        )}
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
                borderRadius: 'var(--radius-xs)',
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

      {error && <div class="card" role="alert" style={{ padding: 12, color: 'var(--danger)' }}>{error}</div>}
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

        // digest_observations_preview is null when the digest has no
        // observations (the server used to send the literal '(empty)'
        // sentinel, which every consumer had to string-compare). Render a
        // localised empty state instead — never a dangling ellipsis.
        const preview = p.digest_observations_preview;

        return (
          <div key={p.id} class="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 60%', minWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span class="badge badge-type" style={{ textTransform: 'none', fontFamily: 'var(--mono)' }}>#{p.id}</span>
                  <span style={{ fontWeight: 600 }}>{p.digest_name}</span>
                  <span class="tag" style={{ fontSize: 11 }}>{p.project}</span>
                  <span class="tag" style={{ fontSize: 11 }}>{p.cluster_key}</span>
                  <span class="tag" style={{ fontSize: 11, color: 'var(--text-2)' }}>{p.source_count} {t('insights.sources')}</span>
                  <span class="tag" style={{ fontSize: 11, ...statusBadgeStyle(p.status) }}>
                    {statusLabel(p.status)}
                  </span>
                </div>
                <div style={{ marginTop: 6, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
                  {preview !== null
                    ? <>{preview}…</>
                    : <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>{t('insights.noPreview')}</span>}
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
                    <button class="btn btn-ghost" onClick={() => reject(p.id)} disabled={isBusy} style={{ color: 'var(--danger)' }}>
                      {t('insights.reject')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {detail && detail.proposed_digest && (
              <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 'var(--radius-xs)', fontSize: 13 }}>
                <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 11 }}>
                  {t('insights.generatedBy')}: <code>{detail.llm_model ?? t('common.unknown')}</code> · {t('insights.promptVersion')}: <code>{detail.prompt_version}</code>
                </div>
                {/* Flagged claims — only present when the dreamer was run
                    with --validate AND the validator returned 'soften'.
                    Renders ABOVE observations so the reviewer reads the
                    caveats before the digest text. Absent/empty array
                    skips this block entirely, preserving the original
                    layout for digests without validator output. */}
                {Array.isArray(detail.proposed_digest.validation_warnings)
                  && detail.proposed_digest.validation_warnings.length > 0 && (
                  <div
                    style={{
                      marginBottom: 10,
                      padding: 10,
                      borderRadius: 'var(--radius-xs)',
                      borderLeft: '3px solid var(--warning)',
                      background: 'var(--warning-soft)',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: 6 }}>
                      ⚠ {t('insights.validationWarnings')}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {detail.proposed_digest.validation_warnings.map((w, i) => (
                        <li key={i} style={{ marginBottom: 6, lineHeight: 1.5 }}>
                          <div>
                            <span style={{ color: 'var(--text-3)' }}>{t('insights.validationClaim')}: </span>
                            <code style={{ fontSize: 12 }}>{w.claim}</code>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-3)' }}>{t('insights.validationReason')}: </span>
                            <span>{w.reason}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
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
                  {t('insights.sourceIds')}: {t('insights.entitiesCount', { n: detail.source_ids.length })} ({detail.source_ids.slice(0, 8).join(', ')}{detail.source_ids.length > 8 ? '…' : ''})
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
