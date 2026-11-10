# Visual audit: the three redesigns against the token system

**Status:** audit, for the owner. Nothing was changed: no code, token, spec or wireframe. It reads
`site/tokens.css`, the design language of 2026-10-28, `components.css`, the `<style>` block of
`site/index.html`, the three specs of 2026-11-09 and their wireframes (23 boards, four stylesheets: the
shared `app.css` and `plan.css`, `today.css`, `calendar.css`). Every board was rendered in Quartz, dark
and light, and measured with `getComputedStyle`; the other three schemes were measured by re-stamping the
same boards. Ratios are WCAG contrast, written light / dark, Quartz unless a scheme is named. In examples
Alex is the viewer and Bob and Casey the other members.

## At a glance

1. **The palette is up to date; the roles and sizes are not.** The four sheets read 71 tokens and every
   one resolves in all eight scheme and mode pairs. The only hex is `#000` in two scroll masks. What is
   missing is names for things the designs now share: the three plan states, "another member", the search
   mark, tracking for headlines and caps, a disc, a row and a control height. Sixteen names, below.
2. **The wireframe sheets cannot be pasted.** Their class names collide with shipped ones: `.row`
   (`.card .row`, index.html:90), `.rows` (the import table, :1277), `.chip.on` (green "on", :1340),
   `.plan-head` (the card's head, :938), `.line` (:729), `.check` (:815), `.quiet` (:101), `.done`. Inside
   the wireframes the collisions already bite: `.mc.money` wears the money field's border (plan.css:62,
   app.css:114), `.usd.over` takes `.over`'s margin (calendar.css:39, 210), and `svg.st.done` had to be
   un-styled (plan.css:47). The system already has what they need: `.erow`, `.list`, the `.ep-*` page
   frame, `.seg`, `.filters`, `.provisional`, `.claude`, `.daystrip`. Note that `components.css` is now
   behind the shipped CSS: it has no `.erow`, `.ep-*`, `.list`, `.chip-btn`, `.who.household` or `.ev.off`.
3. **Four selected states are told by a tint alone**, which the Graphite rule forbids (design language,
   line 85): the chosen day (fill 1.06 / 1.09 against the page, border 1.20 / 1.36), a pressed goal chip
   or overlay toggle (1.09 / 1.23), the desk's chosen day head (1.15 / 1.13) and the search mark (1.15 /
   1.13). Shipped CSS already has the answers: an ink ring (:1183) and an ink-filled pill (:482).
4. **A Doing glyph in the accent disappears on a calendar box.** On a "mine" box it is 2.27 in Quartz
   dark, 1.00 in Graphite dark and 1.12 in Graphite light; on a Household box 2.53 in Quartz light. A
   glyph on a source fill must take the box's ink.
5. **Three text pairs fail, all in light, all from opacity or a tint**: a bill box's second line (4.26),
   a done row's meta line (4.37), faint text inside a search mark (4.46). Dark has no text pair under 5.0.
   The `$` mark's three states (unpaid, short, paid) differ by hue only: caution against problem is 1.03.
6. **Targets.** Only the Calendar sheet pads small controls to 44px (calendar.css:206 to 213). On Plan
   the people bar is 33.5px, goal chips 30, an area heading 36, the done row 40, foot buttons and Back 32,
   crumb links 20. On Today the kinds are 28, text links 18 to 23, the clear button 18.
7. **Dashed needs one ruling, not three.** A due date was already dashed by law. The desk's "A new area"
   column (plan.css:129) and the read-back before a removal (app.css:146) are dashed for no reason the
   law allows, and a done plan's due row stays dashed in green (calendar.css:122). Make all three solid.
8. **Claude loses a channel.** The briefing inside a day card has the mark, by-line and paper but no gold
   rule (today.css:78), and Claude's proposal sits on plain card. The first is a drift to fix; the second
   is right and the law should change.
9. **The same things are drawn three ways**: the people bar (three rule sets, 33.5, 33.5 and 38px), the
   member disc (`.who` in Plan, `.pd` in Today and Calendar; 22, 18 and 16px), buttons (`<a class="btn">`
   at 13px/500 and `<button class="btn">` at 15px/400 on the same board), page heads, icon buttons.
10. **"Partner" is the wrong word in the tokens** once there are three members, and two other members
    with the same initial get identical discs. Rename to `--src-other-*`; use two letters on a collision.

## Tokens to add or change

