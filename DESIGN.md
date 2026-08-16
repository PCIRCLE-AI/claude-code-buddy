# MeMesh Design System

The dashboard's visual language, written down.

Everything below is derived from `dashboard/src/styles/global.css`, which
remains the implementation. When they disagree, the CSS is what ships — fix
whichever is wrong, do not leave them apart.

---

## Direction: VIVARIUM

A nocturnal glass vivarium. You are not operating an instrument panel; you
are looking in on a living second brain that grows while you are away. What
glows is alive. What is sealed in amber was preserved by a human hand. Total
stillness is the alarm.

Chosen 2026-08-16, superseding "Precision Engineer" (2026-04). The
discipline survives the direction change: decoration that carries no
information does not appear. What changed is what counts as information —
this product's memory is grown by machines while the human is away, so
recency, capture activity and liveness are first-class data, and the
interface renders them as light and motion. Three laws:

**Gradients carry information or they do not appear.** (Unchanged.) A
gradient is allowed only when the gradient *is* the data: the Graph drift
legend (stale red → fresh green is the scale it explains) and the
nav-overflow fade (the fade *is* the "more, scroll right" affordance).

**Luminance carries information or it does not appear.** Brightness and
glow encode vitality — recency and liveness. Nothing else may glow. This is
also why the night is neutral: if the ground, text and borders were all
green-tinted, green would stop carrying signal (the first draft of this
direction failed exactly that way — "too green").

**Every moving pixel tells a truth.** No idle or random animation. Every
animation is driven by a real event or real state, and the same data always
replays the same way. The single sanctioned idle animation is the heartbeat
(below), and it is honest: it runs only while the dashboard is actually
connected.

**Canvas cannot read a token.** `ctx.fillStyle = 'var(--life)'` is invalid
and silently draws black. The two `<canvas>` renderers resolve the tokens
they need from the live stylesheet via `getComputedStyle` and draw with the
resolved values — `GraphTab` once at mount, `MemoryTimeline` per draw — so
a palette change still reaches the canvas. Never hardcode a palette hex
into a canvas draw call; if `getComputedStyle` returns empty (no
stylesheet, e.g. a test), that is a visible signal, not a value to paper
over with a literal fallback.

---

## Tokens

**Never write a literal where a token exists.** A literal is invisible to a
palette change and cannot be checked. If a value is missing from this list,
add a token rather than a literal.

### Surfaces — the neutral night

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#09090A` | Page / substrate |
| `--bg-1` | `#0F0F11` | Panels |
| `--bg-2` | `#151518` | Raised surfaces |
| `--bg-card` | `rgba(15, 15, 17, 0.9)` | Cards over the page |
| `--bg-hover` | `#1B1B1F` | Hover state |
| `--bg-input` | `#0F0F11` | Form fields |

### Text — neutral, slightly cool

| Token | Value | Use |
|---|---|---|
| `--text-0` | `#EDEDEE` | Primary |
| `--text-1` | `#B4B5B7` | Secondary |
| `--text-2` | `#7E8083` | Muted / labels |
| `--text-3` | `#4B4D51` | Disabled / hints |

### Life, amber, and status

| Token | Value | Meaning |
|---|---|---|
| `--life` | `#8FF25C` | Bioluminescent green. Alive, machine-grown, recently touched. Actions, focus, active state |
| `--life-hover` | `#A9FF75` | Life hover |
| `--life-soft` | 8% life | Life fills (pair rule below) |
| `--amber` | `#E4C590` | The human seal: pinned, human-judged, human-preserved. Rings and small labels ONLY — never large fills, never body text |
| `--amber-soft` | 8% amber | The one amber fill: seal-label backgrounds |
| `--success` | = `--life` | Success is the normal state, by design |
| `--danger` | `#FF7A6B` | Errors, destructive actions |
| `--warning` | `#FFAB40` | Needs attention, not broken. Separated from amber by BOTH chroma and channel: warning is high-chroma and appears as fills/badges; amber is low-chroma and appears as rings/labels. The two never share a channel |
| `--info` | `#6FB7D9` | Neutral information |
| `--neutral-soft` | 10% grey | "No signal" / unknown status fill — deliberately grey; "unknown" must not read as alive |

Each status colour has a `-soft` variant at 8% for backgrounds. Use the
pair for **fills**, never a hand-rolled `rgba()` of the same hue.

**Hover glows and elevation shadows** are the one place a hand-rolled life
`rgba()` is allowed — `box-shadow`/`border-color` at 15–40% alpha, where no
8% `-soft` token fits the intent. The pair rule governs solid fills; a glow
is not a fill.

### Borders — neutral, so green can mean something

`--border` (`rgba(255,255,255,.08)`), `--border-subtle`
(`rgba(255,255,255,.04)`), `--border-focus` (solid `--life`). This reverses
the previous system's accent-tinted borders on purpose: when every hairline
is green, a green glow is noise; when the night is neutral, a green edge is
a statement. The focus ring is that statement.

### Species palette — one formula, not fourteen magic numbers

