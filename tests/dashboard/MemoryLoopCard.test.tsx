// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { MemoryLoopCard } from '../../dashboard/src/components/MemoryLoopCard';

const baseTrend = [
  { date: '2026-04-15', count: 2 },
  { date: '2026-04-22', count: 5 },
  { date: '2026-04-29', count: 8 },
];

describe('MemoryLoopCard — SPEC-2 acceptance criteria', () => {
  it('renders the hero number when reusedThisWeek > 0', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 12, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    // JS \b is between \w / non-\w only, so 12 sandwiched against letters
    // has no word boundary. Just assert the substring is present.
    expect(container.textContent).toContain('12');
  });

  it('shows the em-dash placeholder for the zero-state (AC: zero state guides the user)', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 0, trend: [], computedFrom: 'recall_hits' }} />
    );
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/^0$/);
  });

  it('surfaces the approximation note when computedFrom is the fallback (AC2)', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'last_accessed_at_approximation' }} />
    );
    // Match either the en or zh-TW phrasing
    const approxRegex = /Approximation|近似值/;
    expect(container.textContent).toMatch(approxRegex);
  });

  it('omits the approx note when computedFrom is the precise mode', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    expect(container.textContent).not.toMatch(/Approximation|近似值/);
  });

  it('renders an SVG sparkline with one circle marker for the most-recent point', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 5, trend: baseTrend, computedFrom: 'recall_hits' }} />
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(1);
  });

  it('handles empty trend without crashing', () => {
    const { container } = render(
      <MemoryLoopCard metric={{ reusedThisWeek: 0, trend: [], computedFrom: 'recall_hits' }} />
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