New aliases that point at scheme tokens must sit in a block matching
`:where(:root, [data-mode], [data-scheme])`, as section 5 of `tokens.css` does (line 540), or a scoped
scheme will not re-resolve them. Add that block as "3c. Roles", after the schemes. Mode-invariant
scales go in section 1 beside their family.

| Name | Light | Dark | Used by | Why |
|---|---|---|---|---|
| `--state-planning` | `var(--ink-faint)` | same | `stateGlyph` planning | restated plan.css:44, calendar.css:108; 4.87 / 6.22 on the page |
| `--state-doing` | `var(--accent)` | same | Doing glyph, the Doing rail | plan.css:45, 48; calendar.css:109, 111; on the page 3.35 in Quartz light, the lowest of the eight |
| `--state-done` | `var(--good)` | same | Done glyph, the done row's check | plan.css:46, 75; calendar.css:110 |
| `--src-other-fill` | `#F4E9F8` | `#2C2035` | every member but the viewer | rename of `--src-partner-fill`; keep the old name as an alias in section 5 |
| `--src-other-line` | `#9A55B7` | `#C18BDC` | the ring | as above; 4.82 / 6.50 on a card |
| `--src-other-ink` | `#5B2675` | `#EBD3F5` | the initial | as above; 9.02 / 11.11 on its fill |
| `--mark-fill` | `var(--accent-line)` | same | `mark` in search results | `--accent-tint` is 1.10 to 1.21 on a card in all eight; this is 1.65 to 2.06, ink on it 7.2 to 10.6 |
| `--hatch` | `repeating-linear-gradient(135deg, var(--hatch-line) 0 2px, transparent 2px 7px)` | same | held rows and boxes, the guest page's taken night | restated calendar.css:124, 200, index.html:1121; pitches of 5, 6 and 7px in components.css |
| `--tracking-headline` | `-0.02em` | n/a | every `h1`, a card's title | literal in all four sheets, components.css:62, 428, 652 and index.html:881 |
| `--tracking-caps` | `0.02em` | n/a | section labels, "WAITING", when-words | literal six times in the sheets; shipped at index.html:189 |
| `--r-inner` | `7px` | n/a | a pressed segment, an event box, a row's outline | 7px in components.css:124, 486; the sheets use 8px (app.css:41, calendar.css:121) |
| `--stroke-rail` | `3px` | n/a | the Doing rail | `inset 3px 0 0` at plan.css:48, calendar.css:111; also index.html:89, 624 |
| `--disc`, `--disc-small` | `22px`, `18px` | n/a | member disc, state glyph, a row's slot | 22px is written 22 times; small is 18, 18 and 16 in the three sheets |
| `--row`, `--control` | `56px`, `36px` | n/a | a row that opens a page; a compact control as drawn | rows are 56, 56, 52; controls 28, 30, 33.5, 36, 38. The hit area stays `--tap` |

Changes to what exists:

- **`--src-partner-*`** become old names (section 5) pointing at `--src-other-*`. Update the comment at
  tokens.css:175 to 182 to "another member's" and add: every member but the viewer shares this treatment.
- **Comments now untrue:** line 83 and 108 ("thread"), 86 ("the briefing's headline"), 172 ("a plan
  someone asked you to take"), 214 ("the tray"), 215 ("a member's own words"). Line 79 stays true and is
  the reason the month grid's counts may not use `--fs-nano` (calendar.css:76).
- **`tools/contrast.py`** passes today (0 fails) but knows none of the new pairs. Add: `--state-doing` on
  the three surfaces at 3.0, `--ink-faint` on `--accent-tint` at 4.5, `--ink` on `--mark-fill` at 4.5,
  `--src-other-*` in place of partner, `--line-strong` on `--surface` for the small hatch mark.
- **No token needed** for four things the brief expected: the lane icon ink (`--ink-faint`, 5.14 / 5.71
  on a card), the paid tone (`--ink-soft` and `--ink-faint`, which is the shipped `.ev.off` look, :1118),
  a bill's tint (`--caution`, `--caution-tint`, `--caution-line`, as `.chip.stale`), and motion (the
  boards are static; use `--t-fast` for a press and `--t-base` for a card opening).

## Literals found

