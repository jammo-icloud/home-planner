# Booking: friends book nights with the household

Status: design, for review. Brainstormed with the owner on 2026-10-28.
Companion to `2026-10-28-home-planner-design.md`. Built after it; switchable on
its own.

## Intent

A page where friends and family can ask to come and stay, and the household
says yes or no from Today like everything else. The owner's words: *"Friends
get a link, pick dates, we approve. I keep a list of friends' emails that I
recognize. They go to the link and enter their email; if they are on the list
we send a code and link in their email that they can follow — other
applications do this now, like Linear. They can then select an open time on the
calendar where other friends or family members have not picked."*

This is the one part of the planner with a different audience — people with no
account on the NAS — and so a different door, a different session, and a
different threat model. It shares the household, the log, the proposal pattern
and the Household calendar with everything else, and nothing else.

## Goals

1. **Passwordless, allowlisted sign-in.** A guest enters their email. If it is
   on the household's list, they receive a one-time code and a magic link by
   email. The page says the same thing whether the address is known or not. The
   code and the link appear **only** in the email — the inbox is the proof.
2. **Pick open nights.** The guest sees a calendar of nights marked open or
   taken, nothing else — never who has taken them, never anything from the
   household calendar. They choose arrival and departure, give a headcount and
   a note, and send the request.
3. **Decided on Today.** The request is a card in the household thread, raised
   by the guest. Approve, decline with a reason, or suggest other dates.
   Approval writes an all-day event across those nights on the Household
   calendar, marks them taken for every other guest, and emails the guest.
   Decline emails the reason.
4. **Change and cancel.** A guest can reopen their link to change dates or
   cancel; either comes back to Today as a card.
5. **Blocked dates.** Members can mark nights unavailable from the calendar.
   Guests see them as taken, with no reason.

## Non-goals

- No guest accounts, profiles or passwords.
- No payments, no deposits, no house rules engine.
- No guest view of anything but open/taken nights and their own requests.
- No public access to any other route. The booking page is the only surface a
  guest session can reach.
- No second allowlist. The list of emails is in the household log.

## Anti-goals — failures even if it technically works

- **The page reveals the code**, or reveals whether an email is on the list.
  Either turns the list into the only secret.
- **A guest learns who else is coming**, or sees any household event.
- **A guest session reaches a household route.** The guest cookie and the
  member cookie are different names on different paths; a guest token in a
  member route is simply unauthenticated.
- **Approval that does not write the calendar**, or a calendar write that does
  not email the guest. One decision, one event, one email, in that order, or
  the card stays waiting and says why.
- **Unbounded code requests.** Without a per-email and per-IP rate limit this
  is a mail cannon pointed at your friends.

## Constraints

