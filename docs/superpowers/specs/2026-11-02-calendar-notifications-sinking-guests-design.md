# A calendar like any other, Claude offline, notifications, sinking funds, and our friends' faces

Status: design, for review. Written on 2026-11-02 from the owner's answers to the
storyboard (`docs/design/2026-11-02-storyboard.md`). Where the owner gave an
answer it is quoted; everything else that needed a choice is marked
**Assumption** and can be overturned without unpicking the rest. Companion to
`2026-10-28-home-planner-design.md` (whose notification non-goal this design
reverses), `2026-10-28-booking-design.md` and `2026-11-01-storage-design.md`.

## Intent

The storyboard walked the app as a member, the owner and a guest, and the owner
read it against his own picture. Five things came back:

1. *"Working with this calendar should be like any other calendar."* Today the
   Calendar's New event button types "Schedule " into Ask Claude; with no key
   there is no way to add an appointment in the app.
2. *"Today should be 'offline' if there is no Claude integration or we are out
   of tokens. This is a simple use case to cut. It should be an error condition
   that tells the user, 'go fill your tokens!'"* Today writes a plain-words
   briefing instead, which hides that something is wrong.
3. *"In app notifications are important."* A friend's booking request and a
   partner's "take this plan" wait on Today until someone happens to open it.
   Both members use Apple devices. In-app (push) is preferred, email second, no
   SMS.
4. Sinking funds. *"You put XX in every month, with the expectation that you
   will be using that money in the future. It actually lives in savings, and the
   totals can add up and be validated."* One savings account holds them.
5. *"A picture of our friends that they upload that shows up in our calendar
   event and in app to reflect why we are doing all of this, to spend time with
   our friends!"* Kept between visits, replaceable. And, not built yet but
   wanted: *"a shared photo album from the visit booking that would get sent to
   everyone so that we can start the vacation with a shared photo album"*, in
   Synology Photos.

Each part stands alone and is built and merged separately (see Build order).

## Non-goals

- A native iPhone or Mac app. Everything here is the web app, installed to the
  Home Screen or Dock.
- SMS, or any paid messaging service.
- A CalDAV server or client of our own. Synology Calendar is the CalDAV server;
  Apple Calendar is the client. The app never sees a member's DSM password.
- Two-way merging of calendar changes. An event moved in Apple Calendar is
  Synology's truth; the app keeps reporting drift for plan-linked events as now.
- Investment, interest or yield on the savings account. The check is cents in
  envelopes against cents in the account.
- More than one savings account (owner: one).
- Face recognition, tagging or curating in Synology Photos. We make and share
  the album; Photos does the rest.

---

## Part 1 — The calendar like any other

Three ways in, in order of how much the owner should use them.

### 1a. Apple Calendar on the phone and the Mac (no code beyond a Settings section)

Synology Calendar is a CalDAV server, and the app already makes a Household
calendar and shares it with every member (`ensureHouseholdCalendar`,
`settings.ts`). Once a member adds their NAS account to Apple Calendar, the
Household calendar is a calendar on their phone like any other: create, move,
invite, alerts, Siri, widgets, all Apple's.

Settings gets a section, **Calendar on your iPhone and Mac**, that says:

- the CalDAV server address, built from `DSM_PUBLIC_URL` (new, optional; the
  public https origin of DSM, e.g. `https://nas.example.com:5001`); when unset,
  the section says to ask the owner for it rather than guessing from `DSM_URL`,
  which is usually an internal address. **Must verify** on the NAS the exact
  form Apple Calendar wants (the bare origin with discovery through
  `/.well-known/caldav`, or the account URL Synology Calendar shows under its
  CalDAV settings) before the words are final;
- the steps: iOS Settings → Calendar → Accounts → Add Account → Other → Add
  CalDAV Account; server as above; user name and password are the NAS ones;
  the same on the Mac in Calendar → Settings → Accounts;
- that the Household calendar and any partner calendars shared on the NAS
  appear there, and that events made there show in the app within a refresh.

**Assumption:** DSM's CalDAV is reachable from outside the house at the same
host as DSM. If the owner only exposes the planner (443) and not DSM, phones
sync only at home or over VPN; the section says so, and that is a deployment
choice, not code.

### 1b. A New event form in the app

The Calendar's **New event** opens a form instead of Ask Claude:

- What (summary, required), Day, All day or From/To times, Where it goes
  (Household, or My calendar), optional Plan (search existing; none by
  default), optional Notes.
- As the times change, the form calls the existing `POST /api/calendars/conflicts`
  and shows clashes under the times, with the free slots `freeSlotsNear` finds,
  as chips that fill the times. It does not block saving.
- **Save** calls a new `POST /api/calendar/events`, which builds an
  `AppointmentAsked` from the form, runs `appointmentTimes` to validate, and
  calls `makeAppointment` directly, appending what it returns.

There is no proposal. A person filling a form and pressing Save is the decision;
proposals exist for what Claude suggests. The event is logged as
`calendar.appointment` by that member, exactly as an approved proposal is, so
the Calendar, the plan link and undo behave the same.

Clicking an event the app made opens the same form filled in, with **Save** and
**Delete**. Saving writes the changes to Synology (the edit path drift already
uses); Delete removes it there and logs it. Events the app did not make (made in
Apple Calendar, or on a partner's calendar) open read-only with **Open in
Synology Calendar**.

With Claude configured, the reply box still accepts "schedule the dentist at 10
on Thursday"; the form is the way that never needs it.

### 1c. Open in Synology Calendar

A link in the Calendar header to `<DSM_PUBLIC_URL>/?launchApp=SYNO.Cal.Application`
(hidden when `DSM_PUBLIC_URL` is unset).

---

## Part 2 — Claude offline

When Claude cannot be used, the app says so plainly and stops pretending.

### What "offline" is

`claude.ts` classifies every failure into one of:

| State | Detected by | Words on screen |
| --- | --- | --- |
| `no-key` | `ANTHROPIC_API_KEY` unset | **Claude isn't set up.** Add an Anthropic API key to the planner's settings on the NAS. |
| `no-credit` | 400 whose message mentions the credit balance; 402 | **Claude is out of tokens — go fill your tokens!** Top up at console.anthropic.com, then press Try again. |
| `bad-key` | 401, 403 | **Claude's key was refused.** The key on the NAS needs replacing. |
| `busy` | 429, 529, timeouts | **Claude is busy.** Try again in a minute. |
| `unreachable` | network errors | **Claude can't be reached from the NAS.** |

The state, its words and when it was last seen are held in memory and served
by `GET /api/claude/status`. A success clears it. `no-key` is known at start;
the others are learned from the first failure.

### What changes on screen

- **Today:** the briefing area becomes the offline banner, with the words above
  and **Try again** (except `no-key`). The plain-words fallback briefing is
  removed: `brief`/`briefHousehold` throw the classified error instead of
  writing a `writtenBy: 'fallback'` section, and no section is stored for that
  day, so a later success writes the real one. Old fallback sections in the log
  still render as they did.
- **Ask Claude:** the reply box is disabled with the same one line.
- **Import:** Haiku suggestions are skipped and the screen says "Claude is
  offline: rules still sort, the rest waits for you." Rules and hand sorting are
  unchanged.
- **Settings:** a **Claude** section shows the state and, when working, the
  model in use.

What does **not** go offline: booking requests, take-this-plan asks, drift
cards, notes, envelopes, Import by rules and by hand. A friend's booking is
never stuck behind an empty Anthropic account. Those cards sit under the banner
as they do now.

**Assumption:** the owner is told once by notification (Part 3) when the state
becomes `no-credit` or `bad-key`, not every time a call fails.

---

## Part 3 — Notifications

### Can a web app do it?

Yes, on everything the household uses:

- **iPhone and iPad (iOS/iPadOS 16.4+):** Web Push works for a web app added to
  the Home Screen. It is opened from its icon, asks permission from a tap, and
  receives notifications on the lock screen, with badges, like any app. Not in a
  Safari tab: the Home Screen install is required, and the Settings section
  says how.
- **Mac:** Safari 16.1+ (and Chrome, Firefox) receive Web Push from the site
  directly, or from the app added to the Dock (Safari 17+).

Requirements the app meets or gains: https (it has it, on 443), a manifest with
`display: standalone` (it has it), a **service worker** (it has none: added
here), an **apple-touch-icon** PNG (the manifest has only an SVG, which iOS does
not use for the Home Screen icon: added here), and a VAPID key pair.

Push goes through Apple's (or Mozilla's, Google's) push service, encrypted
end to end (RFC 8291); the service sees that a message went, not what it says.
Bodies are still kept short and money-free.

### Pieces

- `site/sw.js`: receives `push`, shows the notification, and on click focuses or
  opens the app at the card (`/#today/<card id>`). Also sets the badge to the
  number of things waiting.
- `api/src/push.ts`: VAPID (RFC 8292, ES256 JWT) and aes128gcm encryption
  (RFC 8291) with `node:crypto` only, no new dependency, tested against the
  RFC 8291 appendix vectors. The key pair is generated on first start and
  kept in the data directory next to the session file, never in the log or
  the repo. `VAPID_SUBJECT` (env, a `mailto:` or the site's origin) is required
  by the push services; default `https://<BOOK_URL or the site's host>`.
- Devices: one record per member per browser (endpoint, keys, a label like
  "the owner's iPhone", added and last-success dates), kept in a file in the data
  directory beside sessions, **not** in the household log: endpoints are
  per-device secrets that churn. A 404 or 410 from the push service deletes the
  device.
- Settings → **Notifications**: Turn on (asks the browser), the list of this
  member's devices with Remove and Send a test, and which kinds they want.

### What notifies whom

| Kind | Goes to | Text |
| --- | --- | --- |
| Booking request | every member | "Sam asked to stay Mar 3–7" |
| Booking changed or withdrawn by the guest | every member | "Sam withdrew Mar 3–7" |
| Asked to take a plan | the member asked | "Alex asked you to take *Gutter cleaning*" |
| A card left for you by your partner | that member | "Bob left you a note" |
| Claude offline (`no-credit`, `bad-key`) | the owner | "Claude is out of tokens" |
| Sinking funds short (Part 4) | every member, once per statement | "Savings is $450 short of the sinking funds" |

Briefings and Claude's own suggestions do not notify; they are why you open
Today, not why you are interrupted.

### Email, second

When a member has notifications on for a kind but no device took it (none, or
all failed), it goes by email instead through the booking mailer (`mail.ts`),
to the address the member gives in Settings. **Assumption:** emails are batched
to at most one per hour per member, listing what is waiting, so a burst of
three booking requests is one email. With no SMTP configured, email is not
offered.

This reverses the home planner design's non-goal "No notifications, push or
email in this design"; that line is updated to point here.

---

## Part 4 — Sinking funds

### What exists

- Every envelope's leftover rolls into next month by default
  (`Envelope.rollover`, true unless set; Budget shows "carried in").
- A category can carry an estimate, "$9,000 every 10 years"
  (`Category.sinking`, `types.ts`), which the migration brought over from the
  old budget, and forecasts already leave those categories out of spending
  extrapolation (`analytics.ts`). No screen sets it and nothing derives a
  monthly amount from it.
- Imports keep transactions and their account, but no account balance.

### What it becomes

**A sinking envelope** is an envelope marked *Saved in Savings*. It always rolls
over. It has a goal of one of two shapes:

- **Every so often:** derived from its categories' estimates, e.g. Auto
  maintenance = tyres $1,200 every 4 years + service $600 every year =
  $25 + $50 = **$75 a month**, toward $1,800 of estimates. The estimates are edited on the envelope
  (they are still stored on the categories, so every budget derives from the
  same world).
- **By a date:** a target and a month, e.g. Bahamas $4,000 by March 2027;
  monthly = what is left ÷ months left, recomputed each month.

The month plan proposes the monthly amount as the envelope's planned figure
(a person may fund more or less). The envelope row shows **saved so far** (its
available balance), the goal, and a bar toward it; spending from it is ordinary
receipts in its categories, so the balance drops when the mechanic is paid.

**The savings account** is chosen once in Settings → Budget from the accounts
seen in imports (owner: one account). Its balance is learned from:

- OFX/QFX imports: the statement's `LEDGERBAL` (amount and date), recorded as
  `account.balance` (account, cents, as of day, source `statement`);
- CSV imports, which carry no balance: Import asks for it ("What does Savings
  show today?"), recorded the same way with source `typed`;
- or typed in Settings at any time.

**The check:** on Budget, a line under the sinking envelopes:

> Sinking funds hold **$12,050**. Savings showed **$12,500** on Oct 31.
> **$450 in Savings isn't in any fund.**

or **"Savings is $300 short of the sinking funds"** in the overspent colour.
The comparison uses envelope balances as of the balance's date, so a statement
from last week is compared with last week. When the balance is older than 35
days the line says so instead of comparing. A shortfall is also a Today card
(and a notification, Part 3) once per new balance.

**Assumption:** money is moved between checking and savings by hand, and those
transfers stay *Transfer / ignore*; the envelopes, not the transfers, are what
the check is about. The app does not tell anyone to move money.

---

## Part 5 — Our friends' faces, and a shared album for every visit

### The guest's photo

- On the booking page, after sign-in, a **Your photo** box: pick or take a
  photo. It is shown on every request from then on; **Change photo** replaces
  it (owner: kept, with the option to upload a new one). **Remove** deletes it.
- The browser shrinks it to at most 1024 px on the long side and re-encodes it
  as JPEG through a canvas before upload. Re-encoding drops the camera's
  metadata, including the GPS location phones put in photos. The server accepts
  only a JPEG under 1 MB whose dimensions are at most 1024, strips any APP1
  (EXIF/XMP) segment it still finds, and refuses anything else.
- It is stored in the planner's own data directory on the NAS, per household,
  under a hash of the guest's email (`guests/<sha256>.jpg`), not in Photos or
  File Station: a guest uploads when no member may be signed in, and every DSM
  write needs a member's session. It is copied into Photos when a stay is
  approved (below). The log records `guest.photo` (email, a content hash, when)
  and `guest.photo.remove`, never the bytes.
- **In the app:** the photo is on the booking request card on Today, on the
  guest's nights in the Calendar, and in Settings → Booking's allowlist.
  Members fetch it through `GET /api/guests/<email>/photo` (signed-in members of
  that household only).
- **In the calendar event:** the all-day stay event gets the guest's name and
  a link to the photo in its description. Apple Calendar shows the link, not
  the picture: Synology Calendar does not serve event attachments to CalDAV
  clients as images. (Must verify; if it does, attach it.)

### The visit's shared album (Synology Photos)

When a member approves a stay, after the calendar event and the confirmation
are done (those stay the approval itself), the app:

1. creates an album in Synology Photos named
   *"Sam & Alex at Placitas · Mar 3–7, 2027"*, holding the guest's photo as its
   first item when there is one;
2. shares it with every household member on the NAS with add rights, makes a
   view link for the guests, and a photo-request link they can add photos
   through (a public album link cannot take uploads; see below);
3. sends both links to the guest (a second short email, "Your album for
   Mar 3–7: see it here, add your photos here") and to members (a notification,
   Part 3), and shows them on the stay in the Calendar and on the booking card.

The album outlives the stay. If the stay is cancelled before the arrival day
and the album holds nothing but the guest's photo, it is deleted; otherwise it
is kept and only its link is disabled.

If Photos is not installed, not reachable, or refuses, the stay is still
approved and a card says "The album for Mar 3–7 wasn't made: <reason>" with
**Try again**. Album failures never undo an approval.

**Photos API facts** (album creation, sharing, whether a public link can allow
guests to upload, personal vs shared space): see *Synology Photos* below, filled
in from research before the build; anything marked there as unverified is
checked against the real NAS with `synology:check` before Part 5 is merged.

### Synology Photos

Synology publishes no Photos API. What follows is from Synology's own help
pages and release notes **[KB]**, and from open-source clients that captured
real requests on DSM 7.2.2 / Photos 1.9.1 (`cmeans/mcp-synology`, its
`photos-module-spec.md` and fixtures; `flingo64/PhotoStation-Upload-Lr-Plugin`;
`N4S4/synology-api`). All calls go through `entry.cgi`; every parameter value
is JSON-encoded (strings quoted).

**What it can do, and what we use:**

| Step | API, method, version | Notes |
| --- | --- | --- |
| Make sure the approving member's Photos exists | `SYNO.Foto.Setting.User get` v1 | a member who never opened Photos has no `homes/<user>/Photos`; this creates it (else uploads fail with 117) |
| Folder for the visit | `SYNO.Foto.Browse.Folder get`/`create` v1 | `Home Planner/Visits/<album name>` in the member's personal space |
| Upload the guest's photo | `SYNO.Foto.Upload.Item upload_to_folder` v1, multipart | returns the item id at once |
| The album | `SYNO.Foto.Browse.NormalAlbum create` v1 (`name`, `item=[id]`), `add_item` | a *normal* album; condition albums cannot take uploads |
| Share it | `SYNO.Foto.Sharing.Passphrase set_shared` v1 (`policy="album"`), then `update` with `permission` | returns `sharing_link`, `https://<host>/mo/sharing/<passphrase>` |
| Members | in the same `update`: role `upload` (Provider: add files) for each household member, ids from `SYNO.Foto.Sharing.Misc list_user_group` | |
| Guests see | in the same `update`: public role `download` | **a public link cannot upload** **[KB]**: view or view/download only |
| Guests add | `SYNO.Foto.PhotoRequest create` v1 (`subject`, `description`, `library="personal_space"`, `folder_home_path`, `filesize_limit`, `expiration`) | "anyone with the link can upload" **[KB]**, Photos 1.3+; link `…/mo/request/<passphrase>` |

So a visit gets **two links**, and the guest's email and the stay say both
plainly: **See the album** (the share link) and **Add your photos** (the
request link). The request expires 30 days after departure (**Assumption**).
Albums live in the approving member's *personal* space (albums and links exist
only there) and are shared to the other members with add rights, so both of us
add photos to the same album from our phones' Photos app.

**Must verify on the real NAS** with `synology:check` before Part 5 merges:

1. Whether `_sid` in the request body (how `synology.ts` calls DSM) works for
   `SYNO.Foto*`, or the `id` cookie and `X-SYNO-TOKEN` are needed, above all for
   the multipart upload.
2. The `PhotoRequest create` parameter that sends uploads into an album (the
   web UI offers "add photos to album"; no client captured it). Capture it from
   the browser's network panel. **If there is none**, uploads land in the visit
   folder and the album's description points to it; the album is not filled by
   the app later, because the app holds no member session in the background.
3. That a guest's request uploads appear in the album, and under whose name.
4. The member role string (`upload` vs `provider`) and the user id form.
5. Whether DSM's "limit sharing for non-admin users" is on, and whether it
   blocks public links or photo requests.
6. The Photos version and API max versions (`SYNO.API.Info query`).

**Errors worth naming** to the member on the album card: 160 (no Photos
privilege: the owner grants it in Control Panel → Application Privileges), 602
(User Home service is off), 801/803 (Shared Space or folder permission), 620
(file type), 623 (transient: retried once).

**Privacy:** sharing only over https; the guest's photo goes into Photos only
with a stay that was approved; the request link carries a per-file size limit
(20 MB, **Assumption**) and Photos strips metadata from request uploads **[KB]**.

---

## Build order

Parts are merged one at a time into `main`, each from its own worktree, each
with its tests and a walk against `fake-dsm`.

| Wave | Part | Starts | Why then |
| --- | --- | --- | --- |
| 1 | Part 1 Calendar | now | touches the Calendar view, `appointments.ts`, a new route |
| 1 | Part 4 Sinking funds | now | touches envelopes, Import parsing, Budget; independent of Part 1 |
| 2 | Part 2 Claude offline | after `storage` merges | `storage` rewrites `briefing.ts` and Today's briefing area |
| 2 | Part 3 Notifications | after `storage` merges | Settings and the service worker; its triggers include Part 2's |
| 3 | Part 5 Guests and albums | after Part 3 | sends its links by notification; needs Photos verified on the NAS |

`fake-dsm` gains what each part needs: CalDAV is not faked (Part 1a is
instructions); event update/delete for 1b if missing; Photos endpoints for
Part 5.

## Testing

- Part 1: route tests for `POST /api/calendar/events` (validation, household vs
  mine, partner refusal, plan link), edit and delete; the form walked in the
  browser against `fake-dsm` with no Claude key.
- Part 2: classification table driven by fake SDK errors for each status; Today
  with no key shows the banner and still shows a booking card; no fallback
  section is written.
- Part 3: RFC 8291 vectors for the encryption; VAPID JWT verifies with the
  public key; a local fake push endpoint receives and decrypts; 410 removes a
  device; email batching.
- Part 4: monthly derivation for both goal shapes; `LEDGERBAL` parsed from
  OFX/QFX fixtures; the check at, under and over; balances as of a past date;
  replay of an old log unchanged.
- Part 5: JPEG validation and EXIF stripping on fixtures (including one with
  GPS); the album made, shared and linked against `fake-dsm`; approval survives
  a Photos failure; cancellation rules for the album.