| Literal | Where | Verdict |
|---|---|---|
| `#000` | scroll masks, plan.css:17, calendar.css:42 | right: a mask's alpha, not a colour |
| weights `400`, `500`, `600` | 94 uses across the four sheets | `--fw-regular`, `--fw-medium`, `--fw-semibold` |
| `-.02em` | `h1` in every sheet | new `--tracking-headline` |
| `-.01em` | titles: plan.css:30, today.css:68, 81, calendar.css:83, 159 | existing `--tracking-tight` (`-0.015em`) |
| `.02em` with uppercase | app.css:56, 91, 147; today.css:122, 138; calendar.css:94 | new `--tracking-caps` |
| line-height `1.35`, `1.5`, `1.55` | plan.css:37, 110; calendar.css:97; app.css:15 | `--lh-snug`, `--lh-body` |
| line-height `1.2`, `1.3` | calendar.css:91, 169, 191 | `--lh-tight` |
| line-height `1`, `1.1` | chips, marks, date numerals | right: one-line boxes |
| `1px` borders | 76 uses | `--stroke` |
| `1.5px` | 17 uses: dashes, rings, radio, checkbox | `--stroke-heavy` |
| `2px` outline or line | clash, now line (calendar.css:126, 131, 187) | right: matches shipped `.ev.clash` and focus |
| `3px` rail | plan.css:48, calendar.css:111 | new `--stroke-rail` |
| radius `10px`, `999px` | plan.css:99, 109; calendar.css:227, 229; app.css:31, 130 | `--r-control`, `--r-pill` |
| radius `8px`, `7px` | app.css:41; calendar.css:121, 126, 191, 221 | new `--r-inner` |
| radius `5px` checkbox | plan.css:113, calendar.css:145 | `--r-chip`, as `.check input` (components.css:112) |
| `4`, `8`, `12`, `16`, `20`, `24px` | about 180 raw uses, some of them icon sizes | `--sp-1` to `--sp-6` |
| `6px` gaps | 46 uses | right for icon to label; components.css does the same 20 times |
| `10px`, `11px`, `14px` insets | rows, entries, forms, the briefing | `--sp-3` inside a list card, `--sp-4` in a card that stands alone |
| `10px 12px` field padding | plan.css:108, calendar.css:226 | reuse `.input` (index.html:810) instead of restating |
| `18px`, `32px` desk gutters | plan.css:119 to 121; today.css:155; calendar.css:157, 158 | `--gutter-wide` |
| `22px`; `18px`, `16px` discs | every sheet | new `--disc`, `--disc-small` |
| icons `9` to `18px` | every sheet | `.i` 16, `.i.sm` 13, `.i.lg` 20, 12 in a chip or mark |
| `28`, `30`, `34`, `36`, `38`, `40px` controls | every sheet | new `--control` drawn, `--tap` hit |
| `44px` | plan.css:67, 100; today.css:63, 150, 185; calendar.css:136, 212 | `--tap` |
| `52px`, `56px` rows | plan.css:35, 128; today.css:52; calendar.css:90 | new `--row` |
| `72px`, `54px` cells; `60px`, `64px` when column | calendar.css:53, 72, 90, 214 | right: one component's geometry |
| `700px 340px`, `420px`, `260px`, `160px` | today.css:155, 158, 164; plan.css:126 | `--measure` and the shipped `minmax(240px, 300px)` |
| `1100px` desk frame | all three | the mock's frame only; the app's is `--page` (1180px) |
| opacity `.8`, `.85`, `.6` | plan.css:50; calendar.css:193; today.css:73 | remove; use an ink token (two of the three text failures) |
| `0 0 0 1px var(--focus)` | today.css:19, app.css:116 | the shipped focus is a 2px outline (index.html:812) |
| `--hour: 40px` | calendar.css:165 | shipped is 44px (index.html:1144); keep shipped |
| `15px/400` on buttons | not in any sheet: app.css:20 resets `button` | an accident of the mock; see the buttons row below |
| durations | none in the sheets; `.15s` at index.html:49, 1288 | `--t-fast` |

## Contrast findings

Failures and near-misses only. Text needs 4.5, marks 3.0. "Computed" means worked out from the tokens
because no board draws the pair.

