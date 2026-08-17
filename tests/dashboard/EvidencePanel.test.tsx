// @vitest-environment happy-dom
//
// The drill-down's four states, which the contract suite delegates here.
// Three of them are failure-adjacent and mean different things to a reader:
// "still loading", "loaded and there is genuinely nothing linked yet", and
// "could not load". Collapsing the middle one into either neighbour is the
// defect this file exists to prevent — an empty panel that actually failed
// tells the user their work has no evidence, which is a lie.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { EvidencePanel } from '../../dashboard/src/components/EvidencePanel';
import type { Entity } from '../../dashboard/src/lib/api';
import * as api from '../../dashboard/src/lib/api';

afterEach(() => { vi.restoreAllMocks(); });

function entity(name: string, overrides: Partial<Entity> = {}): Entity {
  return {
    id: 1,
    name,
    type: 'commit',
    created_at: '2026-08-16T00:00:00.000Z',
    observations: ['did a thing'],
    tags: [],
    ...overrides,
  };
}

describe('EvidencePanel', () => {
  it('says it is loading before the answer arrives', () => {
    vi.spyOn(api, 'fetchNodeEvidence').mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <EvidencePanel node="d1" nodeTitle="A decision" onClose={() => {}} />,
    );
    expect(container.textContent).toMatch(/Loading evidence|載入證據/i);
  });

  it('an empty result names the command that draws the links — it does not read as "no evidence exists"', async () => {
    vi.spyOn(api, 'fetchNodeEvidence').mockResolvedValue({
      entities: [], relations: [], truncated: false,
    });
    const { container } = render(
      <EvidencePanel node="d1" nodeTitle="A decision" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(container.textContent).toMatch(/kg backfill/);
    });
    // And it must not be mistaken for the failure state.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a failure is an alert, never an empty list', async () => {
    vi.spyOn(api, 'fetchNodeEvidence').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <EvidencePanel node="d1" nodeTitle="A decision" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    // The empty-state copy must NOT be what a failed load shows.
    expect(container.textContent).not.toMatch(/kg backfill/);
  });

  it('lists the evidence and surfaces truncation rather than swallowing it', async () => {
    vi.spyOn(api, 'fetchNodeEvidence').mockResolvedValue({
      entities: [entity('commit-abc'), entity('insight-1', { type: 'session-insight' })],
      relations: [
        { from: 'commit-abc', to: 'd1', type: 'evidences' },
        { from: 'insight-1', to: 'd1', type: 'evidences' },
      ],
      truncated: true,
    });
    const { container } = render(
      <EvidencePanel node="d1" nodeTitle="A decision" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('li')).toHaveLength(2);
    });
    // "more exist" is the honesty half — a full window that says nothing is
    // indistinguishable from a complete answer.
    expect(container.textContent).toMatch(/more exist|還有更多/i);
  });

  it('refetches when the selected node changes', async () => {
    const spy = vi.spyOn(api, 'fetchNodeEvidence').mockResolvedValue({
      entities: [], relations: [], truncated: false,
    });
    const { rerender } = render(
      <EvidencePanel node="d1" nodeTitle="One" onClose={() => {}} />,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledWith('d1'));
    rerender(<EvidencePanel node="d2" nodeTitle="Two" onClose={() => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('d2'));
  });
});
