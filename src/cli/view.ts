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
  } catch {
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

    // Query entities
    const entityRows = db
      .prepare('SELECT id, name, type FROM entities LIMIT 5000')
      .all() as Array<{ id: number; name: string; type: string }>;

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
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
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
  <!-- d3.js for force-directed graph -->
  <script src="https://d3js.org/d3.v7.min.js"><\/script>
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
        <thead><tr><th>Name</th><th>Type</th><th>Observations</th><th>Tags</th></tr></thead>
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
    var tr = document.createElement('tr');
    var tdName = document.createElement('td'); tdName.textContent = e.name;
    var tdType = document.createElement('td'); tdType.textContent = e.type;
    var tdObs = document.createElement('td'); tdObs.textContent = String(e.observations.length);
    var tdTags = document.createElement('td'); tdTags.textContent = e.tags.join(', ');
    tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdObs); tr.appendChild(tdTags);
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
  if (DATA.entities.length === 0) return;

  var svg = d3.select('#graph');
  var width = svg.node().getBoundingClientRect().width || 800;
  var height = 500;
  svg.attr('viewBox', [0, 0, width, height]);

  var color = d3.scaleOrdinal(d3.schemeTableau10);

  var nodes = DATA.entities.map(function(e) {
    return {
      id: e.name,
      type: e.type,
      observations: e.observations,
      radius: 6 + Math.min(e.observations.length, 5),
    };
  });

  var nameSet = new Set(nodes.map(function(n) { return n.id; }));
  var links = DATA.relations
    .filter(function(r) { return nameSet.has(r.from) && nameSet.has(r.to); })
    .map(function(r) { return { source: r.from, target: r.to, type: r.type }; });

  var simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d) { return d.id; }).distance(100))
    .force('charge', d3.forceManyBody().strength(-200))
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
    .call(drag(simulation));

  // Node labels
  var label = g.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text(function(d) { return d.id; })
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

// CLI entry point: detect direct execution via import.meta.url
const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const dbPath =
    process.env.MEMESH_DB_PATH ??
    path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

  const html = generateDashboardHtml(dbPath);
  const outPath = path.join(os.tmpdir(), 'memesh-dashboard.html');
  fs.writeFileSync(outPath, html, 'utf-8');

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
