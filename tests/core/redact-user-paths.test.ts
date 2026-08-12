/**
 * `redactUserPaths` decides what a PUBLIC GitHub issue says about the user's
 * machine, on two surfaces: `memesh feedback` composes the body from `doctor`
 * output, and the dashboard's widget composes the same body from `/v1/doctor`,
 * where this runs server-side over the JSON.
 *
 * So it has two ways to fail, and both are bad in opposite directions:
 * redacting too little publishes the account name, and redacting too much
 * corrupts the diagnostic the user is about to file — silently, since nothing
 * marks a mangled report as mangled.
 *
 * Tested directly rather than through the CLI because the interesting inputs
 * are configurations, not commands: an env override pointing somewhere
 * relative, or at a directory whose name is a prefix of an unrelated one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactUserPaths } from '../../src/core/paths.js';

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['HOME', 'USERPROFILE', 'MEMESH_DIR', 'MEMESH_DB_PATH']) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-redact-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.MEMESH_DIR;
  delete process.env.MEMESH_DB_PATH;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('redactUserPaths: hides the account name', () => {
  it('replaces the home directory, in both its spellings', () => {
    // macOS resolves a temp HOME through /private, so the text can carry
    // either form; redacting one and not the other publishes the other.
    const real = fs.realpathSync(home);
    const out = redactUserPaths(`db at ${home}/.memesh/kg.db and ${real}/.memesh/kg.db`);
    expect(out).not.toContain(home);
    expect(out).not.toContain(real);
    expect(out).toBe('db at ~/.memesh/kg.db and ~/.memesh/kg.db');
  });

  it('replaces a data directory an override moved outside home', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-corpshare-'));
    try {
      process.env.MEMESH_DIR = outside;
      const out = redactUserPaths(`config at ${outside}/config.json`);
      expect(out).not.toContain(outside);
      expect(out).toBe('config at ~/config.json');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('redactUserPaths: does not corrupt the report', () => {
  it('ignores a relative override instead of turning "." into a root', () => {
    // `getDbPath()` returns MEMESH_DB_PATH verbatim, so a relative value makes
    // `path.dirname(...)` exactly ".". As a redaction root that matched every
    // "./" in the payload. Only the absolute-path guard rejects it — the
    // boundary anchor alone does not, because "." IS followed by a separator
    // here.
    process.env.MEMESH_DB_PATH = 'kg.db';
    const out = redactUserPaths('see ./config.json and ../notes.md — version 4.5.0');
    expect(out, '"." was accepted as a redaction root').toBe(
      'see ./config.json and ../notes.md — version 4.5.0'
    );
  });

  it('matches a root only where the path component ENDS', () => {
    // Roots were unanchored substrings, so MEMESH_DIR=/data rewrote
    // /var/lib/postgres/database and /datasets/x.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths('/var/lib/postgres/database and /datasets/x and /data/real');
    expect(out).toContain('/var/lib/postgres/database');
    expect(out).toContain('/datasets/x');
    // …while the genuine one is still redacted, so this is not "match nothing".
    expect(out).toContain('~/real');
  });

  it('matches a root only where the path component BEGINS', () => {
    // The trailing boundary alone passes this case — /data is followed by a
    // separator, which is exactly what it asks for — so a root still matched in
    // the middle of an unrelated path and /var/lib/data/file came out as
    // /var/lib~/file. Splitting this from the test above is deliberate: one
    // assertion per boundary, so removing either anchor turns exactly one test
    // red instead of leaving the other one covering for it.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths(
      '/var/lib/data/file and /srv/data/x and MEMESH_DIR=/data/real and /data/top'
    );
    expect(out, 'a root matched inside an unrelated path').toContain('/var/lib/data/file');
    expect(out, 'a root matched inside an unrelated path').toContain('/srv/data/x');
    // Preceded by `=` and by nothing at all: both are real boundaries, so the
    // lookbehind must not reject them. Without this half the fix reads as
    // "redact less" rather than "redact the right thing".
    expect(out, 'a genuine root after "=" stopped being redacted').toContain('MEMESH_DIR=~/real');
    expect(out, 'a genuine root at the start of the text stopped being redacted').toContain('~/top');
  });

  it('does not let a doubled separator slip a root past the boundary', () => {
    // `[\\/]{1,2}` in the pattern means the match can start one character to
    // the right of a `//` pair. If the lookbehind only forbade word characters,
    // that second slash would be an allowed predecessor and /var/lib//data
    // would redact after all.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths('/var/lib//data/file');
    expect(out, 'a doubled separator let a root match mid-path').toBe('/var/lib//data/file');
  });

  it('still redacts a root inside a file:// URL', () => {
    // The first lookbehind forbade EVERY separator as a predecessor, which
    // unredacted each frame of a Node ESM stack trace: in file:///data/x the
    // match starts at a separator that follows another separator. What makes
    // that different from /var/lib//data — also a separator after a separator —
    // is what comes before the pair: a component character there, a `:` here.
    // The lookbehind has to reach past the separators to the glue, not stop at
    // the separators themselves. This is the case that turns red if it is
    // written as a single-character class again.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths('Error at file:///data/secret.txt:3:5');
    // `file:/~`, not `file://~`: the pattern's `[\\/]{1,2}` absorbs up to two
    // separators into the match (it has to, for JSON-doubled backslashes), so
    // one of the URL's slashes is replaced along with the root. The account
    // name is gone and the frame is still legible — this is the over-redaction
    // side of the trade the lookbehind comment describes, chosen on purpose.
    expect(out, 'an ESM stack-trace frame kept the real path').not.toContain('/data');
    expect(out).toContain('file:/~/secret.txt');
  });

  it('still redacts a root on a diff removed-line', () => {
    // `-` can end a path component in principle, but a predecessor `-` is far
    // more often a diff marker or a bullet — and this function is a security
    // control, so the ambiguity resolves toward redacting: over-matching costs
    // a slightly mangled diagnostic, under-matching publishes the account name.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths('--- old\n-/data/secret and see.../data/quoted');
    expect(out, 'a diff removed-line kept the real path').toContain('-~/secret');
    expect(out, 'an ellipsis predecessor kept the real path').toContain('see...~/quoted');
  });

  it('leaves text with no machine paths in it exactly as it was', () => {
    const text = 'Node v24.15.0 (ABI 137, darwin/arm64). 17 skill files verified.';
    expect(redactUserPaths(text)).toBe(text);
  });
});
