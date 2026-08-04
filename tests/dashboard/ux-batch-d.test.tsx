// @vitest-environment happy-dom
//
// Batch D — the a11y contracts the design-token gate can't see, because they
// are runtime DOM shape, not source text. Each test pins one keyboard/screen-
// reader guarantee added in this batch: a wrong ARIA role is worse than none,
// so these assert the *correct* wiring, not merely its presence.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { TabNav } from '../../dashboard/src/components/TabNav';
import { FeedbackWidget } from '../../dashboard/src/components/FeedbackWidget';
import { resolveTokens } from '../../dashboard/src/lib/tokens';

afterEach(() => vi.restoreAllMocks());

const TABS = [
  { key: 'Insights', label: 'Insights' },
  { key: 'Search', label: 'Search' },
  { key: 'Graph', label: 'Graph' },
];

describe('TabNav is a real WAI-ARIA tablist', () => {
  it('exposes role=tablist and a role=tab per tab with aria-selected on the active one', () => {
    const { container, getByRole } = render(
      <TabNav tabs={TABS} active="Search" onSelect={() => {}} />,
    );
    getByRole('tablist'); // throws if absent
    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(['Insights', 'Search', 'Graph']);
    // exactly the active tab is selected, and it owns the single tab stop
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    // each tab points at its panel
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual([
      'panel-Insights', 'panel-Search', 'panel-Graph',
    ]);
  });

  it('ArrowRight moves selection to the next tab', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TabNav tabs={TABS} active="Search" onSelect={onSelect} />,
    );
    const active = container.querySelector('[aria-selected="true"]') as HTMLButtonElement;
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('Graph');
  });

  it('ArrowLeft wraps from the first tab to the last', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TabNav tabs={TABS} active="Insights" onSelect={onSelect} />,
    );
    const active = container.querySelector('[aria-selected="true"]') as HTMLButtonElement;
    fireEvent.keyDown(active, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenCalledWith('Graph');
  });
});

describe('FeedbackWidget is a dialog that closes on Escape', () => {
  const health = { status: 'ok', version: 'test', entity_count: 0 } as const;

  it('the toggle reports expanded state and opens a role=dialog', () => {
    const { container, getByRole } = render(<FeedbackWidget health={health} />);
    const toggle = container.querySelector('.fb-btn') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    getByRole('dialog'); // throws if the panel is not a dialog
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // corner popover, NOT modal — claiming modality while the page stays live
    // would mislead a screen reader.
    expect(container.querySelector('.fb-panel')?.getAttribute('aria-modal')).toBeNull();
  });

  it('Escape closes the panel and collapses the toggle', () => {
    const { container } = render(<FeedbackWidget health={health} />);
    const toggle = container.querySelector('.fb-btn') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(container.querySelector('.fb-panel')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.fb-panel')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('canvas token resolver reads the live stylesheet', () => {
  it('returns the value set on the element, and empty (not a literal) when absent', () => {
    const el = document.createElement('div');
    el.style.setProperty('--accent', '#00D6B4');
    document.body.appendChild(el);
    const tk = resolveTokens(el, ['--accent', '--missing']);
    expect(tk['--accent']).toBe('#00D6B4');
    // Absent token is empty — a visible signal, never a papered-over fallback.
    expect(tk['--missing']).toBe('');
  });
});
