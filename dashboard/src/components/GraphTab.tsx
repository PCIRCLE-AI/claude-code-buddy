import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { fetchGraph, fetchWorkGraph, type GraphData, type WorkGraphData, type Entity } from '../lib/api';
import { EvidencePanel } from './EvidencePanel';
import { t, getLocale } from '../lib/i18n';
import { typeLabel, relationLabel, displayTitle } from '../lib/entity-display';
import { classifyLoadError, failureMessage, type LoadFailure } from '../lib/failure';
import { useSignalMode } from '../lib/signalMode';
import { EmptyLibraryState } from './EmptyLibraryState';
import { resolveTokens, rgbaFrom, type ResolvedTokens } from '../lib/tokens';
import { CATEGORICAL_TYPE_COLORS } from '../lib/type-palette';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** What both graph payloads have in common — the two arrays every read in
 *  this component iterates. `noiseTypes` is NOT part of it: the work layer
 *  has no noise types, because every type in it is signal by definition. */
type RenderableGraph = { entities: Entity[]; relations: Array<{ from: string; to: string; type: string }> };

/**
 * The two arrays every read in this component iterates. Exported so the
 * contract suite can test it leaf by leaf — a component-level stub can only
 * pin the leaves it happens to omit, and this predicate rejecting for the
 * WRONG missing field is invisible at that level.
 */
export function isGraphRenderable<T extends Partial<RenderableGraph>>(
  d: T | null | undefined,
): d is T & RenderableGraph {
  return Array.isArray(d?.entities) && Array.isArray(d.relations);
}

/**
 * The work-layer payload additionally carries `evidenceCounts`, and its
 * absence must NOT be defaulted away. `?? {}` would render every badge as
 * zero — "nothing supports this decision" — from a response that never
 * answered the question. Missing counts are a shape mismatch (version skew),
 * which the tab already knows how to report; a fabricated zero is the silent
 * degradation `retrieval.degraded` exists to prevent on the recall side.
 */
export function isWorkGraphRenderable(
  d: Partial<WorkGraphData> | null | undefined,
): d is WorkGraphData {
  return isGraphRenderable(d)
    && typeof d.evidenceCounts === 'object'
    && d.evidenceCounts !== null
    && !Array.isArray(d.evidenceCounts);
}

/** The two-layer view's fallback threshold. A graph of one or two nodes is
 *  not a graph; below this the tab shows the full graph instead and SAYS it
 *  did (measured on the live graph 2026-08-17: 53 work entities of 361
 *  active, so the real case renders the work layer, and the fallback is for
 *  a young install — where it is the normal state, not an error). */
export const WORK_LAYER_MIN_NODES = 3;

/** Badge radius in SCREEN pixels — divided by scale at draw and hit-test so
 *  both agree at every zoom. */
const BADGE_R = 5;

interface GNode {
  id: string;
  /** The headline a human reads, from `displayTitle`'s chain (title → best
   *  observation → type + date). NOT `id`: `id` is `entity.name`, a machine
   *  dedup key (`pre-compact-<sessionId>`, `commit-a1b2c3d`), and the canvas
   *  was drawing those keys on screen — the one thing entity-display.ts says
   *  the chain must never fall back to. Precomputed with the node set so the
   *  draw loop does no string work per frame; the cost is that the type+date
   *  branch keeps the locale it was built with until the data or the layer
   *  changes (title and observation headlines carry no locale at all). */
  display: string;
  /** `name + headline`, lowercased — the search haystack. Search used to test
   *  the machine name alone, so typing the headline the user just read (in
   *  Memories, or in this graph's own tooltip) matched nothing. */
  searchText: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  recency: number;          // 0.15–1.0
  isOrphan: boolean;
  lastDate: string;         // ISO string for tooltip age
  /** Incoming `evidences` edges. 0 in the full-graph view, and 0 is honest
   *  in the work view too: `memesh kg backfill` is what draws those edges. */
  evidenceCount: number;
  /** Raw access_count (clamped to ≥0), kept because RANKING must use it:
   *  the radius clamps at 9px from access_count ≈ 23 up, so sorting on
   *  radius silently made recency the primary key for every
   *  well-trafficked node. */
  accessCount: number;
  /** Where the draw loop PUT the evidence badge this frame (world coords), or
   *  null on a frame that drew none. The hit-test reads this rather than
   *  recomputing the geometry, because the second copy drifted twice over:
   *  it used `n.radius` while the draw grows the radius to 9px on hover and
   *  10px on focus (visible badge, unclickable — and a clickable circle over
   *  empty canvas), and it ran unconditionally while the draw only places a
   *  badge inside the label budget (an invisible target on every unlabelled
   *  node, swallowing the click-empty-canvas gesture that exits ego mode). */
  badge: { x: number; y: number } | null;
}

