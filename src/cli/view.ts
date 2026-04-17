#!/usr/bin/env node

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

interface DashboardData {
  entities: Array<{
    id: number;
    name: string;
    type: string;
    status: string;
    observations: string[];
    tags: string[];
  }>;
  relations: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  stats: {
    totalEntities: number;
    totalObservations: number;
    totalRelations: number;
    totalTags: number;
    typeDistribution: Record<string, number>;
    tagDistribution: Record<string, number>;
  };
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundledD3 = fs
  .readFileSync(path.join(moduleDir, 'assets', 'd3.v7.min.js'), 'utf8')
  .replace(/<\/script/gi, '<\\/script');

function queryData(dbPath: string): DashboardData {
  const emptyData: DashboardData = {
    entities: [],
    relations: [],
    stats: {
      totalEntities: 0,
      totalObservations: 0,
      totalRelations: 0,
      totalTags: 0,
      typeDistribution: {},
      tagDistribution: {},
    },
  };

  if (!fs.existsSync(dbPath)) {
    return emptyData;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err: any) {
    console.error(`[memesh-view] Cannot open database at ${dbPath}: ${err.message}`);
    return emptyData;
  }

  try {
    // Check if tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities', 'observations', 'relations', 'tags')"
      )
      .all()
      .map((r: any) => r.name as string);

    if (!tables.includes('entities')) {
      return emptyData;
    }

    // Check if status column exists (backward compat with v2.11 DBs)
    const hasStatus = (db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>)
      .some((col) => col.name === 'status');
    const statusSelect = hasStatus ? ', status' : ", 'active' AS status";

    // Query entities (include all — archived are shown with visual distinction)
    const entityRows = db
      .prepare(`SELECT id, name, type${statusSelect} FROM entities LIMIT 5000`)
      .all() as Array<{ id: number; name: string; type: string; status: string }>;

    // Query observations
    const obsRows = tables.includes('observations')
      ? (db
          .prepare('SELECT entity_id, content FROM observations')
          .all() as Array<{ entity_id: number; content: string }>)
      : [];

    // Query tags
    const tagRows = tables.includes('tags')
      ? (db.prepare('SELECT entity_id, tag FROM tags').all() as Array<{
          entity_id: number;
          tag: string;
        }>)
      : [];

    // Query relations
    const relationRows = tables.includes('relations')
      ? (db
          .prepare(
            'SELECT from_entity_id, to_entity_id, relation_type FROM relations'
          )
          .all() as Array<{
          from_entity_id: number;
          to_entity_id: number;
          relation_type: string;
        }>)
      : [];

    // Build entity map
    const entityMap = new Map<number, string>();
    for (const e of entityRows) {
      entityMap.set(e.id, e.name);
    }

    // Group observations by entity
    const obsByEntity = new Map<number, string[]>();
    for (const o of obsRows) {
      const arr = obsByEntity.get(o.entity_id) ?? [];
      arr.push(o.content);
      obsByEntity.set(o.entity_id, arr);
    }

    // Group tags by entity
    const tagsByEntity = new Map<number, string[]>();
    for (const t of tagRows) {
      const arr = tagsByEntity.get(t.entity_id) ?? [];
      arr.push(t.tag);
      tagsByEntity.set(t.entity_id, arr);
    }

    // Build entities
    const entities = entityRows.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      status: e.status,
      observations: obsByEntity.get(e.id) ?? [],
      tags: tagsByEntity.get(e.id) ?? [],
    }));

    // Build relations with names
    const relations = relationRows
      .filter(
        (r) => entityMap.has(r.from_entity_id) && entityMap.has(r.to_entity_id)
      )
      .map((r) => ({
        from: entityMap.get(r.from_entity_id)!,
        to: entityMap.get(r.to_entity_id)!,
        type: r.relation_type,
      }));

    // Type distribution
    const typeDistribution: Record<string, number> = {};
    for (const e of entityRows) {
      typeDistribution[e.type] = (typeDistribution[e.type] ?? 0) + 1;
    }

    // Tag distribution
    const tagDistribution: Record<string, number> = {};
    for (const t of tagRows) {
      tagDistribution[t.tag] = (tagDistribution[t.tag] ?? 0) + 1;
    }

    return {
      entities,
      relations,
      stats: {
        totalEntities: entityRows.length,
        totalObservations: obsRows.length,
        totalRelations: relationRows.length,
        totalTags: tagRows.length,
        typeDistribution,
        tagDistribution,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Escape characters that could break out of a script JSON context.
 */
function escapeJsonForHtml(json: string): string {
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Generate a self-contained HTML dashboard for the MeMesh knowledge graph.
 * Opens the database read-only and queries all data.
 */
export function generateDashboardHtml(dbPath?: string): string {
  const resolvedPath =
    dbPath ??
    process.env.MEMESH_DB_PATH ??
    path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

  const data = queryData(resolvedPath);
  const dataJson = escapeJsonForHtml(JSON.stringify(data));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeMesh LLM Memory — Dashboard</title>
  <!-- bundled d3.js -->
  <script>
${bundledD3}
  <\/script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: #0d1117; color: #c9d1d9; line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 28px; margin-bottom: 24px; color: #f0f6fc; }
    h2 { font-size: 20px; margin-bottom: 12px; color: #f0f6fc; }

    /* Stats cards */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 20px; text-align: center;
    }
    .stat-card .value { font-size: 36px; font-weight: 700; color: #58a6ff; }
    .stat-card .label { font-size: 14px; color: #8b949e; margin-top: 4px; }

    /* Graph */
    .graph-container {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      margin-bottom: 32px; overflow: hidden;
    }
    .graph-container svg { width: 100%; height: 500px; display: block; }
    .graph-container svg text { fill: #c9d1d9; font-size: 11px; pointer-events: none; }
    .link-label { fill: #484f58; font-size: 9px; }

    /* Tables */
    .tables { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    @media (max-width: 800px) { .tables { grid-template-columns: 1fr; } }
    .table-section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { font-size: 14px; }

    /* Entity table */
    .entity-section { margin-bottom: 32px; }
    .search-box {
      width: 100%; padding: 10px 14px; margin-bottom: 16px;
      background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      color: #c9d1d9; font-size: 14px; outline: none;
    }
    .search-box:focus { border-color: #58a6ff; }
    .entity-table-wrap {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      overflow: auto; max-height: 500px;
    }

    /* Tooltip */
    .tooltip {
      position: absolute; pointer-events: none; background: #1c2128;
      border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px;
      font-size: 13px; max-width: 300px; display: none; z-index: 10;
    }
    .tooltip .tt-name { font-weight: 600; color: #f0f6fc; }
    .tooltip .tt-type { color: #8b949e; font-size: 12px; }
    .tooltip .tt-obs { margin-top: 6px; color: #c9d1d9; white-space: pre-line; }
  </style>
</head>
<body>
<div class="container">
  <h1>MeMesh LLM Memory</h1>
  <p style="font-size:12px;color:#8b949e;margin-bottom:20px;">powered by pcircle.ai</p>

  <div class="stats" id="stats"></div>

  <h2>Knowledge Graph</h2>
  <div class="graph-container"><svg id="graph"></svg></div>

  <div class="entity-section">
    <h2>Entities</h2>
    <input class="search-box" id="search" type="text" placeholder="Search entities...">
    <div class="entity-table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Observations</th><th>Tags</th></tr></thead>
        <tbody id="entity-tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="tables">
    <div class="table-section">
      <h2>Type Distribution</h2>
      <table><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody id="type-tbody"></tbody></table>
    </div>
    <div class="table-section">
      <h2>Tag Distribution</h2>
      <table><thead><tr><th>Tag</th><th>Count</th></tr></thead><tbody id="tag-tbody"></tbody></table>
    </div>
  </div>
</div>

<div class="tooltip" id="tooltip">
  <div class="tt-name"></div>
  <div class="tt-type"></div>
  <div class="tt-obs"></div>
</div>

<script>
const DATA = ${dataJson};

// Safe text escaping for DOM insertion
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// --- Stats ---
(function renderStats() {
  var s = DATA.stats;
  var cards = [
    { label: 'Entities', value: s.totalEntities },
    { label: 'Observations', value: s.totalObservations },
    { label: 'Relations', value: s.totalRelations },
    { label: 'Tags', value: s.totalTags },
  ];
  var el = document.getElementById('stats');
  el.textContent = '';
  cards.forEach(function(c) {
    var card = document.createElement('div');
    card.className = 'stat-card';
    var val = document.createElement('div');
    val.className = 'value';
    val.textContent = String(c.value);
    var lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = c.label;
    card.appendChild(val);
    card.appendChild(lbl);
    el.appendChild(card);
  });
})();

// --- Entity table ---
function renderEntityTable(filter) {
  var f = (filter || '').toLowerCase();
  var tbody = document.getElementById('entity-tbody');
  tbody.textContent = '';
  var filtered = DATA.entities.filter(function(e) {
    return !f || e.name.toLowerCase().includes(f) || e.type.toLowerCase().includes(f);
  });
  if (filtered.length === 0) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 4;
    td.style.textAlign = 'center';
    td.style.color = '#8b949e';
    td.textContent = 'No entities';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  filtered.forEach(function(e) {
    var isArchived = e.status === 'archived';
    var tr = document.createElement('tr');
    if (isArchived) { tr.style.opacity = '0.4'; }
    var tdName = document.createElement('td');
    tdName.textContent = isArchived ? e.name + ' [archived]' : e.name;
    var tdType = document.createElement('td'); tdType.textContent = e.type;
    var tdStatus = document.createElement('td'); tdStatus.textContent = e.status || 'active';
    var tdObs = document.createElement('td'); tdObs.textContent = String(e.observations.length);
    var tdTags = document.createElement('td'); tdTags.textContent = e.tags.join(', ');
    tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdStatus); tr.appendChild(tdObs); tr.appendChild(tdTags);
    tbody.appendChild(tr);
  });
}
document.getElementById('search').addEventListener('input', function() { renderEntityTable(this.value); });
renderEntityTable('');

// --- Distribution tables ---
(function renderDistributions() {
  function fillTable(tbodyId, data) {
    var tbody = document.getElementById(tbodyId);
    tbody.textContent = '';
    var entries = Object.entries(data).sort(function(a, b) { return b[1] - a[1]; });
    if (entries.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 2; td.style.textAlign = 'center'; td.style.color = '#8b949e';
      td.textContent = 'No data';
      tr.appendChild(td); tbody.appendChild(tr);
      return;
    }
    entries.forEach(function(pair) {
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td'); tdKey.textContent = pair[0];
      var tdVal = document.createElement('td'); tdVal.textContent = String(pair[1]);
      tr.appendChild(tdKey); tr.appendChild(tdVal); tbody.appendChild(tr);
    });
  }
  fillTable('type-tbody', DATA.stats.typeDistribution);
  fillTable('tag-tbody', DATA.stats.tagDistribution);
})();

// --- D3.js Force Graph ---
(function renderGraph() {
  if (DATA.relations.length === 0 && DATA.entities.length === 0) return;

  var svg = d3.select('#graph');
  var width = svg.node().getBoundingClientRect().width || 800;

  // Only show the most connected entities to keep graph readable
  var MAX_GRAPH_NODES = 40;
  var degreeMap = {};
  DATA.relations.forEach(function(r) {
    degreeMap[r.from] = (degreeMap[r.from] || 0) + 1;
    degreeMap[r.to] = (degreeMap[r.to] || 0) + 1;
  });

  // Sort by connection count, take top N
  var topNames = Object.entries(degreeMap)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, MAX_GRAPH_NODES)
    .map(function(e) { return e[0]; });
  var topSet = new Set(topNames);

  // If no relations, show top 50 entities instead
  var graphEntities = topSet.size > 0
    ? DATA.entities.filter(function(e) { return topSet.has(e.name); })
    : DATA.entities.slice(0, 50);

  if (graphEntities.length === 0) return;

  // Scale height based on node count
  var height = Math.max(500, Math.min(700, graphEntities.length * 6));
  svg.attr('viewBox', [0, 0, width, height]);
  svg.style('height', height + 'px');

  var color = d3.scaleOrdinal(d3.schemeTableau10);

  var nodes = graphEntities.map(function(e) {
    return {
      id: e.name,
      type: e.type,
      status: e.status,
      observations: e.observations,
      radius: 6 + Math.min(e.observations.length, 5),
    };
  });

  var nameSet = new Set(nodes.map(function(n) { return n.id; }));
  var links = DATA.relations
    .filter(function(r) { return nameSet.has(r.from) && nameSet.has(r.to); })
    .map(function(r) { return { source: r.from, target: r.to, type: r.type }; });

  var simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d) { return d.id; }).distance(200))
    .force('charge', d3.forceManyBody().strength(-500))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(function(d) { return d.radius + 4; }));

  var g = svg.append('g');

  // Zoom
  svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', function(event) {
    g.attr('transform', event.transform);
  }));

  // Links
  var link = g.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', '#30363d')
    .attr('stroke-width', 1.5);

  // Link labels
  var linkLabel = g.append('g')
    .selectAll('text')
    .data(links)
    .join('text')
    .attr('class', 'link-label')
    .text(function(d) { return d.type; });

  // Nodes
  var node = g.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', function(d) { return d.radius; })
    .attr('fill', function(d) { return color(d.type); })
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 1.5)
    .style('opacity', function(d) { return d.status === 'archived' ? 0.4 : 1; })
    .call(drag(simulation));

  // Node labels
  var label = g.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text(function(d) { return d.id.length > 35 ? d.id.slice(0, 35) + '...' : d.id; })
    .attr('dx', function(d) { return d.radius + 4; })
    .attr('dy', 4);

  // Tooltip
  var tooltipEl = document.getElementById('tooltip');
  node.on('mouseover', function(event, d) {
    tooltipEl.style.display = 'block';
    tooltipEl.querySelector('.tt-name').textContent = d.id;
    tooltipEl.querySelector('.tt-type').textContent = d.type;
    tooltipEl.querySelector('.tt-obs').textContent = d.observations.slice(0, 3).join('\\n');
  }).on('mousemove', function(event) {
    tooltipEl.style.left = (event.pageX + 12) + 'px';
    tooltipEl.style.top = (event.pageY - 10) + 'px';
  }).on('mouseout', function() {
    tooltipEl.style.display = 'none';
  });

  simulation.on('tick', function() {
    link
      .attr('x1', function(d) { return d.source.x; }).attr('y1', function(d) { return d.source.y; })
      .attr('x2', function(d) { return d.target.x; }).attr('y2', function(d) { return d.target.y; });
    linkLabel
      .attr('x', function(d) { return (d.source.x + d.target.x) / 2; })
      .attr('y', function(d) { return (d.source.y + d.target.y) / 2; });
    node.attr('cx', function(d) { return d.x; }).attr('cy', function(d) { return d.y; });
    label.attr('x', function(d) { return d.x; }).attr('y', function(d) { return d.y; });
  });

  function drag(simulation) {
    return d3.drag()
      .on('start', function(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', function(event, d) { d.fx = event.x; d.fy = event.y; })
      .on('end', function(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Live dashboard — served by the HTTP server, fetches data from the API
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained live HTML dashboard.
 * Data is fetched in-browser from the HTTP API (/v1/*).
 * All DOM manipulation uses textContent / createElement — no innerHTML with user data.
 */
export function generateLiveDashboardHtml(): string {
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --bg-primary: #09090b;
      --bg-secondary: #111113;
      --bg-card: rgba(17,17,19,0.8);
      --bg-hover: rgba(39,39,42,0.5);
      --border: rgba(39,39,42,0.8);
      --border-subtle: rgba(39,39,42,0.4);
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #3b82f6;
      --accent-glow: rgba(59,130,246,0.15);
      --accent-hover: #60a5fa;
      --danger: #ef4444;
      --success: #22c55e;
      --warning: #f59e0b;
      --radius: 12px;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.5);
      --shadow-glow: 0 0 20px var(--accent-glow);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-sans);
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* Light mode overrides */
    body.light {
      --bg-primary: #fafafa;
      --bg-secondary: #ffffff;
      --bg-card: rgba(255,255,255,0.9);
      --bg-hover: rgba(0,0,0,0.04);
      --border: rgba(0,0,0,0.08);
      --border-subtle: rgba(0,0,0,0.04);
      --text-primary: #09090b;
      --text-secondary: #52525b;
      --text-muted: #a1a1aa;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.12);
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .subtitle {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 400;
      letter-spacing: 0.02em;
    }
    .version {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg-hover);
      padding: 2px 8px;
      border-radius: var(--radius-xs);
    }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .header .meta { display: flex; align-items: center; gap: 12px; }

    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      display: inline-block; margin-right: 6px;
      background: var(--text-muted);
    }
    .dot.connected { background: var(--success); box-shadow: 0 0 6px rgba(34,197,94,0.4); }
    .dot.error { background: var(--danger); }

    /* Navigation */
    .nav {
      display: flex;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      gap: 2px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav button {
      padding: 12px 16px;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
      transition: all 0.2s ease;
      white-space: nowrap;
      font-family: var(--font-sans);
    }
    .nav button:hover { color: var(--text-secondary); background: var(--bg-hover); }
    .nav button.active { color: var(--text-primary); border-bottom-color: var(--accent); }

    /* Content */
    .content { max-width: 1280px; margin: 0 auto; padding: 24px; }

    /* Tab panels */
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 16px;
      backdrop-filter: blur(8px);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover { border-color: rgba(59,130,246,0.2); box-shadow: var(--shadow-glow); }
    .card h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); letter-spacing: -0.01em; }

    /* Forms */
    input, button, textarea { font-family: var(--font-sans); font-size: 14px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 20px; }
    .search-input {
      flex: 1;
      padding: 10px 14px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 14px;
      font-family: var(--font-sans);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    .search-input::placeholder { color: var(--text-muted); }

    /* Buttons */
    .btn {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font-sans);
      transition: all 0.15s ease;
      background: var(--bg-secondary);
      color: var(--text-primary);
    }
    .btn:hover { background: var(--bg-hover); border-color: var(--text-muted); }
    .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn-secondary { background: var(--bg-secondary); color: var(--text-secondary); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
    .btn-danger { border-color: var(--danger); color: var(--danger); background: transparent; }
    .btn-danger:hover { background: rgba(239,68,68,0.1); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }

    /* Tables */
    .table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 500px; table-layout: auto; }
    th {
      text-align: left;
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
      color: var(--text-secondary);
      word-break: break-word;
    }
    tbody tr { transition: background 0.15s ease; }
    tbody tr:hover { background: var(--bg-hover); }
    tbody tr:last-child td { border-bottom: none; }

    /* Badges */
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; }
    .badge-active { background: rgba(34,197,94,0.12); color: #4ade80; }
    .badge-archived { background: rgba(239,68,68,0.12); color: #f87171; }
    .badge-type { background: var(--accent-glow); color: var(--accent-hover); }

    /* Entity name */
    .entity-name { font-weight: 500; color: var(--text-primary); }
    .entity-obs { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

    /* Tag pills */
    .tag-pill {
      display: inline-block; padding: 2px 8px; margin: 2px;
      border-radius: 999px; font-size: 11px;
      font-family: var(--font-mono);
      background: var(--bg-hover);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      cursor: default;
    }

    /* Placeholder */
    .placeholder { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 14px; }
    .placeholder .icon { font-size: 32px; margin-bottom: 12px; display: block; }

    /* Result / error box */
    .result-box { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; margin-top: 12px; font-size: 13px; font-family: var(--font-mono); white-space: pre-wrap; max-height: 400px; overflow: auto; color: var(--text-secondary); }
    .result-box.error { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.2); color: #f87171; }

    /* Loading spinner */
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Settings */
    .settings-section { margin-bottom: 28px; }
    .settings-section h3 { font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.05em; }
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 5px; }
    .form-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .provider-radio-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .provider-radio { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: border-color 0.15s; color: var(--text-secondary); font-size: 13px; }
    .provider-radio:hover { border-color: var(--accent); color: var(--text-primary); }
    .provider-radio.selected { border-color: var(--accent); background: var(--accent-glow); color: var(--accent-hover); }
    .provider-radio input[type=radio] { accent-color: var(--accent); }
    .cap-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .cap-item { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12px; }
    .cap-item .cap-label { color: var(--text-muted); margin-bottom: 2px; }
    .cap-item .cap-value { font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); }
    .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
    .status-dot.ok { background: var(--success); box-shadow: 0 0 5px rgba(34,197,94,0.4); }
    .status-dot.warn { background: var(--warning); }

    /* Welcome wizard modal */
    .wizard-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(4px); }
    .wizard-overlay.hidden { display: none; }
    .wizard-modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; max-width: 520px; width: 90%; box-shadow: var(--shadow-lg); }
    .wizard-modal h2 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: var(--text-primary); letter-spacing: -0.02em; }
    .wizard-modal .subtitle { color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
    .wizard-steps { display: flex; gap: 6px; margin-bottom: 28px; }
    .wizard-step-dot { flex: 1; height: 3px; background: var(--border); border-radius: 2px; transition: background 0.2s; }
    .wizard-step-dot.active { background: var(--accent); }
    .wizard-step-dot.done { background: var(--success); }
    .wizard-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }

    /* Analytics */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; text-align: center; backdrop-filter: blur(8px); }
    .stat-card .stat-value { font-size: 32px; font-weight: 700; color: var(--accent); font-family: var(--font-mono); line-height: 1.2; }
    .stat-card .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .bar-chart { margin-bottom: 20px; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
    .bar-label { width: 140px; flex-shrink: 0; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { flex: 1; background: var(--bg-hover); border-radius: 4px; height: 8px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s ease; opacity: 0.8; }
    .bar-count { width: 36px; text-align: right; color: var(--text-muted); flex-shrink: 0; font-family: var(--font-mono); font-size: 12px; }
    .tag-cloud { display: flex; flex-wrap: wrap; gap: 8px; }

    /* Timeline */
    .chain { display: flex; align-items: center; flex-wrap: wrap; gap: 0; margin-bottom: 16px; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); }
    .chain-node { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 14px; font-size: 13px; position: relative; transition: border-color 0.15s; }
    .chain-node:hover { border-color: var(--accent); }
    .chain-node.archived { opacity: 0.4; }
    .chain-node .cn-name { font-weight: 600; color: var(--text-primary); }
    .chain-node .cn-type { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
    .chain-arrow { font-size: 16px; color: var(--accent); padding: 0 8px; flex-shrink: 0; opacity: 0.6; }

    /* Graph */
    .graph-svg-wrap { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; position: relative; }
    .graph-svg-wrap svg { width: 100%; height: 520px; display: block; }
    .graph-controls { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; font-size: 12px; color: var(--text-muted); }

    /* Graph tooltip */
    .graph-tooltip {
      position: absolute;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      font-size: 12px;
      pointer-events: none;
      backdrop-filter: blur(12px);
      box-shadow: var(--shadow-lg);
      max-width: 280px;
      z-index: 10;
    }

    /* Manage */
    .manage-action-cell { display: flex; gap: 6px; flex-wrap: wrap; }

    /* Feedback widget */
    #feedback-btn {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--accent); color: white;
      border: none; padding: 10px 16px;
      border-radius: 999px; cursor: pointer;
      font-size: 13px; font-weight: 500;
      box-shadow: var(--shadow-md), var(--shadow-glow);
      transition: all 0.2s ease; z-index: 50;
      font-family: var(--font-sans);
    }
    #feedback-btn:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg), 0 0 30px var(--accent-glow); }
    #feedback-panel {
      position: fixed; bottom: 72px; right: 24px;
      width: 340px; background: var(--bg-secondary);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; box-shadow: var(--shadow-lg);
      z-index: 51; backdrop-filter: blur(16px); display: none;
    }
    #feedback-panel.open { display: block; }
    #feedback-panel h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; color: var(--text-primary); }
    .fb-radio-group { display: flex; gap: 8px; margin-bottom: 12px; }
    .fb-radio { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); cursor: pointer; font-size: 12px; color: var(--text-secondary); }
    .fb-radio.selected { border-color: var(--accent); background: var(--accent-glow); color: var(--accent-hover); }
    .fb-radio input { accent-color: var(--accent); }
    #fb-desc { width: 100%; height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); font-size: 13px; resize: vertical; outline: none; margin-bottom: 10px; background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-sans); }
    #fb-desc:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    .fb-sys-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }

    /* Highlight */
    mark { background: rgba(59,130,246,0.2); color: inherit; padding: 1px 3px; border-radius: 3px; }

    /* Hidden */
    .hidden { display: none !important; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    /* Responsive */
    @media (max-width: 768px) {
      .content { padding: 16px; }
      .nav button { padding: 10px 12px; font-size: 12px; }
      .header h1 { font-size: 15px; }
      .search-row { flex-direction: column; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      #feedback-panel { width: calc(100vw - 48px); }
      #feedback-btn { bottom: 16px; right: 16px; }
    }
    @media (max-width: 480px) {
      .nav { gap: 0; }
      .nav button { flex: 1; font-size: 11px; padding: 10px 6px; }
      .stats-grid { grid-template-columns: 1fr; }
      .header { padding: 12px 16px; }
    }
  `.trim();

  // The inline script uses only createElement / textContent for all user data.
  // No dynamic HTML concatenation with unsanitised strings.
  const SCRIPT = `
(function () {
  'use strict';

  var _currentVersion = '';
  var _currentSearchLevel = '';

  // ---- API ----
  async function apiCall(method, path, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);
    try {
      var opts = { method: method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
      if (body !== undefined) opts.body = JSON.stringify(body);
      var res = await fetch(path, opts);
      clearTimeout(timeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Request timed out (10s)');
      throw err;
    }
  }

  // ---- Theme (dark default, light class toggles light mode) ----
  (function initTheme() {
    var saved = localStorage.getItem('memesh-theme');
    if (saved === 'light') { document.body.classList.add('light'); }
    var themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.textContent = document.body.classList.contains('light') ? '\\ud83c\\udf19' : '\\u2600\\ufe0f';
      themeBtn.addEventListener('click', function () {
        document.body.classList.toggle('light');
        var isLight = document.body.classList.contains('light');
        themeBtn.textContent = isLight ? '\\ud83c\\udf19' : '\\u2600\\ufe0f';
        localStorage.setItem('memesh-theme', isLight ? 'light' : 'dark');
        try { apiCall('POST', '/v1/config', { theme: isLight ? 'light' : 'dark' }); } catch (_) {}
        // Update graph label colors if graph has been rendered
        var newLabelColor = isLight ? '#09090b' : '#fafafa';
        var graphWrap = document.getElementById('graph-svg-wrap');
        if (graphWrap) {
          graphWrap.querySelectorAll('svg g text:not([font-size="9"])').forEach(function(el) {
            el.setAttribute('fill', newLabelColor);
          });
        }
      });
    }
  })();

  // ---- Tab switching ----
  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    var tab = btn.dataset.tab;
    document.querySelectorAll('.nav button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'browse') loadBrowse();
    if (tab === 'graph') loadGraph();
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'timeline') loadTimeline();
    if (tab === 'manage') loadManage();
    if (tab === 'settings') loadSettings();
  });

  // ---- Health check ----
  async function checkHealth() {
    var indicator = document.getElementById('health-indicator');
    var versionLabel = document.getElementById('version-label');
    try {
      var data = await apiCall('GET', '/v1/health');
      if (!data.success) throw new Error(data.error || 'API error');
      _currentVersion = data.data.version || '';
      var dot = document.createElement('span');
      dot.className = 'dot';
      indicator.textContent = '';
      indicator.appendChild(dot);
      indicator.appendChild(document.createTextNode('Connected'));
      versionLabel.textContent = 'v' + data.data.version + '  \u00b7  ' + data.data.entity_count + ' entities';
    } catch (_err) {
      var dot2 = document.createElement('span');
      dot2.className = 'dot error';
      indicator.textContent = '';
      indicator.appendChild(dot2);
      indicator.appendChild(document.createTextNode('Disconnected'));
    }
  }

  // ---- Shared: build entity table from array using only DOM APIs ----
  // Redesigned: shows Time (locale) | Memory Preview | Source/Type | Status | Tags
  // Entity name is secondary — first observation preview is the primary content
  function buildEntityTable(entities, highlightTerm) {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    ['Time', 'Memory', 'Type', 'Status', 'Tags'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      if (h === 'Memory') th.style.width = '45%';
      if (h === 'Time') th.style.width = '140px';
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    entities.forEach(function (e) {
      var status = e.archived ? 'archived' : (e.status || 'active');
      var tr = document.createElement('tr');
      if (status === 'archived') tr.style.opacity = '0.5';

      // Time column — locale-formatted timestamp
      var tdTime = document.createElement('td');
      tdTime.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:nowrap;';
      try {
        var d = new Date(e.created_at);
        tdTime.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        tdTime.textContent = e.created_at || '—';
      }
      tdTime.title = e.created_at || '';
      tr.appendChild(tdTime);

      // Memory column — first observation as preview, entity name as secondary
      var tdMemory = document.createElement('td');
      var memoryContent = document.createElement('div');

      // Primary: first observation (the actual useful content)
      var preview = document.createElement('div');
      preview.style.cssText = 'font-size:13px;line-height:1.5;margin-bottom:2px;';
      var firstObs = (e.observations && e.observations.length > 0) ? e.observations[0] : '(no observations)';
      var previewText = firstObs.length > 120 ? firstObs.slice(0, 120) + '\\u2026' : firstObs;
      if (highlightTerm) {
        highlightText(preview, previewText, highlightTerm);
      } else {
        preview.textContent = previewText;
      }
      memoryContent.appendChild(preview);

      // Secondary: entity name (technical identifier) + observation count
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);';
      var obsCount = e.observations ? e.observations.length : 0;
      meta.textContent = e.name + (obsCount > 1 ? ' \\u00b7 ' + obsCount + ' observations' : '');
      memoryContent.appendChild(meta);

      tdMemory.appendChild(memoryContent);
      tr.appendChild(tdMemory);

      // Type badge
      var tdType = document.createElement('td');
      var typeBadge = document.createElement('span');
      typeBadge.className = 'badge badge-type';
      typeBadge.textContent = e.type;
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      // Status badge
      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-' + (status === 'archived' ? 'archived' : 'active');
      statusBadge.textContent = status;
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // Tags
      var tdTags = document.createElement('td');
      if (e.tags && e.tags.length > 0) {
        e.tags.slice(0, 3).forEach(function (t) {
          var pill = document.createElement('span');
          pill.className = 'tag-pill';
          pill.textContent = t;
          tdTags.appendChild(pill);
        });
        if (e.tags.length > 3) {
          var more = document.createElement('span');
          more.className = 'tag-pill';
          more.style.opacity = '0.6';
          more.textContent = '+' + (e.tags.length - 3);
          tdTags.appendChild(more);
        }
      }
      tr.appendChild(tdTags);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(table);
    return wrap;
  }

  function showError(container, msg) {
    container.textContent = '';
    var box = document.createElement('div');
    box.className = 'result-box error';
    box.textContent = msg;
    container.appendChild(box);
  }

  function showPlaceholder(container, text) {
    container.textContent = '';
    var ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = text;
    container.appendChild(ph);
  }

  function showSpinner(container) {
    container.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'placeholder';
    var sp = document.createElement('div');
    sp.className = 'loading';
    wrap.appendChild(sp);
    container.appendChild(wrap);
  }

  // ---- Search term highlighting (XSS-safe via createElement/textContent) ----
  function highlightText(container, text, term) {
    if (!term) { container.textContent = text; return; }
    var lower = text.toLowerCase();
    var lowerTerm = term.toLowerCase();
    var termLen = lowerTerm.length;
    if (termLen === 0) { container.textContent = text; return; }
    var pos = 0;
    while (pos < text.length) {
      var idx = lower.indexOf(lowerTerm, pos);
      if (idx === -1) {
        container.appendChild(document.createTextNode(text.slice(pos)));
        break;
      }
      if (idx > pos) {
        container.appendChild(document.createTextNode(text.slice(pos, idx)));
      }
      var mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + termLen);
      container.appendChild(mark);
      pos = idx + termLen;
    }
  }

  // ---- Search tab ----
  var searchInput = document.getElementById('search-query');
  var searchBtn = document.getElementById('search-btn');
  var searchResults = document.getElementById('search-results');

  async function doSearch() {
    var q = searchInput.value.trim();
    if (!q) return;
    showSpinner(searchResults);
    try {
      var data = await apiCall('POST', '/v1/recall', { query: q, limit: 20 });
      searchResults.textContent = '';
      if (!data.success) { showError(searchResults, data.error || 'Unknown error'); return; }
      var entities = Array.isArray(data.data) ? data.data : (data.data.entities || []);
      if (entities.length === 0) { showPlaceholder(searchResults, 'No results for "' + q + '"'); return; }
      searchResults.appendChild(buildEntityTable(entities, q));
    } catch (err) {
      showError(searchResults, err.message);
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  // ---- Browse tab ----
  var allEntities = [];
  var browseFilter = document.getElementById('browse-filter');
  var browseWrap = document.getElementById('browse-table-wrap');

  async function loadBrowse() {
    showSpinner(browseWrap);
    try {
      var data = await apiCall('GET', '/v1/entities?limit=200');
      if (!data.success) throw new Error(data.error || 'Failed to load entities');
      allEntities = data.data || [];
      renderBrowseTable(browseFilter.value);
    } catch (err) {
      showError(browseWrap, err.message);
    }
  }

  function renderBrowseTable(filter) {
    var f = (filter || '').toLowerCase();
    var rows = allEntities.filter(function (e) {
      return !f || e.name.toLowerCase().includes(f) || e.type.toLowerCase().includes(f);
    });
    browseWrap.textContent = '';
    if (rows.length === 0) { showPlaceholder(browseWrap, 'No entities found'); return; }
    browseWrap.appendChild(buildEntityTable(rows, filter || ''));
  }

  browseFilter.addEventListener('input', function () { renderBrowseTable(this.value); });
  document.getElementById('browse-refresh').addEventListener('click', loadBrowse);

  // ---- Graph tab ----
  var graphLoaded = false;

  async function loadGraph() {
    if (graphLoaded) return;
    graphLoaded = true;
    var wrap = document.getElementById('graph-svg-wrap');
    showSpinner(wrap);
    try {
      var data = await apiCall('GET', '/v1/graph');
      if (!data.success) throw new Error(data.error || 'Failed to load graph');
      renderGraph(data.data.entities || [], data.data.relations || [], wrap);
    } catch (err) {
      showError(wrap, err.message);
      graphLoaded = false;
    }
  }

  function renderGraph(entities, relations, container) {
    container.textContent = '';

    if (entities.length === 0) {
      showPlaceholder(container, 'No entities yet. Start remembering to build your graph.');
      return;
    }

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '520');
    container.appendChild(svg);

    var width = container.clientWidth || 900;
    var height = 520;

    // Only show top connected nodes to keep graph readable
    var MAX_NODES = 60;
    var degreeMap = {};
    relations.forEach(function (r) {
      degreeMap[r.from] = (degreeMap[r.from] || 0) + 1;
      degreeMap[r.to] = (degreeMap[r.to] || 0) + 1;
    });

    var topNames;
    if (Object.keys(degreeMap).length > 0) {
      topNames = new Set(
        Object.entries(degreeMap)
          .sort(function (a, b) { return b[1] - a[1]; })
          .slice(0, MAX_NODES)
          .map(function (e) { return e[0]; })
      );
    } else {
      topNames = new Set(entities.slice(0, MAX_NODES).map(function (e) { return e.name; }));
    }

    var graphEntities = entities.filter(function (e) { return topNames.has(e.name); });
    if (graphEntities.length === 0) graphEntities = entities.slice(0, MAX_NODES);

    var colorPalette = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16','#f97316','#6366f1'];
    var typeColorMap = {};
    var colorIdx = 0;
    graphEntities.forEach(function (e) {
      if (!typeColorMap[e.type]) {
        typeColorMap[e.type] = colorPalette[colorIdx % colorPalette.length];
        colorIdx++;
      }
    });

    // Build nodes and links
    var nodeMap = {};
    var nodes = graphEntities.map(function (e, i) {
      var n = { id: e.name, type: e.type, status: e.status, obs: e.observations ? e.observations.length : 0, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null };
      nodeMap[e.name] = n;
      return n;
    });

    var links = relations
      .filter(function (r) { return nodeMap[r.from] && nodeMap[r.to]; })
      .map(function (r) { return { source: r.from, target: r.to, type: r.type }; });

    // Force simulation using pure JS (no D3 needed for basic layout)
    // Initialize positions in a circle
    nodes.forEach(function (n, i) {
      var angle = (2 * Math.PI * i) / nodes.length;
      var r = Math.min(width, height) * 0.35;
      n.x = width / 2 + r * Math.cos(angle);
      n.y = height / 2 + r * Math.sin(angle);
    });

    // Create SVG elements using D3 (bundled)
    var d3svg = d3.select(svg);
    d3svg.attr('viewBox', [0, 0, width, height]);

    // Defs: arrow marker + glow filter + grid pattern
    var defs = d3svg.append('defs');

    // Arrow marker
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 10 10').attr('refX', 20).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', 'rgba(59,130,246,0.4)');

    // Glow filter
    var filter = defs.append('filter').attr('id', 'node-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
    var feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Grid pattern background
    var gridSize = 32;
    var gridPattern = defs.append('pattern')
      .attr('id', 'grid').attr('width', gridSize).attr('height', gridSize)
      .attr('patternUnits', 'userSpaceOnUse');
    gridPattern.append('path')
      .attr('d', 'M ' + gridSize + ' 0 L 0 0 0 ' + gridSize)
      .attr('fill', 'none').attr('stroke', 'rgba(39,39,42,0.4)').attr('stroke-width', '0.5');

    // Background rect with grid
    d3svg.append('rect')
      .attr('width', width).attr('height', height)
      .attr('fill', 'url(#grid)');

    var g = d3svg.append('g');

    d3svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', function (event) {
      g.attr('transform', event.transform);
    }));

    var linkSel = g.append('g')
      .selectAll('line').data(links).join('line')
      .attr('stroke', 'rgba(59,130,246,0.25)').attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arrow)');

    var linkLabel = g.append('g')
      .selectAll('text').data(links).join('text')
      .attr('font-size', 9).attr('fill', 'rgba(113,113,122,0.8)').attr('text-anchor', 'middle')
      .attr('font-family', 'JetBrains Mono, ui-monospace, monospace')
      .text(function (d) { return d.type; });

    var nodeSel = g.append('g')
      .selectAll('circle').data(nodes).join('circle')
      .attr('r', function (d) { return Math.max(6, Math.min(20, 6 + d.obs * 1.5)); })
      .attr('fill', function (d) { return typeColorMap[d.type] || '#3b82f6'; })
      .attr('stroke', 'rgba(9,9,11,0.8)').attr('stroke-width', 1.5)
      .attr('opacity', function (d) { return d.status === 'archived' ? 0.3 : 0.9; })
      .attr('filter', function (d) { return d.status === 'archived' ? null : 'url(#node-glow)'; })
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', function (event, d) { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', function (event, d) { d.fx = event.x; d.fy = event.y; })
        .on('end', function (event, d) { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    // Hover pulse effect
    nodeSel.on('mouseenter', function () {
      d3.select(this).attr('stroke', '#3b82f6').attr('stroke-width', 2.5);
    }).on('mouseleave', function () {
      d3.select(this).attr('stroke', 'rgba(9,9,11,0.8)').attr('stroke-width', 1.5);
    });

    var labelColor = document.body.classList.contains('light') ? '#09090b' : '#fafafa';
    var labelSel = g.append('g')
      .selectAll('text').data(nodes).join('text')
      .attr('font-size', 11).attr('fill', labelColor).attr('dy', 4)
      .attr('font-family', 'Inter, system-ui, sans-serif').attr('font-weight', '500')
      .text(function (d) { return d.id.length > 30 ? d.id.slice(0, 30) + '\u2026' : d.id; });

    // Tooltip
    var ttEl = document.getElementById('live-tooltip');
    nodeSel.on('mouseover', function (event, d) {
      ttEl.style.display = 'block';
      ttEl.querySelector('.tt-name').textContent = d.id;
      ttEl.querySelector('.tt-type').textContent = d.type + (d.status === 'archived' ? ' \u2014 archived' : '');
      ttEl.querySelector('.tt-obs').textContent = d.obs + ' observation' + (d.obs !== 1 ? 's' : '');
    }).on('mousemove', function (event) {
      ttEl.style.left = (event.pageX + 14) + 'px';
      ttEl.style.top = (event.pageY - 10) + 'px';
    }).on('mouseout', function () { ttEl.style.display = 'none'; });

    var sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function (d) { return d.id; }).distance(150))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(22));

    sim.on('tick', function () {
      linkSel
        .attr('x1', function (d) { return d.source.x; }).attr('y1', function (d) { return d.source.y; })
        .attr('x2', function (d) { return d.target.x; }).attr('y2', function (d) { return d.target.y; });
      linkLabel
        .attr('x', function (d) { return (d.source.x + d.target.x) / 2; })
        .attr('y', function (d) { return (d.source.y + d.target.y) / 2; });
      nodeSel.attr('cx', function (d) { return d.x; }).attr('cy', function (d) { return d.y; });
      labelSel.attr('x', function (d) { return d.x + 10; }).attr('y', function (d) { return d.y; });
    });

    // Legend
    var legend = document.createElement('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;font-size:12px;padding:0 2px;font-family:Inter,system-ui,sans-serif;';
    Object.entries(typeColorMap).forEach(function (pair) {
      var item = document.createElement('span');
      item.style.cssText = 'display:flex;align-items:center;gap:5px;color:var(--text-secondary,#a1a1aa);';
      var dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;display:inline-block;background:' + pair[1] + ';box-shadow:0 0 4px ' + pair[1] + '66;';
      var lbl = document.createElement('span');
      lbl.textContent = pair[0];
      item.appendChild(dot);
      item.appendChild(lbl);
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }

  // ---- Analytics tab ----
  var analyticsLoaded = false;

  async function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;
    var container = document.getElementById('analytics-body');
    showSpinner(container);
    try {
      var data = await apiCall('GET', '/v1/stats');
      if (!data.success) throw new Error(data.error || 'Failed to load stats');
      renderAnalytics(data.data, container);
    } catch (err) {
      showError(container, err.message);
      analyticsLoaded = false;
    }
  }

  function renderAnalytics(stats, container) {
    container.textContent = '';

    // Stats grid
    var grid = document.createElement('div');
    grid.className = 'stats-grid';
    [
      { label: 'Entities', value: stats.totalEntities },
      { label: 'Observations', value: stats.totalObservations },
      { label: 'Relations', value: stats.totalRelations },
      { label: 'Unique Tags', value: stats.totalTags },
    ].forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'stat-card';
      var val = document.createElement('div');
      val.className = 'stat-value';
      val.textContent = String(c.value);
      var lbl = document.createElement('div');
      lbl.className = 'stat-label';
      lbl.textContent = c.label;
      card.appendChild(val);
      card.appendChild(lbl);
      grid.appendChild(card);
    });
    container.appendChild(grid);

    // Status distribution
    if (stats.statusDistribution && stats.statusDistribution.length > 0) {
      var statusTitle = document.createElement('h3');
      statusTitle.style.cssText = 'font-size:11px;font-weight:600;margin-bottom:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      statusTitle.textContent = 'Status Distribution';
      container.appendChild(statusTitle);
      var statusGrid = document.createElement('div');
      statusGrid.className = 'stats-grid';
      stats.statusDistribution.forEach(function (s) {
        var card = document.createElement('div');
        card.className = 'stat-card';
        var val = document.createElement('div');
        val.className = 'stat-value';
        val.textContent = String(s.count);
        var lbl = document.createElement('div');
        lbl.className = 'stat-label';
        lbl.textContent = s.status || 'active';
        card.appendChild(val);
        card.appendChild(lbl);
        statusGrid.appendChild(card);
      });
      container.appendChild(statusGrid);
    }

    // Type distribution bar chart
    if (stats.typeDistribution && stats.typeDistribution.length > 0) {
      var typeTitle = document.createElement('h3');
      typeTitle.style.cssText = 'font-size:11px;font-weight:600;margin:16px 0 10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      typeTitle.textContent = 'Type Distribution';
      container.appendChild(typeTitle);

      var maxCount = stats.typeDistribution[0].count || 1;
      var barChart = document.createElement('div');
      barChart.className = 'bar-chart';
      stats.typeDistribution.forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'bar-row';
        var lbl = document.createElement('div');
        lbl.className = 'bar-label';
        lbl.textContent = t.type;
        lbl.title = t.type;
        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = Math.round((t.count / maxCount) * 100) + '%';
        track.appendChild(fill);
        var cnt = document.createElement('div');
        cnt.className = 'bar-count';
        cnt.textContent = String(t.count);
        row.appendChild(lbl);
        row.appendChild(track);
        row.appendChild(cnt);
        barChart.appendChild(row);
      });
      container.appendChild(barChart);
    }

    // Tag cloud
    if (stats.tagDistribution && stats.tagDistribution.length > 0) {
      var tagTitle = document.createElement('h3');
      tagTitle.style.cssText = 'font-size:11px;font-weight:600;margin:16px 0 10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      tagTitle.textContent = 'Top Tags';
      container.appendChild(tagTitle);

      var maxTagCount = stats.tagDistribution[0].count || 1;
      var tagCloud = document.createElement('div');
      tagCloud.className = 'tag-cloud';
      stats.tagDistribution.forEach(function (t) {
        var pill = document.createElement('span');
        pill.className = 'tag-pill';
        var scale = 0.8 + (t.count / maxTagCount) * 0.9;
        pill.style.fontSize = Math.round(scale * 13) + 'px';
        pill.title = t.count + ' entities';
        pill.textContent = t.tag;
        tagCloud.appendChild(pill);
      });
      container.appendChild(tagCloud);
    }

    if (!stats.typeDistribution || stats.typeDistribution.length === 0) {
      showPlaceholder(container, 'No data yet. Start adding entities.');
    }
  }

  // ---- Timeline tab ----
  var timelineLoaded = false;

  async function loadTimeline() {
    if (timelineLoaded) return;
    timelineLoaded = true;
    var container = document.getElementById('timeline-body');
    showSpinner(container);
    try {
      var data = await apiCall('GET', '/v1/graph');
      if (!data.success) throw new Error(data.error || 'Failed to load graph');
      renderTimeline(data.data.entities || [], data.data.relations || [], container);
    } catch (err) {
      showError(container, err.message);
      timelineLoaded = false;
    }
  }

  function renderTimeline(entities, relations, container) {
    container.textContent = '';

    // Build entity map
    var entityMap = {};
    entities.forEach(function (e) { entityMap[e.name] = e; });

    // Find supersedes relations
    var supersedes = relations.filter(function (r) { return r.type === 'supersedes'; });

    if (supersedes.length === 0) {
      showPlaceholder(container, 'No evolution chains yet. Use "supersedes" relations to track knowledge evolution.');
      return;
    }

    // Build chains: find roots (nodes that are not a "to" in any supersedes)
    var hasIncoming = new Set(supersedes.map(function (r) { return r.to; }));
    var roots = [...new Set(supersedes.map(function (r) { return r.from; }))].filter(function (name) {
      return !hasIncoming.has(name);
    });

    // If no pure roots, just use all froms
    if (roots.length === 0) {
      roots = [...new Set(supersedes.map(function (r) { return r.from; }))];
    }

    // Build adjacency: from -> [to, ...]
    var nextMap = {};
    supersedes.forEach(function (r) {
      if (!nextMap[r.from]) nextMap[r.from] = [];
      nextMap[r.from].push(r.to);
    });

    // Walk each chain
    var visited = new Set();
    var chainCount = 0;

    roots.forEach(function (root) {
      if (visited.has(root)) return;
      var chain = [];
      var cursor = root;
      var safety = 0;
      while (cursor && !visited.has(cursor) && safety < 50) {
        visited.add(cursor);
        chain.push(cursor);
        var nexts = nextMap[cursor];
        cursor = nexts && nexts[0];
        safety++;
      }
      if (chain.length < 2) return;
      chainCount++;

      var chainEl = document.createElement('div');
      chainEl.className = 'chain';

      chain.forEach(function (name, idx) {
        if (idx > 0) {
          var arrow = document.createElement('span');
          arrow.className = 'chain-arrow';
          arrow.textContent = '\\u2192';
          chainEl.appendChild(arrow);
        }
        var node = document.createElement('div');
        var ent = entityMap[name];
        node.className = 'chain-node' + (ent && ent.status === 'archived' ? ' archived' : '');
        var nameEl = document.createElement('div');
        nameEl.className = 'cn-name';
        nameEl.textContent = name;
        var typeEl = document.createElement('div');
        typeEl.className = 'cn-type';
        typeEl.textContent = ent ? ent.type : '';
        node.appendChild(nameEl);
        node.appendChild(typeEl);
        chainEl.appendChild(node);
      });

      container.appendChild(chainEl);
    });

    if (chainCount === 0) {
      showPlaceholder(container, 'No multi-step evolution chains found.');
    }
  }

  // ---- Manage tab ----
  var allManageEntities = [];
  var manageFilter = '';

  async function loadManage() {
    var tableWrap = document.getElementById('manage-table-wrap');
    if (!tableWrap) return;
    showSpinner(tableWrap);
    try {
      var data = await apiCall('GET', '/v1/entities?limit=500&status=all');
      if (!data.success) throw new Error(data.error || 'Failed to load');
      allManageEntities = data.data || [];
      renderManageTable();
    } catch (err) {
      showError(tableWrap, err.message);
    }
  }

  function renderManageTable() {
    var filterInput = document.getElementById('manage-filter');
    var f = (filterInput ? filterInput.value : manageFilter).toLowerCase();
    var rows = allManageEntities.filter(function (e) {
      return !f || e.name.toLowerCase().includes(f) || e.type.toLowerCase().includes(f);
    });

    var tableWrap = document.getElementById('manage-table-wrap');
    if (!tableWrap) return;
    tableWrap.textContent = '';

    if (rows.length === 0) {
      showPlaceholder(tableWrap, 'No entities found');
      return;
    }

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    ['Name', 'Type', 'Status', 'Obs', 'Tags', 'Actions'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (e) {
      var status = e.status || 'active';
      var tr = document.createElement('tr');
      if (status === 'archived') tr.style.opacity = '0.6';

      var tdName = document.createElement('td');
      tdName.className = 'entity-name';
      tdName.textContent = e.name;
      tr.appendChild(tdName);

      var tdType = document.createElement('td');
      var typeBadge = document.createElement('span');
      typeBadge.className = 'badge badge-type';
      typeBadge.textContent = e.type;
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      var tdStatus = document.createElement('td');
      var sb = document.createElement('span');
      sb.className = 'badge badge-' + (status === 'archived' ? 'archived' : 'active');
      sb.textContent = status;
      tdStatus.appendChild(sb);
      tr.appendChild(tdStatus);

      var tdObs = document.createElement('td');
      tdObs.className = 'entity-obs';
      tdObs.textContent = String(e.observations ? e.observations.length : 0);
      tr.appendChild(tdObs);

      var tdTags = document.createElement('td');
      tdTags.className = 'entity-obs';
      tdTags.textContent = e.tags ? e.tags.join(', ') : '';
      tr.appendChild(tdTags);

      var tdActions = document.createElement('td');
      var actCell = document.createElement('div');
      actCell.className = 'manage-action-cell';

      if (status === 'archived') {
        var restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn-sm btn-secondary';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', function () {
          restoreBtn.disabled = true;
          restoreBtn.textContent = '...';
          apiCall('POST', '/v1/remember', { name: e.name, type: e.type, observations: [], tags: [] })
            .then(function () { loadManage(); })
            .catch(function (err) {
              restoreBtn.disabled = false;
              restoreBtn.textContent = 'Restore';
              var errEl = document.createElement('div');
              errEl.style.cssText = 'color:var(--danger);padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-xs);margin-top:8px;font-size:13px;';
              errEl.textContent = 'Error: ' + err.message;
              actCell.appendChild(errEl);
              setTimeout(function() { errEl.remove(); }, 5000);
            });
        });
        actCell.appendChild(restoreBtn);
      } else {
        var archiveBtn = document.createElement('button');
        archiveBtn.className = 'btn btn-sm btn-danger';
        archiveBtn.textContent = 'Archive';
        archiveBtn.addEventListener('click', function () {
          if (!confirm('Archive entity "' + e.name + '"? It will be hidden but not deleted.')) return;
          archiveBtn.disabled = true;
          archiveBtn.textContent = '...';
          apiCall('POST', '/v1/forget', { name: e.name })
            .then(function () { loadManage(); })
            .catch(function (err) {
              archiveBtn.disabled = false;
              archiveBtn.textContent = 'Archive';
              var errEl = document.createElement('div');
              errEl.style.cssText = 'color:var(--danger);padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-xs);margin-top:8px;font-size:13px;';
              errEl.textContent = 'Error: ' + err.message;
              actCell.appendChild(errEl);
              setTimeout(function() { errEl.remove(); }, 5000);
            });
        });
        actCell.appendChild(archiveBtn);
      }

      // Remove observation button (only if entity has observations)
      if (e.observations && e.observations.length > 0) {
        var rmObsBtn = document.createElement('button');
        rmObsBtn.className = 'btn btn-sm btn-secondary';
        rmObsBtn.textContent = 'Remove obs';
        rmObsBtn.addEventListener('click', function () {
          var modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(4px);';
          var box = document.createElement('div');
          box.className = 'card';
          box.style.cssText = 'max-width:500px;width:90%;max-height:80vh;overflow-y:auto;';
          var title = document.createElement('h3');
          title.textContent = 'Remove Observation';
          title.style.cssText = 'margin-bottom:12px;font-size:14px;font-weight:600;color:var(--text-primary);';
          box.appendChild(title);
          e.observations.forEach(function(obsText) {
            var label = document.createElement('label');
            label.style.cssText = 'display:block;padding:8px 10px;margin:4px 0;border:1px solid var(--border);border-radius:var(--radius-xs);cursor:pointer;font-size:13px;color:var(--text-secondary);transition:border-color 0.15s;';
            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'obs-select-' + e.name;
            radio.value = obsText;
            radio.style.marginRight = '8px';
            radio.style.accentColor = 'var(--accent)';
            label.appendChild(radio);
            label.appendChild(document.createTextNode(obsText.length > 120 ? obsText.slice(0, 120) + '...' : obsText));
            box.appendChild(label);
          });
          var modalErrEl = document.createElement('div');
          modalErrEl.style.cssText = 'color:var(--danger);font-size:13px;min-height:18px;margin-top:8px;';
          box.appendChild(modalErrEl);
          var btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end;';
          var cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn btn-secondary';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', function() { modal.remove(); });
          btnRow.appendChild(cancelBtn);
          var removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-danger';
          removeBtn.textContent = 'Remove Selected';
          removeBtn.addEventListener('click', function() {
            var selected = box.querySelector('input[name="obs-select-' + e.name + '"]:checked');
            if (!selected) { modalErrEl.textContent = 'Select an observation first.'; return; }
            removeBtn.disabled = true;
            removeBtn.textContent = '...';
            apiCall('POST', '/v1/forget', { name: e.name, observation: selected.value })
              .then(function() { modal.remove(); loadManage(); })
              .catch(function(err) {
                removeBtn.disabled = false;
                removeBtn.textContent = 'Remove Selected';
                modalErrEl.textContent = 'Error: ' + err.message;
              });
          });
          btnRow.appendChild(removeBtn);
          box.appendChild(btnRow);
          modal.appendChild(box);
          modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.remove(); });
          document.body.appendChild(modal);
        });
        actCell.appendChild(rmObsBtn);
      }

      tdActions.appendChild(actCell);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    var manageTableOuter = document.createElement('div');
    manageTableOuter.className = 'table-wrap';
    manageTableOuter.appendChild(table);
    tableWrap.appendChild(manageTableOuter);
  }

  document.getElementById('manage-filter').addEventListener('input', function () { renderManageTable(); });
  document.getElementById('manage-refresh').addEventListener('click', loadManage);

  // ---- Feedback widget ----
  (function initFeedback() {
    var btn = document.getElementById('feedback-btn');
    var panel = document.getElementById('feedback-panel');
    if (!btn || !panel) return;

    var fbType = 'bug';

    btn.addEventListener('click', function () {
      panel.classList.toggle('open');
    });

    // Radio group selection
    panel.querySelectorAll('.fb-radio input').forEach(function (radio) {
      radio.addEventListener('change', function () {
        panel.querySelectorAll('.fb-radio').forEach(function (el) { el.classList.remove('selected'); });
        radio.parentElement.classList.add('selected');
        fbType = radio.value;
      });
    });

    var submitBtn = document.getElementById('fb-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var desc = document.getElementById('fb-desc').value.trim();
        if (!desc) { document.getElementById('fb-desc').focus(); return; }
        var includeSys = document.getElementById('fb-sys').checked;
        var labels = 'feedback,from-dashboard,' + fbType;
        var title = encodeURIComponent('[' + fbType + '] ' + desc.slice(0, 50));
        var bodyText = '## Description\\n' + desc;
        if (includeSys) {
          bodyText += '\\n\\n## System Info\\nVersion: ' + _currentVersion + '\\nSearch Level: ' + _currentSearchLevel;
        }
        var body = encodeURIComponent(bodyText);
        window.open('https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=' + title + '&body=' + body + '&labels=' + labels, '_blank');
        panel.classList.remove('open');
        document.getElementById('fb-desc').value = '';
      });
    }

    // Close panel on outside click
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('open');
      }
    });
  })();

  // ---- Settings tab ----
  var settingsLoaded = false;

  async function loadSettings() {
    if (settingsLoaded) return;
    settingsLoaded = false; // allow re-render on each visit to reflect saved state
    var body = document.getElementById('settings-body');
    body.textContent = '';

    var configRes;
    try {
      configRes = await apiCall('GET', '/v1/config');
    } catch (err) {
      showError(body, 'Failed to load config: ' + err.message);
      return;
    }

    var currentConfig = (configRes.success && configRes.data && configRes.data.config) || {};
    var caps = (configRes.success && configRes.data && configRes.data.capabilities) || {};

    // --- Capabilities section ---
    var capSection = document.createElement('div');
    capSection.className = 'settings-section';
    var capH3 = document.createElement('h3');
    capH3.textContent = 'Current Capabilities';
    capSection.appendChild(capH3);

    var capGrid = document.createElement('div');
    capGrid.className = 'cap-grid';

    function addCap(label, value, good) {
      var item = document.createElement('div');
      item.className = 'cap-item';
      var lbl = document.createElement('div');
      lbl.className = 'cap-label';
      lbl.textContent = label;
      var val = document.createElement('div');
      val.className = 'cap-value';
      if (good !== undefined) {
        var dot = document.createElement('span');
        dot.className = 'status-dot ' + (good ? 'ok' : 'warn');
        val.appendChild(dot);
      }
      val.appendChild(document.createTextNode(String(value)));
      item.appendChild(lbl);
      item.appendChild(val);
      capGrid.appendChild(item);
    }

    var searchLevel = caps.searchLevel !== undefined ? caps.searchLevel : '?';
    _currentSearchLevel = String(searchLevel);
    addCap('Search Level', searchLevel === 1 ? 'Smart Mode' : 'Core FTS5', searchLevel === 1);
    addCap('Embeddings', caps.embeddings || 'tfidf', caps.embeddings && caps.embeddings !== 'tfidf');
    var llmProvider = (caps.llm && caps.llm.provider) ? caps.llm.provider : 'None';
    addCap('LLM Provider', llmProvider, !!caps.llm);
    var llmModel = (caps.llm && caps.llm.model) ? caps.llm.model : '\u2014';
    addCap('LLM Model', llmModel, !!caps.llm);

    capSection.appendChild(capGrid);
    body.appendChild(capSection);

    // --- LLM Provider section ---
    var llmSection = document.createElement('div');
    llmSection.className = 'settings-section';
    var llmH3 = document.createElement('h3');
    llmH3.textContent = 'LLM Provider';
    llmSection.appendChild(llmH3);

    var providerGroup = document.createElement('div');
    providerGroup.className = 'form-group';
    var providerLabel = document.createElement('label');
    providerLabel.className = 'form-label';
    providerLabel.textContent = 'Provider';
    providerGroup.appendChild(providerLabel);

    var radioGroup = document.createElement('div');
    radioGroup.className = 'provider-radio-group';
    var currentProvider = (currentConfig.llm && currentConfig.llm.provider) || '';

    ['anthropic', 'openai', 'ollama'].forEach(function (p) {
      var wrapper = document.createElement('label');
      wrapper.className = 'provider-radio' + (currentProvider === p ? ' selected' : '');

      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'llm-provider';
      radio.value = p;
      if (currentProvider === p) radio.checked = true;

      radio.addEventListener('change', function () {
        document.querySelectorAll('.provider-radio').forEach(function (el) { el.classList.remove('selected'); });
        wrapper.classList.add('selected');
        apiKeyGroup.style.display = p === 'ollama' ? 'none' : 'block';
        modelGroup.style.display = 'block';
      });

      wrapper.appendChild(radio);
      wrapper.appendChild(document.createTextNode(p.charAt(0).toUpperCase() + p.slice(1)));
      radioGroup.appendChild(wrapper);
    });

    providerGroup.appendChild(radioGroup);
    llmSection.appendChild(providerGroup);

    // API Key input
    var apiKeyGroup = document.createElement('div');
    apiKeyGroup.className = 'form-group';
    apiKeyGroup.style.display = currentProvider && currentProvider !== 'ollama' ? 'block' : (currentProvider === 'ollama' ? 'none' : 'none');

    var apiKeyLabel = document.createElement('label');
    apiKeyLabel.className = 'form-label';
    apiKeyLabel.textContent = 'API Key';
    apiKeyGroup.appendChild(apiKeyLabel);

    var apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'password';
    apiKeyInput.className = 'search-input';
    apiKeyInput.placeholder = 'sk-ant-api03-\u2026 or sk-\u2026';
    apiKeyInput.style.width = '100%';
    apiKeyInput.autocomplete = 'off';
    apiKeyGroup.appendChild(apiKeyInput);

    var apiKeyHint = document.createElement('div');
    apiKeyHint.className = 'form-hint';
    apiKeyHint.textContent = 'Leave blank to keep existing key. Key is stored in ~/.memesh/config.json (mode 600).';
    apiKeyGroup.appendChild(apiKeyHint);
    llmSection.appendChild(apiKeyGroup);

    // Model input
    var modelGroup = document.createElement('div');
    modelGroup.className = 'form-group';
    modelGroup.style.display = currentProvider ? 'block' : 'none';

    var modelLabel = document.createElement('label');
    modelLabel.className = 'form-label';
    modelLabel.textContent = 'Model (optional)';
    modelGroup.appendChild(modelLabel);

    var modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.className = 'search-input';
    modelInput.placeholder = 'e.g. claude-haiku-4-5, gpt-4o-mini, llama3.2';
    modelInput.style.width = '100%';
    if (currentConfig.llm && currentConfig.llm.model) modelInput.value = currentConfig.llm.model;
    modelGroup.appendChild(modelInput);
    llmSection.appendChild(modelGroup);

    // Save button row
    var saveRow = document.createElement('div');
    saveRow.style.display = 'flex';
    saveRow.style.gap = '10px';
    saveRow.style.alignItems = 'center';
    saveRow.style.marginTop = '4px';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';

    var saveMsg = document.createElement('span');
    saveMsg.style.fontSize = '13px';
    saveMsg.style.color = 'var(--success)';

    saveBtn.addEventListener('click', async function () {
      var selectedProvider = document.querySelector('input[name=llm-provider]:checked');
      if (!selectedProvider) { saveMsg.style.color = 'var(--danger)'; saveMsg.textContent = 'Select a provider first.'; return; }
      var prov = selectedProvider.value;
      var llmUpdate = { provider: prov };
      if (modelInput.value.trim()) llmUpdate.model = modelInput.value.trim();
      if (apiKeyInput.value.trim()) llmUpdate.apiKey = apiKeyInput.value.trim();

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      try {
        var res = await apiCall('POST', '/v1/config', { llm: llmUpdate });
        if (!res.success) throw new Error(res.error || 'Save failed');
        saveMsg.style.color = 'var(--success)';
        saveMsg.textContent = 'Saved! Restart the server to apply LLM changes.';
        apiKeyInput.value = '';
        settingsLoaded = false; // force re-render on next visit
      } catch (err) {
        saveMsg.style.color = 'var(--danger)';
        saveMsg.textContent = 'Error: ' + err.message;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    saveRow.appendChild(saveBtn);
    saveRow.appendChild(saveMsg);
    llmSection.appendChild(saveRow);
    body.appendChild(llmSection);

    // --- General settings section ---
    var genSection = document.createElement('div');
    genSection.className = 'settings-section';
    var genH3 = document.createElement('h3');
    genH3.textContent = 'General';
    genSection.appendChild(genH3);

    // Auto-capture toggle
    var autoGroup = document.createElement('div');
    autoGroup.className = 'form-group';
    autoGroup.style.display = 'flex';
    autoGroup.style.alignItems = 'center';
    autoGroup.style.gap = '10px';

    var autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox';
    autoCheck.id = 'auto-capture';
    autoCheck.style.accentColor = 'var(--accent)';
    autoCheck.checked = currentConfig.autoCapture !== false;

    var autoLabel = document.createElement('label');
    autoLabel.htmlFor = 'auto-capture';
    autoLabel.style.fontSize = '13px';
    autoLabel.style.fontWeight = '600';
    autoLabel.style.cursor = 'pointer';
    autoLabel.textContent = 'Auto-capture (session-start hook)';

    autoGroup.appendChild(autoCheck);
    autoGroup.appendChild(autoLabel);
    genSection.appendChild(autoGroup);

    var autoHint = document.createElement('div');
    autoHint.className = 'form-hint';
    autoHint.style.marginLeft = '28px';
    autoHint.textContent = 'Automatically recall project memories at the start of each Claude Code session.';
    genSection.appendChild(autoHint);

    var genSaveRow = document.createElement('div');
    genSaveRow.style.marginTop = '12px';

    var genSaveBtn = document.createElement('button');
    genSaveBtn.className = 'btn btn-primary btn-sm';
    genSaveBtn.textContent = 'Save';

    var genMsg = document.createElement('span');
    genMsg.style.fontSize = '13px';
    genMsg.style.marginLeft = '10px';
    genMsg.style.color = 'var(--success)';

    genSaveBtn.addEventListener('click', async function () {
      genSaveBtn.disabled = true;
      genSaveBtn.textContent = 'Saving\u2026';
      try {
        var res = await apiCall('POST', '/v1/config', { autoCapture: autoCheck.checked });
        if (!res.success) throw new Error(res.error || 'Save failed');
        genMsg.style.color = 'var(--success)';
        genMsg.textContent = 'Saved!';
        setTimeout(function () { genMsg.textContent = ''; }, 3000);
      } catch (err) {
        genMsg.style.color = 'var(--danger)';
        genMsg.textContent = 'Error: ' + err.message;
      } finally {
        genSaveBtn.disabled = false;
        genSaveBtn.textContent = 'Save';
      }
    });

    genSaveRow.appendChild(genSaveBtn);
    genSaveRow.appendChild(genMsg);
    genSection.appendChild(genSaveRow);
    body.appendChild(genSection);
  }

  // ---- Welcome Wizard ----
  var wizardStep = 0;
  var wizardProvider = '';
  var wizardApiKey = '';
  var wizardModel = '';

  function updateWizardStepDots(totalSteps) {
    var dotsEl = document.getElementById('wizard-steps');
    dotsEl.textContent = '';
    for (var i = 0; i < totalSteps; i++) {
      var dot = document.createElement('div');
      dot.className = 'wizard-step-dot' + (i < wizardStep ? ' done' : (i === wizardStep ? ' active' : ''));
      dotsEl.appendChild(dot);
    }
  }

  function renderWizardStep() {
    var content = document.getElementById('wizard-content');
    var actions = document.getElementById('wizard-actions');
    content.textContent = '';
    actions.textContent = '';
    updateWizardStepDots(3);

    if (wizardStep === 0) {
      var title = document.createElement('h2');
      title.textContent = 'Welcome to MeMesh';
      content.appendChild(title);

      var sub = document.createElement('p');
      sub.className = 'subtitle';
      sub.textContent = 'MeMesh gives Claude a persistent knowledge graph. Set up an LLM provider to unlock Smart Mode \u2014 semantic search, conflict detection, and knowledge evolution.';
      content.appendChild(sub);

      var capList = document.createElement('ul');
      capList.style.listStyle = 'none';
      capList.style.marginBottom = '8px';
      [
        ['Core FTS5 search \u2014 always available', true],
        ['Smart Mode (LLM) \u2014 requires API key', false],
        ['Auto-capture on session start', true],
      ].forEach(function (item) {
        var li = document.createElement('li');
        li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px;';
        var dot = document.createElement('span');
        dot.className = 'status-dot ' + (item[1] ? 'ok' : 'warn');
        li.appendChild(dot);
        li.appendChild(document.createTextNode(String(item[0])));
        capList.appendChild(li);
      });
      content.appendChild(capList);

      var skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-secondary';
      skipBtn.textContent = 'Skip for now';
      skipBtn.addEventListener('click', closeWizard);

      var nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn-primary';
      nextBtn.textContent = 'Set up Smart Mode \u2192';
      nextBtn.addEventListener('click', function () { wizardStep = 1; renderWizardStep(); });

      actions.appendChild(skipBtn);
      actions.appendChild(nextBtn);

    } else if (wizardStep === 1) {
      var title2 = document.createElement('h2');
      title2.textContent = 'Choose a Provider';
      content.appendChild(title2);

      var sub2 = document.createElement('p');
      sub2.className = 'subtitle';
      sub2.textContent = 'Select your LLM provider and enter your API key. Keys are stored locally in ~/.memesh/config.json (mode 600).';
      content.appendChild(sub2);

      // Provider radios
      var radioGroupW = document.createElement('div');
      radioGroupW.className = 'provider-radio-group';
      radioGroupW.style.marginBottom = '16px';

      ['anthropic', 'openai', 'ollama'].forEach(function (p) {
        var wrapper = document.createElement('label');
        wrapper.className = 'provider-radio' + (wizardProvider === p ? ' selected' : '');

        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'wizard-provider';
        radio.value = p;
        if (wizardProvider === p) radio.checked = true;

        radio.addEventListener('change', function () {
          document.querySelectorAll('.provider-radio').forEach(function (el) { el.classList.remove('selected'); });
          wrapper.classList.add('selected');
          wizardProvider = p;
          keyInput.style.display = p === 'ollama' ? 'none' : 'block';
          keyLabel.style.display = p === 'ollama' ? 'none' : 'block';
        });

        wrapper.appendChild(radio);
        wrapper.appendChild(document.createTextNode(p.charAt(0).toUpperCase() + p.slice(1)));
        radioGroupW.appendChild(wrapper);
      });
      content.appendChild(radioGroupW);

      // API Key
      var keyLabel = document.createElement('label');
      keyLabel.className = 'form-label';
      keyLabel.textContent = 'API Key';
      keyLabel.style.display = wizardProvider && wizardProvider !== 'ollama' ? 'block' : 'none';
      content.appendChild(keyLabel);

      var keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.className = 'search-input';
      keyInput.placeholder = 'Paste your API key\u2026';
      keyInput.style.width = '100%';
      keyInput.style.marginBottom = '12px';
      keyInput.style.display = wizardProvider && wizardProvider !== 'ollama' ? 'block' : 'none';
      keyInput.value = wizardApiKey;
      keyInput.addEventListener('input', function () { wizardApiKey = keyInput.value; });
      content.appendChild(keyInput);

      // Error message
      var errMsg = document.createElement('div');
      errMsg.style.cssText = 'font-size:13px;color:var(--danger);min-height:18px;margin-bottom:8px;';
      content.appendChild(errMsg);

      var backBtn = document.createElement('button');
      backBtn.className = 'btn btn-secondary';
      backBtn.textContent = '\u2190 Back';
      backBtn.addEventListener('click', function () { wizardStep = 0; renderWizardStep(); });

      var testBtn = document.createElement('button');
      testBtn.className = 'btn btn-secondary';
      testBtn.textContent = 'Test Connection';
      testBtn.addEventListener('click', async function () {
        if (!wizardProvider) { errMsg.textContent = 'Select a provider.'; return; }
        if (wizardProvider !== 'ollama' && !wizardApiKey.trim()) { errMsg.textContent = 'Enter an API key.'; return; }
        testBtn.disabled = true;
        testBtn.textContent = 'Testing\u2026';
        errMsg.textContent = '';
        try {
          // Save to config and check capabilities
          var payload = { llm: { provider: wizardProvider } };
          if (wizardApiKey.trim()) payload.llm.apiKey = wizardApiKey.trim();
          var res = await apiCall('POST', '/v1/config', payload);
          if (!res.success) throw new Error(res.error || 'Config save failed');
          errMsg.style.color = 'var(--success)';
          errMsg.textContent = 'Connection config saved!';
        } catch (err) {
          errMsg.style.color = 'var(--danger)';
          errMsg.textContent = 'Error: ' + err.message;
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = 'Test Connection';
        }
      });

      var nextBtn2 = document.createElement('button');
      nextBtn2.className = 'btn btn-primary';
      nextBtn2.textContent = 'Next \u2192';
      nextBtn2.addEventListener('click', async function () {
        if (!wizardProvider) { errMsg.textContent = 'Select a provider.'; return; }
        nextBtn2.disabled = true;
        nextBtn2.textContent = 'Saving\u2026';
        try {
          var payload2 = { llm: { provider: wizardProvider }, setupCompleted: true };
          if (wizardApiKey.trim()) payload2.llm.apiKey = wizardApiKey.trim();
          var res2 = await apiCall('POST', '/v1/config', payload2);
          if (!res2.success) throw new Error(res2.error || 'Save failed');
          wizardStep = 2;
          renderWizardStep();
        } catch (err) {
          errMsg.style.color = 'var(--danger)';
          errMsg.textContent = 'Error: ' + err.message;
          nextBtn2.disabled = false;
          nextBtn2.textContent = 'Next \u2192';
        }
      });

      actions.appendChild(backBtn);
      actions.appendChild(testBtn);
      actions.appendChild(nextBtn2);

    } else if (wizardStep === 2) {
      var title3 = document.createElement('h2');
      title3.textContent = "You're all set!";
      content.appendChild(title3);

      var sub3 = document.createElement('p');
      sub3.className = 'subtitle';
      sub3.textContent = 'MeMesh Smart Mode is configured. Restart the server for LLM changes to take effect. Start using the Search and Browse tabs to explore your knowledge graph.';
      content.appendChild(sub3);

      var tipBox = document.createElement('div');
      tipBox.style.cssText = 'background:var(--accent-glow);border:1px solid rgba(59,130,246,0.2);border-radius:var(--radius-sm);padding:14px 16px;font-size:13px;line-height:1.6;color:var(--text-secondary);';
      var tipLines = [
        '\u2022 Use the Search tab to find anything across all your memories.',
        '\u2022 Browse tab shows all entities with filter controls.',
        '\u2022 Settings tab lets you change your provider anytime.',
      ];
      tipLines.forEach(function (line) {
        var p = document.createElement('p');
        p.textContent = line;
        tipBox.appendChild(p);
      });
      content.appendChild(tipBox);

      var doneBtn = document.createElement('button');
      doneBtn.className = 'btn btn-primary';
      doneBtn.textContent = 'Go to Dashboard';
      doneBtn.addEventListener('click', closeWizard);
      actions.appendChild(doneBtn);
    }
  }

  function showWelcomeWizard() {
    wizardStep = 0;
    document.getElementById('wizard-overlay').classList.remove('hidden');
    renderWizardStep();
  }

  function closeWizard() {
    document.getElementById('wizard-overlay').classList.add('hidden');
    // Mark setup completed so wizard doesn't reappear
    apiCall('POST', '/v1/config', { setupCompleted: true });
  }

  // Overlay click does NOT close wizard — user must use Skip or complete setup
  document.getElementById('wizard-overlay').addEventListener('click', function (e) {
    if (e.target === this) {
      // Intentionally do nothing — prevent accidental dismissal
    }
  });

  // ---- Init ----
  checkHealth();
  loadBrowse();

  // Check if first-run wizard should appear
  (async function checkFirstRun() {
    try {
      var res = await apiCall('GET', '/v1/config');
      if (res.success && res.data && res.data.config && !res.data.config.setupCompleted) {
        showWelcomeWizard();
      }
    } catch (_err) {
      // Silently ignore — wizard is optional
    }
  })();
})();
  `.trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeMesh LLM Memory — Dashboard</title>
  <style>${CSS}</style>
  <!-- bundled d3.js -->
  <script>
${bundledD3}
  <\/script>
</head>
<body>

<div class="header">
  <div>
    <h1 style="margin:0;line-height:1.2">MeMesh LLM Memory</h1>
    <span class="subtitle">powered by pcircle.ai</span>
  </div>
  <div class="header-right">
    <div class="meta">
      <span id="health-indicator"><span class="dot"></span>Connecting\u2026</span>
      <span id="version-label" class="version"></span>
    </div>
    <button id="theme-btn" title="Toggle theme" style="background:none;border:1px solid var(--border);border-radius:var(--radius-xs);padding:6px 10px;cursor:pointer;color:var(--text-secondary);font-size:14px;transition:border-color 0.2s ease;">\u2600\ufe0f</button>
  </div>
</div>

<nav class="nav" id="nav">
  <button class="active" data-tab="search">Search</button>
  <button data-tab="browse">Browse</button>
  <button data-tab="graph">Graph</button>
  <button data-tab="analytics">Analytics</button>
  <button data-tab="timeline">Timeline</button>
  <button data-tab="manage">Manage</button>
  <button data-tab="settings">Settings</button>
</nav>

<div class="content">

  <div class="tab-content active" id="tab-search">
    <div class="card">
      <h2>Search Knowledge</h2>
      <div class="search-row">
        <input class="search-input" id="search-query" type="text" placeholder="Search entities, observations, tags\u2026" />
        <button class="btn btn-primary" id="search-btn">Search</button>
      </div>
      <div id="search-results"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-browse">
    <div class="card">
      <h2>All Entities</h2>
      <div class="search-row">
        <input class="search-input" id="browse-filter" type="text" placeholder="Filter by name or type\u2026" />
        <button class="btn btn-secondary" id="browse-refresh">Refresh</button>
      </div>
      <div id="browse-table-wrap"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-graph">
    <div class="card">
      <h2>Knowledge Graph</h2>
      <div class="graph-controls">
        <span>Scroll to zoom \u00b7 Drag nodes \u00b7 Pan with mouse</span>
      </div>
      <div class="graph-svg-wrap" id="graph-svg-wrap"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-analytics">
    <div class="card">
      <h2>Analytics</h2>
      <div id="analytics-body"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-timeline">
    <div class="card">
      <h2>Evolution Timeline</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Entities connected by \u201csupersedes\u201d relations, showing knowledge evolution chains.</p>
      <div id="timeline-body"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-manage">
    <div class="card">
      <h2>Manage Entities</h2>
      <div class="search-row">
        <input class="search-input" id="manage-filter" type="text" placeholder="Filter by name or type\u2026" />
        <button class="btn btn-secondary" id="manage-refresh">Refresh</button>
      </div>
      <div id="manage-body">
        <div id="manage-table-wrap"></div>
      </div>
    </div>
  </div>

  <div class="tab-content" id="tab-settings">
    <div class="card" id="settings-card">
      <h2>Settings</h2>
      <div id="settings-body"></div>
    </div>
  </div>

</div>

<!-- Welcome Wizard Modal -->
<div class="wizard-overlay hidden" id="wizard-overlay">
  <div class="wizard-modal">
    <div class="wizard-steps" id="wizard-steps"></div>
    <div id="wizard-content"></div>
    <div class="wizard-actions" id="wizard-actions"></div>
  </div>
</div>

<!-- Graph tooltip -->
<div id="live-tooltip" class="graph-tooltip" style="display:none;">
  <div class="tt-name" style="font-weight:600;color:var(--text-primary);font-size:13px;margin-bottom:3px;"></div>
  <div class="tt-type" style="color:var(--accent-hover);font-size:11px;font-family:var(--font-mono);margin-bottom:4px;"></div>
  <div class="tt-obs" style="color:var(--text-muted);font-size:12px;"></div>
</div>

<!-- Feedback widget -->
<button id="feedback-btn">&#x1f4ac; Feedback</button>
<div id="feedback-panel">
  <h3>Send Feedback</h3>
  <div class="fb-radio-group">
    <label class="fb-radio selected"><input type="radio" name="fb-type" value="bug" checked /> Bug</label>
    <label class="fb-radio"><input type="radio" name="fb-type" value="feature" /> Feature</label>
    <label class="fb-radio"><input type="radio" name="fb-type" value="question" /> Question</label>
  </div>
  <textarea id="fb-desc" placeholder="Describe your feedback\u2026"></textarea>
  <div class="fb-sys-row">
    <input type="checkbox" id="fb-sys" checked style="accent-color:var(--accent);" />
    <label for="fb-sys">Include system info</label>
  </div>
  <button class="btn btn-primary" id="fb-submit" style="width:100%;">Open GitHub Issue</button>
</div>

<script>${SCRIPT}<\/script>
</body>
</html>`;
}

// CLI entry point: detect direct execution via import.meta.url
const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const dbPath =
    process.env.MEMESH_DB_PATH ??
    path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

  const html = generateDashboardHtml(dbPath);
  const dashboardDir = path.join(os.homedir(), '.memesh');
  fs.mkdirSync(dashboardDir, { recursive: true });
  const outPath = path.join(dashboardDir, 'dashboard.html');
  fs.writeFileSync(outPath, html, { encoding: 'utf-8', mode: 0o600 });

  // Open in default browser
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', outPath] : [outPath];
  const bin = platform === 'win32' ? 'cmd.exe' : cmd;

  execFile(bin, args, (err) => {
    if (err) {
      console.error(`Could not open browser: ${err.message}`);
      console.log(`Dashboard written to: ${outPath}`);
    } else {
      console.log(`Dashboard opened: ${outPath}`);
    }
  });
}
