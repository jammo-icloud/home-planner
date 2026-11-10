# Home Planner: the design language

Status: design, for review. Written 28 October 2026 against the brief of the same date and the three specs and four plans it names. Where this document and those disagree, they win, except for the three places listed under [Decisions taken against the documents](#decisions-taken-against-the-documents), which the owner approved on 28 October.

## At a Glance

- **One file, `site/tokens.css`,** holds every colour, size, space, radius, shadow and duration as a custom property, for Home Planner and for any other app on the NAS. It holds no component styles. See [Tokens](#tokens) and [How the tokens are delivered](#how-the-tokens-are-delivered).
- **Four schemes**, named for stones like the tokens the app started with: **Quartz** (the default, today's Ion blue), **Lapis**, **Iolite** and **Graphite**. Each is designed in light and dark. See [Schemes](#schemes).
- **A scheme changes the accent and the neutrals, nothing else.** Good, caution, problem, Claude, the provisional dash and the three calendar sources are fixed, tuned once per mode. That is why Alice in Lapis and Bob in Graphite read the same household with one set of signals. See [The core that never moves](#the-core-that-never-moves).
- **Stamped on `<html>`:** `data-scheme` and `data-mode`. An explicit mode beats the device; the device beats nothing; nothing is light. No attributes means Quartz, following the device.
- **The scheme lives in the household log** as a `scheme.set` event by the member, cached in `localStorage` for the first paint. It follows each of you to a new phone and is in the backup. See [Where the scheme preference lives](#where-the-scheme-preference-lives).
- **One visual law for proposals:** dashed means not real yet: a person still has to say yes, or a date is only an intention; solid means it happened or is settled. A decided card collapses to one line. Red means a problem and nothing else. See [Conventions](#conventions).
- **Claude is set apart by four channels everywhere it writes:** a mark, a by-line, a gold rule and its own paper. Humans never get those; Claude never gets the accent.
- **Calendar sources** are told apart by lightness, structure and a letter or mark, not by hue alone: yours solid, every other member a plum ring with their initial; two members whose initials match show two letters, Household a stone ring with a house. They survive every scheme and colour blindness. See [Source shades](#the-three-source-shades).
- **Phone first:** the board and the calendar week re-form on a phone rather than shrinking. Plan is one card of rows per area with the state as a glyph; the Calendar is a strip of days with marks over one day's card of rows; Today is one card per day. See [Layout](#layout).
- **The guest page** loads the same tokens with a place layer, `data-place="placitas"`: adobe neutrals, the sky blue of a New Mexico door, and a flat illustration of the Sandias. It never takes a member's scheme. See [The guest page](#the-guest-page-in-placitas).
- **Migration, not rewrite:** `tokens.css` carries the app's old token names as aliases, so it can land first and change nothing visible. The note [`2026-10-28-style-migration.md`](2026-10-28-style-migration.md) lists what to keep, rename and retire.
- **Satoshi has been a fake bold.** Fontshare has no static 600, so every heading in the app today is synthesized. Load the variable cut (`satoshi@1`). See [Type](#type).
- **Where to look:** the design canvas (17 frames: the system, conventions, every surface at phone and desk); [`components.css`](components.css), the reference component layer; [`mockups/`](mockups/index.html), plain HTML of every frame that loads `site/tokens.css`.

## Contents

1. [Decisions taken against the documents](#decisions-taken-against-the-documents)
2. [Tokens](#tokens)
3. [Schemes](#schemes)
4. [The core that never moves](#the-core-that-never-moves)
5. [How the tokens are delivered](#how-the-tokens-are-delivered)
6. [Where the scheme preference lives](#where-the-scheme-preference-lives)
7. [Type](#type)
8. [Space, shape, elevation, motion](#space-shape-elevation-motion)
9. [Conventions](#conventions)
10. [Components](#components)
11. [Layout](#layout)
12. [Settings](#settings)
13. [The guest page, in Placitas](#the-guest-page-in-placitas)
14. [Copy voice](#copy-voice)
15. [Answers to the brief's five questions](#answers-to-the-briefs-five-questions)
16. [What changes in the plans](#what-changes-in-the-plans)

---

## Decisions taken against the documents

Three, approved by the owner before design began. Everything else follows the specs and plans.

**A scheme restyles accent and neutrals only.** The brief asked for complete, distinct schemes and, separately, that every semantic rule hold in all of them. Those pull apart if a scheme can recolour everything: an amber accent would collide with caution and with Claude, a red one with problem. So the semantic signals are fixed and a scheme is an accent plus a family of surfaces and inks. Schemes still feel different, through accent hue, the temperature of the paper and how much contrast they carry; they never repaint an alarm. The cost is real and deliberate: no scheme may have a red, amber, green or gold accent.

**One law for provisional and committed, and red only for problems.** The current app encodes "waiting on a person" two ways: dashed in some places, a solid amber stripe on a proposal card. An approved card keeps the same stripe and changes only a caption, so a proposal and a decision look nearly alike. Red also means two things: an overspent envelope, and a proposed or clashing event. The language now has one device for waiting (the dashed edge), settles a decision into a single line, and keeps red for problems. The Doing clock, which the plan drew in red, is amber: elapsed time is not a problem.

**The board and the calendar re-form on a phone.** Both are specified as grids that read well on a desk and fall apart at 375 points. On a phone the board stacks each area's Planning and Doing lanes at full width, and the calendar shows one day at a time under a week strip. The desk keeps both grids as specified.

---

## Tokens

The full set is in `site/tokens.css`, documented inline. What follows says what each group is for. Use the name, never the number: a raw hex or pixel in a component is a component that will not follow the scheme.

**Surfaces.** `--surface` is the page; `--surface-raised` is a card, a sheet, the top bar; `--surface-sunken` is a well (inputs, the effects list on a proposal, the segmented-control track); `--surface-overlay` is a menu or sheet that floats. In dark mode surfaces get lighter as they come forward, which is how depth reads without shadows.

**Ink.** `--ink` for text that matters, `--ink-soft` for secondary lines, `--ink-faint` for timestamps and by-lines. All three pass 4.5:1 on every surface in every scheme and mode, faint included; today's `--ink-faint` (#8A93A3) does not, at 3:1.

**Lines.** `--line` divides rows and is decorative. `--line-strong` is the edge of a control (an input, a checkbox) and passes 3:1, which today's `--line` (#DCE6F3, 1.2:1) does not. `--hair` is the faintest rule, inside a card.

**Accent.** `--accent` is the scheme's colour for marks: focus, the selected tab's underline, the "now" line. `--accent-fill` is a primary button, `--accent-ink` is accent as text (links, counts), `--accent-tint` is a selected row and a member's own words in the thread, `--accent-line` its border, `--on-accent` the text on a fill. They are separate because the brand blue, #0C8CE9, fails 4.5:1 with white text (3.4:1). Quartz keeps Ion as the mark and fills buttons a shade deeper.

**Signals** (the [core](#the-core-that-never-moves)): `--good`, `--caution`, `--problem`, each with `-tint` and `-line`; `--claude-ink`, `--claude-mark`, `--claude-paper`, `--claude-line`; `--provisional`; the three source sets `--src-mine-*`, `--src-partner-*`, `--src-household-*`; `--hatch-line`.

**Scales**: type, space, radii, elevation, motion, and four layout widths (`--measure` 680px, the reading column; `--page` 1180px; `--gutter` 16px on a phone and `--gutter-wide` 32px from 760px; `--tap` 44px, the smallest target a thumb is asked to hit).

Every text and control pairing was checked across all eight scheme and mode combinations; none fails. The check is [`tools/contrast.py`](tools/contrast.py); run it against `site/tokens.css` whenever a value changes (`python3 docs/superpowers/design/tools/contrast.py site/tokens.css`).

---

## Schemes

| Scheme | Neutrals | Accent | In a sentence |
|---|---|---|---|
| **Quartz** (default) | cool blue-white | Ion blue | Today's app, made accessible. |
| **Lapis** | warm limestone paper | ultramarine | A little more notebook than screen; softer late at night. |
| **Iolite** | cool lavender-grey | indigo-violet | Quiet and even. |
| **Graphite** | neutral greys | ink | No hue but the signals, so the signals are all you see. |

Each scheme is drawn twice. Dark is designed, not inverted: Quartz dark is a deep blue-graphite, Lapis dark a warm near-black, Iolite dark a violet night, Graphite dark true charcoal. In dark, shadows give way to edges, and every accent lightens to hold contrast with dark text on it.

Graphite needs two rules the components already follow in every scheme: a link is told from text by its underline, never colour alone; and a selected thing is told by a filled or raised shape, never by a tint alone. Both are good practice anywhere; Graphite makes them load-bearing.

> **Discussion: why stones.** The app's first tokens were named for materials (ion, quartz, graphite, emerald, sand, rose). Naming the schemes the same way keeps the idea and makes the choice feel like picking a material rather than a theme. The names are also short enough for a radio button on a phone.

---

## The core that never moves

These tokens are set once for light and once for dark, before any scheme, and no scheme block may touch them.

**Good, caution, problem.** Emerald, amber and rose, as today, re-tuned so each passes 4.5:1 as text on every surface. Good and problem are the classic red-green pair that a deuteranope cannot separate by hue, so neither ever stands alone: good carries a check, problem a word ("over", "clashes") or an exclamation mark, caution a clock or the word "moved".

**Claude.** An ochre gold, used four ways and only for Claude: the mark (a four-point spark), the by-line in `--claude-ink` with the time and "as of", a gold rule around the block, and a faint gold paper. The paper is the weakest channel on purpose; on the warm Lapis surface it is close to the page, and the mark, by-line and rule carry it. Caution and Claude are both warm, which is why caution never appears as a large surface and Claude never appears as a small chip without its mark.

**Provisional.** One colour for the one dashed edge, readable at 3:1 on every surface and on Claude's paper.

**The three source shades** have their own section, next.

### The three source shades

Each calendar is drawn relative to whoever is looking, as the spec says: mine, partner, Household.

- **Mine**: solid, the darkest thing on the grid in light mode and the lightest in dark. No hue at all, so it cannot clash with any accent.
- **Another member**: a pale plum fill inside a plum ring, with their initial. Every member but the viewer shares it; there is no third colour.
- **Household**: a pale stone fill inside a stone ring, with a small house.

A state glyph or lane icon drawn on a source fill takes that fill's ink, never the accent.

The same treatments mark a person anywhere in the app. The owner disc on a board card is mine-solid or partner-ringed, so "Bob's" looks the same on a card, in a rail and on the grid.

They survive colour blindness by design rather than luck. Mine is separated from the other two by lightness, which every kind of colour blindness keeps. Plum against stone sits on the blue-yellow axis, which protanopes and deuteranopes keep; simulated, their perceptual distance stays above 56 (on a scale where 2 is just noticeable). Only tritanopes, about one person in ten thousand, lose most of that difference, and there the initial and the house carry it. The system sheet on the canvas shows the three under all three simulations and in greyscale.

---

## How the tokens are delivered

**One file**, `site/tokens.css`, loaded with a `<link>` by each app. It contains custom properties and nothing else, so any other app on the NAS can load it and get the household's colours, type scale and spacing without inheriting Home Planner's components.

**Two attributes on `<html>`:**

- `data-scheme`: `quartz`, `lapis`, `iolite` or `graphite`. Absent means Quartz.
- `data-mode`: `light` or `dark`. Absent means follow the device.

Resolution is exactly the brief's: an explicit mode beats `prefers-color-scheme`, which beats nothing, which is light. An un-stamped page is Quartz in the device's mode, and that is also precisely what a guest sees on a page that never stamps a scheme.

**How the cascade works.** Every rule is wrapped in `:where()`, so every rule has zero specificity and the order in the file decides. Base light, then base dark for the device, then base dark when chosen; then each scheme the same three ways. Component styles, being ordinary class selectors, always beat token rules, which is the point: components read tokens, they never redefine them.

**Each scheme's dark values appear twice**, once inside the media query and once under `[data-mode="dark"]`. Plain CSS cannot share one block between the two. The file says so beside each pair. When every device in the house, guests' included, runs Safari 17.5 or later, the CSS `light-dark()` function can fold each pair into one; until then the guest page is the reason not to.

**Scoping.** Both attributes work on any element, not just `<html>`, which is how the mockups show two schemes side by side. A scoped element must carry both.

**First paint.** A short inline script at the top of `<head>`, before the stylesheet, reads the cached choice and stamps `<html>`, so the page never flashes the wrong scheme:

```html
<script>
  try {
    const a = JSON.parse(localStorage.getItem('hp.appearance') || '{}');
    if (a.scheme) document.documentElement.dataset.scheme = a.scheme;
    if (a.mode === 'light' || a.mode === 'dark') document.documentElement.dataset.mode = a.mode;
  } catch {}
</script>
```

Add two `theme-color` metas, one per `prefers-color-scheme`, so the iPhone's status bar matches.

**The old names stay working.** The last block of `tokens.css` maps `--ion`, `--quartz`, `--graphite`, `--emerald`, `--sand`, `--rose`, `--card`, `--bg`, `--radius` and `--shadow` onto the new tokens. The file can therefore land before a single component changes, and scheme and mode work on the old styles from day one, to the extent the old styles use tokens at all (see the migration note for the 85 that do not).

> **Discussion: the other apps.** They cannot read the household log, and they may sit on another origin, so `localStorage` does not carry across. If they live under the same parent domain, Home Planner can also write a small first-party cookie (`hp-appearance=lapis.dark`, `Path=/`, the parent domain, not HttpOnly) when the scheme changes, and each app copies the same six-line first-paint script with the cookie as its source. That is optional, and each app works without it as plain Quartz following the device.

---

## Where the scheme preference lives

**Recommendation: a `scheme.set { scheme, mode }` event in the household log, by the member, cached in `localStorage` for the first paint.**

The app already keeps per-member state in the log (each member's read cursor, each member's conflict calendars), and this belongs with it. It follows a member to a new phone, which is the moment `localStorage` alone fails: the first morning on a new iPhone would open in the wrong colours and stay that way until someone found Settings. It is in the backup and restores with everything else. It is attributed, so the history says who changed what. It costs one event per change, which for a preference touched a few times a year is nothing.

The cache is what keeps it fast. Replay is not on the first-paint path; the inline script stamps from the cache, the app replays as usual, and if the log disagrees with the cache (a change made on another device) the app re-stamps and refreshes the cache. At worst that is one visible change on the first load after switching on another device.

`mode` stores the member's choice of `light`, `dark` or `match` ("match this device"), not the resolved mode, so "match" naturally means different things on a phone set to dark and a laptop set to light. The event's restore scope sits wherever the member's conflict calendars sit; engineering's call.

---

## Type

**Satoshi, three weights: 400, 500, 600.** Load the variable cut:

```
https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap
```

Fontshare publishes Satoshi in 300, 400, 500, 700 and 900, and no static 600. The app's current request (`satoshi@400,500,600`) returns two faces, and the browser synthesizes every 600 heading by smearing the 500. The variable cut is one file of about 43 KB with a true 600, and it is the fix the migration should make first.

| Role | Size | Weight | Used for |
|---|---|---|---|
| display | 30 | 600 | One figure per screen at most: left to assign |
| headline | 21 | 600 | The briefing's headline; a plan card's title |
| title | 17 | 600 | Section titles, area names, the household pill |
| input | 16 | 400 | Anything typed into. Never smaller: below 16px iOS zooms the page on focus, which is what happens on the reply box today |
| body | 15 | 400 | Reading text: the thread, notes, card bodies |
| ui | 14 | 500 | Buttons, menu items, list rows |
| small | 13 | 400 | Secondary lines, effects, quiet changes |
| micro | 12 | 500 | By-lines, timestamps, chip text |

Eight roles replace the eighteen sizes the stylesheet uses today (12.5, 13.5, 14.5 and 11.5 among them). Headlines and titles take a slight negative tracking; nothing else does. The only uppercase in the app is the eyebrow, which names a group. Figures are tabular everywhere, so money and times line up.

---

## Space, shape, elevation, motion

**Space** steps by four: 4, 8, 12, 16, 20, 24, 32, 40, 56. Components use the names (`--sp-1` to `--sp-9`).

**Radii**: chip 6, control 10, card 12, sheet 16, pill for filters and the tray.

**Elevation** is three steps: a card (a hairline and a whisper of shadow), a popover, a sheet. In dark mode shadows nearly vanish and surfaces lighten instead.

**Motion** is three durations, 120, 180 and 260 ms, on one easing. Nothing animates for delight; motion only says where something went. Under reduced motion all three are zero in the token file itself, so no component has to remember.

---

## Conventions

These answer the brief's section 5, and they hold in every scheme. The canvas's conventions sheet draws each one.

**A proposal** is a card a person must approve: from Claude (in a briefing or an answer), from a member (an ask to take a plan), from a guest (a booking), or from the app (drift). It always has a **dashed edge**, a small "Waiting for you" or "Waiting for either of you" line above its title, its effects in a sunken list, and its actions. A Claude proposal sits on Claude's paper; every other proposal sits on plain card. The dash is the same either way: the provenance is the paper, the status is the dash.

**A decision** is never a card. Approving, declining or putting off collapses the card in place to **one line**: an icon (a green check, a cross, a clock), what it was, who, when, and the reason in quotation marks. "Move $110 from Travel to Vehicle. Approved by Bob, 7:41, 'The trip is paid for.'" A put-off line also says it comes back if its numbers change.

**When the numbers moved**, the card stays dashed, says so in caution amber, and offers "Work it out again" in place of Approve.

**A suggestion from Claude inside research** (a contact, a due date) is a small dashed row on Claude's paper with two short verbs, such as Add and Skip. It is never drawn in the place the accepted thing will appear. Until accepted, the contact is not in People and the date is not in When.

**Claude's text, everywhere it appears**, wears all four of its channels: mark, by-line, gold rule, paper. That includes the briefing, answers, research on a card, and the "Claude added research" line in a card's history (which takes the by-line style). A briefing written without Claude says so in its by-line and drops all four.

**A due date** is a date, not time set aside: a **dashed** chip with a calendar glyph, and on the calendar a dashed all-day marker. **A block** is time set aside for a plan: a **solid** chip with a clock glyph, and on the calendar a solid timed event in its calendar's shade that opens its card. **An appointment** is any timed event, possibly linked to a plan: solid, in its calendar's shade. Due is dashed because it is an intention, which is the same reason a proposal is.

**On the calendar**, a proposed event (from a card nobody has approved) is hollow and dashed in the accent. Drift (a plan and its event disagree) is an amber ring offset from the event, and the event says "moved" in words. A clash is a red ring: the only red on the grid. Held nights (a guest's stay or a member's block) are hatched and never say why.

**Handed, not asked.** A plan changes hands at once, and Today says who moved it, from whom, to whom and why. Nothing on Plan is dashed for it. An ask from before 0.7.0 keeps its dashed card on Today until it is answered or the plan moves.

**The Doing clock** is an amber chip with a clock, "3 wks", and appears only in Doing and only from 14 days. Nothing in Planning ever shows an age, and nothing about time is ever red.

**Empty states** say in one sentence what would be here, in the app's own words, and offer at most one button, only when there is one obvious first step. "No one is linked to this card yet." with "Link someone from Contacts". "Nothing in Doing in Trips." with nothing.

**The error box.** One per screen, directly under the top bar and above everything else on that screen, cleared when the screen changes (as today). It says what happened and then what to do, in that order: "The due date wasn't saved. The NAS didn't answer, so nothing changed on the plan or the calendar. Try again in a minute." A section that is off for a reason is not an error and does not use the box: "Calendars need you to sign in again. The budget and your plans still work." sits in place, in a quiet grey panel with a lock.

**Dashed is reserved.** Nothing else has a dashed edge: drop zones, add rows, the desk's "A new area" column and a read-back before a change are solid. The Planning glyph is a dashed circle, which says the same thing in small: not begun. Import's suggested rows, already dashed today, are correct under the law and stay.

---

## Components

The reference layer is [`components.css`](components.css). It is not loaded by the app; the migration pastes it into `site/index.html`'s one `<style>` block, section by section, as each screen is built. It reads only tokens. Its header explains one rule worth repeating here: the layout responds to the width of a container (`.hp`), not the window, and because a query container becomes the positioning box for fixed children, the phone tab bar, the More sheet and the scrim are siblings of `.hp`, not inside it. *(Superseded 2026-10-30: there is no tab bar, sheet or scrim now, so nothing sits outside `.hp`; see [the amendment](#amended-2026-10-30).)*

The vocabulary, by job:

- **Shell**: `top`, `pill` (household and member), `tabs-top` (desk), `tabbar` (phone, five slots), `menu-list` and `menu-item`, `more-sheet`, `scrim`, `page-head`, `back`. *(Superseded 2026-10-30: `tabs-top` serves both widths; `tabbar`, `more-sheet` and `scrim` are retired. See [the amendment](#amended-2026-10-30).)*
- **Controls**: `btn` (`primary`, `bare`, `small`, `danger`), `link`, `field` and `input`, `check`, `seg` (segmented: the chosen option is a raised shape), `filters`.
- **People and chips**: `who` (`mine`, `partner`; gains `other`, `household`, `claude`), `chips` and `chip` (`due`, `block`, `stale`, `research`, `money`, `asked`, `moved`).
- **Waiting and settled**: `provisional` (with `waiting`, `why`, `effects`, `moved-note`), `decided`.
- **Claude**: `claude` (the block), `byline` (`claude-by`, `mark`, `asof`), `looked`.
- **Today**: `today` (three regions), `brief`, `briefing`, `day-head`, `newsince`, `msg` (`mine`, `theirs`), `line` (`flag`), `yours` and `rail`, `composer`, `tray`. From 0.8.0 this becomes: `today` (three regions), `brief`, `briefing`, `yours` and `rail`, `composer`, `day`, `ent`, `seg people`, `tnew`.
- **Plan**: `area`, `erow plan`, `erow add`, `erow fold`, `st`, `list`; on the card `crumb`, `plan-head`, `plan-title`, `plan-body`, `plan-main`, `plan-side`, `sec-head`, `md`, `checklist`, `files` and `file`, `dropzone`, `kv`, `person`, `notes-list`, `history`, `askrow`.
- **Calendar**: `cal-bar`, `legend` and `sw`, `ev` (`mine`, `partner`, `household`, `proposed`, `drift`, `clash`, `due`, `held`), `week` (desk), `daystrip` and `dayview` (phone). From 0.9.0 this becomes: `cal-bar`, `marks`, `erow cal`, `ev` (`mine`, `partner`, `household`, `proposed`, `drift`, `clash`, `due`, `held`), `week` (desk), `daystrip` (phone).
- **Settings**: `settings`, `set-index`, `set-group`, `set-sec`, `rows` and `rowi`, `schemes` and `scheme`, `readonly`, `state-on`.
- **Errors and empties**: `err`, `unavailable`, `empty`.
- **Guest**: `guest`, `letter`, `letterhead`, `banner`, `month-bar`, `nights` and `night` (`taken`, `pending`, `confirmed`, `inrange`), `key`, `request`, and for the place layer `landscape`, `place-line`, `fence`, `know`.

One naming rule came out of building the mockups: **a modifier never shares a name with a block.** Two collisions surfaced (a "research" chip named `claude` picked up the Claude block's padding, and the calendar's current day named `today` picked up the Today page's grid) and both were renamed. Use `is-` for states (`is-today`) when a plain name is taken.

---

## Layout

Each surface is drawn on the canvas at phone (390) and desk (1280), in two schemes, light and dark between them, and exported to [`mockups/`](mockups/index.html). The element lists below are the plans'; what is added is placement.

**The shell.** Desk: Today, Plan, Calendar, Budget and More in the top bar, the chosen tab underlined in the accent; the household pill and the member pill at the right. Phone: the household pill and the member disc in the top bar; the five tabs at the bottom where a thumb is, More being the fifth. *(Superseded 2026-10-30 on a phone; see [the amendment](#amended-2026-10-30).)* The household pill opens the household menu, whose first item is Settings. Budget's own sub-tabs (Budget, Import, Compare) sit as a segmented row at the top of Budget.

<a id="amended-2026-10-30"></a>
> **Amended 2026-10-30: on a phone the screens are icons in the top bar.** The owner replaced the bottom tab bar. The phone's top bar now reads, left to right: the household pill; Today, Plan, Calendar and Budget as icons (Lucide's sun, square kanban, calendar and wallet, each keeping its name for a screen reader), the chosen one underlined in the accent as on the desk; More as a hamburger; and the member disc. The bar stays at the top as the page scrolls, and the hamburger opens the same menu as More on the desk: the links that leave Home Planner, then changing them in Settings, then Settings. The desk is unchanged.

**Today.** The briefing is the page: first, widest, the largest type, on Claude's paper. On a phone the order is the briefing (with its cards and any decided lines), then **Yours**, then the rest of the day's thread, the waiting tray and the reply box. Yours holds the three rails as hairline lists inside one quiet card, labelled "Yours · what the briefing was written from", because three boxes under the briefing is the widget failure the spec warns about. On the desk Yours becomes its own column beside the thread, sticky, so the shared conversation and each member's own layer sit side by side and never interleave. This is the spec's "shared Today is not personal Today" made spatial. The reply box sticks to the bottom; the tray sits on it and counts what waits.

**The Plan board.** Desk: area labels down the side, Planning ("no clock") and Doing ("the clock runs") across, a shelf as a full-width solid strip under its area's cards, "holds 4", opening the shelf's page. Phone: each area is a section; inside it Planning, then Doing (with a clock glyph), each card at full width; the shelf strip last. Filters (Both, Mine, Bob's, Show done) and New sit above both.

**The Plan card.** Desk: crumb, title, then a row of facts and actions (the Planning/Doing segment, Mark done, the owner, Ask the other member to take it, Due date, Block time) and the card's chips. Main column: Notes, Checklist, Attachments, Claude, Between us. Sidebar: Money, People, When, History. Phone: the same order, except When and Money move up into one compact card under the title, because on a phone they are the facts you opened the card to check. The ask button appears only for the owner.

**The Calendar.** Desk: the seven-day week, 7:00 to 21:00, the all-day row as one strip so a span can cross days, today's column tinted and marked by the accent "now" line, a legend, Block nights and New event. Phone: the month and week arrows, a strip of seven days with a dot per source under each, the chosen day as a full-width timed column with its all-day markers above, and a compact legend.

**Settings** is described in its own section below. **The guest page** likewise.

> **Discussion: More on a phone is a sheet, not a row.** A row of links beside four tabs would make the photo library a peer of Today, and it is not: the links leave Home Planner. So More is the fifth tab and opens a sheet headed "These leave Home Planner", each link with a leaving glyph, and "Change these links" at the bottom. On the desk it is the same list as a menu under More. *(Superseded 2026-10-30 by a hamburger and a menu; the reasoning about the links still holds, and the menu keeps the heading. See [the amendment](#amended-2026-10-30).)*

---

## Settings

One screen, reached from the household pill, in two groups that say whose they are.

**Yours** (only you see these; the other member keeps their own):

- **Appearance**: the four schemes as real previews (each tile is stamped with its own scheme, so it shows the true colours), and Light, Dark or Match this device. The hint says the choice follows you to every device and is in the backup.
- **Calendars I check for conflicts**: your calendar and Household, always checked and disabled; then each calendar a partner has shared with you, read only, as a checkbox with "Shared with you by Bob, read only" beneath.

**The household's** (you both see and change these; every change is in the history):

- **Areas**: an editable list with a drag handle, each with its plan count, Rename, and Remove only when empty; "An area with plans in it can't be removed until they move."
- **Links under More**: label and URL, Edit, Remove, Add a link.
- **Household calendar**: which calendar receives plan events, who it is shared with, and Use another calendar. The hint says it is the only calendar the shared briefing reads.
- **Guests**: whether booking is on (or which variable is missing, for members only), the list of allowed addresses with how you know them and Remove, and an inline form to add email, name and reason.
- **Attachments**: read only, in a grey panel with a lock: on or off, the folder, the size cap, and that it changes in the deployment.

Desk adds a sticky index of the sections on the left; phone stacks them with a Done button at the top.

---

## The guest page, in Placitas

The guest page loads `tokens.css` like everything else, and never takes a member's scheme: a guest has no preference to read, and a member's scheme is personal, not the house's. Instead `book.html` stamps a **place layer**, `data-place="placitas"`, which follows the scheme contract exactly (accent and neutrals only) and adds a set of `--place-*` colours for illustration. Because the core is untouched, a taken night, a pending request and a confirmed stay mean on the guest page what they mean in the app: hatched, dashed, solid.

Everything in the layer comes from the place:

- **The neutrals are natural adobe and caliche**, the soft beige walls and pale desert soil.
- **The accent is the sky blue of a northern New Mexico door.** Doors and trim there are painted the blue of a cloudless sky straight overhead, and the tradition pairs it with natural adobe. Your confirmed nights are that blue, so the colour of the door is the colour of a yes.
- **The illustration is the Sandias from the north**, in flat layered silhouettes in the manner of the old New Mexico travel posters, with no photography. The mountains are pink because the granite is: potassium feldspar in the Sandia granite gives them their colour, and "sandía" is watermelon. A band of individual small conifers runs along the crest, the green rind of the watermelon image, over ravines cut down the granite. Below are caliche hills and piñon-juniper savanna, the vegetation of the foothills at Placitas' 5,955 feet. In the foreground is a small adobe with vigas, a coyote fence and a blue door. In light mode it is watermelon hour, the sun going down behind the mountain's north end. In dark mode it is night: a deep sky with stars, the mountain gone plum, and one warm window lit.
- **A coyote fence** of uneven latillas is the page's divider.
- **The letterhead** names the place ("Placitas, New Mexico · 5,955 feet") above the page's headline, and the household's name below it.
- **"Before you come"** carries what a guest actually needs from the place, in the app's voice: that it sits at almost 6,000 feet, so layers and water; that free-roaming horses graze the ridges, so give them room and don't feed them; in December, that farolitos line the walk to the San Antonio Mission for Las Posadas on Christmas Eve; and that the address comes with the confirmation email. The page shows no address, consistent with the booking spec.

The composition stays a letter, not a workspace: one centred column on a phone, two columns on a desk (the month and your requests; the form and "Before you come"), large night targets, no member chrome.

> **Discussion: what the theme deliberately leaves out.** Placitas has well-known petroglyphs, including what is thought to be an Avanyu, the Pueblo water serpent. They are not used as decoration: they are sacred imagery, not ornament for a booking page. The granite pink is also close in hue to the problem colour, which is acceptable only because it is confined to the illustration; no `--place-*` colour may be used on anything a guest reads or touches.

Sources for the place: the Sandia Mountains' geology, name and vegetation zones ([Wikipedia](https://en.wikipedia.org/wiki/Sandia_Mountains)); Placitas' elevation and land-grant history ([Wikipedia](https://en.wikipedia.org/wiki/Placitas,_Sandoval_County,_New_Mexico)); the horses, the San Antonio Mission's Las Posadas, the open space and the light ([New Mexico Magazine](https://www.newmexicomagazine.org/blog/post/best-things-to-do-in-placitas-new-mexico/)); the blue-door tradition and its pairing with adobe ([Taos News](https://www.taosnews.com/stories/one-door-two-doors-three-doors-blue-doors,43449)).

---

## Copy voice

The app's existing voice, kept: plain, direct, specific, no exclamation marks, no "oops", no "please try again later" without a reason. Name the thing and the person. Say what happened, then what to do. Prefer the household's words to the system's: "Bob moved the vet to Tuesday on his phone", not "Calendar event updated externally". Numbers in sentences are the engine's, never rounded into vagueness ("about $110" only when the briefing says "about"). Times are local and short ("7:41", "Tue 10:30"). A guest is spoken to warmly but with the same plainness: "If that address is one we know, a link is on its way."

---

## Answers to the brief's five questions

1. **Three source shades.** Mine solid and hueless, partner a plum ring with an initial, Household a stone ring with a house; separated by lightness, by the blue-yellow axis and by a letter or mark, so they hold across schemes, modes and colour blindness. [Detail](#the-three-source-shades).
2. **The chip system.** One vocabulary: owner as a disc (mine solid, partner ringed); free text neutral; due dashed with a calendar; block solid with a clock; stale amber with a clock, Doing only; research gold with the Claude mark; money with the envelope and what is left, red only when over; asked dashed with an arrow; moved amber. Scheme-independent because every one is drawn from the core. [Detail](#conventions).
3. **Where the scheme preference lives.** In the household log as `scheme.set` by the member, cached in `localStorage` for the first paint. [Detail](#where-the-scheme-preference-lives).
4. **How the guest page shares tokens without looking like the app.** It loads the same file, never takes a member's scheme, and stamps a place layer that changes only the accent and neutrals and adds illustration colours; its composition is a letter with a landscape, not a workspace with chrome. [Detail](#the-guest-page-in-placitas).
5. **More on a phone.** A menu, presented as a sheet from the fifth tab, labelled as leaving the app. [Detail](#layout). *(Superseded 2026-10-30: the same menu as the desk's, from a hamburger in the top bar; see [the amendment](#amended-2026-10-30).)*

---

## What changes in the plans

Engineering will find these differences from the element lists in the plans. Each follows from one of the three approved decisions.

- **Plan app, task 5.** The Doing age chip is amber (`chip stale`), not red. A shelf is a solid sunken strip, not a dashed one. On a phone the board renders per area with stacked lanes; the 96px grid is the desk layout (here 132px, to fit "People" with its count). A card whose plan was asked of you uses `bcard provisional`.
- **Calendar and Today, task 4.** The drift card is a `provisional drift` card with the moved chip; its three buttons are as specified.
- **Calendar and Today, task 7.** The rails render inside one "Yours" container, below the briefing on a phone and in their own column on a desk.
- **Calendar and Today, task 8.** A proposed event is dashed in the accent, not outlined in red; drift is an amber ring with "moved" in words; a clash is the red ring. On a phone the view is a day under a week strip.
- **Calendar and Today, task 9.** More is a sheet on a phone *(superseded 2026-10-30: a menu from a hamburger; see [the amendment](#amended-2026-10-30))*. Settings has the Appearance section, which also needs the `scheme.set` event and its route.
- **Booking, task 7.** `book.html` stamps `data-place="placitas"` and uses the guest components. The plan says to copy the `:root` block so the page stands alone; with the place layer that copy grows to the Placitas block plus the core, in light and dark.

> **Discussion: copy the tokens, or link them?** This one is engineering's call, not a decision taken here. Linking `site/tokens.css` keeps one source of truth; the file is static and served beside `book.html`, so the page still stands alone in every sense but the literal one. Copying keeps the guest route free of any shared asset, at the price of a fork that must be updated by hand whenever the core changes. If it is copied, copy the core and the Placitas blocks together and add a line to the migration checklist to re-copy on every token change.
