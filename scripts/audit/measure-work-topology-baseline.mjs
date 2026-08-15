#!/usr/bin/env node
//
// Work-topology baseline measurements (M0)
// ========================================
//
// Three read-only measurements against THIS machine's real data, gating the
// work-topology redesign (see the handoff plan). Run before UX-3/UX-4 design
// decisions, and re-run after LLM titling ships:
//
//   1. Work-layer share — what fraction of active entities are work-layer
//      types (decision/lesson/milestone/pattern/goal/plan/task-state)?
//      Decides whether the empty-state/evidence-fallback design is an edge
//      case or the norm.
//   2. Recall-hit false-negative rate — of the entities session-start
//      injected, how many does the current NAME-only hit detector miss that
//      a name|title|fragment detector would catch? Decides the priority of
//      the ROI-accounting fix (F4).
//   3. Opening-exploration cost — how many tokens of Read/Grep/Glob results
//      do this project's sessions spend in their first 20 tool calls
//      re-discovering state? The budget the A1 topology injection exists to
//      cut.
//
// Read-only by construction: the DB opens with readOnly, and nothing here
// writes any file. Usage:
//
//   node scripts/audit/measure-work-topology-baseline.mjs
//

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = process.env.HOME || os.homedir();
const dbPath = process.env.MEMESH_DB_PATH || path.join(home, '.memesh', 'knowledge-graph.db');

// The work-layer whitelist. Deliberately the PLANNED set (goal/plan/
// task-state included even though today they count zero) so re-runs after
// those types ship measure against the same line.
const WORK_LAYER_TYPES = new Set([
  'decision', 'lesson_learned', 'lesson', 'milestone', 'pattern',
  'goal', 'plan', 'task-state',
]);

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch']);