interface GEdge {
  from: string;
  to: string;
  type: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * The entity types whose colour coincides with a design token. They are NOT
 * written as literals: DOM reads the token via `var()`, canvas via the value
 * resolved at mount — so a palette change reaches both. `decision` IS the
 * life colour (decisions are this brain's main produce); `session-insight`
 * stays grey (weak signal must not read as alive). Every other species hue
 * comes from the formula-derived palette in `type-palette.ts`. See DESIGN.md
 * "Species palette".
 */
const TOKEN_TYPE_VARS: Record<string, string> = {
  decision: '--life',
  'session-insight': '--text-2',
};
const DEFAULT_TYPE_VAR = '--text-1';

/** The tokens the canvas resolves once at mount (canvas cannot read `var()`). */
const CANVAS_TOKENS = [
  '--life', '--life-hover',
  '--text-0', '--text-1', '--text-2', '--text-3',
  '--bg-0', '--bg-1', '--font-ui', '--mono',
] as const;

/** DOM swatch/legend colour — a CSS value (`var()` for token types, else the
 *  categorical literal). */
function typeColorCss(type: string): string {
  const v = TOKEN_TYPE_VARS[type];
  if (v) return `var(${v})`;
  return CATEGORICAL_TYPE_COLORS[type] ?? `var(${DEFAULT_TYPE_VAR})`;
}

/** Canvas node colour — token types come from the resolved values, not `var()`.
 *  An empty resolved value is left empty on purpose (a visible signal the
 *  palette did not load), never swapped for a literal fallback. */
function typeColorCanvas(type: string, r: ResolvedTokens): string {
  const v = TOKEN_TYPE_VARS[type];
  if (v) return r[v] ?? '';
  return CATEGORICAL_TYPE_COLORS[type] ?? (r[DEFAULT_TYPE_VAR] ?? '');
}

/** Drift Mode: interpolate stale (danger-ish red) → fresh (life green) by
 *  recency 0.15–1.0. A fixed semantic ramp, drawn on canvas; the endpoints
 *  are the drift scale itself, not palette tokens. */
function getDriftColor(recency: number): string {
  const t = Math.max(0, Math.min(1, (recency - 0.15) / 0.85));
  const r = Math.round(248 + (143 - 248) * t);
  const g = Math.round(113 + (242 - 113) * t);
  const b = Math.round(113 + (92 - 113) * t);
  return `rgb(${r},${g},${b})`;
}

/**
 * Scale radius by access_count using log2 so high-traffic nodes stand out —
 * inside a deliberately TIGHT band (3.5–9px). The earlier 5–14px band let one
 * hub dwarf the field and collide with its neighbours' labels; a narrow band
 * keeps hubs readable as "bigger" without letting size dominate the layout.
 * (Same reasoning as sigma-based graph UIs that clamp to ~2–12px.)
 */
function computeRadius(accessCount: number | undefined): number {
  // Domain guard: a negative or non-finite count reaching Math.log2 puts
  // NaN into ctx.arc, which throws and kills the animation frame — a blank
  // graph from one corrupt row.
  const n = Number.isFinite(accessCount) && (accessCount as number) > 0 ? (accessCount as number) : 0;
  if (n === 0) return 3.5;
  return Math.min(9, 3.5 + Math.log2(n + 1) * 1.2);
}

/**
 * Darken a resolved CSS color for the node rim. The rim is the node's OWN
 * hue stepped darker — category information restated at the boundary, which
 * is what makes adjacent same-colour nodes read as separate objects instead
 * of one blob. Accepts the `rgb()`/`#hex` strings getComputedStyle returns.
 * Unparseable input comes back UNCHANGED — and note what that means at the
 * call site: assigning an invalid string to ctx.strokeStyle is silently
 * IGNORED by canvas, which keeps its previous colour. Both real palettes
 * (global.css tokens, CATEGORICAL_TYPE_COLORS) resolve to 6-digit hex, so
 * that path is only reachable when tokens are missing entirely (unit
 * tests); documented so nobody mistakes the passthrough for a signal.
 */
function darkenColor(color: string, factor = 0.55): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const v = parseInt(hex[1], 16);
    const r = Math.round(((v >> 16) & 255) * factor);
    const g = Math.round(((v >> 8) & 255) * factor);
    const b = Math.round((v & 255) * factor);
    return `rgb(${r},${g},${b})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color.trim());
  if (rgb) {
    return `rgb(${Math.round(+rgb[1] * factor)},${Math.round(+rgb[2] * factor)},${Math.round(+rgb[3] * factor)})`;
  }
  return color;
}

/** Deterministic string hash (djb2) — position jitter and edge sampling must
 *  be stable across reloads, or the graph reshuffles every visit. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Compute recency (0.15–1.0) from a date string. */
function computeRecency(dateStr: string | undefined): number {
  if (!dateStr) return 0.15;
  const ageMs = Date.now() - new Date(dateStr).getTime();
  return Math.max(0.15, 1 - Math.min(1, ageMs / (30 * 86400000)));
}

/** Format age for tooltip: "today", "3d ago", "2w ago", "45d ago". */
function formatAge(dateStr: string): string {
  const ageMs = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ageMs / 86400000);
  if (days < 1) return t('graph.ageToday');
  if (days < 7) return t('graph.ageDaysAgo', { count: days });
  if (days < 30) return t('graph.ageWeeksAgo', { count: Math.floor(days / 7) });
  return t('graph.ageDaysAgo', { count: days });
}

/** Cap a headline for canvas drawing. Canvas text is drawn, not wrapped, and a
 *  headline is a title (up to TITLE_MAX_LENGTH = 200) or a whole observation
 *  (unbounded) — the machine name the canvas used to draw was short by
 *  construction, so nothing capped it. Uncapped, a label runs clear across the
 *  stage and a tooltip line makes its box wider than the canvas. */
function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 2) + '...' : s;
}

declare global {
  interface Window { __graphReheat?: () => void; }
}

// Tuned to fit a 1440x900 viewport after header (~44px) + nav (~44px) +
// stats row (~80px) + card padding (12+8) + filter strip (~36px). At 500
// the canvas was overflowing the viewport bottom.
const CANVAS_HEIGHT = 440;
const CLICK_THRESHOLD = 4; // px — drag vs click detection

/**
 * Node budget for the simulation. The repulsion pass is O(n²) per animation
 * frame and the server sends EVERY signal entity uncapped (only noise types
 * are capped at 200 server-side) — a few thousand entities is not a slow
 * graph, it is a frozen tab. Above the cap, keep the most-recalled (then
 * most-recent) nodes and SAY SO in the stats row: a communicated limit,
 * never a silent drop.
 *
 * 1500 nodes ≈ 1.1M pair checks per frame — still interactive on ordinary
 * hardware; the pre-existing >300px distance skip thins the constant further.
 */
export const GRAPH_NODE_CAP = 1500;

/** The nodes that survive the budget: most-recalled first, recency as the
 *  tiebreak — the same "show me useful things" order BrowseTab defaults to. */
export function capGraphEntities(entities: Entity[], cap: number = GRAPH_NODE_CAP): Entity[] {
  if (entities.length <= cap) return entities;
  return [...entities]
    .sort((a, b) =>
      (b.access_count ?? 0) - (a.access_count ?? 0)
      || (b.last_accessed_at ?? b.created_at).localeCompare(a.last_accessed_at ?? a.created_at))
    .slice(0, cap);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function GraphTab({ dataRevision = 0 }: { dataRevision?: number }) {
  const [data, setData] = useState<GraphData | null>(null);
  // Two-layer state (UX-4). `layer` is what the user asked for; `activeLayer`
  // is what is actually on screen — they differ exactly when the work layer
  // was too small to draw and the tab fell back, which the note below the
  // toggle reports. A silent fallback would be the same defect R2 removed
  // from recall.
  const [layer, setLayer] = useState<'work' | 'all'>('work');
  const [activeLayer, setActiveLayer] = useState<'work' | 'all'>('work');
  const [fellBack, setFellBack] = useState(false);
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({});
  const [evidenceNode, setEvidenceNode] = useState<GNode | null>(null);
  // The pre-cap count. `data.entities` holds at most GRAPH_NODE_CAP nodes;
  // the stats row keeps reporting the real library size next to the cap note.
  const [totalEntities, setTotalEntities] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);

  // UI state
  const [typeFilters, setTypeFilters] = useState<Record<string, boolean>>({});
  const [signalMode] = useSignalMode();
  const [searchQuery, setSearchQuery] = useState('');
  const [egoNodeId, setEgoNodeId] = useState<string | null>(null);
  const [driftMode, setDriftMode] = useState(false);

  // Refs for canvas animation loop
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GNode[]>([]);
  const edgesRef = useRef<GEdge[]>([]);
  /** The bright-skeleton edge set — see the backbone block in the loader. */
  const backboneRef = useRef<Set<GEdge>>(new Set());
  const animRef = useRef<number>(0);
  // Viewport transform: world = (screen - rect.{left,top} - {panX,panY}) / scale.
  // Render applies setTransform(scale*dpr, 0, 0, scale*dpr, panX*dpr, panY*dpr)
  // so node coords stay authored in world-space; only hit-tests + render
  // change. Defaults: identity (panX=panY=0, scale=1).
  const viewportRef = useRef<{ scale: number; panX: number; panY: number }>({
    scale: 1,
    panX: 0,
    panY: 0,
  });
  // panRef tracks an in-progress background pan (started on empty-area
  // mousedown). dragRef remains the per-node grab state.
  const panRef = useRef<{
    active: boolean;
    startScreenX: number;
    startScreenY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  }>({ active: false, startScreenX: 0, startScreenY: 0, startPanX: 0, startPanY: 0, moved: false });
  const dragRef = useRef<{
    node: GNode | null;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    dragged: boolean;
  }>({ node: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, dragged: false });
  const hoverRef = useRef<GNode | null>(null);
  const tooltipRef = useRef<{ x: number; y: number; node: GNode | null }>({
    x: 0,
    y: 0,
    node: null,
  });
  const canvasWidthRef = useRef(800);
  // Palette resolved from the live stylesheet at mount — canvas cannot read a
  // CSS custom property. See lib/tokens.ts and DESIGN.md.
  const tokensRef = useRef<ResolvedTokens>({});

  // Keep latest state in refs so the animation closure can read them
  const typeFiltersRef = useRef(typeFilters);
  const searchQueryRef = useRef(searchQuery);
  const egoNodeIdRef = useRef(egoNodeId);
  const driftModeRef = useRef(driftMode);
  // Signal Mode is READ when a payload is applied (it seeds the type filters)
  // and must never TRIGGER a load. Read from state, it made `applyGraph` a new
  // function on every toggle, and `applyGraph` is a dependency of the loader —
  // so the header's Signal/All button refetched the graph over HTTP, blanked
  // the canvas through the loading gate and closed an open evidence
  // drill-down, for a toggle the `[signalMode, data]` effect below already
  // applies in place.
  const signalModeRef = useRef(signalMode);
  useEffect(() => { typeFiltersRef.current = typeFilters; }, [typeFilters]);

  // When the global Signal Mode toggles, snap the NOISE-type filters
  // to match the new mode. User-curated signal types (lesson_learned,
  // decision, etc.) keep whatever the user set them to — only the
  // server-declared noise list flips. If signalMode goes ON, hide
  // noise; if OFF, show it.
  useEffect(() => {
    if (!data) return;
    const noise = new Set(data.noiseTypes ?? []);
    setTypeFilters((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const t of noise) {
        const desired = !signalMode;
        if (next[t] !== desired) {
          next[t] = desired;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [signalMode, data]);
  useEffect(() => { searchQueryRef.current = searchQuery; }, [searchQuery]);
  useEffect(() => { egoNodeIdRef.current = egoNodeId; }, [egoNodeId]);
  useEffect(() => { driftModeRef.current = driftMode; }, [driftMode]);
  useEffect(() => { signalModeRef.current = signalMode; }, [signalMode]);

  // Everything both layers do with a payload once it has arrived: the shape
  // guard, the physics cap, and the initial type filters. A shape mismatch
  // used to reach the user as "Cannot read properties of undefined (reading
  // 'forEach')" — every read below is unconditional and the loader's own
  // `.catch` swallowed the TypeError, so CI saw no unhandled rejection. The
  // guard makes a bad payload read as "did not load" instead.
  const applyGraph = useCallback((d: GraphData) => {
    if (!isGraphRenderable(d)) {
      // Loudly: the request succeeded, so nothing else will ever log this.
      console.warn('[memesh dashboard] /v1/graph answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', d);
      setFailure('unreadable');
      return;
    }
    setFailure(null);
    // The physics budget: everything below (filters, counts, canvas)
    // works on the capped set; only the stats row knows the real total.
    const capped = capGraphEntities(d.entities);
    if (capped.length < d.entities.length) {
      console.info(
        `[memesh dashboard] graph capped at ${capped.length} of ${d.entities.length} entities — the O(n²) simulation freezes the tab beyond this; showing the most-recalled nodes.`,
      );
    }
    setTotalEntities(d.entities.length);
    setData({ ...d, entities: capped });
    // Init type filters from the server-supplied noise list. When
    // global Signal Mode is ON we hide noise by default; when it
    // is OFF the user explicitly opted into "show everything," so
    // every type starts checked.
    const noise = new Set(Array.isArray(d.noiseTypes) ? d.noiseTypes : []);
    const types: Record<string, boolean> = {};
    const hideNoise = signalModeRef.current;
    capped.forEach((e) => {
      types[e.type] = types[e.type] ?? (hideNoise ? !noise.has(e.type) : true);
    });
    setTypeFilters(types);
    // Empty deps on purpose — see signalModeRef above. This callback is a
    // dependency of the loader, so anything it closes over becomes a refetch.
  }, []);

  /* ----- data fetch ----- */
  // One loader for both layers. The work layer is tried first (it is the
  // question the tab exists to answer — "what was decided / learned"); when
  // it holds too few nodes to be a graph the full graph is fetched instead
  // and `fellBack` makes that visible. `evidenceCounts` only has meaning in
  // the work view, so it is cleared on the way into the full one.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    setEvidenceNode(null);
    const loadFull = () => fetchGraph().then((d) => {
      if (cancelled) return;
      setActiveLayer('all');
      setEvidenceCounts({});
      applyGraph(d);
    });

    const run = layer === 'all'
      ? (setFellBack(false), loadFull())
      : fetchWorkGraph().then((wg: WorkGraphData) => {
          if (cancelled) return undefined;
          if (!isWorkGraphRenderable(wg)) {
            console.warn('[memesh dashboard] /v1/graph?layer=work answered with a shape this bundle cannot render:', wg);
            setFailure('unreadable');
            setData(null);
            return undefined;
          }
          if (wg.entities.length < WORK_LAYER_MIN_NODES) {
            setFellBack(true);
            return loadFull();
          }
          setFellBack(false);
          setActiveLayer('work');
          setEvidenceCounts(wg.evidenceCounts);
          // The work layer carries no noise types — every type in it is
          // signal by definition — so the full-graph shape is completed
          // with an empty list rather than leaving the field undefined for
          // the filter code to read.
          applyGraph({ ...wg, noiseTypes: [] });
          return undefined;
        });

    Promise.resolve(run)
      .catch((e) => {
        if (cancelled) return;
        console.warn('[memesh dashboard] graph failed to load:', e);
        setFailure(classifyLoadError(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Complete deps, and deliberately cheap: `applyGraph` is stable (empty
    // deps), so the only thing that re-runs this loader is a layer switch.
  }, [layer, applyGraph, dataRevision]);


  // ONE derivation of the human-readable headline for the whole tab: the
  // canvas labels, the tooltip, the search predicates and the match count all
  // read this map. A second copy of the chain is how the match count and the
  // highlighted nodes drift apart — and it is how the tooltip ended up with a
  // hand-rolled `title || type · age`, skipping the middle step and hiding the
  // observation Memories shows for the same entity.
  const displayIndex = useMemo(() => {
    const index = new Map<string, { display: string; search: string }>();
    if (!data) return index;
    for (const e of data.entities) {
      const display = displayTitle(e);
      index.set(e.name, { display, search: `${e.name} ${display}`.toLowerCase() });
    }
    return index;
  }, [data]);

  /* ----- build graph & start simulation ----- */
  useEffect(() => {
    if (!data || loading) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Resolve the palette once now the canvas is in the DOM; the draw loop
    // reads tokensRef.current every frame.
    tokensRef.current = resolveTokens(canvas, CANVAS_TOKENS);

    // getBoundingClientRect()/floor catches sub-pixel layout that
    // clientWidth rounds away. Subtract the card's horizontal padding
    // (12px each side) so the canvas can't end up wider than its
    // container — the cause of horizontal scrollbars on the card.
    const parentRect = canvas.parentElement?.getBoundingClientRect();
    const w = parentRect ? Math.floor(parentRect.width) - 24 : 800;
    const h = CANVAS_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvasWidthRef.current = w;

    // Build node set + compute connected set for orphan detection
    const connectedNodes = new Set<string>();
    data.relations.forEach((r) => {
      connectedNodes.add(r.from);
      connectedNodes.add(r.to);
    });

    // Seeded initial positions, not Math.random(). Each TYPE is a cluster
    // seeded on a golden-angle spiral around the canvas centre; members pack
    // inside their cluster on a sqrt-radial spiral with name-hash jitter.
    // Two payoffs: the simulation starts near equilibrium (it only has to
    // relax, not untangle), and the SAME data produces the SAME shape on
    // every reload — a graph that reshuffles per visit cannot be learned.
    // "Same shape" requires CONTENT-derived slots: the server orders
    // entities by last-recall time, so anything keyed on response order
    // (the first cut used arrival index) re-dealt every cluster on every
    // recall. Slots come from the name-sorted member list instead.
    const GOLDEN_ANGLE = 2.399963229728653;
    const cx = w / 2, cy = h / 2;
    const types = [...new Set(data.entities.map((e) => e.type))].sort();
    const clusterCentre = new Map<string, { x: number; y: number }>();
    // Spiral radii scaled PER AXIS: the stage is ~2.4× wider than tall, and
    // a min(w,h) radius used ~44% of the width — clusters overlapped
    // laterally while both sides of the canvas sat empty.
    const maxSpiralX = w * 0.42;
    const maxSpiralY = h * 0.42;
    types.forEach((type, i) => {
      const f = Math.sqrt((i + 1) / types.length);
      const angle = i * GOLDEN_ANGLE;
      clusterCentre.set(type, {
        x: cx + Math.cos(angle) * maxSpiralX * f,
        y: cy + Math.sin(angle) * maxSpiralY * f,
      });
    });
    // Deterministic intra-cluster slot: index in the name-sorted member list.
    const slotByName = new Map<string, number>();
    for (const type of types) {
      data.entities
        .filter((e) => e.type === type)
        .map((e) => e.name)
        .sort()
        .forEach((name, i) => slotByName.set(name, i));
    }
    // Members must SEED on the stage: the sqrt spiral is capped against the
    // short axis (a big cluster packs denser rather than seeding past the
    // canvas edge and flying back in over the first frames), and the seed
    // point is clamped with a margin as the last line of defence.
    const spreadCap = Math.min(w, h) * 0.18;

    const nodeMap = new Map<string, GNode>();
    data.entities.forEach((e: Entity) => {
      const lastDate = e.last_accessed_at || e.created_at;
      const centre = clusterCentre.get(e.type)!;
      const k = slotByName.get(e.name)!;
      const hash = hashString(e.name);
      const angle = k * GOLDEN_ANGLE + (hash % 100) / 100;
      const spread = Math.min(spreadCap, 14 + Math.sqrt(k) * 16 + (hash % 7));
      // Non-null: `displayIndex` is keyed off THIS entity list and rebuilt
      // with it, so a miss would mean the two came from different payloads.
      const shown = displayIndex.get(e.name)!;
      nodeMap.set(e.name, {
        id: e.name,
        display: shown.display,
        searchText: shown.search,
        type: e.type,
        x: Math.min(w - 16, Math.max(16, centre.x + Math.cos(angle) * spread)),
        y: Math.min(h - 16, Math.max(16, centre.y + Math.sin(angle) * spread)),
        vx: 0,
        vy: 0,
        radius: computeRadius(e.access_count),
        recency: computeRecency(lastDate),
        isOrphan: !connectedNodes.has(e.name),
        lastDate,
        accessCount: Math.max(0, e.access_count ?? 0),
        evidenceCount: evidenceCounts[e.name] ?? 0,
        badge: null,
      });
    });
    // Label-budget order: RAW traffic first, recency as the tiebreak, name
    // as the deterministic last resort. Not radius — the radius clamps at
    // 9px from access_count ≈ 23 up, and ranking on it made recency the
    // primary key for every well-trafficked node (a 24-recall newcomer
    // outranked a 10 000-recall hub).
    //
    // The work layer ranks differently, and the reason is measured. Traffic
    // is a proxy for "has been useful for a while", which is exactly wrong
    // for a decision made this morning: on the live graph the newest
    // decisions carry access_count 0 and would be the LAST thing named. The
    // work layer ranks by recency, then by how much evidence supports the
    // node, then name. Status is deliberately not a key here: of 53 active
    // work entities measured 2026-08-17, zero were the target of a
    // `supersedes` edge — supersession archives the loser, and this view is
    // active-only, so a status axis would rank on a field that is constant.
    const rankedNodes = Array.from(nodeMap.values()).sort(
      activeLayer === 'work'
        ? (a, b) =>
            b.recency - a.recency
            || b.evidenceCount - a.evidenceCount
            || a.id.localeCompare(b.id)
        : (a, b) =>
            b.accessCount - a.accessCount
            || b.recency - a.recency
            || a.id.localeCompare(b.id),
    );
    nodesRef.current = Array.from(nodeMap.values());
    edgesRef.current = data.relations.filter(
      (r) => nodeMap.has(r.from) && nodeMap.has(r.to),
    );
    // Dense-graph sampling set, PRECOMPUTED: the render loop used to hash
    // both endpoint names per edge per frame — load-constant work in the
    // hottest loop. djb2's low bits are also weak (h mod 4 is close to a
    // character-sum parity), so fold the high bits in before bucketing.
    const denseKeep = new Set<GEdge>();
    for (const edge of edgesRef.current) {
      const hsh = hashString(edge.from + ' ' + edge.to);
      if (((hsh ^ (hsh >>> 16)) & 3) === 0) denseKeep.add(edge);
    }

    // Backbone: the ≤128 highest-priority edges (≤5 per node), drawn brighter
    // than the rest so the graph's SHAPE stays readable while the remaining
    // edges recede. Priority = geometric mean of endpoint log-traffic (raw
    // counts — the clamped radius degenerated to a constant 9 between hubs)
    // scaled by the staler endpoint's recency; the same signal the label
    // budget uses, so the bright skeleton and the labelled nodes tell one
    // story.
    //
    // Computed per VIEW, not once: chosen globally, a filtered or ego view
    // can contain zero backbone edges, leaving the whole visible
    // neighbourhood on the faint layer (~0.08 effective alpha — invisible).
    // The render loop re-picks it whenever the visibility signature
    // (type filters + ego) changes.
    const computeBackbone = (edgeList: GEdge[]): Set<GEdge> => {
      const perNode = new Map<string, number>();
      const scored = edgeList
        .map((e) => {
          const a = nodeMap.get(e.from)!;
          const b = nodeMap.get(e.to)!;
          const traffic = Math.sqrt(
            Math.log2(a.accessCount + 2) * Math.log2(b.accessCount + 2),
          );
          return { e, p: traffic * Math.min(a.recency, b.recency) };
        })
        .sort((x, y) => y.p - x.p);
      const backbone = new Set<GEdge>();
      for (const { e } of scored) {
        if (backbone.size >= 128) break;
        const fa = perNode.get(e.from) ?? 0;
        const fb = perNode.get(e.to) ?? 0;
        if (fa >= 5 || fb >= 5) continue;
        backbone.add(e);
        perNode.set(e.from, fa + 1);
        perNode.set(e.to, fb + 1);
      }
      return backbone;
    };
    // null = not yet computed; the first frame computes it from the actual
    // visible edge set, so a filter restored from state is respected from
    // frame one.
    let backboneSig: string | null = null;

    /* ---------- visibility helpers (read from refs) ---------- */
    const isNodeVisible = (n: GNode): boolean => {
      const filters = typeFiltersRef.current;
      if (filters[n.type] === false) return false;

      const egoId = egoNodeIdRef.current;
      if (egoId) {
        if (n.id === egoId) return true;
        // 1-degree neighbor?
        const isNeighbor = edgesRef.current.some(
          (e) =>
            (e.from === egoId && e.to === n.id) ||
            (e.to === egoId && e.from === n.id),
        );
        return isNeighbor;
      }
      return true;
    };

    const isEdgeVisible = (e: GEdge): boolean => {
      const fromNode = nodeMap.get(e.from);
      const toNode = nodeMap.get(e.to);
      if (!fromNode || !toNode) return false;
      return isNodeVisible(fromNode) && isNodeVisible(toNode);
    };

    // Name AND headline — the same haystack the match count reads. Testing
    // the machine name alone meant a user who typed the words they can SEE on
    // this canvas got "0 matches" back from it.
    const isSearchMatch = (n: GNode): boolean => {
      const q = searchQueryRef.current.toLowerCase();
      if (!q) return false;
      return n.searchText.includes(q);
    };

    /* ---------- simulation loop ---------- */
    // Cooling — D3-force-style. alpha decays from 1.0 toward 0; once it
    // hits zero the simulate() inner loop short-circuits its physics so
    // the graph truly settles instead of jittering forever. Earlier this
    // floored at 0.001, which scaled repulsion to a tiny non-zero value
    // every frame and produced the slow "drifting dots" the user noticed.
    let alpha = 1.0;
    const alphaDecay = 0.005;

    // Expose reheat function for drag/filter changes
    const reheat = () => { alpha = 0.3; };
    window.__graphReheat = reheat;

    const simulate = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const tk = tokensRef.current;
      const curDpr = window.devicePixelRatio || 1;

      // Cool down — clamp at exactly 0 so we can short-circuit force
      // accumulation once the graph has settled. Render still runs, so
      // hover highlights / selection halos keep working.
      alpha = Math.max(0, alpha - alphaDecay);
      const physicsActive = alpha > 0;

      // Physics constants (scaled by alpha)
      const damping = 0.85;
      const repulsion = 2000 * alpha;
      const springLen = 80;
      const springK = 0.02 * alpha;
      // centerForce previously 0.005 — too weak to reel in isolated
      // (orphan) nodes that get pushed to the canvas edges by repulsion
      // and then clamped there. Bumped to 0.02 (4× stronger) so disconnected
      // entities settle near the cluster instead of pinning to corners.
      const centerForce = 0.02 * alpha;
      const largeN = nodes.length > 200;

      // Single nodeById built once per frame, shared by both spring-force
      // (when physics is hot) and edge rendering (always). Earlier this
      // was rebuilt twice per frame; reviewer flagged the redundant
      // O(n) allocation.
      const cx = w / 2;
      const cy = h / 2;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // Skip force accumulation when fully cooled. Velocities are already
      // 0 (frozen below) so positions stay put without burning cycles on
      // O(n²) repulsion every frame.
      if (physicsActive) {
        // Repulsion between ALL nodes (physics runs on full set for stability)
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x;
            const dy = nodes[j].y - nodes[i].y;
            const distSq = dx * dx + dy * dy;
            // Performance: skip distant pairs for large graphs
            if (largeN && distSq > 90000) continue; // 300px
            const dist = Math.sqrt(distSq) || 1;
            const force = repulsion / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            nodes[i].vx -= fx;
            nodes[i].vy -= fy;
            nodes[j].vx += fx;
            nodes[j].vy += fy;
          }
        }

        // Spring force for edges
        for (const edge of edges) {
          const a = nodeById.get(edge.from);
          const b = nodeById.get(edge.to);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - springLen) * springK;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }

        // Center gravity
        for (const n of nodes) {
          n.vx += (cx - n.x) * centerForce;
          n.vy += (cy - n.y) * centerForce;
        }
      }

      // Apply velocities. Skip the whole loop when fully cooled AND nothing
      // is moving (no drag, no residual velocity); reviewer flagged that
      // even after settle the freeze loop ran O(n) comparisons + boundary
      // checks every frame indefinitely. With the early-out the cooled
      // graph costs ~0 per frame.
      // If a drag is in progress against a node that's no longer in the
      // current `nodes` array (e.g. data refresh swapped the array
      // mid-drag), the stale ref would make the spring-force / edge
      // render lookups silently miss for one frame. Cheap to detect:
      // if dragNode isn't in the current set, clear it so subsequent
      // frames behave normally.
      let dragNode = dragRef.current.node;
      if (dragNode && !nodes.includes(dragNode)) {
        dragRef.current.node = null;
        dragNode = null;
      }
      const skipApply = !physicsActive
        && !dragNode
        && nodes.every((n) => n.vx === 0 && n.vy === 0);
      if (!skipApply) for (const n of nodes) {
        if (dragNode === n) continue;
        n.vx *= damping;
        n.vy *= damping;
        // Freeze when nearly stopped
        if (Math.abs(n.vx) < 0.01 && Math.abs(n.vy) < 0.01) { n.vx = 0; n.vy = 0; }
        n.x += n.vx;
        n.y += n.vy;
        // Soft boundary: only clamp if a node strays well outside the
        // viewport. The previous hard clamp at 20px from each edge
        // pinned isolated nodes to corners — repulsion pushed them out,
        // weak gravity couldn't pull back, clamp held them on the
        // boundary forever. Letting nodes float to the visible edge
        // (with a generous off-screen tolerance) lets gravity reel
        // them back over a few frames instead.
        const slack = 100;
        if (n.x < -slack) n.x = -slack;
        else if (n.x > w + slack) n.x = w + slack;
        if (n.y < -slack) n.y = -slack;
        else if (n.y > h + slack) n.y = h + slack;
      }

      // --- Auto-center on single search match ---
      const q = searchQueryRef.current.toLowerCase();
      if (q) {
        // Same haystack as isSearchMatch: a query that highlights exactly one
        // node must be the query that centres it, or the auto-centre fires on
        // a different set than the glow ring.
        const matches = nodes.filter((n) => n.searchText.includes(q));
        if (matches.length === 1) {
          const target = matches[0];
          const shiftX = cx - target.x;
          const shiftY = cy - target.y;
          // Smoothly shift all nodes
          const ease = 0.05;
          for (const n of nodes) {
            n.x += shiftX * ease;
            n.y += shiftY * ease;
          }
        }
      }

      /* ---------- render ---------- */
      // Clear in screen-space (identity transform).
      ctx.setTransform(curDpr, 0, 0, curDpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Then apply viewport transform so nodes/edges are drawn in world
      // coords. Hit-tests use the inverse — see findNodeAt + getCanvasPos.
      const vp = viewportRef.current;
      ctx.setTransform(
        vp.scale * curDpr,
        0,
        0,
        vp.scale * curDpr,
        vp.panX * curDpr,
        vp.panY * curDpr,
      );

      // Collect visible edges
      const visibleEdges = edges.filter(isEdgeVisible);
      const showEdgeLabels = visibleEdges.length < 30;

      // Re-pick the backbone whenever the VIEW changes (type filters, ego).
      // A backbone chosen once over the whole graph can be entirely absent
      // from a filtered view, which would leave every visible edge on the
      // faint layer — the hairball fix rendering the filtered neighbourhood
      // invisible instead of legible.
      const visSig =
        (egoNodeIdRef.current ?? '') + '|' +
        Object.keys(typeFiltersRef.current)
          .filter((t) => typeFiltersRef.current[t] === false)
          .sort()
          .join(',');
      if (visSig !== backboneSig) {
        backboneSig = visSig;
        backboneRef.current = computeBackbone(visibleEdges);
      }

      // (nodeById was built once at the top of simulate() and is reused
      // here for edge rendering — see physics block above.)

      // Draw edges in two layers. The old renderer drew EVERY edge at the
      // same 1px/0.4-alpha accent line — at a few hundred edges that is the
      // hairball: uniform brightness carries no information. Now the
      // backbone (≤128 highest-priority edges) is drawn readable and the
      // rest recede to a faint field; on dense graphs the faint layer is
      // additionally SAMPLED deterministically (precomputed name-hash set,
      // so the same edges appear on every frame and every reload — a
      // flickering or reshuffling background would read as activity that
      // isn't there).
      const backbone = backboneRef.current;
      const denseGraph = visibleEdges.length > 400;
      const isEgoView = egoNodeIdRef.current !== null;
      for (const edge of visibleEdges) {
        const a = nodeById.get(edge.from);
        const b = nodeById.get(edge.to);
        if (!a || !b) continue;
        const onBackbone = backbone.has(edge);
        // Ego view is already a curated neighbourhood: every edge in it is
        // the information, so nothing recedes there.
        if (!onBackbone && !isEgoView) {
          if (denseGraph && !denseKeep.has(edge)) continue;
          ctx.globalAlpha = Math.min(a.recency, b.recency) * 0.22;
        } else {
          ctx.globalAlpha = Math.min(a.recency, b.recency) * 0.7;
        }
        ctx.strokeStyle = rgbaFrom(tk['--life'], onBackbone || isEgoView ? 0.5 : 0.35);
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (showEdgeLabels) {
          // Relation labels are vocabulary, not texture: they must not
          // inherit the faint edge layer's alpha (0.22×recency put them at
          // ~5% over the canvas in exactly the small filtered views this
          // branch exists for), and their size is a SCREEN size — we are
          // inside the world transform, so divide by scale.
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const edgeAlpha = ctx.globalAlpha;
          ctx.globalAlpha = Math.max(0.6, Math.min(a.recency, b.recency));
          ctx.font = `${9 / vp.scale}px ${tk['--font-ui']}`;
          ctx.fillStyle = tk['--text-2'];
          ctx.fillText(relationLabel(edge.type), mx + 2, my - 2);
          ctx.globalAlpha = edgeAlpha;
        }
      }

      ctx.globalAlpha = 1;

      // Collect visible nodes
      const visibleNodes = nodes.filter(isNodeVisible);

      // Zoom-tiered ALWAYS-ON label budget — 3 zoomed out, 12 at working
      // zoom, 28 zoomed in — allocated over what the user can actually SEE:
      // the ranking is global (traffic-then-recency), but eligibility is
      // checked against the current view (visibility filters AND viewport),
      // so a filtered, ego or zoomed-in view spends its whole budget on
      // nodes that are on screen. A global-rank cut here meant an ego view
      // of any non-hub neighbourhood carried no labels at all — in the one
      // view where names matter most — and zooming IN could show fewer
      // labels than the working zoom. Drift Mode suppresses the budget on
      // purpose: it is the ambient view; interaction labels still show.
      const labelBudget = vp.scale < 0.75 ? 3 : vp.scale < 1.5 ? 12 : 28;
      const budgeted = new Set<GNode>();
      if (!driftModeRef.current) {
        for (const rn of rankedNodes) {
          if (budgeted.size >= labelBudget) break;
          if (!isNodeVisible(rn)) continue;
          const sx = rn.x * vp.scale + vp.panX;
          const sy = rn.y * vp.scale + vp.panY;
          if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
          budgeted.add(rn);
        }
      }

      // Draw nodes
      const hoveredNode = hoverRef.current;
      for (const n of visibleNodes) {
        const isHovered = hoveredNode === n;
        const matched = isSearchMatch(n);
        const isFocusCenter = egoNodeIdRef.current === n.id;
        const r = isFocusCenter ? 10 : isHovered ? 9 : n.radius;
        // The badge's position is per-frame state, so clear it BEFORE the
        // draw decides whether to place one. Assigning only inside the badge
        // block would leave a node that drops out of the label budget
        // carrying a click target where nothing is drawn.
        n.badge = null;

        // Recency alpha: full for hovered/matched
        const alpha = isHovered || matched ? 1.0 : n.recency;
        ctx.globalAlpha = alpha;

        // Node fill
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        const fillColor = driftModeRef.current ? getDriftColor(n.recency) : typeColorCanvas(n.type, tk);
        ctx.fillStyle = fillColor;
        ctx.fill();

        // Rim: the node's own hue stepped darker. Category information
        // restated at the boundary — adjacent same-colour nodes read as
        // separate objects instead of one blob. Connected nodes only:
        // orphans keep their dashed --text-3 boundary below, which is
        // already their defined edge. Drawn under the node's recency alpha
        // on purpose — a stale node's rim fades with its fill; boundary
        // contrast belongs to the live graph, not to re-brightening old
        // nodes.
        if (!n.isOrphan) {
          ctx.strokeStyle = darkenColor(fillColor);
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Orphan dashed border
        if (n.isOrphan) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = tk['--text-3'];
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Search match glow ring
        if (matched) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = tk['--life-hover'];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Hover ring — the brightest life tone: hovering is the user's hand
        // on the living graph, and interaction states belong to the life
        // colour (DESIGN.md "Life, amber, and status"). Resolved, not
        // hardcoded, so a palette change reaches it.
        if (isHovered && !matched) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = tk['--life-hover'];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Node labels. Interaction labels (hover/search/ego) always show at
        // full strength; the always-on budget set was allocated above,
        // before this loop — a graph where no node is named until you hover
        // is a graph you cannot read; a graph where every node is named is
        // a graph you cannot see.
        const showLabel = isHovered || matched || isFocusCenter || budgeted.has(n);
        if (showLabel) {
          const interactive = isHovered || matched || isFocusCenter;
          ctx.globalAlpha = interactive ? 1 : Math.max(0.7, n.recency);
          // Label metrics are SCREEN sizes drawn inside the world
          // transform, so divide by scale — otherwise zooming out shrinks
          // the zoomed-out tier's 3 labels to unreadable specks and zooming
          // in blows 20px text and 6px halos over the graph.
          ctx.font = `${10 / vp.scale}px ${tk['--font-ui']}`;
          // The headline, not the machine name — see GNode.display. Searched
          // and focused nodes get a wider cap because they are the node the
          // user asked about; both are capped now, which the old code did not
          // need to do when it was drawing a name.
          const label =
            matched || isFocusCenter
              ? ellipsize(n.display, 48)
              : ellipsize(n.display, 20);
          // Halo: the label stroked in the canvas background colour
          // (--bg-0 — the canvas element's actual background) before the
          // fill, so text stays legible when it crosses nodes or edges.
          // Legibility is information; this is not a decorative glow.
          ctx.strokeStyle = tk['--bg-0'];
          ctx.lineWidth = 3 / vp.scale;
          ctx.strokeText(label, n.x + r + 4, n.y + 3);
          ctx.fillStyle = interactive ? tk['--text-1'] : tk['--text-2'];
          ctx.fillText(label, n.x + r + 4, n.y + 3);
          ctx.globalAlpha = alpha;
        }

        // Evidence badge — how much mechanical capture supports this work
        // item. Drawn under the SAME budget as the label (plus interaction),
        // because a badge on every node at zoomed-out scale is the same
        // unreadable field the label budget exists to prevent. Screen-
        // constant size, like the label, so zoom does not change its meaning.
        // Kept off the full-graph view: there `evidenceCount` is 0 for every
        // node and a universal "0" is noise, not information.
        if (n.evidenceCount > 0 && showLabel) {
          const br = BADGE_R / vp.scale;
          const bx = n.x + r * 0.8;
          const by = n.y - r * 0.8;
          // Publish where it landed. The hit-test reads this instead of
          // recomputing `n.radius * 0.8` — `r` above is 9 or 10px on a hovered
          // or focused node, so the recomputed copy pointed at a badge that
          // was not there.
          n.badge = { x: bx, y: by };
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = tk['--bg-0'];
          ctx.fill();
          ctx.strokeStyle = tk['--life'];
          ctx.lineWidth = 1 / vp.scale;
          ctx.stroke();
          ctx.font = `${7 / vp.scale}px ${tk['--mono']}`;
          ctx.fillStyle = tk['--life'];
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Three digits do not fit a 5px badge; 99+ is the honest cap.
          ctx.fillText(n.evidenceCount > 99 ? '99+' : String(n.evidenceCount), bx, by);
          ctx.textAlign = 'start';
          ctx.textBaseline = 'alphabetic';
          ctx.globalAlpha = alpha;
        }
      }

      ctx.globalAlpha = 1;

      // Tooltip — draw in SCREEN space (reset transform) so tooltip text
      // size and position stay constant regardless of zoom level.
      // tooltipRef.{x,y} is already in screen coords (canvas rect-local).
      const tip = tooltipRef.current;
      if (tip.node && isNodeVisible(tip.node)) {
        ctx.setTransform(curDpr, 0, 0, curDpr, 0, 0);
        const tx = tip.x + 12;
        const ty = tip.y - 10;
        // Headline, then the metadata line. This used to reimplement the
        // display chain as `title || type · age` and skip its middle step, so
        // an untitled entity showed its best observation in Memories and only
        // "type · age" here — and the one-line branch existed precisely
        // because line1 was then a copy of line2. With a real headline in
        // line1 that branch is dead. (When the headline IS the type+date
        // fallback — an entity with no title and no observations — line2 still
        // adds the age, so the two lines never say the same thing twice.)
        const typeTxt = typeLabel(tip.node.type);
        const ageTxt = formatAge(tip.node.lastDate);
        const line1 = ellipsize(tip.node.display, 64);
        const line2 = `${typeTxt}  |  ${ageTxt}`;
        ctx.font = `11px ${tk['--font-ui']}`;
        const w1 = ctx.measureText(line1).width;
        const w2 = ctx.measureText(line2).width;
        const boxW = Math.max(w1, w2) + 12;
        const boxH = 34;
        // Tooltip panel: translucent panel bg + accent hairline, both built from
        // the resolved tokens (--bg-1 / --life) so a palette change reaches the
        // canvas — semi-transparent so the graph shows through.
        ctx.fillStyle = rgbaFrom(tk['--bg-1'], 0.92);
        ctx.strokeStyle = rgbaFrom(tk['--life'], 0.3);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx - 4, ty - 18, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tk['--text-0'];
        ctx.fillText(line1, tx, ty - 4);
        ctx.fillStyle = tk['--text-2'];
        ctx.font = `10px ${tk['--mono']}`;
        ctx.fillText(line2, tx, ty + 10);
      }

      animRef.current = requestAnimationFrame(simulate);
    };

    animRef.current = requestAnimationFrame(simulate);
    return () => cancelAnimationFrame(animRef.current);
    // activeLayer/evidenceCounts are read when the nodes are built (badge
    // counts) and when they are ranked, so the simulation must rebuild when
    // the layer changes — not only when `data` does. displayIndex is derived
    // from `data` alone, so it adds no rebuild of its own.
  }, [data, loading, activeLayer, evidenceCounts, displayIndex]);

  /* ---------- hit-test (only visible nodes) ----------
   * `wx`/`wy` are WORLD coords (already inverse-transformed). Hit radius
   * is divided by current zoom so the on-screen hit area stays constant
   * (~12px) even when the user has zoomed in/out. */
  const findNodeAt = useCallback((wx: number, wy: number): GNode | null => {
    const nodes = nodesRef.current;
    const filters = typeFiltersRef.current;
    const egoId = egoNodeIdRef.current;
    const scale = viewportRef.current.scale || 1;
    const hitR = 12 / scale; // keep ~12 screen pixels regardless of zoom
    const hitR2 = hitR * hitR;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (filters[n.type] === false) continue;
      if (egoId && n.id !== egoId) {
        const isNeighbor = edgesRef.current.some(
          (e) => (e.from === egoId && e.to === n.id) || (e.to === egoId && e.from === n.id),
        );
        if (!isNeighbor) continue;
      }
      const dx = n.x - wx;
      const dy = n.y - wy;
      if (dx * dx + dy * dy < hitR2) return n;
      // The evidence badge is a visible part of the node and must be clickable
      // as one — a target you can see and cannot hit is worse than no target.
      // The reverse is worse still, and both used to happen: this recomputed
      // the badge's place from `n.radius` while the draw call grows the radius
      // on hover and focus, and it ran for every node with evidence while the
      // draw only places a badge inside the label budget — so an unlabelled
      // node carried an invisible target that ate the click-empty-canvas
      // gesture. Reading the drawn position removes the copy rather than
      // syncing it: `n.badge` is null on every frame no badge was drawn.
      if (n.badge) {
        const br = BADGE_R / scale;
        const bdx = n.badge.x - wx;
        const bdy = n.badge.y - wy;
        if (bdx * bdx + bdy * bdy < br * br) return n;
      }
    }
    return null;
  }, []);

  /** Returns SCREEN coords (inside canvas rect) — used for tooltip + pan tracking. */
  const getCanvasPos = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  /** Inverse viewport transform: screen rect-local coords → world coords. */
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const vp = viewportRef.current;
    return {
      x: (sx - vp.panX) / vp.scale,
      y: (sy - vp.panY) / vp.scale,
    };
  }, []);

  /* ---------- pointer handlers ----------
   * Pointer events, not mouse events, so touch and pen pan/drag/select the
   * same paths as a mouse — the whole tab was unusable on a touch device with
   * mouse-only handlers. `touch-action: none` on the canvas (see JSX) stops the
   * browser scrolling/zooming the page instead, and setPointerCapture keeps a
   * drag tracking after the pointer leaves the canvas bounds.
   * Conventions:
   *   - getCanvasPos(e) returns SCREEN coords inside the canvas rect.
   *   - screenToWorld(sx, sy) converts to WORLD coords (the space nodes
   *     are authored in). Hit-test + node-drag live in world space.
   *   - Background pan tracks deltas in SCREEN space and writes to
   *     viewportRef.{panX,panY} (also a screen-space offset). */
  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      canvasRef.current?.setPointerCapture?.(e.pointerId);
      const screen = getCanvasPos(e);
      const world = screenToWorld(screen.x, screen.y);
      const node = findNodeAt(world.x, world.y);
      if (node) {
        // Grab a node
        window.__graphReheat?.();
        dragRef.current = {
          node,
          offsetX: world.x - node.x,
          offsetY: world.y - node.y,
          startX: screen.x,
          startY: screen.y,
          dragged: false,
        };
        panRef.current.active = false;
      } else {
        // Pan the viewport — start tracking screen-delta from current pan.
        const vp = viewportRef.current;
        panRef.current = {
          active: true,
          startScreenX: screen.x,
          startScreenY: screen.y,
          startPanX: vp.panX,
          startPanY: vp.panY,
          moved: false,
        };
        dragRef.current = {
          node: null,
          offsetX: 0,
          offsetY: 0,
          startX: screen.x,
          startY: screen.y,
          dragged: false,
        };
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grabbing';
      }
    },
    [findNodeAt, getCanvasPos, screenToWorld],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const screen = getCanvasPos(e);
      const world = screenToWorld(screen.x, screen.y);
      const drag = dragRef.current;
      const pan = panRef.current;

      if (drag.node) {
        // Node drag — author in world coords.
        const dxScreen = screen.x - drag.startX;
        const dyScreen = screen.y - drag.startY;
        if (dxScreen * dxScreen + dyScreen * dyScreen > CLICK_THRESHOLD * CLICK_THRESHOLD) {
          drag.dragged = true;
        }
        drag.node.x = world.x - drag.offsetX;
        drag.node.y = world.y - drag.offsetY;
        drag.node.vx = 0;
        drag.node.vy = 0;
      } else if (pan.active) {
        // Background pan — track screen-delta.
        const dx = screen.x - pan.startScreenX;
        const dy = screen.y - pan.startScreenY;
        if (dx * dx + dy * dy > CLICK_THRESHOLD * CLICK_THRESHOLD) {
          pan.moved = true;
        }
        viewportRef.current.panX = pan.startPanX + dx;
        viewportRef.current.panY = pan.startPanY + dy;
      }

      const node = findNodeAt(world.x, world.y);
      hoverRef.current = node;
      // Tooltip is drawn in screen space, so store screen coords.
      tooltipRef.current = node
        ? { x: screen.x, y: screen.y, node }
        : { x: 0, y: 0, node: null };
      const canvas = canvasRef.current;
      if (canvas) {
        if (drag.node) {
          canvas.style.cursor = 'grabbing';
        } else if (pan.active) {
          canvas.style.cursor = 'grabbing';
        } else if (node) {
          canvas.style.cursor = egoNodeIdRef.current ? 'pointer' : 'grab';
        } else {
          canvas.style.cursor = 'grab';
        }
      }
    },
    [findNodeAt, getCanvasPos, screenToWorld],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      canvasRef.current?.releasePointerCapture?.(e.pointerId);
      const drag = dragRef.current;
      const pan = panRef.current;
      const screen = getCanvasPos(e);
      const world = screenToWorld(screen.x, screen.y);

      if (drag.node && !drag.dragged) {
        // Click on a node — toggle ego mode.
        setEgoNodeId((prev) => (prev === drag.node!.id ? null : drag.node!.id));
        // …and in the work view, open (or switch) the evidence drill-down.
        // Clicking the SAME node again closes both, so one gesture never
        // leaves the panel showing a node that is no longer focused.
        const clicked = drag.node;
        setEvidenceNode((prev) => (prev?.id === clicked.id ? null : clicked));
      } else if (!drag.node && pan.active && !pan.moved) {
        // Click on empty canvas (no pan happened) — exit ego mode.
        const nodeAtPos = findNodeAt(world.x, world.y);
        if (!nodeAtPos) {
          setEgoNodeId(null);
          setEvidenceNode(null);
        }
      }

      dragRef.current = {
        node: null,
        offsetX: 0,
        offsetY: 0,
        startX: 0,
        startY: 0,
        dragged: false,
      };
      panRef.current.active = false;
      panRef.current.moved = false;

      const canvas = canvasRef.current;
      if (canvas) {
        const hovered = findNodeAt(world.x, world.y);
        canvas.style.cursor = hovered ? (egoNodeIdRef.current ? 'pointer' : 'grab') : 'grab';
      }
    },
    [findNodeAt, getCanvasPos, screenToWorld],
  );

  const onPointerLeave = useCallback(() => {
    dragRef.current = {
      node: null,
      offsetX: 0,
      offsetY: 0,
      startX: 0,
      startY: 0,
      dragged: false,
    };
    panRef.current.active = false;
    panRef.current.moved = false;
    hoverRef.current = null;
    tooltipRef.current = { x: 0, y: 0, node: null };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'default';
  }, []);

  /** Wheel zoom — zoom centred on the cursor. The world point under the
   * cursor stays under the cursor by adjusting panX/panY along with scale. */
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const vp = viewportRef.current;
      const oldScale = vp.scale;
      // Trackpad pinch-zoom uses small deltaY (Mac), wheel uses large.
      // Use exponential so each tick is multiplicative — feels natural.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.max(0.25, Math.min(4, oldScale * factor));
      if (newScale === oldScale) return;

      // Keep the world point under the cursor pinned: solve
      //   sx = panX + worldX * scale
      // for new panX given worldX from the OLD transform.
      const worldX = (sx - vp.panX) / oldScale;
      const worldY = (sy - vp.panY) / oldScale;
      vp.scale = newScale;
      vp.panX = sx - worldX * newScale;
      vp.panY = sy - worldY * newScale;
    },
    [],
  );

  /** Reset view to identity transform. */
  const resetView = useCallback(() => {
    viewportRef.current = { scale: 1, panX: 0, panY: 0 };
  }, []);

  /* Attach a NON-passive wheel listener directly on the canvas. Preact's
   * synthetic `onWheel` cannot reliably preventDefault scroll on Mac
   * trackpads; the page scrolls instead of zoom. Native addEventListener
   * with `{ passive: false }` is the only path that works here.
   *
   * NOTE: depending on `[data, loading]` (not just `[onWheel]`) is REQUIRED.
   * The component returns the loading <div> first — the canvas JSX (and
   * therefore canvasRef.current) doesn't exist on the first render. After
   * data arrives the component re-renders with the canvas, but a useEffect
   * with deps=[onWheel] would NOT fire then because onWheel is stable from
   * useCallback([]). Tying it to [data, loading] guarantees we re-run once
   * the canvas is mounted. */
  useEffect(() => {
    if (loading || !data) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => onWheel(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [data, loading, onWheel]);

  /* ---------- derived data for render ---------- */
  if (loading && !data) return <div class="empty"><div class="loading" /></div>;
  // The two failures carry different next steps — "check the server" vs
  // "reload / memesh doctor" — so they get different sentences; the console
  // has the raw details either way. There used to be a third branch showing
  // a raw error string here, but nothing could reach it: the only place it
  // was set also set `failure`, which returns first. A branch that reads as
  // a safety net and cannot run is exactly the shape this repo hunts.
  if (failure && !data) return <div class="error-box" role="alert">{failureMessage(failure)}</div>;
  if (!data) return <div class="error-box" role="alert">{t('common.error')}: {t('common.noData')}</div>;

  // Type counts
  const typeGroups = new Map<string, number>();
  data.entities.forEach((e) =>
    typeGroups.set(e.type, (typeGroups.get(e.type) || 0) + 1),
  );

  // Orphan count — over the DRAWABLE edge set, not raw data.relations.
  // The node cap trims entities but the server's relation list is uncapped,
  // so a node whose only partner was capped out still appears in a raw
  // relation. Counting that as "connected" while the canvas draws it with
  // zero edges (edgesRef filters to relations whose BOTH endpoints survive)
  // is the miscount. Filter the same way the canvas does so the stat matches
  // what is drawn.
  const nodeNames = new Set(data.entities.map((e) => e.name));
  const connectedSet = new Set<string>();
  data.relations.forEach((r) => {
    if (!nodeNames.has(r.from) || !nodeNames.has(r.to)) return;
    connectedSet.add(r.from);
    connectedSet.add(r.to);
  });
  const orphanCount = data.entities.filter((e) => !connectedSet.has(e.name)).length;

  // Search match count — over the SAME haystack the canvas highlights on
  // (name + headline). Counted over the machine name alone it reported "0
  // matches" for a query that the user took straight off this canvas.
  // Memoized: this scans every node, and it used to run on every render with
  // `searchQuery.toLowerCase()` recomputed per node.
  const searchMatches = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    return [...displayIndex.entries()].filter(([, d]) => d.search.includes(q));
  }, [displayIndex, searchQuery]);
  const matchCount = searchMatches.length;

  /**
   * Select the node the search has narrowed to, from the keyboard.
   *
   * Node selection was pointer-only: the click handler was the ONLY way to
   * enter ego mode or open the evidence drill-down, so a keyboard user could
   * reach the canvas (it is focusable and labelled) and read the summary,
   * and could not open a single node. Search highlighted matches and stopped
   * there.
   *
   * Deliberately narrow: only when the query has narrowed to exactly ONE
   * node, and driven from the search box the user is already typing in. Full
   * node-to-node traversal is still deferred — it is a large-graph
   * interaction that needs its own design, as the canvas comment says — but
   * "find it and open it" is the thing the mouse does that the keyboard
   * could not do at all.
   */
  const selectSoleMatch = () => {
    if (searchMatches.length !== 1) return;
    const [name] = searchMatches[0];
    setEgoNodeId(name);
    // The REAL node, not a two-field stand-in. `{ id, display } as GNode`
    // left twelve of fourteen fields undefined on a node reached by keyboard
    // and populated on the same node reached by click — nothing reads them
    // today, and the next reader of `evidenceNode` would get `undefined` with
    // no type error to warn them.
    const node = nodesRef.current.find((n) => n.id === name);
    if (node) setEvidenceNode(node);
  };

  // Ego node name for banner
  const egoEntity = egoNodeId
    ? data.entities.find((e) => e.name === egoNodeId)
    : null;

  const globalFilterStatus = (
    <div
      role="status"
      style={{ fontSize: 12, color: 'var(--text-2)', padding: '8px 10px', marginBottom: 8, background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xs)' }}
    >
      {t(signalMode ? 'globalFilter.focusedStatus' : 'globalFilter.allStatus')}
    </div>
  );

  // An empty library used to render as a bare black canvas — indistinguishable
  // from a rendering bug, and mute about what to do next. /v1/graph returns
  // every signal entity, so zero entities here IS an empty database: show the
  // instructive empty state (with the demo seed — the durable entry point
  // that survives the OnboardingBanner's permanent dismissal).
  if (data.entities.length === 0) {
    return (
      <div>
        {loading && <div class="loading" role="status" />}
        {failure && <div class="error-box" role="alert">{failureMessage(failure)}</div>}
        {globalFilterStatus}
        <div class="stats-row">
          <div class="stat">
            <div class="stat-val">0</div>
            <div class="stat-lbl">{t('graph.entities')}</div>
          </div>
          <div class="stat">
            <div class="stat-val">0</div>
            <div class="stat-lbl">{t('graph.relations')}</div>
          </div>
          <div class="stat">
            <div class="stat-val">0</div>
            <div class="stat-lbl">{t('graph.orphans')}</div>
          </div>
        </div>
        <div class="card" style={{ padding: 12 }}>
          <span class="card-title" style={{ margin: 0 }}>{t('tab.graph')}</span>
          <EmptyLibraryState />
        </div>
      </div>
    );
  }

  const isCapped = totalEntities > data.entities.length;

  return (
    <div>
      {loading && <div class="loading" role="status" />}
      {failure && <div class="error-box" role="alert">{failureMessage(failure)}</div>}
      {globalFilterStatus}
      {/* Stats row: 3 cards. The entities stat reports the LIBRARY size
          (pre-cap) — the cap note right below owns the discrepancy. */}
      <div class="stats-row">
        <div class="stat">
          <div class="stat-val">{totalEntities.toLocaleString(getLocale())}</div>
          <div class="stat-lbl">{t('graph.entities')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{data.relations.length.toLocaleString(getLocale())}</div>
          <div class="stat-lbl">{t('graph.relations')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{orphanCount.toLocaleString(getLocale())}</div>
          <div class="stat-lbl">{t('graph.orphans')}</div>
        </div>
      </div>

      {isCapped && (
        <div role="status" style={{ fontSize: 11, color: 'var(--text-2)', margin: '0 0 8px' }}>
          {t('graph.cappedNote', {
            shown: data.entities.length.toLocaleString(getLocale()),
            total: totalEntities.toLocaleString(getLocale()),
          })}
        </div>
      )}

      {/* Layer switch. Two questions, not two styles: "what was decided and
          learned" (work) versus "everything memesh has stored" (all). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
        <div role="group" aria-label={t('graph.layerLabel')} style={{ display: 'flex', gap: 4 }}>
          {(['work', 'all'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={layer === v}
              onClick={() => setLayer(v)}
              style={{
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                border: `1px solid ${layer === v ? 'var(--life)' : 'var(--border)'}`,
                background: layer === v ? 'var(--life-soft)' : 'transparent',
                color: layer === v ? 'var(--life)' : 'var(--text-2)',
              }}
            >
              {v === 'work' ? t('graph.layerWork') : t('graph.layerAll')}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
          {activeLayer === 'work' ? t('graph.layerWorkHint') : t('graph.layerAllHint')}
        </span>
      </div>

      {/* The fallback is announced, never silent: the user asked for the
          work layer and is looking at something else. */}
      {fellBack && (
        <div role="status" style={{ fontSize: 11, color: 'var(--text-2)', margin: '0 0 8px' }}>
          {t('graph.layerFellBack', { min: WORK_LAYER_MIN_NODES })}
        </div>
      )}

      <div class="card" style={{ padding: 12 }}>
        {/* Row 1: Title + type filter checkboxes — horizontally
            scrollable strip so 30+ types don't wrap into 3-4 lines and
            push the canvas below the viewport on a 1440x900 screen. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 8,
            flexWrap: 'nowrap',
            overflowX: 'auto',
            paddingBottom: 4,
            scrollbarWidth: 'thin',
          }}
        >
          <span class="card-title" style={{ margin: 0, flexShrink: 0 }}>
            {t('tab.graph')}
          </span>
          {Array.from(typeGroups.entries()).map(([type, count]) => {
            const checked = typeFilters[type] !== false;
            const color = typeColorCss(type);
            return (
              <label
                key={type}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  color: 'var(--text-1)',
                  opacity: checked ? 1 : 0.4,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setTypeFilters((prev) => ({
                      ...prev,
                      [type]: !prev[type],
                    }))
                  }
                  style={{
                    accentColor: color,
                    width: 13,
                    height: 13,
                    cursor: 'pointer',
                  }}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: color,
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                {typeLabel(type)} ({count})
              </label>
            );
          })}
        </div>

        {/* Row 2: Search input + match count + Drift Mode toggle */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            flexWrap: 'wrap',
          }}
        >
          <input
            type="text"
            placeholder={t('graph.search')}
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') selectSoleMatch(); }}
            aria-describedby="graph-search-hint"
            style={{
              flex: '1 1 160px',
              minWidth: 120,
              maxWidth: 260,
              padding: '4px 8px',
              background: 'var(--bg-0)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--text-0)',
              fontSize: 12,
              fontFamily: 'var(--font-ui)',
            }}
          />
          {searchQuery && (
            <span
              id="graph-search-hint"
              role="status"
              style={{
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--text-2)',
              }}
            >
              {matchCount} {t('graph.matches')}
              {/* The hint appears exactly when the action is available, so it
                  never promises something Enter will not do. */}
              {matchCount === 1 && ` — ${t('graph.enterToOpen')}`}
            </span>
          )}
          <button
            onClick={resetView}
            title={t('graph.resetViewHint')}
            style={{
              marginLeft: 'auto',
              padding: '3px 10px',
              background: 'var(--border-subtle)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--text-2)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {t('graph.resetView')}
          </button>
          <button
            onClick={() => setDriftMode((v) => !v)}
            title={t('graph.driftHint')}
            aria-pressed={driftMode}
            style={{
              padding: '3px 10px',
              background: driftMode ? 'rgba(143,242,92,0.15)' : 'var(--border-subtle)',
              border: `1px solid ${driftMode ? 'rgba(143,242,92,0.4)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-xs)',
              color: driftMode ? 'var(--life)' : 'var(--text-2)',
              fontSize: 11,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {/* Drift legend: the gradient IS the stale→fresh scale it explains —
                an informational gradient, sanctioned in DESIGN.md. */}
            <span style={{
              display: 'inline-block',
              width: 32,
              height: 6,
              borderRadius: 'var(--radius-hairline)',
              background: 'linear-gradient(to right, #F87171, var(--life))',
            }} />
            {t('graph.drift')}
          </button>
        </div>

        {/* Row 3: Ego mode banner (only when active) */}
        {egoEntity && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              padding: '4px 10px',
              background: 'var(--life-soft)',
              borderRadius: 'var(--radius-xs)',
              fontSize: 12,
            }}
          >
            <span style={{ color: 'var(--life)', fontWeight: 600 }}>
              {t('graph.focusMode')}:
            </span>
            {/* The headline, not `egoEntity.name`: this banner names the node
                the user is focused on, and a dedup key like
                `pre-compact-<sessionId>` does not name anything to a human. */}
            <span style={{ color: 'var(--text-0)' }}>{displayTitle(egoEntity)}</span>
            <button
              onClick={() => setEgoNodeId(null)}
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                background: 'rgba(143, 242, 92, 0.12)',
                border: '1px solid rgba(143, 242, 92, 0.2)',
                borderRadius: 'var(--radius-hairline)',
                color: 'var(--life)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {t('graph.showAll')}
            </button>
          </div>
        )}

        {/* Row 4: Click hint (only when NOT in ego mode) */}
        {!egoNodeId && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              marginBottom: 6,
            }}
          >
            {t('graph.interactHint')}
          </div>
        )}

        {/* Canvas. role=img + aria-label give the non-visual equivalent: the
            counts and, above, the keyboard-reachable type legend (checkboxes)
            and search. Full keyboard node-to-node traversal is deferred — a
            large-graph interaction that needs its own design; tabIndex makes
            the canvas itself focusable so it is at least in the tab order and
            carries the summary. touch-action:none lets pointer pan/zoom work
            without the browser scrolling the page. */}
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={t('graph.canvasA11y', {
            entities: totalEntities.toLocaleString(getLocale()),
            relations: data.relations.length.toLocaleString(getLocale()),
            orphans: orphanCount.toLocaleString(getLocale()),
          })}
          style={{
            width: '100%',
            height: CANVAS_HEIGHT,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-0)',
            cursor: 'grab',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerLeave}
          onPointerLeave={onPointerLeave}
        />

        {/* Drill-down. Work view only: in the full graph a clicked node is
            not a work item, so "what evidence supports it" is not a question
            that view can answer. */}
        {activeLayer === 'work' && evidenceNode && (
          /* `node` is the API key (the entity name); `nodeTitle` is what the
             panel heading reads out, so it takes the headline. The old
             `title || id` fallback put the machine key in the heading of
             every untitled node. */
          <EvidencePanel
            node={evidenceNode.id}
            nodeTitle={evidenceNode.display}
            onClose={() => setEvidenceNode(null)}
          />
        )}
      </div>
    </div>
  );
}
