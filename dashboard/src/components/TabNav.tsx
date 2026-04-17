export function TabNav({ tabs, active, onSelect }: { tabs: string[]; active: string; onSelect: (t: string) => void }) {
  return (
    <nav class="nav">
      {tabs.map((t) => (
        <button key={t} class={`nav-btn ${t === active ? 'active' : ''}`} onClick={() => onSelect(t)}>
          {t}
        </button>
      ))}
    </nav>
  );
}