| Pair | Light | Dark | Fix |
|---|---|---|---|
| Bill box, second line: caution at .85 on its tint (`.ev.money .s`) | **4.26** | 6.55 | drop the opacity (calendar.css:193); 5.79 without it |
| Done row's meta: soft ink at .8 (`.row.is-done .m`) | **4.37** (Iolite 4.55, Lapis 4.59) | 5.69 | drop the opacity (plan.css:50); the softened title already says done |
| Faint text inside `mark` on `--accent-tint` | **4.46** (Graphite 4.49) | 5.04 (Graphite **4.38**) | `mark { color: var(--ink) }` |
| Faint text inside `mark` on a tinted row (today.css:110), computed | **3.11** | **2.81** | the same rule |
| Paid and short bill boxes, second line | 4.51, 4.59 | 5.93 | the same opacity fix |
| Faint ink on `--surface-sunken`: bar counts, a held row's small line | 4.57 | 6.46 | passes by 0.07 in every light scheme; use `--ink-soft` (6.39) |
| The same faint text where it crosses a hatch stripe, computed | **about 3.4** | about 4.7 | held rows take `--ink-soft`, as `.ev.held` does |
| Green status box (`.done`, app.css:151) | 4.75 | 8.22 | passes; do not put it on any other tint |
| Chosen day: fill and border against the page (calendar.css:58) | **1.06, 1.20** | **1.09, 1.36** | the shipped ink ring, index.html:1183 |
| Chosen day that is today: `--accent-line` border | **1.57** | **2.21** | the same ring; today is already said by the accent date |
| Pressed chip `.chip.on`: fill and border against the page | **1.09, 1.57** | **1.23, 2.21** | ink fill, as `.kind` and `.filters` (index.html:482) |
| Desk's chosen day head: `--accent-tint` on a card (calendar.css:171) | **1.15** | **1.13** | add the tab's 2px accent underline |
| Search mark: `--accent-tint` on a card (today.css:109) | **1.15** | **1.13** | `--mark-fill` and semibold |
| Held mark, 10 by 8px: fill, then hatch, against the page | **1.07, 1.42** | **1.04, 1.31** | draw its lines and edge in `--line-strong` (3.07 / 3.39) |
| Doing glyph on a "mine" box, computed | 4.57 | **2.27** (Graphite **1.00**; Graphite light **1.12**) | inside `.ev`, `.st` uses `currentColor` |
| Doing glyph on a Household box; in a due box at .85 | **2.53, 2.92** | 5.76 | the same rule, and no opacity on `.ev .s` |
| Done due row's dashed outline in `--good-line` | **1.79** | **2.70** | no outline on a done plan's due row |
| `$` unpaid against `$` short; unpaid against paid (lightness only) | **1.03, 1.26** | **1.18, 1.62** | a second cue: a check for paid, `$!` for short |
| Radio ring `--line-strong`; checked radio in `--accent` | 3.07 (Graphite 3.01), 3.35 | 3.39 | passes; fill the checked one with `--accent-fill` like the checkbox |

Everything else the boards draw passes. 119 distinct text pairs were measured in each mode; outside this
table the lowest is faint ink on Claude's paper, 4.75 / 5.69. A link on the paper is 5.41 / 8.34.

### Targets, text sizes and overflow

- **Under 44px, Plan:** people bar 33.5 high; goal chips 30; area heading 36; done row 40; foot buttons,
  Back and Show/Hide 32; crumb links 25 by 20; the state segment 33.5; every other button 36.
- **Under 44px, Today:** kinds 28 ("All" is 36 by 28); people bar 33.5; search button 36 by 36; "Read
  the whole briefing" 20; a Yours row 36; "Open the plan" and the from-line 18; the sort 23; composer
  buttons 36; the field's clear button 18 by 18; Cancel 21. A proposal's buttons reach 44 by padding.
- **Under 44px, Calendar:** the month button 23; people bar 38; "All day" 21; free-slot chips 42; the
  Kind and On segments 38; Back and the envelope page's foot 32. The rest reach 44, most by `::after`.
- **Text sizes.** Nothing is under 10px. 10px is used for initials, which is its job, and for the month
  grid's counts (calendar.css:76), which is not: use `--fs-micro`; four marks still fit a 49px cell.
  The desk search field is 14px (today.css:159), under the 16px floor for anything typed into.
- **Overflow at 390 and 375:** none but the two scrollers (goals 657 in 358; overlays 698 in 358). At 375
  the kinds row with a kind pressed is 347 in 343: 4px into the gutter. At 320 it runs 25 to 43px past
  the page. Today's people bar has no scroll rule (today.css:36); Plan's and Calendar's do.
- **The when column is 64px** and "10:00 AM" at 14px/600 is 64.3px. The boards hide this by writing
  "9:00" in the morning and "2:00 PM" after noon. Set it to 68px and use `clockOf` everywhere.

