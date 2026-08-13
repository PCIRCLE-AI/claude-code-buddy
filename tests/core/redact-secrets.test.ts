import { describe, it, expect } from 'vitest';
import os from 'os';
import { redactSecrets, redactUserPaths, SECRET_PATTERN_SOURCES } from '../../src/core/paths.js';

/**
 * redactSecrets guards two PUBLIC egresses — the dashboard's /v1/doctor and
 * the CLI's `memesh feedback`, both of which land verbatim in a pre-filled
 * GitHub issue body. Until this file existed the function had ZERO tests:
 * deleting any single pattern, or the call itself, left the whole suite
 * green while credentials sailed into a public issue URL. A cross-model
 * review measured the gap empirically (github_pat_, Stripe, JWT and npm
 * tokens all survived the old seven-pattern list).
 */
describe('redactSecrets (public-egress credential masking)', () => {
  // One realistic sample per shape the shared list claims to cover.
  const SECRETS: Array<[string, string]> = [
    ['anthropic key', 'sk-ant-' + 'a1B2'.repeat(6)],
    ['openai key', 'sk-' + 'x9Yz'.repeat(6)],
    ['underscore sk key', 'sk_' + 'a1b2c3d4'.repeat(2)],
    ['stripe live secret', 'sk_live_' + 'A1b2C3d4'.repeat(3)],
    ['stripe test restricted', 'rk_test_' + 'A1b2C3d4'.repeat(3)],
    ['github classic PAT', 'ghp_' + 'A1b2C3d4'.repeat(9)],
    ['github oauth', 'gho_' + 'A1b2C3d4'.repeat(9)],
    ['github server token', 'ghs_' + 'A1b2C3d4'.repeat(9)],
    ['github refresh token', 'ghr_' + 'A1b2C3d4'.repeat(9)],
    ['github fine-grained PAT', 'github_pat_' + '11AAAAAAA0'.repeat(4)],
    ['aws access key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['aws temporary key', 'ASIA' + 'ABCDEFGHIJKLMNOP'],
    ['google api key', 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5'],
    ['slack bot token', 'xoxb-1234567890-abcdefghij'],
    ['npm automation token', 'npm_' + 'a1B2c3D4e5F6'.repeat(3)],
    ['sendgrid key', 'SG.' + 'a1B2c3D4e5F6g7H8'.repeat(1) + '.' + 'i9J0k1L2m3N4o5P6'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['postgres url creds', 'postgres://memesh_user:hunter2secret@db.internal:5432/prod'],
  ];

  it.each(SECRETS)('masks a %s', (_label, secret) => {
    const out = redactSecrets(`context before ${secret} context after`);
    expect(out).toContain('***REDACTED***');
    // The full credential must be gone. For URL-shaped secrets the scheme
    // may survive; the password portion must not.
    expect(out).not.toContain(secret.includes('@') ? 'hunter2secret' : secret);
  });

  it('masks a PEM private key body, including a truncated paste', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
    const whole = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(redactSecrets(whole)).not.toContain(body);
    const truncated = `-----BEGIN PRIVATE KEY-----\n${body}\n\ntrailing prose`;
    expect(redactSecrets(truncated)).not.toContain(body);
  });

  it('catches a Bearer token split by a JSON-ESCAPED newline (the /v1/doctor shape)', () => {
    // The HTTP egress redacts JSON.stringify output, where a real newline
    // has become the two characters \n — plain \s+ cannot see it, and the
    // two egresses silently disagreed on what they masked.
    const stringified = JSON.stringify({ detail: 'Bearer\nabcdefghijklmnopqrstuvwxyz012345' });
    const out = redactSecrets(stringified);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('leaves near-miss prose alone', () => {
    const prose = [
      'the ghost in the machine',           // ghp_-adjacent prose
      'skimming the surface of sk8er culture',
      'visit https://example.com/AKIAtutorial-page', // AKIA followed by lowercase
      'Bearer of good news arrived today',  // short tail, no 16-char token
      'a word:another@host mention',        // no scheme anchor
    ].join(' ');
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('composes with path redaction the way both egresses call it', () => {
    // Both public egresses run redactUserPaths(redactSecrets(text)) — this
    // pins that the composition masks the credential AND the identifying
    // path in one pass, so neither redactor undoes the other's work.
    const home = os.homedir();
    const input = `key sk-ant-${'a1B2'.repeat(6)} found in ${home}/project/config.json`;
    const out = redactUserPaths(redactSecrets(input));
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('a1B2'.repeat(6));
    expect(out, 'the machine-identifying home path must be gone too').not.toContain(home);
  });

  it('the shared pattern list is what this suite exercised', () => {
    // Guard-the-guard: if a pattern is added to SECRET_PATTERN_SOURCES
    // without a sample here, this count goes stale and forces the author
    // to add one. Update BOTH when the list grows.
    expect(SECRET_PATTERN_SOURCES.length).toBe(18);
  });
});
