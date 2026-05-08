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

import type Database from 'better-sqlite3';
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
  { daysAgo: 2, name: 'plan-v3-dashboard', type: 'plan', observations: ['Plan: dashboard-v3', 'Steps: Browse redesign, Lessons categorisation, Project Roadmap, Memory Loop KPI', 'Status: complete; see Lessons tab for execution lessons'] },
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

function isoForDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/**
 * Insert the demo dataset, or remove it if `reset` is set. Returns
 * counts so the CLI can report what changed without re-querying.
 *
 * Idempotent on the insert side: re-running without --reset is a
 * no-op for entities that already exist (createEntity uses INSERT OR
 * IGNORE), so the tour never duplicates.
 */
export function seedDemo(
  db: Database.Database,
  opts: { reset?: boolean } = {},
): SeedResult {
  if (opts.reset) {
    // Remove every entity carrying metadata.demo = true. We route the
    // delete through KnowledgeGraph.deleteEntity rather than a raw
    // DELETE because the contentless FTS5 virtual table and the
    // sqlite-vec table both keep their own row pointers — a bare
    // DELETE FROM entities leaves orphaned index rows that surface
    // later as phantom search hits. (Codex review caught this on the
    // first pass.)
    const kgInner = new KnowledgeGraph(db);
    const rows = db.prepare(
      "SELECT name FROM entities WHERE metadata IS NOT NULL AND json_extract(metadata, '$.demo') = 1",
    ).all() as Array<{ name: string }>;
    if (rows.length === 0) return { inserted: 0, removed: 0 };
    let removed = 0;
    for (const r of rows) {
      if (kgInner.deleteEntity(r.name).deleted) removed++;
    }
    return { inserted: 0, removed };
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
  for (const entry of DEMO_DATA) {
    const exists = db.prepare('SELECT id FROM entities WHERE name = ?').get(entry.name);
    if (exists) continue;
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
  }
  return { inserted, removed: 0 };
}
