# Design brief: a design language for Home Planner, and a scheme each of us can pick

You are the design lead for a small, private web application that a couple runs on
their own Synology NAS for themselves and a handful of friends. Your job is to give it
one design language — tokens, CSS architecture, layout, UI conventions, and the
Settings surface that configures it — such that every application on that NAS can
share it, and such that the two members can each pick a scheme they prefer without
the application looking like two applications.

You will not be able to talk to the engineers who are building it. Everything they
decided is written down; read it before designing anything. Where this brief and
those documents disagree, the documents win.

## Read first, in this order

Repository: `household-budget` (a private
GitHub repository). If you cannot read the repository, ask
for these files to be attached, in this order.

1. `docs/superpowers/specs/2026-10-28-home-planner-design.md` — what the product is
   and why. The *Anti-goals* section is a list of visual failures.
2. `docs/superpowers/specs/2026-10-28-today-thread-design.md` — Today as a shared
   thread, already built. Its *Entries in the thread* table is a component inventory.
3. `docs/superpowers/specs/2026-10-28-booking-design.md` — the one page strangers see.
4. `docs/superpowers/plans/2026-10-28-plan-app.md` (task 5), `…calendar-and-today.md`
   (tasks 7–9), `…booking.md` (task 7) — the screens engineering will build, with the
   exact element lists they expect. Your layout work lands in those tasks.
5. `site/index.html` — the whole current UI in one file. Read the `<style>` block's
   `:root` (fourteen custom properties), the class vocabulary, and the `TABS` array
   near the end. This is what exists; it is light-only and has no theme switching.
6. The brainstorming wireframes, if present on disk (they are scratch and not
   committed): `.superpowers/brainstorm/*/content/home-planner-wireframe.html`,
   `plan-board-modes.html`, `plan-card.html`. They show structure and hierarchy the
   owner approved. They are deliberately ugly; do not inherit their look.

## What exists today

- A single-file vanilla-JS app, no build step, served by a Node API. Styles live in
  one `<style>` block. Any token system you propose must be expressible as CSS
  custom properties that this file — and other apps — can load.
- Fourteen tokens in `:root`, named after materials: `--ion` (the one accent,
  `#0C8CE9`), `--quartz`, `--graphite`, `--emerald`, `--sand`, `--rose`,
  `--ink-soft`, `--ink-faint`, `--line`, `--hair`, `--card`, `--bg`, `--radius`
  (12px), `--shadow`. Keep the naming idea if it serves you; replace the set if it
  doesn't. Emerald / sand / rose are already used as good / caution / problem.
- Typeface: Satoshi, with a system fallback stack.
- Component classes in use: `btn`, `btn primary`, `card`, `row`, `field`,
  `tray`, `eyebrow`, `quiet`, `err`, `menu`, `sheet`, `tabs`. The thread's cards are
  the most developed component; look at `offerCard()` and `entryNode()` in the file.
- No dark mode. No per-user preference of any kind beyond which budget is open.

## What I want from you

**1. Tokens.** A complete token set — colour (semantic roles, not just a palette:
surface, surface-raised, ink, ink-soft, ink-faint, line, accent, accent-ink, good,
caution, problem, and the three *source* shades the calendar needs for *mine /
partner / household*), type scale and weights on Satoshi, spacing scale, radii,
elevation, motion durations. Light and dark, both designed, not inverted.

**2. Schemes a member can pick.** At least three complete schemes beyond the
default — distinct enough that choosing one is a real choice, disciplined enough
that a screen designed in one reads identically in another. Each scheme is light
and dark. Name them; names are part of the design. A scheme is a *personal* choice:
Alice and Bob — the two members — may be looking at the same household in different schemes at the
same moment, and every semantic rule below must hold in all of them.

**3. CSS architecture.** How the tokens are delivered: one `tokens.css` the app loads
and that other applications on the NAS (a comic reader, a document binder) can load
too, so the household's apps share one language. How a scheme is applied (a
`data-scheme` attribute on `<html>`, I assume — say so, or say why not). How light
and dark resolve: explicit choice beats OS preference, OS preference beats nothing.
What the un-stamped default renders as. Keep it to what vanilla CSS does.

