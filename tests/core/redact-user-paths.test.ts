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

  it('matches a root only at a path boundary', () => {
    // Roots were unanchored substrings, so MEMESH_DIR=/data rewrote
    // /var/lib/postgres/database and /datasets/x.
    process.env.MEMESH_DIR = '/data';
    const out = redactUserPaths('/var/lib/postgres/database and /datasets/x and /data/real');
    expect(out).toContain('/var/lib/postgres/database');
    expect(out).toContain('/datasets/x');
    // …while the genuine one is still redacted, so this is not "match nothing".
    expect(out).toContain('~/real');
  });

  it('leaves text with no machine paths in it exactly as it was', () => {
    const text = 'Node v24.15.0 (ABI 137, darwin/arm64). 17 skill files verified.';
    expect(redactUserPaths(text)).toBe(text);
  });
});
