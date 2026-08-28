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
