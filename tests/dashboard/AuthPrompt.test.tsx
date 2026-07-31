// @vitest-environment happy-dom
//
// The half of the AuthPrompt fix that no other test reaches.
//
// `tests/dashboard-i18n.test.ts` covers its translation keys, and
// `tests/dashboard-design-tokens.test.ts` covers the `--font-mono` typo and the
// dead `t(...) || literal` branches. Neither can see what the fix was actually
// about: this screen told a screen-reader user nothing, and gave no feedback at
// all for a wrong token.
//
// Both failures are silent by construction — the page renders, the styling is
// right, and nothing throws. Only asserting the announced state catches them.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { AuthPrompt } from '../../dashboard/src/components/AuthPrompt';

describe('AuthPrompt', () => {
  function submitForm(container: HTMLElement) {
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
  }

  it('announces the empty-token error to a screen reader and links it to the field', () => {
    // `role="alert"` is a live region: without it the message is inserted
    // silently, focus stays on the button, and a non-sighted operator gets no
    // signal that anything happened at all.
    const { container } = render(<AuthPrompt currentToken="" onSubmit={vi.fn()} />);

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).not.toBe('true');

    submitForm(container);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent?.trim()).toBeTruthy();

    // The field has to be marked invalid AND point at the message, or the
    // announcement is not attached to anything the user can act on.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert!.id);
    expect(alert!.id).toBeTruthy();
  });

  it('gives feedback for a token the server rejected', () => {
    // Pasting a WRONG token used to produce nothing: the shell flashed, the 401
    // flipped back, and this remounted with the rejected token pre-filled and an
    // unchanged title. On a remote-bound deployment the operator could not tell
    // a bad token from a broken page.
    const { container } = render(<AuthPrompt currentToken="wrong-token" onSubmit={vi.fn()} rejected />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent?.trim()).toBeTruthy();
  });

  it('says nothing before the operator has tried anything', () => {
    // The contrast that gives the two cases above their meaning: an error
    // surface that is always present announces on every mount and trains the
    // user to ignore it.
    const { container } = render(<AuthPrompt currentToken={null} onSubmit={vi.fn()} />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('submits the trimmed token', () => {
    // The happy path, and the reason it is here: every other case in this file
    // asserts something did NOT happen. Delete the `onSubmit(value.trim())`
    // call from the component and all of them stay green — the dashboard would
    // be permanently unable to authenticate against a remote-bound server with
    // the whole suite passing. No other test imports this component.
    const onSubmit = vi.fn();
    const { container } = render(<AuthPrompt currentToken="" onSubmit={onSubmit} />);

    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '  a-real-token  ' } });
    submitForm(container);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('a-real-token');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not submit a whitespace-only token', () => {
    // `required` is deliberately absent from the input — with it the browser
    // blocks submission, so submit() never runs and the empty-state message was
    // unreachable for the very case its text names. The component's own check
    // has to cover both.
    const onSubmit = vi.fn();
    const { container } = render(<AuthPrompt currentToken="   " onSubmit={onSubmit} />);
    submitForm(container);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
