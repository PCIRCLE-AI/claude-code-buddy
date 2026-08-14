// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { ProjectRoadmap } from '../../dashboard/src/components/ProjectRoadmap';
import type { Entity } from '../../dashboard/src/lib/api';

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: Math.floor(Math.random() * 100000),
    name: 'x',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['test obs'],
    tags: [],
    ...overrides,
  };
}

describe('ProjectRoadmap — SPEC-9 v0/v1 acceptance criteria', () => {
  it('renders the header band with project name and entity count (v0 AC3)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'a', type: 'decision' }),
      makeEntity({ id: 2, name: 'b', type: 'pattern' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="memesh" entities={entities} />);
    expect(container.textContent).toContain('memesh');
    expect(container.textContent).toMatch(/2/);
  });

  it('renders empty state for a project with zero entities (edge E1)', () => {
    const { container } = render(<ProjectRoadmap projectName="ghost" entities={[]} />);
    expect(container.textContent).toMatch(/沒有記憶|No memories/i);
  });

  it('renders a single-entity project without crashing (edge E1)', () => {
    // UX-1: the machine name never renders; the title (or observation
    // fallback) is the visible label.
    const e = makeEntity({ name: 'lone', title: 'The only decision here', type: 'decision' });
    const { container } = render(<ProjectRoadmap projectName="solo" entities={[e]} />);
    expect(container.textContent).toContain('The only decision here');
    expect(container.textContent).not.toContain('lone');
  });

  it('shows "Switch to List view" button only when handler is provided (v0 AC2)', () => {
    const onSwitch = vi.fn();
    const e = makeEntity({});
    const withButton = render(
      <ProjectRoadmap projectName="x" entities={[e]} onSwitchToList={onSwitch} />
    );
    const buttons = Array.from(withButton.container.querySelectorAll('button'));
    const listBtn = buttons.find((b) => /清單檢視|List view/.test(b.textContent ?? ''));
    expect(listBtn).toBeDefined();
    fireEvent.click(listBtn!);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('puts release type FIRST within a date group (v0 AC4 — type priority sort)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'late-decision', title: 'A decision made late', type: 'decision', created_at: '2026-04-15T08:00:00.000Z' }),
      makeEntity({ id: 2, name: 'early-release', title: 'Shipped the early release', type: 'release', created_at: '2026-04-15T09:00:00.000Z' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    // Find the visible titles in DOM order — release should come before decision
    const text = container.textContent ?? '';
    const releaseIdx = text.indexOf('Shipped the early release');
    const decisionIdx = text.indexOf('A decision made late');
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeLessThan(decisionIdx);
  });

  it('renders a Milestones rail when release entities exist (v1 AC6)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'v4.0.0', title: 'Release v4.0.0 shipped', type: 'release', tags: ['project:memesh'] }),
      makeEntity({ id: 2, name: 'a-decision', title: 'Some decision', type: 'decision' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="memesh" entities={entities} />);
    // The milestones header label
    expect(container.textContent).toMatch(/里程碑|Milestones/i);
    // The release entity's TITLE should appear in the rail (in addition to
    // the timeline row) — the machine name never renders anywhere.
    const releaseMatches = (container.textContent?.match(/Release v4\.0\.0 shipped/g) ?? []).length;
    expect(releaseMatches).toBeGreaterThanOrEqual(2); // once in rail, once in timeline
    expect(container.textContent).not.toMatch(/a-decision/);
  });

  it('does NOT render Milestones rail when no release entities exist (v1 AC8)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'a-decision', type: 'decision' }),
      makeEntity({ id: 2, name: 'a-pattern', type: 'pattern' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    expect(container.textContent).not.toMatch(/里程碑|Milestones/i);
  });

  it('renders auto-phase strip when entity density >= 3 within 7 days (v2 AC10)', () => {
    // Two clusters: first 4 entities on April 17–18 (one phase),
    // then a 14-day gap, then 3 entities on May 2–3 (second phase).
    // Both clusters meet the >=3 threshold so two strip chips render.
    const entities = [
      makeEntity({ id: 1, name: 'a', type: 'decision', created_at: '2026-04-17T08:00:00.000Z' }),
      makeEntity({ id: 2, name: 'b', type: 'pattern', created_at: '2026-04-17T10:00:00.000Z' }),
      makeEntity({ id: 3, name: 'foundation-release', title: 'Foundation release shipped', type: 'release', created_at: '2026-04-18T09:00:00.000Z' }),
      makeEntity({ id: 4, name: 'd', type: 'note', created_at: '2026-04-18T11:00:00.000Z' }),
      makeEntity({ id: 5, name: 'e', type: 'decision', created_at: '2026-05-02T08:00:00.000Z' }),
      makeEntity({ id: 6, name: 'v2-release', title: 'Version two out the door', type: 'release', created_at: '2026-05-02T12:00:00.000Z' }),
      makeEntity({ id: 7, name: 'g', type: 'pattern', created_at: '2026-05-03T08:00:00.000Z' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    // Phase anchors are labelled by title (never the machine name).
    expect(container.textContent).toContain('Foundation release shipped');
    expect(container.textContent).toContain('Version two out the door');
    expect(container.textContent).not.toContain('foundation-release');
  });

  it('does NOT render phase strip when density is below threshold (v2 AC12)', () => {
    // Single entity, no phases possible.
    const { container } = render(
      <ProjectRoadmap projectName="x" entities={[makeEntity({ id: 1, name: 'lone' })]} />
    );
    // The "Phases" header label should not appear when phases is empty.
    expect(container.textContent).not.toMatch(/Phases|階段/);
  });

  it('renders Key Lessons rail sorted by access_count desc (v1 AC7)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'low-recall', title: 'Rarely recalled lesson', type: 'lesson_learned', access_count: 3 }),
      makeEntity({ id: 2, name: 'high-recall', title: 'Constantly recalled lesson', type: 'lesson_learned', access_count: 50 }),
      makeEntity({ id: 3, name: 'mid-recall', title: 'Sometimes recalled lesson', type: 'lesson_learned', access_count: 12 }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    // Find the rail card by its localised heading. Then check title order
    // *within the rail* — the timeline column may render the same titles
    // in a different order (type-priority, not access_count).
    const cards = Array.from(container.querySelectorAll('.card'));
    const railCard = cards.find((c) => /重要教訓|Key lessons/i.test(c.textContent ?? ''));
    expect(railCard).toBeDefined();
    const railText = railCard!.textContent ?? '';
    const high = railText.indexOf('Constantly recalled lesson');
    const mid = railText.indexOf('Sometimes recalled lesson');
    const low = railText.indexOf('Rarely recalled lesson');
    expect(high).toBeGreaterThanOrEqual(0);
    expect(mid).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(mid);
  });
});
