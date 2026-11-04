# Settings, one menu, and setting up a phone

**Status:** approved by the owner on 2026-11-04 from the wireframes (five
boards: top bar, switch household, Settings, the phone sheet, the phone sheet
before the address is set). This document is what those boards mean.

## Intent

Three things confused the owner on first real use:

- The top bar had two menus, one for the household and one for the person,
  and the split was not obvious. Everything under either is something the
  signed-in person does, so there should be one menu, under the person.
- Connectors was a separate page reached from the person menu, though it is
  settings for the NAS. It belongs in Settings as a third group, seen by
  administrators only.
- Settings "ran on": every section was open at once with its whole form. And
  the "Calendar on your iPhone and Mac" section was help, not a setting, and
  gave a bare address that a phone cannot use.

The phone setup becomes a help sheet with a QR code. One scan installs an
Apple configuration profile that adds the Household calendar to Apple
Calendar as a CalDAV account and puts Home Planner on the Home Screen.

## Goals

- One menu under the person: Settings, Set up your iPhone, Switch household
  (sub-list), Sign out. The household's name shows under the person's name on
  the pill, so you always know which household you are in.
- Settings in three groups, You, Household, This NAS, every section a row:
  title, one line of status, one action. A row opens its form only when its
  action is pressed, in place.
- The Connectors page is gone; its rows are the This NAS group, with the same
  state pills (on, off, broken) and sources, visible to DSM administrators.
- "Set up your iPhone" sheet: a QR code carrying a ten-minute one-time link
  to a configuration profile; two checkboxes decide what the profile holds;
  a download for Macs; the typed instructions kept as a fold-out.
- Everything that moved keeps working: share, categories, backup and restore,
  the Today notices that open Settings or a Connectors row.

## Non-goals

- No change to the Calendar screen, the Today thread or the budget screens.
- No signed profiles. iOS shows "Not Verified" on an unsigned profile and
  installs it; that is accepted.
- No Android. Android has no profile mechanism; the typed instructions apply.
- No new persistent configuration beyond what exists. The NAS's public
  address stays the `DSM_PUBLIC_URL` connector.

## Navigation

The Household pill (`#hh-menu-btn`, `#hh-menu`) is removed. The person pill
(`#me-menu-btn`) shows: the member's disc and name, and under the name in
small type the household's name and today's date (what the Household pill
showed). Its menu:

1. A quiet line: "Signed in as <account> on the NAS" (exists).
2. **Settings** — opens Settings.
3. **Set up your iPhone** — opens the phone sheet (below).
4. **Switch household ›** — only when the member has two or more households.
   Opens a sub-list in the same menu: a Back row; the member's households,
   each with its name, its members and who owns it, the current one marked;
   and **Create a new household**. With one household the menu shows
   **Create a new household** in this slot instead.
5. **Sign out**.

Where the old Household menu's items went:

| Was | Now |
|---|---|
| Settings | Settings, first menu item |
| Share it with someone | Settings › Household › Members, action "Invite someone" |
| Categories | Settings › Household › Budget, action "Edit" opens the categories panel |
| Download a backup | Settings › Household › Backup, action "Download" |
| Restore from a backup | Settings › Household › Backup, action "Restore…" |
| (person menu) Connectors | Settings › This NAS |
| (person menu) Switch household | Switch household sub-list |

The Categories panel (`#cat-sec`) and the share and restore panels keep their
markup and behaviour; only what opens them changes. Nothing else that uses
`#hh-name` or `#today-date` breaks: both ids stay, on the person pill.

## Settings

One page, a left index and a body, as today, but the body is rows.

### Row anatomy

A row is: a title (fixed width), one line of status in words (what is set, or
"Not set"), and one action on the right. Pressing the action opens the row's
existing form in place under the status line, with its own Save/Cancel; the
row closes on save. A row with nothing to edit (the software line) has no
action. Owner-only rows show the action to the owner and the status to
everyone else.

### Groups and rows

**You** — "Only you see these. <others> keep their own."

| Row | Status line | Action |
|---|---|---|
| Appearance | a segmented System / Light / Dark control, inline (no form) | — |
| Calendars I check | the checked calendars, "·"-separated; a hint on conflicts | Change |
| Your iPhone and Mac | "Not set up on this device yet" or "Set up on this device on <date>" (kept in localStorage, per device); one sentence on what the scan does | Set up › (opens the phone sheet) |
| footer | `Home Planner <version> · commit <sha> · built <date>` (exists) | — |

**Household** — "<You both / Everyone> see and change these. Every change goes
in the household's history."

