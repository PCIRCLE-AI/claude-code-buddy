/**
 * Five comparisons across two timestamp formats, all failing the same way.
 *
 * SQLite stores what it is given. `CURRENT_TIMESTAMP` writes
 * `'YYYY-MM-DD HH:MM:SS'`; JavaScript's `toISOString()` writes
 * `'YYYY-MM-DDTHH:MM:SS.sssZ'`. Both live in this database — `created_at` and
 * `llm_telemetry.ts` come from SQLite, `last_accessed_at` and every cutoff
 * computed in JS come from Date. Compared as TEXT they first differ at index
 * 10, and the separator decides the whole comparison:
 *
 *     ' '  is 0x20     'T'  is 0x54     so ' ' sorts BEFORE 'T'
 *
 * Same instant, opposite verdicts. The consequences ran from "one day of a
 * scorecard silently missing" to "every telemetry row from the cutoff day
 * deleted, including rows newer than the cutoff".
 *
 * The fix is one rule: normalise before comparing — `datetime(?)` in SQL,
 * `parseSqliteUtcMs` in JS. This file pins the rule at the boundary where it
 * matters, the cutoff day itself, because that is the only place the defect
 * was ever visible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { pruneTelemetry, summariseTelemetry } from '../../src/core/llm-telemetry.js';
import { parseSqliteUtcMs } from '../../src/core/time-utils.js';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-tsfmt-'));
  saved = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'kg.db'));
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (saved === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** SQLite's own rendering of a moment, which is what `ts` really holds. */
function sqliteStamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

