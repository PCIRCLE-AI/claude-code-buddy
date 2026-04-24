import { useState, useEffect } from 'preact/hooks';
import { api, type ConfigData, type UpdateStatusData } from '../lib/api';
import { t, setLocale, getLocales, type Locale } from '../lib/i18n';

interface SettingsTabProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTimestamp(locale: Locale, value: string | null): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function getInstallChannelLabel(channel: UpdateStatusData['installChannel'] | undefined): string {
  switch (channel) {
    case 'npm-global':
      return t('settings.installNpmGlobal');
    case 'npm-local':
      return t('settings.installNpmLocal');
    case 'source-checkout':
      return t('settings.installSourceCheckout');
    default:
      return t('settings.installUnknown');
  }
}

function getInstallChannelGuidance(channel: UpdateStatusData['installChannel'] | undefined): string {
  switch (channel) {
    case 'npm-global':
      return t('settings.updateGuidanceNpmGlobal');
    case 'npm-local':
      return t('settings.updateGuidanceNpmLocal');
    case 'source-checkout':
      return t('settings.updateGuidanceSourceCheckout');
    default:
      return t('settings.updateGuidanceUnknown');
  }
}

export function SettingsTab({ locale, onLocaleChange }: SettingsTabProps) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusData | null>(null);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [updateLoading, setUpdateLoading] = useState(true);
  const [updateRefreshing, setUpdateRefreshing] = useState(false);

  async function loadUpdateStatus(forceFresh = true, keepCurrentState = false) {
    if (keepCurrentState) {
      setUpdateRefreshing(true);
    } else {
      setUpdateLoading(true);
    }

    try {
      const path = forceFresh ? '/v1/update-status' : '/v1/update-status?cached=1';
      const data = await api<UpdateStatusData>('GET', path);
      setUpdateStatus(data);
    } catch {
      if (!keepCurrentState) {
        setUpdateStatus(null);
      }
    } finally {
      if (keepCurrentState) {
        setUpdateRefreshing(false);
      } else {
        setUpdateLoading(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    api<ConfigData>('GET', '/v1/config')
      .then((data) => {
        setConfig(data);
        setProvider(data.config.llm?.provider || '');
        setModel(data.config.llm?.model || '');
      })
      .finally(() => setLoading(false));

    void (async () => {
      await loadUpdateStatus(false);
      if (!cancelled) {
        void loadUpdateStatus(true, true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const llm: { provider: string; model?: string; apiKey?: string } = { provider };
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
  const searchModeLabel = caps?.searchLevel ? t('settings.smartMode') : t('settings.core');
  const isCheckingUpdates = updateLoading || (updateRefreshing && !updateStatus);
  const updateActionInProgress = updateLoading || updateRefreshing;
  const updateSummary = isCheckingUpdates
    ? t('settings.updateChecking')
    : !updateStatus
      ? t('settings.updateUnavailable')
      : updateStatus.freshness === 'unavailable'
        ? t('settings.updateNoSuccessfulChecks')
        : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
          ? t('settings.updateStale')
          : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
            ? t('settings.updateCachedFallback')
            : updateStatus.updateAvailable
              ? t('settings.updateAvailable')
              : t('settings.upToDate');
  const updateSummaryColor = !updateStatus
    ? 'var(--warning)'
    : updateStatus.freshness === 'unavailable'
      ? 'var(--warning)'
      : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
        ? 'var(--warning)'
        : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
          ? 'var(--info)'
          : updateStatus.updateAvailable
            ? 'var(--info)'
            : 'var(--success)';
  const updateSourceLabel = updateStatus?.freshness === 'stale'
    ? t('settings.updateSourceStale')
    : updateStatus?.source === 'cache'
      ? t('settings.updateSourceCached')
      : updateStatus?.source === 'fresh'
        ? t('settings.updateSourceFresh')
        : t('settings.updateSourceUnavailable');
  const installMethodLabel = getInstallChannelLabel(updateStatus?.installChannel);
  const installGuidance = getInstallChannelGuidance(updateStatus?.installChannel);
  const lastAttemptLabel = isCheckingUpdates ? t('common.loading') : formatTimestamp(locale, updateStatus?.lastAttemptAt || null);
  const lastSuccessfulLabel = isCheckingUpdates ? t('common.loading') : formatTimestamp(locale, updateStatus?.lastSuccessfulCheckAt || null);
  const showLastSuccessful = Boolean(updateStatus?.lastSuccessfulCheckAt);
  const showLastError = Boolean(updateStatus?.lastError) && !isCheckingUpdates;

  return (
    <div>
      {/* Capabilities */}
      <div class="card">
        <div class="card-title">{t('settings.capabilities')}</div>
        <div class="stats-row" style={{ marginBottom: 0 }}>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 18 }}>{searchModeLabel}</div>
            <div class="stat-lbl">{t('settings.searchMode')}</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{capitalize(caps?.embeddings || '—')}</div>
            <div class="stat-lbl">{t('settings.embeddings')}</div>
          </div>
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14 }}>{capitalize(caps?.llm?.provider || t('settings.none'))}</div>
            <div class="stat-lbl">{t('settings.llmProvider')}</div>
          </div>
        </div>
      </div>

      {/* LLM Config */}
      <div class="card">
        <div class="card-title">{t('settings.llmProvider')}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
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
                autoComplete="off"
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
            <button class="btn btn-primary" type="submit" disabled={!provider || saving}>
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
            {msg && <span style={{ fontSize: 12, color: msg.startsWith(t('common.error')) ? 'var(--danger)' : 'var(--success)' }}>{msg}</span>}
          </div>
        </form>
      </div>

      {/* Updates */}
      <div class="card">
        <div class="card-title">{t('settings.updates')}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ color: updateSummaryColor, fontSize: 13, fontWeight: 600 }}>{updateSummary}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!isCheckingUpdates && updateStatus && (
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{updateSourceLabel}</div>
            )}
            <button
              class="btn btn-sm"
              type="button"
              onClick={() => { void loadUpdateStatus(true, Boolean(updateStatus)); }}
              disabled={updateActionInProgress}
            >
              {updateActionInProgress ? t('settings.updateChecking') : t('settings.checkNow')}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.installMethod')}</span>
            <span style={{ color: 'var(--text-0)' }}>{isCheckingUpdates ? t('common.loading') : installMethodLabel}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.currentVersion')}</span>
            <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{updateStatus?.currentVersion || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.latestVersion')}</span>
            <span style={{ color: 'var(--text-0)', fontFamily: 'var(--mono)' }}>{updateStatus?.latestVersion || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('settings.lastAttempted')}</span>
            <span style={{ color: 'var(--text-0)' }}>{lastAttemptLabel}</span>
          </div>
          {showLastSuccessful && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
              <span style={{ color: 'var(--text-2)' }}>{t('settings.lastSuccessful')}</span>
              <span style={{ color: 'var(--text-0)' }}>{lastSuccessfulLabel}</span>
            </div>
          )}
          {!updateLoading && (
            <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.5, marginTop: 2 }}>{installGuidance}</div>
          )}
          {showLastError && (
            <div style={{ color: 'var(--warning)', fontSize: 12, lineHeight: 1.5 }}>
              {t('settings.updateLastError', { message: updateStatus?.lastError || '' })}
            </div>
          )}
          {updateStatus?.recommendedCommand && (
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{t('settings.updateCommand')}</span>
              <code style={{ color: 'var(--text-0)', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)' }}>
                {updateStatus.recommendedCommand}
              </code>
            </div>
          )}
        </div>
      </div>

      {/* Language */}
      <div class="card">
        <div class="card-title">{t('settings.language')}</div>
        <select
          value={locale}
          onChange={(e) => {
            const nextLocale = (e.target as HTMLSelectElement).value as Locale;
            setLocale(nextLocale);
            onLocaleChange(nextLocale);
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
