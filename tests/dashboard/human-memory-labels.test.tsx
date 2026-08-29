// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { MemoryRow } from '../../dashboard/src/components/MemoryRow';
import { ExpandedBody } from '../../dashboard/src/components/LessonCards';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { ProjectRoadmap } from '../../dashboard/src/components/ProjectRoadmap';
import { setLocale } from '../../dashboard/src/lib/i18n';
import type { Entity } from '../../dashboard/src/lib/api';

function entity(id: number, type: string, name: string, title: string | null, observation: string): Entity {
  return {
    id,
    type,
    name,
    title,
    created_at: '2026-08-29T00:00:00.000Z',
    observations: [observation],
    tags: ['project:memesh'],
    access_count: 0,
  };
}

const REPRESENTATIVE = [
  entity(1, 'decision', 'decision-auth-strategy-v2', 'Use passkeys for new accounts', 'Decision evidence and alternatives remain available here.'),
  entity(2, 'lesson_learned', 'lesson-pipefail-0192', 'Preserve the failing command exit code', 'The pipe hid the original command failure and delayed diagnosis.'),
  entity(3, 'pattern', 'pattern-review-loop-22', null, 'Repeated review findings show that readback must follow every persisted setting change.'),
  entity(4, 'commit', 'commit-a1b2c3d', 'fix(settings): retain the tested draft', 'Diff stats: 3 files changed, 42 insertions.'),
  entity(5, 'session_keypoint', 'session-019d-internal-key', null, 'Verified the complete settings journey in a clean browser session with persisted readback.'),
];

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('en');
  localStorage.clear();
});

describe('issue #233 — human-first memory labels', () => {
  it('gives all five representative entity types a source-supported primary label', () => {
    for (const memory of REPRESENTATIVE) {
      const view = render(<MemoryRow entity={memory} />);
      const headline = view.container.querySelector('.mem-preview')?.textContent ?? '';
      expect(headline).not.toContain(memory.name);
      expect(headline).toBe(memory.title ?? memory.observations[0]);
      view.unmount();
    }
  });

  it('keeps canonical name, raw type, and full observations in secondary details', () => {
    const memory = REPRESENTATIVE[4];
    const view = render(<ExpandedBody entity={memory} />);
    expect(view.container.textContent).toContain(memory.observations[0]);
    fireEvent.click(view.getByText('Technical details'));
    expect(view.container.textContent).toContain(memory.name);
    expect(view.container.textContent).toContain(memory.type);
  });

  it('uses the readable decision title in Project and reveals exact identity only after expansion', () => {
    const decision = REPRESENTATIVE[0];
    const view = render(<ProjectRoadmap projectName="memesh" entities={[decision]} />);
    fireEvent.click(view.getByRole('tab', { name: /Decisions/ }));
    const card = view.getByRole('button', { name: /Use passkeys for new accounts/ });
    expect(view.container.textContent).not.toContain(decision.name);
    fireEvent.click(card);
    fireEvent.click(view.getByText('Technical details'));
    expect(view.container.textContent).toContain(decision.name);
    expect(view.container.textContent).toContain(decision.type);
    expect(view.container.textContent).toContain(decision.observations[0]);
  });

  it('still filters by canonical name without promoting it to the visible headline', async () => {
    const decision = REPRESENTATIVE[0];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      return String(input).startsWith('/v1/entities') ? response([decision]) : response([]);
    });
    const view = render(<MemoriesTab />);
    await waitFor(() => expect(view.container.textContent).toContain(decision.title));
    const search = view.getByRole('searchbox');
    fireEvent.input(search, { target: { value: decision.name } });
    expect(view.container.querySelector('.mem-preview')?.textContent).toContain(decision.title);
    expect(view.container.textContent).not.toContain(decision.name);
  });
});
