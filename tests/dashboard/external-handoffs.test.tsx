// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { TerminalHandoff } from '../../dashboard/src/components/ExternalHandoff';
import { DASHBOARD_EXTERNAL_HANDOFFS, openExternalWindow } from '../../dashboard/src/lib/external-handoffs';
import { setLocale, t } from '../../dashboard/src/lib/i18n';
import { HttpError } from '../../dashboard/src/lib/api';
import { actionFailureMessage, failureMessage } from '../../dashboard/src/lib/failure';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('issue #235 — explicit external handoffs', () => {
  it('keeps one authoritative inventory whose IDs are rendered by their declared surfaces', () => {
    expect(new Set(DASHBOARD_EXTERNAL_HANDOFFS.map(item => item.id)).size).toBe(DASHBOARD_EXTERNAL_HANDOFFS.length);
    for (const item of DASHBOARD_EXTERNAL_HANDOFFS) {
      const relative = item.surface === 'failure' || item.surface === 'api'
        ? `dashboard/src/lib/${item.surface}.ts`
        : `dashboard/src/components/${item.surface}.tsx`;
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      if (item.surface === 'failure' || item.surface === 'api') expect(source, item.id).toContain("t('handoff.terminal')");
      else expect(source, item.id).toContain(`id="${item.id}"`);
    }
    const componentSource = fs.readdirSync(path.join(root, 'dashboard/src/components'))
      .filter(name => name.endsWith('.tsx'))
      .map(name => fs.readFileSync(path.join(root, 'dashboard/src/components', name), 'utf8'))
      .join('\n');
    expect(componentSource).not.toContain('window.open(');
  });

  it('labels a Terminal prerequisite before the copy action and copies without executing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = render(<TerminalHandoff id="settings-update" command="memesh update" />);

    expect(view.container.textContent).toContain(t('handoff.terminal'));
    expect(view.container.textContent).toContain(t('handoff.terminalPrereq'));
    fireEvent.click(view.getByRole('button', { name: t('handoff.copyCommand') }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('memesh update'));
    expect(view.container.textContent).toContain(t('handoff.commandCopied'));
  });

  it('keeps Doctor diagnostics available when GitHub is blocked and exposes retry plus copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      status: 'FAIL',
      checks: [{ id: 'llm', label: 'LLM', status: 'fail', summary: 'Provider unavailable', fix: 'Run `memesh doctor --probe`.' }],
    }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = render(<DoctorBanner />);

    const help = await view.findByRole('button', { name: t('doctorBanner.getHelp') });
    expect(view.container.textContent).toContain(t('handoff.github'));
    expect(view.container.textContent).toContain(t('handoff.terminal'));
    fireEvent.click(help);
    await waitFor(() => expect(view.container.textContent).toContain(t('feedback.popupBlocked')));
    const prepared = open.mock.calls[0]![0] as string;
    const retry = view.getByRole('link', { name: t('feedback.retry') }) as HTMLAnchorElement;
    expect(retry.href).toBe(prepared);
    fireEvent.click(view.getByRole('button', { name: t('feedback.copyLink') }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prepared));
    expect(view.container.textContent).not.toMatch(/issue (created|submitted)/i);
  });

  it('reports successful GitHub launch only when a window handle exists', () => {
    const opened = { opener: window } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(opened);
    expect(openExternalWindow('https://github.com/PCIRCLE-AI/memesh/issues/new')).toBe(true);
    expect(opened.opener).toBeNull();
  });
});

describe('issue #235 — the Terminal label follows the primary action', () => {
  // The first cut of #235 labelled any message that merely MENTIONED a
  // `memesh …` command. Two of those messages tell the user to reload or
  // retry in the browser and only escalate to a command if that fails, so
  // the label announced a prerequisite that does not exist.
  const label = () => `${t('handoff.terminal')}:`;

  it('labels the unreachable load, whose only action is in a terminal', () => {
    expect(failureMessage('unreachable')).toContain(label());
    expect(failureMessage('unreachable')).toContain(t('common.serverUnreachableAction'));
  });

  it('does not label the unreadable load, whose action is reloading the page', () => {
    expect(failureMessage('unreadable')).not.toContain(label());
    expect(failureMessage('unreadable')).toContain(t('common.responseUnreadableAction'));
  });

  it('does not label an envelope-less HttpError, whose action is retrying', () => {
    expect(actionFailureMessage(new HttpError(502))).not.toContain(label());
    expect(actionFailureMessage(new HttpError(502))).toBe(t('common.serverError', { status: 502 }));
  });

  it('holds in a non-English locale, where the label is a different string', () => {
    setLocale('zh-TW');
    try {
      expect(failureMessage('unreachable')).toContain(label());
      expect(failureMessage('unreadable')).not.toContain(label());
      expect(actionFailureMessage(new HttpError(502))).not.toContain(label());
    } finally {
      setLocale('en');
    }
  });
});
