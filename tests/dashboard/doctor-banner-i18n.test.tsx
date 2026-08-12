// @vitest-environment happy-dom
/**
 * The doctor banner translates server-sent checks by MESSAGE CODE, falling
 * back to the server's raw English only when a code has no catalogue entry.
 * This is the regression pin for the exact defect a zh-TW user reported:
 * banner title in Chinese, body in raw English jargon ("agentic-loop
 * guard", "user_interrupt"). Removing the code-based lookup, the params
 * interpolation, or the catalogue entries turns these red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, t } from '../../dashboard/src/lib/i18n';
import { trSummary, trFix, trLabel, isBannerWorthy } from '../../dashboard/src/components/DoctorBanner';

afterEach(() => setLocale('en'));

const codedCheck = {
  id: 'hook-activity',
  label: 'Hook activity',
  status: 'fail' as const,
  summary: 'The last capture hook ran 4 days ago. (raw English from server)',
  fix: 'Restart your agent, end one session, then run memesh doctor again.',
  code: 'hook-activity.stale',
};

describe('doctor banner i18n', () => {
  it('renders a coded check in the active locale, not the server English', () => {
    setLocale('zh-TW');
    expect(trSummary(codedCheck)).toBe(t('doctor.msg.hook-activity.stale.summary'));
    expect(trSummary(codedCheck)).not.toContain('raw English from server');
    expect(trFix(codedCheck)).toBe(t('doctor.msg.hook-activity.stale.fix'));
    expect(trLabel(codedCheck)).toBe(t('doctor.label.hook-activity'));
    // The translation must actually be Chinese, not a fallthrough.
    expect(trSummary(codedCheck)).toMatch(/[一-鿿]/);
  });

  it('interpolates params into the translated message', () => {
    setLocale('zh-TW');
    const c = {
      id: 'update-status',
      label: 'Update status',
      status: 'warn' as const,
      summary: 'Update available: 9.9.9 (current: 1.0.0)',
      fix: "Run 'memesh update' to upgrade",
      code: 'update-status.update-available',
      params: { latest: '9.9.9', current: '1.0.0' },
    };
    const s = trSummary(c);
    expect(s).toContain('9.9.9');
    expect(s).toContain('1.0.0');
    expect(s).not.toContain('{latest}');
  });

  it('falls back to the raw server text for an unknown code — nothing invented, nothing hidden', () => {
    setLocale('zh-TW');
    const c = { ...codedCheck, code: 'not-a-real.code' };
    expect(trSummary(c)).toBe(codedCheck.summary);
  });

  it('falls back to raw text when the check carries no code at all', () => {
    setLocale('zh-TW');
    const c = { ...codedCheck, code: undefined };
    expect(trSummary(c)).toBe(codedCheck.summary);
  });
});

describe('doctor banner: silence when nothing is wrong', () => {
  // 使用者原話：「既然沒更新就不要出聲，有更新才通知，沒更新也顯示一個
  // 訊息幹嘛？」 A "no news" report must never interrupt.
  const warn = (code: string) => ({
    id: code.split('.')[0],
    label: 'x',
    status: 'warn' as const,
    summary: 's',
    fix: 'do something',
    code,
  });

  it('suppresses every "nothing is wrong yet" warn from the banner', () => {
    for (const code of [
      'update-status.no-cache',
      'update-status.stale',
      'update-status.deprecation-unknown',
      'shell-cli.not-on-path',
      'skills-manifest.missing-dev',
      'install-channel.unknown',
      'http-probe.no-server',
    ]) {
      expect(isBannerWorthy(warn(code)), `${code} must stay quiet`).toBe(false);
    }
  });

  it('still surfaces action-needed warns and every FAIL', () => {
    expect(isBannerWorthy(warn('update-status.update-available'))).toBe(true);
    expect(isBannerWorthy(warn('embeddings.threw'))).toBe(true);
    expect(isBannerWorthy(warn('hook-wiring.no-marker'))).toBe(true);
    expect(isBannerWorthy({ ...warn('update-status.no-cache'), status: 'fail' as const })).toBe(true);
    expect(isBannerWorthy({ id: 'database', label: 'x', status: 'fail' as const, summary: 's', code: 'database.broken' })).toBe(true);
  });

  it('a dead capture loop reaches the banner — it used to be the one thing suppressed', () => {
    // `hook-activity.quiet` sat in QUIET_WARN_CODES, so the single signal that
    // automatic capture might have stopped was the single signal a dashboard
    // user could never see. It was suppressed for a defensible reason — the
    // old check could not tell a quiet day from a dead loop — and the fix is
    // that the check no longer has to guess, not that the banner shouts more.
    for (const code of ['hook-activity.never-ran', 'hook-activity.stale', 'hook-activity.query-failed']) {
      const check = { id: 'hook-activity', label: 'x', status: 'fail' as const, summary: 's', fix: 'do something', code };
      expect(isBannerWorthy(check), `${code} must reach the user`).toBe(true);
    }
  });

  it('legacy warn without code still requires a real fix hint', () => {
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's' })).toBe(false);
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's', fix: 'No action needed' })).toBe(false);
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's', fix: 'Run `memesh reindex`.' })).toBe(true);
  });
});
