import { useEffect, useState } from 'preact/hooks';
import { fetchNodeEvidence, type NodeEvidenceData } from '../lib/api';
import { displayTitle, typeLabel } from '../lib/entity-display';
import { t } from '../lib/i18n';

/**
 * The evidence drill-down: what mechanical capture supports one work node.
 *
 * Loaded on demand, never with the graph. The evidence layer is an order of
 * magnitude larger than the work layer (measured on the live graph:
 * 53 work entities, 246 evidence entities), so shipping it up front would
 * pay for a payload almost nobody expands.
 *
 * Three states are distinct on purpose, because they mean different things
 * to the reader and the middle one used to be reported as the last:
 *   - loading
 *   - loaded, empty → this node has no evidence linked YET, and the copy
 *     names the command that draws those edges. An empty list is not a
 *     claim that the work happened without evidence.
 *   - failed → says so, never renders as empty.
 *
 * `truncated` from the server is surfaced, not swallowed (same honesty rule
 * as recall's retrieval metadata: a full window says it is full).
 */

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; data: NodeEvidenceData }
  | { phase: 'failed' };

interface Props {
  /** Work-node entity name. */
  node: string;
  /** Human-readable heading for the node itself. */
  nodeTitle: string;
  onClose: () => void;
}

export function EvidencePanel({ node, nodeTitle, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    fetchNodeEvidence(node)
      .then((data) => {
        if (cancelled) return;
        setState({ phase: 'loaded', data });
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[memesh dashboard] evidence drill-down failed:', e);
        setState({ phase: 'failed' });
      });
    // Re-runs when the selected node changes; the flag drops the answer of
    // a request whose node is no longer the selected one.
    return () => { cancelled = true; };
  }, [node]);

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>{t('graph.evidenceFor', { node: nodeTitle })}</strong>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-2)',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {t('graph.evidenceClose')}
        </button>
      </div>

      {state.phase === 'loading' && (
        <div style={{ color: 'var(--text-2)', fontSize: 12 }}>{t('graph.evidenceLoading')}</div>
      )}

      {state.phase === 'failed' && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
          {t('graph.evidenceFailed')}
        </div>
      )}

      {state.phase === 'loaded' && state.data.entities.length === 0 && (
        <div style={{ color: 'var(--text-2)', fontSize: 12 }}>{t('graph.evidenceEmpty')}</div>
      )}

      {state.phase === 'loaded' && state.data.entities.length > 0 && (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {state.data.entities.map((e) => (
              <li key={e.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)', fontSize: 11, minWidth: 96 }}>
                  {typeLabel(e.type)}
                </span>
                <span style={{ color: 'var(--text-1)' }}>{displayTitle(e)}</span>
              </li>
            ))}
          </ul>
          {state.data.truncated && (
            <div style={{ marginTop: 8, color: 'var(--text-2)', fontSize: 11 }}>
              {t('graph.evidenceTruncated', { shown: state.data.entities.length })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
