import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { redactSecrets, redactUserPaths, SECRET_PATTERN_SOURCES } from '../../src/core/paths.js';
import { containsSecret, scrubSecrets } from '../../src/core/transcript-extractor.js';

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
    // #238 — what a provider ACTUALLY returns for a rejected key: the value
    // quoted back, partially masked. The old `sk-[A-Za-z0-9_-]{16,}` stopped
    // at the first mask glyph and published the prefix and the tail.
    ['masked openai key (asterisks)', 'sk-proj-**********************************ZfQ9'],
    ['masked openai key (bullets)', 'sk-proj-••••••••••••••••ZfQ9'],
    ['truncated openai key', 'sk-proj-...ZfQ9'],
    // #238 — a credential in a query string. No pattern covered this shape.
    ['url query api key', 'api_key=A1b2C3d4E5f6G7h8I9j0'],
    ['url query access token', 'access_token=A1b2C3d4E5f6G7h8I9j0'],
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
    expect(SECRET_PATTERN_SOURCES.length).toBe(17);
  });
});

/**
 * The other half of the contract. redactSecrets runs over
 * `JSON.stringify(doctorResult)` for the WHOLE doctor payload, which is full
 * of credential-shaped strings that are not credentials: commit SHAs,
 * `sha256:` digests, installation ids, hook marker hashes, model names.
 *
 * Over-redaction here is not a cosmetic problem. A pattern of `.` once
 * compiled from a relative DB path and replaced every literal dot in the
 * payload — `4.5.0` was published as `4~5~0` — and nothing in the output
 * said redaction had done it. A corrupted diagnostic is worse than a verbose
 * one, because the reader cannot tell it is corrupt.
 *
 * The corpus is real `runDoctor` output captured against a throwaway
 * MEMESH_DIR, plus the diagnostic shapes this project's own evidence
 * artifacts carry. Any new pattern must leave every byte of it alone.
 */
describe('redactSecrets does not corrupt diagnostics', () => {
  const corpus = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/redaction-negative-corpus.json'),
      'utf8',
    ),
  ) as { doctorOutput: string; mustSurvive: string[] };

  it('leaves a real doctor payload byte-identical', () => {
    expect(corpus.doctorOutput.length).toBeGreaterThan(1000);
    expect(redactSecrets(corpus.doctorOutput)).toBe(corpus.doctorOutput);
  });

  it.each(corpus.mustSurvive.map((line) => [line.slice(0, 48), line]))(
    'leaves %s… untouched',
    (_label, line) => {
      expect(redactSecrets(line)).toBe(line);
    },
  );

  it('keeps the parameter name when the value is a credential', () => {
    // `?limit=200` must survive: the pattern matches the NAME, so an
    // ordinary query parameter is not collateral.
    const url = 'GET https://api.openai.com/v1/models?limit=200&api_key=A1b2C3d4E5f6G7h8I9j0';
    const out = redactSecrets(url);
    expect(out).toContain('limit=200');
    expect(out).not.toContain('A1b2C3d4E5f6G7h8I9j0');
  });

  it('ends a masked-key match on an alphanumeric, leaving sentence punctuation', () => {
    // `sk[-_]\S{4,}[A-Za-z0-9]` must not swallow the full stop, or the
    // redacted sentence loses its boundary and reads as one run-on.
    const out = redactSecrets('Incorrect API key provided: sk-proj-****ZfQ9. Find it at platform.openai.com.');
    expect(out).toContain('***REDACTED***. Find it at');
  });
});

/**
 * The pattern list has a THIRD consumer that the egress tests never exercised:
 * `containsSecret()` in transcript-extractor, which is a DROP gate — a mined
 * memory that trips it is discarded rather than staged. A pattern that is
 * merely noisy at the egress silently destroys content there.
 *
 * That is not hypothetical. `sk[-_]\S{4,}` without a word boundary matched
 * inside `task-runner`, `disk-usage`, `risk-level` and `ask-first`: six
 * ordinary English phrases, every one of them redacted at the egress and
 * dropped on the way in. The corpus above only asserted `redactSecrets`, so
 * it could not see the drop.
 */
describe('the pattern list is safe for the transcript drop gate too', () => {
  const corpusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/redaction-negative-corpus.json');
  const negatives = (JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as { mustSurvive: string[] }).mustSurvive;

  it.each(negatives.map((line) => [line.slice(0, 44), line]))(
    'does not drop %s…',
    (_label, line) => {
      expect(containsSecret(line)).toBe(false);
      expect(scrubSecrets(line)).toBe(line);
    },
  );

  it('still drops and scrubs a real credential', () => {
    const secret = 'sk-ant-' + 'a1B2'.repeat(6);
    expect(containsSecret(`context ${secret} context`)).toBe(true);
    expect(scrubSecrets(`context ${secret} context`)).not.toContain(secret);
  });

  it('requires a word boundary before the key prefix', () => {
    // Removing the leading \b makes every one of these true.
    for (const word of ['task-runner-v2', 'disk-usage-report', 'risk-level-high']) {
      expect(containsSecret(word)).toBe(false);
    }
    expect(containsSecret('sk-proj-**********ZfQ9')).toBe(true);
  });
});
