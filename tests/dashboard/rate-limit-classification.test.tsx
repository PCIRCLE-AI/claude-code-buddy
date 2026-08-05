// @vitest-environment happy-dom
//
// The regression PR #131 fixed: a 429 from the rate limiter was reaching the
// load paths as a generic error and being mislabelled "the dashboard and
// server are out of sync — run doctor". The fix is a dedicated RateLimitError
// (thrown by api() on any 429, envelope or bare string) that classifyLoadError
// maps to its own 'ratelimited' kind. These lock BOTH halves so the mislabel
// cannot silently come back.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { api, RateLimitError } from '../../dashboard/src/lib/api';
import { classifyLoadError, failureMessage } from '../../dashboard/src/lib/failure';
import { t } from '../../dashboard/src/lib/i18n';

afterEach(() => vi.restoreAllMocks());

function response(status: number, body: string, contentType?: string): Response {
  return new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : undefined,
  });
}

describe('429 rate-limit classification (dashboard)', () => {
  it('api() throws RateLimitError on a 429 carrying the JSON envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        429,
        JSON.stringify({ success: false, errorCode: 'rate.limited', error: 'Too many requests' }),
        'application/json',
      ),
    );
    await expect(api('GET', '/v1/proposals')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('api() throws RateLimitError on a 429 with a BARE string body (default limiter)', async () => {
    // express-rate-limit's default body is a bare string, not an envelope; the
    // 429 branch fires before any body parse, so this must still be a RateLimitError.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(429, 'Too many requests, please try again later.'));
    await expect(api('GET', '/v1/proposals')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('classifyLoadError maps RateLimitError to "ratelimited", NOT "unreadable"', () => {
    // Break-test: delete the `if (err instanceof RateLimitError)` line in
    // failure.ts and this flips to 'unreadable' — the exact mislabel bug.
    expect(classifyLoadError(new RateLimitError(t('httpError.rate.limited')))).toBe('ratelimited');
    expect(classifyLoadError(new RateLimitError(t('httpError.rate.limited')))).not.toBe('unreadable');
  });

  it('the ratelimited message is the slow-down text, not the version-skew text', () => {
    const msg = failureMessage('ratelimited');
    expect(msg).toBe(t('httpError.rate.limited'));
    expect(msg).not.toBe(failureMessage('unreadable')); // must not read as "out of sync"
  });
});
