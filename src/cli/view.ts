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
  <title>MeMesh Dashboard</title>
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
  <h1>MeMesh Dashboard</h1>

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
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; margin-right: 6px; }
    .dot.error { background: #f87171; }
    .nav { display: flex; background: white; border-bottom: 1px solid #e0e0e0; padding: 0 16px; overflow-x: auto; }
    .nav button { padding: 12px 16px; border: none; background: none; cursor: pointer; font-size: 14px; color: #666; border-bottom: 2px solid transparent; white-space: nowrap; }
    .nav button.active { color: #1a1a2e; border-bottom-color: #4361ee; font-weight: 600; }
    .nav button:hover:not(.active) { color: #1a1a2e; background: #f5f5f5; }
    .content { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #1a1a2e; }
    input, button { font-family: inherit; font-size: 14px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 16px; }
    .search-input { flex: 1; padding: 9px 14px; border: 1px solid #ddd; border-radius: 6px; outline: none; }
    .search-input:focus { border-color: #4361ee; }
    .btn { padding: 9px 18px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
    .btn-primary { background: #4361ee; color: white; }
    .btn-primary:hover { background: #3651d4; }
    .btn-secondary { background: #f0f0f0; color: #333; }
    .btn-secondary:hover { background: #e0e0e0; }
    .btn-sm { padding: 6px 12px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    th { font-weight: 600; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; background: #fafafa; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafbff; }
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
  `.trim();

  // The inline script uses only createElement / textContent for all user data.
  // No dynamic HTML concatenation with unsanitised strings.
  const SCRIPT = `
(function () {
  'use strict';

  // ---- API ----
  async function apiCall(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    return res.json();
  }

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
    if (tab === 'settings') loadSettings();
  });

  // ---- Health check ----
  async function checkHealth() {
    var indicator = document.getElementById('health-indicator');
    var versionLabel = document.getElementById('version-label');
    try {
      var data = await apiCall('GET', '/v1/health');
      if (!data.success) throw new Error(data.error || 'API error');
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
  function buildEntityTable(entities) {
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
      tdName.textContent = e.name;
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
    return table;
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
      searchResults.appendChild(buildEntityTable(entities));
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
    browseWrap.appendChild(buildEntityTable(rows));
  }

  browseFilter.addEventListener('input', function () { renderBrowseTable(this.value); });
  document.getElementById('browse-refresh').addEventListener('click', loadBrowse);

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

  // Close wizard on overlay click outside modal
  document.getElementById('wizard-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeWizard();
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
  <title>MeMesh Dashboard</title>
  <style>${CSS}</style>
</head>
<body>

<div class="header">
  <h1>MeMesh</h1>
  <div class="meta">
    <span id="health-indicator"><span class="dot"></span>Connecting\u2026</span>
    <span id="version-label"></span>
  </div>
</div>

<nav class="nav" id="nav">
  <button class="active" data-tab="search">Search</button>
  <button data-tab="browse">Browse</button>
  <button data-tab="graph">Graph</button>
  <button data-tab="analytics">Analytics</button>
  <button data-tab="manage">Manage</button>
  <button data-tab="timeline">Timeline</button>
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
      <div class="placeholder"><div class="icon">&#9672;</div><p>Graph tab \u2014 coming in M4.4</p></div>
    </div>
  </div>

  <div class="tab-content" id="tab-analytics">
    <div class="card">
      <div class="placeholder"><div class="icon">&#128202;</div><p>Analytics tab \u2014 coming in M4.4</p></div>
    </div>
  </div>

  <div class="tab-content" id="tab-manage">
    <div class="card">
      <div class="placeholder"><div class="icon">&#9881;</div><p>Manage tab \u2014 coming in M4.5</p></div>
    </div>
  </div>

  <div class="tab-content" id="tab-timeline">
    <div class="card">
      <div class="placeholder"><div class="icon">&#128337;</div><p>Timeline tab \u2014 coming in M4.4</p></div>
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
