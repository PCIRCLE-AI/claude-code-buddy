// =============================================================================
// Demo seeder — populates a fresh install with a 30-entity tour
// =============================================================================
//
// SDD plan SPEC-4 calls for an empty-state onboarding flow: a brand
// new install (entity_count = 0) shows a banner pointing at
// `memesh demo`. Running the command produces a curated set so the
// dashboard renders meaningfully on first inspection rather than as
// blank charts.
//
// Every demo entity carries `metadata.demo = true` and a
// `project:memesh-demo` tag. `seedDemo({ reset: true })` removes
// everything that flag covers — the user can wipe the tour cleanly
// without disturbing real memories captured after install.
//
// Dates are spread over the last 30 days so the timeline / age-matrix
// / phase-strip have meaningful structure to render.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { KnowledgeGraph } from '../knowledge-graph.js';

export interface SeedResult {
  inserted: number;
  removed: number;
}

const DEMO_TAG = 'project:memesh-demo';

interface DemoEntity {
  /** Days ago (1 = yesterday) when the entity was "created" — used to
   *  spread the dataset across a believable 30-day timeline. */
  daysAgo: number;
  name: string;
  type: string;
  observations: string[];
  tags?: string[];
}

const DEMO_DATA: DemoEntity[] = [
  // Phase 1 — Foundation (~30 days ago)
  { daysAgo: 30, name: 'auth-decision', type: 'decision', observations: ['Use OAuth 2.0 with PKCE for browser flows', 'Refresh tokens rotated every 90 days'] },
  { daysAgo: 30, name: 'db-choice', type: 'decision', observations: ['PostgreSQL for relational data', 'Redis for session + cache layer'] },
  { daysAgo: 29, name: 'api-design', type: 'pattern', observations: ['RESTful API with /v1/ versioning', 'JSON envelope: { success, data | error }'] },
  { daysAgo: 29, name: 'rate-limiting', type: 'pattern', observations: ['Token bucket algorithm with Redis, 100 req/min per API key'] },
  { daysAgo: 28, name: 'testing-strategy', type: 'best_practice', observations: ['vitest with forks pool mode for native modules', 'Real DB in tests; no SQL mocks'] },

  // Phase 2 — Implementation (~21 days ago)
  { daysAgo: 22, name: 'feature-auth-flow', type: 'feature', observations: ['Email + password with TOTP fallback', 'Session cookies HttpOnly + Secure + SameSite=Lax'] },
  { daysAgo: 21, name: 'plan-billing-rollout', type: 'plan', observations: ['Plan: stripe-billing-rollout', 'Steps: webhook ingest, idempotent invoice processor, customer portal embed'] },
  { daysAgo: 20, name: 'lesson-api-import-missing', type: 'lesson_learned', observations: ['Error: db.ts imported getEmbeddingDimension from embedder.ts; circular import', 'Root cause: function placed by domain not by dependency direction', 'Fix: moved getEmbeddingDimension to config.ts', 'Prevention: check for cycles before adding new imports'], tags: ['error-pattern:import-missing', 'severity:minor'] },
  { daysAgo: 20, name: 'arch-storage-layer', type: 'architecture', observations: ['SQLite + sqlite-vec for memory storage', 'FTS5 virtual table for keyword recall'] },
  { daysAgo: 19, name: 'pattern-event-sourcing', type: 'technical_pattern', observations: ['Append-only event log with periodic snapshots', 'Replay rebuilds projections deterministically'] },

  // Phase 3 — Hardening (~14 days ago)
  { daysAgo: 14, name: 'lesson-billing-config-error', type: 'lesson_learned', observations: ['Error: billing webhook env var not propagated to staging', 'Root cause: secrets manager only synced production tier', 'Fix: extended sync to all tiers, added smoke check in CI', 'Prevention: env-var presence assertion at startup, fail fast'], tags: ['error-pattern:config-error', 'severity:major'] },
  { daysAgo: 13, name: 'bugfix-race-on-double-submit', type: 'bug_fix', observations: ['Symptom: double charges on slow networks', 'Cause: idempotency key derived after request body parse', 'Fix: derive key in middleware before any I/O'] },
  { daysAgo: 13, name: 'decision-graceful-degradation', type: 'decision', observations: ['When LLM provider is down, fall back to FTS-only recall', 'No silent zero-result responses; surface "LLM unavailable" badge'] },
  { daysAgo: 12, name: 'arch-recall-pipeline', type: 'architecture', observations: ['FTS5 → vector rerank → access-count boost → impact score', 'Each stage is opt-out via flags, not opt-in'] },
  { daysAgo: 11, name: 'lesson-test-failure-flake', type: 'lesson_learned', observations: ['Error: integration tests passed locally, failed in CI 30% of the time', 'Root cause: tests shared a global temp dir cleared at suite end', 'Fix: per-test mkdtemp + per-test cleanup in afterEach', 'Prevention: assume parallelism; never share mutable state across tests'], tags: ['error-pattern:test-failure', 'severity:major'] },

  // Phase 4 — Optimization (~7 days ago)
  { daysAgo: 7, name: 'pattern-noise-filter', type: 'pattern', observations: ['Auto-tag commits + sessions with type-specific labels', 'UI default-hides noise types; dashboard uses signal-first surfacing'] },
  { daysAgo: 7, name: 'bugfix-stale-cache-banner', type: 'bug_fix', observations: ['Symptom: deprecation banner stayed visible after upgrade', 'Cause: cache TTL only refreshed on explicit "check now"', 'Fix: also refresh on session-start when cache is fresh'] },
  { daysAgo: 6, name: 'feature-projects-view', type: 'feature', observations: ['New /v1/projects endpoint extracts distinct project tags', 'Dashboard groups Browse + Lessons by project chip'] },
  { daysAgo: 5, name: 'decision-precision-engineer-design', type: 'decision', observations: ['Adopt Precision Engineer aesthetic: minimal stroke icons, no decoration', 'Reject Neural Organic and Retro Terminal alternatives — too noisy for data tool'] },
  { daysAgo: 5, name: 'arch-roadmap-derivation', type: 'architecture', observations: ['Phase clusters: ≥3 entities within ≤7 days', 'Anchor entity by type priority: release > architecture > plan > decision'] },

  // Phase 5 — Recent (~2 days ago)
  { daysAgo: 3, name: 'lesson-bug_fix-canvas-blank', type: 'lesson_learned', observations: ['Error: timeline chart blank after tab switch', 'Root cause: canvas.style.width persisted across display:none -> block', 'Fix: clear inline width before measuring, use ResizeObserver', 'Prevention: never assume CSS width:100% wins over inline style on canvas'], tags: ['error-pattern:other', 'severity:minor'] },
  // This entry used to end "see Lessons tab for execution lessons". There is
  // no Lessons tab — the dashboard is Home / Memories / Project / Graph /
  // Settings — and the demo library is the FIRST thing a new user reads, so
  // the one line that told them where to go next sent them looking for a tab
  // that does not exist. Names a place that is really there instead.
  { daysAgo: 2, name: 'plan-v3-dashboard', type: 'plan', observations: ['Plan: dashboard-v3', 'Steps: Browse redesign, Lessons categorisation, Project Roadmap, Memory Loop KPI', 'Status: complete; the execution lessons are the lesson_learned memories in Memories'] },
  { daysAgo: 2, name: 'bugfix-confidence-pump', type: 'bug_fix', observations: ['Symptom: Quality KPI inflated by repeated remember() calls', 'Cause: confidence bumped on every re-assertion regardless of source', 'Fix: gate on (new observation) AND (metadata.trust !== untrusted)'] },
  { daysAgo: 1, name: 'release-v3.0', type: 'release', observations: ['Released as Dashboard v3 milestone', 'Highlights: Lessons-first landing, Project Roadmap, Memory Loop KPI, SVG icon set, Signal Mode toggle'] },
  { daysAgo: 1, name: 'pattern-svg-iconography', type: 'pattern', observations: ['Stroke-based 16x16 SVG glyphs, currentColor', '12 entity-cluster shapes; aria-label per glyph'] },
  { daysAgo: 1, name: 'lesson-build-error-tsx-include', type: 'lesson_learned', observations: ['Error: vitest skipped tests/dashboard/*.test.tsx silently', 'Root cause: vitest.config include pattern matched .ts not .tsx', 'Fix: add tests/**/*.test.tsx to include array', 'Prevention: when adding a new file extension, audit every glob in test config'], tags: ['error-pattern:test-failure', 'severity:minor'] },
  { daysAgo: 0, name: 'note-onboarding-tour', type: 'note', observations: ['This entity tree is the demo seed shown when entity_count = 0', 'Run `memesh demo --reset --yes` to remove'] },
  { daysAgo: 0, name: 'best-practice-trust-gating', type: 'best_practice', observations: ['Confidence-bump paths must check metadata.trust before lifting', 'Untrusted sources: importer append/overwrite, auto-learned lessons'] },
  { daysAgo: 0, name: 'decision-memory-loop-kpi', type: 'decision', observations: ['Replace Health Score gauge with "memories reused this week" hero', 'Vanity metric → value-proof metric'] },
  { daysAgo: 0, name: 'feature-onboarding-banner', type: 'feature', observations: ['Detect entity_count = 0 from /v1/health', 'Show dismissable banner pointing at `memesh demo`'] },
];