- **Email is required.** No mail, no sign-in, no confirmations. Synology
  exposes no API for sending mail; DSM's own notifications and MailPlus Server
  both just speak SMTP. So the app sends SMTP itself, and *where* is deployment
  configuration: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_FROM` in `.env`. Pointing those at MailPlus on the NAS, or at an
  external relay, is the owner's choice and his job. If SMTP is unconfigured,
  the booking page is off and says so to members, not to guests.
- **The public door is the owner's reverse proxy.** The app serves the booking
  page under `/book`; exposing only that path to the internet, with TLS, is
  done at the proxy and is out of scope here. The app must still be safe if the
  whole thing is exposed: every non-booking route requires a member session,
  as today.
- **`BOOK_URL` is required.** The magic link must be built from a configured
  public origin, never from the request's `Host` or `X-Forwarded-Host`: with a
  forged host, anyone who guesses an allowlisted address can have the real
  friend emailed a link to the attacker's domain, and the single-use token goes
  with the click. Booking is off until `BOOK_URL` is set, the same way it is
  off until SMTP is.
- **`BOOK_HOUSEHOLD` names the one household that may book.** The server
  hosts many households and a guest has no session, so `/book` must know whose
  list to search and whose thread to post to. One house, one booking page; the
  env var says which. (Per-household public paths were considered and rejected
  for now — they expose household ids and multiply the attack surface for a
  need that does not exist.)
- Same log, same scopes machinery: booking events get scope `bookings`.
- Same proposal pattern: a request is `proposal.offer`, a decision is
  `proposal.decide`, decided by a member, attributed to them.
- **Builds after the planner's calendar work.** Today `checkWithDsm()` drops
  the DSM `sid` and no `SYNO.Cal.*` client exists, so approval cannot write a
  calendar until the planner has landed its session change, its Calendar
  client, and the Household calendar. Booking reuses all three.

## Decided in conversation

- **The allowlist** lives in the household log: `guest.allow { email, name,
  why }` and `guest.revoke { email, why }`, by a member, with a reason, so it is
  attributed, auditable, and restored with everything else. An entry may link a
  Synology contact. Only members edit it; there is no self-signup.
- **Sign-in flow.** `POST /book/start { email }` always responds *"If that
  address is one we know, a link is on its way."* If the email is on the list,
  the app sends one message containing a six-digit code and a magic link. The
  guest either follows the link or types the code. Success issues a guest
  session cookie scoped to `/book`.
- **What a guest sees.** A month-at-a-time calendar of nights, each open or
  taken. Taken is the union of approved stays, pending requests from *other*
  guests (so two friends cannot both pick the same week while a decision is
  pending), and member-blocked nights. Their own pending or approved requests
  are shown as theirs.
- **The form.** Arrival date, departure date, headcount, a note.
- **The request** is `proposal.offer { prompt: "booking", tool:
  "approve_booking", args: { email, name, arrive, depart, headcount, note } }`
  by the actor `guest:<email>`. It appears on Today as a card: *"The Nguyens
  would like to come Dec 12–15, 3 people: 'We'd love to see the house!'"* with
  **Approve** / **Decline** / **Suggest other dates**.
- **Approve** runs the effects first and records last. The approving member's
  session creates the all-day VEVENT on the Household calendar; then the
  confirmation email is sent; **only then** is `proposal.decide { approved }`
  appended together with `booking.confirm { arrive, depart, headcount, cal_id,
  evt_id, ical_uid, dav_etag }` in one write. If the calendar call fails,
  nothing is appended and the card says why. If the email fails after the
  event was created, the event is deleted and nothing is appended — the log
  never records an approval that did not fully happen. This is the planner's
  shared **effect stage** at decide time (its call 13), not a mechanism of
  booking's own. **Decline** is `proposal.decide { declined, why }`, appended
  after the email carrying the reason is sent.
- **Suggest other dates** keeps the invariant that only members decide
  proposals. It declines the original request (its nights are released),
  records `booking.suggest { email, arrive, depart, why }` by the member, and
  sends the guest a fourth email — *"those dates don't work, but how about…"* —
  with their link. Suggested nights are **not** held. When the guest accepts,
  the app raises a fresh `proposal.offer` for those dates marked *"you
  suggested these,"* and a member approves it with one click; if someone else
  took the nights in between, the card says so. A suggestion a guest never
  acts on simply lapses.
- **Change or cancel** by the guest raises a new card the same way; a cancel of
  an approved stay deletes the calendar event on approval of the cancel (which
  members may simply acknowledge).
- **Blocked nights**: `booking.block { from, to, why }` by a member, from the
  calendar view; shown to guests as taken; removable.

## Calls I made (the owner to check)

1. **Codes expire in 10 minutes; magic links are single-use and expire in 24
   hours**; a guest session lasts 30 days. Numbers are the builder's to tune;
   the shape is not.
2. **Rate limits**: five code requests per email per hour, twenty per IP per
   hour; over the limit the response is unchanged and nothing is sent.
3. **One party at a time.** Nights are exclusive. The owner said "where other
   friends or family members have not picked" and did not say otherwise.
4. **Pending requests block the nights** for other guests until decided, so a
   decision never has to choose between two friends who picked the same week.
5. **The guest actor** is `guest:<email>` in the log, so every request is
   attributed and a revoked guest's history remains readable.
6. **SMTP via a small dependency or raw SMTP** — the builder's choice; the API
   has stayed dependency-light and should stay so.
7. **Four emails, all plain text**, from `SMTP_FROM`, with the household's
   label as the display name: the code and link; confirmed (dates, headcount,
   the note as sent, the link to change or cancel); declined (with the
   reason); and other dates suggested (with the link). A guest is told about a
   counter-offer, not left to find it.
8. **Taken nights hide the reason.** A member-blocked night and a friend's stay
   look identical to a guest.

## Left to the builder

- The guest page's look, within the existing tokens but with none of the
  member chrome: no top bar, no household pill, just the calendar and the form.
- Exact copy of the three emails (code, confirmed, declined).
- How a counter-offer is shown to the guest and how long it waits.
- Test shape: a fake SMTP that records what would have been sent, and the
  guest session alongside the member session in `auth.test.ts`.
- Whether `booking.block` is also drawn on the member calendar view (probably
  yes, as a hatched all-day span).