function addTelemetry(ts: string, flow = 'dreamer'): void {
  getDatabase()
    .prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, model, attempt_index, status, latency_ms, fallback_used)
       VALUES (?, ?, 'anthropic', 'm', 0, 'ok', 10, 0)`,
    )
    .run(ts, flow);
}

function telemetryCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM llm_telemetry').get() as { c: number }).c;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * A stamp on the SAME CALENDAR DAY as a cutoff, but newer than it.
 *
 * Derived from the cutoff rather than picked by hand: the defect only shows
 * where the two strings share their first ten characters and differ at the
 * separator, so a fixture that lands a day off proves nothing — and a
 * hand-picked offset lands a day off whenever the run happens near midnight.
 * The hour is forced to 23:59:59 UTC of the cutoff's date, which is the
 * newest a same-day row can be.
 */
function sameDayButNewerThan(cutoffMs: number): string {
  const d = new Date(cutoffMs);
  return `${d.toISOString().slice(0, 10)} 23:59:59`;
}

/** How far back the product's own cutoff sits, in ms. */
function cutoffMsFor(days: number): number {
  return Date.now() - days * DAY;
}

describe('the separator does decide a raw TEXT comparison', () => {
  it("' ' sorts before 'T', so the two formats disagree about the same instant", () => {
    // Not a test of memesh — a test of the premise every fix below rests on.
    // If this ever stops being true, the fixes are solving nothing.
    const now = new Date();
    const iso = now.toISOString();
    const sqlite = iso.replace('T', ' ').slice(0, 19);
    expect(sqlite < iso, 'the same moment no longer compares unequal across formats').toBe(true);
  });
});

describe('pruning telemetry keeps rows newer than the cutoff', () => {
  it('does not delete a row from the cutoff day that is newer than the cutoff', () => {
    // 180 days is the default window. A row 179 days and 23 hours old is
    // INSIDE it — but shares a date with the cutoff, which is exactly where
    // the raw comparison went wrong.
    const cutoff = cutoffMsFor(180);
    const boundary = sameDayButNewerThan(cutoff);
    // Fixture: the row really is inside the window AND really does share the
    // cutoff's date. Both have to hold or the test proves nothing.
    expect(parseSqliteUtcMs(boundary)! > cutoff, 'fixture: the row is not inside the window').toBe(true);
    expect(boundary.slice(0, 10), 'fixture: the row is not on the cutoff day')
      .toBe(new Date(cutoff).toISOString().slice(0, 10));

    addTelemetry(boundary, 'inside-window');
    addTelemetry(sqliteStamp(400 * DAY), 'genuinely-old');
    expect(telemetryCount(), 'fixture: nothing to prune').toBe(2);

    pruneTelemetry();

    const rows = getDatabase().prepare('SELECT flow FROM llm_telemetry').all() as Array<{ flow: string }>;
    expect(rows, 'the row inside the window was deleted with the old one').toHaveLength(1);
    expect(rows[0].flow).toBe('inside-window');
  });

  it('still deletes what it should — the anti-vacuity half', () => {
    // A prune normalised into a no-op would satisfy the test above and let
    // telemetry grow without bound.
    addTelemetry(sqliteStamp(400 * DAY), 'genuinely-old');
    pruneTelemetry();
    expect(telemetryCount(), 'nothing was pruned at all').toBe(0);
  });
});

describe('the scorecard includes the first day of its window', () => {
  it('counts a row from the window boundary day', () => {
    // The mirror image: `WHERE ts >= ?` dropped every row from the first day
    // of the window, so a 30-day scorecard silently reported 29.
    const cutoff = cutoffMsFor(30);
    const boundary = sameDayButNewerThan(cutoff);
    expect(parseSqliteUtcMs(boundary)! > cutoff, 'fixture: the row is not inside the window').toBe(true);
    addTelemetry(boundary, 'boundary-day');

    const summaries = summariseTelemetry(30);

    expect(summaries.map((s) => s.flow), 'the boundary day was dropped from the scorecard')
      .toContain('boundary-day');
  });

  it('still excludes rows outside the window — the anti-vacuity half', () => {
    addTelemetry(sqliteStamp(400 * DAY), 'ancient');
    expect(summariseTelemetry(30).map((s) => s.flow)).not.toContain('ancient');
  });
});

describe('a plan touched on the cutoff day is not stale', () => {
  it('does not count a plan whose last access is one hour inside the window', async () => {
    // `stalePlanCount` compares `last_accessed_at` — written by trackAccess
    // as an ISO string — against `datetime('now','-30 days')`, which is
    // SQLite's format. 'T' sorts AFTER ' ', so an ISO stamp on the cutoff
    // day always read as NEWER than the cutoff, whatever the hour: a plan
    // untouched for 30 days and 20 hours still counted as fresh.
    const { computePmAnalytics } = await import('../../src/core/analytics.js');
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, status) VALUES ('a-plan', 'plan', 'active')").run();
    // Just OUTSIDE the window, on the same calendar day as the cutoff.
    const cutoff = cutoffMsFor(30);
    const justStale = new Date(cutoff - HOUR).toISOString();
    expect(justStale.slice(0, 10), 'fixture: not on the cutoff day')
      .toBe(new Date(cutoff).toISOString().slice(0, 10));
    db.prepare("UPDATE entities SET last_accessed_at = ? WHERE name = 'a-plan'").run(justStale);

    expect(computePmAnalytics(db).staleness.stalePlanCount,
      'a plan past the cutoff was reported as fresh').toBe(1);
  });

  it('does not count a plan touched today — the anti-vacuity half', async () => {
    const { computePmAnalytics } = await import('../../src/core/analytics.js');
    const db = getDatabase();
    db.prepare("INSERT INTO entities (name, type, status) VALUES ('fresh-plan', 'plan', 'active')").run();
    db.prepare("UPDATE entities SET last_accessed_at = ? WHERE name = 'fresh-plan'")
      .run(new Date().toISOString());

    expect(computePmAnalytics(db).staleness.stalePlanCount,
      'a plan touched today was reported as stale').toBe(0);
  });
});

describe('recency ordering uses the instant, not the text', () => {
  it('ranks by parsed time where a TEXT compare would invert it', () => {
    // What `kg-backfill`'s Rule 2 does when it picks the newest anchor for a
    // project. `localeCompare` on `created_at` ordered by the string, and
    // the two stored formats differ at the separator — so a value written
    // one way always sorted after a value written the other way from the
    // same second, regardless of which was actually newer.
    const older = '2026-08-24 08:00:00';
    const newer = '2026-08-24 09:00:00';

    const byInstant = [older, newer].sort(
      (a, b) => (parseSqliteUtcMs(b) ?? -Infinity) - (parseSqliteUtcMs(a) ?? -Infinity),
    );
    expect(byInstant[0]).toBe(newer);
  });

  it('sorts a timestamp it cannot trust LAST, not first', () => {
    // The policy Rule 5 already set and Rule 2 did not follow: a value the
    // parser will not vouch for must not become a number that sorts.
    // `localeCompare` put a full ISO string ahead of every SQLite-format
    // sibling from the same day, because 'T' sorts after ' '.
    const trusted = '2026-08-24 09:00:00';
    const untrusted = '2026-08-24T10:00:00.000Z';   // newer in real time

    expect(parseSqliteUtcMs(untrusted), 'the parser no longer rejects a suffixed value').toBeNull();
    expect(untrusted.localeCompare(trusted), 'fixture: the formats no longer disagree as TEXT')
      .toBeGreaterThan(0);

    const byInstant = [trusted, untrusted].sort(
      (a, b) => (parseSqliteUtcMs(b) ?? -Infinity) - (parseSqliteUtcMs(a) ?? -Infinity),
    );
    expect(byInstant[0], 'an untrusted timestamp was ranked as the newest').toBe(trusted);
  });
});

describe('the demo tour writes the format the column holds', () => {
  it('back-dates a seeded entity in SQLite format, so the parser trusts it', async () => {
    // demo.ts was the one writer putting a full ISO string into
    // `created_at`. Every demo entity was therefore untrusted by
    // `parseSqliteUtcMs`, invisible to the relation backfill's anchoring,
    // and out of order against its CURRENT_TIMESTAMP siblings — in the one
    // dataset a new user's first impressions are built from.
    const { seedDemo } = await import('../../src/core/demo.js');
    const result = seedDemo(getDatabase());
    expect(result.inserted, 'fixture: the tour seeded nothing').toBeGreaterThan(0);

    const rows = getDatabase()
      .prepare("SELECT name, created_at FROM entities WHERE json_extract(metadata, '$.demo') = 1")
      .all() as Array<{ name: string; created_at: string }>;
    expect(rows.length, 'fixture: no demo rows carry the marker').toBeGreaterThan(0);

    const unparseable = rows.filter((r) => parseSqliteUtcMs(r.created_at) === null);
    expect(unparseable.map((r) => `${r.name}=${r.created_at}`),
      'a demo entity carries a timestamp the repo\'s own parser rejects').toEqual([]);
  });
});
