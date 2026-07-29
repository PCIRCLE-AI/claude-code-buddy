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
 *
 * Translation lookups here are bare, with no `|| 'English literal'` fallback
 * after them, deliberately. Such a fallback reads as a safety net and is not
 * one: the lookup returns the key string itself on a miss, which is truthy, so
 * the right-hand branch can never execute. When these five keys were genuinely
 * absent this file rendered `auth.title` at an operator and the fallback did
 * nothing to stop it. English is already the fallback inside the lookup
 * (locale -> en -> key), and `tests/dashboard-i18n.test.ts` fails the build if
 * a key used here is missing from the English catalogue. A second, unsynced
 * copy of the English string in JSX buys drift risk and no protection.
 *
 * That test scans source text rather than parsing it, so writing an example
 * lookup call in a comment makes it demand a key of that name. Describe, don't
 * demonstrate — hence the prose above.
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
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.intro')}</p>
        <label>
          <span>{t('auth.tokenLabel')}</span>
          <input
            type="password"
            autocomplete="off"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder={t('auth.tokenPlaceholder')}
            required
          />
        </label>
        {touched && !value.trim() && (
          <p class="auth-prompt-error">{t('auth.empty')}</p>
        )}
        <button type="submit" class="auth-prompt-submit">
          {t('auth.submit')}
        </button>
      </form>
    </div>
  );
}
