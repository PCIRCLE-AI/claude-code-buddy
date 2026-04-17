import { useState, useEffect } from 'preact/hooks';
import { api, type ConfigData } from '../lib/api';

export function SettingsTab() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<ConfigData>('GET', '/v1/config')
      .then((data) => {
        setConfig(data);
        setProvider(data.config.llm?.provider || '');
        setModel(data.config.llm?.model || '');
      })
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const llm: any = { provider };
      if (model) llm.model = model;
      if (apiKey) llm.apiKey = apiKey;
      await api('POST', '/v1/config', { llm });
      setMsg('Saved! Restart server for LLM changes to take effect.');
      setApiKey('');
    } catch (e: any) {
      setMsg('Error: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div class="empty"><div class="loading" /></div>;

  const caps = config?.capabilities;

  return (
    <div>
      {/* Capabilities */}
      <div class="card">
        <div class="card-title">Capabilities</div>
        <div class="stats-row" style={{ marginBottom: 0 }}>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 18 }}>Level {caps?.searchLevel || 0}</div>
            <div class="stat-lbl">{caps?.searchLevel ? 'Smart Mode' : 'Core'}</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{caps?.embeddings || '—'}</div>
            <div class="stat-lbl">Embeddings</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{caps?.llm?.provider || 'None'}</div>
            <div class="stat-lbl">LLM Provider</div>
          </div>
        </div>
      </div>

      {/* LLM Config */}
      <div class="card">
        <div class="card-title">LLM Provider</div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
          {['anthropic', 'openai', 'ollama'].map((p) => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="radio"
                name="provider"
                value={p}
                checked={provider === p}
                onChange={() => setProvider(p)}
              />
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </label>
          ))}
        </div>

        {provider && provider !== 'ollama' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>API Key</label>
            <input
              type="password"
              placeholder={provider === 'anthropic' ? 'sk-ant-api03-…' : 'sk-…'}
              value={apiKey}
              onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Model (optional)</label>
          <input
            type="text"
            placeholder={provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'openai' ? 'gpt-4o-mini' : 'llama3.2'}
            value={model}
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button class="btn btn-primary" onClick={save} disabled={!provider || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('Error') ? 'var(--danger)' : 'var(--success)' }}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