| Row | Status line | Action |
|---|---|---|
| Setup | the five setup steps in a two-column grid, ✓ or ○ each with its value; "Only <owner> chooses these. Each is also a row below." | — |
| Members | names, the owner marked | Invite someone (the share panel) |
| Areas | the areas, "·"-separated | Edit |
| Budget | "Categories: N in use · Savings shown today: $X" | Edit (categories panel; the savings form) |
| Household calendar | "<name>, on the NAS, shared with <others>" or "No Household calendar yet" | Rename · Replace (existing forms) |
| Guests and booking | "N guests on the list · Booking on/off"; when off and the booking address is unset, "Needs the booking address set under This NAS before it can go on." | Edit |
| Documents | "<Team Folder> › <folder> on Synology Drive · Cards keep files on/off" or "No folder chosen" | Change folder |
| Links under More | the labels | Edit |
| Backup | "The household's log, everything it has decided." | Download · Restore… |
| Time zone and Envelope model | stay inside Setup's rows as today (each setup step is a row's form) | — |

**This NAS** — administrators only. "Seen by DSM administrators only. Shared
by every household on this NAS." The seven Connectors rows in this order,
with their state pill and source as `connectors-view.ts` already computes
them: Claude; Synology Drive; **Where phones reach the NAS** (was "Calendar
on phones"); Mail; Booking address; Who may sign in; Pricing sources.

The "Where phones reach the NAS" row's hint: "DSM's own address from outside
the house, with its port, such as `https://nas.example.com:5001`. Not the
planner's address and not the LAN one. It is the server Apple Calendar is
given, and where 'Open in Synology Calendar' goes." Its value is still
`DSM_PUBLIC_URL`; `dsmPublicUrl()` keeps validating it.

### Opening Settings at a place

`openSettings(group, row)` replaces `openSettings(section, step)` and
`openConnectors(row)`: `group` is `you | household | nas`, `row` a row key.
The Today notices ("choose a folder" → `household`/`documents`; "Set up the
NAS" → `nas`/<row>) use it. A non-administrator asked to open `nas` is shown
Settings at the top with no error. The index on the left lists the rows of
the three groups; the This NAS heading and rows are absent for a
non-administrator.

### Removal

`openConnectors`, the `#me-connectors` item and the Connectors page view are
removed. `GET /api/connectors` and the `PUT`s stay as they are; the rows'
forms post to them from Settings.

## Set up your iPhone

A sheet, opened from the person menu or the "Your iPhone and Mac" row.

### Contents, when the address is set

- Title "Set up your iPhone", a Done button.
- One paragraph: one scan puts the Household calendar in Apple Calendar, with
  alerts and Siri, and Home Planner on the Home Screen; a change made to an
  event on the phone comes back as a card to approve.
- Two checkboxes, both on by default: **Household calendar** in Apple
  Calendar ("A CalDAV account for <account> at your NAS. The phone asks for
  your NAS password once.") and **Home Planner** on the Home Screen ("Opens
  full screen at the household's address, like Add to Home Screen").
- The QR code, 164 px, with: "Scan with the iPhone's camera. It opens a page
  on your NAS that hands Safari a configuration profile. Then: Settings →
  Profile Downloaded → Install." and the small print: "This code works for
  10 minutes and only for you. The profile is unsigned, so iOS says 'Not
  Verified'; that is expected."
- A button **Download the profile for a Mac** and a fold-out **Type it
  instead** with the iPhone and Mac steps, the server address
  `<DSM_PUBLIC_URL>/caldav/<account>/`, the user name, "your NAS password",
  and the note that Synology Calendar shows the same address under a
  calendar's menu, CalDAV Account.
- The closing line about reaching the NAS from outside, and that members who
  skip this lose nothing in the app.

The checkboxes change the code: unticking one requests a new code without
that payload. At least one must be on; with both off the code area says so.

### Contents, before the address is set

The same title and first sentence, then a dashed placeholder where the code
would be ("No code until the NAS's address is set"), a paragraph saying a DSM
administrator sets it once under Settings › This NAS › Where phones reach the
NAS, and: for an administrator a button **Set the address ›** that opens that
row; for anyone else "Ask <an administrator's name, or 'an administrator'> to
set it." The Home Screen payload alone does not need the address, so when the
address is unset the sheet still offers the code with the calendar checkbox
disabled and the Home Screen one on.

### The one-time link

`POST /api/phone-setup/code` with `{ calendar: boolean, home: boolean, origin: string }`
(session required) answers `{ code, expiresAt, url }`. The code is 32 random
bytes base64url, kept hashed in memory with the member's name, the household,
the two flags, the origin and an expiry ten minutes out, as the booking codes
are kept; one live code per member, a new request replaces it. `origin` is the
page's `location.origin`, where the Home Screen icon will open; it is
accepted only if it is `https:` (or `http:` on a loopback host) and is kept
with the code, never read from a later request. `url` is
`<origin>/setup/<code>`.

`GET /setup/<code>` needs no session: it looks the code up, and if live
answers the profile with `Content-Type: application/x-apple-aspen-config` and
`Content-Disposition: attachment; filename="home-planner.mobileconfig"`, then
burns the code. Expired, unknown or already used codes answer 404 with a
short HTML page: "This code has expired. Open Home Planner on your computer
and make a new one from Set up your iPhone." The page carries no household
data.

`GET /api/phone-setup/profile?calendar=1&home=1` (session required) answers
the same profile for the signed-in member for the Mac download, using the
request's origin for the Home Screen payload under the same rule.

`GET /api/phone-setup/qr?code=…` is not needed: the QR is rendered on the
server into the `code` answer as `qr`, an SVG string, drawn with the `qrcode`
npm package (`toString(url, { type: 'svg' })`). That is the one new
dependency.

### The profile

A property-list XML, `PayloadType: Configuration`, `PayloadVersion 1`,
`PayloadIdentifier` `name.homeplanner.setup.<member>` (reverse-DNS style with
a stable per-install random suffix is not needed; the identifier only has to
be stable so a reinstall replaces the earlier one), `PayloadUUID` a v4 UUID
derived deterministically from the member and the flags (so reinstall
replaces), `PayloadDisplayName` "Home Planner", `PayloadDescription` "The
Household calendar in Apple Calendar, and Home Planner on your Home Screen.",
`PayloadOrganization` the household's name. `PayloadContent` holds:

- When `calendar`: `com.apple.caldav.account` with `CalDAVAccountDescription`
  "Household calendar (NAS)", `CalDAVHostName` the host of `DSM_PUBLIC_URL`,
  `CalDAVPort` its port (443 when none), `CalDAVUseSSL` true when the scheme
  is https, `CalDAVUsername` the member's DSM account, and
  `CalDAVPrincipalURL` `/caldav/<account>/`. No password: iOS asks for it on
  install. If a first real install shows that iOS wants the bare `/caldav/`
  instead, that one constant changes; the typed fallback shows the same path
  the profile uses.
- When `home`: `com.apple.webClip.managed` with `Label` "Home Planner", `URL`
  the kept origin, `FullScreen` true, `IsRemovable` true, `Precomposed` true,
  and `Icon` the PNG at `site/icon-180.png` as base64 data.

`site/icon-180.png` is a new file: a 180×180 PNG of the app icon. The
repository has no image tooling, so it is produced once by a small Node
script (zlib only) that paints the icon's background colour with the
household glyph omitted; a real rendering of `icon.svg` can replace it later
without any code change. The manifest keeps pointing at `icon.svg`.

### Marking the device

When the sheet made a code or the Mac download was pressed, the page stores
`phone-setup-at: <ISO date>` in localStorage, and the "Your iPhone and Mac"
row reads it for its status line. It is a convenience, not a record.

## Words

- "This NAS", not "Connectors", everywhere a person reads it. The API path
  `/api/connectors` and the file `connectors.json` keep their names.
- "Where phones reach the NAS", not "Calendar on phones".
- "Set up your iPhone" is the menu item and the sheet's title; the row is
  "Your iPhone and Mac".

## Documents

- `DEPLOY.md`: the Connectors section becomes "Settings › This NAS"; the
  phone section describes the profile, the one-time link, what it carries,
  and the address rule; the fallback typed address.
- `README.md`: the "How it is configured" paragraphs name Settings › This NAS
  instead of a Connectors page; one sentence on the QR setup.
- `api/tools/synology-check/README.md`: unchanged, except the one line that
  calls the row "Calendar on phones".

## Tests

- The menu: one pill; Switch household present only with two or more
  households; Create a new household always reachable.
- Settings: three groups for an administrator, two for a member; each row's
  status line for set and unset states; `openSettings('nas', 'phones')` lands
  on the row for an administrator and at the top for a member; the Today
  notices still open the right place.
- The code: a POST answers a URL and an SVG; the GET serves a profile once
  and 404s the second time and after ten minutes; a bad origin is refused
  400; the profile's plist parses and holds exactly the payloads asked for,
  with the CalDAV fields from `DSM_PUBLIC_URL` and the web clip's URL equal
  to the kept origin; no profile is served without a session on the `/api`
  route.
- The profile for a Mac via `/api/phone-setup/profile`.
- Nothing in any response from `/setup/<code>` names the household's data.

## Left to the builder

The exact CSS of the rows within the existing tokens, the order of the index
links, how the in-place form animates, and how the sub-list in the menu is
focused for a keyboard. The plist writer is a small hand-rolled function; no
plist library.
