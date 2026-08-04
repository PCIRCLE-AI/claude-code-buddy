import { useState, useEffect } from 'preact/hooks';
import { api, type ConfigData, type ConfigTestResult, type UpdateStatusData } from '../lib/api';
import { t, setLocale, getLocales, type Locale } from '../lib/i18n';
import { actionFailureMessage } from '../lib/failure';

interface SettingsTabProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}

/**
 * The one field this tab reads past a `?.`: the load handler reads
 * `data.config.llm?.provider` and the behaviour card reads
 * `config?.config.autoUpdate` — the optional chain guards `config`, and the
 * read is one level further down, on `.config`. `{success: true, data: {}}`
 * satisfies every truthiness check and then throws exactly there.
 */
export function isConfigRenderable(c: ConfigData | null): c is ConfigData {
  return typeof c?.config === 'object' && c.config !== null;
}

/**
 * The fields the update summary BRANCHES on, not merely renders. A hollow
 * `{}` here does not crash anything — worse, it falls through every branch
 * and lands on "Up to date": a false green produced by a payload that said
 * nothing at all. Version strings and timestamps degrade to '—' harmlessly
 * and are deliberately not required.
 */
export function isUpdateStatusRenderable(u: UpdateStatusData | null): u is UpdateStatusData {
  return (
    typeof u?.checkSucceeded === 'boolean' &&
    typeof u.freshness === 'string' &&
    typeof u.updateAvailable === 'boolean'
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Human message for a failed provider probe. The server sends a stable
 * `errorCode` ('auth' | 'network' | 'no_models' | 'bad_host' |
 * 'http_<status>' | 'unknown') next to its English `error` prose — translate
 * the code (settings.testError.*) and keep the raw prose as the detail.
 * Miss-detection is the sanctioned `translated === key` check: t() returns
 * the key itself for uncatalogued keys, and `|| fallback` would treat a
 * legitimate empty translation and a missing one identically.
 */
function probeErrorMessage(result: { errorCode?: string; error?: string }): string {
  if (result.errorCode) {
    const httpMatch = /^http_(\d+)$/.exec(result.errorCode);
    const key = httpMatch ? 'settings.testError.http' : `settings.testError.${result.errorCode}`;
    const translated = httpMatch ? t(key, { status: httpMatch[1] }) : t(key);
    if (translated !== key) {
      return result.error ? `${translated} — ${result.error}` : translated;
    }
  }
  return result.error || t('settings.testFailed');
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
  // F17: track whether the saved config has an apiKey (server returns
  // '***' as a mask if one is stored, undefined otherwise). Used to gate
  // the "Remove provider" button so it only shows when there's actually
  // a credential to remove (not for ollama which is keyless).
  const [initialHasApiKey, setInitialHasApiKey] = useState(false);
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
      if (!isUpdateStatusRenderable(data)) {
        // The request SUCCEEDED, so no error path will ever log this — and a
        // hollow payload here would read as "Up to date", not as a failure.
        console.warn('[memesh dashboard] /v1/update-status answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
        if (!keepCurrentState) setUpdateStatus(null);
        return;
      }
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
        if (!isConfigRenderable(data)) {
          if (data !== null) {
            console.warn('[memesh dashboard] /v1/config answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', data);
          }
          setConfig(null);
          return;
        }
        setConfig(data);
        const p = data.config.llm?.provider || '';
        const m = data.config.llm?.model || '';
        setProvider(p);
        setModel(m);
        setInitialProvider(p);
        setInitialModel(m);
        // Server masks the key as '***' when one is stored. Empty/undefined
        // means no key on disk (e.g. ollama or fresh install).
        setInitialHasApiKey(!!data.config.llm?.apiKey);
      })
      .catch((e) => {
        // This chain had a .finally and no .catch, so a server that was simply
        // down became an unhandled rejection instead of a degraded tab.
        console.warn('[memesh dashboard] /v1/config failed to load:', e);
        setConfig(null);
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
    } catch (e) {
      setTestResult({ valid: false, error: actionFailureMessage(e) });
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
      // If the user just submitted a new apiKey for this provider, the
      // server now has it on disk — reflect that in the gate state so
      // the Remove button appears immediately without a page reload.
      if (apiKey) setInitialHasApiKey(true);
      setApiKey('');
      setTestResult(null);
      setInitialProvider(provider);
      setInitialModel(model);
    } catch (e) {
      setMsg(t('common.error') + ': ' + actionFailureMessage(e));
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
      setInitialHasApiKey(false);
      setTestResult(null);
      setMsg(t('settings.providerRemoved'));
    } catch (e) {
      setMsg(t('common.error') + ': ' + actionFailureMessage(e));
    } finally {
      setSaving(false);
    }
  }

  // Persist a single behaviour field and SURFACE the outcome. The autoUpdate
  // select and the agentic checkbox used to swallow POST failures in an empty
  // catch, so a failed write snapped the control back to its old value with no
  // explanation — the user thought it saved. Route both through the same msg
  // banner save()/removeProvider() use.
  async function saveField(patch: Record<string, unknown>, apply: (cur: ConfigData) => ConfigData) {
    setMsg('');
    try {
      await api('POST', '/v1/config', patch);
      setConfig((cur) => (cur ? apply(cur) : cur));
      setMsg(t('settings.saved'));
    } catch (e) {
      setMsg(t('common.error') + ': ' + actionFailureMessage(e));
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
          {/* Which model answers is as much a capability as which provider
              does — a user comparing digest quality needs it visible without
              opening ~/.memesh/config.json. Mono: it is an identifier. */}
          <div class="stat">
            <div class="stat-val" style={{ fontSize: 14, fontFamily: 'var(--mono)' }}>{caps?.llm?.model || '—'}</div>
            <div class="stat-lbl">{t('settings.model')}</div>
          </div>
        </div>
      </div>

      {/* LLM Config */}
      <div class="card">
        <div class="card-title">{t('settings.llmProvider')}</div>
        {/*
          #31 — explain LLM is OPTIONAL up-front. memesh's wedge is
          "strong recall with FTS5 alone, no LLM required". The Settings
          UI shouldn't make users feel they
          "must" pick a provider just because it's the most prominent
          card on this tab. Spell out exactly what stays available
          without an LLM, and what an LLM unlocks.
        */}
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 14,
            background: 'var(--bg-2)',
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
                {/* An empty key field is only a dead end when NOTHING is on
                    disk: POST /v1/config/test falls back to the stored key
                    when apiKey is omitted and the provider matches. Gating
                    the button on `apiKey === ''` alone forced users to
                    re-paste a key they had already saved just to re-test. */}
                <button
                  type="button"
                  class="btn"
                  onClick={() => void testConnection()}
                  disabled={provider === '' || testing
                    || (provider !== 'ollama' && apiKey === '' && !(initialHasApiKey && provider === initialProvider))}
                  title={initialHasApiKey && provider === initialProvider && apiKey === ''
                    ? t('settings.testStoredKeyHint')
                    : undefined}
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
              role={testResult.valid ? 'status' : 'alert'}
              style={{
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                background: testResult.valid ? 'rgba(0, 214, 180, 0.08)' : 'rgba(255, 107, 107, 0.08)',
                border: `1px solid ${testResult.valid ? 'rgba(0, 214, 180, 0.4)' : 'rgba(255, 107, 107, 0.4)'}`,
                color: testResult.valid ? 'var(--accent)' : 'var(--danger)',
              }}
            >
              {testResult.valid
                ? t('settings.testPassed', { count: testResult.models?.length ?? 0 })
                : `✗ ${probeErrorMessage(testResult)}`}
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
                {/* F17: Show Remove button only when a credential exists
                    on disk. Per the destructive-action UX pattern, hide it
                    when there's nothing concrete to remove. Ollama is keyless
                    so it doesn't show this button — users switch ollama by
                    picking a different provider radio, not by "removing". */}
                {initialHasApiKey && (
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
                {/* role: errors interrupt (alert), confirmations wait their
                    turn (status) — without either, a screen reader hears
                    nothing when Save succeeds or fails. */}
                {msg && (
                  <span
                    role={msg.startsWith(t('common.error')) ? 'alert' : 'status'}
                    style={{ fontSize: 12, color: msg.startsWith(t('common.error')) ? 'var(--danger)' : 'var(--success)' }}
                  >
                    {msg}
                  </span>
                )}
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
            <strong style={{ color: 'var(--danger)' }}>
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
              await saveField({ autoUpdate: next }, (cur) => ({ ...cur, config: { ...cur.config, autoUpdate: next } }));
            }}
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-1)', cursor: 'pointer' }}
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
                await saveField({ enableAgenticOrchestration: next }, (cur) => ({ ...cur, config: { ...cur.config, enableAgenticOrchestration: next } }));
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
            // Server-side counterpart: config.language decides what language
            // the LLM writes generated CONTENT in (dreamer digests, patterns,
            // lessons), which the client-side locale cannot reach. Post the
            // locale's display name ('繁體中文', 'Deutsch', …) — it lands
            // inside a prompt, and a native language name is unambiguous
            // where a bare code like 'th' is not. Non-blocking: the UI
            // language changed either way, and the next visit to Settings
            // shows the truth.
            const displayName = getLocales().find((l) => l.code === nextLocale)?.name;
            if (displayName) {
              void api('POST', '/v1/config', { language: displayName }).catch(() => {
                /* offline / auth lapse — UI locale still applied; not worth blocking */
              });
            }
          }}
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-1)', cursor: 'pointer' }}
        >
          {getLocales().map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