/** Build a metadata blob that flags an entity as part of the demo
 *  dataset. The schema accepts arbitrary JSON; the `demo` boolean is
 *  the canonical signal `--reset` looks for. */
function demoMetadata() {
  return {
    demo: true,
    provenance: { source: 'demo-seed', generated_at: new Date().toISOString() },
    trust: 'trusted' as const,
  };
}

/** Whether a raw `entities.metadata` column value is a row `demoMetadata()`
 *  wrote — the same "this row is genuinely part of the demo tour" test the
 *  `--reset` path's `json_extract(metadata, '$.demo') = 1` query makes. */
function isDemoMetadata(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === 'object' && parsed.demo === true);
  } catch {
    return false;
  }
}

/**
 * A back-dated `created_at`, in the format the COLUMN holds.
 *
 * `'YYYY-MM-DD HH:MM:SS'`, not `toISOString()`. This was the one writer in
 * the codebase putting a full ISO string into `created_at`, and the repo has
 * already decided what an unrecognised timestamp means: `parseSqliteUtcMs`
 * anchors both ends and returns null, and `kg-backfill`'s Rule 5 refuses to
 * anchor on a value it cannot trust (there is a test named for it). So every
 * demo entity was, by construction, invisible to the relation backfill and
 * out of order in every TEXT comparison against its `CURRENT_TIMESTAMP`
 * siblings — the demo tour being the one dataset a new user's first
 * impressions are built from.
 *
 * Fixing the writer rather than widening the parser is deliberate: the
 * parser's strictness is load-bearing (a `+08:00` suffix read as UTC is
 * eight hours wrong and looks fine), and only this one function ever
 * disagreed with it.
 */
function isoForDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Insert the demo dataset, or remove it if `reset` is set. Returns
 * counts so the CLI can report what changed without re-querying.
 *
 * Idempotent on the insert side: re-running without --reset is a
 * no-op for entities that already exist (createEntity uses INSERT OR
 * IGNORE), so the tour never duplicates.
 */
/**
 * The edges of the demo graph. Without these the Graph tab's guided tour
 * showed thirty floating dots and zero lines — a "knowledge graph" with no
 * graph in it — and the PM panel's orphan rate read 100%. Each triple names
 * entities from DEMO_DATA above; seeding asserts every name resolves, so a
 * renamed entity breaks loudly here instead of silently shrinking the tour.
 */
export const DEMO_RELATIONS: Array<[from: string, type: string, to: string]> = [
  // The auth slice: decision -> implementation -> hardening -> lesson.
  ['feature-auth-flow', 'implements', 'auth-decision'],
  ['bugfix-race-on-double-submit', 'relates_to', 'feature-auth-flow'],
  // Storage and recall architecture hang together.
  ['arch-recall-pipeline', 'depends_on', 'arch-storage-layer'],
  ['db-choice', 'relates_to', 'arch-storage-layer'],
  ['pattern-noise-filter', 'relates_to', 'arch-recall-pipeline'],
  // Billing slice: plan -> lesson learned while executing it.
  ['lesson-billing-config-error', 'learned_from', 'plan-billing-rollout'],
  ['bugfix-confidence-pump', 'relates_to', 'arch-recall-pipeline'],
  // API surface: pattern governs the feature endpoints.
  ['feature-projects-view', 'follows', 'api-design'],
  ['rate-limiting', 'relates_to', 'api-design'],
  // Dashboard slice.
  ['plan-v3-dashboard', 'relates_to', 'decision-precision-engineer-design'],
  ['bugfix-stale-cache-banner', 'relates_to', 'plan-v3-dashboard'],
  ['lesson-bug_fix-canvas-blank', 'learned_from', 'plan-v3-dashboard'],
  ['arch-roadmap-derivation', 'depends_on', 'feature-projects-view'],
  // Testing culture connects the flake lesson to the strategy.
  ['lesson-test-failure-flake', 'relates_to', 'testing-strategy'],
  ['decision-graceful-degradation', 'relates_to', 'arch-recall-pipeline'],
];

