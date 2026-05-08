// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { MemoryRow } from '../../dashboard/src/components/MemoryRow';
import type { Entity } from '../../dashboard/src/lib/api';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 1,
    name: 'auth-decision',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['Use OAuth 2.0 with PKCE for browser flows'],
    tags: ['project:memesh', 'topic:auth'],
    ...overrides,
  };
}

describe('MemoryRow', () => {
  it('renders the entity name and the best observation', () => {
    const { container } = render(<MemoryRow entity={makeEntity()} />);
    expect(container.textContent).toContain('Use OAuth 2.0 with PKCE');
    expect(container.textContent).toContain('auth-decision');
  });

  it('shows the project chip when a project: tag is present', () => {
    const { container } = render(<MemoryRow entity={makeEntity()} />);
    // Post-SPEC-5 the folder glyph is an SVG, not an emoji. Locate the
    // chip by its tag class plus the project name text.
    const chips = Array.from(container.querySelectorAll('.tag'));
    const projectChip = chips.find((c) => (c.textContent ?? '').includes('memesh'));
    expect(projectChip).toBeDefined();
    expect(projectChip!.querySelector('svg')).not.toBeNull();
  });

  it('omits the recall badge when access_count is 0', () => {
    const e = makeEntity({ access_count: 0 });
    const { container } = render(<MemoryRow entity={e} />);
    expect(container.textContent).not.toMatch(/次回憶|recalls/);
  });

  it('shows a high-tone badge when access_count >= 20', () => {
    const e = makeEntity({ access_count: 42 });
    const { container } = render(<MemoryRow entity={e} />);
    // Both Chinese and English fallback labels include the count
    expect(container.textContent).toMatch(/42/);
  });

  it('does not surface internal date or project: tags in the tag row', () => {
    const e = makeEntity({ tags: ['project:memesh', '2026-04-15', 'topic:auth'] });
    const { container } = render(<MemoryRow entity={e} />);
    // project:memesh becomes the dedicated chip, not a generic tag
    const tagChips = Array.from(container.querySelectorAll('.tag')).map((el) => el.textContent ?? '');
    expect(tagChips.some((t) => t.includes('topic:auth'))).toBe(true);
    // Date-stamp tag and project: prefix should not appear as raw tag chips
    expect(tagChips.some((t) => /^2026-04-15$/.test(t.trim()))).toBe(false);
  });

  it('uses the dedicated SVG icon (not emoji) for known types', () => {
    // After SPEC-5 the icon column renders an SVG with an aria-label
    // matching its glyph cluster — Lesson / Bug fix / Feature etc.
    const lesson = render(<MemoryRow entity={makeEntity({ type: 'lesson_learned' })} />);
    const lessonSvg = lesson.container.querySelector('svg[aria-label="Lesson"]');
    expect(lessonSvg).not.toBeNull();

    const bug = render(<MemoryRow entity={makeEntity({ type: 'bug_fix' })} />);
    expect(bug.container.querySelector('svg[aria-label="Bug fix"]')).not.toBeNull();

    const release = render(<MemoryRow entity={makeEntity({ type: 'release' })} />);
    expect(release.container.querySelector('svg[aria-label="Feature"]')).not.toBeNull();
  });

  it('does not render any emoji as a UI affordance (DESIGN.md mandate)', () => {
    const { container } = render(<MemoryRow entity={makeEntity({ type: 'lesson_learned' })} />);
    // Codepoint regex covers the type-glyph emoji we historically used.
    // SDD plan SPEC-5 AC1: no emoji in component-rendered DOM.
    expect(container.textContent ?? '').not.toMatch(/[💡🎯🐛🧩✨♻️📝📋🗺️📓🚀⏱️📅🔖🏗️⚙️📚]/);
  });
});
