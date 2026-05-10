import { t } from '../lib/i18n';

// PatternCard renders the visual surface for a pattern_emergent
// dream proposal — output from runPatternDetector (Phase 3) in
// src/core/dreamer.ts. Pattern proposals share the dream_proposals
// table and accept/reject lifecycle with weekly compaction digests
// but represent a different signal: an emerging concern the LLM
// detected across recent project entities, not a successful
// summary. The amber accent (var(--warning)) intentionally contrasts
// with the success-green digest card so the user can tell at a glance
// that this row is a heads-up, not a recap.
//
// The action handlers are passed in from InsightsTab so the parent
// keeps full control of in-flight state, refresh fan-out, and the
// memesh:data-changed event broadcast. This component is purely
// presentational.

import type { JSX } from 'preact';

interface PatternProposalSummary {
  id: number;
  project: string;
  cluster_key: string;
  source_count: number;
  digest_name: string;
  digest_observations_preview: string;
  status: string;
  created_at: string;
}

// See InsightsTab's matching ValidationWarning interface — same shape
// flows through GET /v1/dream/proposals/:id for both digest and
// pattern_emergent kinds. Absent on patterns generated before the
// validator wiring landed; the rendering branch below is
// fully backward-compatible.
interface ValidationWarning {
  claim: string;
  reason: string;
}

interface PatternProposalDetail {
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
}

interface PatternCardProps {
  proposal: PatternProposalSummary;
  detail: PatternProposalDetail | undefined;
  expanded: boolean;
  inFlight: boolean;
  onToggleExpand: (id: number) => void;
  onAccept: (id: number) => void;
  onReject: (id: number) => void;
  formatRelative: (iso: string) => string;
  statusBadgeStyle: (status: string) => JSX.CSSProperties;
  statusLabel: (status: string) => string;
}

// Severity is surfaced via tags emitted by the LLM; we recognise
// severity:high|medium|low (matching the project's existing
// project:foo / lesson:bar tag convention) and fall back to
// neutral when absent.
function extractSeverity(tags: string[] | undefined): 'high' | 'medium' | 'low' | null {
  if (!tags) return null;
  for (const tag of tags) {
    const m = /^severity:(high|medium|low)$/i.exec(tag);
    if (m) return m[1].toLowerCase() as 'high' | 'medium' | 'low';
  }
  return null;
}

function severityColor(severity: 'high' | 'medium' | 'low' | null): string {
  switch (severity) {
    case 'high': return 'var(--danger)';
    case 'medium': return 'var(--warning)';
    case 'low': return 'var(--text-2)';
    default: return 'var(--text-3)';
  }
}

export function PatternCard(props: PatternCardProps) {
  const {
    proposal: p,
    detail,
    expanded,
    inFlight,
    onToggleExpand,
    onAccept,
    onReject,
    formatRelative,
    statusBadgeStyle,
    statusLabel,
  } = props;

  const isPending = p.status === 'pending';
  const severity = extractSeverity(detail?.proposed_digest?.tags);
  const badgeStyle = statusBadgeStyle(p.status);

  return (
    <div
      class="card"
      style={{
        padding: 14,
        borderLeft: '3px solid var(--warning)',
        background: 'var(--warning-soft)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 60%', minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span class="badge badge-type" style={{ textTransform: 'none' }}>#{p.id}</span>
            <span class="tag" style={{ fontSize: 11, background: 'var(--warning)', color: '#080A0C', fontWeight: 600 }}>
              {t('pattern.title')}
            </span>
            <span style={{ fontWeight: 600 }}>{p.digest_name}</span>
            <span class="tag" style={{ fontSize: 11 }}>{p.project}</span>
            <span class="tag" style={{ fontSize: 11, color: 'var(--text-2)' }}>
              {t('pattern.evidenceCount', { n: String(p.source_count) })}
            </span>
            {severity && (
              <span class="tag" style={{ fontSize: 11, color: severityColor(severity), borderColor: severityColor(severity) }}>
                {t('pattern.severity')}: {t(`pattern.severity.${severity}`)}
              </span>
            )}
            <span class="tag" style={{ fontSize: 11, ...badgeStyle }}>
              {statusLabel(p.status)}
            </span>
          </div>
          <div style={{ marginTop: 6, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
            {p.digest_observations_preview}{p.digest_observations_preview === '(empty)' ? '' : '…'}
          </div>
          <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 11 }}>
            {formatRelative(p.created_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          <button
            class="btn btn-ghost"
            onClick={() => onToggleExpand(p.id)}
            disabled={inFlight}
            aria-expanded={expanded}
          >
            {expanded ? t('insights.collapse') : t('insights.viewDetail')}
          </button>
          {isPending && (
            <>
              <button class="btn btn-primary" onClick={() => onAccept(p.id)} disabled={inFlight}>
                {inFlight ? t('insights.applying') : t('insights.accept')}
              </button>
              <button class="btn btn-ghost" onClick={() => onReject(p.id)} disabled={inFlight} style={{ color: 'var(--danger)' }}>
                {t('insights.reject')}
              </button>
            </>
          )}
        </div>
      </div>

      {detail && detail.proposed_digest && (
        <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-1)', borderRadius: 4, fontSize: 13 }}>
          <div style={{ marginBottom: 8, color: 'var(--text-3)', fontSize: 11 }}>
            {t('insights.generatedBy')}: <code>{detail.llm_model ?? 'unknown'}</code> {' '} {t('insights.promptVersion')}: <code>{detail.prompt_version}</code>
          </div>
          {/* Flagged claims — surfaced ABOVE the pattern description
              so reviewers see validator caveats first. Same channel and
              shape as InsightsTab; renders only when the validator
              flagged claims for this proposal. */}
          {Array.isArray(detail.proposed_digest.validation_warnings)
            && detail.proposed_digest.validation_warnings.length > 0 && (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 4,
                borderLeft: '3px solid var(--warning, #FFC800)',
                background: 'rgba(255,200,0,0.08)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--warning, #FFC800)', marginBottom: 6 }}>
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
            <strong>{t('pattern.description')}:</strong>
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
            {t('insights.sourceIds')}: {detail.source_ids.length} ({detail.source_ids.slice(0, 8).join(', ')}{detail.source_ids.length > 8 ? '…' : ''})
          </div>
        </div>
      )}
    </div>
  );
}
