import { useState, useEffect, useMemo } from 'preact/hooks';
import { fetchLessons, fetchProjects, type Entity, type HealthData, type ProjectInfo } from '../lib/api';
import { t } from '../lib/i18n';
import { classifyLoadError, failureMessage } from '../lib/failure';
import { EmptyLibraryState } from './EmptyLibraryState';
import {
  classifyLesson,
  extractProject,
  relativeDate,
  accessSignal,
  type LessonKind,
} from '../lib/entity-display';
import { EntityIcon } from './icons/EntityIcon';

/** Inline label that pairs an SVG glyph with text. Centralised so each
 *  card / tab / empty-state stays visually identical instead of every
 *  caller wrapping its own flex container. */
function GlyphLabel({ type, children }: { type: string; children: preact.ComponentChild }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <EntityIcon type={type} size={16} />
      {children}
    </span>
  );
}

/* ---------- structured-failure parser (Type A) ---------- */

interface StructuredBlock {
  error: string;
  rootCause: string;
  fix: string;
  prevention: string;
}

/** Parse a failure-driven lesson into 1+ structured blocks. Each block has
 *  Error / Root cause / Fix / Prevention. Larger lessons (the "other" bucket
 *  in the database) often contain multiple blocks back-to-back; we split on
 *  the next "Error:" boundary. */
