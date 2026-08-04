# MeMesh Design System

The dashboard's visual language, written down.

`CLAUDE.md` has instructed every contributor to "read DESIGN.md before making
any visual or UI decision" and to "flag any code that doesn't match DESIGN.md
in QA mode" — while no such file existed. So the rule could not be followed and
could not be checked, and the drift it was meant to prevent happened anyway:
`--font-mono` was used in five places and is not a token (the palette defines
`--mono`), so those elements silently fell back to the browser's default
monospace or to the body sans-serif. Palette values were hardcoded where a
token existed.

Everything below is derived from `dashboard/src/styles/global.css`, which
remains the implementation. When they disagree, the CSS is what ships — fix
whichever is wrong, do not leave them apart.

---

## Direction: Precision Engineer

Chosen deliberately over two alternatives (a warm serif "Neural Organic"
direction and a green-phosphor "Retro Terminal" one). The product stores things
people cannot afford to lose, so the interface trades personality for the
appearance of reliability.

Practically that means: no decoration that does not carry information, no
gradients as ornament, no rounded-friendly shapes, no illustration. Dense,
quiet, and legible.

**Gradients carry information or they do not appear.** A gradient is allowed
only when the gradient *is* the data: the Graph drift legend (stale red → fresh
green is the scale it explains) and the nav-overflow fade (the fade *is* the
"more, scroll right" affordance). A gradient used as a card background is
ornament — flatten it to `--accent-soft`. Three banners shipped decorative
`linear-gradient` fills (`MemoryLoopCard`, `InsightsBanner`, `OnboardingBanner`)
and were flattened.

**Canvas cannot read a token.** `ctx.fillStyle = 'var(--accent)'` is invalid and
silently draws black. The two `<canvas>` renderers resolve the tokens they need
from the live stylesheet via `getComputedStyle` and draw with the resolved
values — `GraphTab` once at mount, `MemoryTimeline` per draw (its
`ResizeObserver` redraws on resize and tab-reveal) — so a palette change still
reaches the canvas. Never hardcode a palette hex into a canvas draw call; if
`getComputedStyle` returns empty (no stylesheet, e.g. a test), that is a visible
signal, not a value to paper over with a literal fallback.

---

## Tokens

**Never write a literal where a token exists.** A literal is invisible to a
palette change and cannot be checked. If a value is missing from this list, add
a token rather than a literal.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#080A0C` | Page background |
| `--bg-1` | `#0D1014` | Panels |
| `--bg-2` | `#14181D` | Raised surfaces |
| `--bg-card` | `rgba(20, 24, 29, 0.9)` | Cards over the page |
| `--bg-hover` | `#1A1F26` | Hover state |
| `--bg-input` | `#0D1014` | Form fields |

### Text

| Token | Value | Use |
|---|---|---|
| `--text-0` | `#F0F2F4` | Primary |
| `--text-1` | `#B8BEC6` | Secondary |
| `--text-2` | `#7A828E` | Muted / labels |
| `--text-3` | `#4A5260` | Disabled / hints |

### Accent and status

| Token | Value | Use |
|---|---|---|
| `--accent` | `#00D6B4` | The single accent. Actions, focus, active state |
| `--accent-hover` | `#00F0CA` | Accent hover |
| `--accent-soft` | 8% accent | Accent fills |
| `--success` | `#00D6B4` | Same as accent by design — success is the normal state |
| `--danger` | `#FF6B6B` | Errors, destructive actions |
| `--warning` | `#FFB84D` | Needs attention, not broken |
| `--info` | `#60A5FA` | Neutral information |
| `--neutral-soft` | 10% grey | "No signal" / unknown status fill |

Each status colour has a `-soft` variant at 8% for backgrounds. Use the pair
for **fills**, never a hand-rolled `rgba()` of the same hue.

`--neutral-soft` is deliberately grey rather than accent-tinted: a "no signal"
or "unknown" status must not read as the accent.