function fail(msg) {
  console.error(`measure-work-topology-baseline: ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}`);
// `readOnly`, not `readonly`: node:sqlite ignores the lowercase spelling
// and hands back a WRITABLE handle.
const db = new DatabaseSync(dbPath, { readOnly: true });

// ---------------------------------------------------------------------------
// 1. Work-layer share
// ---------------------------------------------------------------------------
{
  const rows = db.prepare(
    "SELECT type, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active FROM entities GROUP BY type",
  ).all();
  const totalActive = rows.reduce((s, r) => s + Number(r.active), 0);
  const workActive = rows
    .filter((r) => WORK_LAYER_TYPES.has(String(r.type)))
    .reduce((s, r) => s + Number(r.active), 0);
  const zeroTypes = ['goal', 'plan', 'task-state'].filter(
    (t) => !rows.some((r) => r.type === t && Number(r.active) > 0),
  );

  console.log('── 1. Work-layer share ──────────────────────────────');
  console.log(`   active entities: ${totalActive}`);
  console.log(`   work-layer active: ${workActive} (${((workActive / Math.max(1, totalActive)) * 100).toFixed(1)}%)`);
  console.log(`   planned types with zero rows: ${zeroTypes.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------------------
// 2. Recall-hit false-negative rate
// ---------------------------------------------------------------------------
{
  const sessionsDir = path.join(home, '.memesh', 'sessions');
  const projectsDir = path.join(home, '.claude', 'projects');
  let result = 'skipped (no session records or transcripts)';

  if (fs.existsSync(sessionsDir) && fs.existsSync(projectsDir)) {
    const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    const transcripts = [];
    for (const dir of fs.readdirSync(projectsDir)) {
      const full = path.join(projectsDir, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(full, f);
        transcripts.push({ mtime: fs.statSync(p).mtimeMs / 1000, path: p });
      }
    }

    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
    const entStmt = db.prepare('SELECT name, title FROM entities WHERE id = ?');
    const measurable = (name) =>
      name && name.length >= 4 && !/^(session-|commit-|pre-compact-)/i.test(name);

    // Same structural strip the hook itself performs: drop the records
    // Claude Code created FROM the hook payload. Without this, the injected
    // context — which contains every entity name by construction — counts
    // as a "hit" for all of them. (The two obvious mis-measurements bracket
    // the truth: unstripped ≈ 100% fake hits, wrong-transcript ≈ 0%.)
    const ECHO_TYPES = new Set(['hook_success', 'hook_additional_context', 'hook_system_message']);
    const stripEchoes = (raw) => {
      const kept = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { kept.push(line); continue; }
        const type = entry?.attachment?.type ?? entry?.type;
        if (typeof type === 'string' && ECHO_TYPES.has(type)) continue;
        kept.push(line);
      }
      return kept.join('\n');
    };

    let total = 0, oldHits = 0, newHits = 0, flips = 0, matched = 0;
    for (const sf of sessionFiles) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, sf), 'utf8')); } catch { continue; }
      // Deterministic pairing: the receiving session's transcript CONTAINS
      // the injected context (as a hook echo). Time-based pairing is wrong
      // in both directions — a transcript's mtime is when the session
      // ENDED, not when the injection happened.
      const marker = String(rec.injectedContext ?? '').slice(0, 120);
      if (marker.length < 40) continue;
      // JSONL escapes the payload, so match the JSON-escaped form.
      const escaped = JSON.stringify(marker).slice(1, -1);
      let text = '';
      for (const t of transcripts) {
        let raw;
        try { raw = fs.readFileSync(t.path, 'utf8'); } catch { continue; }
        if (raw.includes(escaped)) { text = stripEchoes(raw).toLowerCase(); break; }
      }
      if (!text) continue;
      matched++;

      const ids = rec.entityIds ?? [];
      const names = rec.entityNames ?? [];
      for (let i = 0; i < ids.length; i++) {
        if (!measurable(names[i])) continue;
        const ent = entStmt.get(ids[i]);
        if (!ent) continue;
        total++;
        const oldHit = text.includes(String(ent.name).toLowerCase());
        let fragHit = false;
        const title = ent.title ? String(ent.title) : '';
        if (title.length >= 8 && text.includes(title.toLowerCase())) fragHit = true;
        if (!fragHit) {
          const obs = obsStmt.all(ids[i]);
          for (const o of obs.slice(0, 5)) {
            const line = String(o.content).split('\n')[0].trim().toLowerCase();
            if (line.length >= 25 && text.includes(line.slice(0, 80))) { fragHit = true; break; }
          }
        }
        const newHit = oldHit || fragHit;
        if (oldHit) oldHits++;
        if (newHit) newHits++;
        if (!oldHit && newHit) flips++;
      }
    }
    result = total === 0
      ? 'skipped (no session record content-matched a transcript)'
      : `sessions matched=${matched}  measurable=${total}  ` +
        `name-only hits=${oldHits} (${((oldHits / total) * 100).toFixed(0)}%)  ` +
        `multi-signal hits=${newHits} (${((newHits / total) * 100).toFixed(0)}%)  ` +
        `false-MISS flips=${flips} (${((flips / total) * 100).toFixed(0)}%)`;
  }
  console.log('── 2. Recall-hit false-negative rate ────────────────');
  console.log(`   ${result}`);
}

// ---------------------------------------------------------------------------
// 3. Opening-exploration cost (this project's transcripts)
// ---------------------------------------------------------------------------
{
  const cwdSlug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const tdir = path.join(home, '.claude', 'projects', cwdSlug);
  let line = `skipped (no transcript dir at ${tdir})`;

  if (fs.existsSync(tdir)) {
    const files = fs.readdirSync(tdir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(tdir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
      .slice(-12);

    let sessions = 0, agg = 0;
    for (const f of files) {
      let calls = 0, exploreTok = 0;
      const pending = new Map();
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const l of raw.split('\n')) {
        let e;
        try { e = JSON.parse(l); } catch { continue; }
        if (!e || typeof e !== 'object') continue;
        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.type === 'assistant') {
          for (const b of blocks) {
            if (b?.type === 'tool_use' && calls < 20) { calls++; pending.set(b.id, b.name); }
          }
        } else if (e.type === 'user') {
          for (const b of blocks) {
            if (b?.type !== 'tool_result') continue;
            const name = pending.get(b.tool_use_id);
            pending.delete(b.tool_use_id);
            if (EXPLORE_TOOLS.has(name)) {
              const c = b.content;
              const text = typeof c === 'string' ? c : (c ? JSON.stringify(c) : '');
              exploreTok += Math.floor(text.length / 4);
            }
          }
        }
        if (calls >= 20 && pending.size === 0) break;
      }
      if (calls < 5) continue;
      sessions++;
      agg += exploreTok;
    }
    line = sessions === 0
      ? 'skipped (no sessions with >=5 tool calls)'
      : `sessions=${sessions}  mean exploration-result tokens in first 20 tool calls: ~${Math.floor(agg / sessions).toLocaleString()} tokens/session`;
  }
  console.log('── 3. Opening-exploration cost ──────────────────────');
  console.log(`   ${line}`);
}

db.close();
