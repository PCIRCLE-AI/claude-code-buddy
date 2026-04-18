import { useState, useEffect } from 'preact/hooks';
import { fetchLessons, type Entity } from '../lib/api';
import { t } from '../lib/i18n';

interface ParsedLesson {
  entity: Entity;
  error: string;
  rootCause: string;
  fix: string;
  prevention: string;
  severity: 'critical' | 'major' | 'minor' | null;
  project: string;
  confidence: number;
}

function parseLesson(entity: Entity): ParsedLesson {
  const obs = entity.observations || [];
  const find = (prefix: string) => {
    const match = obs.find((o) => o.startsWith(prefix));
    return match ? match.slice(prefix.length).trim() : '';
  };

  const tags = entity.tags || [];
  let severity: ParsedLesson['severity'] = null;
  if (tags.includes('severity:critical')) severity = 'critical';
  else if (tags.includes('severity:major')) severity = 'major';
  else if (tags.includes('severity:minor')) severity = 'minor';

  const projectTag = tags.find((tg) => tg.startsWith('project:'));
  const project = projectTag ? projectTag.slice('project:'.length) : '';

  return {
    entity,
    error: find('Error:'),
    rootCause: find('Root cause:'),
    fix: find('Fix:'),
    prevention: find('Prevention:'),
    severity,
    project,
    confidence: entity.confidence ?? 1,
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  major: '#f97316',
  minor: '#3b82f6',
};

export function LessonsTab() {
  const [lessons, setLessons] = useState<ParsedLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchLessons()
      .then((entities) => setLessons(entities.map(parseLesson)))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (error) return <div class="error-box">{t('common.error')}: {error}</div>;
  if (lessons.length === 0) {
    return (
      <div class="empty">
        <span class="empty-icon">{"📝"}</span>
        {t('lessons.empty')}
      </div>
    );
  }

  return (
    <div>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-val">{lessons.length}</div>
          <div class="stat-lbl">{t('lessons.total')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{lessons.filter((l) => l.severity === 'critical').length}</div>
          <div class="stat-lbl">{t('lessons.critical')}</div>
        </div>
      </div>
      {lessons.map((lesson) => {
        const borderColor = lesson.severity ? SEVERITY_COLORS[lesson.severity] : 'var(--border)';
        return (
          <div
            key={lesson.entity.id}
            class="card"
            style={{ borderLeft: `3px solid ${borderColor}` }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div class="card-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
                {lesson.entity.name}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {lesson.project && (
                  <span class="tag">{lesson.project}</span>
                )}
                {lesson.severity && (
                  <span class="badge" style={{
                    background: `${SEVERITY_COLORS[lesson.severity]}18`,
                    color: SEVERITY_COLORS[lesson.severity],
                  }}>
                    {lesson.severity}
                  </span>
                )}
                <span class="badge" style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-hover)',
                }}>
                  {Math.round(lesson.confidence * 100)}%
                </span>
              </div>
            </div>
            {lesson.error && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', marginBottom: 2 }}>{t('lessons.error')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>{lesson.error}</div>
              </div>
            )}
            {lesson.rootCause && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', marginBottom: 2 }}>{t('lessons.rootCause')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>{lesson.rootCause}</div>
              </div>
            )}
            {lesson.fix && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#22c55e', marginBottom: 2 }}>{t('lessons.fix')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>{lesson.fix}</div>
              </div>
            )}
            {lesson.prevention && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#3b82f6', marginBottom: 2 }}>{t('lessons.prevention')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>{lesson.prevention}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