**4. Layout.** The surfaces, with the element lists engineering already expects
(the plans name them): the shell (Today · Plan · Calendar · Budget · More ▾,
household pill, member pill); Today (briefing first, the three rails, the sticky
reply box, the waiting tray); the Plan board (area rows × Planning | Doing, shelves
as full-width strips, cards with chips); the Plan card (Linear-shaped: title, state
segment, notes, checklist, attachments, Claude's block, "between us", a sidebar);
the Calendar week (all-day row, timed grid 7:00–21:00, three source shades, drift
outline); Settings; the guest booking page (standalone, none of the member chrome).
Phone first — both members read this on iPhones — then desktop.

**5. UI/UX conventions**, written down so the engineers apply them without asking:
how a *proposal* (a card to approve) differs from a *decision* (one line, who,
when); how a *suggestion from Claude* differs from both; how a *due date*
(dashed, a date) differs from a *block* (solid, time set aside) differs from an
*appointment*; how Claude's text is set apart from the humans' everywhere it
appears; what "asked, not assigned" looks like on a card; what an empty state
says; what the error box says and where it lives. The copy voice is the one in
the current app: plain, direct, no exclamation marks, no "oops".

**6. Settings & Configuration.** One screen, reachable from the household pill, for
everything the plans put there: areas (editable list), links under More, the
Household calendar (create or pick), the calendars I check for conflicts, the
guest list for booking, attachments on/off (read-only, from the environment),
and — new, yours — **scheme and light/dark, per member.** Decide where the scheme
preference lives and say why. The app already keeps per-member things in the
household's event log (each member's read cursor, each member's conflict
calendars), so a `scheme.set` event by the member, cached in `localStorage` for
the first paint, follows them across devices and is backed up with everything
else; `localStorage` alone is simpler and forgets on a new phone. Recommend one.

## Rules the design must keep (from the specs; not yours to reopen)

- **The briefing is the page.** Today is not three widgets. Anything that competes
  with the briefing for attention is wrong.
- **Nothing in Planning shows age.** Only Doing has a clock. A thinking item must
  never look neglected.
- **A suggestion never looks like a decision.** Claude's proposals and research are
  visibly provisional until a person accepts them.
- **Asked, not assigned.** A plan on your board that someone asked you to take is
  visibly a request until you accept it.
- **Shared Today is not personal Today.** The thread and briefing read identically
  for both members; the rails and calendars around them are each member's own.
- **Guests see nothing of the household.** The booking page has no member chrome,
  no names, no reasons — open nights and taken nights.
- **Every figure is text the engine wrote.** Design never implies precision the
  app doesn't have; no fake sparklines, no decorative charts.
- Single-file vanilla app, no build step, no framework, no CSS preprocessor. Fonts:
  Satoshi stays.

## Questions I want your answer to

1. Three source shades (mine / partner / household) that survive every scheme and
   both modes, and stay distinguishable to a colour-blind reader — show them.
2. The chip system: due, block, owner, free-text, Claude-research, stale-clock,
   source — one vocabulary, scheme-independent.
3. Where the scheme preference lives (see §6), with your recommendation.
4. How the guest page shares tokens with the app without looking like the app.
5. Whether `More ▾` is a menu or a row, on a phone.

## Deliverables

- `site/tokens.css` — the token set, all schemes, light and dark, documented inline.
- `docs/superpowers/design/2026-10-28-design-language.md` — the system: tokens,
  schemes, type, spacing, components, conventions, copy voice, Settings spec, and
  the per-member scheme decision. Written so a builder applies it without you.
- Mockups of Today, the Plan board, the Plan card, the Calendar week, Settings, and
  the guest page — in two schemes each, light and dark, at phone width and desktop.
  HTML that loads `tokens.css` is preferred over images, because the engineers can
  lift from it.
- A short note on what in `site/index.html`'s current styles to keep, rename, or
  retire, so the first engineering task is a migration and not a rewrite.

Nothing you produce is wired into the app; engineering does that from your
documents. Design the thing a couple will open every morning for the next ten
years, and that their friends will see once a year when they ask to visit.
