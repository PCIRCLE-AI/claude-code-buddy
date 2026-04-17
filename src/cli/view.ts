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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a2e; }
    .header { background: #1a1a2e; color: white; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    .header .meta { opacity: 0.6; font-size: 13px; display: flex; gap: 16px; align-items: center; }
    .header-right { display: flex; gap: 10px; align-items: center; }
    .theme-btn { background: none; border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 14px; }
    .theme-btn:hover { background: rgba(255,255,255,0.1); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; margin-right: 6px; }
    .dot.error { background: #f87171; }
    .nav { display: flex; background: white; border-bottom: 1px solid #e0e0e0; padding: 0 16px; overflow-x: auto; }
    .nav button { padding: 12px 16px; border: none; background: none; cursor: pointer; font-size: 14px; color: #666; border-bottom: 2px solid transparent; white-space: nowrap; transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease; }
    .nav button.active { color: #1a1a2e; border-bottom-color: #4361ee; font-weight: 600; }
    .nav button:hover:not(.active) { color: #1a1a2e; background: #f5f5f5; }
    .content { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #1a1a2e; }
    input, button { font-family: inherit; font-size: 14px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 16px; }
    .search-input { flex: 1; padding: 9px 14px; border: 1px solid #ddd; border-radius: 6px; outline: none; background: white; color: #1a1a2e; }
    .search-input:focus { border-color: #4361ee; }
    .btn { padding: 9px 18px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
    .btn-primary { background: #4361ee; color: white; }
    .btn-primary:hover { background: #3651d4; }
    .btn-secondary { background: #f0f0f0; color: #333; }
    .btn-secondary:hover { background: #e0e0e0; }
    .btn-danger { background: #fee2e2; color: #991b1b; }
    .btn-danger:hover { background: #fecaca; }
    .btn-sm { padding: 6px 12px; font-size: 13px; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; min-width: 500px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; word-break: break-word; }
    th { font-weight: 600; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; background: #fafafa; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafbff; }
    table tbody tr:hover { background: #f8f9fa; }
    body.dark table tbody tr:hover { background: #1c2333; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
    .badge-active { background: #dcfce7; color: #166534; }
    .badge-archived { background: #fee2e2; color: #991b1b; }
    .badge-type { background: #e0e7ff; color: #3730a3; }
    .placeholder { text-align: center; padding: 60px 20px; color: #aaa; }
    .placeholder .icon { font-size: 32px; margin-bottom: 8px; }
    .result-box { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 14px; margin-top: 12px; font-size: 13px; font-family: ui-monospace, monospace; white-space: pre-wrap; max-height: 400px; overflow: auto; }
    .result-box.error { background: #fff5f5; border-color: #fecaca; color: #b91c1c; }
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid #e0e0e0; border-top-color: #4361ee; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .entity-name { font-weight: 500; }
    .entity-obs { color: #888; font-size: 12px; }
    /* Settings */
    .settings-section { margin-bottom: 28px; }
    .settings-section h3 { font-size: 14px; font-weight: 600; color: #1a1a2e; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0; }
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 5px; }
    .form-hint { font-size: 12px; color: #888; margin-top: 4px; }
    .provider-radio-group { display: flex; gap: 12px; flex-wrap: wrap; }
    .provider-radio { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; transition: border-color 0.15s; }
    .provider-radio:hover { border-color: #4361ee; }
    .provider-radio.selected { border-color: #4361ee; background: #f0f3ff; }
    .provider-radio input[type=radio] { accent-color: #4361ee; }
    .cap-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .cap-item { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 10px 12px; font-size: 12px; }
    .cap-item .cap-label { color: #888; margin-bottom: 2px; }
    .cap-item .cap-value { font-weight: 600; color: #1a1a2e; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
    .status-dot.ok { background: #4ade80; }
    .status-dot.warn { background: #facc15; }
    /* Welcome wizard modal */
    .wizard-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .wizard-overlay.hidden { display: none; }
    .wizard-modal { background: white; border-radius: 12px; padding: 32px; max-width: 520px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .wizard-modal h2 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #1a1a2e; }
    .wizard-modal .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
    .wizard-steps { display: flex; gap: 6px; margin-bottom: 28px; }
    .wizard-step-dot { flex: 1; height: 3px; background: #e0e0e0; border-radius: 2px; transition: background 0.2s; }
    .wizard-step-dot.active { background: #4361ee; }
    .wizard-step-dot.done { background: #4ade80; }
    .wizard-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
    /* Analytics */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-card { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-card .stat-value { font-size: 32px; font-weight: 700; color: #4361ee; }
    .stat-card .stat-label { font-size: 13px; color: #888; margin-top: 2px; }
    .bar-chart { margin-bottom: 20px; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
    .bar-label { width: 140px; flex-shrink: 0; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { flex: 1; background: #f0f0f0; border-radius: 4px; height: 16px; overflow: hidden; }
    .bar-fill { height: 100%; background: #4361ee; border-radius: 4px; transition: width 0.3s; }
    .bar-count { width: 36px; text-align: right; color: #888; flex-shrink: 0; }
    .tag-cloud { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag-pill { display: inline-block; padding: 3px 10px; border-radius: 12px; background: #e0e7ff; color: #3730a3; font-size: 12px; font-weight: 500; cursor: default; }
    /* Timeline */
    .chain { display: flex; align-items: center; flex-wrap: wrap; gap: 0; margin-bottom: 20px; padding: 16px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; }
    .chain-node { background: white; border: 1px solid #ddd; border-radius: 6px; padding: 8px 14px; font-size: 13px; position: relative; }
    .chain-node.archived { opacity: 0.5; }
    .chain-node .cn-name { font-weight: 600; color: #1a1a2e; }
    .chain-node .cn-type { font-size: 11px; color: #888; }
    .chain-arrow { font-size: 18px; color: #4361ee; padding: 0 6px; flex-shrink: 0; }
    /* Graph */
    .graph-svg-wrap { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden; }
    .graph-svg-wrap svg { width: 100%; height: 520px; display: block; }
    .graph-controls { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; font-size: 13px; color: #888; }
    /* Manage */
    .manage-action-cell { display: flex; gap: 6px; flex-wrap: wrap; }
    /* Feedback widget */
    #feedback-btn { position: fixed; bottom: 24px; right: 24px; background: #4361ee; color: white; border: none; border-radius: 24px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(67,97,238,0.4); z-index: 900; transition: background 0.15s, transform 0.15s; }
    #feedback-btn:hover { background: #3651d4; transform: translateY(-1px); }
    #feedback-panel { position: fixed; bottom: 76px; right: 24px; width: 320px; background: white; border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); padding: 20px; z-index: 900; display: none; }
    #feedback-panel.open { display: block; }
    #feedback-panel h3 { font-size: 15px; font-weight: 700; margin-bottom: 14px; color: #1a1a2e; }
    .fb-radio-group { display: flex; gap: 8px; margin-bottom: 12px; }
    .fb-radio { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .fb-radio.selected { border-color: #4361ee; background: #f0f3ff; color: #4361ee; }
    .fb-radio input { accent-color: #4361ee; }
    #fb-desc { width: 100%; height: 80px; padding: 8px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 10px; background: white; color: #1a1a2e; }
    #fb-desc:focus { border-color: #4361ee; }
    .fb-sys-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #666; margin-bottom: 12px; }
    /* Dark mode */
    body.dark { background: #0d1117; color: #c9d1d9; }
    body.dark .header { background: #010409; }
    body.dark .nav { background: #161b22; border-color: #30363d; }
    body.dark .nav button { color: #8b949e; }
    body.dark .nav button.active { color: #c9d1d9; border-bottom-color: #58a6ff; }
    body.dark .nav button:hover:not(.active) { color: #c9d1d9; background: #21262d; }
    body.dark .card { background: #161b22; border: 1px solid #30363d; box-shadow: none; }
    body.dark .card h2 { color: #c9d1d9; }
    body.dark th { background: #0d1117; color: #8b949e; }
    body.dark td { border-color: #21262d; }
    body.dark tr:hover td { background: #1c2128; }
    body.dark .search-input { background: #0d1117; color: #c9d1d9; border-color: #30363d; }
    body.dark .search-input:focus { border-color: #58a6ff; }
    body.dark .btn-secondary { background: #21262d; color: #c9d1d9; }
    body.dark .btn-secondary:hover { background: #30363d; }
    body.dark .btn-danger { background: #3d1f1f; color: #f87171; }
    body.dark .btn-danger:hover { background: #4d2020; }
    body.dark .result-box { background: #0d1117; border-color: #30363d; color: #c9d1d9; }
    body.dark .result-box.error { background: #2d1b1b; border-color: #5c2626; color: #f87171; }
    body.dark .stat-card { background: #0d1117; border-color: #30363d; }
    body.dark .stat-card .stat-value { color: #58a6ff; }
    body.dark .stat-card .stat-label { color: #8b949e; }
    body.dark .bar-track { background: #21262d; }
    body.dark .bar-fill { background: #58a6ff; }
    body.dark .bar-label { color: #c9d1d9; }
    body.dark .tag-pill { background: #1c2128; color: #79c0ff; border: 1px solid #30363d; }
    body.dark .chain { background: #0d1117; border-color: #30363d; }
    body.dark .chain-node { background: #161b22; border-color: #30363d; }
    body.dark .chain-node .cn-name { color: #c9d1d9; }
    body.dark .graph-svg-wrap { background: #0d1117; border-color: #30363d; }
    body.dark .cap-item { background: #0d1117; border-color: #30363d; }
    body.dark .cap-item .cap-value { color: #c9d1d9; }
    body.dark .settings-section h3 { border-color: #30363d; color: #c9d1d9; }
    body.dark .form-label { color: #c9d1d9; }
    body.dark .provider-radio { border-color: #30363d; color: #c9d1d9; }
    body.dark .provider-radio.selected { background: #1c2128; border-color: #58a6ff; color: #79c0ff; }
    body.dark #feedback-panel { background: #161b22; border-color: #30363d; }
    body.dark #feedback-panel h3 { color: #c9d1d9; }
    body.dark .fb-radio { border-color: #30363d; color: #c9d1d9; }
    body.dark .fb-radio.selected { border-color: #58a6ff; background: #1c2128; color: #79c0ff; }
    body.dark #fb-desc { background: #0d1117; color: #c9d1d9; border-color: #30363d; }
    body.dark .fb-sys-row { color: #8b949e; }
    body.dark .wizard-modal { background: #161b22; }
    body.dark .wizard-modal h2 { color: #c9d1d9; }
    body.dark .wizard-modal .subtitle { color: #8b949e; }
    body.dark .wizard-step-dot { background: #30363d; }
    body.dark .placeholder { color: #484f58; }
    @media (max-width: 768px) {
      .content { padding: 0 12px; margin: 12px auto; }
      .nav { flex-wrap: wrap; }
      .nav button { padding: 10px 10px; font-size: 12px; flex: 1; min-width: 0; }
      .header h1 { font-size: 16px; }
      .search-row { flex-direction: column; gap: 8px; }
      .search-input { min-width: auto; width: 100%; }
      .card { padding: 14px; }
      #feedback-panel { width: calc(100vw - 48px); right: 24px; }
      #feedback-btn { bottom: 16px; right: 16px; font-size: 14px; padding: 10px 14px; }
    }
    @media (max-width: 480px) {
      .nav button { font-size: 11px; padding: 8px 6px; }
      .header { padding: 10px 16px; }
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

  // ---- Dark mode ----
  (function initTheme() {
    var saved = localStorage.getItem('memesh-theme');
    if (saved === 'dark') { document.body.classList.add('dark'); }
    var themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.textContent = document.body.classList.contains('dark') ? '\\u2600\\ufe0f' : '\\ud83c\\udf19';
      themeBtn.addEventListener('click', function () {
        document.body.classList.toggle('dark');
        var isDark = document.body.classList.contains('dark');
        themeBtn.textContent = isDark ? '\\u2600\\ufe0f' : '\\ud83c\\udf19';
        localStorage.setItem('memesh-theme', isDark ? 'dark' : 'light');
        try { apiCall('POST', '/v1/config', { theme: isDark ? 'dark' : 'light' }); } catch (_) {}
        // Update graph label colors if graph has been rendered
        var newLabelColor = isDark ? '#c9d1d9' : '#374151';
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
  function buildEntityTable(entities, highlightTerm) {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    ['Name', 'Type', 'Status', 'Obs', 'Tags'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    entities.forEach(function (e) {
      var status = e.archived ? 'archived' : (e.status || 'active');
      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.className = 'entity-name';
      if (highlightTerm) {
        highlightText(tdName, e.name, highlightTerm);
      } else {
        tdName.textContent = e.name;
      }
      tr.appendChild(tdName);

      var tdType = document.createElement('td');
      var typeBadge = document.createElement('span');
      typeBadge.className = 'badge badge-type';
      typeBadge.textContent = e.type;
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-' + (status === 'archived' ? 'archived' : 'active');
      statusBadge.textContent = status;
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      var tdObs = document.createElement('td');
      tdObs.className = 'entity-obs';
      tdObs.textContent = String(e.observations ? e.observations.length : 0);
      tr.appendChild(tdObs);

      var tdTags = document.createElement('td');
      tdTags.className = 'entity-obs';
      tdTags.textContent = e.tags ? e.tags.join(', ') : '';
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
      mark.style.cssText = 'background:#fef08a;color:inherit;padding:1px 2px;border-radius:2px;';
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

    var colorPalette = ['#4361ee','#e63946','#2a9d8f','#e9c46a','#f4a261','#a8dadc','#6d6875','#b5838d','#e9724c','#c5283d'];
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

    // Arrow markers for links
    var defs = d3svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 10 10').attr('refX', 18).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', '#94a3b8');

    var g = d3svg.append('g');

    d3svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', function (event) {
      g.attr('transform', event.transform);
    }));

    var linkSel = g.append('g')
      .selectAll('line').data(links).join('line')
      .attr('stroke', '#94a3b8').attr('stroke-width', 1.2)
      .attr('marker-end', 'url(#arrow)');

    var linkLabel = g.append('g')
      .selectAll('text').data(links).join('text')
      .attr('font-size', 9).attr('fill', '#94a3b8').attr('text-anchor', 'middle')
      .text(function (d) { return d.type; });

    var nodeSel = g.append('g')
      .selectAll('circle').data(nodes).join('circle')
      .attr('r', function (d) { return 6 + Math.min(d.obs, 5); })
      .attr('fill', function (d) { return typeColorMap[d.type] || '#4361ee'; })
      .attr('stroke', '#fff').attr('stroke-width', 1.5)
      .attr('opacity', function (d) { return d.status === 'archived' ? 0.35 : 1; })
      .call(d3.drag()
        .on('start', function (event, d) { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', function (event, d) { d.fx = event.x; d.fy = event.y; })
        .on('end', function (event, d) { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    var labelColor = document.body.classList.contains('dark') ? '#c9d1d9' : '#374151';
    var labelSel = g.append('g')
      .selectAll('text').data(nodes).join('text')
      .attr('font-size', 11).attr('fill', labelColor).attr('dy', 4)
      .text(function (d) { return d.id.length > 30 ? d.id.slice(0, 30) + '…' : d.id; });

    // Tooltip
    var ttEl = document.getElementById('live-tooltip');
    nodeSel.on('mouseover', function (event, d) {
      ttEl.style.display = 'block';
      ttEl.querySelector('.tt-name').textContent = d.id;
      ttEl.querySelector('.tt-type').textContent = d.type + (d.status === 'archived' ? ' [archived]' : '');
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
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:12px;';
    Object.entries(typeColorMap).forEach(function (pair) {
      var item = document.createElement('span');
      item.style.cssText = 'display:flex;align-items:center;gap:4px;';
      var dot = document.createElement('span');
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;background:' + pair[1] + ';';
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
      statusTitle.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;color:#666;';
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
      typeTitle.style.cssText = 'font-size:14px;font-weight:600;margin:16px 0 10px;color:#666;';
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
      tagTitle.style.cssText = 'font-size:14px;font-weight:600;margin:16px 0 10px;color:#666;';
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
              errEl.style.cssText = 'color:#dc2626;padding:8px 12px;background:#fef2f2;border-radius:6px;margin-top:8px;font-size:13px;';
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
              errEl.style.cssText = 'color:#dc2626;padding:8px 12px;background:#fef2f2;border-radius:6px;margin-top:8px;font-size:13px;';
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
          modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
          var box = document.createElement('div');
          box.className = 'card';
          box.style.cssText = 'max-width:500px;width:90%;max-height:80vh;overflow-y:auto;';
          var title = document.createElement('h3');
          title.textContent = 'Remove Observation';
          title.style.marginBottom = '12px';
          box.appendChild(title);
          e.observations.forEach(function(obsText) {
            var label = document.createElement('label');
            label.style.cssText = 'display:block;padding:8px;margin:4px 0;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;';
            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'obs-select-' + e.name;
            radio.value = obsText;
            radio.style.marginRight = '8px';
            label.appendChild(radio);
            label.appendChild(document.createTextNode(obsText.length > 120 ? obsText.slice(0, 120) + '...' : obsText));
            box.appendChild(label);
          });
          var modalErrEl = document.createElement('div');
          modalErrEl.style.cssText = 'color:#dc2626;font-size:13px;min-height:18px;margin-top:8px;';
          box.appendChild(modalErrEl);
          var btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end;';
          var cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn btn-secondary';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', function() { modal.remove(); });
          btnRow.appendChild(cancelBtn);
          var removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-primary';
          removeBtn.style.background = '#dc2626';
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
    saveMsg.style.color = '#166534';

    saveBtn.addEventListener('click', async function () {
      var selectedProvider = document.querySelector('input[name=llm-provider]:checked');
      if (!selectedProvider) { saveMsg.style.color = '#b91c1c'; saveMsg.textContent = 'Select a provider first.'; return; }
      var prov = selectedProvider.value;
      var llmUpdate = { provider: prov };
      if (modelInput.value.trim()) llmUpdate.model = modelInput.value.trim();
      if (apiKeyInput.value.trim()) llmUpdate.apiKey = apiKeyInput.value.trim();

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      try {
        var res = await apiCall('POST', '/v1/config', { llm: llmUpdate });
        if (!res.success) throw new Error(res.error || 'Save failed');
        saveMsg.style.color = '#166534';
        saveMsg.textContent = 'Saved! Restart the server to apply LLM changes.';
        apiKeyInput.value = '';
        settingsLoaded = false; // force re-render on next visit
      } catch (err) {
        saveMsg.style.color = '#b91c1c';
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
    autoCheck.style.accentColor = '#4361ee';
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
    genMsg.style.color = '#166534';

    genSaveBtn.addEventListener('click', async function () {
      genSaveBtn.disabled = true;
      genSaveBtn.textContent = 'Saving\u2026';
      try {
        var res = await apiCall('POST', '/v1/config', { autoCapture: autoCheck.checked });
        if (!res.success) throw new Error(res.error || 'Save failed');
        genMsg.style.color = '#166534';
        genMsg.textContent = 'Saved!';
        setTimeout(function () { genMsg.textContent = ''; }, 3000);
      } catch (err) {
        genMsg.style.color = '#b91c1c';
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
      errMsg.style.cssText = 'font-size:13px;color:#b91c1c;min-height:18px;margin-bottom:8px;';
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
          errMsg.style.color = '#166534';
          errMsg.textContent = 'Connection config saved!';
        } catch (err) {
          errMsg.style.color = '#b91c1c';
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
          errMsg.style.color = '#b91c1c';
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
      tipBox.style.cssText = 'background:#f0f3ff;border-radius:6px;padding:14px 16px;font-size:13px;line-height:1.6;';
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
  <div><h1 style="margin:0;line-height:1.2">MeMesh LLM Memory</h1><span style="font-size:11px;opacity:0.6">powered by pcircle.ai</span></div>
  <div class="header-right">
    <div class="meta">
      <span id="health-indicator"><span class="dot"></span>Connecting\u2026</span>
      <span id="version-label"></span>
    </div>
    <button class="theme-btn" id="theme-btn" title="Toggle dark/light mode">\ud83c\udf19</button>
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
      <p style="font-size:13px;color:#888;margin-bottom:16px;">Entities connected by \u201csupersedes\u201d relations, showing knowledge evolution chains.</p>
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
<div id="live-tooltip" style="position:absolute;pointer-events:none;background:#1c2128;border:1px solid #30363d;border-radius:6px;padding:10px 14px;font-size:13px;max-width:260px;display:none;z-index:50;color:#c9d1d9;">
  <div class="tt-name" style="font-weight:600;color:#f0f6fc;"></div>
  <div class="tt-type" style="color:#8b949e;font-size:12px;"></div>
  <div class="tt-obs" style="margin-top:4px;color:#c9d1d9;"></div>
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
    <input type="checkbox" id="fb-sys" checked style="accent-color:#4361ee;" />
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