export function seedDemo(
  db: MemeshDatabase,
  opts: { reset?: boolean } = {},
): SeedResult {
  if (opts.reset) {
    // Remove every entity carrying metadata.demo = true. We route the
    // delete through KnowledgeGraph.deleteEntity rather than a raw
    // DELETE because the contentless FTS5 virtual table and the
    // sqlite-vec table both keep their own row pointers — a bare
    // DELETE FROM entities leaves orphaned index rows that surface
    // later as phantom search hits.
    //
    // Wrap the per-entity deletes in a single transaction so a
    // mid-loop failure rolls back to a clean pre-reset state instead
    // of leaving the user with half a tour deleted (the destructive
    // endpoint should be all-or-nothing).
    const kgInner = new KnowledgeGraph(db);
    const rows = db.prepare(
      "SELECT name FROM entities WHERE metadata IS NOT NULL AND json_extract(metadata, '$.demo') = 1",
    ).all() as Array<{ name: string }>;
    if (rows.length === 0) return { inserted: 0, removed: 0 };
    const removeAll = db.transaction((names: string[]) => {
      let n = 0;
      for (const name of names) {
        if (kgInner.deleteEntity(name).deleted) n++;
      }
      return n;
    });
    return { inserted: 0, removed: removeAll(rows.map((r) => r.name)) };
  }

  const kg = new KnowledgeGraph(db);
  let inserted = 0;
  // Path: createEntity to drive the canonical insert/observations/FTS/
  // tag flow, then a follow-up UPDATE to set created_at + metadata.demo.
  // Trying to pre-INSERT before createEntity caused the FTS pipeline to
  // attempt a removeFromFts on a row whose FTS entry did not exist yet,
  // logging a "disk image malformed" warning even though everything
  // worked. Going through createEntity first avoids that.
  const stampStmt = db.prepare(
    'UPDATE entities SET created_at = ?, metadata = ? WHERE name = ?',
  );
  // Names DEMO_RELATIONS may safely wire an edge onto: entities this run
  // just seeded, plus ones a PRIOR run already seeded (metadata.demo = 1,
  // so a re-run stays idempotent). The demo dataset's names — `auth-
  // decision`, `db-choice` — are plausible names a real user's own memory
  // could carry; `if (exists) continue` above already refuses to touch or
  // duplicate that row, but `createRelation` resolves by NAME alone, with
  // no notion of "who created this" — so without this set, a real memory
  // that happened to collide would still get wired into the demo graph
  // the moment any OTHER demo entity in the same run needed inserting.
  const demoNames = new Set<string>();
  for (const entry of DEMO_DATA) {
    const existing = db.prepare('SELECT metadata FROM entities WHERE name = ?')
      .get(entry.name) as { metadata: string | null } | undefined;
    if (existing) {
      if (isDemoMetadata(existing.metadata)) demoNames.add(entry.name);
      continue;
    }
    const tags = [DEMO_TAG, ...(entry.tags ?? [])];
    kg.createEntity(entry.name, entry.type, {
      observations: entry.observations,
      tags,
      trustOverride: 'trusted',
    });
    stampStmt.run(
      isoForDaysAgo(entry.daysAgo),
      JSON.stringify(demoMetadata()),
      entry.name,
    );
    inserted++;
    demoNames.add(entry.name);
  }

  // Edges only when this run actually inserted the tour (idempotent re-runs
  // skip; INSERT OR IGNORE in createRelation makes the edges idempotent too).
  // Transactional like the --reset path: a bad fixture entry should leave
  // zero edges, not a partial graph.
  if (inserted > 0) {
    db.transaction(() => {
      for (const [from, type, to] of DEMO_RELATIONS) {
        if (!demoNames.has(from) || !demoNames.has(to)) continue;
        kg.createRelation(from, to, type);
      }
    })();
  }
  return { inserted, removed: 0 };
}
