import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Recall results carry HOW they were found. The P7 audit's worst core-trust
 * moment: a nonsense query against a populated database returned an
 * unrelated entity presented exactly like a match. The geometry cannot be
 * thresholded out — measured on this repo's own calibration data, junk
 * queries land at distance 1.205–1.288 against real stored entities while
 * genuine matches reach p75 1.269 — so the fix is provenance: `match.source`
 * says `keyword` or `semantic`, and presentation layers disclose what
 * geometry cannot certify. Ranking is untouched (Mode A benchmark re-run on
 * the changed tree: R@5 0.956, MRR 0.8929 — identical to the published
 * figures).
 */
let home: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

describe('recall provenance: results say how they were found', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-prov-'));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('keyword hits are tagged keyword; a semantic-only rescue is tagged semantic', async () => {
    const { openDatabase } = await import('../src/db.js');
    const { remember, recallEnhanced } = await import('../src/core/operations.js');
    openDatabase();

    await remember({
      name: 'lorem-note',
      type: 'note',
      observations: ['lorem-ipsum-token lorem-ipsum-token dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'],
    });

    const { entities: keyword } = await recallEnhanced({ query: 'lorem ipsum dolor' });
    expect(keyword.length).toBeGreaterThan(0);
    expect(keyword[0].match?.source).toBe('keyword');

    // The exact P7 fixture: gibberish query, populated DB. Whatever the
    // vector index surfaces must be LABELLED as semantic — and if the
    // embedder is unavailable in this environment, the honest answer is
    // zero results, which also passes (absence, not a mislabelled match).
    const { entities: nonsense } = await recallEnhanced({ query: 'xyzzyplughfrobozz quux' });
    for (const e of nonsense) {
      expect(e.match?.source, `${e.name} surfaced without keyword evidence`).toBe('semantic');
      expect(e.match!.relevance).toBeGreaterThan(0);
      expect(e.match!.relevance).toBeLessThan(1);
    }
  });

  it('the empty-query listing carries no match provenance — a listing is not a match', async () => {
    const { openDatabase } = await import('../src/db.js');
    const { remember, recallEnhanced } = await import('../src/core/operations.js');
    openDatabase();
    await remember({ name: 'plain-note', type: 'note', observations: ['hello world'] });

    const listed = (await recallEnhanced({})).entities;
    expect(listed.length).toBeGreaterThan(0);
    for (const e of listed) expect(e.match).toBeUndefined();
  });
});
