import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, fetchProjects, type Entity, type HealthData, type ProjectInfo } from '../lib/api';
import { ProjectRoadmap } from './ProjectRoadmap';
import { EmptyLibraryState } from './EmptyLibraryState';
import { Chip } from './Chip';
import { t } from '../lib/i18n';
import { classifyLoadError, failureMessage } from '../lib/failure';
import { extractProject } from '../lib/entity-display';

const FETCH_LIMIT = 2000;

/** `?project=` deep-link read. Unvalidated on purpose: a stale name renders
 *  the roadmap's own honest empty state, and the chip row is still there to
 *  recover with — better than silently ignoring the link. */
function urlProject(): string | null {
  try { return new URLSearchParams(window.location.search).get('project'); } catch { return null; }
}

function writeUrlProject(name: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('project', name);
    history.replaceState(null, '', url);
  } catch { /* private mode / no history — the view still works */ }
}

/**
 * The roadmap's entity set for one project: active entities of the project,
 * PLUS the archived entities an active one points at with a lineage edge.
 * `supersedes` ARCHIVES its target on write (operations.ts), so a plain
 * active filter hides exactly the node every supersession edge points at —
 * the roadmap could never show a chain. The fetch already carries archived
 * rows (status=all); general archived noise stays out. Exported for the
 * unit test — the readmission rule is the load-bearing part of this tab.
 */
export function selectProjectEntities(entities: Entity[], selected: string | null): Entity[] {
  if (!selected) return [];
  const isArchived = (e: Entity) => Boolean(e.archived) || e.status === 'archived';
  const active = entities.filter((e) => !isArchived(e) && extractProject(e) === selected);
  const referenced = new Set<string>();
  for (const e of active) {
    for (const r of e.relations ?? []) {
      if (r.type === 'supersedes' || r.type === 'contradicts') referenced.add(r.to);
    }
  }
  const readmitted = entities.filter((e) => isArchived(e) && referenced.has(e.name));
  return [...active, ...readmitted].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * The Project tab — a thin host for ProjectRoadmap, which is 100%
 * parent-fed (it fetches nothing itself). This tab owns the fetch, the
 * project selector and the `?project=` deep link. No `memesh:data-changed`
 * dispatch here: this surface is read-only, and the event exists to sync
 * the header after mutations.
 */
export function ProjectTab({ health }: { health?: HealthData | null }) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(urlProject);
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
        // One project = no choice to make; walk straight in — unless a
        // ?project= deep link already chose (even a stale one: overriding
        // it would make the shared URL silently show something else).
        if (projs.length === 1) setSelected((cur) => cur ?? projs[0].name);
      })
      .catch((e) => {
        if (gen !== loadGen.current) return;
        setError(failureMessage(classifyLoadError(e)));
      })
      .finally(() => {
        if (gen === loadGen.current) setLoading(false);
      });
  }, []);

  const projectEntities = useMemo(
    () => selectProjectEntities(entities, selected),
    [entities, selected],
  );

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
            onClick={() => { setSelected(p.name); writeUrlProject(p.name); }}
          />
        ))}
      </div>
      {selected
        ? <div class="card"><ProjectRoadmap projectName={selected} entities={projectEntities} /></div>
        : <div class="empty">{t('project.selectPrompt')}</div>}
    </div>
  );
}
