import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

// Surfaces the llm_telemetry persisted scorecard as a dashboard panel.
// Backed by GET /v1/telemetry?window=N → { window_days, summaries[] }.
// Each summary describes one flow (dreamer / pattern_detector /
// consolidator / auto_tagger / failure_analyzer) with success rate,
// fallback usage, latency median, provider breakdown, and error
// classes. The scorecard is the dashboard surface the maintainer
// asked for: "memesh 真的對你的工作有幫助" — quantified.

interface FlowSummary {
  flow: string;
  total_calls: number;
  total_attempts: number;
  successes: number;
  failures: number;
  fallback_used: number;
  median_latency_ms: number | null;
  by_provider: Record<string, { ok: number; fail: number }>;
  by_model: Record<string, { ok: number; fail: number }>;
  by_project: Record<string, { ok: number; fail: number }>;
  by_error_class: Record<string, number>;
  sample_errors: Array<{ error_class: string | null; message: string }>;
  window_days: number;
}

interface TelemetryResponse {
  window_days: number;
  summaries: FlowSummary[];
}

const FLOW_LABELS: Record<string, string> = {
  dreamer: 'Weekly recap (dreamer)',
  pattern_detector: 'Pattern detector',
  consolidator: 'Consolidator',
  auto_tagger: 'Auto-tagger',
  failure_analyzer: 'Failure analyzer',
};

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function LlmTelemetryPanel() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [window, setWindow] = useState(30);

  useEffect(() => {
    setLoading(true);
    setError('');
    api<TelemetryResponse>('GET', `/v1/telemetry?window=${window}`)
      // Without `summaries` there is nothing to render, and `data.summaries.length`
      // throws. Treat the partial payload as absent rather than as data.
      .then(d => setData(Array.isArray(d?.summaries) ? d : null))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [window]);

  return (
    <div class="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <span class="card-title" style={{ margin: 0 }}>{t('telemetry.title')}</span>
        <div style={{ display: 'flex', gap: 4, fontSize: 12 }}>
          {[7, 30, 90].map(d => (
            <button
              key={d}
              class="btn btn-ghost"
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid ' + (window === d ? 'var(--accent)' : 'var(--border)'),
                color: window === d ? 'var(--accent)' : 'var(--text-2)',
                background: window === d ? 'rgba(0,214,180,0.10)' : 'transparent',
              }}
              onClick={() => setWindow(d)}
            >
              {t('telemetry.lastNDays', { n: d })}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('telemetry.loading')}</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      {!loading && !error && data && data.summaries.length === 0 && (
        <div style={{ color: 'var(--text-2)', fontSize: 13, padding: 8 }}>
          {t('telemetry.empty')}
        </div>
      )}

      {!loading && !error && data && data.summaries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.summaries.map(s => {
            const successRate = s.total_attempts > 0 ? s.successes / s.total_attempts : 0;
            const fallbackPct = s.total_calls > 0 ? s.fallback_used / s.total_calls : 0;
            const flowLabel = FLOW_LABELS[s.flow] ?? s.flow;
            const providerEntries = Object.entries(s.by_provider);
            const modelEntries = Object.entries(s.by_model);
            const projectEntries = Object.entries(s.by_project);
            const errorEntries = Object.entries(s.by_error_class).sort((a, b) => b[1] - a[1]);

            return (
              <div key={s.flow} style={{
                padding: 12,
                background: 'var(--bg-1)',
                borderRadius: 4,
                borderLeft: `2px solid ${successRate >= 0.9 ? 'var(--accent)' : successRate >= 0.5 ? '#FFC800' : '#FF5050'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontWeight: 600 }}>{flowLabel}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {t('telemetry.callsCount', { n: s.total_calls })} · {t('telemetry.attemptsCount', { n: s.total_attempts })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginBottom: 6 }}>
                  <span>
                    <span style={{ color: 'var(--text-3)' }}>{t('telemetry.successRate')}: </span>
                    <strong style={{ color: successRate >= 0.9 ? 'var(--accent)' : successRate >= 0.5 ? '#FFC800' : '#FF5050' }}>
                      {fmtPct(successRate)}
                    </strong>
                  </span>
                  <span>
                    <span style={{ color: 'var(--text-3)' }}>{t('telemetry.medianLatency')}: </span>
                    <strong>{fmtLatency(s.median_latency_ms)}</strong>
                  </span>
                  {s.fallback_used > 0 && (
                    <span style={{ color: '#FFC800' }}>
                      ⚠️ {t('telemetry.fallbackUsed', { n: s.fallback_used, pct: fmtPct(fallbackPct) })}
                    </span>
                  )}
                </div>
                {providerEntries.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
                    {t('telemetry.byProvider')}:{' '}
                    {providerEntries.map(([p, v]) => (
                      <span key={p} class="tag" style={{ marginRight: 6, fontSize: 11 }}>
                        {p} {v.ok}/{v.ok + v.fail}
                      </span>
                    ))}
                  </div>
                )}
                {modelEntries.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
                    {t('telemetry.byModel')}:{' '}
                    {modelEntries.map(([m, v]) => (
                      <span key={m} class="tag" style={{ marginRight: 6, fontSize: 11 }}>
                        {m} {v.ok}/{v.ok + v.fail}
                      </span>
                    ))}
                  </div>
                )}
                {projectEntries.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
                    {t('telemetry.byProject')}:{' '}
                    {projectEntries.map(([p, v]) => (
                      <span key={p} class="tag" style={{ marginRight: 6, fontSize: 11 }}>
                        {p} {v.ok}/{v.ok + v.fail}
                      </span>
                    ))}
                  </div>
                )}
                {errorEntries.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                    {t('telemetry.errors')}:{' '}
                    {errorEntries.map(([cls, n]) => (
                      <span key={cls} class="tag" style={{
                        marginRight: 6,
                        fontSize: 11,
                        background: cls === 'auth' ? 'rgba(255,80,80,0.12)' : 'rgba(255,200,0,0.10)',
                        color: cls === 'auth' ? '#FF5050' : '#FFC800',
                      }}>
                        {cls} ×{n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