## Design-language amendments

Verdict by section of `2026-10-28-design-language.md`, then the exact changes. Sections not listed
(Schemes, How the tokens are delivered, Where the scheme preference lives, Space and shape, Settings, The
guest page) still hold as written.

- **Decisions taken against the documents:** the first two still hold. The third is superseded for the
  board. Add after line 50: "*(Superseded 2026-11-09: Plan, Today and the Calendar's phone page are
  specified phone first; see the three specs of that date.)*"
- **At a Glance, line 12.** Old: "dashed means a person still has to say yes; solid means it happened."
  New: "dashed means not real yet: a person still has to say yes, or a date is only an intention; solid
  means it happened or is settled."
- **At a Glance, line 14, and "The three source shades", lines 105 to 111.** Old: "mine solid, partner a
  plum ring with their initial". New: "yours solid, every other member a plum ring with their initial;
  two members whose initials match show two letters". Old: "**Partner**: a pale plum fill inside a plum
  ring, with the partner's initial." New: "**Another member**: a pale plum fill inside a plum ring, with
  their initial. Every member but the viewer shares it; there is no third colour." Add: "A state glyph or
  lane icon drawn on a source fill takes that fill's ink, never the accent."
- **At a Glance, line 15.** Old: "The board stacks Planning over Doing per area; the calendar shows one
  day under a week strip." New: "Plan is one card of rows per area with the state as a glyph; the
  Calendar is a strip of days with marks over one day's card of rows; Today is one card per day."
- **Tokens, line 64.** Old: "`--accent-tint` is a selected row and a member's own words in the thread".
  New: "`--accent-tint` is the row a link landed on". Line 68 and the type table: "thread" becomes
  "record".
- **Type, line 187.** Old: "The only uppercase in the app is the eyebrow, which names a group." New:
  "Uppercase is only for a label that names a group or a kind: a section's label (13px, semibold), the
  eyebrow and the word in a row's when column (12px). All take `--tracking-caps`." Table, headline: old
  "The briefing's headline; a plan card's title", new "A screen's name; a page's or a plan card's title".
  Title: add "a day's name". Body: old "the thread", new "a note's or an answer's words".
- **Conventions, "A proposal", line 207.** Old: "A Claude proposal sits on Claude's paper; every other
  proposal sits on plain card. The dash is the same either way: the provenance is the paper, the status
  is the dash." New: "A proposal is a dashed block under the row that offered it, on plain card whoever
  offered it: the row's disc and first words say who, the dash says it waits." Old: "a small "Waiting for
  you" or "Waiting for either of you" line". New: "the label "Waiting"".
- **"A decision", line 209.** Old: "collapses the card in place to **one line**: an icon (a green check,
  a cross, a clock), what it was, who, when, and the reason". New: "leaves the card's title and one
  settled line in the block's place: who, when and the reason. A decision made on a later day also gets
  its own row that day." I recommend the builder keeps the icon from `.decided`; the spec does not
  forbid it and good should not stand on a word alone.
- **"Claude's text", line 215:** still true, and the wireframe breaks it. `.brief` (today.css:78) needs
  the gold rule: a `--claude-line` border top and bottom inside the day card. Add: "In a row, Claude's
  disc is its mark on its paper inside a gold ring."
- **"A due date", line 217:** still true. Add: "On a plan's row the due day and a block are an icon and
  words with no box; the dashed edge is the Calendar's. A done plan's due date is not dashed."
- **"On the calendar", line 219.** Old: "A clash is a red ring: the only red on the grid. Held nights (a
  guest's stay or a member's block) are hatched and never say why." New: "A clash is a red ring, the only
  red ring; a bill its envelope cannot cover is red in its words and figure. An unpaid bill is caution, a
  paid one quiet, and a date going by changes neither. Held nights are hatched; a friend never sees why,
  a member's row names the stay or the reason." The wireframes draw no "moved" and no "not on the
  calendar yet" row or box; the shipped `.ev.drift` and `.ev.off` (:1112, :1118) stand, and rows need
  the same two variants.
- **"Asked, not assigned", line 221:** superseded whole. New: "**Handed, not asked.** A plan changes
  hands at once, and Today says who moved it, from whom, to whom and why. Nothing on Plan is dashed for
  it. An ask from before 0.7.0 keeps its dashed card on Today until it is answered or the plan moves."
