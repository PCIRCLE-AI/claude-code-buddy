// @vitest-environment happy-dom
//
// SPEC-4 OnboardingBanner — guards the regressions Codex flagged on
// the GUI rework: visibility gating, the runSeed() pending-state
// stuck-loading bug, and the accessibility regression on the error
// surface. The state machine is the only logic worth testing here;
// styling decisions are visual-review territory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { OnboardingBanner } from '../../dashboard/src/components/OnboardingBanner';
import type { HealthData } from '../../dashboard/src/lib/api';
import { getLocale, setLocale } from '../../dashboard/src/lib/i18n';

const emptyHealth: HealthData = { status: 'ok', version: 'test', entity_count: 0 };
const populatedHealth: HealthData = { status: 'ok', version: 'test', entity_count: 30 };
const populatedDemoHealth: HealthData = {
  status: 'ok',
  version: 'test',
  entity_count: 31,
  demo_entity_count: 30,
};

describe('OnboardingBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the GUI seed button when the store is empty', () => {
    const { container } = render(<OnboardingBanner health={emptyHealth} />);
    // Primary affordance: a real button, not a code chip.
    const buttons = Array.from(container.querySelectorAll('button.btn-primary'));
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent ?? '').toMatch(/demo|示範|示范|डेमो|デモ|투어|démo|demo/i);
  });

  it('separates the LLM-free core, semantic indexing, and LLM-assisted organization', () => {
    const previousLocale = getLocale();
    setLocale('en');
    try {
      const { container } = render(<OnboardingBanner health={emptyHealth} />);
      const capabilityItems = Array.from(container.querySelectorAll('ul li'))
        .map((item) => item.textContent ?? '');
      expect(capabilityItems).toHaveLength(3);
      expect(capabilityItems[0]).toMatch(/Without an LLM.*FTS5.*hooks.*Dashboard/i);
      expect(capabilityItems[1]).toMatch(/With an embedder.*semantic indexing.*meaning-based recall/i);
      expect(capabilityItems[2]).toMatch(/With an LLM.*weekly digest.*pattern\/conflict.*validation.*lesson\/tag.*telemetry/i);
      expect(capabilityItems.join(' ')).not.toMatch(/everything.*FTS5 alone|LLM.*only.*lesson/i);
    } finally {
      setLocale(previousLocale);
    }
  });

  it('hides itself once entity_count climbs above zero', () => {
    const { container } = render(<OnboardingBanner health={populatedHealth} />);
    expect(container.querySelector('button.btn-primary')).toBeNull();
  });

  it('keeps a demo-only cleanup action visible after the populated library reloads', () => {
    const { container, getByRole } = render(<OnboardingBanner health={populatedDemoHealth} />);
    getByRole('region', { name: /Demo data|示範資料|示范数据|デモデータ|데모 데이터/i });
    expect(container.textContent).toContain('30');
    expect(container.querySelector('button.btn')).not.toBeNull();
    expect(container.querySelector('button.btn-primary')).toBeNull();
  });

  it('confirms scope and recovery, reads back reset, then broadcasts refresh', async () => {
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpy);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { inserted: 0, removed: 30 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { status: 'ok', version: 'test', entity_count: 1, demo_entity_count: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const changed = vi.fn();
    window.addEventListener('memesh:data-changed', changed);
    try {
      const { container } = render(<OnboardingBanner health={populatedDemoHealth} />);
      fireEvent.click(container.querySelector('button.btn')!);

      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(['/v1/demo/reset', '/v1/health']);
      const confirmation = String(confirmSpy.mock.calls[0]?.[0]);
      expect(confirmation).toContain('metadata.demo');
      expect(confirmation).toMatch(/restore|還原|还原|復元|복원|restaur|wiederher|khôi phục|กู้คืน/i);
      expect(confirmation).toMatch(/real|真實|真实|実際|실제|reais|réelles|echte|thật|ความทรงจำจริง/i);
    } finally {
      window.removeEventListener('memesh:data-changed', changed);
    }
  });

  it('keeps cleanup visible and reports an error when reset fails', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('reset unavailable'));
    const changed = vi.fn();
    window.addEventListener('memesh:data-changed', changed);
    try {
      const { container } = render(<OnboardingBanner health={populatedDemoHealth} />);
      fireEvent.click(container.querySelector('button.btn')!);

      await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
      expect(container.querySelector('button.btn')).not.toBeNull();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('memesh:data-changed', changed);
    }
  });

  it('withholds refresh when reset readback still reports demo memories', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { inserted: 0, removed: 30 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: populatedDemoHealth,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const changed = vi.fn();
    window.addEventListener('memesh:data-changed', changed);
    try {
      const { container } = render(<OnboardingBanner health={populatedDemoHealth} />);
      fireEvent.click(container.querySelector('button.btn')!);

      await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
      expect(container.querySelector('button.btn')).not.toBeNull();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('memesh:data-changed', changed);
    }
  });

  it('hides itself when the user has previously dismissed it', () => {
    localStorage.setItem('memesh.onboardingDismissed', 'true');
    const { container } = render(<OnboardingBanner health={emptyHealth} />);
    expect(container.querySelector('button.btn-primary')).toBeNull();
  });

  it('clears the pending state in a finally block so the buttons re-enable on success', async () => {
    // Simulate the slow /v1/health refetch case: seed POST resolves,
    // banner does NOT auto-unmount (because we keep entity_count = 0).
    // The button must still go from disabled back to enabled.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { inserted: 30, removed: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const { container } = render(<OnboardingBanner health={emptyHealth} />);
    const btn = container.querySelector('button.btn-primary') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);

    // Mid-flight the button is disabled.
    expect(btn.disabled).toBe(true);

    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    expect(fetchSpy).toHaveBeenCalledWith('/v1/demo/seed', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces seed failures in a live alert for screen readers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { container } = render(<OnboardingBanner health={emptyHealth} />);
    const btn = container.querySelector('button.btn-primary') as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      // role="alert" already implies aria-live="assertive"; the explicit
      // aria-live="polite" it once carried CONTRADICTED that implicit
      // level, so screen readers got two different politeness answers.
      // The role alone is the contract now.
      expect(alert!.hasAttribute('aria-live')).toBe(false);
      expect((alert!.textContent ?? '').length).toBeGreaterThan(0);
    });
  });
});
