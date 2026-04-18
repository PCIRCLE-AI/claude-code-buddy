import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchGraph, type GraphData } from '../lib/api';
import { t } from '../lib/i18n';

interface Node {
  id: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Edge {
  from: string;
  to: string;
  type: string;
}

const TYPE_COLORS: Record<string, string> = {
  decision: '#3b82f6',
  pattern: '#22c55e',
  lesson_learned: '#f97316',
  commit: '#8b5cf6',
  'session-insight': '#6b7280',
};
const DEFAULT_COLOR = '#94a3b8';

function getColor(type: string): string {
  return TYPE_COLORS[type] || DEFAULT_COLOR;
}

export function GraphTab() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ node: Node | null; offsetX: number; offsetY: number }>({ node: null, offsetX: 0, offsetY: 0 });
  const hoverRef = useRef<Node | null>(null);
  const tooltipRef = useRef<{ x: number; y: number; node: Node | null }>({ x: 0, y: 0, node: null });

  useEffect(() => {
    fetchGraph()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Build nodes and edges when data arrives
  useEffect(() => {
    if (!data) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = canvas.parentElement?.clientWidth || 800;
    const h = 500;
    canvas.width = w * window.devicePixelRatio;
    canvas.height = h * window.devicePixelRatio;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const nodeMap = new Map<string, Node>();
    data.entities.forEach((e) => {
      nodeMap.set(e.name, {
        id: e.name,
        type: e.type,
        x: Math.random() * w * 0.8 + w * 0.1,
        y: Math.random() * h * 0.8 + h * 0.1,
        vx: 0,
        vy: 0,
        radius: 6,
      });
    });
    nodesRef.current = Array.from(nodeMap.values());
    edgesRef.current = data.relations.filter((r) => nodeMap.has(r.from) && nodeMap.has(r.to));

    // Start simulation
    const simulate = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const dpr = window.devicePixelRatio;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Force simulation step
      const damping = 0.85;
      const repulsion = 2000;
      const springLen = 80;
      const springK = 0.02;
      const centerForce = 0.005;

      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
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

      // Apply velocities with damping
      for (const n of nodes) {
        if (dragRef.current.node === n) continue;
        n.vx *= damping;
        n.vy *= damping;
        n.x += n.vx;
        n.y += n.vy;
        // Clamp to bounds
        n.x = Math.max(20, Math.min(w - 20, n.x));
        n.y = Math.max(20, Math.min(h - 20, n.y));
      }

      // Render
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Draw edges
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(113, 113, 122, 0.3)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(113, 113, 122, 0.5)';
      for (const edge of edges) {
        const a = nodeById.get(edge.from);
        const b = nodeById.get(edge.to);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // Edge label
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.fillText(edge.type, mx + 2, my - 2);
      }

      // Draw nodes
      for (const n of nodes) {
        const isHovered = hoverRef.current === n;
        const r = isHovered ? 9 : n.radius;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = getColor(n.type);
        ctx.fill();
        if (isHovered) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // Node label
        ctx.fillStyle = '#d4d4d8';
        ctx.font = '10px system-ui, sans-serif';
        const label = n.id.length > 20 ? n.id.slice(0, 18) + '...' : n.id;
        ctx.fillText(label, n.x + r + 4, n.y + 3);
      }

      // Tooltip
      const tip = tooltipRef.current;
      if (tip.node) {
        const tx = tip.x + 12;
        const ty = tip.y - 10;
        const text = `${tip.node.id} (${tip.node.type})`;
        const textW = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(15, 15, 18, 0.92)';
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx - 4, ty - 12, textW + 8, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fafafa';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(text, tx, ty);
      }

      animRef.current = requestAnimationFrame(simulate);
    };

    animRef.current = requestAnimationFrame(simulate);
    return () => cancelAnimationFrame(animRef.current);
  }, [data]);

  const findNodeAt = useCallback((mx: number, my: number): Node | null => {
    for (const n of nodesRef.current) {
      const dx = n.x - mx;
      const dy = n.y - my;
      if (dx * dx + dy * dy < 144) return n; // 12px radius hit area
    }
    return null;
  }, []);

  const getCanvasPos = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const onMouseDown = useCallback((e: MouseEvent) => {
    const pos = getCanvasPos(e);
    const node = findNodeAt(pos.x, pos.y);
    if (node) {
      dragRef.current = { node, offsetX: pos.x - node.x, offsetY: pos.y - node.y };
    }
  }, [findNodeAt, getCanvasPos]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const pos = getCanvasPos(e);
    if (dragRef.current.node) {
      dragRef.current.node.x = pos.x - dragRef.current.offsetX;
      dragRef.current.node.y = pos.y - dragRef.current.offsetY;
      dragRef.current.node.vx = 0;
      dragRef.current.node.vy = 0;
    }
    const node = findNodeAt(pos.x, pos.y);
    hoverRef.current = node;
    tooltipRef.current = node ? { x: pos.x, y: pos.y, node } : { x: 0, y: 0, node: null };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = node ? 'grab' : 'default';
  }, [findNodeAt, getCanvasPos]);

  const onMouseUp = useCallback(() => {
    dragRef.current = { node: null, offsetX: 0, offsetY: 0 };
  }, []);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (error) return <div class="error-box">{t('common.error')}: {error}</div>;
  if (!data) return <div class="error-box">{t('common.error')}: No data</div>;

  const typeGroups = new Map<string, number>();
  data.entities.forEach((e) => typeGroups.set(e.type, (typeGroups.get(e.type) || 0) + 1));

  return (
    <div>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-val">{data.entities.length.toLocaleString()}</div>
          <div class="stat-lbl">{t('graph.entities')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{data.relations.length.toLocaleString()}</div>
          <div class="stat-lbl">{t('graph.relations')}</div>
        </div>
      </div>
      <div class="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
          <span class="card-title" style={{ margin: 0 }}>{t('tab.graph')}</span>
          {Array.from(typeGroups.entries()).map(([type, count]) => (
            <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-2)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: getColor(type), display: 'inline-block' }} />
              {type} ({count})
            </span>
          ))}
        </div>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, borderRadius: 'var(--radius-sm)', background: 'var(--bg-0)' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
      </div>
    </div>
  );
}
