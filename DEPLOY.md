# Deploying to the Synology

The container asks DSM whether your credentials are real and then issues its
own session cookie. There is no second password to manage, and disabling a DSM
account disables this too.

```bash
cp .env.example .env      # everything in it is optional; see Environment
docker compose up -d --build budget-api
```

That is the laptop file. On the Synology itself, behind https, use `docker.yml`
instead: see [On the NAS, behind https](#on-the-nas-behind-https).

Open `http://nas-ip:8090` and sign in with a DSM account. What belongs to the
whole NAS (its public address, who may sign in, mail, the Claude key and the
pricing keys) is set by an administrator, any account in DSM's administrators
group, on the Connectors page under the person icon: see [Connectors](#connectors).
What belongs to a household (where its documents live, its time zone, its
calendar, booking and the envelope model) is set by that household's owner, in
Settings. Nothing in `.env` is needed to start. Without the Claude key the app
still runs — briefings fall back to a plain generated summary quoting the same
figures, without Claude's prioritising.

---

## Checking the NAS's API shapes

The calendar, contacts and file features call DSM APIs that Synology documents
only in part, so the client in `api/src/synology.ts` makes guesses. After the
first deploy, run the check once, from a checkout on any machine that reaches
the NAS (the image does not carry it):

```bash
cd api
read -rs CHECK_PASS && export CHECK_PASS
CHECK_USER=<your-dsm-account> DSM_URL=http://nas-ip:5000 npm run synology:check
```

It only reads, apart from the one write you have to ask for (below), and never
prints the password or the session id. It prints the version range of each API
and the raw reply to each read, beside what the app makes of it.
`api/tools/synology-check/README.md` lists every guess and what to change. The
ones most likely to matter:

| What you see | What to do |
|---|---|
| `Contacts` is `NOT OFFERED` | Install Synology Contacts from Package Center. The version is not a setting: the app asks the NAS which one to call. |
| `SYNO.Cal.Event list` is refused with 114 or 120 | `cal_id_list` is the wrong parameter name: change it in `listEvents`, the one place it appears. |
| Changing a plan's date in the app after its event was moved on a phone (the check cannot show this one) puts a card in Today, "Bob moved Fix the gate to Sun 8 Nov on their phone", with three choices | Nothing: that is the stale-etag refusal working, turned into a drift card (see [Calendar on the NAS](#calendar-on-the-nas)). |
| The same change says "the NAS refused SYNO.Cal.Event set (code 9007)", or 9009 or 9017, instead of raising the card | That code is the stale-etag refusal after all: take it out of `NOT_AN_ETAG_REFUSAL` in `synology.ts`. |
| An administrator is `REFUSED` the question of who is in the administrators group or which accounts exist (probes 1 and 2), or the reply is not `{ users: [{ name }] }` | Change `ADMIN_GROUP_CALL` or `ACCOUNTS_CALL` in `api/src/accounts.ts`. Until then name the administrator in `ADMIN_USER`: a reply the app cannot read counts as nobody, so a real administrator would be taken for an ordinary member. |
| No Team Folder shows `can_write` (probe 3) | Every Team Folder would be read-only to the app: `teamFolders` in `drive.ts` reads that field. Report the reply. |
| A name already taken is answered with something other than **1003** (probes 4 and 5) | Put the code in `DRIVE_NAME_TAKEN` in `drive.ts`. |
| A moved file is found later than 3000 ms (probe 5) | Raise `MOVE_WAIT_MS` in `moves.ts`. Until then a slow move is left for the next pass, and nothing is lost. |

The check also asks seven things that Connectors and Settings rest on: how DSM
names its administrators and accounts, what a Team Folder says a member may
do, how folders are listed and made, and how a file is moved (probes 1 to 7 in
the README, under `── What the configuration design guessed ──`). Some of them
want more than a member's account:

```bash
cd api
read -rs CHECK_PASS && export CHECK_PASS
read -rs CHECK_ADMIN_PASS && export CHECK_ADMIN_PASS
CHECK_USER=<your-dsm-account> DSM_URL=http://nas-ip:5000 \
  CHECK_ADMIN_USER=<an-administrator> CHECK_SECOND_TEAM=<another-team-folder> \
  PLANNER_ROOT=/Planner CHECK_DRIVE_WRITE=1 npm run synology:check
```

- `CHECK_ADMIN_USER` and `CHECK_ADMIN_PASS` go together, or not at all. With
  them, how DSM names administrators and accounts is asked as the member and as
  the administrator; without them, only as the member.
- `PLANNER_ROOT` here is a Team Folder you may write, for this run only; the app
  does not need it set. With `CHECK_DRIVE_WRITE=1` the check makes
  `.planner-check` in it and writes a few small files there, and moves one
  between folders. It deletes nothing: delete `<PLANNER_ROOT>/.planner-check`
  yourself afterwards, in File Station.
- `CHECK_SECOND_TEAM=<name>` is a second Team Folder you may write. One of the
  move checks then moves a file into its `.planner-check` and back.

---

## When sign-in fails

The message is deliberately the same for a wrong password and an account that is
not permitted, so account names do not leak. **The log says which it was:**

```bash
docker compose logs budget-api --tail 20
```

| What the log says | What to do |
|---|---|
| `refused "x": not in ALLOWED_USERS` | The list is the one saved on Connectors (Who may sign in), or `ALLOWED_USERS` in `.env` while none is saved; the log calls it `ALLOWED_USERS` either way. It must hold **DSM account names**, which may not be your first names (Control Panel → User & Group). An administrator who can still sign in changes it on Connectors, or clears it so any DSM account may sign in. If no one can, see [An allowlist that locks everyone out](#an-allowlist-that-locks-everyone-out). |
| `DSM refused "x": that username or password is not right` | DSM itself rejected it. Try the same credentials on DSM directly. |
| `cannot reach the NAS … (SELF_SIGNED…)` | `DSM_URL` is on HTTPS with a certificate the container does not trust. Point it at `http://host.docker.internal:5000`. |
| `cannot reach the NAS … (ECONNREFUSED)` | `DSM_URL` or the `extra_hosts` mapping is wrong. |
| `something answered at DSM_URL but it is not DSM (HTTP …)` | The port reaches something other than DSM — another service on the NAS, or AirPlay on a Mac's 5000. Check `DSM_PORT` against Control Panel → Login Portal → DSM. |
| Sign-in works but the household list is **empty** | Nothing you are a member of. If this is a fresh upgrade from a single-log install, check the boot log for `adopted … as household` — if it is missing, `LOG_PATH` is not pointing at your old log. If it is there but you were not added, `ADMIN_USER` was unset at first boot. |
| `is owned by "x" and ADMIN_USER is unset` | The adopted log was claimed by a name that may not exist on this NAS, and no admin was configured to fall back on. Set `ADMIN_USER`, delete the directory it created under `HOUSEHOLDS_DIR`, and restart so adoption runs again. |
| Households vanish on every redeploy | `HOUSEHOLDS_DIR` is not on the volume. It must be under `/data`. |
| An administrator has no Connectors under the person icon, and the log says `could not ask DSM whether x is an administrator: code N` | DSM answered the question about its administrators group in a way the app does not read. Run the check as an administrator (probe 1; see [Checking the NAS's API shapes](#checking-the-nass-api-shapes)); until then set `ADMIN_USER` to that account. |

Claude being unavailable never stops the app. The log says why:

| What the log says | What it means |
|---|---|
| `briefing written without Claude: …` | The day's briefing is the plain summary. The next look tries Claude again and, if it answers, its briefing replaces the plain one for the rest of the day. |
| An import says *Claude could not suggest envelopes* | Haiku was unreachable or out of credit. Everything still imports; rules still sort; the rest are sorted by hand. |
| The Claude row on Connectors says *The key has expired or been revoked* | The key was reset or revoked. Paste the new one on Connectors: it counts from the next request, with no rebuild and no restart. |
| A question shows *Claude didn't answer this one* | The question is recorded; the answer is not. Ask again once the key or credit is sorted. |

## Who owns the budget

A log is a household: **one shared budget, one owner, and the people they invite.**
There is one log per household, in its own directory under `HOUSEHOLDS_DIR`.

**Any DSM account on the NAS may sign in**, and gets a household of its own the
first time they make one. Isolation is per household, not per server — so a new
account signing in sees an empty app, never anybody else's money. An
administrator can narrow that to a named list on Connectors (Who may sign in),
or with `ALLOWED_USERS` in `.env` until one is saved; leaving it empty is the
intended setup here.

Claiming a household is an event in its log, so "whose budget is this" has a name
and a date on it rather than living in an env var. The owner then shares it:

```bash
curl -X POST http://nas-ip:8090/api/members \
  -b cookies.txt -d '{"member":"<their-dsm-account>","why":"my partner"}'
```

After that both of you see **byte-identical state**. There is no per-person view
and no merge — two people budgeting from different pictures is the problem this
exists to solve. One person's `move` and the other's `assign` land in the same
log, each attributed to whoever made it.

Isolation is enforced at every route. Someone with a valid DSM login who is not a
member gets `403` and nothing else — not a balance, not a category list. The
owner cannot be removed, so a household always has an administrator.

Three gates, deliberately separate:

| | Set where | Decides |
|---|---|---|
| who may sign in | Connectors, by an administrator (`ALLOWED_USERS` in `.env` until one is saved) | who may sign in at all — empty means any DSM account |
| membership | the log, by the owner | who may use a given budget |
| the administrator | DSM's administrators group (`ADMIN_USER` in `.env` overrides it) | who may list households and use Connectors — never read the households |

Changing who has access needs no redeploy, and leaves a record of who granted it
and why — sharing requires a reason the same way moving money does. The same is
true of the sign-in list: saving it on Connectors counts from the next sign-in.

### The administrator

**Any account in DSM's administrators group is the administrator.** The app asks
DSM, with the account's own session, at sign-in: DSM answers the question for an
administrator and refuses it for anyone else, and a refusal is read as "not one"
without a word in the log. `ADMIN_USER` overrides the group: set, it names the one
account that is the administrator, and the group is not asked. Leave it unset
unless the group does not work on your NAS (see *When sign-in fails*). The boot
log says which rule is in force: `admin: DSM's administrators group` or
`admin: ADMIN_USER=<name>`.

An administrator can do two things. They can see **that households exist**
(owner, size on disk, last activity, and which folder each keeps its documents
in) at `GET /api/admin/households`, and they can use Connectors. Neither is a
way into a household. There is no route by which an admin reads another
household's categories, receipts or balances, and being an admin does not make
you a member.

Whether someone is an administrator is decided once, at sign-in, and kept with
their DSM session in memory only. A sign-in carried over a restart has no DSM
session, so it is not an administrator's until they **sign in again**: Connectors
is closed to them until then.

One exception, and it is a migration rather than a power: on the very first boot
after upgrading from a single-log install, the old log is adopted as a household
and `ADMIN_USER` is **added as a member of that one household**, because the log
was claimed by whatever name the old server ran under and that name may not be a
DSM account here. Without it the sign-in succeeds and the household list comes
back empty, with the money on disk and nothing able to open it. Only
`ADMIN_USER` does this: the group is asked with a session, and there is none at
boot. The addition is an ordinary `member.add` event carrying a reason that says
the server did it, and the boot log says so too.

## The local bypass

`DEV_USER=local` lets that one name sign in with any password and no DSM at all.
It grants **the whole application and none of your money**: a bypass session is
pointed at `/tmp/dev-events.jsonl`, a separate log with its own household that
nobody shares. Every screen works, the data is not yours, and the sandbox is
discarded when the container restarts.

That is what makes it safe to leave the door open — there is nothing behind it.
It is still worth leaving unset in production.

---

## Environment

Every variable below is the deployment's value, read when it is used. The ones
marked *a default* are used only until an administrator saves a value on
[Connectors](#connectors), or a household's owner saves one in Settings; the
screens call such a value *from the deployment* while it is the one in use. A
saved value counts from the next request, with no restart and no rebuild.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8090` | |
| `DSM_URL` | `http://host.docker.internal:5000` | Needs `extra_hosts: host.docker.internal:host-gateway`. Compose builds it from `DSM_PORT`. |
| `DSM_PORT` | `5000` | DSM's HTTP port. Leave unset on the NAS. On a laptop, the port `api/tools/fake-dsm` listens on (`5555`; a Mac holds 5000 for AirPlay). Stays in `.env`. |
| `DSM_PUBLIC_URL` | unset | *A default.* Set it on Connectors (Calendar on phones). DSM's address as a phone reaches it from outside the container, such as `https://nas.example.com:5001` (the origin only; a path is dropped). Settings tells members to add the NAS's calendar to their iPhone and Mac at this address, and the Calendar's *Open in Synology Calendar* link goes to it. Unset hides the link and tells members to ask the owner. Not guessed from `DSM_URL`, which is usually an address only the container can reach. See [Calendar on the NAS](#calendar-on-the-nas). |
| `PLANNER_ROOT` | unset | Only for an install from before folders were chosen in Settings: the share its files were kept in, such as `/Planner`. A household whose log already names files under it has that folder carried over, once; and it is the first Team Folder the picker suggests. It is never where a new household's documents or files go. See *Documents in Synology Drive*. |
| `LOG_PATH` | `/data/events.jsonl` | The volume. Only the old single log is read from here, once, to be adopted as a household. |
| `HOUSEHOLDS_DIR` | `/data/households` | One directory per household. **Must be under `/data`** — anywhere else is inside the image and is lost on redeploy. |
| `CONNECTORS_PATH` | `/data/connectors.json` | What the administrators save on Connectors: the mail password and the keys are in it. On the volume, beside `sessions.json` and outside `HOUSEHOLDS_DIR`. Run outside the image, the default is `data/connectors.json`. See [Connectors](#connectors). |
| `ALLOWED_USERS` | unset | *A default.* Set it on Connectors (Who may sign in). Unset or empty means any DSM account may sign in, each getting its own household. |
| `ADMIN_USER` | unset | Optional: the administrators group decides, unless this names one account. Then only that account is an administrator. See *The administrator*. |
| `COOKIE_INSECURE` | unset | Set to `1` for plain HTTP on the LAN. **Unset it once TLS is in front**, so the session cookie is `Secure`. |
| `TZ` | `UTC` | *A default.* Each household's owner chooses its zone in Settings. Until they do, this is the zone: an **IANA name** such as `America/Denver` (never `MST` or `-07:00`). It decides which day "today" is, so a wrong value shifts receipts across month boundaries, and is the zone of every calendar event the app makes. The compose files set it for you (`UTC`, or `America/Denver` in `docker.yml`), so Settings says *from the deployment* even when `.env` leaves it empty. See [Calendar on the NAS](#calendar-on-the-nas). |
| `ANTHROPIC_API_KEY` | — | *A default.* Set it on Connectors (Claude). Absent means briefings still generate, without Claude; notes work; "Ask Claude" says it is not set up; imports are sorted by rule and by hand. |
| `CLAUDE_MODEL` | `claude-opus-5` | Writes the briefing and answers questions. |
| `CLAUDE_MATCH_MODEL` | `claude-haiku-5-5` | *A default.* Each household's owner chooses the model in Settings. Leave empty for the default. Suggests envelopes for imported receipts no rule caught. Sent payee names and envelope names only. |
| `CENSUS_API_KEY` | — | *A default.* Set it on Connectors (Pricing sources). Free. Without it, county rent and property-tax figures are unavailable. |
| `EIA_API_KEY` | — | *A default.* Set it on Connectors (Pricing sources). Free. Without it, the average electricity bill is unavailable. |
| `SESSIONS_PATH` | `/data/sessions.json` | Who is signed in, as token hashes. On the volume so a redeploy keeps everyone signed in (to the budget, not to the NAS: see below). |
| `DEV_USER` | — | The local bypass. Sandbox only, but leave it unset in production. |
| `BOOK_URL` | unset | *A default.* Set it on Connectors (Booking). The booking page's public origin, e.g. `https://book.example.com`. No path. See Booking. |
| `BOOK_HOUSEHOLD` | unset | *A default,* and only a fallback: each household's owner turns booking on in Settings. See Booking. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | unset | *A default.* Set them on Connectors (Mail). Where booking's mail goes out. See Booking. |
| `SMTP_PLAIN_AUTH` | unset | *A default,* with the mail above. `1` lets the SMTP password go over a connection with no TLS. Only for a relay on the NAS itself. See Booking. |
| `TRUST_PROXY` | unset | How many reverse proxies are in front: `1` for one (whether it appends to `X-Forwarded-For` or replaces it), `2` for two. The per-IP limits (booking's sign-in emails and codes, members' passwords) then read the address that many entries from the right of `X-Forwarded-For`, which a client cannot forge. Unset means the connection's own address. Stays in `.env`. See Booking. |
| `FAKE_DSM_ACCOUNTS` | unset | Laptop only: the test accounts `api/tools/fake-dsm` accepts, as `name:password[:otp[:admin]]`, comma separated; `alice:correct-horse::admin` is an administrator. Test values, never real DSM passwords. Stays in `.env`. |

`SYNO_CONTACTS_VERSION` is no longer read: the app asks the NAS which version of
the Contacts API to call, the first time Contacts is used, and keeps the answer
in `connectors.json`. Boot says so if it is still set.

Sessions last seven days and survive a redeploy. They are kept in
`/data/sessions.json` as **hashes** of their tokens, never the tokens, so the
file says who is signed in until when and nothing in it works as a cookie — a
bearer token still never sits on the same volume as the thing it unlocks. It
does not need backing up; losing it costs a sign-in.

What does not survive a redeploy or restart is the DSM session behind each
sign-in, which is kept in memory only. The budget itself keeps working, but
Calendar, Contacts and Files answer "sign in again to use this" until the
member signs out and signs in again; that is expected after every redeploy,
not a fault. The same goes for being an administrator: Connectors is closed to
an administrator whose sign-in was carried over, until they sign in again.

Because a restart no longer signs anyone out, this is how to:

```bash
docker compose stop budget-api && rm api/data/sessions.json && docker compose start budget-api
```

## Connectors

Connectors holds what belongs to the whole NAS rather than to any household. It
is a page under the person icon, and only an administrator sees it (the routes
under `/api/connectors` answer anyone else 403). It has seven rows. Each is on,
off or broken, says in one line how it stands, and says where its value comes
from.

| Row | What an administrator sets there | The `.env` default |
|---|---|---|
| Claude | the API key | `ANTHROPIC_API_KEY` |
| Synology Drive | nothing: whether Drive answers your session, and how many households have chosen a folder (the folder is each owner's choice, in Settings) | — |
| Calendar on phones | DSM's address as a phone reaches it | `DSM_PUBLIC_URL` |
| Mail | host, port, user, password, the address mail comes from, and whether the password may go with no TLS | `SMTP_*`, `SMTP_PLAIN_AUTH` |
| Booking | the booking page's address (the switch is each household's own, in Settings) | `BOOK_URL` |
| Who may sign in | DSM account names, picked from the list DSM gives an administrator or typed | `ALLOWED_USERS` |
| Pricing sources | the Census and EIA keys | `CENSUS_API_KEY`, `EIA_API_KEY` |

**An `.env` value is the default until something is saved.** A row says which
value it is using, in these words: *saved* (an administrator saved it here),
*off* (an administrator saved it off, which beats a value in `.env`), *from the
deployment* (the value in `.env`, or the compose file's own default) and
*default* (nothing saved and nothing in `.env`). Clearing a row puts the
deployment's value back. Who may sign in cannot be saved off: clearing it is how
any DSM account is let in again, when `.env` has no list of its own.

**Where it is kept.** In `api/data/connectors.json` (`/data/connectors.json` in
the container; `CONNECTORS_PATH` moves it). The file is mode `0600`, is written
whole and renamed over, and holds the mail password and the keys, so **never
commit it** (`api/data` is ignored) and keep any copy as private as `.env`. It
sits on the volume beside `sessions.json`, so a copy of `api/data` takes it
along with the logs: back it up with them. Losing it costs re-entering what was
saved there, and every row goes back to its `.env` value. A secret is never
written to a household's log, and none comes back to the browser: the page and
every answer say only `set` or `not set` of the mail password, the Claude key
and the Census and EIA keys. Saving mail without a password keeps the saved one.

**Edited by hand.** One entry of the wrong shape is ignored and the deployment's
value applies; the rest of the file still counts, and sign-in still works. Boot
names the entry. A file that does not parse at all is ignored whole and left as
it was.

### An allowlist that locks everyone out

Saving Who may sign in is refused when the list leaves out the administrator
saving it, and clearing the saved list is refused when `ALLOWED_USERS` in `.env`
would leave them out. Names are trimmed and lowercased, as sign-in reads them. A
list can still lock everyone out, though: it may name accounts that cannot sign
in, or the administrator's DSM account may be removed afterwards. **An allowlist
that locks everyone out is undone by deleting `signIn` from `connectors.json` and
restarting.** On the NAS, all of it is done in DSM:

1. Container Manager → Container → `home-planner` → Details → Terminal →
   Create. This opens a shell inside the container. The image is Alpine and
   has no `bash`: if Create opens nothing, use the arrow beside it → Launch
   with command, and enter `sh`.
2. The file is `/data/connectors.json`, one JSON object with `signIn` as a key
   at its top level. Remove that key and leave the rest as it is:

   ```sh
   node -e "const fs=require('fs'),f='/data/connectors.json',c=JSON.parse(fs.readFileSync(f,'utf8'));delete c.signIn;fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
   ```

   Writing over the file in place keeps its owner and its 0600 mode, and the
   container gives `/data` back to the app's user as it starts in any case.
3. Container Manager → Container → `home-planner` → Action → Restart.

On a laptop, delete the `signIn` entry from `api/data/connectors.json` in an
editor and run `docker compose restart budget-api`. Either way,
`ALLOWED_USERS` in `.env`, or any DSM account if it is empty, applies again.
Nothing else in the file needs to change.

### The Claude key

*Claude* on Connectors is where the key lives. A key that is reset or revoked is
pasted there: it counts from the next request, with no rebuild and no restart.
The key is trimmed when saved, so a newline from a password manager does no
harm; a key with a space or a line break **inside** is refused in words, since
the request's headers would refuse it.

*Test* sends one small request with the key as it stands and keeps the answer on
the row (never the key). A live refusal from Claude (a 401) makes the row
*broken*, "The key has expired or been revoked", until a new key is saved or a
Test passes. That is kept in memory only: a restart forgets it, and the next
call finds out again. A Test made before the last save counts nowhere. Whatever
the row says, Claude being unavailable never stops the app (see *When sign-in
fails*).

### Mail

*Send a test* mails an address you give and keeps the result on the row, and the
address for next time. Mail whose last test failed is not counted as working mail
by booking, until a test passes or the mail is saved again.

### What the administrator is reminded of

An administrator's Today carries one quiet card, *Set up the NAS*, naming the
rows among Claude, Calendar on phones, Mail and Pricing sources that have
nothing saved and nothing in `.env`, or that are broken. It is a reminder, never
a decision, and goes once they are set up. A row saved off is off on purpose
and never counts, and Synology Drive, Booking and Who may sign in never do.

## Calendar on the NAS

Plans' dates, Today's calendar rail, the Calendar screen and appointments
Claude proposes all live in **Synology Calendar**, read and written with each
member's own DSM session. Nothing about the calendar is stored anywhere else;
the log says only which event is whose.

**Install the Synology Calendar package** (Package Center) before anyone uses
the app. Without it every calendar call is refused: Today's rail and the
Calendar screen say why in a line, and the plans' dates are still drawn.

**The Household calendar is made on first use, and the owner makes it.** There
is none until the household's owner sets a due date, blocks time on a plan, or
approves an appointment, or chooses it in Settings. Their account makes a
calendar called *Household* and shares it read-write with every other member. A
member who does one of those first is told it is the owner's to choose. Only
its maker can change who it is shared with, so a member added later is shared
the next time its maker opens the app. If the maker's account goes, or the
calendar is deleted in Synology Calendar, the owner chooses Settings → Household
calendar for a new one in its place; the app finds it gone when its maker's own
list of calendars no longer shows it, and a household that books has booking
turned off then (see *Booking*). Plans go to it unless the owner picks another
calendar in Settings: one the owner made, and has shared read-write with every
other member.

**A drift card** is how a change made outside the app arrives. When someone
moves, renames or deletes, in Synology Calendar or on a phone, an event the app
made for a plan's due date or block, the app notices on its next look (Today
looks at most every ten minutes per household, by whoever opens it with a NAS
session) and puts a card in Today: "Bob moved Fix the gate to Sun 8 Nov on
their phone", with three choices: *Move the plan too*, *Put the calendar back*,
*Leave both*. Nothing on either side changes until someone chooses, and the app
never overwrites an event someone changed. Appointments are not drift-checked
yet, linked to a plan or not.

**A date set without a NAS session** (after a redeploy, before signing in
again) is kept on the plan and shown as *not on the calendar*; the next look by
anyone signed in to the NAS puts it there, or the card's *Put it on the
calendar* does it at once.

**Calendars on a phone and a Mac.** Synology Calendar is a CalDAV server, so a
member who adds their NAS account to Apple Calendar (Settings → Calendar →
Accounts → Add Account → Other → Add CalDAV Account) gets the Household
calendar there like any other: create, move, invite, alerts, Siri. An
administrator sets DSM's address on Connectors (Calendar on phones; the
`DSM_PUBLIC_URL` default) so Settings can say what server address to give. This works
away from home only if DSM itself is reachable from outside (the planner alone
on 443 is not enough); otherwise phones sync at home or over VPN. **Verify on
the NAS** which address Apple Calendar wants (the bare origin, found through
`/.well-known/caldav`, or the account URL Synology Calendar shows under its
CalDAV settings) and correct the words in Settings if it is the second.

**The time zone must be an IANA zone name**, such as `America/Denver`. Each
household's owner chooses it in Settings; until they do it is `TZ`, from the
deployment. It is the `tz_id` on every event the app makes, and it decides where
an all-day due-date marker falls: midnight to midnight in that zone. Left at the
`UTC` default, a household in the Americas gets markers on the wrong day:
Saturday's runs from UTC midnight, which is Friday afternoon where they are, so
it shows a day early. Choose it before the first date is set; events already
made keep the zone they were made with, and a zone chosen later does not make
the app's own events look changed.

### First real use: what to watch

The fake DSM answers these the way the app guesses DSM does; only the real NAS
can confirm them. Each is one place in the code if it is wrong.

| The guess | How it shows on the NAS | Where to change it |
|---|---|---|
| A stale etag is refused with **9006** (or any code but 9007, 9009, 9017) | A date changed in the app after the event moved on a phone raises a drift card. An error naming a code instead means that code is the etag refusal. | `NOT_AN_ETAG_REFUSAL` in `synology.ts` |
| An event that is not there is **9009** | An event deleted on a phone becomes a card "… was deleted from the calendar". An error with another code instead means DSM says "gone" differently. | `NO_SUCH_EVENT` in `calendar.ts` |
| **`last_modify_user`** names who changed an event | The drift card says "Bob moved …". "Someone moved …" means the field is named differently. | `calEvent` in `synology.ts` |
| **`SYNO.Cal.Event list`** returns events that *overlap* the window (the fake does), not only those *starting* in it | An event that began yesterday, or runs over several days, is missing from today's rail and the week. | Widen the window in `viewerEvents`' callers, or ask a day earlier |
| **`SYNO.Cal.Cal set`** renames a calendar, for its owner | Settings → rename the Household calendar works for its maker, and is refused in words for anyone else. | `renameCalendar` in `synology.ts` |
| The sid from **`session=Calendar`** is accepted by Calendar, Contacts and File Station | Contacts or Files answer "not allowed" (105) while the calendar works. | `checkWithDsm` in `auth.ts`; the check shows it |
| **Sharee ids**: a calendar shared with a member may be listed for them under a `cal_id` of their own, the `original_cal_id` staying the owner's | A member whose account does not list the Household calendar gets a 409, "that calendar is not shared with bob on the NAS" (naming that member), on a date change, and their look logs `event N is on a calendar bob's account does not list; not looked at` (and `could not put …'s dates on the calendar` for a date kept without a session) instead of asking about it. That is the guard working until the calendar's maker opens the app and shares it. The same message for a member who *can* see the calendar means the listing differs from this guess: compare both accounts' `Cal list` in the check. | `sameCalendar` in `types.ts`, `listingFor` in `calendar.ts` |
| **Whose a calendar is**: the owner tag on Today's and the week's events ("mine" or the partner's) is a guess from the prefix of the calendar's `original_cal_id` (`/bob/…`), falling back to `cal_id` | A calendar of a partner's that you check shows as yours, or one of yours as theirs; Settings says "Shared with you by …" of your own calendar, or of nobody's. Compare `Cal list` for both accounts: the `original_cal_id` of a shared calendar should begin with its owner's account name. | `ownedBy` in `calendar-view.ts`, `ownerOf` in `site/index.html` |
| **The address book**: `Addressbook list` rows carry `id` and `name`; a contact has `full_name`, `tel`, `email`, `org` | Contacts search finds nobody, or a card's person has no phone. | `listAddressbooks` and `contact()` in `synology.ts`; the check's README lists each field |

## Files on plans

A file attached to a plan is not kept in the container. It goes to the NAS,
uploaded through File Station with the member's own DSM session, into
`<the household's folder>/<plan>/`: the folder its owner chose for the
household's documents (see below), so a plan's files and its page sit together.
The log keeps only its path, name and size. Opening it comes back through the
app with the same session, so nobody who cannot open the card can fetch the
file. Each is at most 25 MB, either way.

**Until the owner has chosen a folder, files on cards are off.** The card says
"Files on cards are off until <owner> chooses where documents live, in
Settings." in place of the drop zone, and nothing else changes. There is no
default folder to fall back on: `PLANNER_ROOT` is not where files go.

Taking a file off a card leaves it on the NAS; delete it there if you want it
gone. A file is never written over: a second file with the same name on the same
card, or one still in its folder after being taken off, is refused, and needs
another name.

**The folder is inside a Team Folder, and a Team Folder is shared.** The app
serves a file only to a member of the household whose card it is on, but that
check is the app's own. Every account with Read/Write on the Team Folder can
open every household's folder in it directly, through File Station, Drive or an
SMB share, where the app's membership check does not reach. With one family on
the server that is the family; with more, it is everyone in all of them. Two
ways to close it:

- Give each household its own Team Folder, with Read/Write for that household's
  members only. The picker lists the Team Folders the owner can write, so each
  owner chooses theirs.
- Or, once a household's folder exists, give it its own permissions: in File
  Station, the folder > Properties > Permission, stop inheriting from the parent,
  and give Read/Write to that household's members only.

No two households share a folder, or nest one inside another: the picker refuses
a folder another household keeps, in words that name no one.

**A household restored as a copy has no folder yet.** Restoring as a new
household keeps its time zone and model and drops the folder choice, any move
and booking; the restore summary says so. The copy's cards still list their
files, but cannot open them while files are off, until its owner chooses a folder. The files are still on
the NAS, in the original's folder: copy them into the copy's folder in File
Station (same plan folders beneath) to bring them back. A restore into the same
household changes none of this.

A sign-in carried over a redeploy has no DSM session (see Environment), so it
can read the list of files and nothing more until the member signs in again.
The local bypass never has one.

## Documents in Synology Drive: choosing a folder in Settings

Briefings, answers and each plan's page are kept as documents (Markdown files)
in Synology Drive, with the member's DSM session, and so are the files attached
to plans. They live in a folder in a **Team Folder** that the household's owner
chooses in Settings. That needs Synology Drive **4.0.0 or later** on **DSM
7.2.2 nano3 or later**. File Station addresses the folder as
`/Planner/<folder>/…` (with `Planner` the Team Folder); Drive addresses the same
files as `/team-folders/Planner/<folder>/…`. Beneath the folder, briefings are
in `today/`, answers in `answers/`, and each plan has a folder of its own, named
by its id, with its `plan.md` and its files.

**Nothing goes to Drive, and no file onto a card, until the owner has chosen.**
Briefings and answers stay in the log, and cards say files are off. Until then a
card tells the owner (*Your documents are not in Drive yet*, with *Choose a
folder*) and the other members to ask them. Those are reminders on Today, never
decisions, and are not logged; they go once a folder is chosen.

Once, by people:

1. In Synology Drive Admin Console > Team Folder, enable a shared folder as a
   Team Folder (make the shared folder first, in Control Panel > Shared Folder,
   if you have none). The app calls no Drive admin endpoint: a person turns it
   on.
2. Members need Read/Write on it.
3. In Universal Search, index the Team Folder and include the contents of `.md`
   files. Without that, search finds documents by name only.
4. The owner opens Settings, where *Setup* starts with where documents live, and
   chooses, in three steps:
   - **A Team Folder.** The ones the owner can write are listed, and one they
     cannot is shown greyed. If `PLANNER_ROOT` names a share, that Team Folder
     is listed first and marked as the deployment's.
   - **A folder in it.** The folders already there are listed. A new name is
     suggested from the household's name (with `-2`, `-3` after a taken one).
     Slashes at either end and spaces around a name are tidied; `..`, `%`, a
     comma and a backslash are refused in words, before the NAS is asked.
   - **The checks.** These stop the choice: the share is not a Team Folder, the
     owner cannot write to it, or another household on this NAS keeps its
     documents there (or holds a folder this one sits in, or is inside). These
     only advise: which of the household's members the Team Folder's members
     list does not show able to write (or that the NAS would not give an
     ordinary account that list, which the page says as *not known*), and
     whether Universal Search reads the folder's pages by their words.

   *Use this folder* makes the folder in Drive, and each folder leading to it, if
   it is not there, asks the checks again, and records the choice in the
   household's log, as the owner's.
5. Run the check once (see *Checking the NAS's API shapes*, with `PLANNER_ROOT`
   set to a Team Folder you may write and `CHECK_DRIVE_WRITE=1`), read the Drive
   section against `api/tools/synology-check/README.md`, then delete
   `<PLANNER_ROOT>/.planner-check` in File Station.

**An install that already has files is carried over, once.** At the first boot
of this version, a household whose log names a file under
`<PLANNER_ROOT>/<household id>/` has that folder chosen for it by the system,
from the deployment: nothing moves, and Settings says *from the deployment*. The
Team Folder is `PLANNER_ROOT`'s first segment; the folder is the rest of it, then
the household's id. A household with no file there chooses for itself. A folder
another household already holds is not carried over, and the boot log says so
(`<id>: … is taken by another household, so its folder is not carried over`).
That is all `PLANNER_ROOT` does, besides being the picker's first suggestion.

**A carried-over share that is not a Team Folder** keeps files on cards working
(File Station writes them), and documents stay in the log. Today tells the
owner: *Your documents are not in Drive yet: Planner/the-house is not a Team
Folder. Enable it in Synology Drive Admin Console, Team Folder, or choose another
folder.* Members are told to ask the owner. Enabling it, or choosing another
folder, ends the notice.

**Changing the folder moves the documents, in the background.** The owner
chooses another folder the same way. The documents the app wrote (briefings,
answers, plan pages) and the files on cards move one at a time, each to its place
in the new folder, and every link in the log follows, so a briefing's document
opens from where it now is. Today shows *Moving 12 documents to Planner/the-farm*
while any are left, in front of every member, and names any that could not be
moved yet and when it tries again (ten minutes later); nothing waits unseen. One
move at a time: a second change is refused until the first has finished. A write
to a file still waiting moves that file first. Files taken off a card, and
anything the app did not write, stay behind in the old folder; nothing is
deleted. A move needs a member with a NAS session: it goes on after any change a
member makes and whenever Today loads, and after a restart the first request from
a member who has signed in again picks it up.

**The boot log says where each household stands.** One line each, with its id
first:

```
[budget]   the-house: folder Planner/the-house (from the deployment); zone America/Denver (from the deployment)
[budget]   the-cabin: none chosen; zone UTC (default)
[budget]   the-farm: folder Planner/farm (chosen); zone America/Denver (saved); 12 files left to move
```

Then `admin:` says which rule makes an administrator, and `Claude:` says where
the key comes from (`key saved on Connectors`, `key from the deployment`, or
`off`), never the key.

**A household restored where its documents are not has headlines and not the
words.** The log keeps each briefing's and answer's headline and the link to
its document; the document stays on the NAS it was written to, in the original's
folder. Restored on another NAS, or as a copy whose old files are gone, Today
and the cards show each headline with *the full text is on the old NAS*.
Restored on the same NAS with the old files still in place, the links still
reach them and the words still show. Either way the plan pages are written
again from the log, in the restored household's own folder once it has one, on
the first look at them. Restore scopes are unchanged: the conversation and the
plans carry these pointers like any other event.

### Edits made in Drive

Each plan has a page, `plan.md`, beside its files in
`<the household's folder>/<plan>/`. The app writes it again after every change to
the plan. Anyone may edit it in Drive, over SMB, or in Drive's own app, and the
app notices:

- **When.** Today looks at the household folder at most every ten minutes, and
  at every page at least once an hour. Restarting the server forgets the ten
  minutes, so the next load of Today looks at once.
- **What it asks.** A page that differs from what the app wrote gets a card on
  Today, in front of either member: *The page for Fix the gate was changed in
  Drive: due date Fri 20 Nov → Fri 27 Nov*. An editor's stray spaces, blank
  lines or reordered keys are no change, and nothing is asked about them. Drive
  does not say who edited the page, so the card names no one.
- **The three choices.** *Take the change* moves the plan to what the page
  says: its title, area, state, due date, estimate, notes and checklist. The
  change is logged as made by the member who chose it, *edited in Drive*. A due
  date or a title goes to the calendar as well, as a member's own edit does.
  Parent, people, envelope and files are the planner's own: the card says so,
  and taking the change leaves them as they were. *Put the page back* writes
  the page again from the plan. If Drive refuses the write, the card stays
  open. *Leave both* keeps the edited page as it is, and the app does not ask
  about it again until the next change to the plan rewrites it.
- **While a card waits**, the page is not written over. A page that can no
  longer be read as a plan can only be put back or left. A page deleted in
  Drive is written again, and nothing is asked. Every version the app writes
  over stays in the file's version history in Drive.

## Booking

Friends on the household's guest list can ask to come and stay, from a page at
`/book`; a member approves on Today. Guests have no account here: they get a
code and a link by email, so booking needs mail, and it needs to know its own
public address.

It is **on only when all of these hold**:

- the booking page's address is set (Connectors, Booking; `BOOK_URL` is the
  default) and is usable;
- mail is set (Connectors, Mail; `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS` and `SMTP_FROM` are the default) and is usable, and its last test,
  if there is one, did not fail;
- the household's **owner turns Booking on in Settings**, and the household has
  its Household calendar.

Settings tells the owner which is missing, or which is set to something that
cannot work (a booking address with a path or on `http://`, a port that is not
a number, a from address that is not an address), naming who can fix it:
`ADMIN_USER` if it is set, else the last administrator to save on Connectors, else
the NAS's administrator. The boot log says the same in the same words. A guest is told
nothing. While it is off, a request already waiting on Today can still be
declined (the guest is mailed the reason, if the mail settings are usable;
otherwise the decline is refused and says so), never approved.

- **One household books at a time.** A server hosts many households and a guest
  has no session, so booking belongs to one of them. Turning it on in a
  household while another books moves it, but only when nothing is ahead in the
  other (no request waiting and no stay still to come); `system` turns it off
  there, signing its guests out. Otherwise the owner is told, for example, "Cabin
  has 2 requests waiting and 1 stay ahead: booking stays with them until then." Turning it off is refused the same way while anything is ahead.
- **A lost calendar turns it off.** If the Household calendar's maker lists their
  calendars and it is not there, the app turns booking off, signs the guests out
  and tells the owner on Today and in Settings why. It cannot be turned on again
  until a calendar is chosen.
- `BOOK_URL` is the public origin, such as `https://book.example.com`. The
  links in sign-in emails are built from it, never from the request's `Host`,
  which anyone can forge. It must be **exactly the origin browsers show** for
  the page (scheme, host and any port, no path): every POST under `/book`
  (the Continue button, the code, every request) is refused with a 403 unless
  its `Origin` is that address, so a mismatch is a page that never signs anyone
  in. It must be `https://`; `http://` is accepted only with
  `COOKIE_INSECURE=1`, for trying it on the LAN.
- **`BOOK_HOUSEHOLD` is only a fallback**, for an install from before the owner's
  switch. It is the id of a household: its directory under `HOUSEHOLDS_DIR`, and
  the id that starts its line in the boot log. If no household has booking on,
  the one it names books, as long as its log has never said anything about
  booking (it was never switched on or off). That household is on with no owner
  having turned it on, **and it can book before its owner has chosen a
  calendar**, because the calendar is checked only when the owner turns it on in
  Settings. Once its owner switches booking on or off, the log decides and the
  fallback no longer applies to it. If it names a household this server does not
  have, booking stays off and the boot log says
  `BOOK_HOUSEHOLD=<id> is not a household here; booking is off`. With the page
  and mail set and no household booking, the boot log says
  `Booking is off here: no household has booking on.`
- The mail is where mail goes out. Synology has no API for sending mail, so the
  app speaks SMTP itself. MailPlus Server on the NAS or an external relay both
  work; which, and getting its sending right, is yours to choose.
- The password is only ever sent over TLS (STARTTLS on 587, or TLS from the
  start on 465), and a server that offers neither is refused. The plain-auth
  switch on Mail (`SMTP_PLAIN_AUTH=1`) lifts that, and is only for a relay on the
  NAS itself, where the password does not cross the network. A NAS relay with a
  self-signed certificate fails STARTTLS verification: give MailPlus the NAS's
  Let's Encrypt certificate, or use an external relay, rather than reaching for
  plain auth.

Expose **only `/book`** (and what is beneath it) to the internet, with TLS, at
the reverse proxy in front of `:8090`; how is the proxy's business. Every other
route still needs a member's session, so the app is safe if more is exposed by
mistake, but there is no reason to offer it. DSM's own reverse proxy cannot
narrow by path; see TLS for what that means.

The limits on the guest door are per client address: twenty sign-in emails an
hour from one address (five per guest), thirty codes typed an hour, and ten
wrong codes a day for one guest however many emails they ask for. An IPv6
client is counted by its /64. **Behind a proxy, set `TRUST_PROXY`**: without
it every friend arrives from the proxy's one address and shares one bucket, so
one busy evening locks everyone out. The proxy must send `X-Forwarded-For`
(DSM's reverse proxy does). If the two disagree (`TRUST_PROXY` set and no
header, or a header and no `TRUST_PROXY`), the log says so once, at the first
request under `/book`.

## The volume

`./api/data` holds `events.jsonl`, `households/`, `sessions.json` and
`connectors.json`. The app runs as the image's unprivileged `node` user, and
the container starts by giving `/data` to that user wherever it is owned by
anyone else, so a folder made in DSM's File Station, or one Docker creates on
first start, works without changing its owner by hand. Only files with the
wrong owner are touched, so a large log is not rewritten on every start.

Back up `api/data` and the Team Folders your households chose. `api/data` holds
the households' logs, which are append-only, and every other piece of state —
balances, history, categorisations, who has access, where documents live, and
the conversation on Today with every decision taken in it — is a pure replay of
them; it also holds `connectors.json`, which carries the mail password and the
keys, so keep that copy private. The Team Folders hold what the logs point to
(plans' files, and the whole text of briefings and answers kept in Synology
Drive), so restoring both restores everything. A restore can take the conversation, or leave it, on its
own. A corrupt final line after an unclean shutdown is
skipped and reported at boot rather than being fatal.

### A fresh install starts empty

Sign in and the app walks you through it: create a budget, say where it is,
open the month, record what comes in. Each step offers the next.

## On the NAS, behind https

`docker.yml` is the compose file for the Synology. It differs from
`docker-compose.yml` (the laptop file) in four ways: the image is built from
the repository on GitHub (`https://github.com/jammo-icloud/home-planner.git#main`,
with the repository root as the context, so the image carries `site/` as well
as `api/`), the port is bound to the NAS's loopback only, `COOKIE_INSECURE` is
not set, and the defaults are the household's time zone (`TZ=America/Denver`)
and `TRUST_PROXY=1`, and they are defaults like the rest: a value saved on
Connectors or in Settings wins over them. `BOOK_URL` is empty unless `.env`
sets it or an administrator saves it on Connectors. Every variable in
`docker.yml` has a default, so it needs no `.env`.

Nothing is cloned onto the NAS and nothing is typed into a shell: only the
compose file is there, and everything below is done in DSM. The repository is
public, so the build needs no credentials.

1. **Packages.** In Package Center, install Container Manager, Synology
   Calendar and Synology Drive. Then, in Synology Drive Admin Console, enable a
   shared folder as a Team Folder, with read/write for every member's account,
   for each household's owner to choose in Settings (see Documents in Synology
   Drive).
2. **The folder.** In File Station, create a folder for the project inside the
   `docker` shared folder, for example `docker/home-planner`. The household
   logs appear under it at `api/data` once the app has started; that folder is
   what to back up.
3. **The compose file.** Download `docker.yml` from the repository:
   `https://raw.githubusercontent.com/jammo-icloud/home-planner/main/docker.yml`.
   Either copy it into the folder with File Station as `docker-compose.yml`, or
   keep it on the computer to upload in the next step. Container Manager only
   recognises a file named `docker-compose.yml`; an uploaded file is saved under
   that name whatever it was called.
4. **The project.** Container Manager → Project → Create. On General Settings:
   Project name `home-planner`; Path: Set Path, and choose the folder from step
   2; Source: Upload docker-compose.yml, and Browse to `docker.yml` (or, if it
   was copied into the folder, use the `docker-compose.yml` already there).
   Next. Leave the web portal (Web Station) step unticked: DSM's reverse proxy
   does that job, in step 7. Next, then Done on the summary. Container Manager
   fetches the repository from GitHub, builds the image and starts the
   container on the NAS's loopback at port 8090, which nothing can reach yet.
5. **`.env` is optional.** Everything that used to need it is set in the app:
   an administrator on Connectors, each household's owner in Settings. If a
   variable is wanted anyway (see Environment), create a file named `.env`
   beside `docker-compose.yml` in File Station, then restart the project:
   Project → Action → Restart, or Stop and then Start.
6. **The certificate.** Control Panel → Security → Certificate → Add: a Let's
   Encrypt certificate for `planner.example.com` (port 80 must reach the NAS for
   the HTTP challenge, or use the DNS challenge). Then Settings, on the same
   page, to assign it to the reverse-proxy entry from step 7 once that exists.
7. **The reverse proxy.** Control Panel → Login Portal → Advanced → Reverse
   Proxy → Create: source `HTTPS`, hostname `planner.example.com`, port `443`;
   destination `HTTP`, `localhost`, port `8090`. Nothing under Custom Header:
   the app streams nothing.
8. **The router and the firewall.** Forward 443 (and 80, if the certificate
   uses the HTTP challenge) to the NAS. 8090 is not forwarded and not reachable
   from the LAN. If DSM's firewall is on (Control Panel → Security →
   Firewall), allow 443.
9. **The first sign-in.** Open `https://planner.example.com` and sign in with a
   DSM account. An administrator then opens Connectors, under the person icon,
   and each household's owner opens Settings. On first real use, run the check
   above (Checking the NAS's API shapes) once as each member, from a laptop
   checkout, and walk the table under Calendar on the NAS.

Booking exposes `/book` to friends at the same address; everything else
behind it still needs a member's session. As under *The volume*: back up
`api/data` and the Team Folders.

Upgrading is Container Manager → Project → Action → Build, which fetches the
current `main` and rebuilds the image; then Start, if the project did not
restart on its own. The log under `api/data` is the only state, so nothing is
lost.

**Confirm on first run.** Two things no documentation settles:

- Whether Docker on DSM can build from a git URL. If the project fails to build
  with a message about git, download the repository as a ZIP from GitHub
  (Code → Download ZIP), unpack it with File Station and move what is inside
  its top folder into the project folder, so `api/` and `site/` sit beside
  `docker-compose.yml`, and change `context:` in `docker-compose.yml` to `.`.
  An upgrade is then a fresh ZIP unpacked over it before Build.
- Whether Build alone recreates the running container with the new image, or
  needs Start (or Stop and then Start) afterwards.

## TLS

Only for TLS. DSM's reverse proxy (Control Panel → Login Portal → Advanced →
Reverse Proxy) terminates Let's Encrypt in front of `:8090` — it performs no
authentication and does not need to, because sign-in happens inside the app.
Getting a real certificate on is what makes the iPhone home-screen install work,
and it is when to drop `COOKIE_INSECURE`.

DSM's reverse proxy matches a host and a port, not a path. A rule that sends
`planner.example.com` to `:8090` for the booking page sends the **whole app** there:
the sign-in page and every route under `/api` are on the internet too. What
that means:

- every route but `/book`, the sign-in page and `/api/health` still needs a
  member's session, exactly as on the LAN;
- `POST /api/auth/login` checks the password against DSM, so it is limited per
  client address: ten wrong passwords a minute and a hundred an hour, then
  even the right one is answered 429 until the minute (or hour) is out. Set
  `TRUST_PROXY` (Booking) or every wrong password anywhere counts against the
  proxy's one address, and the household's own sign-ins with it;
- `/book` is the only route for people without an account;
- every member sign-in reaches DSM from the container's own address, so
  DSM's Auto Block (Control Panel → Security → Protection) sees all the
  internet's guesses as one client and, under sustained guessing, could block
  that address and lock every member out of sign-in. Either add the
  container's address to Auto Block's allow list, or rely on the app's limit
  and keep Auto Block's threshold above it (more than ten failures a minute).

If the household would rather the internet saw only `/book`, put a proxy that
can route by path in front instead (Caddy, nginx): send `/book` and `/book/*`
to `:8090` and nothing else.

`/api/health` is the one route before the auth check, so the container
healthcheck needs no credential and a broken proxy cannot disguise a broken
process.

---

## Where a budget is

A budget can carry a location, because a budget differs from another budget by
being somewhere else — that is why electricity and property tax are priced
separately while groceries are not. With a ZIP recorded, `look_up_local_costs`
reads public measured data for the place:

| Source | Key | Covers |
|---|---|---|
| Zillow Observed Rent Index | none | rent, by ZIP, monthly |
| US EIA retail sales | free key | average residential electricity bill, by state |
| US Census ACS 5-year | free key | rent and property tax, by county, ~2 years behind |

Both keys are free: `eia.gov/opendata/register.php` and
`api.census.gov/data/key_signup.html`. An administrator pastes them on
Connectors (Pricing sources). Without them only rent is available, and only
where Zillow covers the ZIP.

**Both parsers were checked against live replies on 2026-10-28.** EIA's shape and
units (revenue in millions of dollars, customers as a count) matched for two
states. Census matched for real counties, and two of its ordinary answers are not
JSON — a county with no figures is a 204 with an empty body, a refused key is a
200 carrying an HTML "Invalid Key" page — so both are named instead of surfacing
as a parse error. Both still refuse anything they do not recognise, so a shape
change reads as an error rather than a wrong figure.

Every figure comes back with its source, the area it was measured over, when,
and what it cannot tell you. They are measurements of a place, never predictions
about this household. Small ZIPs are simply absent from the rent index, and the
lookup says so rather than returning nothing and letting it read as zero.

**Price it from local data** turns those figures into a proposal: it creates the
category and envelope where they do not exist, shows the old number beside the
new one where they do, and carries each source and caveat onto the approval
screen. It covers only what is measured — one or two envelopes out of forty —
and says so, so it never reads as having filled in a budget. With no data for
the place it refuses rather than inventing a figure.

## What is not ready

**All four screens are built** — Today, Budget, Import and Compare. Activity is
part of Today's thread now. The old
standalone planner is preserved at `/planner.html`, but it reads `budget.jsonl`
off disk, which the API no longer serves, so it is a historical artefact.

**Drive's webhook is not used yet.** Edits made in Drive are found by looking
when Today loads (see *Edits made in Drive*), not pushed by the NAS. The webhook
waits until its payload has been observed on a real NAS.
