import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type StatsData, type AnalyticsData, type PatternsData } from '../lib/api';
import { HealthScore } from './HealthScore';
import { MemoryLoopCard } from './MemoryLoopCard';
import { MemoryTimeline } from './MemoryTimeline';
import { MemoryAgeMatrix } from './MemoryAgeMatrix';
import { KnowledgeRadar } from './KnowledgeRadar';
import { UserPatterns } from './UserPatterns';
import { LlmTelemetryPanel } from './LlmTelemetryPanel';
import { PmAnalyticsPanel } from './PmAnalyticsPanel';
import { t } from '../lib/i18n';

/** The four bars `HealthScore` renders, each read as `factors[key].score`. */
const FACTOR_KEYS = ['activity', 'quality', 'freshness', 'lessons'] as const;

/**
 * Every field the stats row and the topics cloud dereference. The first
 * version of this check covered `totalEntities` and `tagDistribution` and
 * stopped, while the row right below it also calls `.toLocaleString()` on
 * `totalObservations`, `totalRelations` and `totalTags` — the same
 * one-level-short shape `PmAnalyticsPanel`'s guard went through twice.
 */
export function isStatsRenderable(s: StatsData | null): s is StatsData {
  return (
    typeof s?.totalEntities === 'number' &&
    typeof s.totalObservations === 'number' &&
    typeof s.totalRelations === 'number' &&
    typeof s.totalTags === 'number' &&
    Array.isArray(s.tagDistribution)
  );
}

/**
 * A rejected shape is a different event from a failed request, and a silent
 * one: the fetch succeeded, so nothing else will ever log. Say so — this is
 * what version skew between a cached bundle and the server looks like.
 */
function rejectShape<T>(label: string, value: T | null, ok: boolean): boolean {
  if (!ok && value !== null) {
    console.warn(`[memesh dashboard] ${label} answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:`, value);
  }
  return ok;
}

/**
 * Whether every field the analytics rows dereference is actually present.
 *
 * Checked against the leaves rather than the groups, because the group is the
 * level at which `{}` passes: `MemoryLoopCard` destructures `metric.trend` and
 * calls `.slice`, `MemoryTimeline` calls `data.reduce`, and `HealthScore`
 * reads `factors.activity.score`. `ageMatrix` / `knowledgeRadar` are not
 * checked here — the render coerces them, because a server that omits them
 * entirely is not a reason to blank the whole tab.
 */
export function isAnalyticsRenderable(a: AnalyticsData | null): a is AnalyticsData {
  if (typeof a?.healthScore !== 'number') return false;
  const factors = a.healthFactors as
    | Record<string, { score?: unknown; weight?: unknown } | undefined>
    | undefined;
  if (!factors) return false;
  for (const key of FACTOR_KEYS) {
    if (typeof factors[key]?.score !== 'number' || typeof factors[key]?.weight !== 'number') {
      return false;
    }
  }
  return Array.isArray(a.loopMetric?.trend) && Array.isArray(a.timeline);
}

/**
 * Same rule for the patterns payload. `UserPatterns` iterates
 * `workSchedule.hourDistribution` with `for…of` and spreads
 * `workSchedule.dayDistribution`, so `workSchedule` merely existing is not
 * enough — `{}` passes that and then throws `hourDistribution is not iterable`.
 */
export function isPatternsRenderable(p: PatternsData | null): p is PatternsData {
  return (
    Array.isArray(p?.workSchedule?.hourDistribution) &&
    Array.isArray(p.workSchedule?.dayDistribution) &&
    Array.isArray(p.toolPreferences) &&
    Array.isArray(p.focusAreas) &&
    Array.isArray(p.strengths) &&
    Array.isArray(p.learningAreas) &&
    typeof p.workflow?.avgSessionMinutes === 'number' &&
    typeof p.workflow?.totalSessions === 'number' &&
    typeof p.workflow?.commitsPerSession === 'number'
  );
}

