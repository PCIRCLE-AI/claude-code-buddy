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
    const e = makeEntity({ name: 'lone', type: 'decision' });
    const { container } = render(<ProjectRoadmap projectName="solo" entities={[e]} />);
    expect(container.textContent).toContain('lone');
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
      makeEntity({ id: 1, name: 'late-decision', type: 'decision', created_at: '2026-04-15T08:00:00.000Z' }),
      makeEntity({ id: 2, name: 'early-release', type: 'release', created_at: '2026-04-15T09:00:00.000Z' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    // Find the visible names in DOM order — release should come before decision
    const text = container.textContent ?? '';
    const releaseIdx = text.indexOf('early-release');
    const decisionIdx = text.indexOf('late-decision');
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeLessThan(decisionIdx);
  });

  it('renders a Milestones rail when release entities exist (v1 AC6)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'v4.0.0', type: 'release', tags: ['project:memesh'] }),
      makeEntity({ id: 2, name: 'a-decision', type: 'decision' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="memesh" entities={entities} />);
    // The milestones header label
    expect(container.textContent).toMatch(/里程碑|Milestones/i);
    // The release entity name should appear in the rail (in addition to timeline)
    const releaseMatches = (container.textContent?.match(/v4\.0\.0/g) ?? []).length;
    expect(releaseMatches).toBeGreaterThanOrEqual(2); // once in rail, once in timeline
  });

  it('does NOT render Milestones rail when no release entities exist (v1 AC8)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'a-decision', type: 'decision' }),
      makeEntity({ id: 2, name: 'a-pattern', type: 'pattern' }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    expect(container.textContent).not.toMatch(/里程碑|Milestones/i);
  });

  it('renders Key Lessons rail sorted by access_count desc (v1 AC7)', () => {
    const entities = [
      makeEntity({ id: 1, name: 'low-recall', type: 'lesson_learned', access_count: 3 }),
      makeEntity({ id: 2, name: 'high-recall', type: 'lesson_learned', access_count: 50 }),
      makeEntity({ id: 3, name: 'mid-recall', type: 'lesson_learned', access_count: 12 }),
    ];
    const { container } = render(<ProjectRoadmap projectName="x" entities={entities} />);
    // Find the rail card by its localised heading. Then check entity-name
    // order *within the rail* — the timeline column may render the same
    // names in a different order (typeof-priority, not access_count).
    const cards = Array.from(container.querySelectorAll('.card'));
    const railCard = cards.find((c) => /重要教訓|Key lessons/i.test(c.textContent ?? ''));
    expect(railCard).toBeDefined();
    const railText = railCard!.textContent ?? '';
    const high = railText.indexOf('high-recall');
    const mid = railText.indexOf('mid-recall');
    const low = railText.indexOf('low-recall');
    expect(high).toBeGreaterThanOrEqual(0);
    expect(mid).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(mid);
  });
});
