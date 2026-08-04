import { useRef, useState, useEffect, useCallback } from 'preact/hooks';
import { t } from '../lib/i18n';

interface TabItem {
  key: string;
  label: string;
}

/**
 * Main navigation as a WAI-ARIA tablist. Before this it was a row of plain
 * buttons: a screen reader announced eight unrelated buttons with no "tab 3 of
 * 8", no selected state, and arrow keys did nothing. Now it is a single tab
 * stop (roving tabIndex) with Left/Right/Home/End moving selection, each tab
 * wired to its panel via aria-controls (panels carry the matching id +
 * role="tabpanel" in App.tsx).
 *
 * The nav strip scrolls horizontally with its scrollbar hidden (see .nav in
 * global.css), so on a narrow screen the tabs past the right edge are
 * invisible and undiscoverable. A right-edge fade — an informational gradient
 * (it IS the "there is more, scroll" affordance, sanctioned in DESIGN.md) —
 * shows only while the strip is actually scrollable and not yet at its end.
 */
export function TabNav({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabItem[];
  active: string;
  onSelect: (key: string) => void;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [overflowRight, setOverflowRight] = useState(false);

  const recomputeOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    // 1px slack so a sub-pixel rounding at the true end doesn't keep the fade on.
    setOverflowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    recomputeOverflow();
    const el = navRef.current;
    if (!el) return;
    el.addEventListener('scroll', recomputeOverflow, { passive: true });
    window.addEventListener('resize', recomputeOverflow);
    return () => {
      el.removeEventListener('scroll', recomputeOverflow);
      window.removeEventListener('resize', recomputeOverflow);
    };
  }, [recomputeOverflow, tabs.length]);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onSelect(tabs[next].key);
    btnRefs.current[next]?.focus();
    btnRefs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div style={{ position: 'relative' }}>
      <div ref={navRef} class="nav" role="tablist" aria-label={t('nav.ariaLabel')}>
        {tabs.map(({ key, label }, i) => {
          const selected = key === active;
          return (
            <button
              key={key}
              ref={(el) => { btnRefs.current[i] = el; }}
              id={`tab-${key}`}
              role="tab"
              aria-selected={selected ? 'true' : 'false'}
              aria-controls={`panel-${key}`}
              tabIndex={selected ? 0 : -1}
              class={`nav-btn ${selected ? 'active' : ''}`}
              onClick={() => onSelect(key)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {overflowRight && <div aria-hidden="true" class="nav-overflow-fade" />}
    </div>
  );
}
