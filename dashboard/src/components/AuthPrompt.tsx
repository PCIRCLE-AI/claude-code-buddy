import { useState } from 'preact/hooks';
import { t } from '../lib/i18n';

interface Props {
  currentToken: string | null;
  onSubmit: (token: string) => void;
  /**
   * True when a token was submitted and the server rejected it. Without this
   * the screen cannot distinguish "you have not entered a token yet" from
   * "the one you entered is wrong" — and it showed the same unchanged title
   * for both.
   */
  rejected?: boolean;
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
export function AuthPrompt({ currentToken, onSubmit, rejected = false }: Props) {
  const [value, setValue] = useState(currentToken ?? '');
  const [touched, setTouched] = useState(false);

  function submit(e: Event) {
    e.preventDefault();
    setTouched(true);
    if (!value.trim()) return;
    onSubmit(value.trim());
  }

  const showEmptyError = touched && !value.trim();

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
            // `required` is deliberately absent. With it, the browser blocks
            // submission on an empty field, so submit() never runs, setTouched
            // never fires, and the auth.empty message below was reachable only
            // for whitespace — never for the empty case its own text names.
            // That is the same dead-branch shape this file was fixed for.
            // The component's own check handles both.
            aria-invalid={showEmptyError}
            aria-describedby={showEmptyError ? 'auth-prompt-error' : undefined}
            // The only field on a screen the user arrives at involuntarily, via
            // a 401. Not focusing it makes them hunt for it before pasting.
            autofocus
          />
        </label>
        {showEmptyError && (
          // role="alert" so a screen reader announces it. Without a live
          // region the text is inserted silently, focus stays on the button,
          // and a non-sighted operator gets no signal that anything happened.
          <p class="auth-prompt-error" id="auth-prompt-error" role="alert">
            {t('auth.empty')}
          </p>
        )}
        {rejected && !showEmptyError && (
          // Pasting a WRONG token used to produce no feedback at all: the
          // shell flashed, the 401 flipped back, and AuthPrompt remounted with
          // the rejected token pre-filled and an unchanged title. On a
          // remote-bound deployment the operator could not tell a bad token
          // from a broken page.
          <p class="auth-prompt-error" role="alert">
            {t('auth.invalid')}
          </p>
        )}
        <button type="submit" class="auth-prompt-submit">
          {t('auth.submit')}
        </button>
      </form>
    </div>
  );
}
