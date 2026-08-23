import { KnowledgeGraph } from '../knowledge-graph.js';
const DEMO_TAG = 'project:memesh-demo';
const DEMO_DATA = [
    { daysAgo: 30, name: 'auth-decision', type: 'decision', observations: ['Use OAuth 2.0 with PKCE for browser flows', 'Refresh tokens rotated every 90 days'] },
    { daysAgo: 30, name: 'db-choice', type: 'decision', observations: ['PostgreSQL for relational data', 'Redis for session + cache layer'] },
    { daysAgo: 29, name: 'api-design', type: 'pattern', observations: ['RESTful API with /v1/ versioning', 'JSON envelope: { success, data | error }'] },
    { daysAgo: 29, name: 'rate-limiting', type: 'pattern', observations: ['Token bucket algorithm with Redis, 100 req/min per API key'] },
    { daysAgo: 28, name: 'testing-strategy', type: 'best_practice', observations: ['vitest with forks pool mode for native modules', 'Real DB in tests; no SQL mocks'] },
    { daysAgo: 22, name: 'feature-auth-flow', type: 'feature', observations: ['Email + password with TOTP fallback', 'Session cookies HttpOnly + Secure + SameSite=Lax'] },
    { daysAgo: 21, name: 'plan-billing-rollout', type: 'plan', observations: ['Plan: stripe-billing-rollout', 'Steps: webhook ingest, idempotent invoice processor, customer portal embed'] },
    { daysAgo: 20, name: 'lesson-api-import-missing', type: 'lesson_learned', observations: ['Error: db.ts imported getEmbeddingDimension from embedder.ts; circular import', 'Root cause: function placed by domain not by dependency direction', 'Fix: moved getEmbeddingDimension to config.ts', 'Prevention: check for cycles before adding new imports'], tags: ['error-pattern:import-missing', 'severity:minor'] },
    { daysAgo: 20, name: 'arch-storage-layer', type: 'architecture', observations: ['SQLite + sqlite-vec for memory storage', 'FTS5 virtual table for keyword recall'] },
    { daysAgo: 19, name: 'pattern-event-sourcing', type: 'technical_pattern', observations: ['Append-only event log with periodic snapshots', 'Replay rebuilds projections deterministically'] },
    { daysAgo: 14, name: 'lesson-billing-config-error', type: 'lesson_learned', observations: ['Error: billing webhook env var not propagated to staging', 'Root cause: secrets manager only synced production tier', 'Fix: extended sync to all tiers, added smoke check in CI', 'Prevention: env-var presence assertion at startup, fail fast'], tags: ['error-pattern:config-error', 'severity:major'] },
    { daysAgo: 13, name: 'bugfix-race-on-double-submit', type: 'bug_fix', observations: ['Symptom: double charges on slow networks', 'Cause: idempotency key derived after request body parse', 'Fix: derive key in middleware before any I/O'] },
    { daysAgo: 13, name: 'decision-graceful-degradation', type: 'decision', observations: ['When LLM provider is down, fall back to FTS-only recall', 'No silent zero-result responses; surface "LLM unavailable" badge'] },
    { daysAgo: 12, name: 'arch-recall-pipeline', type: 'architecture', observations: ['FTS5 → vector rerank → access-count boost → impact score', 'Each stage is opt-out via flags, not opt-in'] },
    { daysAgo: 11, name: 'lesson-test-failure-flake', type: 'lesson_learned', observations: ['Error: integration tests passed locally, failed in CI 30% of the time', 'Root cause: tests shared a global temp dir cleared at suite end', 'Fix: per-test mkdtemp + per-test cleanup in afterEach', 'Prevention: assume parallelism; never share mutable state across tests'], tags: ['error-pattern:test-failure', 'severity:major'] },
    { daysAgo: 7, name: 'pattern-noise-filter', type: 'pattern', observations: ['Auto-tag commits + sessions with type-specific labels', 'UI default-hides noise types; dashboard uses signal-first surfacing'] },
    { daysAgo: 7, name: 'bugfix-stale-cache-banner', type: 'bug_fix', observations: ['Symptom: deprecation banner stayed visible after upgrade', 'Cause: cache TTL only refreshed on explicit "check now"', 'Fix: also refresh on session-start when cache is fresh'] },
    { daysAgo: 6, name: 'feature-projects-view', type: 'feature', observations: ['New /v1/projects endpoint extracts distinct project tags', 'Dashboard groups Browse + Lessons by project chip'] },
    { daysAgo: 5, name: 'decision-precision-engineer-design', type: 'decision', observations: ['Adopt Precision Engineer aesthetic: minimal stroke icons, no decoration', 'Reject Neural Organic and Retro Terminal alternatives — too noisy for data tool'] },
    { daysAgo: 5, name: 'arch-roadmap-derivation', type: 'architecture', observations: ['Phase clusters: ≥3 entities within ≤7 days', 'Anchor entity by type priority: release > architecture > plan > decision'] },
    { daysAgo: 3, name: 'lesson-bug_fix-canvas-blank', type: 'lesson_learned', observations: ['Error: timeline chart blank after tab switch', 'Root cause: canvas.style.width persisted across display:none -> block', 'Fix: clear inline width before measuring, use ResizeObserver', 'Prevention: never assume CSS width:100% wins over inline style on canvas'], tags: ['error-pattern:other', 'severity:minor'] },
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
function demoMetadata() {
    return {
        demo: true,
        provenance: { source: 'demo-seed', generated_at: new Date().toISOString() },
        trust: 'trusted',
    };
}
function isoForDaysAgo(days) {
    return new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}
export const DEMO_RELATIONS = [
    ['feature-auth-flow', 'implements', 'auth-decision'],
    ['bugfix-race-on-double-submit', 'relates_to', 'feature-auth-flow'],
    ['arch-recall-pipeline', 'depends_on', 'arch-storage-layer'],
    ['db-choice', 'relates_to', 'arch-storage-layer'],
    ['pattern-noise-filter', 'relates_to', 'arch-recall-pipeline'],
    ['lesson-billing-config-error', 'learned_from', 'plan-billing-rollout'],
    ['bugfix-confidence-pump', 'relates_to', 'arch-recall-pipeline'],
    ['feature-projects-view', 'follows', 'api-design'],
    ['rate-limiting', 'relates_to', 'api-design'],
    ['plan-v3-dashboard', 'relates_to', 'decision-precision-engineer-design'],
    ['bugfix-stale-cache-banner', 'relates_to', 'plan-v3-dashboard'],
    ['lesson-bug_fix-canvas-blank', 'learned_from', 'plan-v3-dashboard'],
    ['arch-roadmap-derivation', 'depends_on', 'feature-projects-view'],
    ['lesson-test-failure-flake', 'relates_to', 'testing-strategy'],
    ['decision-graceful-degradation', 'relates_to', 'arch-recall-pipeline'],
];
export function seedDemo(db, opts = {}) {
    if (opts.reset) {
        const kgInner = new KnowledgeGraph(db);
        const rows = db.prepare("SELECT name FROM entities WHERE metadata IS NOT NULL AND json_extract(metadata, '$.demo') = 1").all();
        if (rows.length === 0)
            return { inserted: 0, removed: 0 };
        const removeAll = db.transaction((names) => {
            let n = 0;
            for (const name of names) {
                if (kgInner.deleteEntity(name).deleted)
                    n++;
            }
            return n;
        });
        return { inserted: 0, removed: removeAll(rows.map((r) => r.name)) };
    }
    const kg = new KnowledgeGraph(db);
    let inserted = 0;
    const stampStmt = db.prepare('UPDATE entities SET created_at = ?, metadata = ? WHERE name = ?');
    for (const entry of DEMO_DATA) {
        const exists = db.prepare('SELECT id FROM entities WHERE name = ?').get(entry.name);
        if (exists)
            continue;
        const tags = [DEMO_TAG, ...(entry.tags ?? [])];
        kg.createEntity(entry.name, entry.type, {
            observations: entry.observations,
            tags,
            trustOverride: 'trusted',
        });
        stampStmt.run(isoForDaysAgo(entry.daysAgo), JSON.stringify(demoMetadata()), entry.name);
        inserted++;
    }
    if (inserted > 0) {
        db.transaction(() => {
            for (const [from, type, to] of DEMO_RELATIONS) {
                kg.createRelation(from, to, type);
            }
        })();
    }
    return { inserted, removed: 0 };
}
//# sourceMappingURL=demo.js.map