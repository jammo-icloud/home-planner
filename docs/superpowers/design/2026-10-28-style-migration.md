# Moving site/index.html onto the design language

Status: design, for the first engineering task. Companion to [`2026-10-28-design-language.md`](2026-10-28-design-language.md).

## At a Glance

- **It lands in three steps, each shippable:** link the tokens (nothing moves but the font), replace the hard-coded colours and sizes (the schemes start working), then rename and retire classes screen by screen as the planner's tasks touch each screen.
- **Step one changes almost nothing you can see,** because `tokens.css` maps the old names (`--ion`, `--quartz`, `--graphite`, `--emerald`, `--sand`, `--rose`, `--card`, `--bg`, `--radius`, `--shadow`) onto the new tokens. The visible changes are deliberate: true 600 headings, darker secondary and faint text that now passes contrast, and `--rose` becoming the accessible problem red.
- **The real work is 85 hard-coded colour literals** (30 distinct values) and **18 font sizes** in the `<style>` block. Until they become tokens, those rules ignore the scheme and dark mode.
- **Inputs are under 16px**, which is why iOS zooms the page when the reply box is tapped. Every input, select and textarea goes to `--fs-input`.
- **The tab bar moves outside the new `.hp` container** so it stays fixed to the screen. *(Superseded 2026-10-30: the owner replaced the bottom tab bar with icon tabs and a hamburger in the top bar, so nothing sits outside `.hp`. See the [design language's amendment](2026-10-28-design-language.md#amended-2026-10-30).)*
- **Retire:** the cream note bubble, every left-edge stripe, the dashed drop zone and "add" row, and Activity's styles if nothing still uses them.

## Step 1: link the tokens

In `<head>`, in this order:

1. The first-paint script from the design language ([How the tokens are delivered](2026-10-28-design-language.md#how-the-tokens-are-delivered)).
2. The font, changed from `satoshi@400,500,600` to the variable cut: `https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap`. Fontshare has no static 600, so today every 600 is synthesized.
3. `<link rel="stylesheet" href="/tokens.css">`.
4. Replace the single `theme-color` meta with two, one per `prefers-color-scheme`, set to each mode's `--surface`.
5. Delete the `:root { … }` block at the top of `<style>`; `tokens.css` now supplies those names.

What you will see change: headings render at a true 600; `--ink-soft` and `--ink-faint` are darker (the faint grey passed only 3:1); `--rose` resolves to `--problem` (#B0223E), which is darker than today's #E96B8A and now passes as text; `--sand` resolves to `--caution-line`, very close to today. Nothing else should move. If something does, it was relying on a value the old block had and the new one does not.

## Step 2: tokens for every literal

These replacements cover the values that recur. Every remaining hex is a judgment call in the same spirit: what is the colour *for*?

| Today | Becomes | Where it is now |
|---|---|---|
| `#a3243f`, `#8d2137` | `var(--problem)` | over-budget figures, errors, danger items, "missing" reasons (16 uses) |
| `#fdf0f3`, `#fdf7f8` | `var(--problem-tint)` | error boxes, short month, removed-receipt badges |
| `#f6d5de` | `var(--problem-line)` | error box borders |
| `#0a7a51` | `var(--good)` | hits, "covers", tie-outs (6 uses) |
| `#e7f7f0`, `#f0faf5`, `#f4fcf8` | `var(--good-tint)` | balanced month, tie-out, extra-payday rows |
| `#b9e7d2` | `var(--good-line)` | balanced month border |
| `#fffdf5`, `#fdf6e6`, `#fffaf0` | `var(--caution-tint)` | "needs" panels, outside-budget box, suggested import rows |
| `#f0e2bd`, `#f3e1b8` | `var(--caution-line)` | their borders |
| `#8a6516`, `#7a5b12`, `#6b5113`, `#8a6414` | `var(--caution)` | their text |
| `#fff`, `#ffffff` | `var(--surface-raised)`, or `var(--on-accent)` on a primary button | buttons, cards, inputs, the tab bar (11 uses) |
| `#fbfdff` | `var(--surface-raised)` | input backgrounds (inputs are no longer tinted; their edge is `--line-strong`) |
| `#cfe4fb` | `var(--accent-line)` | hover borders, the "new since" rule, member bubbles |
| `#e9edf4` | `var(--surface-sunken)` | the tab track |
| `#0a7ccb` | `var(--accent-fill-hover)` | primary button hover |
| `#f6f9fe`, `#e9f3ff`, `#f1f5fa`, `#dce6f3`, `#8a93a3` | `--surface`, `--accent-tint`, `--hair`, `--line`, `--ink-faint` | stray copies of old tokens |
| the three `rgba(23,25,31,…)` shadows | `var(--e-1)`, `var(--e-3)` | the old `--shadow`, the menu shadow |
| the composer's `rgba(246,249,254,0)` fade | `transparent` to `var(--surface)` | so the fade works in dark |
| the phone tab bar's `rgba(255,255,255,.97)` | `var(--surface-raised)` | so the tab bar goes dark with the page |

Then the type: map each of the 18 sizes to one of the eight roles.

| Today | Role |
|---|---|
| 11, 11.5, 12, 12.5 | `--fs-micro` (12). The phone tab labels may stay at 11. |
| 13, 13.5 | `--fs-small` (13) |
| 14, 14.5 | `--fs-ui` (14) |
| 15 | `--fs-body` (15) |
| any input, select or textarea | `--fs-input` (16), with no exceptions |
| 17, 18, 19, 20 | `--fs-title` (17) for section and pill titles; `--fs-headline` (21) for the briefing and the card page's title |
| 22 | `--fs-headline` (21) |
| 26, 30, 34 | `--fs-display` (30), for the one big figure on a screen |

After step 2 the four schemes and dark mode work across the existing screens. Check with the browser's inspector by setting `data-scheme` and `data-mode` on `<html>`, and run `python3 docs/superpowers/design/tools/contrast.py site/tokens.css` whenever a token value changes.

## Step 3: rename, restructure, retire

Do these as each screen is built in the planner's tasks, not as one sweep. [`components.css`](components.css) has the target rules; paste a section when its screen is built.

**Keep, restyled through tokens:** `btn`, `btn primary`, `field`, `err`, `quiet`, `eyebrow`, `menu-list`, `sheet`, `card`, `tray`, `filters`, `line`, `effects`, `decided`, `composer`, `list`, the envelope family (`env`, `env-head`, `env-left`, `bar`), `toassign`, `band`, `table.rows`, `pick`, `signin`, `hh`.

**Rename:**

| Today | Becomes | Why |
|---|---|---|
| `card offer`, `card decision` | `provisional` | One device for waiting on a person |
| `row` inside a card | `actions` | It is the action row; `row` is too generic to keep |
| `msg claude` and its `bubble` | `claude` | Claude's block, with its four channels |
| `msg member` | `msg mine` or `msg theirs` | Your words right in the accent tint; theirs left on plain card |
| `by` | `byline` (`claude-by` for Claude) | |
| `tnew`, `tday` | `newsince`, `day-head` | |
| `menu-btn`, `mb-name`, `mb-sub` | `pill`, `name`, `sub` | The household and member pills |
| `nav.tabs` | `tabs-top` on the desk, `tabbar` on the phone | Two components, not one restyled by a media query |
| `badge`, `tag hit`, `tag miss` | `chip` with a signal | One chip vocabulary |
| `prompt` | `banner` | Same job: what changed and what to do next |

**Restructure:** wrap the top bar and `<main>` in `<div class="hp">`, and put the phone tab bar, the More sheet and any scrim after it, outside. A query container becomes the positioning box for fixed children, so a tab bar inside `.hp` would pin to the bottom of the page instead of the screen. *(Superseded 2026-10-30: there is no tab bar, sheet or scrim any more; `.hp` wraps the top bar and `<main>` and nothing sits after it. Anything added later that is fixed to the screen still belongs outside `.hp`, for the same reason. See the [design language's amendment](2026-10-28-design-language.md#amended-2026-10-30).)*

**Retire:**

- `msg said-note`, the cream note bubble. Cream is now Claude's paper; a note is a member's words like any other, told apart by its by-line ("left a note").
- Every left-edge stripe: `card decision`, `card offer` and `card offer moved`, `act review` (both its border and its inset shadow), `prompt`. A stripe asked the reader to learn a colour; the replacements say it in structure or in words.
- The dashed `drop` zone and dashed `add-row`. Dashed now means only "waiting on a person". Both become solid (`dropzone`, and `rows .add` in lists). Import's dashed suggested rows (`tr.suggested select`) stay: they are suggestions waiting on a person, which is exactly the law.
- Activity's styles (`act`, `act-*`, `gone`, `day`) once nothing renders them; Activity folded into the thread.
- The legacy alias block at the end of `tokens.css`, once nothing in any app reads the old names.
