import { useState, useEffect } from 'preact/hooks';
import { api, type ConfigData } from '../lib/api';
import { t, getLocale, setLocale, getLocales } from '../lib/i18n';

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
      setMsg(t('settings.saved'));
      setApiKey('');
    } catch (e: any) {
      setMsg(t('common.error') + ': ' + e.message);
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
        <div class="card-title">{t('settings.capabilities')}</div>
        <div class="stats-row" style={{ marginBottom: 0 }}>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 18 }}>Level {caps?.searchLevel || 0}</div>
            <div class="stat-lbl">{caps?.searchLevel ? t('settings.smartMode') : t('settings.core')}</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{capitalize(caps?.embeddings || '—')}</div>
            <div class="stat-lbl">{t('settings.embeddings')}</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{capitalize(caps?.llm?.provider || 'None')}</div>
            <div class="stat-lbl">{t('settings.llmProvider')}</div>
          </div>
        </div>
      </div>

      {/* LLM Config */}
      <div class="card">
        <div class="card-title">{t('settings.llmProvider')}</div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
          {([['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI'], ['ollama', 'Ollama (Local)']] as const).map(([val, label]) => (
            <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="radio"
                name="provider"
                value={val}
                checked={provider === val}
                onChange={() => setProvider(val)}
              />
              {label}
            </label>
          ))}
        </div>

        {provider && provider !== 'ollama' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>{t('settings.apiKey')}</label>
            <input
              type="password"
              placeholder={provider === 'anthropic' ? 'sk-ant-api03-…' : 'sk-…'}
              value={apiKey}
              onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>{t('settings.model')}</label>
          <input
            type="text"
            placeholder={provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'openai' ? 'gpt-4o-mini' : 'llama3.2'}
            value={model}
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button class="btn btn-primary" onClick={save} disabled={!provider || saving}>
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith(t('common.error')) ? 'var(--danger)' : 'var(--success)' }}>{msg}</span>}
        </div>
      </div>

      {/* Language */}
      <div class="card">
        <div class="card-title">{t('settings.language')}</div>
        <select
          value={getLocale()}
          onChange={(e) => {
            setLocale((e.target as HTMLSelectElement).value as any);
            window.location.reload();
          }}
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)', cursor: 'pointer' }}
        >
          {getLocales().map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
