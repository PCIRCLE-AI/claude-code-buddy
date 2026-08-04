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

const quietCheck = {
  id: 'hook-activity',
  label: 'Hook activity (last 24h)',
  status: 'warn' as const,
  summary: 'memesh has not saved anything automatically in the last 24 hours. (raw English from server)',
  fix: 'Do a normal Claude Code work session, then check again.',
  code: 'hook-activity.quiet',
};

describe('doctor banner i18n', () => {
  it('renders a coded check in the active locale, not the server English', () => {
    setLocale('zh-TW');
    expect(trSummary(quietCheck)).toBe(t('doctor.msg.hook-activity.quiet.summary'));
    expect(trSummary(quietCheck)).not.toContain('raw English from server');
    expect(trFix(quietCheck)).toBe(t('doctor.msg.hook-activity.quiet.fix'));
    expect(trLabel(quietCheck)).toBe(t('doctor.label.hook-activity'));
    // The translation must actually be Chinese, not a fallthrough.
    expect(trSummary(quietCheck)).toMatch(/[一-鿿]/);
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
    const c = { ...quietCheck, code: 'not-a-real.code' };
    expect(trSummary(c)).toBe(quietCheck.summary);
  });

  it('falls back to raw text when the check carries no code at all', () => {
    setLocale('zh-TW');
    const c = { ...quietCheck, code: undefined };
    expect(trSummary(c)).toBe(quietCheck.summary);
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
      'hook-activity.quiet',
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

  it('legacy warn without code still requires a real fix hint', () => {
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's' })).toBe(false);
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's', fix: 'No action needed' })).toBe(false);
    expect(isBannerWorthy({ id: 'x', label: 'x', status: 'warn' as const, summary: 's', fix: 'Run `memesh reindex`.' })).toBe(true);
  });
});
