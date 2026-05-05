import { useState } from 'preact/hooks';
import { t } from '../lib/i18n';

interface Props {
  currentToken: string | null;
  onSubmit: (token: string) => void;
}

/**
 * Token entry surface shown when /v1/* returns 401.
 *
 * The server protects /v1/* with bearer auth whenever bound to a
 * non-loopback host. Browsers cannot attach an Authorization header on
 * the top-level navigation that loaded /dashboard, so the SPA must
 * collect the token AFTER load and inject it on every fetch call.
 *
 * The token is the same string the operator set via MEMESH_REMOTE_TOKEN
 * (or the file at <memeshDir>/remote-token). Stored in localStorage so
 * it survives page reload on the same origin. Cleared by entering an
 * empty value or by the operator rotating the token (the next 401
 * will reopen this prompt).
 */
export function AuthPrompt({ currentToken, onSubmit }: Props) {
  const [value, setValue] = useState(currentToken ?? '');
  const [touched, setTouched] = useState(false);

  function submit(e: Event) {
    e.preventDefault();
    setTouched(true);
    if (!value.trim()) return;
    onSubmit(value.trim());
  }

  return (
    <div class="auth-prompt-shell" data-testid="auth-prompt">
      <form class="auth-prompt-card" onSubmit={submit}>
        <h1>{t('auth.title') || 'Authentication required'}</h1>
        <p>
          {t('auth.intro') ||
            'This dashboard is protected by a bearer token. Paste the value of MEMESH_REMOTE_TOKEN (or the contents of <memeshDir>/remote-token) below.'}
        </p>
        <label>
          <span>{t('auth.tokenLabel') || 'Token'}</span>
          <input
            type="password"
            autocomplete="off"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder="paste token here"
            required
          />
        </label>
        {touched && !value.trim() && (
          <p class="auth-prompt-error">{t('auth.empty') || 'Token cannot be empty.'}</p>
        )}
        <button type="submit" class="auth-prompt-submit">
          {t('auth.submit') || 'Unlock dashboard'}
        </button>
      </form>
    </div>
  );
}
