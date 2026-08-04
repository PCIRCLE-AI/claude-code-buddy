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

const emptyHealth: HealthData = { status: 'ok', version: 'test', entity_count: 0 };
const populatedHealth: HealthData = { status: 'ok', version: 'test', entity_count: 30 };

describe('OnboardingBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the GUI seed button when the store is empty', () => {
    const { container } = render(<OnboardingBanner health={emptyHealth} />);
    // Primary affordance: a real button, not a code chip.
    const buttons = Array.from(container.querySelectorAll('button.btn-primary'));
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent ?? '').toMatch(/demo|示範|示范|डेमो|デモ|투어|démo|demo/i);
  });

  it('hides itself once entity_count climbs above zero', () => {
    const { container } = render(<OnboardingBanner health={populatedHealth} />);
    expect(container.querySelector('button.btn-primary')).toBeNull();
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
