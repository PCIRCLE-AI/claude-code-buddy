// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { FeedbackWidget } from '../../dashboard/src/components/FeedbackWidget';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openAndFill(description: string) {
  const rendered = render(<FeedbackWidget health={null} />);
  fireEvent.click(rendered.container.querySelector('.fb-btn')!);
  const textarea = rendered.container.querySelector('.fb-desc') as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: description } });
  return { ...rendered, textarea };
}

describe('FeedbackWidget GitHub handoff', () => {
  it('preserves the dialog and draft and offers retry plus copy when the popup is blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const draft = 'The full draft must survive a blocked popup.';
    const { container, getByRole, getByText, textarea } = openAndFill(draft);

    fireEvent.click(container.querySelector('.fb-submit')!);

    const alert = await waitFor(() => getByRole('alert'));
    expect(alert.textContent).toMatch(/GitHub/);
    expect(container.querySelector('.fb-panel')).not.toBeNull();
    expect(textarea.value).toBe(draft);
    expect(open).toHaveBeenCalledTimes(1);

    const preparedUrl = open.mock.calls[0]![0] as string;
    const retry = getByText(/再次嘗試開啟 GitHub|Try opening GitHub again/) as HTMLAnchorElement;
    expect(retry.href).toBe(preparedUrl);
    fireEvent.click(getByText(/複製 GitHub 連結|Copy GitHub link/));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(preparedUrl));
    getByText(/已複製連結|Link copied/);
  });

  it('closes and clears only after the browser returns a handoff handle', async () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const { container, getByRole } = openAndFill('Open this prepared composer.');
    expect(getByRole('dialog').textContent).toMatch(/GitHub/);

    fireEvent.click(container.querySelector('.fb-submit')!);

    await waitFor(() => expect(container.querySelector('.fb-panel')).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatch(/^https:\/\/github\.com\/PCIRCLE-AI\/memesh\/issues\/new\?/);
    expect(opened.opener).toBeNull();

    fireEvent.click(container.querySelector('.fb-btn')!);
    expect((container.querySelector('.fb-desc') as HTMLTextAreaElement).value).toBe('');
    expect(container.textContent).not.toMatch(/issue (created|submitted)|已建立 issue|已送出 issue/i);
  });
});
