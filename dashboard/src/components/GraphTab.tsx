import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchGraph, type GraphData, type Entity } from '../lib/api';
import { t } from '../lib/i18n';
import { useSignalMode } from '../lib/signalMode';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface GNode {
  id: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  recency: number;          // 0.15–1.0
  isOrphan: boolean;
  lastDate: string;         // ISO string for tooltip age
}

interface GEdge {
  from: string;
  to: string;
  type: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TYPE_COLORS: Record<string, string> = {
  decision: '#00D6B4',
  pattern: '#60A5FA',
  lesson_learned: '#FFB84D',
  commit: '#A78BFA',
  'session-insight': '#7A828E',
  session_keypoint: '#4ADE80',
  session_identity: '#F472B6',
  workflow_checkpoint: '#38BDF8',
  feature: '#FB923C',
  bug_fix: '#F87171',
  concept: '#00D6B4',
  tool: '#818CF8',
  person: '#E879F9',
  note: '#94A3B8',
};
const DEFAULT_COLOR = '#B8BEC6';

function getColor(type: string): string {
  return TYPE_COLORS[type] || DEFAULT_COLOR;
}

/** Drift Mode: interpolate stale (#F87171) → fresh (#00D6B4) by recency 0.15–1.0. */
function getDriftColor(recency: number): string {
  const t = Math.max(0, Math.min(1, (recency - 0.15) / 0.85));
  const r = Math.round(248 + (0 - 248) * t);
  const g = Math.round(113 + (214 - 113) * t);
  const b = Math.round(113 + (180 - 113) * t);
  return `rgb(${r},${g},${b})`;
}

/** Scale radius by access_count using log2 so high-traffic nodes stand out. */
function computeRadius(accessCount: number | undefined): number {
  const n = accessCount ?? 0;
  if (n === 0) return 5;
  return Math.min(14, 5 + Math.log2(n + 1) * 2);
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

declare global {
  interface Window { __graphReheat?: () => void; }
}

// Tuned to fit a 1440x900 viewport after header (~44px) + nav (~44px) +
// stats row (~80px) + card padding (12+8) + filter strip (~36px). At 500
// the canvas was overflowing the viewport bottom.
const CANVAS_HEIGHT = 440;
const CLICK_THRESHOLD = 4; // px — drag vs click detection

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function GraphTab() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  // Keep latest state in refs so the animation closure can read them
  const typeFiltersRef = useRef(typeFilters);
  const searchQueryRef = useRef(searchQuery);
  const egoNodeIdRef = useRef(egoNodeId);
  const driftModeRef = useRef(driftMode);
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

  /* ----- data fetch ----- */
  useEffect(() => {
    fetchGraph()
      .then((d) => {
        // `d.entities.forEach` and every read below it are unconditional, and
        // this component's own `.catch` swallows the TypeError they throw and
        // paints the raw JS message on screen — so a shape mismatch surfaced
        // to the user as "Cannot read properties of undefined (reading
        // 'forEach')" and produced no unhandled rejection for CI to notice.
        // A payload that is not the graph reads as "did not load": `!data`
        // below already renders the no-data box.
        if (!Array.isArray(d?.entities) || !Array.isArray(d.relations)) {
          setData(null);
          return;
        }
        setData(d);
        // Init type filters from the server-supplied noise list. When
        // global Signal Mode is ON we hide noise by default; when it
        // is OFF the user explicitly opted into "show everything," so
        // every type starts checked.
        const noise = new Set(Array.isArray(d.noiseTypes) ? d.noiseTypes : []);
        const types: Record<string, boolean> = {};
        d.entities.forEach((e) => {
          types[e.type] = types[e.type] ?? (signalMode ? !noise.has(e.type) : true);
        });
        setTypeFilters(types);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  /* ----- build graph & start simulation ----- */
  useEffect(() => {
    if (!data || loading) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

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

    const nodeMap = new Map<string, GNode>();
    data.entities.forEach((e: Entity) => {
      const lastDate = e.last_accessed_at || e.created_at;
      nodeMap.set(e.name, {
        id: e.name,
        type: e.type,
        x: Math.random() * w * 0.8 + w * 0.1,
        y: Math.random() * h * 0.8 + h * 0.1,
        vx: 0,
        vy: 0,
        radius: computeRadius(e.access_count),
        recency: computeRecency(lastDate),
        isOrphan: !connectedNodes.has(e.name),
        lastDate,
      });
    });
    nodesRef.current = Array.from(nodeMap.values());
    edgesRef.current = data.relations.filter(
      (r) => nodeMap.has(r.from) && nodeMap.has(r.to),
    );

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

    const isSearchMatch = (n: GNode): boolean => {
      const q = searchQueryRef.current.toLowerCase();
      if (!q) return false;
      return n.id.toLowerCase().includes(q);
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
        const matches = nodes.filter((n) => n.id.toLowerCase().includes(q));
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

      // (nodeById was built once at the top of simulate() and is reused
      // here for edge rendering — see physics block above.)

      // Draw edges
      for (const edge of visibleEdges) {
        const a = nodeById.get(edge.from);
        const b = nodeById.get(edge.to);
        if (!a || !b) continue;
        const edgeAlpha = Math.min(a.recency, b.recency) * 0.6;
        ctx.globalAlpha = edgeAlpha;
        ctx.strokeStyle = 'rgba(0, 214, 180, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (showEdgeLabels) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          ctx.font = '9px Satoshi, system-ui, sans-serif';
          ctx.fillStyle = '#7A828E';
          ctx.fillText(edge.type, mx + 2, my - 2);
        }
      }

      ctx.globalAlpha = 1;

      // Collect visible nodes
      const visibleNodes = nodes.filter(isNodeVisible);

      // Draw nodes
      const hoveredNode = hoverRef.current;
      for (const n of visibleNodes) {
        const isHovered = hoveredNode === n;
        const matched = isSearchMatch(n);
        const isFocusCenter = egoNodeIdRef.current === n.id;
        const r = isFocusCenter ? 10 : isHovered ? 9 : n.radius;

        // Recency alpha: full for hovered/matched
        const alpha = isHovered || matched ? 1.0 : n.recency;
        ctx.globalAlpha = alpha;

        // Node fill
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = driftModeRef.current ? getDriftColor(n.recency) : getColor(n.type);
        ctx.fill();

        // Orphan dashed border
        if (n.isOrphan) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#4A5260';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Search match glow ring
        if (matched) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#00F0CA';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Hover ring
        if (isHovered && !matched) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Node labels: only show for hovered, focused, or matched nodes
        const showLabel = isHovered || matched || isFocusCenter;
        if (showLabel) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#B8BEC6';
          ctx.font = '10px Satoshi, system-ui, sans-serif';
          const label =
            matched || isFocusCenter
              ? n.id
              : n.id.length > 20
                ? n.id.slice(0, 18) + '...'
                : n.id;
          ctx.fillText(label, n.x + r + 4, n.y + 3);
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
        const name = tip.node.id;
        const typeTxt = tip.node.type;
        const ageTxt = formatAge(tip.node.lastDate);
        const line1 = name;
        const line2 = `${typeTxt}  |  ${ageTxt}`;
        ctx.font = '11px Satoshi, system-ui, sans-serif';
        const w1 = ctx.measureText(line1).width;
        const w2 = ctx.measureText(line2).width;
        const boxW = Math.max(w1, w2) + 12;
        const boxH = 34;
        ctx.fillStyle = 'rgba(13, 16, 20, 0.92)';
        ctx.strokeStyle = 'rgba(0, 214, 180, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx - 4, ty - 18, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#F0F2F4';
        ctx.fillText(line1, tx, ty - 4);
        ctx.fillStyle = '#7A828E';
        ctx.font = '10px Geist Mono, JetBrains Mono, monospace';
        ctx.fillText(line2, tx, ty + 10);
      }

      animRef.current = requestAnimationFrame(simulate);
    };

    animRef.current = requestAnimationFrame(simulate);
    return () => cancelAnimationFrame(animRef.current);
  }, [data, loading]);

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

  /* ---------- mouse handlers ----------
   * Conventions:
   *   - getCanvasPos(e) returns SCREEN coords inside the canvas rect.
   *   - screenToWorld(sx, sy) converts to WORLD coords (the space nodes
   *     are authored in). Hit-test + node-drag live in world space.
   *   - Background pan tracks deltas in SCREEN space and writes to
   *     viewportRef.{panX,panY} (also a screen-space offset). */
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
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

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
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

  const onMouseUp = useCallback(
    (e: MouseEvent) => {
      const drag = dragRef.current;
      const pan = panRef.current;
      const screen = getCanvasPos(e);
      const world = screenToWorld(screen.x, screen.y);

      if (drag.node && !drag.dragged) {
        // Click on a node — toggle ego mode.
        setEgoNodeId((prev) => (prev === drag.node!.id ? null : drag.node!.id));
      } else if (!drag.node && pan.active && !pan.moved) {
        // Click on empty canvas (no pan happened) — exit ego mode.
        const nodeAtPos = findNodeAt(world.x, world.y);
        if (!nodeAtPos) {
          setEgoNodeId(null);
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

  const onMouseLeave = useCallback(() => {
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
  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (error) return <div class="error-box">{t('common.error')}: {error}</div>;
  if (!data) return <div class="error-box">{t('common.error')}: {t('common.noData')}</div>;

  // Type counts
  const typeGroups = new Map<string, number>();
  data.entities.forEach((e) =>
    typeGroups.set(e.type, (typeGroups.get(e.type) || 0) + 1),
  );

  // Orphan count
  const connectedSet = new Set<string>();
  data.relations.forEach((r) => {
    connectedSet.add(r.from);
    connectedSet.add(r.to);
  });
  const orphanCount = data.entities.filter((e) => !connectedSet.has(e.name)).length;

  // Search match count
  const matchCount = searchQuery
    ? data.entities.filter((e) =>
        e.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ).length
    : 0;

  // Ego node name for banner
  const egoEntity = egoNodeId
    ? data.entities.find((e) => e.name === egoNodeId)
    : null;

  return (
    <div>
      {/* Stats row: 3 cards */}
      <div class="stats-row">
        <div class="stat">
          <div class="stat-val">{data.entities.length.toLocaleString()}</div>
          <div class="stat-lbl">{t('graph.entities')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{data.relations.length.toLocaleString()}</div>
          <div class="stat-lbl">{t('graph.relations')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{orphanCount.toLocaleString()}</div>
          <div class="stat-lbl">{t('graph.orphans')}</div>
        </div>
      </div>

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
            const color = getColor(type);
            return (
              <label
                key={type}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  color: '#B8BEC6',
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
                {type} ({count})
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
            style={{
              width: 260,
              padding: '4px 8px',
              background: '#080A0C',
              border: '1px solid rgba(0, 214, 180, 0.08)',
              borderRadius: 4,
              color: '#F0F2F4',
              fontSize: 12,
              fontFamily: 'Satoshi, system-ui, sans-serif',
              outline: 'none',
            }}
          />
          {searchQuery && (
            <span
              style={{
                fontSize: 11,
                fontFamily: 'Geist Mono, JetBrains Mono, monospace',
                color: '#7A828E',
              }}
            >
              {matchCount} {t('graph.matches')}
            </span>
          )}
          <button
            onClick={resetView}
            title={t('graph.resetViewHint')}
            style={{
              marginLeft: 'auto',
              padding: '3px 10px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 4,
              color: '#7A828E',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {t('graph.resetView')}
          </button>
          <button
            onClick={() => setDriftMode((v) => !v)}
            style={{
              padding: '3px 10px',
              background: driftMode ? 'rgba(0,214,180,0.15)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${driftMode ? 'rgba(0,214,180,0.4)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 4,
              color: driftMode ? '#00D6B4' : '#7A828E',
              fontSize: 11,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {/* Drift legend: stale → fresh ramp */}
            <span style={{
              display: 'inline-block',
              width: 32,
              height: 6,
              borderRadius: 3,
              background: 'linear-gradient(to right, #F87171, #00D6B4)',
            }} />
            Drift
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
              background: 'rgba(0, 214, 180, 0.08)',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <span style={{ color: '#00D6B4', fontWeight: 600 }}>
              {t('graph.focusMode')}:
            </span>
            <span style={{ color: '#F0F2F4' }}>{egoEntity.name}</span>
            <button
              onClick={() => setEgoNodeId(null)}
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                background: 'rgba(0, 214, 180, 0.12)',
                border: '1px solid rgba(0, 214, 180, 0.2)',
                borderRadius: 3,
                color: '#00D6B4',
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
              color: '#4A5260',
              marginBottom: 6,
            }}
          >
            {t('graph.interactHint')}
          </div>
        )}

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: CANVAS_HEIGHT,
            borderRadius: 'var(--radius-sm)',
            background: '#080A0C',
            cursor: 'grab',
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
        />
      </div>
    </div>
  );
}
