import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isTopicalTag,
  tokenizeName,
  jaccardSimilarity,
  proposeBackfillCandidates,
  backfillRelations,
} from '../../src/core/kg-backfill.js';

const require = createRequire(import.meta.url);

// Contract tests for the heuristic KG relation backfill introduced in
// commit 746d60cf. Two rules are pinned here:
//
//   Rule 1 — tag co-occurrence: two active entities sharing ≥ 2 topical
//   tags get a `related-to` edge.
//
//   Rule 2 — project clustering: orphan consumer-type entities
//   (lesson_learned, decision, bug_fix, …) in a project get a single
//   `belongs-to-project` edge to the most recent anchor-type entity
//   (release, feature, architecture, plan) in that project.
//
// Scenario #10 (system-tag exclusion) is the regression pin for the
// cartesian-explosion bug the maintainer caught manually on the live DB:
// 24 lessons sharing `completed` would have produced 276 bogus edges.

describe('isTopicalTag — strict allow-list semantics', () => {
  // Allow-listed prefixes
  it('should accept topic: prefix tags', () => {
    expect(isTopicalTag('topic:auth')).toBe(true);
  });

  it('should accept tech: prefix tags', () => {
    expect(isTopicalTag('tech:nodejs')).toBe(true);
  });

  // Blocked prefixes (system namespaces)
  it('should reject project: prefix tags — system namespace', () => {
    expect(isTopicalTag('project:memesh')).toBe(false);
  });

  it('should reject week: prefix tags — system namespace', () => {
    expect(isTopicalTag('week:2026-W19')).toBe(false);
  });

  // Date-shaped bare tags
  it('should reject bare YYYY-MM-DD date tags', () => {
    expect(isTopicalTag('2026-05-10')).toBe(false);
  });

  // System literal blocklist
  it('should reject session_end — system literal', () => {
    expect(isTopicalTag('session_end')).toBe(false);
  });

  it('should reject completed — lifecycle status (cartesian-noise fix)', () => {
    expect(isTopicalTag('completed')).toBe(false);
  });

  // Bare content tags pass through
  it('should accept bare content tags like auth-pattern', () => {
    expect(isTopicalTag('auth-pattern')).toBe(true);
  });

  // Defensive edge cases
  it('should reject empty string', () => {
    expect(isTopicalTag('')).toBe(false);
  });

  it('should reject null coerced to empty string via falsy check', () => {
    // The function signature is (tag: string) but callers could pass
    // null/undefined from DB rows. The `!tag` guard covers this.
    expect(isTopicalTag(null as unknown as string)).toBe(false);
    expect(isTopicalTag(undefined as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests
// ---------------------------------------------------------------------------

describe('kg-backfill integration', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;
  // Use createRequire to import better-sqlite3 synchronously
  let Database: ReturnType<typeof require>;
  let db: InstanceType<typeof Database>;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-kg-backfill-test-'));
    dbPath = path.join(testDir, 'test.db');
    prevDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;
    // Open a fresh DB for this test using the singleton
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* nothing open */ }
    openDatabase();
    // Also open a direct better-sqlite3 handle for seeding
    Database = require('better-sqlite3');
    db = new Database(dbPath);
  });

  afterEach(async () => {
    db.close();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = prevDbPath;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function insertEntity(name: string, type: string, status = 'active'): number {
    const r = db.prepare(
      "INSERT INTO entities (name, type, status) VALUES (?, ?, ?)"
    ).run(name, type, status);
    return r.lastInsertRowid as number;
  }

  function insertTag(entityId: number, tag: string): void {
    db.prepare("INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)").run(entityId, tag);
  }

  function insertRelation(fromId: number, toId: number, relType = 'related-to'): void {
    db.prepare(
      "INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)"
    ).run(fromId, toId, relType);
  }

  function countRelations(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM relations").get() as { c: number }).c;
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: Tag co-occurrence — happy path
  // ---------------------------------------------------------------------------

  it('should propose related-to for two orphans sharing ≥ 2 topical tags', () => {
    // Entity A: orphan with 2 topical tags + 1 system tag
    const idA = insertEntity('entity-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');
    insertTag(idA, 'project:demo');   // system — excluded

    // Entity B: orphan sharing the 2 topical tags
    const idB = insertEntity('entity-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');
    insertTag(idB, 'project:other');  // system — excluded

    // Entity C: orphan with unrelated tags — should not appear
    const idC = insertEntity('entity-c', 'knowledge');
    insertTag(idC, 'topic:ci');
    insertTag(idC, 'tech:docker');

    const candidates = proposeBackfillCandidates({ minSharedTags: 2 });

    // A↔B pair must exist (A→B or B→A depending on iteration order)
    const abCandidate = candidates.find(
      c => (c.fromEntityId === idA && c.toEntityId === idB) ||
           (c.fromEntityId === idB && c.toEntityId === idA)
    );
    expect(abCandidate).toBeDefined();
    expect(abCandidate!.relationType).toBe('related-to');
    expect(abCandidate!.strength).toBe(2);

    // C must not appear paired with A or B
    const cInvolved = candidates.filter(
      c => c.fromEntityId === idC || c.toEntityId === idC
    );
    expect(cInvolved).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Orphan-only filter — only orphans propose, not connected peers
  // ---------------------------------------------------------------------------

  it('should only generate candidates FROM orphan entities, not from connected peers', () => {
    const idOrphan = insertEntity('orphan-entity', 'knowledge');
    insertTag(idOrphan, 'topic:auth');
    insertTag(idOrphan, 'tech:oauth');

    const idConnected = insertEntity('connected-entity', 'knowledge');
    insertTag(idConnected, 'topic:auth');
    insertTag(idConnected, 'tech:oauth');
    // Give idConnected an existing relation so it is NOT an orphan
    const idAnchor = insertEntity('some-anchor', 'release');
    insertRelation(idConnected, idAnchor);

    const candidates = proposeBackfillCandidates({ minSharedTags: 2 });

    // The connected entity must not appear as fromEntityId
    const connectedAsSource = candidates.filter(c => c.fromEntityId === idConnected);
    expect(connectedAsSource).toHaveLength(0);

    // The orphan SHOULD propose a candidate toward the connected entity
    // (Rule 1 looks up ALL entities as potential peers, not just orphans)
    const orphanToConnected = candidates.find(
      c => c.fromEntityId === idOrphan && c.toEntityId === idConnected
    );
    expect(orphanToConnected).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: maxEdgesPerSource cap
  // ---------------------------------------------------------------------------

  it('should cap candidates per orphan source at maxEdgesPerSource', () => {
    const idOrphan = insertEntity('rich-orphan', 'knowledge');
    insertTag(idOrphan, 'topic:auth');
    insertTag(idOrphan, 'tech:oauth');

    // Create 5 peers each sharing both topical tags with the orphan
    for (let i = 1; i <= 5; i++) {
      const id = insertEntity(`peer-${i}`, 'knowledge');
      insertTag(id, 'topic:auth');
      insertTag(id, 'tech:oauth');
    }

    const candidates = proposeBackfillCandidates({ maxEdgesPerSource: 3, minSharedTags: 2 });
    const fromOrphan = candidates.filter(c => c.fromEntityId === idOrphan);
    expect(fromOrphan.length).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Project clustering — basic happy path
  // ---------------------------------------------------------------------------

  it('should propose belongs-to-project from orphan lesson to release anchor in same project', () => {
    // Anchor: a release in project:demo (NOT an orphan — has a relation)
    const idRelease = insertEntity('v1.0.0-release', 'release');
    insertTag(idRelease, 'project:demo');
    // Give the release an existing relation so it's not an orphan itself
    // (the rule reads ALL entities for anchors, not just orphans)
    const idConnected = insertEntity('dummy-connected', 'knowledge');
    insertRelation(idRelease, idConnected);

    // Orphan consumer: lesson in same project
    const idLesson = insertEntity('bug-fix-auth', 'lesson_learned');
    insertTag(idLesson, 'project:demo');

    const candidates = proposeBackfillCandidates();
    const pc = candidates.find(
      c => c.fromEntityId === idLesson && c.toEntityId === idRelease
    );
    expect(pc).toBeDefined();
    expect(pc!.relationType).toBe('belongs-to-project');
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Project clustering — only one (most recent) anchor per orphan
  // ---------------------------------------------------------------------------

  it('should link orphan to only the most-recent anchor when multiple anchors exist in project', () => {
    // Three releases in project:demo with different timestamps
    const idRelOld = insertEntity('v1.0.0-release', 'release');
    insertTag(idRelOld, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2025-01-01 00:00:00' WHERE id = ?").run(idRelOld);

    const idRelMid = insertEntity('v2.0.0-release', 'release');
    insertTag(idRelMid, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2025-06-01 00:00:00' WHERE id = ?").run(idRelMid);

    const idRelNew = insertEntity('v3.0.0-release', 'release');
    insertTag(idRelNew, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(idRelNew);

    // Orphan lesson
    const idLesson = insertEntity('critical-bug-fix', 'lesson_learned');
    insertTag(idLesson, 'project:demo');

    const candidates = proposeBackfillCandidates();
    const pcCandidates = candidates.filter(
      c => c.fromEntityId === idLesson && c.relationType === 'belongs-to-project'
    );

    // Only one anchor per orphan
    expect(pcCandidates).toHaveLength(1);
    // Must be the most-recent release
    expect(pcCandidates[0].toEntityId).toBe(idRelNew);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: applyBackfill writes rows + idempotency (INSERT OR IGNORE)
  // ---------------------------------------------------------------------------

  it('should write edges on first call and skip duplicates on re-run', () => {
    const idA = insertEntity('apply-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');

    const idB = insertEntity('apply-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');

    const before = countRelations();
    const result1 = backfillRelations({ dryRun: false, minSharedTags: 2 });
    const after1 = countRelations();

    // Edges were written
    expect(result1.edgesWritten).toBeGreaterThan(0);
    expect(after1).toBeGreaterThan(before);

    // Second run — INSERT OR IGNORE should fire zero new rows
    const result2 = backfillRelations({ dryRun: false, minSharedTags: 2 });
    const after2 = countRelations();

    expect(result2.edgesWritten).toBe(0);
    expect(after2).toBe(after1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Dry-run does not write, but still proposes candidates
  // ---------------------------------------------------------------------------

  it('should not write any edges when dryRun is true', () => {
    const idA = insertEntity('dry-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');

    const idB = insertEntity('dry-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');

    const before = countRelations();
    const result = backfillRelations({ dryRun: true, minSharedTags: 2 });
    const after = countRelations();

    expect(result.dryRun).toBe(true);
    expect(result.candidatesProposed).toBeGreaterThan(0);
    expect(result.edgesWritten).toBe(0);
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: Project filter — only entities from the target project
  // ---------------------------------------------------------------------------

  it('should only propose candidates for the specified project when project option is set', () => {
    // Orphans in project:demo
    const idDemoA = insertEntity('demo-entity-a', 'knowledge');
    insertTag(idDemoA, 'topic:auth');
    insertTag(idDemoA, 'tech:oauth');
    insertTag(idDemoA, 'project:demo');

    const idDemoB = insertEntity('demo-entity-b', 'knowledge');
    insertTag(idDemoB, 'topic:auth');
    insertTag(idDemoB, 'tech:oauth');
    insertTag(idDemoB, 'project:demo');

    // Orphans in project:other — must not appear
    const idOtherA = insertEntity('other-entity-a', 'knowledge');
    insertTag(idOtherA, 'topic:auth');
    insertTag(idOtherA, 'tech:oauth');
    insertTag(idOtherA, 'project:other');

    const idOtherB = insertEntity('other-entity-b', 'knowledge');
    insertTag(idOtherB, 'topic:auth');
    insertTag(idOtherB, 'tech:oauth');
    insertTag(idOtherB, 'project:other');

    const candidates = proposeBackfillCandidates({ project: 'demo', minSharedTags: 2 });

    // All candidates must involve only demo entities as the FROM (orphan source)
    const demoEntityIds = new Set([idDemoA, idDemoB]);
    for (const c of candidates) {
      expect(demoEntityIds.has(c.fromEntityId)).toBe(true);
    }

    // other-project entities must not appear as source
    const otherIds = new Set([idOtherA, idOtherB]);
    const otherInvolved = candidates.filter(c => otherIds.has(c.fromEntityId));
    expect(otherInvolved).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: System-tag exclusion — regression for cartesian-explosion fix
  // ---------------------------------------------------------------------------

  it('should produce zero tag-cooccurrence candidates when entities share only system-literal tags', () => {
    // 3 orphan lessons sharing only `completed` + `lesson` — both SYSTEM_TAG_LITERALS.
    // Without the filter these would produce 3 cartesian pairs (3×2/2 = 3 edges).
    // With the filter: zero topical tags => zero candidates from Rule 1.
    for (let i = 1; i <= 3; i++) {
      const id = insertEntity(`system-tag-lesson-${i}`, 'lesson_learned');
      insertTag(id, 'completed');   // SYSTEM_TAG_LITERALS
      insertTag(id, 'lesson');      // SYSTEM_TAG_LITERALS
    }

    const candidates = proposeBackfillCandidates({ minSharedTags: 2 });

    // Rule 1 must propose nothing — all shared tags are system-literal noise
    const tagCooc = candidates.filter(c => c.relationType === 'related-to');
    expect(tagCooc).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Rule 3: Session co-occurrence
  // ---------------------------------------------------------------------------

  function setMetadata(entityId: number, meta: Record<string, unknown>): void {
    db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), entityId);
  }

  it('A1: links two high-signal orphans sharing a session: tag (co-created)', () => {
    const idA = insertEntity('lesson from auth work', 'lesson_learned');
    insertTag(idA, 'session:abc123');
    setMetadata(idA, { signal_score: 1.0 });

    const idB = insertEntity('decision on auth approach', 'decision');
    insertTag(idB, 'session:abc123');
    setMetadata(idB, { signal_score: 0.9 });

    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: false });
    expect(result.byRule.sessionCooccurrence).toBeGreaterThanOrEqual(1);

    const rel = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='co-created'"
    ).get(idA, idB);
    expect(rel).toBeTruthy();
  });

  it('A2: excludes low-signal entities (signal_score < 0.6) from session co-occurrence', () => {
    const idC = insertEntity('Duration: 0s noise', 'session_keypoint');
    insertTag(idC, 'session:xyz789');
    setMetadata(idC, { signal_score: 0.0 });

    const idD = insertEntity('real decision', 'decision');
    insertTag(idD, 'session:xyz789');
    setMetadata(idD, { signal_score: 0.9 });

    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: false });
    // session_keypoint is not in sessionEligibleTypes; also score=0 < 0.6
    expect(result.byRule.sessionCooccurrence).toBe(0);
  });

  it('A3: dry-run proposes co-created edges without writing', () => {
    const idE = insertEntity('lesson X', 'lesson_learned');
    insertTag(idE, 'session:s1');
    setMetadata(idE, { signal_score: 1.0 });

    const idF = insertEntity('decision Y', 'decision');
    insertTag(idF, 'session:s1');
    setMetadata(idF, { signal_score: 0.9 });

    const before = countRelations();
    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: true });
    const after = countRelations();

    expect(result.candidatesProposed).toBeGreaterThanOrEqual(1);
    expect(result.edgesWritten).toBe(0);
    expect(after).toBe(before);
  });

  it('A6: maxEdgesPerSource caps co-created edges from Rule 3', () => {
    const anchor = insertEntity('big lesson', 'lesson_learned');
    insertTag(anchor, 'session:s2');
    setMetadata(anchor, { signal_score: 1.0 });

    for (let i = 0; i < 5; i++) {
      const id = insertEntity(`decision ${i}`, 'decision');
      insertTag(id, 'session:s2');
      setMetadata(id, { signal_score: 0.9 });
    }

    backfillRelations({ includeSessionCooccurrence: true, maxEdgesPerSource: 2, dryRun: false });

    const edges = db.prepare(
      "SELECT COUNT(*) AS n FROM relations WHERE from_entity_id=? AND relation_type='co-created'"
    ).get(anchor) as { n: number };
    expect(edges.n).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Rule 4: Name token similarity
  // ---------------------------------------------------------------------------

  it('A4: links orphans sharing ≥2 content name tokens (shares-name-tokens)', () => {
    const idG = insertEntity('memesh auth flow refactor', 'feature');
    setMetadata(idG, { signal_score: 0.65 });

    const idH = insertEntity('auth flow session handling', 'bug_fix');
    setMetadata(idH, { signal_score: 0.7 });

    const result = backfillRelations({ includeNameTokenSimilarity: true, dryRun: false });
    expect(result.byRule.nameTokenSimilarity).toBeGreaterThanOrEqual(1);
  });

  it('A5: does NOT link orphans with only stopword name overlap', () => {
    // After removing stopwords: {auth,bug} vs {login,issue} — 0 shared tokens
    insertEntity('fix the auth bug', 'bug_fix');
    insertEntity('fix the login issue', 'bug_fix');

    const result = backfillRelations({ includeNameTokenSimilarity: true, dryRun: false });
    expect(result.byRule.nameTokenSimilarity).toBe(0);
  });

  it('A4-jaccard: qualifies via Jaccard ≥ 0.25 even when shared token count < minSharedNameTokens', () => {
    // tokens: {oauth,implementation} vs {oauth,module} → intersection=1, union=3 → Jaccard=0.33
    const idI = insertEntity('oauth implementation', 'feature');
    setMetadata(idI, { signal_score: 0.65 });

    const idJ = insertEntity('oauth module', 'architecture');
    setMetadata(idJ, { signal_score: 0.9 });

    const result = backfillRelations({
      includeNameTokenSimilarity: true,
      minSharedNameTokens: 2,   // shared=1 < 2, but Jaccard=0.33 ≥ 0.25 still qualifies
      minNameJaccard: 0.25,
      dryRun: false,
    });
    expect(result.byRule.nameTokenSimilarity).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Task A2: Pure-function unit tests for tokenizeName + jaccardSimilarity
// ---------------------------------------------------------------------------

describe('tokenizeName — content token extraction', () => {
  it('lowercases and splits on non-word chars, removes stopwords', () => {
    // 'fix' is a stopword; 'auth' and 'flow' are content tokens
    expect(tokenizeName('Auth-Flow Fix')).toEqual(new Set(['auth', 'flow']));
  });

  it('filters tokens shorter than 3 chars', () => {
    expect(tokenizeName('io vs go')).toEqual(new Set([]));
  });

  it('removes stopwords', () => {
    expect(tokenizeName('fix the auth bug')).toEqual(new Set(['auth', 'bug']));
  });

  it('handles empty string', () => {
    expect(tokenizeName('')).toEqual(new Set());
  });

  it('splits on underscores (non-word boundary)', () => {
    expect(tokenizeName('session_auth_handler')).toEqual(new Set(['session', 'auth', 'handler']));
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1.0);
  });

  it('returns 0.0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0.0);
  });

  it('computes partial overlap correctly', () => {
    // intersection={auth,flow}, union={auth,flow,memesh,session} → 2/4 = 0.5
    const a = new Set(['auth', 'flow', 'memesh']);
    const b = new Set(['auth', 'flow', 'session']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it('returns 0.0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0.0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0.0);
  });
});