**Hover glows and elevation shadows** are the one place a hand-rolled accent
`rgba()` is allowed — `box-shadow`/`border-color` at 15–40% alpha, where no 8%
`-soft` token fits the intent. The pair rule governs solid fills; a glow is not
a fill. These already ship in `global.css` (`.card:hover`, `.stat:hover`,
`.dot-ok`, `mark`) and stay.

**Entity-type colours are a separate categorical palette.** The graph and its
legend colour nodes by type across ~14 types; a single accent cannot encode a
category. Those hues live in `dashboard/src/lib/type-palette.ts` as literals on
purpose — they map to no token, so a token could not express them. The five
that *do* coincide with a token (`decision`/`concept` = accent, `pattern` =
info, `lesson_learned` = warning, `session-insight` = text-2) are resolved from
the tokens at runtime, not written as literals, so a palette change reaches
them.

### Borders

`--border` (8% accent), `--border-subtle` (4% accent), `--border-focus`
(solid accent). Borders are tinted with the accent rather than grey — it is
what makes the surface separation read as deliberate rather than as a default.

### Type

| Token | Value |
|---|---|
| `--font` | `'Satoshi', -apple-system, system-ui, sans-serif` |
| `--mono` | `'Geist Mono', 'JetBrains Mono', ui-monospace, monospace` |

There is **no `--font-mono`**. Referencing one silently produces the fallback
in `var(--font-mono, monospace)`, or nothing at all in `var(--font-mono)` —
which is how four stat numbers rendered in Satoshi while every other stat in
the app used Geist Mono.

Use `--mono` for anything the user might compare digit by digit: counts,
scores, IDs, timestamps, tokens, file paths.

Base size is 14px on `html`.

### Radius

`--radius` 8px, `--radius-sm` 6px, `--radius-xs` 4px, `--radius-hairline` 2px
for data-viz bars, tracks and 1–3px decorations (they collapse to 2px — a 1px
difference is invisible at that scale, and one token beats three magic numbers).

Write the token, never the number: an inline `borderRadius: 6` is invisible to a
scale change exactly as a colour literal is.

**Two shapes are rounder, on purpose, and are sanctioned:**

- **Pills** (`border-radius: 9999px`) for status badges (`.badge`) and the
  feedback FAB (`.fb-btn`). The pill shape signals "tag / floating action"; it
  is established in the shipped UI, and the CSS is the implementation. This
  overrides "nothing rounder" for these two shapes only — everywhere else uses
  the scale.
- **Circles** (`border-radius: 50%`) for genuinely round elements: the status
  `.dot` and the `.loading` spinner.

---

## Accessibility

These are requirements, not preferences.

- **Every error message needs a live region.** `role="alert"` or
  `aria-live="assertive"`. Text inserted into the DOM without one is announced
  to nobody — the auth screen told a screen-reader user nothing at all when
  their token was empty or wrong.
- **Associate errors with their field**: `aria-describedby` pointing at the
  message, plus `aria-invalid` on the input.
- **Focus the obvious field on mount** when a screen has exactly one, and
  especially when the user did not choose to be there (the auth screen is
  reached by an involuntary 401).
- **Every state must be reachable and visible by keyboard.** Focus rings use
  `--border-focus`; do not remove them.
- **Do not rely on `required` for validation you also implement.** The browser
  blocks submission before the handler runs, which makes the handler's own
  message unreachable — a dead branch that reads as a safety net.

---

## Copy

Follows the same rule as error messages elsewhere in the project: say what
happened and what the reader can do. "That token was not accepted. Check it and
try again." — not "Authentication error".

All user-facing strings go through `t()` in `dashboard/src/lib/i18n.ts`, in all
11 locales. **Never write `t('x') || 'English fallback'`**: `t()` returns the
key string on a miss, which is truthy, so the right-hand branch is unreachable.
It reads as a safety net and is not one. The real fallback chain is inside
`t()`: locale → English → key.

`tests/dashboard-i18n.test.ts` fails the build when a statically-written key is
missing from the English catalogue, and when a locale drifts from English. It
cannot see template-literal keys (`` t(`radar.axis.${axis}`) ``) — those need a
fixed-key-set assertion if you add more.