Entity-type colours are a separate categorical palette: the graph and its
legend colour nodes by type, and a single accent cannot encode a category.
They live in `dashboard/src/lib/type-palette.ts` and every value is the
output of ONE formula — `oklch(0.78 0.12 H) → hex` — with the hue recorded
beside each entry. Equal lightness and chroma mean no species shouts over
another. Anchors: `lesson_learned` 85 (earthy — amber differs by chroma),
`concept` 200, `pattern`/`technical_pattern` 230; the rest are spaced ≥25°
apart with the life band (~135°) left free. The values are written down
(rather than computed at runtime) because `tests/dashboard-i18n.test.ts`
parses that block as the type vocabulary.

The two types that coincide with a token are NOT in the palette file:
`decision` = `--life` (decisions are this brain's main produce) and
`session-insight` = `--text-2` (weak signal stays grey). GraphTab resolves
those from the tokens at runtime, so a palette change reaches them.

**Hue encodes species; luminance encodes vitality. The two channels never
compete.** **Amber is a state, not a species**: a pinned node keeps its
species fill and gains an amber ring/seal. Who grew it (species) and who
preserved it (human) are two questions answered on two channels.

### Type — three voices

| Token | Stack | Role |
|---|---|---|
| `--font-ui` | `'Bricolage Grotesque', -apple-system, system-ui, sans-serif` | UI chrome: labels, nav, buttons, table heads. Variable font — its optical-size axis keeps 11px labels sturdy while headings grow character |
| `--font-memory` | `'Newsreader', 'Songti TC', Georgia, serif` | Memory content itself (`.mem-preview` and successors): observations, titles. Memories are read, not scanned. 15px/1.6 — a serif needs the extra pixel to hold the same optical size. CJK falls back to the system serif |
| `--mono` | `'Geist Mono', 'JetBrains Mono', ui-monospace, monospace` | Anything the user might compare digit by digit: counts, scores, IDs, timestamps, tokens, file paths |

**Italic is epistemology.** In the memory voice, roman = captured verbatim;
italic = machine-inferred or condensed (dreamer output, auto-summaries).
The slant marks "testimony vs. conjecture" in the letterform itself. Never
use italic decoratively in memory content. (The italic wiring arrives with
the provenance field; the rule is constitutional now so no component ships
a decorative italic in the meantime.)

Fonts load via Google Fonts `<link>` in `dashboard/index.html`; offline,
the fallback stacks carry the page. There is no `--font` and no
`--font-mono` — referencing either silently produces a fallback font.
Base size is 14px on `html`.

### Radius

`--radius` 8px, `--radius-sm` 6px, `--radius-xs` 4px, `--radius-hairline`
2px for data-viz bars, tracks and 1–3px decorations.

Write the token, never the number: an inline `borderRadius: 6` is invisible
to a scale change exactly as a colour literal is.

**Two shapes are rounder, on purpose, and are sanctioned:**

- **Pills** (`border-radius: 9999px`) for status badges (`.badge`) and the
  feedback FAB (`.fb-btn`). This overrides "nothing rounder" for these two
  shapes only — everywhere else uses the scale.
- **Circles** (`border-radius: 50%`) for genuinely round elements: the
  status `.dot` and the `.loading` spinner.

### Motion tokens

| Token | Value | Use |
|---|---|---|
| `--t-heartbeat` | `3200ms` | Header liveness beat |
| `--t-germinate` | `450ms` | Single new-memory reveal |
| `--t-replay-max` | `2500ms` | Full germination replay budget |
| `--t-pulse` | `600ms` | One recall travelling one graph edge |

---

## The living mechanics

Each mechanic encodes real state; none is ornament. **Shipped now:** the
heartbeat, the serif memory voice, the species palette, the neutral night.
**Arrives with the UX arc** (each in its own PR, in this order): vitality
fade, bud marks, germination replay, mycelium pulse.

1. **Heartbeat** *(shipped)* — the header status dot breathes
   (`--t-heartbeat`, ease-in-out glow) only while `/v1/health` answers;
   disconnected renders a perfectly still error dot. Stillness IS the
   alarm; no red banner needs to fire first. Mapping the breath rate to
   capture-event frequency is the intended end state; the first
   implementation breathes at a fixed rate.
2. **Vitality fade** — every memory row and graph node will carry
   `--vitality: 0–1`, computed from the SAME freshness curve the recall
   engine uses for scoring, so the light in the UI and the score in the
   ranking are one number, not two truths. Scale: <1h full species colour +
   glow → <1d faint glow → <1w chroma −30% → <30d chroma −60% → >90d grey
   litter (faded, never hidden). Glow must never push text below WCAG AA
   ("green never on green": body text stays on the neutral text layers).
3. **Bud marks** — a 2px `--life` dot on rows/nodes created since the
   user's last visit (`last_seen` watermark), cleared on first sight.
4. **Germination replay** — on open, memories captured since the last
   visit stagger in (`--t-germinate` each, ≤`--t-replay-max` total) in true
   capture order, once, deterministically. Same data, same replay.
5. **Mycelium pulse** — when a real recall event fires, one light dot
   travels the graph edge (`--t-pulse`). An idle graph is still.

`prefers-reduced-motion`: every mechanic degrades to a static mark (glow,
dot, weight) — information kept, motion gone.

---

## Component patterns

Normative for the tab-consolidation arc; existing components migrate as
they are touched.

- **Chip** (shared): token-only styling. Inactive: `--border` border,
  `--text-2` text, transparent fill. Active: `--life` border, `--life-soft`
  fill, `--life` text. Radius `--radius`, 11px `--font-ui`, count in
  `--mono`. `aria-pressed` always.
- **Composition bar**: cluster segments coloured by the species formula,
  height 6px, `--radius-hairline`, on a `--bg-0` track. The bar itself is
  `aria-hidden`; its legend chips are the interactive, keyboard-reachable
  targets.
- **Expander row**: a chevron button with `aria-expanded` +
  `aria-controls`; the body renders lazily on first expand.

## The graph earns visibility; it does not distribute it.

Uniform brightness carries no information — a graph where every edge is
drawn at the same alpha is a hairball, and a graph where no node is named
until hover cannot be read. The renderer therefore ranks: a small backbone
of the highest-traffic edges (≤128, ≤5 per node) draws readable while the
rest recede (and are deterministically sampled on dense graphs) — re-picked
per view, so a filtered or ego neighbourhood keeps a bright skeleton
instead of falling entirely to the faint layer; node labels follow a
zoom-tiered budget (3/12/28) allocated by traffic-then-recency over the
nodes actually in view, at constant screen size regardless of zoom; node
radii stay inside a tight 3.5–9px band so hubs read as bigger without
dominating (ranking uses the raw recall counts, never the clamped radius);
each connected node gets a rim in its own hue stepped darker (category
restated at the boundary — not decoration; orphans keep their dashed
boundary); and label text is stroked in `--bg-0` — the canvas's own
background — before filling so it stays legible over nodes (legibility is
information, not a glow). Initial positions are seeded per type on a
golden-angle spiral with name-hash jitter, slotted by name order rather
than response order — the same data draws the same shape on every visit,
and the simulation relaxes instead of untangling. What was deliberately NOT
adopted from graph tools that look good (vignettes, ambient glows,
background grids): ornament that carries no information stays out, per the
direction above.

---

## Accessibility

These are requirements, not preferences.

- **Every error message needs a live region.** `role="alert"` or
  `aria-live="assertive"`. Text inserted into the DOM without one is
  announced to nobody.
- **Associate errors with their field**: `aria-describedby` pointing at the
  message, plus `aria-invalid` on the input.
- **Focus the obvious field on mount** when a screen has exactly one, and
  especially when the user did not choose to be there (the auth screen is
  reached by an involuntary 401).
- **Every state must be reachable and visible by keyboard.** Focus rings
  use `--border-focus`; do not remove them.
- **Do not rely on `required` for validation you also implement.** The
  browser blocks submission before the handler runs, which makes the
  handler's own message unreachable.
- **Motion degrades.** Everything under "The living mechanics" has a
  `prefers-reduced-motion` static form.

---

## Anti-goals (constitutional)

- **No leaves.** No plant illustration, particles, mascots. The metaphor
  lives in light, type and behaviour; draw a leaf and it becomes a toy.
- **No lying liveness.** No random idle animation, ever. "Looking busy" is
  the one sin an honest-memory product cannot afford.
- **No gamification.** No streaks, badges-as-achievements, scores for the
  human. The brain is not a pet game.
- **Single dark theme.** The vivarium is nocturnal. The token sheet stays
  complete (capability), the commitment is one look.

---

## Copy

Follows the same rule as error messages elsewhere in the project: say what
happened and what the reader can do. "That token was not accepted. Check it
and try again." — not "Authentication error".

All user-facing strings go through `t()` in `dashboard/src/lib/i18n.ts`, in
all 11 locales. **Never write `t('x') || 'English fallback'`**: `t()`
returns the key string on a miss, which is truthy, so the right-hand branch
is unreachable. The real fallback chain is inside `t()`: locale → English →
key.

`tests/dashboard-i18n.test.ts` fails the build when a statically-written
key is missing from the English catalogue, and when a locale drifts from
English. It cannot see template-literal keys (`` t(`radar.axis.${axis}`) ``)
— those need a fixed-key-set assertion if you add more.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-18 | Precision Engineer direction (Satoshi, cyan `#00D6B4`, zero decoration) | The product stores things people cannot afford to lose; reliability over personality |
| 2026-08-16 | VIVARIUM supersedes it | North star "a second brain, alive": memory here is machine-grown while the human is away, so liveness is data — rendered as light and motion. The no-uninformative-decoration discipline is retained and extended to luminance |
| 2026-08-16 | Neutral night ground | The first VIVARIUM draft tinted ground/text/borders green and the accent stopped carrying signal ("too green") |
| 2026-08-16 | Life accent `#8FF25C` | Chosen on a side-by-side preview over deep-sea teal, jelly pink and ice blue |
| 2026-08-16 | Species palette by formula | `oklch(0.78 0.12 H)` replaces nine hand-picked hexes; hue=species, luminance=vitality |
