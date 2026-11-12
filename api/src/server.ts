/**
 * The HTTP surface. One endpoint shape for everything:
 *
 *   GET  /api/tools                 the tool definitions, as Claude receives them
 *   POST /api/tools/:name           run a tool — reads return data, writes return a proposal
 *   POST /api/commit                approve a proposal; the only path that writes
 *   GET  /api/thread                the household's days, a month at a time (?through=, ?day=): each day's entries
 *                                   (briefing, conversation, cards, direct changes), counts, and what waits on you;
 *                                   notStarted while the budget has no location and no envelope
 *   GET  /api/docs/:event           the whole text of a briefing or an answer kept in Drive, read with your session
 *                                   (404 if the event is not one; 409 without a session; 404 if Drive has lost it)
 *   GET  /api/today                 yours, under the briefing: your calendars today and tomorrow,
 *                                   your plans due this week or in Doing, and this month's money
 *   POST /api/thread/ask            ask Claude in the thread; it calls the same tools
 *   POST /api/thread/note           leave the household a note
 *   POST /api/thread/decide         approve, decline or put off a card; { args: { choice } } for a drift's choice
 *   POST /api/thread/refresh        work a card out again from today's numbers
 *   POST /api/thread/adjust         your own version of a card
 *   POST /api/thread/seen           you have looked at a flagged change
 *   POST /api/briefing/read         advance the caller's read cursor
 *   GET  /api/plans                 the board whole: a row per area (?who=<member>|everyone&goal=<label>)
 *   POST /api/plans                 make a plan { title, area, owner?, goal? }; a member's plan edits are written, not proposed
 *   POST /api/goals/rename          { from, to }: every plan carrying the goal takes the new name; { plans }
 *   POST /api/goals/remove          { goal }: it comes off every plan carrying it; { plans }
 *   GET  /api/plans/:id             one plan's card
 *   POST /api/plans/:id             change its title, area, chips, notes, estimate or envelope
 *   DELETE /api/plans/:id           remove it, with a reason
 *   POST /api/plans/:id/state       planning, doing or done
 *   POST /api/plans/:id/ask         ask Claude about it, from its card { question }
 *   POST /api/plans/:id/hand        hand it to a member at once { to, why? }
 *   POST /api/plans/:id/goal        its one goal { goal }, or null for none
 *   POST /api/plans/:id/answer      the member asked takes it, or declines with a reason
 *   POST /api/plans/:id/checklist   the whole checklist
 *   POST /api/plans/:id/due         a due date, or null; on the calendar as an all-day event
 *   POST /api/plans/:id/block       set time aside, as a timed event;  DELETE …/block/:block lets it go
 *                                   (without a DSM session a new one is kept with `calendar: 'sign in again'`)
 *   POST /api/plans/:id/calendar    put its dates that have no event on the calendar now (needs the NAS)
 *   POST /api/plans/:id/contact     put a contact on it;  DELETE …/contact/:contact_id
 *   POST /api/plans/:id/note        a note between the members, on its card
 *   POST /api/plans/:id/attach      one file, as multipart/form-data, onto the NAS and the card
 *   GET  /api/plans/:id/files/:name that file, read from the NAS with your session
 *   DELETE /api/plans/:id/files/:name take it off the card, with a reason (it stays on the NAS)
 *   GET  /api/search?q=&lane=&who=  the record by words in it: day cards of the entries that match (Drive's briefings and
 *                                   answers with your session), and plans and files elsewhere; { who, days, entries, capped,
 *                                   elsewhere, documents: 'searched' | 'not searched' }; 400 under two letters
 *   GET  /api/contacts?q=           the household's address book on the NAS, filtered by name
 *   GET  /api/contacts/:id          one person in it, for their phone number on a card
 *   POST /api/contacts              propose adding someone to it (a card; the NAS is asked once it is approved)
 *   POST /api/match                 envelope suggestions for receipts To sort holds
 *   POST /api/auth/login            username + password, checked against DSM (ten wrong a minute, a hundred an hour,
 *                                   per client address: 429 past that)
 *   POST /api/auth/logout           drop the session
 *   GET  /api/auth/check            am I signed in, and to whose household
 *   POST /api/members               owner shares the budget with someone
 *   GET  /api/budget                the budget at a glance: this month, the last income, where it is, how many envelopes, the open months, whether it is started
 *   GET  /api/budget/first-run      where the budget's walkthrough is: the step still to take
 *   GET  /api/households            the households you are in
 *   POST /api/households            make one, and open it
 *   POST /api/households/select     open a different one
 *   POST /api/households/remove     { household, label }: the owner deletes it for good, its log and all, once its name
 *                                   is typed back exactly (400 otherwise); every session that had it open has none
 *                                   open after. 403 to a member who is not the owner, and to anyone else as select
 *                                   answers; 409 from the local sandbox
 *   GET  /api/backup                the open household's log, as a file
 *   POST /api/restore/preview       what a backup would bring, and what would collide
 *   POST /api/restore               take it, refusing on any collision
 *   GET  /api/admin/households      that households exist, and which folder each keeps documents in — never their contents
 *   GET  /api/connectors            what the NAS connects to: seven rows, each on, off or broken, with its source, one line
 *                                   and its form; secrets only as set or not set. This and the ten below: admin only (403)
 *   GET  /api/connectors/accounts   { accounts: [{ name, member }] }: the DSM accounts the admin's session lists
 *                                   (409 without a session: type the names instead)
 *   POST /api/connectors/public-url the saves: each takes exactly one of { value }, { off: true } or { clear: true }
 *   POST /api/connectors/sign-in      and answers with the page. public-url and book-url take an origin (book-url https,
 *   POST /api/connectors/book-url     or http with COOKIE_INSECURE=1); sign-in a list of names, trimmed and lowercased,
 *   POST /api/connectors/mail         never off, never leaving out the admin saving it; mail { host, port, user, pass?,
 *   POST /api/connectors/census       from, plainAuth }, no pass keeping the saved one; census, eia and claude a key,
 *   POST /api/connectors/eia          trimmed
 *   POST /api/connectors/claude
 *   POST /api/connectors/mail/test  { to }: a test mail, its result kept for the Mail row
 *   POST /api/connectors/claude/test one minimal request with the key as it stands; the result kept, never the key
 *   GET  /api/settings              the household's settings, your own appearance, whether documents go to Drive, and the software version
 *   POST /api/settings/areas        replace the household's areas
 *   POST /api/settings/areas/rename rename one area, and move its plans with it
 *   POST /api/settings/areas/add    add one area at the end
 *   POST /api/settings/areas/remove drop one area (refused while plans sit in it)
 *   POST /api/settings/areas/move   move one area to a place in the list
 *   POST /api/settings/links        replace the household's links
 *   POST /api/settings/appearance   how the app looks to you
 *   POST /api/settings/zone         { zone }: the time zone the household's days are read in; the owner's, and a name ICU knows
 *   POST /api/settings/model        { model }: the model that suggests envelopes, from the list Settings offers (null for the deployment's, else the default); the owner's
 *   POST /api/settings/booking      { on }: booking, for one household at a time; the owner's. 409 when it cannot be on here yet
 *                                   (saying who can fix that), or while requests wait or stays are ahead, here or where it is now
 *   GET  /api/drive/team-folders    the Team Folders in Synology Drive, with what you may do in each (the picker's first step)
 *   GET  /api/drive/folders?team=   the folders in one, and a name suggested for the household's (the second)
 *   POST /api/drive/folder-check    { team, folder }: what is wrong with using it, and what is only advice; makes nothing (the third)
 *   POST /api/settings/documents    { team, folder }: "Use this folder": makes it and logs the choice; the owner's;
 *                                   409 while the last change's files still wait to move, before the NAS is asked
 *   POST /api/settings/savings      { account }: the account the sinking funds live in, from those imports have seen (null for none)
 *   POST /api/settings/savings/balance  { cents, asOf? }: what Savings shows, typed (today unless a day gone by is given)
 *   GET  /api/calendars             your calendars on the NAS, and which the household uses; the Household calendar missing from its
 *                                   maker's list is gone, and booking, if it is here, goes off
 *   POST /api/calendars/household   make (or re-share) the Household calendar; { replace: true } makes a new one for one that is gone; the owner's
 *   POST /api/calendars/household/name  rename the Household calendar, on the NAS and in the log
 *   POST /api/calendars/target      the calendar plans go on; the owner's
 *   POST /api/calendars/conflicts   your calendars that plans are checked against
 *   GET  /api/calendar?start&end  the Calendar screen: 1 to 42 days of events, plans' dates, held nights, the record's numbers and the budget's money
 *   POST /api/calendar/check        look for plans' events changed on the calendar now (Today looks every ten minutes)
 *   POST /api/calendar/conflicts    { start, end, allDay, on, except? }: what clashes with the New event form's times on the
 *                                   calendars it is checked against, and up to three free times; only looks
 *   POST /api/calendar/events       the New event form's Save: { summary, start, end, allDay, on, plan?, notes? } made on the
 *                                   NAS and logged as the member's own appointment (no proposal); { appointment }
 *   POST /api/calendar/events/:id   Save on one the app made: { summary, start, end, allDay, notes }
 *   DELETE /api/calendar/events/:id Delete on one the app made, on the NAS and in the log
 *   POST /api/bookings/suggest      { offer, arrive, depart, why }: decline a guest's request and put other dates
 *                                   to them, by email; 404 in any household but the one friends book with
 *   GET  /api/bookings/nights?month=  YYYY-MM: each night open or taken, and for a taken one its kind (a stay,
 *                                   a request waiting, a block with its reason, or past) and whose; 404 in any
 *                                   household but the one friends book with
 *   POST /api/bookings/block        { from, to, why }: keep nights for the household, from the first night to the
 *                                   morning after the last (at most 90); refused over a confirmed stay, naming it
 *   DELETE /api/bookings/block/:id  { why }: let them go
 *   GET  /api/guests                { guests }: who may ask to stay, by name, address and how you know them
 *   POST /api/guests                { email, name, why }: put someone on the list; answers with the settings
 *   DELETE /api/guests/:email       { why }: take them off it, and end their sessions; their stays stand
 *   POST /api/guests/arrival        { text }: how a guest gets in, sent in each confirmation ('' for none; at most 1000)
 *                                   (these three and the two above: 404 in any household but the one friends book with)
 *   POST /api/phone-setup/code      { origin }: a one-time link for a phone to set up its calendar, ten minutes,
 *                                   one per member; { code, url, expiresAt, qr } with the QR as SVG. origin is the page's
 *                                   own, https (or http on this computer); 400 while the NAS's address is not set
 *   GET  /api/phone-setup/profile   the same calendar profile for the signed-in member, as a file, for a Mac
 *   GET  /api/phone-setup/home?origin=  { url, qr }: the page's address with ?add=home, as a QR for the Home Screen;
 *                                   touches no code; 400 for an origin that cannot be put on a Home Screen
 *   GET  /api/whoami                who you are, and whose household this is
 *   GET  /api/health                for the container healthcheck, with the version and commit running
 *
 * And the guest door, the one surface a guest session reaches. Its cookie is
 * read by these routes and no others; everything above still wants a member.
 * Every POST here must carry `Origin` equal to BOOK_URL (403 otherwise) and,
 * but for the Continue button's form, be JSON (415 otherwise), at most 8 KB.
 *
 *   GET  /book                      the booking page (served whether or not booking is on)
 *   GET  /book/tokens.css           the shared tokens, under the one path the proxy exposes
 *   GET  /book/favicon.ico, /book/icon.svg, /book/icon-180.png   the page's icons, under the same path
 *   POST /book/start                { email }: one sentence back, always; a code and link by email if it is on the list
 *   GET  /book/open?token=          the emailed link: a page with one Continue button, and no side effects,
 *                                   so a mail scanner that fetches the link spends nothing
 *   POST /book/open                 { token } (the button's form): same-origin only; a guest session, and back to /book
 *   POST /book/code                 { email, code }: the same, by the code instead (30 an hour per client address,
 *                                   429 past that; ten wrong in a day for one address and its codes are refused)
 *   POST /book/signout              drop the guest session
 *   GET  /book/me                   { email, household, tz, arrival } (its name, its time zone, whether the confirmation
 *                                   brings how to get in) for a guest session; 404 "not available" while booking is off
 *   GET  /book/nights?month=        YYYY-MM: { month, nights: [{ night, status }] }, status open, taken, mine-pending
 *                                   or mine-approved; a guest session only, and no reason for a taken night
 *   POST /book/request              { arrive, depart, headcount, note }: { id } of the card it raises on Today;
 *                                   409 naming the clash ("you already have …", "… is taken")
 *   GET  /book/mine                 { requests }: the guest's own requests and stays, each pending, approved,
 *                                   declined (with why), suggested (with why and the dates) or cancelled
 *   POST /book/cancel               { id }: withdraw a request or cancel a stay of theirs, for the app's own reason (a confirmed
 *                                   stay's event waits on a member's card to come off the calendar)
 *   POST /book/change               { id, arrive, depart, headcount, note }: { id } of the new request; the old
 *                                   one is cancelled, and the new nights are checked first ("taken": nothing changes)
 *   POST /book/accept-suggestion    { id } of a suggestion made to them: { id } of a fresh request for those dates;
 *                                   409 once already taken up
 *
 * And a phone's one-time link, which needs no session because the phone has
 * none: the code in the path is the credential.
 *
 *   GET  /setup/:code               the configuration profile the code was made for, once; HEAD answers the same headers
 *                                   and leaves the code alone. Anything else, or a code unknown, spent or ten minutes old,
 *                                   is one 404 page that names nothing
 *
 * Sign-in is the NAS's job, but it happens here rather than in front: the login
 * route asks DSM whether the credentials are real and then issues this app's own
 * session cookie. Nothing upstream is trusted, so this can be published to the
 * LAN directly, the way the comic reader on the same NAS is.
 *
 * A log is a household. The first permitted person to sign in claims it, and
 * only the people they add can see it — which is what makes the state genuinely
 * shared between two people rather than two private copies that drift.
 */

import { createServer } from 'node:http';
import { isIPv6 } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat, mkdir, copyFile, readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';

import { Store } from './store.ts';
import type { NewEvent } from './store.ts';
import { Households, adoptSingleLog, isValidId, retireShelves } from './households.ts';
import { isAdministrator, listAccounts } from './accounts.ts';
import { connectors, lastSavedBy, loadConnectors, recordTest, resolvedEnv, saveConnector, sourceOf } from './connectors.ts';
import type { Change, MailValue, SavedKey } from './connectors.ts';
import { connectorsView, needsAdmin, ROW_NAME } from './connectors-view.ts';
import { teamFolders } from './drive.ts';
import { eventsToApply, parseBackup, planRestore, SCOPES, unreadableBackup } from './restore.ts';
import type { Scope } from './restore.ts';
import {
  AuthError, GuestSessions, OtpRequired, Sessions, checkWithDsm, clearedCookie, clearedGuestCookie, guestCookie,
  localBypassUser, readCookie, sessionCookie, AUTH_VERSION, COOKIE, GUEST_COOKIE,
} from './auth.ts';
import { APPROVE_IN_ONE, CARD_ONLY, ToolError, touches, commit, refusedInOne, runTool, toolByName, toolSchemas, ProposalStore } from './tools.ts';
import type { Proposal, ToolContext } from './tools.ts';
import { firstRun } from './first-run.ts';
import { openMonths } from './envelopes.ts';
import {
  areaIndex, ARRIVAL_MAX, DEFAULT_AREAS, GUEST_PREFIX, householdDay, isDay, isEmail, MODES, SCHEMES, SPLIT, SYSTEM, isSpend, monthOf, movesLeft, sameCalendar, zoneOf,
} from './types.ts';
import type { Actor, Day, Event, Mode, NewEventShape, Scheme, SortedInto, SplitPart, State, Txn } from './types.ts';
import { parse, dedupeKey } from './parse.ts';
import { thread, threadDay } from './thread.ts';
import { isLane } from './lanes.ts';
import type { Lane } from './lanes.ts';
import { decide, refresh, adjust, raiseSavingsCard } from './offers.ts';
import { note, askInThread } from './conversation.ts';
import { board, card } from './plans.ts';
import { PAGE_RETRY_MS, schedulePages } from './pages.ts';
import { moveFailures } from './moves.ts';
import { searchRecord, searchWords } from './search.ts';
import type { BoardCard } from './plans.ts';
import {
  addBlock, answerAsk, createPlan, handPlan, linkContact, putOnCalendar, removeBlock, removePlan, removeGoal, renameGoal, setChecklist,
  setDue, setGoal, setState, unlinkContact, updatePlan,
} from './plan-edits.ts';
import { attach, ATTACH_MAX_BYTES, detach, filesOff, PLANNER_ROOT, readAttachment } from './attachments.ts';
import type { FileContext } from './attachments.ts';
import { answerTextFrom, briefingBodyFrom, currentDoc, documentsStatus, readDoc, teamFolderKnown } from './docs.ts';
import { carryOver, checkFolder, chooseFolder, cleanFolder, drivePathOf, folderOf, nasPathOf, pickerFolders, pickerTeams, rememberDocuments, stillMoving } from './folders.ts';
import { budgetNotices, folderSource, setupNotices, setupSteps, zoneSource } from './setup.ts';
import { matchModel, modelChoices, modelSource, pickerOptions, suggestForRows } from './match.ts';
import { cents, fmt, fmtExact } from './money.ts';
import type { Cents } from './money.ts';
import { inToSort, lowEnvelopes, snapshot, toSort } from './analytics.ts';
import { byRule, splitProblem, ReplayError } from './replay.ts';
import { ensureHousehold, ensureSection, markRead } from './briefing.ts';
import { ClaudeRefused, claudeConfigured, claudeKey, testClaude } from './claude.ts';
import {
  NeedsDsm, NotAllowed, SessionLost, SynologyError, dsm, getContact, listCalendars, renameCalendar, requireSid, searchContacts, sharingOf,
} from './synology.ts';
import type { CalendarInfo, UserShare } from './synology.ts';
import { currentPublicUrl, ensureHouseholdCalendar, oneAtATime, replaceHouseholdCalendar, reshareHousehold } from './settings.ts';
import { changeEvent, formConflicts, removeEvent, saveNewEvent } from './appointment-edits.ts';
import { checkDrift, checkDriftNowAndThen, checkPagesNowAndThen } from './drift.ts';
import { todayEvents, weekEvents, weekWindow } from './calendar-view.ts';
import { addDays } from './calendar.ts';
import { calendarMoney } from './calendar-money.ts';
import {
  acceptSuggestion, aheadOf, aheadWords, allowGuest, availability, blockNights, bookingAvailability, bookUrl, bookingHousehold, bookingNeeds, bookingOffWords, bookingStatus,
  cancelStay, changeStay, finishSignIn, guestList, memberNights, NO_BOOKING_HOUSEHOLD,
  GUEST_CANCEL_WHY, mailWhileOff, mine, raiseReleaseCards, request, revokeGuest, SIGN_IN_MESSAGE, signInFloor, startSignIn, suggest, unblockNights,
} from './booking.ts';
import type { BookingMail, BookingStatus, Viewer } from './booking.ts';
import { sendMail } from './mail.ts';
import { Limiter } from './limiter.ts';
import { softwareVersion, STALE } from './version.ts';
import { buildProfile, caldavPath, PROFILE_CONTENT_TYPE, PROFILE_FILENAME } from './profile.ts';
import { loadSigner, signedOrPlain } from './sign.ts';
import type { SigningStatus } from './sign.ts';
import { acceptedOrigin, createPhoneCodes, homeLink, homeOrigin } from './phone-setup.ts';
import type { PhoneCodes } from './phone-setup.ts';
import QRCode from 'qrcode';

