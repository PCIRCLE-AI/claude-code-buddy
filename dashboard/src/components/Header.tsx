import type { HealthData } from '../lib/api';

export function Header({ health, error }: { health: HealthData | null; error: string }) {
  return (
    <div class="header">
      <div class="header-brand">
        <h1>MeMesh LLM Memory</h1>
        <small>powered by pcircle.ai</small>
      </div>
      <div class="header-right">
        <div class="header-meta">
          {health ? (
            <>
              <span><span class="dot dot-ok" />Connected</span>
              <span class="badge-version">v{health.version} · {health.entity_count.toLocaleString()} memories</span>
            </>
          ) : error ? (
            <span><span class="dot dot-err" />Disconnected</span>
          ) : (
            <span style={{ color: 'var(--text-3)' }}>Connecting…</span>
          )}
        </div>
      </div>
    </div>
  );
}