- **"The error box", line 227:** still true. Add: "A form or a proposal block also has its own error
  slot, always rendered, for a refusal of that one action."
- **"Dashed is reserved", line 229.** Old: "Nothing else in the app is dashed: drop zones and shelves
  are solid." New: "Nothing else has a dashed edge: drop zones, add rows, the desk's "A new area" column
  and a read-back before a change are solid. The Planning glyph is a dashed circle, which says the same
  thing in small: not begun."
- **Components, lines 244 to 246.** Today: remove `day-head`, `newsince`, `msg`, `line`, `tray`; add
  `day`, `ent`, `seg people`, `tnew`. Plan: remove `board`, `lane`, `lane-label`, `bcard`, `shelf`; add
  `erow plan`, `erow add`, `erow fold`, `st`, `list`. Calendar: remove `legend`, `sw`, `dayview`; add
  `marks`, `erow cal`. People and chips: `who` gains `other`, `household`, `claude`; `chip asked` goes.
  Line 251, the naming rule, still holds and is the rule finding 2 rests on.
- **Layout, lines 264 to 270:** the Today, Plan board, Plan card and Calendar paragraphs are superseded.
  Replace each with one sentence naming its spec; keep "shared Today is not personal Today".
- **Copy voice, line 322.** Old: "Times are local and short ("7:41", "Tue 10:30")." New: "Times are the
  household's, as `clockOf` writes them ("7:41 AM"); a day is a weekday, a day and a month."
