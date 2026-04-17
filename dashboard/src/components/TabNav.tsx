interface TabItem {
  key: string;
  label: string;
}

export function TabNav({ tabs, active, onSelect }: { tabs: TabItem[]; active: string; onSelect: (key: string) => void }) {
  return (
    <nav class="nav">
      {tabs.map(({ key, label }) => (
        <button key={key} class={`nav-btn ${key === active ? 'active' : ''}`} onClick={() => onSelect(key)}>
          {label}
        </button>
      ))}
    </nav>
  );
}