function parseStructuredBlocks(observations: string[]): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  let current: StructuredBlock | null = null;

  for (const raw of observations) {
    const obs = raw.trim();
    if (obs.startsWith('Error:')) {
      if (current) blocks.push(current);
      current = { error: obs.slice('Error:'.length).trim(), rootCause: '', fix: '', prevention: '' };
    } else if (obs.startsWith('Root cause:')) {
      if (!current) current = { error: '', rootCause: '', fix: '', prevention: '' };
      current.rootCause = obs.slice('Root cause:'.length).trim();
    } else if (obs.startsWith('Fix:') || obs.startsWith('Solution')) {
      if (!current) current = { error: '', rootCause: '', fix: '', prevention: '' };
      current.fix = obs.replace(/^(Fix|Solution\s*\d*):/i, '').trim();
    } else if (obs.startsWith('Prevention:')) {
      if (!current) current = { error: '', rootCause: '', fix: '', prevention: '' };
      current.prevention = obs.slice('Prevention:'.length).trim();
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/* ---------- plan-completion parser (Type B) ---------- */

interface PlanRecord {
  planName: string;
  stepCount: number;
  steps: string;
  commits: string[];
}

function parsePlan(entity: Entity): PlanRecord {
  const obs = entity.observations ?? [];
  const planMatch = obs[0]?.match(/^Plan "(.+?)" completed \((\d+) steps?\)/);
  const stepsLine = obs.find((o) => o.startsWith('Steps:'))?.slice('Steps:'.length).trim() ?? '';
  const commitsLine = obs.find((o) => o.startsWith('Commits:'))?.slice('Commits:'.length).trim() ?? '';
  return {
    planName: planMatch?.[1] ?? entity.name,
    stepCount: planMatch ? parseInt(planMatch[2], 10) : 0,
    steps: stepsLine,
    commits: commitsLine ? commitsLine.split(',').map((c) => c.trim()).filter(Boolean) : [],
  };
}

/* ---------- severity helpers ---------- */

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#FF6B6B',
  major: '#FFB84D',
  minor: '#60A5FA',
};

function severityOf(entity: Entity): 'critical' | 'major' | 'minor' | null {
  const tags = entity.tags ?? [];
  if (tags.includes('severity:critical')) return 'critical';
  if (tags.includes('severity:major')) return 'major';
  if (tags.includes('severity:minor')) return 'minor';
  return null;
}

/* ---------- card renderers ---------- */

function FailureCard({ entity }: { entity: Entity }) {
  const blocks = parseStructuredBlocks(entity.observations ?? []);
  const severity = severityOf(entity);
  const project = extractProject(entity);
  const access = accessSignal(entity.access_count);
  const borderColor = severity ? SEVERITY_COLORS[severity] : 'var(--border)';

  return (
    <div class="card" style={{ borderLeft: `3px solid ${borderColor}`, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
        <div class="card-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
          <GlyphLabel type="lesson_learned">{entity.name}</GlyphLabel>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          {project && <span class="tag" style={{ background: 'rgba(0, 214, 180, 0.12)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M2 4 a1 1 0 0 1 1 -1 h4 l2 2 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>{project}</span>}
          {severity && (
            <span class="badge" style={{ background: `${SEVERITY_COLORS[severity]}18`, color: SEVERITY_COLORS[severity] }}>
              {t(`lessons.severity.${severity}`)}
            </span>
          )}
          {access.tone !== 'none' && (
            <span class="tag" style={{
              background: access.tone === 'high' ? 'rgba(0, 214, 180, 0.18)' : 'rgba(0, 214, 180, 0.10)',
              color: 'var(--accent)',
              fontWeight: access.tone === 'high' ? 600 : 400,
            }}>
              ✓ {access.label}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{relativeDate(entity.last_accessed_at || entity.created_at)}</span>
        </div>
      </div>

      {blocks.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
          {t('lessons.unstructured')}
        </div>
      )}

      {blocks.map((b, i) => (
        <div key={i} style={{ marginTop: i > 0 ? 14 : 0, paddingTop: i > 0 ? 14 : 0, borderTop: i > 0 ? '1px dashed var(--border-subtle)' : 'none' }}>
          {b.error && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)', marginBottom: 2 }}>{t('lessons.error')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{b.error}</div>
            </div>
          )}
          {b.rootCause && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', marginBottom: 2 }}>{t('lessons.rootCause')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{b.rootCause}</div>
            </div>
          )}
          {b.fix && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--success)', marginBottom: 2 }}>{t('lessons.fix')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{b.fix}</div>
            </div>
          )}
          {b.prevention && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--info)', marginBottom: 2 }}>{t('lessons.prevention')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{b.prevention}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PlanCard({ entity }: { entity: Entity }) {
  const plan = parsePlan(entity);
  const project = extractProject(entity);
  const access = accessSignal(entity.access_count);

  return (
    <div class="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div class="card-title" style={{ margin: 0 }}>
            <GlyphLabel type="plan">{plan.planName}</GlyphLabel>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
            {plan.stepCount} {t('lessons.stepsLabel')} · {t('lessons.commitsCount', { count: plan.commits.length })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {project && <span class="tag" style={{ background: 'rgba(0, 214, 180, 0.12)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M2 4 a1 1 0 0 1 1 -1 h4 l2 2 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>{project}</span>}
          {access.tone !== 'none' && (
            <span class="tag" style={{ background: 'rgba(0, 214, 180, 0.10)', color: 'var(--accent)' }}>
              ✓ {access.label}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{relativeDate(entity.created_at)}</span>
        </div>
      </div>
      {plan.steps && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 4 }}>
          {plan.steps.length > 220 ? plan.steps.slice(0, 220) + '…' : plan.steps}
        </div>
      )}
      {plan.commits.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {plan.commits.slice(0, 4).join(' · ')}
          {plan.commits.length > 4 && <span> · +{plan.commits.length - 4}</span>}
        </div>
      )}
    </div>
  );
}

function FreeformCard({ entity }: { entity: Entity }) {
  const obs = entity.observations ?? [];
  const project = extractProject(entity);
  const access = accessSignal(entity.access_count);

  return (
    <div class="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
        <div class="card-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
          <GlyphLabel type="note">{entity.name}</GlyphLabel>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {project && <span class="tag" style={{ background: 'rgba(0, 214, 180, 0.12)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M2 4 a1 1 0 0 1 1 -1 h4 l2 2 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>{project}</span>}
          {access.tone !== 'none' && (
            <span class="tag" style={{ background: 'rgba(0, 214, 180, 0.10)', color: 'var(--accent)' }}>
              ✓ {access.label}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{relativeDate(entity.created_at)}</span>
        </div>
      </div>
      {obs.length > 0 && (
        <ul style={{ fontSize: 13, lineHeight: 1.6, margin: 0, paddingLeft: 18, color: 'var(--text-1)' }}>
          {obs.slice(0, 6).map((o, i) => (
            <li key={i} style={{ marginBottom: 3 }}>{o.length > 200 ? o.slice(0, 200) + '…' : o}</li>
          ))}
          {obs.length > 6 && (
            <li style={{ color: 'var(--text-3)', listStyle: 'none' }}>{t('lessons.moreItems', { count: obs.length - 6 })}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------- main component ---------- */

/** fetchLessons() asks for this many; at exactly this count the stats are a
 *  window, not the whole story, and must say so. */
const LESSONS_FETCH_LIMIT = 100;

export function LessonsTab({ health }: { health?: HealthData | null }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<LessonKind>('failure');
  const [search, setSearch] = useState('');
  const [project, setProject] = useState<string | 'all'>('all');

  useEffect(() => {
    Promise.all([fetchLessons(), fetchProjects().catch(() => [])])
      .then(([es, ps]) => { setEntities(es); setProjects(ps); })
      // The classified sentence, not e.message: a dead server otherwise
      // reads as the browser's raw "Failed to fetch".
      .catch((e) => setError(failureMessage(classifyLoadError(e))))
      .finally(() => setLoading(false));
  }, []);

  // Categorize once
  const categorized = useMemo(() => {
    const buckets: Record<LessonKind, Entity[]> = { failure: [], 'plan-completion': [], freeform: [] };
    for (const e of entities) {
      buckets[classifyLesson(e)].push(e);
    }
    // Sort by access_count desc, then created date
    for (const k of Object.keys(buckets) as LessonKind[]) {
      buckets[k].sort((a, b) =>
        (b.access_count ?? 0) - (a.access_count ?? 0)
        || b.created_at.localeCompare(a.created_at));
    }
    return buckets;
  }, [entities]);

  // Apply search + project filter to active tab
  const visible = useMemo(() => {
    const list = categorized[tab];
    const s = search.toLowerCase();
    return list.filter((e) => {
      if (project !== 'all' && extractProject(e) !== project) return false;
      if (!s) return true;
      const hay = [e.name, ...(e.observations ?? []), ...(e.tags ?? [])].join(' ').toLowerCase();
      return hay.includes(s);
    });
  }, [categorized, tab, search, project]);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  // `error` is already a full sentence with a next step — no prefix.
  if (error) return <div class="error-box" role="alert">{error}</div>;

  const totalAccess = entities.reduce((sum, e) => sum + (e.access_count ?? 0), 0);
  const criticalCount = categorized.failure.filter((e) => severityOf(e) === 'critical').length;

  return (
    <div>
      {/* Stats */}
      <div class="stats-row">
        <div class="stat">
          <div class="stat-val">{categorized.failure.length}</div>
          <div class="stat-lbl">{t('lessons.tabFailure')}</div>
        </div>
        <div class="stat">
          <div class="stat-val" style={{ color: criticalCount > 0 ? '#FF6B6B' : undefined }}>
            {criticalCount}
          </div>
          <div class="stat-lbl">{t('lessons.severity.critical')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{categorized['plan-completion'].length}</div>
          <div class="stat-lbl">{t('lessons.tabPlan')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{totalAccess}</div>
          <div class="stat-lbl">{t('lessons.totalRecalls')}</div>
        </div>
      </div>

      {/* Sub-category tabs */}
      <div class="card" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            class="btn btn-sm"
            style={{
              background: tab === 'failure' ? 'rgba(0, 214, 180, 0.18)' : 'transparent',
              borderColor: tab === 'failure' ? 'rgba(0, 214, 180, 0.5)' : 'rgba(255,255,255,0.08)',
              color: tab === 'failure' ? 'var(--accent)' : 'var(--text-2)',
            }}
            onClick={() => setTab('failure')}
          >
            <GlyphLabel type="lesson_learned">{t('lessons.tabFailure')}</GlyphLabel> <span style={{ opacity: 0.6, fontFamily: 'var(--mono)', marginLeft: 6 }}>{categorized.failure.length}</span>
          </button>
          <button
            class="btn btn-sm"
            style={{
              background: tab === 'plan-completion' ? 'rgba(0, 214, 180, 0.18)' : 'transparent',
              borderColor: tab === 'plan-completion' ? 'rgba(0, 214, 180, 0.5)' : 'rgba(255,255,255,0.08)',
              color: tab === 'plan-completion' ? 'var(--accent)' : 'var(--text-2)',
            }}
            onClick={() => setTab('plan-completion')}
          >
            <GlyphLabel type="plan">{t('lessons.tabPlan')}</GlyphLabel> <span style={{ opacity: 0.6, fontFamily: 'var(--mono)', marginLeft: 6 }}>{categorized['plan-completion'].length}</span>
          </button>
          <button
            class="btn btn-sm"
            style={{
              background: tab === 'freeform' ? 'rgba(0, 214, 180, 0.18)' : 'transparent',
              borderColor: tab === 'freeform' ? 'rgba(0, 214, 180, 0.5)' : 'rgba(255,255,255,0.08)',
              color: tab === 'freeform' ? 'var(--accent)' : 'var(--text-2)',
            }}
            onClick={() => setTab('freeform')}
          >
            <GlyphLabel type="note">{t('lessons.tabFreeform')}</GlyphLabel> <span style={{ opacity: 0.6, fontFamily: 'var(--mono)', marginLeft: 6 }}>{categorized.freeform.length}</span>
          </button>
        </div>

        {/* Search + project filter */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder={t('lessons.searchPlaceholder')}
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            style={{ flex: 1, minWidth: 240, padding: '4px 8px', fontSize: 12 }}
          />
          {projects.length > 0 && (
            <select
              value={project}
              onChange={(e) => setProject((e.target as HTMLSelectElement).value)}
              style={{ padding: '3px 8px', fontSize: 12 }}
            >
              <option value="all">{t('lessons.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>{p.name} ({p.count})</option>
              ))}
            </select>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
          {t('lessons.showing', { visible: visible.length, total: categorized[tab].length })}
          {/* At exactly the fetch limit the set is (almost certainly)
              truncated — the stats above then describe a window, and
              saying nothing would let them silently contradict reality. */}
          {entities.length >= LESSONS_FETCH_LIMIT && (
            <span> · {t('lessons.capNote', { limit: LESSONS_FETCH_LIMIT })}</span>
          )}
        </div>
      </div>

      {/* Card list. Three empty states, three different truths:
          - the whole DATABASE is empty → the durable demo entry point
            (OnboardingBanner may be dismissed forever; this may not);
          - the database has data but zero lessons → say how lessons come
            to exist, not "try another filter";
          - lessons exist but the filter matched none → the filter message. */}
      <div style={{ marginTop: 14 }}>
        {entities.length === 0 && health?.entity_count === 0 ? (
          <EmptyLibraryState />
        ) : visible.length === 0 ? (
          <div class="empty">
            <span class="empty-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
              <EntityIcon
                type={tab === 'failure' ? 'lesson_learned' : tab === 'plan-completion' ? 'plan' : 'note'}
                size={28}
              />
            </span>
            {entities.length === 0
              ? t('lessons.emptyGuide')
              : search
                ? t('lessons.noMatch', { query: search })
                : t('lessons.emptyCategory')}
          </div>
        ) : (
          visible.map((e) => {
            if (tab === 'failure') return <FailureCard key={e.id} entity={e} />;
            if (tab === 'plan-completion') return <PlanCard key={e.id} entity={e} />;
            return <FreeformCard key={e.id} entity={e} />;
          })
        )}
      </div>
    </div>
  );
}
