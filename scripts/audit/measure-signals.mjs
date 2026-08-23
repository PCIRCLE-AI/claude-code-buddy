#!/usr/bin/env node
//
// Signal census — what every measuring mechanism is ACTUALLY producing
// ====================================================================
//
// The defect class this exists for is not "the code is wrong" and not "there
// is no test". It is:
//
//     Every layer is correct, every layer is tested, the chain is connected,
//     and the number coming out the far end has been zero since the day it
//     shipped — because nobody ever looked at the real one.
//
// Measured instance (2026-08-24). R1 spent +70 tokens per session building
// `[mem:id]` citation accounting to measure whether injected memories earn
// their tokens. Write side: shipped and tested. Read side (`analytics.ts`):
// shipped and tested. Review: passed. Eight days later the real values were
// read for the first time — `citation_sessions_total = 4`, and the key
// counting sessions WITH a citation did not exist at all. The mechanism had
// never produced a signal, and no review could have found it, because every
// test seeded its own fixture values and every fixture said what it was told
// to say.
//
// The other detectors in this directory are STATIC — they read source. A
// static scan cannot see this: the source is right. Only reading the live
// numbers can. So this is a census, not a linter, and it is read-only by
// construction: it opens the database `readOnly` and never writes.
//
// Usage:
//   node scripts/audit/measure-signals.mjs            # real DB
//   node scripts/audit/measure-signals.mjs --db PATH  # a copy or a fixture
//   node scripts/audit/measure-signals.mjs --json
//
// Exit code is 0 even when signals are dead: this reports, it does not gate.
// A dead signal is a finding for a human to act on, not a build break — and
// a gate that fails on a fresh install (where every counter is legitimately
// zero) would be turned off within a week.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 && args[dbFlag + 1]
  ? args[dbFlag + 1]
  : path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

if (!fs.existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return undefined; } };
const many = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };

/**
 * A signal is DEAD when the mechanism behind it has clearly run and the
 * number it produces is still nothing. That is deliberately narrower than
 * "the value is zero": a fresh install has zero of everything and is not
 * broken. Each probe below decides its own `live` predicate, and every probe
 * that cannot tell says `unknown` rather than guessing — the same three-state
 * rule the rest of this codebase uses for "I could not read that".
 */
const signals = [];
function signal(name, { value, state, note }) {
  signals.push({ name, value, state, note });
}

// ---- 1. Entity population, and whether retrieval touches it ---------------
const totals = one(`SELECT COUNT(*) n, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM entities`) ?? {};
signal('entities.total', { value: `${totals.active ?? 0} active / ${totals.n ?? 0} total`, state: (totals.n ?? 0) > 0 ? 'live' : 'empty' });

const access = one(`SELECT COUNT(*) n, SUM(CASE WHEN access_count>0 THEN 1 ELSE 0 END) touched, MAX(last_accessed_at) latest FROM entities`) ?? {};
signal('entities.access_count', {
  value: `${access.touched ?? 0}/${access.n ?? 0} ever retrieved; last ${access.latest ?? 'never'}`,
  // access_count is bumped by `kg.search()` — the MCP recall path. Hook
  // injection uses its own SQL and does not bump it, so a graph used only
  // through hooks legitimately shows a stale timestamp. Reported, not judged.
  state: (access.touched ?? 0) > 0 ? 'live' : (totals.n ?? 0) > 0 ? 'dead' : 'empty',
  note: 'bumped by kg.search() only — hook injection does not touch it',
});

// ---- 2. Citation accounting — the instance that motivated this file -------
const meta = Object.fromEntries(many(`SELECT key, value FROM memesh_metadata`).map((r) => [r.key, r.value]));
const citeTotal = Number.parseInt(meta.citation_sessions_total ?? '', 10);
const citeCited = meta.citation_sessions_cited === undefined
  ? null
  : Number.parseInt(meta.citation_sessions_cited, 10);
signal('citation.sessions', {
  value: Number.isInteger(citeTotal)
    ? `${citeCited === null ? '?' : citeCited} cited / ${citeTotal} injected`
    : 'never accounted',
  state: !Number.isInteger(citeTotal) || citeTotal === 0
    ? 'empty'
    : citeCited === null
      ? 'unknown'
      : citeCited > 0 ? 'live' : 'dead',
  note: 'a session that received memories and cited none is an injection nobody used',
});
signal('citation.accounting_mode', {
  value: meta.recall_accounting_mode ?? 'unstamped',
  state: meta.recall_accounting_mode ? 'live' : 'unknown',
});

const hits = one(`SELECT SUM(recall_hits) h, SUM(recall_misses) m, SUM(CASE WHEN recall_hits>0 THEN 1 ELSE 0 END) n FROM entities`) ?? {};
signal('entities.recall_hits', {
  value: `${hits.n ?? 0} entities credited; ${hits.h ?? 0} hits / ${hits.m ?? 0} misses`,
  state: (hits.h ?? 0) > 0 ? 'live' : (citeTotal > 0 ? 'dead' : 'empty'),
});

// ---- 3. Hooks: has each one actually run? --------------------------------
const runs = many(`SELECT hook, last_run_at FROM hook_runs ORDER BY hook`);
if (runs.length === 0) {
  signal('hooks.runs', { value: 'no hook has ever stamped a run', state: 'dead' });
} else {
  for (const r of runs) {
    signal(`hooks.${r.hook}`, { value: r.last_run_at ?? 'never', state: r.last_run_at ? 'live' : 'dead' });
  }
}

// ---- 4. Everything else in memesh_metadata, unfiltered -------------------
// Listed rather than curated: a hard-coded list of "interesting" keys is a
// list that stops mentioning the key added last month, which is exactly the
// blind spot this file exists to remove.
const covered = new Set(['citation_sessions_total', 'citation_sessions_cited', 'recall_accounting_mode']);
for (const [k, v] of Object.entries(meta).sort()) {
  if (covered.has(k)) continue;
  const zeroish = v === '0' || v === '' || v === 'null';
  signal(`metadata.${k}`, { value: String(v).slice(0, 60), state: zeroish ? 'dead' : 'live' });
}

db.close();

if (asJson) {
  console.log(JSON.stringify({ dbPath, signals }, null, 2));
  process.exit(0);
}

const ICON = { live: '✓', dead: '✗', empty: '·', unknown: '?' };
console.log(`── Signal census ─────────────────────────────────────────`);
console.log(`   ${dbPath}\n`);
for (const s of signals) {
  console.log(`  ${ICON[s.state] ?? '?'} ${s.name.padEnd(30)} ${s.value}`);
  if (s.note && s.state !== 'live') console.log(`      ${s.note}`);
}
const dead = signals.filter((s) => s.state === 'dead');
const unknown = signals.filter((s) => s.state === 'unknown');
console.log('');
console.log(`  ${signals.length} signals · ${dead.length} producing nothing · ${unknown.length} unmeasurable`);
if (dead.length) {
  console.log('\n  Producing nothing — each is a mechanism that runs and reports zero:');
  for (const s of dead) console.log(`    ✗ ${s.name}`);
  console.log('\n  A signal here is not automatically a bug. It is a question with');
  console.log('  exactly two honest answers: the mechanism is broken, or nothing it');
  console.log('  measures has happened yet. Answer it before shipping past it.');
}
