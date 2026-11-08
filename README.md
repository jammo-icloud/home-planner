# Home Planner

Home Planner is a self-hosted household planner that runs in a container on a
Synology NAS. It holds one household or several. Each household has an owner
and the members they invite, and everyone signs in with their own DSM account.
It keeps a zero-based budget in envelopes, a board of plans whose documents and
files live in Synology Drive, a shared calendar in Synology Calendar, a booking
page where guests can ask to stay, and an assistant (Claude) that writes each
day's briefing, answers questions and suggests changes for a person to approve.

## The log is the truth

Every change is an event appended to the household's log, a file that is never
rewritten: a receipt imported, money moved between envelopes, a month opened, a
plan's due date, a question asked, a suggestion approved, a member added. The
balances, the history, the categories, who has access and where documents live
are all a pure replay of that file, so the in-memory state can be thrown away and
rebuilt at any time. Every event is attributed to the member who made it, and a
backup of a household is its log.

## What it does

### Today

Each day opens with one briefing, drawn from the budget, the plans and the
calendar. Under it is the thread: questions for Claude, notes between members,
every change made on another screen, and cards that wait for a person to decide
(Claude's suggestions, a calendar event moved on a phone, a plan's page edited
in Drive, a guest's booking request). Today also carries setup notices, such as
an owner's *choose a folder* or an administrator's *Set up the NAS*. They are
reminders, never decisions, and go once the thing is set.

### Budget

- **Zero-based envelopes.** The month balances to nothing left to assign. The
  budget decides how envelopes are set; the envelope screen shows what is in
  them, so the receipts in an envelope add up to the number on it.
- **A plan of record.** Opening a month snapshots the plan. Later moves are
  their own events, each with a reason, so what was decided and what was done
  about it stay separate.
- **Receipts in.** Import OFX, QFX or CSV in the browser. Transactions are keyed
  on the bank's own id where there is one, so re-importing an overlapping range
  is exact. A receipt can be split across envelopes in whole cents.
- **Matched with Claude's help.** Rules sort first. For what they leave, Claude
  suggests an envelope from the payee names and envelope names only, never
  amounts, dates or accounts. A suggestion stays a suggestion until a person
  accepts it, and accepting one offers to remember it as a rule.
- **Several budgets, compared.** A budget can carry a place, and Compare sets
  budgets side by side.

### Pricing from public data

With a ZIP recorded, a budget can be priced from measured public figures: rent
from the Zillow Observed Rent Index, rent and property tax by county from the US
Census ACS, and the average electricity bill by state from the US EIA. Every
figure carries its source, the area and period it was measured over, and what it
cannot say. The proposal covers only what is measured and refuses rather than
inventing a figure. Zillow needs no key; Census and EIA keys are free.

### Plans and documents

Plan is the household's board: areas of life as rows, Planning and Doing as
columns, with Done kept as an archive. A card holds notes, a checklist, the
people involved, an envelope and an estimate, a due date and files.
Briefings, Claude's answers and each plan's page are kept as Markdown documents
in Synology Drive, in a folder inside a Team Folder that the household's owner
chooses in Settings. Files attached to a card go beside its page. Nothing is
written to Drive until the owner has chosen. A plan's page can be edited in
Drive, and the app asks on Today whether to take the change. Changing the folder
later moves the documents in the background, and every link in the log follows.

### Calendar

Plans' due dates, blocks of time and appointments live in Synology Calendar,
read and written with each member's own DSM session. The household's owner
makes the Household calendar, shared with every member. Synology Calendar is a
CalDAV server, so members can add it to their phones and computers and see the
same events there. The profile that sets up an iPhone is signed with the NAS's
certificate when a copy of it is on the volume. A change made on a phone to an event the app made arrives on
Today as a card with three choices, and the app never overwrites an event
someone else changed.

### Booking

Friends on the household's guest list can ask to come and stay from a public
page at `/book`, and a member approves or declines on Today. Guests have no
account: they get a code and a link by email. Booking is off until the booking
address and outgoing mail are set and the owner switches it on in Settings,
which needs the Household calendar to be chosen first. One household on a server
books at a time.

### Households and sign-in

Sign-in is delegated to DSM, so there is no second password, and disabling a
DSM account disables it here too. Any DSM account may sign in and gets an empty
household of its own, unless an administrator narrows who may sign in.
Isolation is per household: the app shows a household's money, plans and
documents only to its members. A Team Folder is shared on the NAS itself, so
DEPLOY.md says how to give each household folder its own permissions. A DSM
administrator can see that households exist (owner, size, last activity) and
never what is in them.

The owner of a household can remove it under Settings › Household. That deletes
the household's log for everyone in it, and everyone who had it open lands back
on Choose a household. A backup is the only way back, so download one first if
there is any doubt. It is also how to start again from the first sign-in.

## How it is configured

Almost nothing has to live in `.env`. Configuration is done in the app, by two
kinds of people, in two places.

Settings is a list, one line per setting with what it is set to. Each setting
opens as a page of its own, with its form at the top, and Back returns to the
list where you left it. A reminder on Today opens the page it is about.

**The household's owner, in Settings.** A *Setup* checklist asks, in order:
where documents live (the Drive folder), the household's time zone, the
Household calendar, whether the household takes bookings, and the model that
suggests envelopes. Each choice is an event in the household's log, with the
owner's name and the date on it.

**A DSM administrator, under Settings › This NAS.** Any account in DSM's administrators
group sees a This NAS group in Settings. It holds what belongs to
the whole NAS: the Claude API key, the address where phones reach the NAS, outgoing mail, the booking page's address, who may sign in, and the
Census and EIA keys. Each row says whether it is on, off or broken and where its
value comes from. These are kept in `connectors.json` in the data folder, never in a
household's log, and no secret is ever sent back to the browser.

Every one of those can be set, changed or reset while the app runs. A saved
value counts from the next request, with no rebuild and no restart. A value in
`.env` is only the default until something is saved, and clearing a row puts
the `.env` value back. The few variables that describe the container itself,
such as the DSM port and how many proxies are in front, stay in `.env`.

Without a Claude key the app still runs: the briefing is a plain summary of
the same figures, and receipts are sorted by rule and by hand.

Members set up an iPhone from Set up your iPhone: a QR code that puts Home
Planner on the Home Screen, and a calendar account for the Household calendar.

Settings ends your own section with the version running, the commit it was
built from and when, so you can see which build is live.

[DEPLOY.md](DEPLOY.md) has the details: every variable and This NAS row, the
Drive, Calendar, booking and TLS setup, and what each failure in the log means.

## Running it

### On the NAS

Everything is done in DSM; no `.env` or shell is needed. Install Container
Manager, Git Server, Synology Calendar and Synology Drive from Package Center, and make a
folder for the project in File Station, such as `docker/home-planner`, with
a `data` folder inside it for the household logs. Then
Container Manager → Project → Create on that folder, uploading
[`docker.yml`](docker.yml) as the compose file: it builds the image from this
repository on GitHub and runs it on the NAS's loopback at port 8090. DSM's
reverse proxy serves it over https on 443, at an address such as
`https://planner.example.com`. Sign in with a DSM account, then an
administrator opens Settings, under This NAS, and each owner opens Settings.
[DEPLOY.md](DEPLOY.md#on-the-nas-behind-https) has every click, from the
certificate and the router to upgrading. Its section on
[signing the calendar profile](DEPLOY.md#signing-the-calendar-profile) says how
to put the certificate where the app can use it.

### On a laptop

`docker-compose.yml` runs the same app over plain HTTP, against a stand-in for
DSM. In `.env`, set `DSM_PORT=5555` and a few test accounts in
`FAKE_DSM_ACCOUNTS` (see `api/tools/fake-dsm/README.md`). Start the fake DSM in
one shell and the app in another:

```bash
cd api && npm install && npm run fake-dsm
docker compose up -d --build budget-api      # from the repository root
```

Open `http://localhost:8090` and sign in as one of the test accounts.

## Development

The API is TypeScript on Node 22.6 or later, with no build step: Node strips the
types at load, so what runs is the source you edited.

```bash
cd api
npm install
npm test
npm run typecheck
```

**The fake DSM** (`api/tools/fake-dsm`) answers sign-in, Calendar, Contacts,
File Station and Drive the way the app expects the NAS to. The tests run it
in-process. It shows that the app and the fake agree, not that DSM does.

**The NAS check** (`api/tools/synology-check`) is for that. Synology documents
its Calendar API in a guide and Drive in a spec, Contacts not at all, and parts
of File Station only by example, so several of the app's DSM calls were written
from the documents or by guess and are provisional until checked. Run the
check once against the real NAS before first use, from a checkout on any
machine that reaches it:

```bash
cd api
read -rs CHECK_PASS && export CHECK_PASS
CHECK_USER=<a-dsm-account> DSM_URL=http://<nas-address>:5000 npm run synology:check
```

It only reads (unless you ask for its one write) and prints the NAS's raw reply
beside what the app makes of it. Its README lists every guess and where to fix
it.

## Data is not code

This repository holds no household's data. The logs, `sessions.json` and
`connectors.json` live in the data folder (`data` beside the compose file on the
NAS, `api/data` on a laptop), which is gitignored along with `.env` and
any bank exports, so a fresh clone starts empty. Back up that folder and the Team
Folders your households chose: the logs hold everything the households decided,
and the Team Folders hold the documents and files the logs point to. `connectors.json`
holds the mail password and the keys, so keep that backup as private as `.env`.

## Status and caveats

- It was built for one household's NAS and has not been tried on others.
- Several DSM calls are provisional until the NAS check has been run against
  your NAS and its results read against the check's README.
- No warranty of any kind. Not financial advice: it is a planning tool for
  talking things through, and its pricing figures measure a place, not a
  household.

MIT licensed; see [LICENSE](LICENSE).