export function AnalyticsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [patterns, setPatterns] = useState<PatternsData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    // Each endpoint degrades independently. Trace a failure to the console so a
    // single-endpoint outage (e.g. /v1/patterns) doesn't just make its panel
    // vanish with no signal — the overall error box only shows when BOTH stats
    // and analytics are null, so a patterns-only failure was previously silent.
    const guard = (label: string) => (err: unknown) => {
      console.warn(`[memesh dashboard] ${label} failed to load:`, err);
      return null;
    };
    Promise.all([
      api<StatsData>('GET', '/v1/stats').catch(guard('/v1/stats')),
      api<AnalyticsData>('GET', '/v1/analytics').catch(guard('/v1/analytics')),
      api<PatternsData>('GET', '/v1/patterns').catch(guard('/v1/patterns')),
    ]).then(([s, a, p]) => {
      // Every render below reads a required field off these —
      // `stats.totalEntities.toLocaleString()` and friends — so a payload
      // without them has to read as "did not load", not as "loaded".
      //
      // A guard has to reach the LEAF each child dereferences, not the group
      // that holds it. `{}` is truthy, so `a.healthFactors && a.loopMetric &&
      // a.timeline` admits a payload whose groups are all present and all
      // empty, and then `HealthScore` reads `factors.activity.score` off
      // `undefined`. That throw lands during the rerender the response
      // triggers, which produces no unhandled rejection and no visible text:
      // four panels simply vanish and nothing is reported.
      setStats(rejectShape('/v1/stats', s, isStatsRenderable(s)) ? s : null);
      setAnalytics(rejectShape('/v1/analytics', a, isAnalyticsRenderable(a)) ? a : null);
      setPatterns(rejectShape('/v1/patterns', p, isPatternsRenderable(p)) ? p : null);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (!stats && !analytics) return <div class="error-box">{t('common.error')}: {t('analytics.loadFailed')}</div>;

  return (
    <div>
      {/* Row 1: Stats overview */}
      {stats && (
        <div class="stats-row">
          <div class="stat"><div class="stat-val">{stats.totalEntities.toLocaleString()}</div><div class="stat-lbl">{t('analytics.totalMemories')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalObservations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.knowledgeFacts')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalRelations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.connections')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalTags.toLocaleString()}</div><div class="stat-lbl">{t('analytics.topics')}</div></div>
        </div>
      )}

      {/* Row 2: Memory Loop hero — the value-proof KPI replacing the Health
          Score gauge as the dominant element on this tab. Health Score is
          retained below as a secondary card. */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <MemoryLoopCard metric={analytics.loopMetric} />
        </div>
      )}

      {/* Row 2b (demoted): Health Score */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <HealthScore score={analytics.healthScore} factors={analytics.healthFactors} />
        </div>
      )}

      {/* Row 3: Memory Timeline */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <MemoryTimeline data={analytics.timeline} />
        </div>
      )}

      {/* Row 4: Age Matrix + Knowledge Radar (side by side on wide screens) */}
      {analytics && (
        <div style={{
          marginTop: 8,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 8,
        }}>
          {/* `?? []` only covers null/undefined, and `{}` is neither. */}
          <MemoryAgeMatrix data={Array.isArray(analytics.ageMatrix) ? analytics.ageMatrix : []} />
          <KnowledgeRadar data={Array.isArray(analytics.knowledgeRadar) ? analytics.knowledgeRadar : []} />
        </div>
      )}

      {/* Row 5: User Patterns */}
      {patterns && (
        <div style={{ marginTop: 8 }}>
          <UserPatterns data={patterns} />
        </div>
      )}

      {/* Row 5b: LLM telemetry — quantifies "memesh did X for you"
          across the 5 Smart-Mode flows. Renders even when other
          analytics fail; sourced from a separate endpoint. */}
      <div style={{ marginTop: 8 }}>
        <LlmTelemetryPanel />
      </div>

      {/* Row 5c: PM metrics — velocity, open decisions, KG orphan rate. */}
      <PmAnalyticsPanel />

      {/* Row 6: Topics cloud */}
      {stats && (() => {
        const internalPrefixes = ['auto_saved', 'auto-tracked', 'session_end', 'session:', 'source:', 'scope:', 'date:', 'urgency:'];
        const userTags = stats.tagDistribution.filter(tg =>
          !internalPrefixes.some(p => tg.tag.startsWith(p)) &&
          !/^\d{4}-\d{2}-\d{2}/.test(tg.tag)
        );
        return userTags.length > 0 ? (
          <div class="card" style={{ marginTop: 8 }}>
            <div class="card-title">{t('analytics.topics')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {userTags.slice(0, 30).map((tg) => (
                <span key={tg.tag} class="tag" style={{ fontSize: Math.max(11, Math.min(15, 10 + Math.log2(tg.count + 1))) + 'px' }}>
                  {tg.tag} <span style={{ opacity: 0.5 }}>({tg.count})</span>
                </span>
              ))}
            </div>
          </div>
        ) : null;
      })()}
    </div>
  );
}