- **Answers, line 329, and "What changes in the plans", line 340:** mark superseded ("asked dashed with
  an arrow", "partner ringed", the shelf strip, `bcard provisional`).

## Components: reuse, vary, new

"Shipped" is `site/index.html` by line; "ref" is `components.css`. Build on the shipped rule where both
exist, since the reference is behind it.

| Drawn in the designs | Verdict | Build on | Note |
|---|---|---|---|
| People bar | vary | `.seg` (:823, ref 121) | add `.seg.people`: scrolls, `.n` count; one copy for three pages |
| Kind chips | reuse | `.filters button` (:482, ref 130) | ink-filled when pressed; icon only while pressed |
| Goal chips, overlay toggles | vary | `.filters button` | add the flag; never `.chip.on`, which is shipped green |
| Free-slot chips | reuse | `.chip-btn` (:315) | already `--tap` high |
| Member disc, Household, Claude | vary | `.who.mine`, `.who.partner`, `.who.household` (:831, :785) | add `.who.other`, `.who.claude`, `.who.sm`; drop `.pd` |
| State glyph, goal flag, meta marks | new | none | `.st`, and `.mc` under another name; not `.money`, `.block` or `.due` |
| Area card, day card body, Bills card | reuse | `.list` (:619) | one surface, rows between hairlines |
| Plan row, calendar row | vary | `.erow` (:157) | add a leading 22px slot; `.erow.plan`, `.erow.cal` |
| Calendar row kinds | vary | `.ev.due`, `.held`, `.clash`, `.proposed`, `.off`, `.drift` (:1109 to 1121) | the same six words on `.erow.cal`; add `.paid` |
| Add row | vary | `.rows .add` (ref 580); `.add-row` (:634) for "A new area" | both solid |
| Done fold | vary | `.erow` | `.erow.fold`: sunken, 44px |
| Area heading | vary | `.area-head` (ref 379) | becomes one link with a count and chevron |
| Area page; Bills section | reuse | `.ep`, `.ep-sec`, `.ep-sec-h`, `.ep-form`, `.ep-acts`, `.ep-foot`, `.back` (:175 to 208, :992) | share the envelope page's frame |
| Owner and Goal sections | reuse | `.ep-line`, `.ep-t` (:196) | value over a soft line, one action |
| Radio list | vary | `.check` (:815, ref 111) | a radio variant, checked in `--accent-fill` |
| Read-back ("This will") | reuse | `.ep-review` and `.effects` (:221, :91) | solid and sunken, not app.css:146 |
| Day card head | new | none | a disclosure button over a `.list`; not `.dhead` twice |
| Entry row | new | none | replaces `.msg` and `.line`; four columns |
| Proposal block | vary | `.provisional`, `.waiting`, `.effects`, `.actions` (:858) | `--r-control` inside a row; keep the sunken effects list |
| Briefing block, Claude's answer | vary | `.claude`, `.byline.claude-by`, `.mark`, `.looked` (:1000, ref 218) | in a day card: no radius, gold rule kept |
| Yours strip and column | vary | `.yours`, `.rail` (:765) | the strip is one row per rail; the column is unchanged |
| Waiting list | vary | `.provisional` around `.rowi` rows (:1280) | `.rowi .meta` is the small line |
| Composer bar | reuse | `.composer`, `.composer-row` (:746) | remove `.tray` |
| Search field, results, mark | vary | `.search input` (:534); entry rows | new: `mark` with `--mark-fill` |
| Week strip | vary | `.daystrip` (:1169 to 1183) | `.dots` becomes `.marks`; keep the ink ring |
| Month picker | vary | `.daystrip` cells; `.nights .dow` (ref 623) | six rows of the same cell |
| Now line | vary | `.week .now` (:1164) | a row-height variant |
| Add form, keep-nights form | reuse | `.cal-panel` contents (:1124) in `.ep-form` | `.pair`, `.clashes`, `.sure` already exist |
| Bill form | reuse | `.ep-f`, `.seg`, `.figure-live` | nothing new |
| Desk week, money boxes, day heads | vary | `.week`, `.ev` (:1144, :1100) | add `.ev.money`, `.paid`, `.short`; `.dh` becomes a button |
| Desk "A new area" column | reuse | `.add-row` (:634) | solid |
| Icon button | vary | `.btn` | `.btn.icon`: `--control` square, padded to `--tap` |
| Page head, Back, crumb, text links | reuse | `.page-head` (:881), `.back` (:992), `.crumb` (:935), `.link` (ref 94) | underline `.link` so Graphite reads it |

## Inconsistencies between the three wireframes

| Thing | Plan | Today | Calendar | Standard to adopt |
|---|---|---|---|---|
| People bar | `.people`, pad 6/12, 33.5px, scrolls (plan.css:9) | pad 6/0, 33.5px, no scroll, count in `small` (today.css:36, 183) | pad 6/8, 38px, scrolls (calendar.css:23, 211, 245) | one `.seg.people`: `--control` drawn, 44 hit, scrolls, `.n` |
| Member disc | `.who.mine`, `.who.partner`; 18 and 22px | `.pd.me`, `.pd.them`; 22 and 18px | `.pd`; 22 and 16px; `.m .who` 16px | `.who`; `--disc` and `--disc-small` (18); initial 12px at 22 as shipped, 10px at 18 |
| Pressed chip | accent tint (`.chip.on`) | ink fill (`.kind`) | accent tint | ink fill |
| Chip height | 30 | 28; 30 on the desk | 30; free slots 28 | 30 drawn, padded to 44 as calendar.css:206 to 209 |
| Buttons | `a.btn` 13px/500, `button.btn` 15px/400; 36; foot 32 | the same; 36 | 44 in forms and foot | 14px/500 and `min-height: var(--tap)` on a phone, 38 on the desk (ref 75 to 88) |
| Page head | pad 14/0/8; `h1` line-height 1.5 | pad 16/0/12; `--lh-tight` | pad 16/0/12; pages 10 | `.page-head`: `--sp-4` above, `--sp-3` below, `--lh-tight` |
| A day's name | n/a | inside the card, a button (`.dhead`, today.css:63) | above the card, a heading (`.dhead`, calendar.css:82) | both right; two class names, one type: 17px/600, `--tracking-tight` |
| Row inset and height | 10/10/10/12, 56 | waiting 10/10/10/14, 52; entry 11/14 | 10/10/10/12, 56 | `--sp-2` by `--sp-3`, `min-height: var(--row)`, gap `--sp-2` |
| Add row | plan.css:67 | none | restated, calendar.css:136 | one `.erow.add` |
| State glyph rules | plan.css:44 to 48 | none | restated, calendar.css:108 to 111 | one copy, on the `--state-*` tokens |
| Icon button | none | 36, no padding (today.css:12) | 36 with 4px padding (calendar.css:17, 207) | one `.btn.icon` with the padding |
| Icon sizes | 12, 14, 16 | 10 to 18 | 9 to 18 | 12 in a chip or mark, 16 in a row, 20 in a button |
| Text links | crumb in accent ink; Back drawn in ink | `.go`, `.from`, `.more`: accent ink, no underline | `.month` | `.link`, underlined; a control with a chevron needs none |
| Times | n/a | "7:52 AM" | "9:00", "10:00", "2:00 PM" | `clockOf` |
| Desk frame | 32px gutters; four columns and 160px | 18px gutters; 700 and 340px | 32px gutters | `--gutter-wide`, `--measure`, `--page` |

Consistent already, and right: card radius and shadow (`--r-card`, `--e-1`), 21px page names, 17px
titles, the caps section label (it is the shipped `.ep-sec-h`), the chevron, the form's field styles.

## What the 0.7.0 build must carry

Plan ships first and defines `memberDisc`, `stateGlyph`, `goalFlag` and `peopleBar`, so the shared work
lands with it or it is done three times.

- [ ] `tokens.css`: the Roles block with `--state-planning`, `--state-doing`, `--state-done`; the
      `--src-other-*` set with `--src-partner-*` moved to the old names; `--tracking-headline`,
      `--tracking-caps`, `--r-inner`, `--stroke-rail`, `--disc`, `--disc-small`, `--row`, `--control`.
      `--mark-fill` may wait for 0.8.0 and `--hatch` for 0.9.0. Fix the six comments listed above.
- [ ] `tools/contrast.py`: the new pairs, and a clean run.
- [ ] `.erow` generalised: a leading slot, `.erow.plan`, `.erow.add`, `.erow.fold`, inside `.list`. No
      new block named `.row`, `.rows`, `.line`, `.plan-head`, `.done`, `.money`, `.over` or `.quiet`.
- [ ] `.seg.people`, written once: scrolls, counts in `.n`, 44px hit. Today and the Calendar call it.
- [ ] `.who`: `.who.other` (keep `.partner` until the Calendar moves), `.who.sm` at 18px, two letters
      when two members' initials match, the member's name as the accessible name.
- [ ] `.st` state glyphs on the three tokens, with the rule that inside `.ev` they use `currentColor`.
- [ ] Goal chips on `.filters button`, ink-filled when pressed, the pressed one scrolled into view.
- [ ] One hit-area helper (the `::after` pattern of calendar.css:206 to 209) on the bar, chips, the area
      heading, the done row, Back, crumb links and foot links. Every one measured at 44.
- [ ] `.btn` at one size: `--fs-ui`, weight 500, `min-height: var(--tap)` on a phone. Replace the `.15s`
      at index.html:49 with `--t-fast`.
- [ ] The Area page on the envelope page's frame; Owner and Goal as `.ep-line`; the radio list as a
      `.check` variant; the goal's Remove read-back as `.ep-review`, solid.
- [ ] The desk's "A new area" as `.add-row`, solid. Columns from `--gutter-wide` and `--page`.
- [ ] No opacity on text: a done row softens with `--ink-soft` only.
- [ ] Delete what the spec lists (`.board`, `.lane`, `.bcard`, `.shelf`, `.chip.asked`), and mark the same
      rules superseded in `components.css` so the reference stops offering them.
- [ ] The design-language amendments above that touch Plan: lines 12, 14, 15, 105 to 111, 221, 229, 246.
- [ ] A check at 375 wide in Graphite, light and dark: every pressed, chosen and Doing state readable
      with no hue.

## What I could not check

- **A real phone.** Everything was measured in the desktop app's Chromium pane. Safari's text sizing,
  the iOS zoom on focus, safe areas and the sticky composer over a keyboard were not seen.
- **Lapis, Iolite and Graphite by eye.** Their text and mark ratios were measured by re-stamping all 23
  boards, and the token pairs were computed for all eight combinations. I did not look at them, so
  judgments of feel (the gold paper on Lapis, plum against stone) are untested for the new layouts.
- **Colour blindness.** No simulation was run. The `$` finding rests on lightness ratios alone.
- **States the boards do not draw.** Hover, focus, pressed, disabled and error; any motion; a real
  `::placeholder` (the composer's is drawn as text, 5.14 / 5.71); "moved" and "not on the calendar yet"
  rows; a day with all five marks; four or more members; a long name; two members with one initial; a
  tinted row on Today; the device-dark path (the boards stamp `data-mode`).
- **Widths other than 390.** 375 and 320 were forced by narrowing the mock's frame, which is not the
  app's container query. The desk boards are 1100px; 1040 and 1280 were not drawn.
- **Text buttons as intended.** The mock resets `button` and `a` (app.css:19, 20), so Back, the sort and
  every `<button class="btn">` render in a size or colour their own rules did not ask for. I report the
  rules' intent where the two differ.
- **The canvases.** I audited the local copies of the boards, not the three claude.ai artifacts.
