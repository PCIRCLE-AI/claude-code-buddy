// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { CaptureDensityBand, deriveBuckets } from '../../dashboard/src/components/CaptureDensityBand';
import type { Entity } from '../../dashboard/src/lib/api';

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: Math.floor(Math.random() * 100000),
    name: 'x',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['obs'],
    tags: [],
    ...overrides,
  };
}

describe('CaptureDensityBand — capture density by category', () => {
  it('renders nothing for an empty project (empty state is the norm, not a zero chart)', () => {
    const { container } = render(<CaptureDensityBand entities={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when every created_at is unparseable — no invented timeline', () => {
    const { container } = render(
      <CaptureDensityBand entities={[makeEntity({ created_at: 'not-a-date' })]} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('the bar is aria-hidden ornament; the visible text carries title, caveat and counts', () => {
    const entities = [
      makeEntity({ id: 1, type: 'decision', created_at: '2026-04-01T00:00:00.000Z' }),
      makeEntity({ id: 2, type: 'commit', created_at: '2026-04-02T00:00:00.000Z' }),
      makeEntity({ id: 3, type: 'note', created_at: '2026-04-03T00:00:00.000Z' }),
    ];
    const { container } = render(<CaptureDensityBand entities={entities} />);
    // Honest naming: captured, with the "not everything that happened" caveat.
    expect(container.textContent).toMatch(/Capture density|捕捉密度/i);
    expect(container.textContent).toMatch(/not everything that happened|不等於發生過的一切/i);
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
    // Legend counts: 1 knowledge (decision), 1 activity (commit), 1 reference (note).
    expect(container.textContent).toContain('1');
  });

  it('deriveBuckets: buckets follow created_at and split by cluster', () => {
    const buckets = deriveBuckets([
      makeEntity({ type: 'decision', created_at: '2026-04-01T00:00:00.000Z' }),
      makeEntity({ type: 'lesson_learned', created_at: '2026-04-01T06:00:00.000Z' }),
      makeEntity({ type: 'commit', created_at: '2026-04-05T00:00:00.000Z' }),
    ]);
    // 5-day span → day buckets.
    expect(buckets).toHaveLength(5);
    expect(buckets[0].counts.knowledge).toBe(2);
    expect(buckets[0].total).toBe(2);
    expect(buckets[4].counts.activity).toBe(1);
    // The quiet days between are rendered as REAL empty buckets, not
    // collapsed away — the gap is the information.
    expect(buckets[1].total + buckets[2].total + buckets[3].total).toBe(0);
  });

  it('deriveBuckets: a multi-year span coarsens to month buckets and stays bounded', () => {
    const buckets = deriveBuckets([
      makeEntity({ created_at: '2024-01-01T00:00:00.000Z' }),
      makeEntity({ created_at: '2026-04-01T00:00:00.000Z' }),
    ]);
    expect(buckets.length).toBeLessThanOrEqual(60);
    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(2);
  });
});
