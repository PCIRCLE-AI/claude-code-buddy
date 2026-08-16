import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, fetchProjects, type Entity, type HealthData, type ProjectInfo } from '../lib/api';
import { ProjectRoadmap } from './ProjectRoadmap';
import { EmptyLibraryState } from './EmptyLibraryState';
import { Chip } from './Chip';
import { t } from '../lib/i18n';
import { classifyLoadError, failureMessage } from '../lib/failure';
import { extractProject } from '../lib/entity-display';

const FETCH_LIMIT = 2000;

/**
 * The Project tab — a thin host for ProjectRoadmap, which is 100%
 * parent-fed (it fetches nothing itself). This tab owns the fetch and a
 * project selector; deep-linking, the capture-coverage band and the ADR
 * views arrive with the project-history PR (UX-3 in the work-topology
 * plan). No `memesh:data-changed` dispatch here: this surface is
 * read-only, and the event exists to sync the header after mutations.
 */
export function ProjectTab({ health }: { health?: HealthData | null }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadGen = useRef(0);

  useEffect(() => {
    const gen = ++loadGen.current;
    Promise.all([
      api<Entity[]>('GET', `/v1/entities?limit=${FETCH_LIMIT}&status=all`),
      fetchProjects().catch(() => [] as ProjectInfo[]),
    ])
      .then(([data, projs]) => {
        if (gen !== loadGen.current) return;
        if (!Array.isArray(data)) {
          setEntities([]);
          setError(failureMessage('unreadable'));
        } else {
          setEntities(data);
        }
        setProjects(projs);
        // One project = no choice to make; walk straight in.
        if (projs.length === 1) setSelected(projs[0].name);
      })
      .catch((e) => {
        if (gen !== loadGen.current) return;
        setError(failureMessage(classifyLoadError(e)));
      })
      .finally(() => {
        if (gen === loadGen.current) setLoading(false);
      });
  }, []);

  const projectEntities = useMemo(() => {
    if (!selected) return [];
    return entities
      .filter((e) => !e.archived && e.status !== 'archived' && extractProject(e) === selected)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [entities, selected]);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (error) return <div class="error-box" role="alert">{error}</div>;

  // Tri-state before claiming emptiness: health arrives from App's own
  // async fetch, and `null?.entity_count === 0` is false — deciding before
  // it lands would render a false first-run claim.
  if (entities.length === 0 && health == null) return <div class="empty"><div class="loading" /></div>;
  if (health?.entity_count === 0) return <EmptyLibraryState />;

  if (projects.length === 0) {
    return <div class="empty">{t('project.empty')}</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 4 }}>{t('project.selectLabel')}</span>
        {projects.map((p) => (
          <Chip
            key={p.name}
            label={p.name}
            count={p.count}
            active={selected === p.name}
            onClick={() => setSelected(p.name)}
          />
        ))}
      </div>
      {selected
        ? <div class="card"><ProjectRoadmap projectName={selected} entities={projectEntities} /></div>
        : <div class="empty">{t('project.selectPrompt')}</div>}
    </div>
  );
}
