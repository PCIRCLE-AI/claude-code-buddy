import { useEffect, useState } from 'preact/hooks';
import { api, type AnalyticsData } from '../lib/api';
import { classifyLoadError, failureMessage, type LoadFailure } from '../lib/failure';
import { t, getLocale } from '../lib/i18n';

/**
 * The first thing Home says: a small row of numbers that are true.
 *
 * Two rules decide everything here, and both exist because the alternative
 * is a confident lie on the first screen a user reads.
 *
 * **Not measured is not zero.** A tile whose instrument has never run says
 * so, in words, in `--neutral-soft`. It never renders 0, because 0 is a
 * measurement — "we looked and found none" — and printing it from an
 * absence claims an observation nobody made. This is the same rule
 * `retrieval.degraded` enforces on the recall side.
 *
 * **A number arrives with its denominator.** "5 critical lessons" is a
 * different claim from "5 of the 12 that anyone has classified", and on a
 * real graph those were the same 5 out of 29 total. A tile that shows the
 * numerator alone rounds silence up into evidence.
 *
 * One fetch, and a per-tile verdict: a tile that cannot be computed degrades
 * on its own rather than blanking the row, because "the health score failed"
 * is not a reason to stop telling the user how many critical lessons they
 * have.
 */

type Load =
  | { phase: 'loading' }
  | { phase: 'loaded'; data: AnalyticsData }
  | { phase: 'failed'; failure: LoadFailure };

/** What a tile renders. `value: null` is the not-measured state and carries
 *  its own sentence; it is deliberately not expressible as a number. */
interface Tile {
  key: string;
  label: string;
  value: string | null;
  /** Shown under the value — the denominator, the caveat, or why it is unknown. */
  note: string;
  /** Colour for the value. Absent = the ordinary life tone. */
  tone?: 'life' | 'warning' | 'muted';
}

function tone(t?: Tile['tone']): string {
  if (t === 'warning') return 'var(--warning)';
  if (t === 'muted') return 'var(--text-2)';
  return 'var(--life)';
}

/** Whether a payload carries the groups this row reads.
 *
 *  A server one release behind sends `/v1/analytics` WITHOUT `criticalLessons`
 *  or `citationCompliance`, and reading `.severityTagged` off `undefined`
 *  throws during render — a white screen, because the app ships no error
 *  boundary. Missing groups are a shape mismatch to report, not fields to
 *  default: a fabricated `{critical: 0}` would print "0 critical lessons"
 *  from a server that never answered the question. */
export function isMetricsRenderable(d: Partial<AnalyticsData> | null | undefined): d is AnalyticsData {
  if (!d || typeof d !== 'object') return false;
  if (typeof d.healthScore !== 'number') return false;
  const cl = d.criticalLessons;
  if (!cl || typeof cl.critical !== 'number' || typeof cl.severityTagged !== 'number' || typeof cl.total !== 'number') {
    return false;
  }
  // `citationCompliance` is legitimately null — that IS its not-measured
  // state — so only a wrong TYPE disqualifies it.
  const cc = d.citationCompliance;
  if (cc !== null && cc !== undefined && (typeof cc.cited !== 'number' || typeof cc.total !== 'number')) return false;
  if (!d.loopMetric || typeof d.loopMetric.reusedThisWeek !== 'number') return false;
  return true;
}

export function buildTiles(data: AnalyticsData, locale: string): Tile[] {
  const n = (x: number) => x.toLocaleString(locale);

  // Health score. Measured from real counts, so it is always a number — but
  // an empty library scores 0 out of arithmetic, not out of judgement, and
  // telling a fresh install its memory is "poor" is the same lie in a
  // different costume. The caller passes `total` so we can say which it is.
  const health: Tile = {
    key: 'health',
    label: t('metrics.health'),
    value: `${data.healthScore}`,
    note: t('metrics.healthNote'),
    tone: data.healthScore >= 60 ? 'life' : data.healthScore >= 40 ? 'warning' : 'muted',
  };

  const cl = data.criticalLessons;
  const critical: Tile = cl.severityTagged === 0
    ? {
        key: 'critical',
        label: t('metrics.critical'),
        value: null,
        note: cl.total === 0 ? t('metrics.criticalNoLessons') : t('metrics.criticalUnclassified', { total: n(cl.total) }),
        tone: 'muted',
      }
    : {
        key: 'critical',
        label: t('metrics.critical'),
        value: n(cl.critical),
        note: cl.severityTagged < cl.total
          ? t('metrics.criticalPartial', { tagged: n(cl.severityTagged), total: n(cl.total) })
          : t('metrics.criticalAll', { total: n(cl.total) }),
        tone: cl.critical > 0 ? 'warning' : 'life',
      };

  const cc = data.citationCompliance;
  const citation: Tile = cc === null
    ? {
        key: 'citation',
        label: t('metrics.citation'),
        value: null,
        note: t('metrics.citationNotMeasured'),
        tone: 'muted',
      }
    : {
        key: 'citation',
        label: t('metrics.citation'),
        value: `${Math.round((cc.cited / cc.total) * 100)}%`,
        note: t('metrics.citationNote', { cited: n(cc.cited), total: n(cc.total) }),
      };

  // The loop metric carries its own honesty flag: the numbers are derived
  // from last_accessed_at, and the note says so rather than implying the
  // precision the field name suggests.
  const loop: Tile = {
    key: 'loop',
    label: t('metrics.reused'),
    value: n(data.loopMetric.reusedThisWeek),
    note: t('metrics.reusedNote'),
  };

  return [health, critical, citation, loop];
}

export function MetricsRow() {
  const [state, setState] = useState<Load>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api<AnalyticsData>('GET', '/v1/analytics')
      .then((data) => {
        if (cancelled) return;
        if (!isMetricsRenderable(data)) {
          console.warn('[memesh dashboard] /v1/analytics answered without the groups this row reads — stale server or version skew:', data);
          setState({ phase: 'failed', failure: 'unreadable' });
          return;
        }
        setState({ phase: 'loaded', data });
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[memesh dashboard] /v1/analytics failed to load for the metrics row:', e);
        setState({ phase: 'failed', failure: classifyLoadError(e) });
      });
    return () => { cancelled = true; };
  }, []);

  if (state.phase === 'loading') {
    return <div class="stats-row" aria-busy="true"><div class="stat"><div class="loading" /></div></div>;
  }
  if (state.phase === 'failed') {
    // The row says what happened. It does NOT render four zeroes, which
    // would report four measurements from a request that never answered.
    return (
      <div role="alert" class="card" style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-2)' }}>
        {failureMessage(state.failure)}
      </div>
    );
  }

  const tiles = buildTiles(state.data, getLocale());
  return (
    <div class="stats-row">
      {tiles.map((tile) => (
        <div class="stat" key={tile.key}>
          <div class="stat-val" style={{ color: tone(tile.tone), fontSize: tile.value === null ? 13 : undefined }}>
            {tile.value ?? t('metrics.notMeasured')}
          </div>
          <div class="stat-lbl">{tile.label}</div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{tile.note}</div>
        </div>
      ))}
    </div>
  );
}