const PORT = Number(process.env['PORT'] ?? 8090);
/** Where every household's log lives, one directory each. */
const HOUSEHOLDS_DIR = process.env['HOUSEHOLDS_DIR'] ?? 'data/households';
/**
 * The single log this used to be. Adopted as a household on first boot if it is
 * there and nothing else is, so an existing install is not stranded by the move
 * from one household per server to many.
 */
const LOG_PATH = process.env['LOG_PATH'] ?? 'data/events.jsonl';
/**
 * An optional override of who administers the server. Unset, an account in
 * DSM's administrators group is the admin (`adminAtSignIn`). An admin sees that
 * households exist — owner, size, last activity — and never what is in them.
 */
const ADMIN_USER = (process.env['ADMIN_USER'] ?? '').trim().toLowerCase();

/**
 * ADMIN_USER when set, else DSM's administrators group, asked once with the
 * fresh sid. The bypass is never an admin unless ADMIN_USER names it.
 */
/** The thread's query, checked: every word is refused whole when it is not one the route knows. */
function threadQuery(url: URL, state: State): {
  base: { lane?: Lane; person?: Actor | 'everyone' }; day?: Day; at?: string; through?: string; open?: Day[];
} {
  const get = (k: string): string | null => url.searchParams.get(k) || null;
  const lane = get('lane');
  if (lane !== null && !isLane(lane)) throw new ToolError('lane must be budget, calendar, plans, claude or notes');
  const who = get('who');
  if (who !== null && who !== 'everyone' && !state.members.has(who)) {
    throw new ToolError('who must be a member of this household, or everyone');
  }
  const day = get('day');
  if (day !== null && !isDay(day)) throw new ToolError('day must be a date, such as 2026-11-10');
  const through = get('through');
  if (through !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(through)) throw new ToolError('through must be a month, such as 2026-10');
  const open = get('open');
  const parts = open === null ? undefined : open.split(',');
  if (parts && !parts.every(isDay)) throw new ToolError('open must be dates, such as 2026-11-10,2026-11-09');
  const at = get('at');
  return {
    base: { ...(lane !== null ? { lane } : {}), ...(who !== null ? { person: who } : {}) },
    ...(day !== null ? { day } : {}), ...(at !== null ? { at } : {}),
    ...(through !== null ? { through } : {}), ...(parts ? { open: parts as Day[] } : {}),
  };
}

async function adminAtSignIn(username: string, sid: string | null): Promise<boolean> {
  if (ADMIN_USER !== '') return username === ADMIN_USER;
  return sid !== null && await isAdministrator(sid, username);
}
/**
 * Which DSM accounts may sign in at all. This is the outer bound; membership
 * in the log decides who may actually use the budget.
 *
 * The saved list, else ALLOWED_USERS, else anyone (empty): no default names, a
 * household's names belong to its own choices, not in the source everyone runs.
 * Empty means any DSM account may reach the sign-in, and membership still
 * decides whether they see anything. Read per use, so a saved list takes effect
 * with no restart.
 */
const allowedUsers = (): string[] => (resolvedEnv()['ALLOWED_USERS'] ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/**
 * Where the local bypass keeps its data. A separate file, so signing in without
 * DSM gives you a working app and none of the household's money.
 */
const DEV_LOG_PATH = process.env['DEV_LOG_PATH'] ?? 'data/dev-events.jsonl';
/**
 * Who is signed in, as hashes of their tokens, so a redeploy does not sign
 * everyone out. Beside the logs, not inside HOUSEHOLDS_DIR, where every entry
 * is taken to be a household.
 */
const SESSIONS_PATH = process.env['SESSIONS_PATH'] ?? 'data/sessions.json';
/** The NAS's connections, beside sessions.json and outside HOUSEHOLDS_DIR, where every entry is taken to be a household. */
const CONNECTORS_PATH = process.env['CONNECTORS_PATH'] ?? 'data/connectors.json';
// Note the default is deliberately NOT under the household volume.

/** The routes of This NAS that save a value, and the key each one saves. */
const CONNECTOR_SAVES: Readonly<Record<string, SavedKey>> = {
  'public-url': 'publicUrl', 'sign-in': 'signIn', 'book-url': 'bookUrl', mail: 'mail', census: 'census', eia: 'eia', claude: 'claude',
};

const ONE_OF = 'send one of value, off or clear';

/** A save on This NAS: its body: exactly one of `{ value }`, `{ off: true }` or `{ clear: true }`. The value is checked by its key. */
function connectorChangeIn(body: Record<string, unknown>): { value: unknown } | { off: true } | { clear: true } {
  const given = (['value', 'off', 'clear'] as const).filter((k) => body[k] !== undefined);
  if (given.length !== 1) throw new ToolError(ONE_OF);
  const [which] = given as ['value' | 'off' | 'clear'];
  if (which === 'value') return { value: body['value'] };
  if (body[which] !== true) throw new ToolError(ONE_OF);
  return which === 'off' ? { off: true } : { clear: true };
}

/** An origin with nothing after its port, `https://nas.example.com:5001`; null for anything else. */
function originOnly(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let u: URL;
  try { u = new URL(v.trim().replace(/\/$/, '')); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    return null;
  }
  return u.origin;
}

/** A key as pasted: trimmed, so a newline from a password manager is never sent in a header. */
function pastedKey(v: unknown): string {
  const key = typeof v === 'string' ? v.trim() : '';
  if (!key) throw new ToolError('paste the key');
  // A space or a line break inside is no key: the request's headers would refuse it, quoting it.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new ToolError('a key is one line with no spaces');
  return key;
}

const MAIL_SHAPE = 'mail needs a host, a port from 1 to 65535, a user and a from address';

/** The mail form's value. No password keeps the saved one; with none saved, it is needed. Passwords are never trimmed. */
function mailValueIn(v: unknown, savedPass: string | null): MailValue {
  const m = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const text = (k: string): string => (typeof m[k] === 'string' ? (m[k] as string).trim() : '');
  const rawPort = m['port'];
  const port = typeof rawPort === 'number' ? rawPort
    : typeof rawPort === 'string' && /^\d+$/.test(rawPort.trim()) ? Number(rawPort.trim()) : NaN;
  const host = text('host');
  const user = text('user');
  const from = text('from');
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535 || !isEmail(from)
    || (m['plainAuth'] !== undefined && typeof m['plainAuth'] !== 'boolean')) throw new ToolError(MAIL_SHAPE);
  const pass = typeof m['pass'] === 'string' && m['pass'] !== '' ? m['pass'] : savedPass;
  if (!pass) throw new ToolError('the password is needed the first time');
  return { host, port, user, pass, from, plainAuth: m['plainAuth'] === true };
}

/**
 * The change a route of This NAS saves, checked for its key, or a 400 in
 * words. `who` is the admin saving, or null for the sandbox, which never
 * passes the sign-in list and so cannot be locked out by it.
 */
function connectorChange(key: SavedKey, change: ReturnType<typeof connectorChangeIn>, who: string | null): Change<SavedKey> {
  if (key === 'signIn') {
    if ('off' in change) throw new ToolError('who may sign in cannot be off; clear it to let any DSM account sign in');
    if ('clear' in change) {
      // Cleared, the deployment's list applies: it must not leave out the admin clearing it either.
      const left = (process.env['ALLOWED_USERS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (who !== null && left.length > 0 && !left.includes(who)) {
        throw new ToolError(`the deployment's ALLOWED_USERS leaves out ${who}: clearing the list would lock you out`);
      }
      return change;
    }
    const v = change.value;
    if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) throw new ToolError('send the account names as a list');
    // Review Focus 2: as sign-in reads them, trimmed and lowercased, and the lockout asked the same way.
    const names = [...new Set((v as string[]).map((n) => n.trim().toLowerCase()).filter(Boolean))];
    if (names.length === 0) throw new ToolError('name at least one account, or clear the list to let any DSM account sign in');
    if (who !== null && !names.includes(who)) throw new ToolError(`keep ${who} in the list, or you would lock yourself out`);
    return { value: names };
  }
  if (!('value' in change)) return change;
  switch (key) {
    case 'publicUrl': {
      const origin = originOnly(change.value);
      if (origin === null) throw new ToolError('an address such as https://nas.example.com:5001, with nothing after the port');
      return { value: origin };
    }
    case 'bookUrl': {
      // As booking reads it: https, or http with COOKIE_INSECURE=1.
      const got = typeof change.value === 'string' ? bookUrl({ ...resolvedEnv(), BOOK_URL: change.value }) : { off: 'BOOK_URL' };
      if (typeof got === 'string') return { value: got };
      // Said as what to type: the page shows these words under the field.
      if (got.off.includes('https://')) throw new ToolError('Start it with https://, like https://planner.example.com (http:// only with COOKIE_INSECURE=1)');
      throw new ToolError('Just the address, with no path: like https://planner.example.com');
    }
    case 'mail': {
      const saved = connectors().mail;
      return { value: mailValueIn(change.value, saved && 'value' in saved ? saved.value.pass : null) };
    }
    default:
      return { value: pastedKey(change.value) };
  }
}

const MAX_BODY = 4 * 1024 * 1024;

/**
 * How many proxies stand in front, for reading the client's address out of
 * X-Forwarded-For. Each proxy appends the address it was reached from, so the
 * entry `n` from the right is the one the outermost of `n` proxies saw: the
 * client, and not anything the client wrote into the header itself. `1` is one
 * proxy that appends or replaces. Unset (or anything but a positive whole
 * number) means no proxy is trusted and the socket's address is used. Only the
 * per-IP limits read this: on sign-in emails and codes, and on members' passwords.
 */
const TRUST_PROXY_HOPS = (() => {
  const v = (process.env['TRUST_PROXY'] ?? '').trim();
  return /^[1-9]\d*$/.test(v) ? Number(v) : 0;
})();

/**
 * The client's address, given X-Forwarded-For, the socket's address and how
 * many proxies are trusted. A header shorter than that is not what those
 * proxies would have sent, so the socket is used.
 */
export function clientAddress(forwarded: string | string[] | undefined, socket: string | undefined, hops: number): string {
  if (hops > 0) {
    const entries = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (entries.length >= hops) return entries[entries.length - hops]!;
  }
  return socket ?? 'unknown';
}

/**
 * Which per-IP bucket an address is counted in. An IPv6 client is handed a
 * whole /64 by its provider and can pick any address in it, so it is counted
 * by the /64; an IPv4 address (or one mapped into IPv6) is itself. Anything
 * that is not an address at all is kept as it came.
 */
export function ipBucket(addr: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return mapped[1]!;
  const bare = addr.split('%')[0]!;
  if (!isIPv6(bare)) return addr;
  // An embedded IPv4 tail is two groups; only the first four groups matter here.
  const groupsOf = (s: string): string[] => (s ? s.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const [left, right] = bare.includes('::') ? bare.split('::') as [string, string] : [bare, null];
  const head = groupsOf(left);
  const groups = right === null ? head : [...head, ...Array<string>(8 - head.length - groupsOf(right).length).fill('0'), ...groupsOf(right)];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * What is wrong between TRUST_PROXY and a request under /book, or null. With
 * a proxy trusted and no X-Forwarded-For, the proxy is not sending it (or the
 * app is reached around it); with one sent and none trusted, every friend is
 * counted as the proxy. Either way the per-IP limits are not per friend.
 */
export function proxyMismatch(hops: number, forwarded: string | string[] | undefined): string | null {
  const has = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').trim() !== '';
  if (hops > 0 && !has) {
    return `TRUST_PROXY=${hops}, but a request under /book came with no X-Forwarded-For: the proxy is not sending it, `
      + "or the app is reached around the proxy, so the per-IP limits count the connection's own address";
  }
  if (hops === 0 && has) {
    return 'a request under /book came with X-Forwarded-For, but TRUST_PROXY is unset: every friend is counted as the proxy, '
      + 'one bucket for all of them, so the per-IP limits will refuse them together. Set TRUST_PROXY=1 for one proxy';
  }
  return null;
}

const clientIp = (req: IncomingMessage): string =>
  ipBucket(clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, TRUST_PROXY_HOPS));

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The small pages `/book/open` answers with, on the booking page's own look:
 * the place layer, Satoshi as every page loads it, the shared tokens from
 * under `/book`, a letterhead, and the booking page's own button (its `.btn`,
 * on the token controls). No script at all, so nothing submits itself. Titles
 * are this file's own constants; the one thing from a request, the token, is
 * escaped where it goes.
 */
const guestPage = (title: string, body: string): string => `<!doctype html>
<html lang="en" data-place="placitas">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title}</title>
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/book/tokens.css" />
<style>
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--surface);color:var(--ink);font-family:var(--font);font-size:var(--fs-body);line-height:var(--lh-body);
    -webkit-font-smoothing:antialiased}
  main{max-width:560px;margin:0 auto;padding:var(--sp-8) var(--gutter)}
  .letterhead h1{font-size:26px;font-weight:var(--fw-semibold);line-height:var(--lh-tight);letter-spacing:-0.02em;margin:0 0 var(--sp-2)}
  a{color:var(--accent-ink)}
  :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-2);min-height:var(--tap);padding:0 var(--sp-4);
    font:inherit;font-size:var(--fs-ui);font-weight:var(--fw-medium);color:var(--ink);background:var(--surface-sunken);
    border:var(--stroke) solid var(--line);border-radius:var(--r-control);cursor:pointer;white-space:nowrap}
  .btn.primary{background:var(--accent-fill);color:var(--on-accent);border-color:var(--accent-fill)}
  .btn.primary:hover{background:var(--accent-fill-hover);border-color:var(--accent-fill-hover)}
</style>
</head>
<body>
<main>
  <header class="letterhead"><h1>${title}</h1></header>
  ${body}
</main>
</body>
</html>
`;

/** Following the emailed link: one button, which is what actually signs in. */
const CONTINUE_PAGE = (token: string): string => guestPage('Come and stay', `
  <form method="post" action="/book/open">
    <input type="hidden" name="token" value="${escapeHtml(token)}" />
    <p><button class="btn primary" type="submit">Continue</button></p>
  </form>`);

/** A link that is spent, stale or unknown. Never why. */
const DEAD_LINK = guestPage('That link has already been used, or has run out',
  '<p>Each link works once. Go back to the <a href="/book">booking page</a> and ask for a new one.</p>');

/** A button pressed from somewhere other than the booking page. */
const WRONG_ORIGIN = guestPage('That did not work',
  '<p>Open the link from your email again, or go to the <a href="/book">booking page</a>.</p>');

/** Booking is off. Nothing more is said. */
const NOT_AVAILABLE = guestPage("This page isn't available right now.", '');

/**
 * Headers for those pages. `strict-origin`, not `no-referrer`: the page's URL
 * carries the token, and this sends only the origin as a Referer, never the
 * path or query, so the token still goes nowhere. `no-referrer` would also make
 * the browser send `Origin: null` on the Continue button's POST, and the
 * same-origin check there would refuse every real guest.
 */
function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin',
  });
  res.end(html);
}

/** A phone's link that is spent, stale or unknown. The same page whichever, and nothing about the household. */
const CODE_EXPIRED = guestPage('This code has expired',
  '<p>Open Home Planner on your computer and make a new one from Settings › You › Your iPhone and Mac.</p>');

const NOT_HTTPS = 'a phone can be set up only from a page opened over https (or over http on this computer)';
const NOT_HOME_ORIGIN = "the Home Screen link needs the page's own address, over http or https, with nothing after the host";
const NO_ADDRESS = "the NAS's address is not set: a DSM administrator sets it under Settings › This NAS › Where phones reach the NAS";

/**
 * What a phone's setup asks for, checked once for the code and the Mac's
 * download alike. The calendar is the profile's only payload now, so the NAS's
 * address is always needed; it is read now and kept with a code, so the profile
 * a phone gets matches what the sheet showed. The origin is the page's own and
 * is needed only for the code's link.
 */
function setupAsked(rawOrigin: unknown, originNeeded: boolean): { origin: string | null; dsmPublicUrl: string } {
  const origin = acceptedOrigin(rawOrigin);
  if (originNeeded && origin === null) throw new ToolError(NOT_HTTPS);
  const dsmPublicUrl = currentPublicUrl();
  if (dsmPublicUrl === null) throw new ToolError(NO_ADDRESS);
  return { origin, dsmPublicUrl };
}

