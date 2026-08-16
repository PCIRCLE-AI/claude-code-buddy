/**
 * The shared filter chip — DESIGN.md "Component patterns" is the contract:
 * token-only styling, `--life` border / `--life-soft` fill / `--life` text
 * when active, `aria-pressed` always. Extracted from BrowseTab's private
 * chip when the memory surfaces merged; every chip row in the dashboard
 * renders this one component so the active state cannot drift per tab.
 */
interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
  /** Optional species/cluster swatch shown before the label (composition
   *  bar legends). A colour value, e.g. from CATEGORICAL_TYPE_COLORS. */
  dot?: string;
}

export function Chip({ label, active, onClick, count, dot }: ChipProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: '4px 10px',
        borderRadius: 'var(--radius)',
        border: '1px solid',
        borderColor: active ? 'var(--life)' : 'var(--border)',
        background: active ? 'var(--life-soft)' : 'transparent',
        color: active ? 'var(--life)' : 'var(--text-2)',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-ui)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 'var(--radius-hairline)', background: dot, flexShrink: 0 }}
        />
      )}
      {label}
      {count !== undefined && (
        <span style={{ opacity: 0.6, fontFamily: 'var(--mono)', fontSize: 10 }}>
          {count}
        </span>
      )}
    </button>
  );
}
