import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchGraph, type GraphData, type Entity } from '../lib/api';
import { t } from '../lib/i18n';

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

const CANVAS_HEIGHT = 500;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [egoNodeId, setEgoNodeId] = useState<string | null>(null);

  // Refs for canvas animation loop
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GNode[]>([]);
  const edgesRef = useRef<GEdge[]>([]);
  const animRef = useRef<number>(0);
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
  useEffect(() => { typeFiltersRef.current = typeFilters; }, [typeFilters]);
  useEffect(() => { searchQueryRef.current = searchQuery; }, [searchQuery]);
  useEffect(() => { egoNodeIdRef.current = egoNodeId; }, [egoNodeId]);

  /* ----- data fetch ----- */
  useEffect(() => {
    fetchGraph()
      .then((d) => {
        setData(d);
        // Init type filters: all checked
        const types: Record<string, boolean> = {};
        d.entities.forEach((e) => { types[e.type] = true; });
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

    const w = canvas.parentElement?.clientWidth || 800;
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
        radius: 6,
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
    let alpha = 1.0;           // cooling factor: 1.0 = hot, 0 = frozen
    const alphaDecay = 0.005;  // how fast it cools per frame
    const alphaMin = 0.001;    // stop physics below this

    // Expose reheat function for drag/filter changes
    const reheat = () => { alpha = 0.3; };
    window.__graphReheat = reheat;

    const simulate = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const curDpr = window.devicePixelRatio || 1;

      // Cool down
      alpha = Math.max(alphaMin, alpha - alphaDecay);

      // Physics constants (scaled by alpha)
      const damping = 0.85;
      const repulsion = 2000 * alpha;
      const springLen = 80;
      const springK = 0.02 * alpha;
      const centerForce = 0.005 * alpha;
      const largeN = nodes.length > 200;

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
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
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
      const cx = w / 2;
      const cy = h / 2;
      for (const n of nodes) {
        n.vx += (cx - n.x) * centerForce;
        n.vy += (cy - n.y) * centerForce;
      }

      // Apply velocities
      for (const n of nodes) {
        if (dragRef.current.node === n) continue;
        n.vx *= damping;
        n.vy *= damping;
        // Freeze when nearly stopped
        if (Math.abs(n.vx) < 0.01 && Math.abs(n.vy) < 0.01) { n.vx = 0; n.vy = 0; }
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(20, Math.min(w - 20, n.x));
        n.y = Math.max(20, Math.min(h - 20, n.y));
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
      ctx.setTransform(curDpr, 0, 0, curDpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Collect visible edges
      const visibleEdges = edges.filter(isEdgeVisible);
      const showEdgeLabels = visibleEdges.length < 30;

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
        ctx.fillStyle = getColor(n.type);
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

      // Tooltip
      const tip = tooltipRef.current;
      if (tip.node && isNodeVisible(tip.node)) {
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

  /* ---------- hit-test (only visible nodes) ---------- */
  const findNodeAt = useCallback((mx: number, my: number): GNode | null => {
    const nodes = nodesRef.current;
    const filters = typeFiltersRef.current;
    const egoId = egoNodeIdRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      // Skip hidden nodes
      if (filters[n.type] === false) continue;
      if (egoId && n.id !== egoId) {
        const isNeighbor = edgesRef.current.some(
          (e) => (e.from === egoId && e.to === n.id) || (e.to === egoId && e.from === n.id),
        );
        if (!isNeighbor) continue;
      }
      const dx = n.x - mx;
      const dy = n.y - my;
      if (dx * dx + dy * dy < 144) return n; // 12px hit area
    }
    return null;
  }, []);

  const getCanvasPos = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  /* ---------- mouse handlers ---------- */
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      const pos = getCanvasPos(e);
      const node = findNodeAt(pos.x, pos.y);
      if (node) window.__graphReheat?.();
      dragRef.current = {
        node: node || null,
        offsetX: node ? pos.x - node.x : 0,
        offsetY: node ? pos.y - node.y : 0,
        startX: pos.x,
        startY: pos.y,
        dragged: false,
      };
    },
    [findNodeAt, getCanvasPos],
  );

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const pos = getCanvasPos(e);
      const drag = dragRef.current;
      if (drag.node) {
        const dx = pos.x - drag.startX;
        const dy = pos.y - drag.startY;
        if (dx * dx + dy * dy > CLICK_THRESHOLD * CLICK_THRESHOLD) {
          drag.dragged = true;
        }
        drag.node.x = pos.x - drag.offsetX;
        drag.node.y = pos.y - drag.offsetY;
        drag.node.vx = 0;
        drag.node.vy = 0;
      }
      const node = findNodeAt(pos.x, pos.y);
      hoverRef.current = node;
      tooltipRef.current = node
        ? { x: pos.x, y: pos.y, node }
        : { x: 0, y: 0, node: null };
      const canvas = canvasRef.current;
      if (canvas) {
        if (node) {
          canvas.style.cursor = egoNodeIdRef.current ? 'pointer' : 'grab';
        } else {
          canvas.style.cursor = 'default';
        }
      }
    },
    [findNodeAt, getCanvasPos],
  );

  const onMouseUp = useCallback(
    (e: MouseEvent) => {
      const drag = dragRef.current;
      const pos = getCanvasPos(e);
      if (drag.node && !drag.dragged) {
        // It's a click — toggle ego mode
        setEgoNodeId((prev) => (prev === drag.node!.id ? null : drag.node!.id));
      } else if (!drag.node && !drag.dragged) {
        // Click on empty canvas — exit ego mode
        const nodeAtPos = findNodeAt(pos.x, pos.y);
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
    },
    [findNodeAt, getCanvasPos],
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
    hoverRef.current = null;
    tooltipRef.current = { x: 0, y: 0, node: null };
  }, []);

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
        {/* Row 1: Title + type filter checkboxes */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 8,
            flexWrap: 'wrap',
          }}
        >
          <span class="card-title" style={{ margin: 0 }}>
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

        {/* Row 2: Search input + match count */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
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
            {t('graph.clickHint')}
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
