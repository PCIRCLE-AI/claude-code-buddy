// @vitest-environment happy-dom
//
// Rejecting a dream proposal is one click and permanent.
//
// The dreamer deliberately never re-proposes a rejected cluster — that is
// what the status is for (`dreamer.ts:226`) — and no surface offers an
// un-reject. So a mis-click on a ghost-styled button next to the primary
// action destroys a digest the user paid an LLM call to produce, silently.
//
// The sibling irreversible action in this dashboard, `OnboardingBanner`'s
// demo reset, already asks first. Accept deliberately does not: an accepted
// memory can be forgotten.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';

const PROPOSAL = {
  id: 7,
  kind: 'digest',
  status: 'pending',
  title: 'a proposed digest',
  content: 'the digest body',
  source_ids: [1, 2],
  created_at: '2026-08-24T00:00:00Z',
};

/** Answer the tab's own GETs; record every POST it attempts. */
function stubApi(posts: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') posts.push(url);
    // `api()` unwraps to `json.data`, and the proposals route answers with
    // the array itself. `/v1/config` wants an object; both land here, and
    // only the proposals shape has to be right for this file.
    const data = url.includes('/v1/dream/proposals') ? [PROPOSAL] : { capabilities: {} };
    return Promise.resolve(
      new Response(
        JSON.stringify({ success: true, data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });
}

async function renderWithProposal(posts: string[]) {
  stubApi(posts);
  const view = render(<InsightsTab />);
  // Wait for the row itself, not for its title: the card renders the
  // proposal id and its actions, and the title only appears once expanded.
  await waitFor(() => {
    expect(view.container.textContent ?? '', 'the proposal row never rendered').toContain('#7');
    rejectButton(view.container);
  });
  return view;
}

function rejectButton(container: Element): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button')) as unknown as HTMLButtonElement[];
  // The reject button is the ghost one carrying the danger colour, next to
  // the primary accept.
  const found = buttons.find((b) => (b.getAttribute('style') ?? '').includes('--danger'));
  if (!found) throw new Error('fixture: no reject button rendered');
  return found;
}

// happy-dom does not implement `confirm`, so there is nothing to spy on —
// it has to be installed. Which is also the honest shape of the test: the
// component calls the bare global, exactly as a browser provides it.
const savedConfirm = (globalThis as { confirm?: unknown }).confirm;

function answerConfirm(value: boolean): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() => value);
  (globalThis as unknown as { confirm: unknown }).confirm = stub;
  return stub;
}

describe('rejecting a proposal asks first', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { confirm: unknown }).confirm = savedConfirm;
  });

  it('sends nothing when the user cancels', async () => {
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    answerConfirm(false);

    fireEvent.click(rejectButton(container));
    // Give any in-flight promise a turn to land before asserting absence.
    await new Promise((r) => setTimeout(r, 0));

    expect(posts, 'a cancelled reject still called the server').toEqual([]);
  });

  it('sends the reject when the user confirms — the anti-vacuity half', async () => {
    // Without this, a reject handler that returned unconditionally would
    // satisfy the test above perfectly.
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    answerConfirm(true);

    fireEvent.click(rejectButton(container));

    await waitFor(() => {
      expect(posts.some((u) => u.includes('/v1/dream/proposals/7/reject'))).toBe(true);
    });
  });

  it('does not ask before accepting — accept is reversible', async () => {
    const posts: string[] = [];
    const { container } = await renderWithProposal(posts);
    const confirmSpy = answerConfirm(true);

    const accept = Array.from(container.querySelectorAll('button.btn-primary')) as unknown as HTMLButtonElement[];
    const acceptButton = accept.find((b) => !(b.getAttribute('style') ?? '').includes('--danger'));
    expect(acceptButton, 'fixture: no accept button rendered').toBeDefined();
    fireEvent.click(acceptButton!);

    await waitFor(() => {
      expect(posts.some((u) => u.includes('/v1/dream/proposals/7/accept'))).toBe(true);
    });
    expect(confirmSpy, 'accept grew a confirmation it should not have').not.toHaveBeenCalled();
  });
});