/** A profile as a file to install. HEAD gets the headers alone, so a phone's look ahead spends nothing. */
function sendProfile(res: ServerResponse, profile: string | Buffer, head: boolean): void {
  res.writeHead(200, {
    'content-type': PROFILE_CONTENT_TYPE, 'content-disposition': `attachment; filename="${PROFILE_FILENAME}"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  });
  res.end(head ? undefined : profile);
}

/**
 * Where the copy of the NAS's certificate is, read per request so a saved
 * value and a deployment's agree with the rest; an empty value is unset.
 */
const profileCertDir = (): string | undefined => resolvedEnv()['PROFILE_CERT_DIR'] || undefined;

/** The `month` asked for, or '' when it is missing or given twice: the caller's validation says 400 to both. */
const monthParam = (url: URL): string => {
  const all = url.searchParams.getAll('month');
  return all.length === 1 ? all[0]! : '';
};

/**
 * The bands a restore asks for, or the receipts, the budget and its months when
 * none are named. A band this build does not have is refused, not passed over:
 * a restore that quietly took less than was asked would say yes to something else.
 */
function restoreScopes(asked: unknown): Scope[] {
  if (asked === undefined) return ['facts', 'budget', 'months'];
  if (!Array.isArray(asked)) throw new ToolError('scopes is a list of bands', 400);
  for (const s of asked) {
    if (!SCOPES.includes(s as Scope)) throw new ToolError(`there is no band called ${String(s)} to restore`, 400);
  }
  return asked as Scope[];
}

/** How many people a contact search hands back: enough to choose from, not the whole book. */
const CONTACTS_LISTED = 50;

/**
 * The front end is served from here rather than from a second container.
 *
 * One origin means the session cookie simply works and there is no CORS to
 * configure — a page on :8088 calling an API on :8090 would need both, for no
 * benefit. Everything under here is public; it is an empty shell until the API
 * answers, and the API needs a session.
 */
const SITE_DIR = resolvePath(process.env['SITE_DIR'] ?? '../site');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
  // normalize() then a prefix check: the classic traversal is ../../etc/passwd
  // and neither test alone is enough.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = rel === '/' || rel === '' ? join(SITE_DIR, 'index.html') : join(SITE_DIR, rel);
  if (!file.startsWith(SITE_DIR)) { json(res, 403, { error: 'no' }); return; }

  // An allowlist of extensions, not a denylist of paths. The site directory also
  // holds budget.jsonl and transactions.jsonl — the plan and every real
  // transaction — and serving those to anyone who guesses the filename would
  // hand out the whole household's finances with no session at all.
  if (!(extname(file).toLowerCase() in MIME)) { json(res, 404, { error: 'not found' }); return; }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // The shell must never be cached: it is how a fix reaches the phones.
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: `no such file ${rel}` });
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
};

/** What a guest may send under /book: a few fields, never a file. */
const BOOK_MAX_BODY = 8 * 1024;

async function readRaw(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new ToolError('request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const raw = await readRaw(req, max);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new ToolError('body is not valid JSON');
  }
}

/** A body that may be a plain HTML form (the Continue button) or JSON, under the same cap. */
async function readFormOrJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) {
    return Object.fromEntries(new URLSearchParams((await readRaw(req, max)).toString('utf8')));
  }
  const body = await readBody(req, max);
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

/** A JSON body that must be an object; anything else is a 400. */
async function bodyOf(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  const body = await readBody(req, max);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ToolError('the body is a JSON object');
  return body as Record<string, unknown>;
}

/**
 * A guest's write, with the fold's refusal answered as the 409 it is ("that
 * request is no longer waiting") rather than as a fault.
 */
async function guestWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (err instanceof ReplayError) throw new ToolError(err.message.replace(/ \(event .*\)$/, ''), 409);
    throw err;
  }
}

/** Room around the file itself for a multipart body's boundaries and part headers. */
const MULTIPART_SLACK = 64 * 1024;

/**
 * The one file in a multipart/form-data upload, read by hand (no dependency).
 * A body whose declared length is over the cap is refused before any of it is
 * read, and one that passes the cap while arriving is refused there; either
 * way the connection is closed rather than drained. Text parts are ignored;
 * the file's name is the part's filename, checked by `attachmentPath` after.
 */
async function readUpload(req: IncomingMessage, res: ServerResponse): Promise<{ name: string; bytes: Uint8Array }> {
  const type = req.headers['content-type'] ?? '';
  const m = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (!m) throw new ToolError('send the file as multipart/form-data');
  const boundary = m[1] ?? m[2]!;
  const limit = ATTACH_MAX_BYTES + MULTIPART_SLACK;
  const refuse = (): ToolError => {
    res.setHeader('connection', 'close');
    return new ToolError(`a file is at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB`, 413);
  };
  if (Number(req.headers['content-length']) > limit) throw refuse();

  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        // Stop listening, not destroy: destroying the request would take the
        // socket, and the 413 with it.
        req.off('data', onData);
        req.pause();
        reject(refuse());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // A browser that gives up mid-upload ends neither way; once ended, this is a no-op.
    req.on('close', () => reject(new ToolError('the upload was cut off before it finished')));
  });
  return onlyFile(body, boundary);
}

/** A part's filename, as a browser sends it: quoted, with `"`, CR and LF percent-encoded; or RFC 5987's `filename*`. */
function filenameOf(disposition: string): string | null {
  const star = /;\s*filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[2]!.trim()); } catch { throw new ToolError('the file name is not readable'); }
  }
  const quoted = /;\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(disposition);
  const bare = quoted ? null : /;\s*filename\s*=\s*([^;]+)/i.exec(disposition);
  const raw = quoted?.[1]?.replace(/\\(.)/g, '$1') ?? bare?.[1]?.trim();
  if (raw === undefined) return null;
  return raw.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n');
}

function onlyFile(body: Buffer, boundary: string): { name: string; bytes: Uint8Array } {
  const malformed = () => new ToolError('the upload is not a well-formed multipart body');
  const delim = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const files: { name: string; bytes: Uint8Array }[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw malformed();
  for (;;) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;   // "--": the closing boundary
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw malformed();
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw malformed();
    const headers = body.subarray(pos + 2, headEnd).toString('utf8');
    const start = headEnd + 4;
    const end = body.indexOf(next, start);
    if (end < 0) throw malformed();
    const name = filenameOf(/^content-disposition:(.*)$/im.exec(headers)?.[1] ?? '');
    if (name !== null) files.push({ name, bytes: body.subarray(start, end) });
    pos = end + 2;
  }
  if (!files.length) throw new ToolError('the upload has no file in it');
  if (files.length > 1) throw new ToolError('one file at a time');
  const file = files[0]!;
  if (file.bytes.length > ATTACH_MAX_BYTES) throw new ToolError(`a file is at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB`, 413);
  return file;
}

/**
 * How a file from a card is handed to the browser. Only images and plain text,
 * which cannot run script, are shown in place, in a sandbox; anything else, a
 * page, an SVG or a PDF among them, is a download, so nothing attached ever
 * runs on the app's own origin. A PDF can carry script and browsers will not
 * open one sandboxed, so it is not shown in place either.
 */
const SHOWN_INLINE: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
};

function sendFile(res: ServerResponse, name: string, bytes: Uint8Array): void {
  const inline = SHOWN_INLINE[extname(name).toLowerCase()];
  const filename = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(200, {
    'content-type': inline ?? 'application/octet-stream',
    'content-length': bytes.length,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    // A sandboxed, opaque origin even for what is shown in place.
    'content-security-policy': inline ? 'sandbox' : "default-src 'none'; sandbox",
  });
  res.end(bytes);
}

/** Whoever the cookie says, or nobody. */
function sessionOf(req: IncomingMessage, sessions: Sessions) {
  const token = readCookie(req.headers.cookie, COOKIE);
  const session = sessions.get(token);
  if (!session) throw new ToolError('please sign in', 401);
  return { session, token };
}

/**
 * The household this request is about, and the store behind it.
 *
 * Two gates, deliberately separate. The session says who you are; membership in
 * that household's own log says whether it is yours. An account can pass the
 * first and fail the second — having a DSM account is not being in a marriage.
 */
async function activeStore(
  session: { who: string; local: boolean; household: string | null },
  households: Households,
  devStore: Store | null,
): Promise<Store> {
  // A bypass session runs against the sandbox, which nobody owns, so there is
  // nothing to be a member of and nothing of yours to reach.
  if (session.local) {
    if (!devStore) throw new ToolError('the local sandbox is not enabled', 409);
    return devStore;
  }
  if (!session.household) {
    throw new ToolError('no household is open — choose or create one', 409);
  }
  const mine = await households.forUser(session.who);
  if (!mine.some((h) => h.id === session.household)) {
    // Deliberately the same answer whoever you are: whether a household exists,
    // and who is in it, is not something a stranger gets to learn.
    throw new ToolError('you do not have access to that household', 403);
  }
  return households.open(session.household);
}

/** How far ahead the plans rail looks for a due date, in days. */
const PLANS_AHEAD_DAYS = 7;
/** How many envelopes the money rail names. */
const LOW_ENVELOPES = 5;

/**
 * The plans rail: the viewer's own open cards (the board, pressed on them,
 * strictly), that are due within the week, overdue, or in Doing. Due
 * dates first, soonest first; then the rest of Doing, longest in it first.
 */
function plansRail(ctx: ToolContext, events: Parameters<typeof board>[1], tz: string): BoardCard[] {
  const until = addDays(ctx.today, PLANS_AHEAD_DAYS);
  return board(ctx.store.state, events, { who: ctx.who, today: ctx.today, tz }).rows
    .flatMap((r) => r.plans)
    .filter((c) => (c.due !== null && c.due <= until) || c.state === 'doing')
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (b.daysInState ?? 0) - (a.daysInState ?? 0));
}

/**
 * The money rail: what is left to assign this month, and the envelopes that
 * are short, read from the pace the briefing is written from (`lowEnvelopes`),
 * as text the engine wrote. Null while this month is not open.
 */
function moneyRail(ctx: ToolContext) {
  const snap = snapshot(ctx.store.state, monthOf(ctx.today), ctx.today);
  if (!snap) return null;
  return { month: snap.month, toAssign: fmt(snap.view.toAssign), low: lowEnvelopes(snap.pace, LOW_ENVELOPES) };
}

/**
 * The balances an import records: each statement's, as the preview read it,
 * and what Savings shows today when a CSV asked. A statement balance already
 * the account's latest is not written again, so importing a file twice says
 * it once.
 */
function balanceEvents(state: State, statements: unknown, savingsToday: unknown, today: string):
  Extract<NewEvent, { op: 'account.balance' }>[] {
  const out: Extract<NewEvent, { op: 'account.balance' }>[] = [];
  if (statements !== undefined && !Array.isArray(statements)) throw new ToolError('balances must be a list');
  for (const x of (statements ?? []) as { account?: unknown; cents?: unknown; asOf?: unknown }[]) {
    if (typeof x?.account !== 'string' || !x.account.trim() || typeof x.cents !== 'number' || !Number.isInteger(x.cents) || !isDay(x.asOf)) {
      throw new ToolError('each balance names its account, whole cents and the day it is as of');
    }
    const latest = state.savings.balances.get(x.account);
    if (latest && latest.asOf === x.asOf && latest.cents === x.cents) continue;
    out.push({ op: 'account.balance', account: x.account, cents: cents(x.cents), asOf: x.asOf, source: 'statement' });
  }
  if (savingsToday !== undefined && savingsToday !== null) {
    const account = state.savings.account;
    if (!account) throw new ToolError('choose the savings account first', 409);
    if (typeof savingsToday !== 'number' || !Number.isInteger(savingsToday)) throw new ToolError('what Savings shows is in whole cents');
    out.push({ op: 'account.balance', account, cents: cents(savingsToday), asOf: today, source: 'typed' });
  }
  return out;
}

/** A path segment as it was meant; a malformed escape is the caller's mistake. */
const decoded = (segment: string): string => {
  try { return decodeURIComponent(segment); } catch { throw new ToolError('that address is not readable'); }
};

/** Only the named fields, and only those present: a body passes through no more than a route takes. */
const pick = <T extends Record<string, unknown>>(o: T, keys: readonly string[]): Partial<T> =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<T>;

/**
 * Settings as the screen gets them: the household's, plus the parts that are
 * yours (appearance, the calendars you check for clashes). Every settings and
 * calendar write answers with this, so the screen redraws from one shape.
 */
/**
 * Booking as one household's members see it: on only in the household friends
 * book with. Every other household on this server is told so, not shown a
 * page that would post someone else's guests to it.
 */
const offView = (why: string) => ({ on: false as const, why, words: bookingOffWords(why) });
const onOrOff = (booking: BookingStatus, household: string | null):
  { on: true } | { on: false; why: string; words: string } =>
  !booking.on ? offView(booking.why)
    : booking.config.household === household ? { on: true }
    : offView('friends book with another household on this server');

/**
 * The Booking row's switch: on or off as above, and whether this household
 * could turn it on (`available`); if not, `why` (and the off line's `words`)
 * name who can fix it. Then whether the app turned it off because the
 * Household calendar was gone, and what is ahead here, which holds the switch.
 */
const bookingView = (state: State, booking: BookingStatus, household: string | null, viewer: Viewer) => {
  const can = bookingAvailability(state, { env: resolvedEnv(), adminUser: ADMIN_USER || null, viewer });
  const about = {
    available: can.available, calendarGone: state.settings.booking?.calendarGone ?? false,
    ahead: aheadOf(state, todayInTz(zoneOf(state))),
  };
  const view = onOrOff(booking, household);
  return view.on || can.available ? { ...view, ...about } : { on: false as const, why: can.why, words: can.why, ...about };
};

/** The guest list for Settings, or why there is none here. */
const guestsView = (state: State, booking: BookingStatus, household: string | null) => {
  const view = onOrOff(booking, household);
  return view.on && booking.on
    ? { on: true as const, url: `${booking.config.url}/book`, list: guestList(state), arrival: state.settings.arrival }
    : view;
};

/** One segment of a path, decoded; one that cannot be is nothing this server has. */
const segment = (raw: string, missing: string): string => {
  try { return decodeURIComponent(raw); } catch { throw new ToolError(missing, 404); }
};

/** The household a session has open, or null for the sandbox, which no guest books. */
const openHousehold = (session: { local: boolean; household: string | null }): string | null =>
  session.local ? null : session.household;

/**
 * Settings → Budget: the account the sinking envelopes' money lives in, the
 * accounts imports have seen to choose it from (newest receipt first), and
 * what it last showed.
 */
function savingsSettings(state: State) {
  const seen = new Map<string, { receipts: number; last: string }>();
  for (const t of state.txns.values()) {
    if (!t.account) continue;
    const s = seen.get(t.account) ?? { receipts: 0, last: '' };
    seen.set(t.account, { receipts: s.receipts + 1, last: t.date > s.last ? t.date : s.last });
  }
  // A statement with nothing new in it still showed its balance: that account was seen too.
  for (const b of state.savings.balances.values()) if (!seen.has(b.account)) seen.set(b.account, { receipts: 0, last: b.asOf });
  const account = state.savings.account;
  const b = account ? state.savings.balances.get(account) : undefined;
  return {
    account,
    accounts: [...seen].map(([id, s]) => ({ account: id, ...s })).sort((x, y) => y.last.localeCompare(x.last)),
    balance: b ? { exact: fmtExact(b.cents), asOf: b.asOf, source: b.source, who: b.who } : null,
  };
}

/**
 * After a balance is written: if Savings now comes up short of the sinking
 * envelopes, a card says so on Today. Never the reason the balance is not
 * recorded; it already is.
 */
async function raiseSavingsCardFor(ctx: ToolContext, written: readonly Event[]): Promise<void> {
  try {
    await raiseSavingsCard(ctx, written);
  } catch (err) {
    console.warn(`[savings] the card for a short balance was not raised: ${(err as Error).message}`);
  }
}

/** The index check's last answer for each household, with the folder it was asked of; kept in memory, so a new folder starts unasked. */
const indexedAnswers = new Map<string, { readonly folder: string; readonly indexed: boolean | null }>();

const indexedFor = (household: string | null, state: State): boolean | null => {
  const folder = state.documents.folder;
  const kept = household === null ? undefined : indexedAnswers.get(household);
  return folder !== null && kept?.folder === drivePathOf(folder) ? kept.indexed : null;
};

/**
 * Ask the NAS again whether Universal Search reads the household's folder,
 * until it says it does. The answer only advises, so a NAS that cannot be
 * asked leaves the last answer as it was.
 */
async function askIndexed(ctx: ToolContext, state: State, household: string | null): Promise<void> {
  const folder = state.documents.folder;
  if (folder === null || household === null || !ctx.sid || indexedFor(household, state) === true) return;
  try {
    const checks = await checkFolder(ctx.sid, folder, { household, members: [...state.members] });
    indexedAnswers.set(household, { folder: drivePathOf(folder), indexed: checks.indexed });
  } catch (err) {
    if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
  }
}

/**
 * A move under way, as Settings shows it: how many files are left, where they
 * go, which failed (in the NAS's words) and when each is tried again, and how
 * many files stay behind in the folder being left. Null when nothing waits.
 */
async function movingView(store: Store) {
  if (!store.state.documents.waiting.size) return null;
  // Files taken off a card stay where they are: counted from the log, which keeps every one.
  const events = await store.since(null);
  const { folder, previous, waiting } = store.state.documents;
  if (!folder || !previous || !waiting.size) return null;
  const left = `${nasPathOf(previous)}/`;
  const behind = new Set(events.flatMap((e) => (e.op === 'plan.detach' && e.path.startsWith(left) ? [e.path] : []))).size;
  return {
    left: waiting.size,
    to: `${folder.team}/${folder.folder}`,
    failed: moveFailures(store.path).map((f) => ({ name: f.name, words: f.words, retryAt: new Date(f.at + PAGE_RETRY_MS).toISOString() })),
    behind,
  };
}

const settingsView = async (store: Store, who: string, booking: BookingStatus, household: string | null, admin: boolean) => {
  const moving = await movingView(store);
  // Per request, so a certificate copied in or run out shows on the next look.
  const signing = (await loadSigner(profileCertDir())).status;
  return settingsOf(store.state, who, booking, household, moving, signing, admin);
};

/** Where a member's calendars are on the NAS from outside, typed into a phone by hand; null while the address is not set. */
const caldavAddress = (who: string): string | null => {
  const publicUrl = currentPublicUrl();
  return publicUrl === null ? null : publicUrl + caldavPath(who);
};

