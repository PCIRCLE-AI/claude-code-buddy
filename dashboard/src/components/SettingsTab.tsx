import { useState, useEffect } from 'preact/hooks';
import { api, type ConfigData, type ConfigTestResult, type UpdateStatusData } from '../lib/api';
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
  const [initialProvider, setInitialProvider] = useState('');
  const [initialModel, setInitialModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [testing, setTesting] = useState(false);
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
        const p = data.config.llm?.provider || '';
        const m = data.config.llm?.model || '';
        setProvider(p);
        setModel(m);
        setInitialProvider(p);
        setInitialModel(m);
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

  async function testConnection() {
    setTesting(true);
    setMsg('');
    setTestResult(null);
    try {
      const result = await api<ConfigTestResult>('POST', '/v1/config/test', {
        provider,
        ...(apiKey ? { apiKey } : {}),
      });
      setTestResult(result);
      if (result.valid && !model && result.suggested) {
        setModel(result.suggested);
      }
    } catch (e: any) {
      setTestResult({ valid: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  // Reset test status whenever the user edits provider or apiKey, since
  // a previously-passing test no longer reflects the current credentials.
  function onProviderChange(v: string) {
    setProvider(v);
    setTestResult(null);
    setModel('');
  }
  function onApiKeyChange(v: string) {
    setApiKey(v);
    setTestResult(null);
  }

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
      setTestResult(null);
    } catch (e: any) {
      setMsg(t('common.error') + ': ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  // F17: Remove the configured LLM provider entirely (drops apiKey + model).
  // After this, memesh falls back to env-var auto-detect (anthropic > openai
  // > ollama). If no env credential is present either, memesh runs in Core
  // Mode (FTS5 + ONNX embeddings, no LLM-backed features).
  async function removeProvider() {
    if (!confirm(t('settings.removeProviderConfirm'))) return;
    setSaving(true);
    setMsg('');
    try {
      await api('POST', '/v1/config', { llm: null });
      setProvider('');
      setModel('');
      setApiKey('');
      setInitialProvider('');
      setInitialModel('');
      setTestResult(null);
      setMsg(t('settings.providerRemoved'));
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
  const isDeprecated = Boolean(updateStatus?.currentVersionDeprecated);
  const hasUpdateTarget = Boolean(
    updateStatus?.latestVersion
    && updateStatus.latestVersion !== updateStatus.currentVersion,
  );
  // Codex rounds 34/35: "confirmed no upgrade target" is only safe
  // to claim when the registry-side equality came from a FRESH
  // lookup. Round 34 distinguished null (unknown) from === current.
  // Round 35 noted that === current from cached/stale data still
  // can't be trusted — npm could have published a replacement
  // since the last successful check. Treat cache/stale/null all as
  // "target unknown" and route the user at `memesh update`.
  const noUpgradeTargetConfirmed = Boolean(
    isDeprecated
    && updateStatus?.latestVersion
    && updateStatus.latestVersion === updateStatus.currentVersion
    && updateStatus?.freshness === 'fresh',
  );
  // Codex round 28: partial-failure state is `checkSucceeded === true`
  // (the version lookup answered) AND `lastError` populated (the
  // deprecation sub-call did not). In that case we don't actually
  // know whether the installed version is flagged for security
  // disclosure. Refuse to show "Up to date" + green here — that's
  // a false-green that hides a security-relevant unknown.
  const isPartialDeprecationFailure = Boolean(
    updateStatus?.checkSucceeded && updateStatus?.lastError,
  );
  // A maintainer-deprecated install is never "up to date" — even
  // when no newer version has been published yet. The primary
  // summary line and color must reflect that so the green "all
  // clear" state can't contradict the deprecation card above. But
  // we also can't claim "Update available" when there's no actual
  // newer version published; in that rare case (deprecation lands
  // before the replacement does), keep the deprecation banner card
  // doing the talking and label the summary "Deprecated — no
  // upgrade target yet" so the user understands `memesh update`
  // would no-op.
  const updateSummary = isCheckingUpdates
    ? t('settings.updateChecking')
    : !updateStatus
      ? t('settings.updateUnavailable')
      : isDeprecated
        ? hasUpdateTarget
          ? t('settings.updateAvailable')
          : noUpgradeTargetConfirmed
            ? t('settings.updateDeprecatedNoTarget')
            : t('settings.updateDeprecatedTargetUnknown')
        : updateStatus.freshness === 'unavailable'
          ? t('settings.updateNoSuccessfulChecks')
          : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
            ? t('settings.updateStale')
            : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
              ? t('settings.updateCachedFallback')
              : updateStatus.updateAvailable
                ? t('settings.updateAvailable')
                : isPartialDeprecationFailure
                  ? t('settings.updatePartialSummary')
                  : t('settings.upToDate');
  const updateSummaryColor = !updateStatus
    ? 'var(--warning)'
    : isDeprecated
      ? 'var(--danger)'
      : updateStatus.freshness === 'unavailable'
        ? 'var(--warning)'
        : !updateStatus.checkSucceeded && updateStatus.freshness === 'stale'
          ? 'var(--warning)'
          : !updateStatus.checkSucceeded && updateStatus.freshness === 'cached'
            ? 'var(--info)'
            : updateStatus.updateAvailable
              ? 'var(--info)'
              : isPartialDeprecationFailure
                ? 'var(--warning)'
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
        {/*
          #31 — explain LLM is OPTIONAL up-front. memesh's wedge is
          "95.40% R@5 with FTS5 alone, no LLM required". README already
          says this; the Settings UI shouldn't make users feel they
          "must" pick a provider just because it's the most prominent
          card on this tab. Spell out exactly what stays available
          without an LLM, and what an LLM unlocks.
        */}
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 14,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--text-2)',
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>
            {t('settings.llmOptional.title')}
          </div>
          <div style={{ marginBottom: 6 }}>{t('settings.llmOptional.body')}</div>
          <div><strong>{t('settings.llmOptional.coreLabel')}</strong> — {t('settings.llmOptional.coreFeatures')}</div>
          <div><strong>{t('settings.llmOptional.smartLabel')}</strong> — {t('settings.llmOptional.smartFeatures')}</div>
        </div>
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
                  onChange={() => onProviderChange(val)}
                />
                {label}
              </label>
            ))}
          </div>

          {provider && provider !== 'ollama' && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>{t('settings.apiKey')}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={provider === 'anthropic' ? 'sk-ant-api03-…' : 'sk-…'}
                  value={apiKey}
                  onInput={(e) => onApiKeyChange((e.target as HTMLInputElement).value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  class="btn"
                  onClick={() => void testConnection()}
                  disabled={!provider || testing || (provider !== 'ollama' && !apiKey)}
                  style={{ flexShrink: 0 }}
                >
                  {testing ? t('settings.testing') : t('settings.test')}
                </button>
              </div>
            </div>
          )}

          {provider === 'ollama' && (
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                class="btn"
                onClick={() => void testConnection()}
                disabled={testing}
              >
                {testing ? t('settings.testing') : t('settings.test')}
              </button>
            </div>
          )}

          {testResult && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                background: testResult.valid ? 'rgba(0, 214, 180, 0.08)' : 'rgba(255, 107, 107, 0.08)',
                border: `1px solid ${testResult.valid ? 'rgba(0, 214, 180, 0.4)' : 'rgba(255, 107, 107, 0.4)'}`,
                color: testResult.valid ? '#00D6B4' : '#ff6b6b',
              }}
            >
              {testResult.valid
                ? t('settings.testPassed', { count: testResult.models?.length ?? 0 })
                : `✗ ${testResult.error || t('settings.testFailed')}`}
            </div>
          )}

          {testResult?.valid && testResult.models && testResult.models.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
                {t('settings.model')}
                {testResult.suggested && (
                  <span style={{ marginLeft: 6, color: 'var(--text-3)', fontWeight: 400 }}>
                    ({t('settings.suggested')}: <span style={{ color: 'var(--accent)' }}>{testResult.suggested}</span>)
                  </span>
                )}
              </label>
              <select
                value={model}
                onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
                style={{ width: '100%' }}
              >
                {testResult.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.created ? ` — ${m.created.slice(0, 10)}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* LLM section is "dirty" only when the user actually changed
              provider, entered a new apiKey, or picked a different model.
              Untouched form (e.g. user opened Settings just to glance) does
              not require a fresh Test before Save. */}
          {(() => {
            const dirty =
              provider !== initialProvider ||
              !!apiKey ||
              model !== initialModel;
            const needsTest = dirty && !testResult?.valid;
            const saveDisabled = !provider || saving || needsTest;
            return (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button class="btn btn-primary" type="submit" disabled={saveDisabled}>
                  {saving ? t('settings.saving') : t('settings.save')}
                </button>
                {/* F17: Show Remove button only when a provider is currently
                    saved. Hides on fresh installs where there's nothing to
                    remove, and matches the destructive-action UX pattern of
                    only showing it for resources that actually exist. */}
                {initialProvider && (
                  <button
                    type="button"
                    class="btn"
                    onClick={removeProvider}
                    disabled={saving}
                    style={{
                      borderColor: 'var(--danger)',
                      color: 'var(--danger)',
                      background: 'transparent',
                    }}
                    title={t('settings.removeProviderHint')}
                  >
                    {t('settings.removeProvider')}
                  </button>
                )}
                {needsTest && (
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('settings.testRequired')}</span>
                )}
                {msg && <span style={{ fontSize: 12, color: msg.startsWith(t('common.error')) ? 'var(--danger)' : 'var(--success)' }}>{msg}</span>}
              </div>
            );
          })()}
        </form>
      </div>

      {/* Updates */}
      <div class="card">
        <div class="card-title">{t('settings.updates')}</div>
        {updateStatus?.currentVersionDeprecated && updateStatus.deprecationMessage && (
          <div
            style={{
              background: 'rgba(255, 107, 107, 0.08)',
              border: '1px solid rgba(255, 107, 107, 0.4)',
              borderRadius: 4,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: 'var(--text-0)',
              lineHeight: 1.55,
            }}
            data-testid="settings-deprecation-warning"
          >
            <strong style={{ color: '#ff6b6b' }}>
              {t('settings.updateDeprecatedTitle', { version: updateStatus.currentVersion })}
            </strong>
            <div style={{ marginTop: 4, opacity: 0.9 }}>{updateStatus.deprecationMessage}</div>
          </div>
        )}
        {updateStatus && updateStatus.checkSucceeded && updateStatus.lastError && (
          <div
            style={{
              background: 'rgba(255, 200, 87, 0.08)',
              border: '1px solid rgba(255, 200, 87, 0.4)',
              borderRadius: 4,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: 'var(--text-0)',
              lineHeight: 1.55,
            }}
            data-testid="settings-update-partial-warning"
          >
            <strong style={{ color: 'var(--warning)' }}>{t('settings.updatePartialTitle')}</strong>
            <div style={{ marginTop: 4, opacity: 0.9 }}>
              {t('settings.updatePartialDescription', { message: updateStatus.lastError ?? '' })}
            </div>
          </div>
        )}
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

      {/* Behaviour — surfaces autoUpdate + enableAgenticOrchestration so
          users can configure them from the dashboard instead of editing
          ~/.memesh/config.json by hand. Both fields were already accepted
          by POST /v1/config; this is the missing UI side. */}
      <div class="card">
        <div class="card-title">{t('settings.behaviourTitle')}</div>

        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>
            {t('settings.autoUpdateLabel')}
          </label>
          <select
            value={config?.config.autoUpdate ?? 'off'}
            onChange={async (e) => {
              const next = (e.target as HTMLSelectElement).value as 'off' | 'patch' | 'minor' | 'major';
              try {
                await api('POST', '/v1/config', { autoUpdate: next });
                setConfig((cur) => cur ? { ...cur, config: { ...cur.config, autoUpdate: next } } : cur);
              } catch { /* surfaced via msg banner if present */ }
            }}
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)', cursor: 'pointer' }}
          >
            <option value="off">{t('settings.autoUpdateOff')}</option>
            <option value="patch">{t('settings.autoUpdatePatch')}</option>
            <option value="minor">{t('settings.autoUpdateMinor')}</option>
            <option value="major">{t('settings.autoUpdateMajor')}</option>
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            {t('settings.autoUpdateHint')}
          </div>
        </div>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={Boolean(config?.config.enableAgenticOrchestration)}
              onChange={async (e) => {
                const next = (e.target as HTMLInputElement).checked;
                try {
                  await api('POST', '/v1/config', { enableAgenticOrchestration: next });
                  setConfig((cur) => cur ? { ...cur, config: { ...cur.config, enableAgenticOrchestration: next } } : cur);
                } catch { /* swallow — read-back will refresh on next load */ }
              }}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontSize: 13, color: 'var(--text-1)' }}>
                {t('settings.agenticLabel')}
              </span>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('settings.agenticHint')}
              </div>
            </span>
          </label>
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
