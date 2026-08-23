// @vitest-environment happy-dom
//
// `PmAnalyticsPanel` rendered `null` for three different outcomes: a failed
// request, a request still in flight, and a reply this bundle cannot read.
// All three looked like an absence — the card simply was not there — so the
// user could not tell "still loading" from "the server is down" from "your
// dashboard is older than your server", and there was nothing to click,
// retry or report.
//
// The sibling on the same tab (`AnalyticsTab`) already renders a spinner and
// an `role="alert"` box for exactly these cases. This panel does now too.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { PmAnalyticsPanel } from '../../dashboard/src/components/PmAnalyticsPanel';

const GOOD = {
  velocity: { decisionsPerWeek: 1.5, releasesPerMonth: 2, windowDays: 30 },
  staleness: { stalePlanCount: 0, openDecisionCount: 3 },
  connectedness: { orphanRate: 0.2, totalRelations: 40, activeEntities: 100 },
};

function stubFetch(impl: () => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

function jsonReply(data: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('PmAnalyticsPanel tells its three states apart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the numbers when the payload is good — the anti-vacuity half', async () => {
    // First, because everything below is about failure states and this is
    // the one that says the panel renders at all.
    stubFetch(() => jsonReply(GOOD));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      expect(container.textContent ?? '').toContain('1.5');
    });
    expect(container.querySelector('[role="alert"]'), 'a good payload showed an error').toBeNull();
  });

  it('shows a spinner while the request is in flight', () => {
    // Never resolves: the panel must show SOMETHING in the meantime.
    stubFetch(() => new Promise<Response>(() => { /* pending forever */ }));
    const { container } = render(<PmAnalyticsPanel />);

    expect(container.querySelector('.loading'), 'nothing rendered while loading').not.toBeNull();
  });

  it('announces a failed request instead of vanishing', async () => {
    stubFetch(() => Promise.reject(new Error('Failed to fetch')));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'a failed request rendered nothing at all').not.toBeNull();
      expect(alert?.textContent ?? '').not.toBe('');
    });
  });

  it('announces a reply it cannot read, which is a different problem', async () => {
    // The request SUCCEEDED. Reporting this as an outage would send the user
    // to check a server that is working; the real cause is version skew
    // between the page and the server, and the remedy is a reload.
    stubFetch(() => jsonReply({ velocity: {}, staleness: {}, connectedness: {} }));
    const { container } = render(<PmAnalyticsPanel />);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'an unreadable payload rendered nothing at all').not.toBeNull();
      expect(alert?.textContent ?? '', 'the message does not mention reloading')
        .toMatch(/[Rr]eload|重新整理|刷新/);
    });
  });
});