const settingsOf = (
  state: State, who: string, booking: BookingStatus, household: string | null, moving: Awaited<ReturnType<typeof movingView>>,
  signing: SigningStatus, admin: boolean,
) => ({
  savings: savingsSettings(state),
  areas: state.settings.areas,
  links: state.settings.links,
  appearance: state.settings.appearance.get(who) ?? null,
  calendar: {
    household: state.calendar.household,
    target: state.calendar.target,
    conflicts: state.calendar.conflicts.get(who) ?? [],
  },
  members: [...state.members],
  /**
   * Whether cards keep files, and if so in which folder on the NAS and up to
   * what size each: on once the owner has chosen where documents live.
   */
  attachments: state.documents.folder !== null
    ? { on: true, root: nasPathOf(state.documents.folder), cap: ATTACH_MAX_BYTES }
    : { on: false, why: filesOff(state.owner) },
  /**
   * Guests: in the household friends book with, where the page is and who is
   * on the list; anywhere else, off, and why.
   */
  guests: guestsView(state, booking, household),
  /** The zone the household's days are read in (its own, else the deployment's): the screens draw their days in it too. */
  tz: zoneOf(state),
  /**
   * What a new household has still to decide, and who may decide it. The
   * folder and the zone say where their value came from, in Settings' words.
   */
  setup: {
    owner: state.owner,
    youOwn: state.owner === who,
    why: state.owner === who ? null : `Only ${state.owner ?? 'the owner'} can change these.`,
    ...setupSteps(state),
    documents: {
      folder: state.documents.folder === null ? null : { team: state.documents.folder.team, folder: state.documents.folder.folder },
      source: folderSource(state),
      left: movesLeft(state),
      indexed: indexedFor(household, state),
      moving,
    },
    zone: { zone: zoneOf(state), source: zoneSource(state) },
  },
  /** The model that suggests envelopes: which, whose choice it is, what is offered, and whether this NAS has no key to use it with. */
  model: { chosen: matchModel(state), source: modelSource(state), choices: modelChoices(), claudeOff: !claudeConfigured() },
  /**
   * DSM's public origin (`DSM_PUBLIC_URL`), or null: where the Calendar's link to
   * Synology Calendar goes, and what Settings tells a phone to add the NAS's calendar at.
   */
  dsmPublicUrl: currentPublicUrl(),
  /**
   * What Set up your iPhone shows: the address a phone adds the calendar at by
   * hand, or null while the NAS's address is not set, and whom to ask to set it;
   * and whether the profile it downloads is signed, as whom and until when.
   */
  phoneSetup: {
    caldav: caldavAddress(who),
    nasAdmin: ADMIN_USER || lastSavedBy() || null,
    signing,
  },
  /**
   * Whether friends can book here, and if not, why; whether the owner could
   * switch it on, what holds it, and whether a lost calendar turned it off;
   * and what booking needs, each said to this member as the one who sets it
   * or not. Members only, like the rest of this; a guest is never told why.
   */
  booking: {
    ...bookingView(state, booking, household, { who, admin }),
    needs: bookingNeeds(state, { env: resolvedEnv(), viewer: { who, admin } }),
  },
});

/**
 * A calendar for the screen: DSM's ids, its name as `name`, as the Household
 * one has. `isHousehold` is worked out here, on either id, so a member the
 * calendar is shared with finds it even if DSM lists it for them under ids of
 * their own.
 */
const calendarView = (c: CalendarInfo, household: State['calendar']['household']) => ({
  cal_id: c.cal_id, original_cal_id: c.original_cal_id, name: c.displayname,
  color: c.color, privilege: c.privilege, isDefault: c.isDefault,
  isHousehold: household !== null && sameCalendar(c, household),
});

/** A `{ cal_id, original_cal_id }` from a request body, or a 400. */
const calendarRefFrom = (x: unknown): { cal_id: string; original_cal_id: string } => {
  const r = x as { cal_id?: unknown; original_cal_id?: unknown } | null;
  if (typeof r?.cal_id !== 'string' || !r.cal_id || typeof r.original_cal_id !== 'string' || !r.original_cal_id) {
    throw new ToolError('a calendar is named by cal_id and original_cal_id');
  }
  return { cal_id: r.cal_id, original_cal_id: r.original_cal_id };
};

/** The member's own listed calendar with these ids, or a 400: nothing is recorded that DSM did not show them. */
const listedCalendar = (listed: readonly CalendarInfo[], ref: { cal_id: string; original_cal_id: string }): CalendarInfo => {
  const found = listed.find((c) => c.cal_id === ref.cal_id && c.original_cal_id === ref.original_cal_id);
  if (!found) throw new ToolError(`you have no calendar ${ref.cal_id} on the NAS`);
  return found;
};

/**
 * Plans are written with the acting member's own session, so a calendar that
 * is not the Household one may become where plans go only if every other
 * member can write to it. DSM tells only a calendar's owner who it is shared
 * with, so the chooser must own it, and must have shared it read-write with
 * each of the others.
 */
async function sharedWithEveryone(sid: string, chosen: CalendarInfo, who: Actor, members: readonly Actor[]): Promise<void> {
  let users: UserShare[];
  try {
    ({ users } = await sharingOf(sid, chosen.cal_id));
  } catch (err) {
    // A refusal from DSM is what a non-owner gets. A dead session, or a NAS
    // that did not answer, is not about ownership and is said as itself.
    if (err instanceof SynologyError && !(err instanceof SessionLost) && err.code !== 0) {
      throw new ToolError('only the calendar\'s owner can make it the household\'s');
    }
    throw err;
  }
  const writers = new Set(users.filter((u) => u.privilege === 'RW').map((u) => u.name.toLowerCase()));
  const missing = members.find((m) => m !== who && !writers.has(m.toLowerCase()));
  if (missing) throw new ToolError(`share it with ${missing} first`);
}

/** Today, as the household's calendar has it. */
const todayInTz = (tz: string): string => householdDay(tz);

export async function start(
  opts: { send?: typeof sendMail; households?: Households; phoneCodes?: PhoneCodes } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  // The NAS's connections first: everything below reads them when it is used.
  for (const problem of loadConnectors(CONNECTORS_PATH).problems) {
    console.warn(`[budget] ${problem.replace(/\.$/, '')}; that setting comes from the deployment`);
  }
  // The households can be handed in so a test can write to the same stores the server reads.
  const households = opts.households ?? new Households(HOUSEHOLDS_DIR);
  const proposals = new ProposalStore();
  /** Stores whose waiting move this process has picked up again since it started, by path. */
  const resumed = new Set<string>();
  const sessions = new Sessions({ path: SESSIONS_PATH });
  /** Friends signed in to /book: memory only, apart from members' sessions. */
  const guests = new GuestSessions();
  const send = opts.send ?? sendMail;
  /** Phones' one-time links: memory only, so a restart spends them all. A test hands in its own clock. */
  const phoneCodes = opts.phoneCodes ?? createPhoneCodes();
  // An install that predates many-households has its whole budget in one log.
  // Adopt it rather than leaving it on disk with nothing able to open it.
  const adopted = await adoptSingleLog(households, LOG_PATH, ADMIN_USER || null);
  if (adopted) {
    console.log(`[budget] adopted ${LOG_PATH} as household "${adopted.id}" (owner ${adopted.owner})`);
    if (adopted.addedAdmin) {
      console.log(`[budget] adoption added ${adopted.addedAdmin} as a member of "${adopted.id}" — it `
        + `was claimed by ${adopted.owner}, who may not be able to sign in here`);
    }
    if (adopted.ownerless) {
      console.warn(`[budget] "${adopted.id}" is owned by ${adopted.owner} and ADMIN_USER is unset — `
        + 'if that name cannot sign in, nobody can open it');
    }
  }

  // The sandbox is a household nobody shares, in its own file, so "works
  // locally" cannot mean "reads somebody's budget".
  const bypass = localBypassUser();
  const devStore = bypass ? new Store({ path: DEV_LOG_PATH }) : null;
  if (devStore) {
    await devStore.load();
    await retireShelves(devStore);
  }

  const all = await households.list();
  console.log(`[budget] ${all.length} household${all.length === 1 ? '' : 's'} in ${households.dir}`);
  console.log(`[budget] ${sessions.size} session${sessions.size === 1 ? '' : 's'} carried over from ${SESSIONS_PATH}`);
  // Every household's folder is known before anything is asked of it: the registry
  // refuses a folder another household holds without opening any other log. A
  // household that already writes files under the deployment's folder keeps them
  // working: its folder is carried over, once. A folder still being left, with
  // files waiting to move out of it, is held too.
  for (const h of all) {
    try {
      rememberDocuments(h.id, (await households.open(h.id)).state.documents);
    } catch (err) {
      console.warn(`[budget]   ${h.id}: could not be opened (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  await carryOver(households, PLANNER_ROOT);
  for (const h of all) {
    let state: State;
    try {
      state = (await households.open(h.id)).state;
    } catch {
      continue; // said above
    }
    const folder = state.documents.folder;
    const where = folder
      ? `folder ${folder.team}/${folder.folder} (${folder.source === 'deployment' ? 'from the deployment' : 'chosen'})`
      : 'none chosen';
    const left = movesLeft(state);
    console.log(`[budget]   ${h.id}: ${where}; zone ${zoneOf(state)} (${zoneSource(state)})${left > 0 ? `; ${left} files left to move` : ''}`);
  }
  console.log(`[budget] admin: ${ADMIN_USER ? `ADMIN_USER=${ADMIN_USER}` : "DSM's administrators group"}`);
  // Whose certificate and until when, or why not; never anything from the key.
  const signing = (await loadSigner(profileCertDir())).status;
  console.log(`[budget] profile signing: ${signing.signed
    ? `signed as ${signing.signedAs} until ${signing.validTo.slice(0, 10)}`
    : `off (${signing.reason})`}`);
  // Where the key comes from, never the key.
  console.log(`[budget] Claude: ${claudeKey() === null ? 'off' : sourceOf('claude') === 'saved' ? 'key saved on This NAS' : 'key from the deployment'}`);
  const retired = 'SYNO_CONTACTS_VERSION';
  if ((process.env[retired] ?? '') !== '') console.warn(`[budget] ${retired} is no longer read: the Contacts version is asked of the NAS`);
  if (devStore) {
    console.warn(`[budget] DEV_USER=${bypass} may sign in without DSM, against ${devStore.path} only`);
  }

  /**
   * Each household's booking switch, as its log says it. A log that cannot be
   * opened books nobody (boot has said so above).
   */
  async function bookingLogs(): Promise<{ id: string; booking: State['settings']['booking'] }[]> {
    const out: { id: string; booking: State['settings']['booking'] }[] = [];
    for (const id of await households.ids()) {
      try {
        out.push({ id, booking: (await households.open(id)).state.settings.booking });
      } catch {
        // said at boot
      }
    }
    return out;
  }

  /** Why booking is off when no log says on and BOOK_HOUSEHOLD names a household this server does not have. */
  const NO_HOUSEHOLD = 'BOOK_HOUSEHOLD is not a household here';

  /**
   * Booking as it is now, worked out from the logs, the saved settings and the
   * deployment on every call: so a `guests.booking`, a save on This NAS, a
   * restore and a household made after boot all count at once.
   */
  async function bookingNow(): Promise<BookingStatus> {
    const env = resolvedEnv();
    const logs = await bookingLogs();
    const status = bookingStatus(env, bookingHousehold(logs, env));
    // A BOOK_HOUSEHOLD naming none of them would put guests' requests nowhere: said as that, not as nobody turning it on.
    const named = env['BOOK_HOUSEHOLD']?.trim();
    if (!status.on && status.why === NO_BOOKING_HOUSEHOLD && named && !logs.some((l) => l.id === named)) return { on: false, why: NO_HOUSEHOLD };
    return status;
  }

  /**
   * This NAS as it stands, worked out on every load and after
   * every save: booking included, so a save that changes it counts at once.
   * Drive is asked with the admin's own session, when they have one.
   */
  async function connectorsNow(sid: string | null): Promise<ReturnType<typeof connectorsView>> {
    let driveReachable: boolean | null = null;
    if (sid) {
      try {
        await teamFolders(sid);
        driveReachable = true;
      } catch {
        // Whatever stopped it, Drive did not answer this session: the row says so.
        driveReachable = false;
      }
    }
    const all = await households.list();
    const booking = await bookingNow();
    return connectorsView({
      env: resolvedEnv(), households: all, driveReachable, booking,
      bookingLabel: booking.on ? all.find((h) => h.id === booking.config.household)?.label ?? null : null,
      adminRule: ADMIN_USER ? 'ADMIN_USER' : 'group',
    });
  }

  // Booking as it stands at boot, for the log.
  const bookingAtBoot = await bookingNow();
  if (!bookingAtBoot.on && bookingAtBoot.why === NO_HOUSEHOLD) {
    console.warn(`[budget] BOOK_HOUSEHOLD=${resolvedEnv()['BOOK_HOUSEHOLD']?.trim()} is not a household here; booking is off`);
  } else if (!bookingAtBoot.on) {
    // Which variable, in the words Settings shows a member.
    console.log(`[budget] ${bookingOffWords(bookingAtBoot.why)}`);
  } else {
    console.log(`[budget] booking is on for "${bookingAtBoot.config.household}" at ${bookingAtBoot.config.url}/book`);
  }

  /** Switches of booking, and the app finding a calendar gone, one at a time across households. */
  const BOOKING_TURN = 'booking';

  /**
   * The owner turns booking on or off for their household. On needs the
   * household able to book, and moves booking from another household only when
   * nothing is ahead there: `system` turns it off in that log, and its guests
   * are signed out. Off is refused while anything is ahead here; done, this
   * household's guests are signed out.
   */
  async function switchBooking(store: Store, here: string, viewer: Viewer, on: boolean): Promise<void> {
    const who = viewer.who;
    await oneAtATime(BOOKING_TURN, async () => {
      // Read after the wait: a switch just before this one may have moved it.
      const env = resolvedEnv();
      const current = bookingHousehold(await bookingLogs(), env);
      if (on) {
        const can = bookingAvailability(store.state, { env, adminUser: ADMIN_USER || null, viewer });
        if (!can.available) throw new ToolError(can.why, 409);
        if (current !== null && current !== here) {
          const other = await households.open(current);
          const ahead = aheadOf(other.state, todayInTz(zoneOf(other.state)));
          if (ahead.requests || ahead.stays) {
            throw new ToolError(`${other.state.label} has ${aheadWords(ahead)}: booking stays with them until then.`, 409);
          }
          await other.append(SYSTEM, { op: 'guests.booking', on: false });
          guests.revokeAll(other.state.guests.keys());
        }
        if (store.state.settings.booking?.on !== true) await store.append(who, { op: 'guests.booking', on: true });
        return;
      }
      if (current === here) {
        const ahead = aheadOf(store.state, todayInTz(zoneOf(store.state)));
        if (ahead.requests || ahead.stays) throw new ToolError(`Booking stays on: ${aheadWords(ahead)}.`, 409);
      }
      if (store.state.settings.booking?.on !== false) await store.append(who, { op: 'guests.booking', on: false });
      if (current === here) guests.revokeAll(store.state.guests.keys());
    });
  }

  /**
   * The Household calendar's maker listed their calendars and it was not
   * there: it is gone. `system` turns booking off here, saying why, whether or
   * not this household books, so it cannot be turned on against a calendar
   * that is not there. If this household is the one that books, its guests
   * are signed out too.
   */
  async function calendarLost(store: Store, here: string, gone: { cal_id: string; original_cal_id: string }): Promise<void> {
    await oneAtATime(BOOKING_TURN, async () => {
      // Read after the wait: chosen again since, it is not gone; said already, it is not said twice.
      const now = store.state.calendar.household;
      if (!now || !sameCalendar(now, gone) || store.state.settings.booking?.calendarGone) return;
      const books = bookingHousehold(await bookingLogs(), resolvedEnv()) === here;
      await store.append(SYSTEM, { op: 'guests.booking', on: false, calendarGone: true });
      if (books) guests.revokeAll(store.state.guests.keys());
    });
  }

  /**
   * The guest the booking cookie says, still on the list, or a 401. The only
   * reader of that cookie; `sessionOf` never looks at it.
   */
  async function guestOf(req: IncomingMessage, household: string): Promise<{ email: string; token: string }> {
    const token = readCookie(req.headers.cookie, GUEST_COOKIE);
    const g = guests.get(token);
    if (!g || !token) throw new ToolError('please sign in', 401);
    // Taken off the list since signing in: signed out, here and now.
    if (!(await households.open(household)).state.guests.has(g.email)) {
      guests.revoke(token);
      throw new ToolError('please sign in', 401);
    }
    return { email: g.email, token };
  }

  /** Said once a process: the proxy in front and TRUST_PROXY disagree (see proxyMismatch). */
  let proxyWarned = false;

  /**
   * `/book` and below. Nothing a guest is told says why booking is off.
   *
   * While it is on, every POST comes from the booking page itself or not at
   * all: `Origin` is BOOK_URL exactly (a form on another site, or a page that
   * sends none, gets the 403 page the Continue button gets), and every route
   * but the Continue button's form takes JSON and nothing else (415), which a
   * cross-site form cannot send. Bodies here are a few fields: 8 KB at most.
   */
  async function book(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const now = await bookingNow();
    if (now.on && !proxyWarned) {
      const mismatch = proxyMismatch(TRUST_PROXY_HOPS, req.headers['x-forwarded-for']);
      if (mismatch) { proxyWarned = true; console.warn(`[budget] ${mismatch}`); }
    }
    if (path === '/book' && req.method === 'GET') return serveStatic('/book.html', res);
    if (path === '/book/tokens.css' && req.method === 'GET') return serveStatic('/tokens.css', res);
    // The page's icons ride the same one path the proxy exposes, for the same reason as the tokens.
    if (path === '/book/favicon.ico' && req.method === 'GET') return serveStatic('/favicon.ico', res);
    if (path === '/book/icon.svg' && req.method === 'GET') return serveStatic('/icon.svg', res);
    if (path === '/book/icon-180.png' && req.method === 'GET') return serveStatic('/icon-180.png', res);

    if (req.method === 'POST' && now.on) {
      if (req.headers.origin !== now.config.url) return sendPage(res, 403, WRONG_ORIGIN);
      if (path !== '/book/open' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        throw new ToolError('send JSON', 415);
      }
    }
    const body = async () => bodyOf(req, BOOK_MAX_BODY);

    if (path === '/book/start' && req.method === 'POST') {
      const asked = await body();
      const email = typeof asked['email'] === 'string' ? asked['email'] : '';
      if (now.on) {
        const store = await households.open(now.config.household);
        const mailAfter = await startSignIn({ store, cfg: now.config, now: Date.now, ip: clientIp(req) }, email, send);
        // Answered first, then mailed: nothing about the mail server's pace reaches the page.
        json(res, 200, { ok: true, message: SIGN_IN_MESSAGE });
        mailAfter();
        return;
      }
      await signInFloor();
      return json(res, 200, { ok: true, message: SIGN_IN_MESSAGE });
    }

    if (path === '/book/signout' && req.method === 'POST') {
      guests.revoke(readCookie(req.headers.cookie, GUEST_COOKIE));
      res.setHeader('set-cookie', clearedGuestCookie());
      return json(res, 200, { ok: true });
    }

    const isOpen = path === '/book/open' && (req.method === 'GET' || req.method === 'POST');
    if (!now.on) {
      // Reached by clicking, so a page rather than JSON; and it says nothing more.
      if (isOpen) return sendPage(res, 404, NOT_AVAILABLE);
      throw new ToolError('not available', 404);
    }
    const onList = async (email: string) => (await households.open(now.config.household)).state.guests.has(email);

    // Looking at the link spends nothing: a mail scanner that fetches it sees
    // a button. Pressing the button is what signs in.
    if (path === '/book/open' && req.method === 'GET') {
      return sendPage(res, 200, CONTINUE_PAGE(url.searchParams.get('token') ?? ''));
    }

    if (path === '/book/open' && req.method === 'POST') {
      // Only the button on our own page (the Origin check above): a form
      // elsewhere posting a token it holds would sign this browser in as someone else.
      const form = await readFormOrJson(req, BOOK_MAX_BODY);
      let email: string | null = null;
      try {
        email = finishSignIn({ token: typeof form['token'] === 'string' ? form['token'] : '', now: Date.now });
      } catch (err) {
        if (!(err instanceof ToolError) || err.status !== 401) throw err;
      }
      if (email === null || !(await onList(email))) return sendPage(res, 401, DEAD_LINK);
      res.writeHead(303, {
        'set-cookie': guestCookie(guests.issue(email)), location: '/book',
        'cache-control': 'no-store', 'referrer-policy': 'strict-origin',
      });
      res.end();
      return;
    }

    if (path === '/book/code' && req.method === 'POST') {
      const asked = await body();
      const email = finishSignIn({
        email: typeof asked['email'] === 'string' ? asked['email'] : '',
        code: typeof asked['code'] === 'string' ? asked['code'] : '',
        now: Date.now, ip: clientIp(req),
      });
      if (!(await onList(email))) throw new ToolError('that link or code is not right', 401);
      res.setHeader('set-cookie', guestCookie(guests.issue(email)));
      return json(res, 200, { email });
    }

    if (path === '/book/me' && req.method === 'GET') {
      const { email } = await guestOf(req, now.config.household);
      const state = (await households.open(now.config.household)).state;
      // The household's name, as every email to them is signed: the page's letterhead says it too.
      // Its day is the household's, not the browser's. Whether the confirmation brings how to get in;
      // never what that says, which is for a confirmed guest.
      return json(res, 200, { email, household: state.label, tz: zoneOf(state), arrival: state.settings.arrival !== '' });
    }

    if (path === '/book/nights' && req.method === 'GET') {
      const { email } = await guestOf(req, now.config.household);
      const month = monthParam(url);
      const state = (await households.open(now.config.household)).state;
      // Two keys a night; availability builds the rows from nothing else.
      return json(res, 200, { month, nights: availability(state, { month, forEmail: email, today: todayInTz(zoneOf(state)) }) });
    }

    // ── asking to stay, and their own requests ─────────────────────────────
    if (path === '/book/request' && req.method === 'POST') {
      const { email } = await guestOf(req, now.config.household);
      const store = await households.open(now.config.household);
      const o = await guestWrite(request({ store, who: `${GUEST_PREFIX}${email}`, today: todayInTz(zoneOf(store.state)) }, await body()));
      return json(res, 200, { id: o.id });
    }

    if (path === '/book/mine' && req.method === 'GET') {
      const { email } = await guestOf(req, now.config.household);
      const store = await households.open(now.config.household);
      return json(res, 200, { requests: mine(store.state, await store.since(null), email, todayInTz(zoneOf(store.state))) });
    }

    if ((path === '/book/cancel' || path === '/book/change') && req.method === 'POST') {
      const { email } = await guestOf(req, now.config.household);
      const store = await households.open(now.config.household);
      const asked = await body();
      // Only an id of their own is anything here: another guest's is as unknown as one never made
      // (cancelStay and changeStay say so, 404, before they take anything's turn).
      const id = typeof asked['id'] === 'string' ? asked['id'] : '';
      const g = { store, who: `${GUEST_PREFIX}${email}`, today: todayInTz(zoneOf(store.state)) };
      if (path === '/book/cancel') {
        // The reason on the line is the app's: a guest's words reach the household only in a request's note.
        const e = await guestWrite(cancelStay(g, id, GUEST_CANCEL_WHY));
        return json(res, 200, { id: e.id });
      }
      const o = await guestWrite(changeStay(g, id, asked));
      return json(res, 200, { id: o.id });
    }

    if (path === '/book/accept-suggestion' && req.method === 'POST') {
      const { email } = await guestOf(req, now.config.household);
      const store = await households.open(now.config.household);
      const asked = await body();
      const o = await guestWrite(acceptSuggestion({ store, who: `${GUEST_PREFIX}${email}`, today: todayInTz(zoneOf(store.state)) }, asked['id']));
      return json(res, 200, { id: o.id });
    }

    throw new ToolError('not found', 404);
  }

  /** Wrong passwords per client address (its /64 for IPv6): memory only. */
  const wrongLoginsPerMinute = new Limiter(10, 60_000);
  const wrongLoginsPerHour = new Limiter(100, 3_600_000);

  /** A member signs in: DSM says whether the password is right, and this app issues its own session. */
  async function signIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { username?: string; password?: string; otpCode?: string };
    const username = (body.username ?? '').trim().toLowerCase();
    if (!username || !body.password) throw new ToolError('username and password are required');
    // Decided before the allowlist is applied. The allowlist guards the
    // household, and a bypass session can never reach it — checking it first
    // means the sandbox needs no place on the real guest list.
    const isBypass = bypass !== null && username === bypass.toLowerCase();
    const allowed = allowedUsers();
    if (!isBypass && allowed.length && !allowed.includes(username)) {
      // The answer stays identical to a wrong password so account names do not
      // leak. The log says which it was, because otherwise a first deployment
      // with the wrong ALLOWED_USERS is indistinguishable from a typo and
      // there is nowhere to look.
      console.warn(`[budget] refused "${username}": not in ALLOWED_USERS `
        + `(${allowed.join(', ') || 'empty'}) — set it to your DSM account names`);
      throw new ToolError('that username or password is not right', 401);
    }

    let sid: string | null = null;
    if (!isBypass) {
      try {
        ({ sid } = await checkWithDsm(username, body.password, body.otpCode));
      } catch (err) {
        if (err instanceof OtpRequired) return json(res, 200, { ok: false, otpRequired: true });
        if (err instanceof AuthError) {
          console.warn(`[budget] DSM refused "${username}": ${err.message}`);
          throw new ToolError(err.message, err.status);
        }
        throw err;
      }
    }

    if (isBypass && devStore && devStore.state.owner === null) {
      await devStore.append(username, { op: 'household.claim', label: 'Sandbox' });
    }

    // Signing in no longer implies access to anything. It tells you which
    // households are yours; none is a perfectly ordinary answer on a first
    // visit, and the app offers to make one.
    const mine = isBypass ? [] : await households.forUser(username);
    const only = mine.length === 1 ? mine[0]!.id : null;
    const admin = await adminAtSignIn(username, isBypass ? null : sid);
    res.setHeader('set-cookie', sessionCookie(sessions.issue(username, {
      local: isBypass, household: isBypass ? 'sandbox' : only,
      sid: isBypass ? null : sid, admin,
    })));
    return json(res, 200, {
      ok: true, who: username, local: isBypass, admin,
      households: mine.map((h) => ({ id: h.id, label: h.label, owner: h.owner, members: h.members })),
      // Chosen for you only when there is nothing to choose between.
      household: isBypass ? 'sandbox' : only,
    });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const status = err instanceof ToolError || err instanceof SynologyError ? err.status : 500;
      if (status >= 500) console.error('[budget]', err);
      json(res, status, { error: (err as Error).message ?? 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/api/health') {
      // No household is named: health is about the process, not anyone's money.
      // The version and commit say which build is running, so a rebuild on the
      // NAS can be checked against GitHub without signing in.
      return json(res, 200, { ok: true, households: (await households.ids()).length, ...softwareVersion() });
    }

    // ── signing in ───────────────────────────────────────────────────────────
    if (path === '/api/auth/login' && req.method === 'POST') {
      // Ten wrong passwords a minute from one address, a hundred an hour; then
      // even the right one waits. DSM is the password check behind this, and
      // the whole origin may be on the internet (DEPLOY.md, TLS). A place is
      // taken before DSM is asked, so twenty at once cannot all be on their
      // way past the count, and given back unless the answer was a wrong password.
      const ip = clientIp(req);
      const at = Date.now();
      const tooMany = (wait: string) => new ToolError(`too many wrong sign-ins from here: wait ${wait} and try again`, 429);
      if (!wrongLoginsPerMinute.take(ip, at)) throw tooMany('a minute');
      if (!wrongLoginsPerHour.take(ip, at)) { wrongLoginsPerMinute.refund(ip, at); throw tooMany('an hour'); }
      let wrong = false;
      try {
        return await signIn(req, res);
      } catch (err) {
        wrong = err instanceof ToolError && err.status === 401;
        throw err;
      } finally {
        if (!wrong) {
          wrongLoginsPerMinute.refund(ip, at);
          wrongLoginsPerHour.refund(ip, at);
        }
      }
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      const token = readCookie(req.headers.cookie, COOKIE);
      const sid = sessions.get(token)?.sid ?? null;
      // Signed out here first, and answered, so a NAS that hangs cannot hold
      // anyone in for the ten seconds a DSM call may take.
      sessions.revoke(token);
      res.setHeader('set-cookie', clearedCookie());
      json(res, 200, { ok: true });
      // Then the DSM session is closed too, since the sid is a NAS-wide
      // credential that should not outlive the member's visit. Best effort and
      // unawaited; a failure is swallowed, not logged, because the sid is a
      // secret and the error would say nothing we can act on.
      if (sid) void dsm({ api: 'SYNO.API.Auth', version: AUTH_VERSION, method: 'logout', sid }).catch(() => {});
      return;
    }

    if (path === '/api/auth/check' && req.method === 'GET') {
      const session = sessions.get(readCookie(req.headers.cookie, COOKIE));
      if (!session) return json(res, 200, { authenticated: false });
      const mine = session.local ? [] : await households.forUser(session.who);
      return json(res, 200, {
        authenticated: true, who: session.who, local: session.local,
        admin: session.admin,
        household: session.household,
        households: mine.map((h) => ({ id: h.id, label: h.label, owner: h.owner, members: h.members })),
      });
    }

    // The guest door, before the gate and before the shell: its own cookie,
    // read here and nowhere else.
    if (path === '/book' || path.startsWith('/book/')) return book(req, res, path, url);

    // A phone's one-time link, also before the gate: the phone has no session,
    // and the code is the credential. Only a GET spends it.
    if (path.startsWith('/setup/')) {
      const code = path.slice('/setup/'.length);
      const entry = req.method === 'GET' ? phoneCodes.redeem(code) : req.method === 'HEAD' ? phoneCodes.peek(code) : null;
      if (!entry) return sendPage(res, 404, CODE_EXPIRED);
      // A HEAD is answered with the headers alone, so it builds and signs nothing.
      if (req.method === 'HEAD') return sendProfile(res, '', true);
      const profile = buildProfile({ member: entry.member, household: entry.household, dsmPublicUrl: entry.dsmPublicUrl });
      return sendProfile(res, await signedOrPlain(profile, profileCertDir()), false);
    }

    // The app shell, before the gate — the login page has to be reachable by
    // someone who is by definition not signed in yet.
    if (!path.startsWith('/api/')) return serveStatic(url.pathname, res);

    // A page left open across an upgrade names its build; one that is not this build is told to reload,
    // before any route runs. A caller that sends no build (the guest page, scripts) is never stale.
    const build = req.headers['x-hp-build'];
    if (typeof build === 'string' && build !== softwareVersion().version) return json(res, 409, { error: STALE, stale: true });

    // ── everything past here needs a session ─────────────────────────────────
    const { session, token } = sessionOf(req, sessions);
    const who = session.who;
    const isAdmin = session.admin;

    // ── households: mine, making one, choosing one ───────────────────────────
    if (path === '/api/households' && req.method === 'GET') {
      const mine = await households.forUser(who);
      return json(res, 200, {
        who, admin: isAdmin, current: session.household,
        households: mine.map((h) => ({
          id: h.id, label: h.label, owner: h.owner, members: h.members,
          youOwn: h.owner === who,
        })),
      });
    }

    if (path === '/api/households' && req.method === 'POST') {
      const body = (await readBody(req)) as { label?: string };
      const label = (body.label ?? '').trim();
      if (!label) throw new ToolError('a household needs a name');
      const made = await households.create(who, label);
      sessions.select(token, made.id);
      return json(res, 200, { id: made.id, label, owner: who });
    }

    if (path === '/api/households/select' && req.method === 'POST') {
      const body = (await readBody(req)) as { household?: string };
      const id = (body.household ?? '').trim();
      const mine = await households.forUser(who);
      if (!mine.some((h) => h.id === id)) throw new ToolError('you do not have access to that household', 403);
      sessions.select(token, id);
      return json(res, 200, { household: id });
    }

    // Removing a household for good. The checks run in this order, and only an
    // id that is one of `who`'s households ever reaches the directory: the
    // removal uses the Households class's own path for it, never the request's.
    if (path === '/api/households/remove' && req.method === 'POST') {
      if (session.local) throw new ToolError('the local sandbox has no household to remove', 409);
      const body = (await readBody(req)) as { household?: unknown; label?: unknown };
      const id = typeof body.household === 'string' ? body.household.trim() : '';
      const mine = await households.forUser(who);
      // The same answer as select: a stranger learns nothing about whether it exists.
      const target = isValidId(id) ? mine.find((h) => h.id === id) : undefined;
      if (!target) throw new ToolError('you do not have access to that household', 403);
      if (target.owner !== who) throw new ToolError('only the owner can remove a household', 403);
      // Against the label of the household the id names, never a search by label.
      if (body.label !== target.label) throw new ToolError("type the household's name exactly to remove it", 400);
      await households.remove(target.id);
      const closed = sessions.leave(target.id);
      console.log(`[budget] household ${target.id} removed by ${who}; ${closed} session${closed === 1 ? '' : 's'} closed`);
      return json(res, 200, { removed: target.id });
    }

    // ── backup and restore ───────────────────────────────────────────────────
    if (path === '/api/backup' && req.method === 'GET') {
      const active = await activeStore(session, households, devStore);
      const text = await readFile(active.path, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition':
          `attachment; filename="${session.household ?? 'household'}-backup.jsonl"`,
        'cache-control': 'no-store',
      });
      res.end(text);
      return;
    }

    if (path === '/api/restore/preview' && req.method === 'POST') {
      const body = (await readBody(req)) as { content?: string; scopes?: string[] };
      if (!body.content?.trim()) throw new ToolError('that file is empty');
      const backup = parseBackup(body.content);
      // Refused whole, before anything is worked out: read without the lines this
      // build cannot read, older or newer, it would be a different household.
      const unreadable = unreadableBackup(backup);
      if (unreadable) throw new ToolError(unreadable, 400);
      const scopes = restoreScopes(body.scopes);
      const active = await activeStore(session, households, devStore);
      const plan = planRestore(active.state, backup, scopes, await active.ids());
      return json(res, 200, {
        from: { label: backup.label, owner: backup.owner },
        available: backup.counts,
        unreadable: backup.skipped,
        selected: plan.counts,
        summary: plan.summary,
        collisions: plan.collisions,
        missingPrerequisites: plan.missingPrerequisites,
        canApply: plan.collisions.length === 0 && plan.missingPrerequisites.length === 0
          && plan.take.length > 0,
      });
    }

    if (path === '/api/restore' && req.method === 'POST') {
      const body = (await readBody(req)) as
        { content?: string; scopes?: string[]; asNewHousehold?: string };
      if (!body.content?.trim()) throw new ToolError('that file is empty');
      const backup = parseBackup(body.content);
      const unreadable = unreadableBackup(backup);
      if (unreadable) throw new ToolError(unreadable, 400);

      // A whole backup becomes a household of its own, owned by whoever holds
      // the file. Nothing is ever written over what is already there.
      if (body.asNewHousehold) {
        const made = await households.createFromLog(who, body.asNewHousehold.trim(),
          [...backup.events]);
        sessions.select(token, made.id);
        return json(res, 200, {
          id: made.id, events: made.store.state.eventCount, mode: 'new household', summary: made.summary,
        });
      }

      const active = await activeStore(session, households, devStore);
      const scopes = restoreScopes(body.scopes);
      const plan = planRestore(active.state, backup, scopes, await active.ids());
      const events = eventsToApply(plan); // throws on any collision — refuse, never merge
      // Adopted, not appended: these events already happened, and the person
      // pressing the button is not the person who spent the money.
      await active.adopt(events);
      // A backup from before 0.7.0 brings its shelves back; they are retired before any request reads them.
      await retireShelves(active);
      // planRestore takes no folder; should one ever come through, the registry knows it at once.
      if (session.household) rememberDocuments(session.household, active.state.documents);
      return json(res, 200, { restored: events.length, into: session.household, summary: plan.summary });
    }

    // ── admin: that households exist, never what is in them ──────────────────
    if (path === '/api/admin/households' && req.method === 'GET') {
      if (!isAdmin) throw new ToolError('not an administrator', 403);
      const all = await households.list();
      return json(res, 200, {
        admin: who,
        households: all.map((h) => {
          const folder = folderOf(h.id);
          return {
            id: h.id, label: h.label, owner: h.owner, memberCount: h.members.length,
            size: h.size, lastActivity: h.lastActivity,
            // Whether the admin may open it is membership like anyone else.
            yours: h.members.includes(who),
            // Where its documents live: a place, not what is in it.
            folder: folder ? `${folder.team}/${folder.folder}` : null,
          };
        }),
      });
    }

    // ── This NAS: what the NAS connects to, the admin's alone ──────────────
    //
    // Every answer but the accounts list is the page itself, worked out again.
    // No secret goes out: the view carries only whether each is set.
    if (path === '/api/connectors' || path.startsWith('/api/connectors/')) {
      if (!isAdmin) throw new ToolError('not an administrator', 403);
      const route = path.slice('/api/connectors/'.length);

      if (path === '/api/connectors' && req.method === 'GET') return json(res, 200, await connectorsNow(session.sid));

      if (route === 'accounts' && req.method === 'GET') {
        if (!session.sid) throw new ToolError('sign in again to list accounts; type the names instead', 409);
        const names = await listAccounts(session.sid);
        const members = new Set((await households.list()).flatMap((h) => h.members));
        return json(res, 200, { accounts: names.map((name) => ({ name, member: members.has(name) })) });
      }

      if (route === 'mail/test' && req.method === 'POST') {
        const to = (await bodyOf(req))['to'];
        if (!isEmail(to)) throw new ToolError('send the test to an email address');
        const smtp = mailWhileOff(resolvedEnv());
        if (!smtp) throw new ToolError('set up mail before testing it', 409);
        const at = new Date().toISOString();
        let result: { ok: boolean; words: string };
        try {
          await send(smtp, {
            to: to.trim(), subject: 'A test from Home Planner',
            text: 'This is the test sent from Settings › This NAS. Mail from Home Planner reaches this address.',
          }, 'Home Planner');
          result = { ok: true, words: 'sent' };
        } catch (err) {
          // A mail server may say back the login it refused: neither the user nor the password is kept.
          let words = err instanceof Error ? err.message : String(err);
          for (const secret of [smtp.pass, smtp.user]) if (secret) words = words.replaceAll(secret, '…');
          result = { ok: false, words };
        }
        await recordTest('mailTest', { at, to: to.trim(), ...result });
        return json(res, 200, await connectorsNow(session.sid));
      }

      if (route === 'claude/test' && req.method === 'POST') {
        if (claudeKey() === null) throw new ToolError('there is no key to test', 409);
        const at = new Date().toISOString();
        const r = await testClaude();
        const before = connectors().claudeTest?.worked;
        await recordTest('claudeTest', { at, ok: r.ok, words: r.words, ...(r.ok ? { worked: at } : before ? { worked: before } : {}) });
        return json(res, 200, await connectorsNow(session.sid));
      }

      const key = Object.hasOwn(CONNECTOR_SAVES, route) ? CONNECTOR_SAVES[route] : undefined;
      if (key && req.method === 'POST') {
        const change = connectorChange(key, connectorChangeIn(await bodyOf(req)), session.local ? null : who);
        await saveConnector(key, change, who);
        return json(res, 200, await connectorsNow(session.sid));
      }
      throw new ToolError('not found', 404);
    }

    // ── calendars: the NAS first, the household second ───────────────────────
    //
    // The sid is checked before anything asks which household is open. A
    // session with no DSM behind it (the sandbox, or one carried across a
    // restart) can do one useful thing, sign in again, and that is what it is
    // told, rather than "no household is open".
    if (path === '/api/calendars' || path.startsWith('/api/calendars/')) {
      const sid = requireSid(session);

      if (path === '/api/calendars' && req.method === 'GET') {
        // The list is the person's own, so it needs no household; which of
        // them the household uses does, when one is open. Membership is
        // asked first, before DSM is: a household this session can no longer
        // open (they were removed from it) is no household, not a failure.
        let store: Store | null = null;
        if (session.household) {
          try {
            store = await activeStore(session, households, devStore);
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
          }
        }
        const household = store?.state.calendar.household ?? null;
        const listed = await listCalendars(sid);
        // Only its maker's listing is sure to include it: missing there, it is gone. Every account has
        // its own default calendar, so an empty listing is an answer not understood, and proves nothing.
        if (store && household && session.household && !session.local && who === household.by
          && listed.length > 0 && !listed.some((c) => sameCalendar(c, household))) {
          await calendarLost(store, session.household, household);
        }
        return json(res, 200, {
          calendars: listed.map((c) => calendarView(c, household)),
          household,
          target: store?.state.calendar.target ?? null,
        });
      }

      const store = await activeStore(session, households, devStore);
      // Which calendar the household uses is the owner's choice, made here and not in replay
      // (old logs hold calendars made by members), and asked before the body is read.
      if (req.method === 'POST' && (path === '/api/calendars/household' || path === '/api/calendars/target')
        && who !== store.state.owner) {
        throw new ToolError(`only ${store.state.owner} can choose the household's calendar`, 403);
      }
      const body = req.method === 'POST' ? await readBody(req) : null;
      const calCtx: ToolContext = { store, who, today: todayInTz(zoneOf(store.state)), proposals, sid };

      if (path === '/api/calendars/household' && req.method === 'POST') {
        // `replace` is for a Household calendar that is gone from the NAS: a
        // new one, made by whoever asks, takes its place in the log.
        if ((body as { replace?: unknown } | null)?.replace === true) {
          await replaceHouseholdCalendar(calCtx, [...store.state.members]);
        } else {
          await ensureHouseholdCalendar(calCtx, [...store.state.members]);
        }
        return json(res, 200, await settingsView(store, who, await bookingNow(), openHousehold(session), session.admin));
      }

      if (path === '/api/calendars/household/name' && req.method === 'POST') {
        const raw = (body as { name?: unknown } | null)?.name;
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (!name) throw new ToolError('the Household calendar needs a name');
        if (name.length > 100) throw new ToolError('a calendar name is at most 100 characters');
        const household = store.state.calendar.household;
        if (!household) throw new ToolError('there is no Household calendar to rename yet');
        // The NAS first: the log names the calendar only once the NAS does.
        // Any member may ask; DSM decides whose sessions may rename it.
        try {
          await renameCalendar(sid, household, name);
        } catch (err) {
          // Said as a matter of who may only when it is one: DSM says not allowed, or
          // someone other than its maker was refused. Anything else is the NAS's own answer.
          const refusedOther = err instanceof SynologyError && !(err instanceof SessionLost) && err.code !== 0 && who !== household.by;
          if (err instanceof NotAllowed || refusedOther) {
            throw new ToolError(`only ${household.by}, who made the Household calendar, can rename it`);
          }
          throw err;
        }
        if (name !== household.name) await store.append(who, { op: 'calendar.household.rename', name });
        return json(res, 200, await settingsView(store, who, await bookingNow(), openHousehold(session), session.admin));
      }

      if (path === '/api/calendars/target' && req.method === 'POST') {
        const chosen = listedCalendar(await listCalendars(sid), calendarRefFrom(body));
        if (chosen.privilege !== 'RW') throw new ToolError(`plans cannot go on ${chosen.displayname}: it is read-only to you`);
        // The Household calendar is shared with every member already; any
        // other must be, by its owner, before plans can go on it.
        const household = store.state.calendar.household;
        if (!household || !sameCalendar(chosen, household)) {
          await sharedWithEveryone(sid, chosen, who, [...store.state.members]);
        }
        await store.append(who, { op: 'calendar.target', cal_id: chosen.cal_id, original_cal_id: chosen.original_cal_id });
        return json(res, 200, await settingsView(store, who, await bookingNow(), openHousehold(session), session.admin));
      }

      if (path === '/api/calendars/conflicts' && req.method === 'POST') {
        const asked = (body as { calendars?: unknown } | null)?.calendars;
        if (!Array.isArray(asked)) throw new ToolError('calendars must be a list');
        const listed = await listCalendars(sid);
        const calendars = [...new Map(asked.map((x) => {
          const c = listedCalendar(listed, calendarRefFrom(x));
          // The label is the NAS's name for it, not whatever the request said.
          return [c.cal_id, { cal_id: c.cal_id, original_cal_id: c.original_cal_id, label: c.displayname }] as const;
        })).values()];
        await store.append(who, { op: 'calendar.conflicts', calendars });
        return json(res, 200, await settingsView(store, who, await bookingNow(), openHousehold(session), session.admin));
      }

      throw new ToolError(`no route for ${req.method} ${path}`, 404);
    }

    const active = await activeStore(session, households, devStore);

    // ── setting up a phone, or a Mac ─────────────────────────────────────────
    if (path === '/api/phone-setup/code' && req.method === 'POST') {
      const body = (await readBody(req)) as { origin?: unknown } | null;
      const asked = setupAsked(body?.origin, true);
      const made = phoneCodes.issue({
        member: who, household: active.state.label, origin: asked.origin!, dsmPublicUrl: asked.dsmPublicUrl,
      });
      const qr = await QRCode.toString(made.url, { type: 'svg', margin: 1 });
      return json(res, 200, { code: made.code, url: made.url, expiresAt: new Date(made.expiresAt).toISOString(), qr });
    }

    if (path === '/api/phone-setup/profile' && req.method === 'GET') {
      const asked = setupAsked(null, false);
      const profile = buildProfile({ member: who, household: active.state.label, dsmPublicUrl: asked.dsmPublicUrl });
      return sendProfile(res, await signedOrPlain(profile, profileCertDir()), false);
    }

    // The Home Screen's QR is only the page's address, so it needs no code and no NAS address.
    if (path === '/api/phone-setup/home' && req.method === 'GET') {
      const origin = homeOrigin(url.searchParams.get('origin'));
      if (origin === null) throw new ToolError(NOT_HOME_ORIGIN);
      const link = homeLink(origin);
      return json(res, 200, { url: link, qr: await QRCode.toString(link, { type: 'svg', margin: 1 }) });
    }

    // The household's own zone, read per request: it decides which day "today" is,
    // and getting that wrong shifts a receipt across a month boundary.
    const tz = zoneOf(active.state);
    // Booking's mail rides on the context only in the household friends book
    // with: a decision on a guest's request is told to them before it is written.
    const bookingHere = await bookingNow();
    const booksHere = bookingHere.on && !session.local && session.household === bookingHere.config.household;
    // While booking is off, a request already on Today may still be declined (its guest mailed, if a
    // mail server is set) and never approved; the sandbox has no guests either way.
    const mail: BookingMail | null = booksHere ? { smtp: bookingHere.config.smtp, url: bookingHere.config.url, send }
      : !bookingHere.on && !session.local ? { smtp: mailWhileOff(resolvedEnv()), url: null, send, off: bookingOffWords(bookingHere.why) }
      : null;
    const ctx: ToolContext = {
      store: active, who, today: todayInTz(tz), proposals, sid: session.sid,
      ...(mail ? { mail } : {}),
      ...(session.local || !session.household ? {} : { household: session.household }),
    };
    // A change may have moved a plan's page: it follows once the answer is sent, and never holds it up.
    if (req.method !== 'GET') res.once('finish', () => schedulePages(ctx));
    // A move a restart cut short is picked up again by the first request with a NAS session, whatever it asks.
    else if (ctx.sid && ctx.household && movesLeft(active.state) > 0 && !resumed.has(active.path)) {
      resumed.add(active.path);
      res.once('finish', () => schedulePages(ctx));
    }

    // ── booking: which nights are taken, and why ─────────────────────────────
    //
    // Only in the household friends book with; anywhere else there is nothing
    // to show, and the sandbox has no guests.
    if (path === '/api/bookings/suggest' && req.method === 'POST') {
      if (!booksHere) throw new ToolError('not available', 404);
      const body = await bodyOf(req);
      if (typeof body['offer'] !== 'string' || !body['offer']) throw new ToolError('offer is required');
      const e = await suggest(ctx, body['offer'], { arrive: body['arrive'], depart: body['depart'], why: body['why'] });
      return json(res, 200, { id: e.id });
    }

    if (path === '/api/bookings/block' && req.method === 'POST') {
      if (!booksHere) throw new ToolError('not available', 404);
      const e = await blockNights(ctx, await bodyOf(req));
      return json(res, 200, { id: e.id });
    }

    const unblock = /^\/api\/bookings\/block\/([^/]+)$/.exec(path);
    if (unblock && req.method === 'DELETE') {
      if (!booksHere) throw new ToolError('not available', 404);
      const body = await bodyOf(req);
      const e = await unblockNights(ctx, segment(unblock[1]!, 'there is no such block'), body['why']);
      return json(res, 200, { id: e.id });
    }

    // ── the guest list ───────────────────────────────────────────────────────
    if (path === '/api/guests' && req.method === 'GET') {
      if (!booksHere) throw new ToolError('not available', 404);
      return json(res, 200, { guests: guestList(active.state) });
    }

    if (path === '/api/guests' && req.method === 'POST') {
      if (!booksHere) throw new ToolError('not available', 404);
      await allowGuest(ctx, await bodyOf(req));
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (path === '/api/guests/arrival' && req.method === 'POST') {
      if (!booksHere) throw new ToolError('not available', 404);
      const text = (await bodyOf(req))['text'];
      if (typeof text !== 'string') throw new ToolError('the arrival note is text');
      if (text.trim().length > ARRIVAL_MAX) throw new ToolError('keep the arrival note under 1,000 characters');
      await active.append(who, { op: 'guests.arrival', text: text.trim() });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    const guestPath = /^\/api\/guests\/([^/]+)$/.exec(path);
    if (guestPath && req.method === 'DELETE') {
      if (!booksHere) throw new ToolError('not available', 404);
      const body = await bodyOf(req);
      const key = await revokeGuest(ctx, segment(guestPath[1]!, 'that address is not on the list'), body['why']);
      // Off the list is signed out, everywhere, now: not only at their next request.
      guests.revokeEmail(key);
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (path === '/api/bookings/nights' && req.method === 'GET') {
      const now = await bookingNow();
      if (!now.on || session.local || session.household !== now.config.household) throw new ToolError('not available', 404);
      const month = monthParam(url);
      return json(res, 200, { month, nights: memberNights(active.state, { month, today: ctx.today }) });
    }

    // ── documents: the words of a briefing or an answer kept in Drive ────────
    //
    // Found among this household's own events, so another household's page is
    // not reachable by its id. The page is read with the caller's session; the
    // answer is the words alone, never the link or the sid.
    const docOf = /^\/api\/docs\/([^/]+)$/.exec(path);
    if (docOf && req.method === 'GET') {
      const id = segment(docOf[1]!, 'no such document');
      const e = (await active.since(null)).find((x) => x.id === id);
      if (!e || (e.op !== 'thread.briefing' && e.op !== 'thread.answer') || !e.doc) throw new ToolError('no such document', 404);
      requireSid(ctx);
      const page = await readDoc(ctx, currentDoc(active.state, e.doc));
      return json(res, 200, { text: e.op === 'thread.briefing' ? briefingBodyFrom(page) : answerTextFrom(page) });
    }

    // ── the Drive picker: where the household's documents live ───────────────
    //
    // Three steps that only look (a Team Folder, a folder in it, the checks) and
    // "Use this folder", which is the owner's. All of them are asked of the NAS
    // as the member, so each needs their sid.
    if (path === '/api/drive/team-folders' && req.method === 'GET') {
      return json(res, 200, { teams: await pickerTeams(requireSid(ctx)) });
    }

    if (path === '/api/drive/folders' && req.method === 'GET') {
      const sid = requireSid(ctx);
      const team = url.searchParams.get('team');
      if (typeof team !== 'string' || !team.trim()) throw new ToolError('choose a Team Folder');
      return json(res, 200, await pickerFolders(sid, team, active.state.label));
    }

    if ((path === '/api/drive/folder-check' || path === '/api/settings/documents') && req.method === 'POST') {
      const sid = requireSid(ctx);
      const household = ctx.household;
      if (!household) throw new NeedsDsm();
      // Looking is any member's; choosing is the owner's, said before the body is read.
      if (path === '/api/settings/documents' && who !== active.state.owner) {
        throw new ToolError(`only ${active.state.owner} can change this`, 403);
      }
      // One move at a time: a second change waits for the first, said before the NAS is asked anything.
      const moving = path === '/api/settings/documents' ? stillMoving(active.state) : null;
      if (moving) throw moving;
      const clean = cleanFolder(await bodyOf(req));
      if ('problem' in clean) throw new ToolError(clean.problem);
      if (path === '/api/drive/folder-check') {
        return json(res, 200, await checkFolder(sid, clean, { household, members: [...active.state.members] }));
      }
      await chooseFolder({ ...ctx, household }, clean);
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    // ── settings: the household's, and your own appearance ───────────────────
    //
    // Mostly lines in the household's log, so the sandbox has them too; the
    // one thing asked of the NAS is whether documents can go to Drive for you.
    if (path === '/api/settings' && req.method === 'GET') {
      await askIndexed(ctx, active.state, openHousehold(session));
      return json(res, 200, {
        ...await settingsView(active, who, await bookingNow(), openHousehold(session), session.admin),
        documents: await documentsStatus(ctx),
        // Shown at the foot of your own settings: which build this is.
        software: softwareVersion(),
      });
    }

    if (path === '/api/settings/areas' && req.method === 'POST') {
      const asked = ((await readBody(req)) as { areas?: unknown } | null)?.areas;
      if (!Array.isArray(asked) || asked.length === 0) {
        throw new ToolError(`areas must be a list of at least one name (for example ${DEFAULT_AREAS.join(', ')})`);
      }
      const areas = asked.map((a) => (typeof a === 'string' ? a.trim() : ''));
      if (areas.some((a) => !a)) throw new ToolError('every area needs a name');
      if (new Set(areas.map((a) => a.toLowerCase())).size !== areas.length) throw new ToolError('two areas have the same name');
      await active.append(who, { op: 'areas.set', areas });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (path === '/api/settings/areas/rename' && req.method === 'POST') {
      const body = (await readBody(req)) as { from?: unknown; to?: unknown } | null;
      const from = typeof body?.from === 'string' ? body.from.trim() : '';
      const to = typeof body?.to === 'string' ? body.to.trim() : '';
      if (!from) throw new ToolError('say which area to rename');
      if (!to) throw new ToolError('the area needs a new name');
      try {
        await active.append(who, { op: 'areas.rename', from, to });
      } catch (err) {
        // The fold knows the list: a name already used, or one that is not there, is the caller's to fix.
        if (err instanceof ReplayError) throw new ToolError(err.message.replace(/ \(event .*\)$/, ''), 400);
        throw err;
      }
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (/^\/api\/settings\/areas\/(add|remove|move)$/.test(path) && req.method === 'POST') {
      const kind = path.slice(path.lastIndexOf('/') + 1) as 'add' | 'remove' | 'move';
      const body = (await readBody(req)) as { area?: unknown; to?: unknown } | null;
      const area = typeof body?.area === 'string' ? body.area.trim() : '';
      if (!area) throw new ToolError('say which area');
      const known = active.state.settings.areas;
      if (kind === 'add') {
        const clash = known.find((a) => a.toLowerCase() === area.toLowerCase());
        if (clash !== undefined) throw new ToolError(`"${clash}" is already an area`);
      } else if (areaIndex(known, area) < 0) {
        throw new ToolError(`there is no area called ${area}`);
      }
      let e: NewEventShape;
      if (kind === 'move') {
        const to = body?.to;
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) throw new ToolError('where it moves to must be a whole number, zero or more');
        // Where it already stands is no change, and no line in the log.
        if (Math.min(to, known.length - 1) === areaIndex(known, area)) return json(res, 200, { areas: known });
        e = { op: 'areas.move', area, to };
      } else {
        e = { op: kind === 'add' ? 'areas.add' : 'areas.remove', area };
      }
      try {
        await active.append(who, e);
      } catch (err) {
        // A fold refusal (plans still in it, the last area, a name too long) is the caller's to fix.
        if (err instanceof ReplayError) throw new ToolError(err.message.replace(/ \(event .*\)$/, ''), 400);
        throw err;
      }
      return json(res, 200, { areas: active.state.settings.areas });
    }

    if (path === '/api/settings/links' && req.method === 'POST') {
      const asked = ((await readBody(req)) as { links?: unknown } | null)?.links;
      if (!Array.isArray(asked)) throw new ToolError('links must be a list');
      const links = asked.map((x) => {
        const l = x as { label?: unknown; url?: unknown } | null;
        const label = typeof l?.label === 'string' ? l.label.trim() : '';
        const url = typeof l?.url === 'string' ? l.url.trim() : '';
        if (!label) throw new ToolError('every link needs a label');
        // Only web addresses: the screen makes these into links, and a
        // javascript: one would run in the page of whoever clicked it.
        let parsed: URL | null = null;
        try { parsed = new URL(url); } catch { /* refused below */ }
        if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
          throw new ToolError(`${label}: a link must be an http or https address`);
        }
        return { label, url };
      });
      await active.append(who, { op: 'links.set', links });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    // The savings account, chosen from those imports have seen; null for none.
    if (path === '/api/settings/savings' && req.method === 'POST') {
      const asked = ((await readBody(req)) as { account?: unknown } | null)?.account;
      if (asked !== null && typeof asked !== 'string') throw new ToolError('account is the one the sinking funds live in, or null for none');
      const account = asked === null ? null : asked.trim();
      if (account !== null && !savingsSettings(active.state).accounts.some((a) => a.account === account)) {
        throw new ToolError(`no import has seen an account ${account}: import its statement first`);
      }
      await active.append(who, { op: 'savings.account', account });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    // What Savings shows, typed off the bank's page: today, unless a day gone by is given.
    if (path === '/api/settings/savings/balance' && req.method === 'POST') {
      const body = (await readBody(req)) as { cents?: unknown; asOf?: unknown } | null;
      const account = active.state.savings.account;
      if (!account) throw new ToolError('choose the savings account first', 409);
      const amount = body?.cents;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) throw new ToolError('the balance is in whole cents');
      const asOf = body?.asOf ?? ctx.today;
      if (!isDay(asOf) || asOf > ctx.today) throw new ToolError('a balance is for today or a day gone by, YYYY-MM-DD');
      const written = await active.append(who, { op: 'account.balance', account, cents: cents(amount), asOf, source: 'typed' });
      await raiseSavingsCardFor(ctx, written);
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (path === '/api/settings/appearance' && req.method === 'POST') {
      const body = (await readBody(req)) as { scheme?: unknown; mode?: unknown } | null;
      const scheme = body?.scheme;
      const mode = body?.mode;
      if (typeof scheme !== 'string' || !SCHEMES.has(scheme)) {
        throw new ToolError(`scheme must be one of ${[...SCHEMES].join(', ')}`);
      }
      if (typeof mode !== 'string' || !MODES.has(mode)) {
        throw new ToolError(`mode must be one of ${[...MODES].join(', ')}`);
      }
      await active.append(who, { op: 'scheme.set', scheme: scheme as Scheme, mode: mode as Mode });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    // The zone the household's days are read in: the owner's choice, and only a name ICU knows.
    if (path === '/api/settings/zone' && req.method === 'POST') {
      if (who !== active.state.owner) throw new ToolError(`only ${active.state.owner} can change this`, 403);
      const zone = ((await readBody(req)) as { zone?: unknown } | null)?.zone;
      if (typeof zone !== 'string' || !zone.trim()) throw new ToolError('a time zone is a name such as America/Denver');
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone.trim() });
      } catch {
        throw new ToolError(`${zone.trim()} is not a time zone this server knows`);
      }
      await active.append(who, { op: 'household.zone', zone: zone.trim() });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    // Booking: the owner's switch, on for one household at a time and held while guests are waiting or staying.
    if (path === '/api/settings/booking' && req.method === 'POST') {
      if (who !== active.state.owner) throw new ToolError(`only ${active.state.owner} can change this`, 403);
      const on = ((await readBody(req)) as { on?: unknown } | null)?.on;
      if (typeof on !== 'boolean') throw new ToolError('booking is on or off: send { on: true } or { on: false }');
      const here = openHousehold(session);
      if (here === null) throw new ToolError('friends book with a household, not the sandbox', 409);
      await switchBooking(active, here, { who, admin: session.admin }, on);
      return json(res, 200, await settingsView(active, who, await bookingNow(), here, session.admin));
    }

    // The model that suggests envelopes: the owner's choice, from the list Settings offers; null for the deployment's, else the default.
    if (path === '/api/settings/model' && req.method === 'POST') {
      if (who !== active.state.owner) throw new ToolError(`only ${active.state.owner} can change this`, 403);
      const model = ((await readBody(req)) as { model?: unknown } | null)?.model;
      if (model !== null && (typeof model !== 'string' || !modelChoices().some((c) => c.id === model))) {
        throw new ToolError('choose one of the models offered');
      }
      await active.append(who, { op: 'envelopes.model', model });
      return json(res, 200, await settingsView(active, who, bookingHere, openHousehold(session), session.admin));
    }

    if (path === '/api/whoami' && req.method === 'GET') {
      return json(res, 200, {
        who, today: ctx.today, timeZone: tz, sandbox: session.local, admin: isAdmin,
        // Whether "Ask Claude" can work here. Notes and the thread do either way.
        claude: claudeConfigured(),
        household: {
          id: session.household, label: active.state.label,
          owner: active.state.owner, members: [...active.state.members],
          youOwn: active.state.owner === who,
        },
      });
    }

    // ── import ───────────────────────────────────────────────────────────────
    //
    // Receipts are how money leaves an envelope, so this is the one route that
    // adds facts rather than opinions. It writes nothing on its own: the preview
    // says what would land, and committing goes through the same approval path
    // as everything else.
    if (path === '/api/import/preview' && req.method === 'POST') {
      const body = (await readBody(req)) as { filename?: string; content?: string };
      if (!body.content?.trim()) throw new ToolError('the file is empty');

      const parsed = parse(body.content);
      const state = active.state;

      // What the ledger already holds, keyed the same way. Replay dedupes on id
      // alone, so this is where a re-imported statement is actually caught.
      const seen = new Set<string>();
      for (const t of state.txns.values()) seen.add(t.dedupeKey);

      const liveOrNull = (e: SortedInto | null): SortedInto | null => (isSpend(e) && !state.envelopes.has(e) ? null : e);
      const fresh: Txn[] = [];
      const withinFile = new Set<string>();
      let duplicates = 0;
      for (const r of parsed.rows) {
        const key = dedupeKey(r);
        if (seen.has(key) || withinFile.has(key)) { duplicates++; continue; }
        withinFile.add(key);
        fresh.push({
          // The key is the id: one receipt, one identity, and re-running the
          // same file cannot produce a second copy even if this route is
          // called twice.
          id: key,
          date: r.date,
          payee: r.payee,
          ...(r.memo ? { memo: r.memo } : {}),
          amount: r.amount,
          account: r.account,
          dedupeKey: key,
          // Rules first: free, exact, and they run before anything is asked of
          // a person or a model. A rule naming an envelope that is not here
          // sorts nothing: the receipt lands in To sort.
          envelope: liveOrNull(byRule(state.rules, r)),
        });
      }

      // A split rule marks a row for dividing, not for filing: it is not "ruled".
      const ruled = fresh.filter((t) => t.envelope !== null && t.envelope !== SPLIT).length;
      const toDivide = fresh.filter((t) => t.envelope === SPLIT).length;
      // What the picker offers: one list, the same for every row.
      const options = pickerOptions(state);
      // Whatever the rules left, Haiku suggests; a person still accepts each one.
      const { suggested, error } = await suggestForRows(state, fresh);
      return json(res, 200, {
        filename: body.filename ?? 'upload',
        format: parsed.format,
        found: parsed.rows.length,
        duplicates,
        skipped: parsed.skipped,
        ruled,
        toDivide,
        needsSorting: fresh.length - ruled,
        options,
        // What each statement says its account held, recorded on commit.
        balances: parsed.balances.map((b) => ({ account: b.account, cents: b.amount, exact: fmtExact(b.amount), asOf: b.asOf })),
        // A CSV carries no balance: with a savings account chosen, Import asks what it shows today.
        askSavings: parsed.format === 'csv' && state.savings.account !== null,
        ...(error ? { suggestError: error } : {}),
        rows: fresh.map((t) => {
          const s = suggested.get(t.id);
          return {
            id: t.id, date: t.date, payee: t.payee, amount: fmtExact(t.amount),
            amountCents: t.amount, envelope: t.envelope, account: t.account,
            ...(s ? { suggested: s.value, confidence: s.confidence,
                      ...(s.rule ? { rule: s.rule } : {}), ...(s.parts ? { parts: [...s.parts] } : {}) } : {}),
          };
        }),
      });
    }

    if (path === '/api/import/commit' && req.method === 'POST') {
      const body = (await readBody(req)) as
        { rows?: { id: string; date: string; payee: string; amountCents: number;
                   account?: string; envelope?: string | null; suggestedBy?: string;
                   split?: { envelope: string; amountCents: number }[] }[]; source?: string;
          balances?: { account?: unknown; cents?: unknown; asOf?: unknown }[]; savingsToday?: unknown };
      const balances = balanceEvents(active.state, body.balances, body.savingsToday, ctx.today);
      if (!body.rows?.length && !balances.length) throw new ToolError('nothing to import');

      const state = active.state;
      const seen = new Set<string>();
      for (const t of state.txns.values()) seen.add(t.dedupeKey);
      // A live envelope, or money that is not spending.
      const exists = (e: string) => state.envelopes.has(e) || !isSpend(e);

      // Every row is checked before anything is appended, so one bad split
      // refuses the whole import rather than landing half of it.
      const txns: Txn[] = [];
      const splits: NewEvent[] = [];
      for (const r of body.rows ?? []) {
        if (!r.id || seen.has(r.id)) continue; // checked again: the preview may be stale
        if (r.envelope === SPLIT) {
          // The client sends null for a row nobody divided; __split with no parts is a client fault.
          if (!Array.isArray(r.split) || !r.split.length) throw new ToolError(`${r.payee} is marked to divide but is not divided`);
          const amount = cents(r.amountCents);
          // Whole cents only, as the tool does: checkParts refuses a stray fraction instead of rounding it.
          const parts: SplitPart[] = r.split.map((p) => {
            if (!p || typeof p.envelope !== 'string' || typeof p.amountCents !== 'number') {
              throw new ToolError(`${r.payee} has a part with no envelope or amount`);
            }
            return {
              envelope: p.envelope,
              amount: Number.isInteger(p.amountCents) ? cents(p.amountCents) : p.amountCents as Cents,
            };
          });
          const problem = splitProblem(parts, amount, state.envelopes, (e) => `no envelope ${e}`);
          if (problem) throw new ToolError(problem);
          // The receipt arrives undivided and its split follows in the same batch.
          txns.push({
            id: r.id, date: r.date, payee: r.payee, amount,
            ...(r.account ? { account: r.account } : {}),
            dedupeKey: r.id, envelope: null,
          });
          splits.push({ op: 'txn.split', txn: r.id, parts });
          continue;
        }
        if (r.envelope && !exists(r.envelope)) throw new ToolError(`no envelope ${r.envelope}`);
        txns.push({
          id: r.id, date: r.date, payee: r.payee, amount: cents(r.amountCents),
          ...(r.account ? { account: r.account } : {}),
          dedupeKey: r.id, envelope: r.envelope ?? null,
          // Recorded only when Claude suggested it and a person kept it.
          ...(r.suggestedBy === 'claude' && r.envelope ? { suggestedBy: 'claude' as const } : {}),
        });
      }
      if (!txns.length && !balances.length) return json(res, 200, { added: 0, note: 'every row was already in the ledger' });

      // The receipts, their splits and the balances in one write: a statement is read whole.
      const written = await active.append(who, [
        ...(txns.length ? [{ op: 'txn.add' as const, txns, source: body.source ?? 'upload' }] : []),
        ...splits,
        ...balances,
      ]);
      await raiseSavingsCardFor(ctx, written);
      // Read after the append: a divided receipt's envelope is __split, so it counts as sorted.
      return json(res, 200, {
        ...(txns.length ? {} : { note: 'every row was already in the ledger' }),
        balances: balances.length,
        added: txns.length,
        divided: splits.length,
        sorted: txns.filter((t) => active.state.txns.get(t.id)?.envelope != null).length,
        // Everything To sort holds now, this import's and what was there before.
        toSort: toSort(active.state).count,
      });
    }

    // Suggestions for receipts To sort holds with no envelope, and the picker's
    // one list. Read-only: accepting one is a sort_receipts write.
    if (path === '/api/match' && req.method === 'POST') {
      const body = (await readBody(req)) as { txnIds?: string[] };
      const state = active.state;
      // What To sort holds, a receipt whose envelope was removed in a month not closed among them; never a split,
      // which To sort shows with its parts and whose missing part is chosen there.
      const open = (t: Txn) => t.envelope !== SPLIT && inToSort(state, t);
      const rows = (body.txnIds ?? []).flatMap((id) => {
        const t = state.txns.get(id);
        return t && open(t)
          ? [{ id: t.id, payee: t.payee, ...(t.memo ? { memo: t.memo } : {}), envelope: null }] : [];
      });
      const { suggested, toDivide, error } = await suggestForRows(state, rows);
      // Every open receipt a split rule covers, named or not: the queue asks with
      // no ids on load, so nothing goes to Claude, and still learns what to divide.
      for (const t of state.txns.values()) {
        if (open(t) && byRule(state.rules, t) === SPLIT) toDivide.add(t.id);
      }
      return json(res, 200, {
        options: pickerOptions(state),
        suggestions: Object.fromEntries([...suggested].map(([id, x]) => [id, {
          choice: x.value, ...(x.rule ? { rule: x.rule } : {}), ...(x.parts ? { parts: [...x.parts] } : {}),
        }])),
        toDivide: [...toDivide],
        ...(error ? { suggestError: error } : {}),
      });
    }

    if (path === '/api/budget' && req.method === 'GET') {
      const state = active.state;
      // The income most recently recorded. Opening a month needs a figure and it
      // is a decision, not a default — but offering the last one you used beats
      // making someone look it up.
      const months = openMonths(state);
      const latest = months.at(-1);
      return json(res, 200, {
        thisMonth: ctx.today.slice(0, 7),
        lastIncomeExact: latest ? fmtExact(state.months.get(latest)!.income) : null,
        location: state.location,
        envelopes: state.envelopes.size,
        months,
        started: firstRun(state, ctx.today).started,
      });
    }

    if (path === '/api/budget/first-run' && req.method === 'GET') {
      return json(res, 200, firstRun(active.state, ctx.today));
    }

    // ── sharing ──────────────────────────────────────────────────────────────
    if (path === '/api/members' && req.method === 'POST') {
      const body = (await readBody(req)) as { member?: string; why?: string };
      const member = (body.member ?? '').trim().toLowerCase();
      if (!member) throw new ToolError('member is required');
      const allowed = allowedUsers();
      if (allowed.length && !allowed.includes(member)) {
        throw new ToolError(`${member} is not permitted to sign in to this server`, 400);
      }
      if (active.state.owner !== who) throw new ToolError('only the owner can share the household', 403);
      await active.append(who, { op: 'member.add', member, why: body.why?.trim() || 'shared the household' });
      // Shares the Household calendar with them now, if `who` made it; best effort.
      await reshareHousehold(ctx);
      return json(res, 200, { members: [...active.state.members] });
    }

    if (path === '/api/members' && req.method === 'DELETE') {
      const body = (await readBody(req)) as { member?: string; why?: string };
      const member = (body.member ?? '').trim().toLowerCase();
      if (active.state.owner !== who) throw new ToolError('only the owner can change sharing', 403);
      await active.append(who, { op: 'member.remove', member, why: body.why?.trim() || 'removed access' });
      // Unshares the Household calendar from them now, if `who` made it; best effort.
      await reshareHousehold(ctx);
      return json(res, 200, { members: [...active.state.members] });
    }

    if (path === '/api/tools' && req.method === 'GET') {
      return json(res, 200, { tools: toolSchemas() });
    }

    if (path === '/api/commit' && req.method === 'POST') {
      const body = (await readBody(req)) as { proposalId?: string };
      if (!body.proposalId) throw new ToolError('proposalId is required');
      const result = await commit(body.proposalId, ctx);
      return json(res, 200, {
        summary: result.summary,
        committed: result.committed.map((e) => ({ id: e.id, op: e.op, at: e.at, who: e.who })),
        lastEventId: active.state.lastEventId,
      });
    }

    // ── the thread ───────────────────────────────────────────────────────────
    if (path === '/api/thread' && req.method === 'GET') {
      const q = threadQuery(url, active.state);
      const started = firstRun(active.state, ctx.today).started;
      // Opening a day by its date or an id it holds reads the record and writes nothing: no briefing, no drift check.
      if (q.day !== undefined || q.at !== undefined) {
        const found = await threadDay(active, { who, today: ctx.today, ...q.base, ...(q.day !== undefined ? { day: q.day } : {}), ...(q.at !== undefined ? { at: q.at } : {}) });
        if (!found) throw new ToolError('no day shows that', 404);
        return json(res, 200, found);
      }
      const noting = url.searchParams.get('quiet') !== '1';
      // A budget whose month is not open yet has nothing to brief on, which
      // is not a reason to hide the thread; the page says so.
      const noOpenMonth = started && !active.state.months.has(ctx.today.slice(0, 7));
      if (noting) {
        // The day opens with the household's briefing: the money, the plans and
        // the Household calendar, one for every member. A calendar that cannot be
        // read is a line in it. Should the briefing itself fail, the budget
        // still gets its own section, as before there was a household one.
        try {
          await ensureHousehold(active, { who, today: ctx.today, sid: ctx.sid, tz, ...(ctx.household !== undefined ? { household: ctx.household } : {}) });
        } catch (err) {
          console.warn(`[briefing] the household's briefing was not written: ${(err as Error).message}`);
          // A refusal is Claude's answer for the day; asking it again for the budget would only be refused again.
          if (active.state.months.has(ctx.today.slice(0, 7)) && !(err instanceof ClaudeRefused)) {
            try {
              await ensureSection(active, { who, today: ctx.today });
            } catch (e2) {
              if (!(e2 instanceof ToolError && e2.status === 409)) throw e2;
            }
          }
        }
        // Then the calendar, and the plans' pages in Drive: a plan's event changed
        // on someone's phone, or its page edited in Drive, is a card on the page.
        // At most every ten minutes, with a NAS session; and never the reason
        // Today fails to load.
        try {
          await checkDriftNowAndThen(ctx);
          await checkPagesNowAndThen(ctx);
        } catch (err) {
          console.warn(`[calendar] looking for changes on the calendar or in Drive failed: ${(err as Error).message}`);
        }
        // Pages left behind (Drive was down, or the change came with no NAS session) catch up.
        schedulePages(ctx);
        // A cancelled stay still on the calendar with no card asking about it gets one. Never stops the page.
        if (active.state.stays.size) {
          try {
            await raiseReleaseCards(ctx);
          } catch (err) {
            console.warn(`[booking] looking for cancelled stays failed: ${(err as Error).message}`);
          }
        }
      }
      return json(res, 200, {
        ...(started ? {} : { notStarted: true }),
        ...(noOpenMonth ? { noOpenMonth: true } : {}),
        ...await thread(active, { who, today: ctx.today, ...q.base,
          ...(q.through !== undefined ? { through: q.through } : {}),
          ...(q.open !== undefined ? { open: q.open } : {}) }),
      });
    }

    // Yours, beside the shared thread: what the briefing was written from, as
    // each member has it. The calendar part never fails the page; a session
    // with no NAS behind it is asked to sign in again, in the rail.
    if (path === '/api/today' && req.method === 'GET') {
      // Asks Drive whether the Team Folder is one, for this session, so what follows writes or stays inline.
      if (ctx.sid) await documentsStatus(ctx);
      const home = active.state.documents.folder;
      return json(res, 200, {
        calendar: await todayEvents(ctx),
        plans: plansRail(ctx, await active.since(null), tz),
        money: moneyRail(ctx),
        // What is not set up yet, worked out on this load and written nowhere.
        // This NAS's rows without asking Drive, whose row never counts here.
        setup: setupNotices({
          state: active.state, who, admin: isAdmin, sandbox: session.local, env: process.env,
          teamFolder: ctx.sid && home ? teamFolderKnown(ctx.sid, home.team) : null,
          failures: moveFailures(active.path),
          adminRows: isAdmin && !session.local ? needsAdmin((await connectorsNow(null)).rows) : [],
          rowName: (id) => ROW_NAME[id],
          // Only an administrator is shown it, so nobody else costs a read of the certificate.
          signing: isAdmin && !session.local ? (await loadSigner(profileCertDir())).status : { signed: false, reason: 'no-directory' },
        }),
        // Envelopes still needing a figure, and those short, this month.
        budget: budgetNotices(active.state, ctx.today),
      });
    }

    if (path === '/api/thread/note' && req.method === 'POST') {
      const body = (await readBody(req)) as { text?: string };
      return json(res, 200, { event: await note(ctx, body.text ?? '') });
    }

    if (path === '/api/thread/ask' && req.method === 'POST') {
      const body = (await readBody(req)) as { question?: string };
      try {
        return json(res, 200, await askInThread(ctx, body.question ?? ''));
      } catch (err) {
        // A classifier decline is Claude's answer, not a fault in the budget.
        if (err instanceof ClaudeRefused) throw new ToolError(err.message, 422);
        throw err;
      }
    }

    if (path === '/api/thread/decide' && req.method === 'POST') {
      const body = (await readBody(req)) as { offer?: string; decision?: string; why?: string; args?: Record<string, unknown> };
      if (!body.offer) throw new ToolError('offer is required');
      if (body.decision !== 'approved' && body.decision !== 'declined' && body.decision !== 'snoozed') {
        throw new ToolError('decision must be approved, declined or snoozed');
      }
      // `args` is what was chosen on approving (a drift's choice); decide says what may be.
      const written = await decide(ctx, body.offer, body.decision, body.why, body.args);
      return json(res, 200, { committed: written.map((e) => ({ id: e.id, op: e.op, at: e.at, who: e.who })) });
    }

    if (path === '/api/thread/refresh' && req.method === 'POST') {
      const body = (await readBody(req)) as { offer?: string };
      if (!body.offer) throw new ToolError('offer is required');
      return json(res, 200, { offer: await refresh(ctx, body.offer) });
    }

    if (path === '/api/thread/adjust' && req.method === 'POST') {
      const body = (await readBody(req)) as { offer?: string; args?: Record<string, unknown> };
      if (!body.offer) throw new ToolError('offer is required');
      return json(res, 200, { offer: await adjust(ctx, body.offer, body.args ?? {}) });
    }

    if (path === '/api/thread/seen' && req.method === 'POST') {
      const body = (await readBody(req)) as { event?: string };
      if (!body.event) throw new ToolError('event is required');
      await active.append(who, { op: 'flag.seen', event: body.event });
      return json(res, 200, { ok: true });
    }

    // The Calendar screen's week. Like Today's rail, the NAS never fails it:
    // a session without one still sees the plans' due dates, and a line saying why.
    if (path === '/api/calendar' && req.method === 'GET') {
      const window = weekWindow(url.searchParams.get('start'), url.searchParams.get('end'));
      const week = await weekEvents(ctx, window);
      return json(res, 200, { ...week, money: calendarMoney(ctx.store.state, { from: window.start, to: addDays(window.end, -1), today: ctx.today }) });
    }

    // Look now, without waiting for Today's ten minutes: needs a NAS session.
    if (path === '/api/calendar/check' && req.method === 'POST') {
      requireSid(ctx);
      const found = await checkDrift(ctx);
      return json(res, 200, { drifts: found.filter((e) => e.op === 'calendar.drift').map((e) => e.id) });
    }

    // The Calendar's New event form. A member's Save is the decision, so none of
    // these is a proposal; the NAS is written first and the log after it.
    if (path === '/api/calendar/conflicts' && req.method === 'POST') {
      return json(res, 200, await formConflicts(ctx, await readBody(req)));
    }
    if (path === '/api/calendar/events' && req.method === 'POST') {
      return json(res, 200, { appointment: await saveNewEvent(ctx, await readBody(req)) });
    }
    const eventMatch = /^\/api\/calendar\/events\/([^/]+)$/.exec(path);
    if (eventMatch && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = /^\d+$/.test(eventMatch[1]!) ? Number(eventMatch[1]) : NaN;
      if (req.method === 'POST') await changeEvent(ctx, id, await readBody(req));
      else await removeEvent(ctx, id);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/briefing/read' && req.method === 'POST') {
      const body = (await readBody(req)) as { upTo?: string };
      await markRead(active, who, body.upTo ?? active.state.lastEventId);
      return json(res, 200, { who, upTo: active.state.readCursor.get(who) ?? null });
    }

    // One search over the household: Drive for its documents, with the
    // member's own session, and the log for the rest. Drive not answering is
    // `documents: 'not searched'`, never a failure.
    if (path === '/api/search' && req.method === 'GET') {
      const words = searchWords(url.searchParams.get('q'));
      const q = threadQuery(url, active.state);
      return json(res, 200, await searchRecord(ctx, words, q.base));
    }

    // ── contacts: the household's address book, on the NAS ───────────────────
    //
    // Read with the member's own DSM session, and only after membership is
    // checked: a stranger is a 403, and a session with no DSM behind it (the
    // sandbox, or one carried over a restart) is told to sign in again.
    if (path === '/api/contacts' && req.method === 'GET') {
      const sid = requireSid(ctx);
      const found = await searchContacts(sid, url.searchParams.get('q') ?? '');
      return json(res, 200, {
        contacts: found.sort((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, CONTACTS_LISTED),
      });
    }
    const contactMatch = /^\/api\/contacts\/([^/]+)$/.exec(path);
    if (contactMatch && req.method === 'GET') {
      if (!/^\d+$/.test(contactMatch[1]!)) throw new ToolError('a contact id is a whole number');
      return json(res, 200, { contact: await getContact(requireSid(ctx), Number(contactMatch[1])) });
    }
    if (path === '/api/contacts' && req.method === 'POST') {
      // A proposal, never a direct write: someone new in the address book is
      // the member's to accept.
      const args = (await readBody(req)) as Record<string, unknown>;
      return json(res, 200, { proposal: await runTool(toolByName.get('create_contact')!, args, ctx) });
    }

    // ── plans ────────────────────────────────────────────────────────────────
    //
    // Not money, so a member's edit is written directly. Every route here uses
    // the ctx built above, so membership has already been checked.
    if (path === '/api/plans' && req.method === 'GET') {
      // An older page's words are refused whole, so it reloads rather than reads a board it cannot draw.
      if (url.searchParams.has('filter') || url.searchParams.has('showDone')) throw new ToolError(STALE, 400);
      const pressed = url.searchParams.get('who') || 'everyone';
      if (pressed !== 'everyone' && !active.state.members.has(pressed)) {
        throw new ToolError('who must be a member of this household, or everyone');
      }
      const goal = url.searchParams.get('goal') || null;
      const events = await active.since(null);
      const seen = board(active.state, events, { who: pressed, goal, today: ctx.today, tz });
      // Only here does a member with nothing in view fall back to everyone, and the answer says so.
      const empty = !seen.rows.some((r) => r.plans.length > 0 || r.done.length > 0);
      return json(res, 200, pressed !== 'everyone' && empty
        ? board(active.state, events, { who: 'everyone', goal, today: ctx.today, tz })
        : seen);
    }

    if (path === '/api/plans' && req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, any>;
      return json(res, 200, { plan: await createPlan(ctx, pick(body, ['title', 'area', 'owner', 'goal', 'parent']) as any) });
    }

    // A goal is the household's, not a plan's: renamed or removed for every plan that carries it.
    if (path === '/api/goals/rename' && req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      return json(res, 200, { plans: await renameGoal(ctx, body['from'], body['to']) });
    }
    if (path === '/api/goals/remove' && req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      return json(res, 200, { plans: await removeGoal(ctx, body['goal']) });
    }

    const planMatch = /^\/api\/plans\/([^/]+)(?:\/(state|ask|ask-to-take|hand|goal|answer|checklist|due|block|calendar|contact|note|attach|files)(?:\/([^/]+))?)?$/.exec(path);
    if (planMatch) {
      const [, rawId, sub, rawKey] = planMatch;
      const id = decoded(rawId!);
      const key = rawKey === undefined ? undefined : decoded(rawKey);
      const route = `${req.method} ${sub ?? ''}${key === undefined ? '' : '/:key'}`;

      if (route === 'GET ') {
        const view = card(active.state, await active.since(null), id, { who, today: ctx.today, tz });
        schedulePages(ctx, id);
        return json(res, 200, view);
      }
      if (route === 'DELETE ') {
        const body = (await readBody(req)) as { why: string };
        await removePlan(ctx, id, body.why);
        return json(res, 200, { ok: true });
      }

      // Files: not JSON, so before the body is read as JSON. Each is asked in
      // the order that costs least: the plan, whether files are on at all,
      // and the NAS session, all before a byte of an upload is read.
      const fileCtx: FileContext = { ...ctx, household: session.household ?? 'sandbox' };
      if (route === 'POST attach') {
        if (!active.state.plans.get(id) || active.state.plans.get(id)!.removed) throw new ToolError(`no such plan: ${id}`, 404);
        if (!active.state.documents.folder) throw new ToolError(filesOff(active.state.owner), 409);
        requireSid(ctx);
        return json(res, 200, { plan: await attach(fileCtx, id, await readUpload(req, res)) });
      }
      if (route === 'GET files/:key') {
        const file = await readAttachment(fileCtx, id, key!);
        return sendFile(res, file.name, file.bytes);
      }

      const body = (await readBody(req)) as Record<string, any>;
      switch (route) {
        case 'POST ': {
          const { estimateCents, ...rest } = body;
          return json(res, 200, { plan: await updatePlan(ctx, id, {
            ...pick(rest, ['title', 'area', 'chips', 'notes', 'envelope']),
            ...(estimateCents !== undefined ? { estimate: estimateCents } : {}),
          }) });
        }
        case 'POST state':
          return json(res, 200, { plan: await setState(ctx, id, body['state']) });
        case 'POST ask-to-take':
          // Nobody is asked to take a plan any more: a page from before 0.7.0 is told to reload.
          throw new ToolError(STALE, 410);
        case 'POST hand':
          return json(res, 200, { plan: await handPlan(ctx, id, body['to'], body['why']) });
        case 'POST goal':
          if (!('goal' in body)) throw new ToolError('goal is required: a name, or null');
          return json(res, 200, { plan: await setGoal(ctx, id, body['goal']) });
        case 'POST ask': {
          if (body['to'] !== undefined || body['why'] !== undefined) {
            throw new ToolError('to hand it to someone, use /hand with to');
          }
          if (typeof body['question'] !== 'string') throw new ToolError('question is required');
          try {
            return json(res, 200, await askInThread(ctx, body['question'], id));
          } catch (err) {
            if (err instanceof ClaudeRefused) throw new ToolError(err.message, 422);
            throw err;
          }
        }
        case 'POST answer':
          return json(res, 200, { plan: await answerAsk(ctx, id, body['answer'], body['why']) });
        case 'POST checklist':
          return json(res, 200, { plan: await setChecklist(ctx, id, body['items']) });
        case 'POST due':
          if (!('due' in body)) throw new ToolError('due is required: a date as YYYY-MM-DD, or null');
          return json(res, 200, await setDue(ctx, id, body['due']));
        case 'POST block':
          return json(res, 200, await addBlock(ctx, id, body['start'], body['end']));
        case 'DELETE block/:key':
          return json(res, 200, await removeBlock(ctx, id, key!, body['why']));
        case 'POST calendar':
          return json(res, 200, await putOnCalendar(ctx, id));
        case 'POST contact':
          return json(res, 200, { plan: await linkContact(ctx, id, pick(body, ['contact_id', 'addressbook_id', 'display']) as any) });
        case 'DELETE contact/:key': {
          if (!/^\d+$/.test(key!)) throw new ToolError('contact_id must be a whole number');
          return json(res, 200, { plan: await unlinkContact(ctx, id, Number(key)) });
        }
        case 'POST note': {
          if (typeof body['text'] !== 'string') throw new ToolError('text is required');
          return json(res, 200, { event: await note(ctx, body['text'], id) });
        }
        case 'DELETE files/:key':
          return json(res, 200, { plan: await detach(ctx, id, key!, body['why']) });
      }
    }

    const toolMatch = /^\/api\/tools\/([\w.]+)$/.exec(path);
    if (toolMatch && req.method === 'POST') {
      const tool = toolByName.get(toolMatch[1]!);
      if (!tool) throw new ToolError(`no tool named ${toolMatch[1]}`, 404);
      // A drift is settled on its card, where approving it goes through decide (one approval at a time);
      // a guest's request is theirs to raise, and answered on its card too.
      if (tool.name === 'resolve_drift') throw new ToolError('a change on the calendar is not proposed here: answer it from its card');
      if (CARD_ONLY.has(tool.name)) throw new ToolError(`${tool.name} is not proposed here: answer it from its card`);
      // Only a fixed set of tools is approved in the request that runs it. Checked before the
      // tool runs, so a refused one does not so much as make a proposal.
      const approve = url.searchParams.get('approve') === '1';
      if (approve && !APPROVE_IN_ONE.has(tool.name)) {
        throw new ToolError(`${tool.name} is not approved in one step; approve its proposal`);
      }
      const args = (await readBody(req)) as Record<string, unknown>;
      // A press sorts a receipt at once, but a rule it would add is shown first: refused here, not in the tool,
      // so Claude's sort_receipts cards keep their rule.
      const refused = approve ? refusedInOne(tool.name, args) : null;
      if (refused) throw new ToolError(refused);
      if (approve) {
        // The tool's check (a cover only while short) reads the state before the append lands on
        // disk, so two taps in the same moment would both pass it: run and commit one at a time
        // per household. Its own key, so a commit that takes oneEffectAtATime never waits on itself.
        // A run that threw never commits, and a refused commit throws too: either leaves the log as it was.
        const { proposal, done } = await oneAtATime(`${ctx.store.path}|approve-in-one`, async () => {
          const proposal = (await runTool(tool, args, ctx)) as Proposal;
          return { proposal, done: await commit(proposal.id, ctx) };
        });
        return json(res, 200, {
          proposal, summary: done.summary,
          committed: done.committed.map((e) => ({ id: e.id, op: e.op, at: e.at, who: e.who })),
          touches: touches(proposal.events),
          lastEventId: active.state.lastEventId,
        });
      }
      // runTool records the args on a write's proposal, for its effect on approval.
      const result = await runTool(tool, args, ctx);
      // Writes come back as a proposal so the caller — UI or Claude — must
      // present it for approval. Nothing here has changed the log.
      return json(res, 200, tool.kind === 'write' ? { proposal: result } : { result });
    }

    throw new ToolError(`no route for ${req.method} ${path}`, 404);
  }

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  // PORT=0 asks the system for a free one; say which it gave.
  const port = (server.address() as { port: number }).port;
  const allowedAtBoot = allowedUsers();
  console.log(`[budget] listening on :${port} (may sign in: ${allowedAtBoot.join(', ') || 'any DSM account'})`);
  if (!allowedAtBoot.length) {
    console.warn('[budget] ALLOWED_USERS is empty — any DSM account may reach the sign-in');
  }

  return {
    port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))),
  };
}

if (import.meta.filename === process.argv[1]) {
  await start();
}
