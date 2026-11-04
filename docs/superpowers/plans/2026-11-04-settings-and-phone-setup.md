# Settings, One Menu and Phone Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One menu under the person, Settings as rows in three groups (You, Household, This NAS) with the Connectors page folded into the third, and a "Set up your iPhone" sheet whose QR code carries a ten-minute one-time link to an Apple configuration profile.

**Architecture:** Three small server modules do the new work and are tested on their own: `profile.ts` writes the property list, `phone-setup.ts` keeps the one-time codes hashed in memory, and `tools/make-icon.ts` makes the Home Screen icon once. `server.ts` gains three routes (two under `/api` behind the session, `/setup/<code>` before the gate, like `/book`), and its settings answer gains what the sheet needs. The page work is in `site/index.html` only: every `*Sec()` becomes a row with its existing form opened in place, the Connectors view becomes the This NAS group, the Household pill goes, and the sheet is a new panel beside `#cat-sec`.

**Tech Stack:** Node with `--experimental-strip-types`, `node:test`, `node:crypto`, `node:zlib`; one new dependency, `qrcode` (with `@types/qrcode` for the typecheck). Single-file vanilla JS page, no build step.

**Spec:** `docs/superpowers/specs/2026-11-04-settings-and-phone-setup-design.md`. It is the authority; read it whole before your task. Where this plan decides something the spec left open, the plan says so in the task.

## Global Constraints

- Tests and typecheck from `api/`: `npm test` and `npm run typecheck`, both green before every commit. 1635 tests pass at `999970b`; the count only grows.
- Commit as the owner, with exactly this trailer whatever model you are: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit -m "<plain sentence>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`. A plain-sentence subject, no conventional-commit prefix. Never push.
- If a bare `git` fails with `xcodebuild` or `Abort trap: 6`, use `/opt/homebrew/bin/git`. Do not install anything from Xcode.
- Never write a private IP address, the household's own folder or domain names, or a real person's name into the tree. Examples use `nas.example.com`, `planner.example.com`, and the accounts `alex` and `bob`.
- Never touch `api/data/`, `.env`, `site/*.jsonl` or `site/planner.html`.
- The app is never started on port 5555. For a check by hand, run it on 5577: `cd api && PORT=5577 npm start`.
- Words a person reads say "This NAS", never "Connectors", and "Where phones reach the NAS", never "Calendar on phones". The API path `/api/connectors`, the file `connectors.json` and code identifiers keep their names.
- Exact copy the spec pins is copied verbatim (the sheet's sentences, the expired page, the row hints).
- Comments in the repository's voice: plain sentences saying why, no headings in shouty case, no "NOTE:".
- No plist library. No image library. `qrcode` is the only new runtime dependency.
- Node type stripping: no parameter properties, no enums.

## Review Focus

1. **A DSM account name with `&`, `<`, an apostrophe or a space** (`o'neil`, `a&b`): the plist stays well-formed and the CalDAV path is URL-encoded. Pinned in Task 1 (`an account with XML and URL characters is escaped`).
2. **A HEAD or prefetch of the setup link before the real GET** (link previews, Safari's own HEAD): it must not spend the code. Pinned in Task 4 (`a HEAD does not spend the code`).
3. **The planner opened over plain http on the LAN** (`http://planner.example.com:8088`): the code is refused with words saying why, and the sheet shows those words instead of a blank square. Pinned in Task 2 (`acceptedOrigin`) and Task 4 (`a bad origin is refused 400 and makes no code`); the sheet's handling is checked by hand in Task 9.
4. **Two members of one household making codes at the same time**: each keeps a live code; only a member's own new code replaces their old one. Pinned in Task 2 (`one live code per member, others untouched`).
5. **The DSM public address changed or cleared between making a code and scanning it**: the profile carries the address as it was when the code was made, so the QR and the profile agree. Pinned in Task 4 (`the address is the one the code was made with`).

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `api/src/profile.ts` (new) | The `.mobileconfig` property list, the CalDAV path, the deterministic UUIDs | 1 |
| `api/test/plist.ts` (new, helper, not a test file) | A tiny plist reader for tests | 1 |
| `api/src/phone-setup.ts` (new) | One-time codes: issue, redeem, expiry, the origin rule | 2 |
| `api/tools/make-icon.ts` (new), `site/icon-180.png` (new, generated) | The 180×180 Home Screen icon | 3 |
| `api/src/server.ts` | Three routes, the icon read at start, `phoneSetup`, `categoriesInUse` and `booking.needsAddress` in the settings answer | 4, 5 |
| `api/src/setup.ts`, `api/src/connectors-view.ts`, `api/src/booking.ts` | Today's notice actions name a Settings group and row; the words say This NAS | 5 |
| `site/index.html` | Settings rows; the This NAS group; one menu; the phone sheet | 6, 7, 8, 9 |
| `DEPLOY.md`, `README.md`, `api/tools/synology-check/README.md` | The words | 10 |

---

## Phase 1: The server

### Task 1: The profile, as a property list

**Files:**
- Create: `api/src/profile.ts`
- Create: `api/test/plist.ts` (helper)
- Test: `api/test/profile.test.ts`

**Interfaces:**
- Produces, in `profile.ts`:
  ```ts
  export interface ProfileInput {
    member: string;               // the DSM account
    household: string;            // the household's label
    dsmPublicUrl: string | null;  // an origin, as dsmPublicUrl() answers it
    origin: string | null;        // the planner's origin, for the web clip
    calendar: boolean;
    home: boolean;
    iconPng: Buffer | null;
  }
  export function buildProfile(o: ProfileInput): string;
  export function caldavPath(account: string): string;   // `/caldav/${encodeURIComponent(account)}/`
  export function profileUuid(seed: string): string;     // v4-shaped, uppercase, from sha256(seed)
  export const PROFILE_CONTENT_TYPE = 'application/x-apple-aspen-config';
  export const PROFILE_FILENAME = 'home-planner.mobileconfig';
  ```
- Produces, in `api/test/plist.ts`: `export function parsePlist(xml: string): unknown` — `dict` to a plain object, `array` to an array, `string` unescaped, `integer` to a number, `true`/`false` to booleans, `data` to a `Buffer`. Throws on anything else or on unbalanced tags. About forty lines of recursive descent over a tag regex; no DOM.

- [ ] **Step 1: Write the failing tests** in `api/test/profile.test.ts`. The common input is `{ member: 'alex', household: 'Larkspur House', dsmPublicUrl: 'https://nas.example.com:5001', origin: 'https://planner.example.com', calendar: true, home: true, iconPng: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }`.

  ```ts
  test('the outer payload is a Configuration named for the member', () => {
    const p = parsePlist(buildProfile(base)) as any;
    assert.equal(p.PayloadType, 'Configuration');
    assert.equal(p.PayloadVersion, 1);
    assert.equal(p.PayloadIdentifier, 'name.homeplanner.setup.alex');
    assert.equal(p.PayloadDisplayName, 'Home Planner');
    assert.equal(p.PayloadDescription, 'The Household calendar in Apple Calendar, and Home Planner on your Home Screen.');
    assert.equal(p.PayloadOrganization, 'Larkspur House');
    assert.match(p.PayloadUUID, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });
  test('the CalDAV payload is read from the public address', () => {
    const [cal] = (parsePlist(buildProfile({ ...base, home: false })) as any).PayloadContent;
    assert.deepEqual(Object.keys(cal).sort(), ['CalDAVAccountDescription', 'CalDAVHostName', 'CalDAVPort', 'CalDAVPrincipalURL',
      'CalDAVUseSSL', 'CalDAVUsername', 'PayloadDisplayName', 'PayloadIdentifier', 'PayloadType', 'PayloadUUID', 'PayloadVersion']);
    assert.equal(cal.PayloadType, 'com.apple.caldav.account');
    assert.equal(cal.CalDAVAccountDescription, 'Household calendar (NAS)');
    assert.equal(cal.CalDAVHostName, 'nas.example.com');
    assert.equal(cal.CalDAVPort, 5001);
    assert.equal(cal.CalDAVUseSSL, true);
    assert.equal(cal.CalDAVUsername, 'alex');
    assert.equal(cal.CalDAVPrincipalURL, '/caldav/alex/');
  });
  test('an address with no port is 443 over https and 80 over http', ...);   // CalDAVPort 443, UseSSL true; 80, UseSSL false
  test('the web clip opens the kept origin full screen with the icon', () => {
    const [clip] = (parsePlist(buildProfile({ ...base, calendar: false })) as any).PayloadContent;
    assert.equal(clip.PayloadType, 'com.apple.webClip.managed');
    assert.equal(clip.Label, 'Home Planner');
    assert.equal(clip.URL, 'https://planner.example.com');
    assert.equal(clip.FullScreen, true);
    assert.equal(clip.IsRemovable, true);
    assert.equal(clip.Precomposed, true);
    assert.deepEqual(clip.Icon, base.iconPng);
  });
  test('no icon leaves the Icon key out', ...);                 // iconPng: null → !('Icon' in clip)
  test('exactly the payloads asked for, calendar first', ...);  // both → types ['com.apple.caldav.account', 'com.apple.webClip.managed']
  test('the same member and flags give the same UUIDs; other flags another', ...);
       // buildProfile(base) === buildProfile(base); outer PayloadUUID differs for { ...base, home: false }
  test('an account with XML and URL characters is escaped', () => {
    const xml = buildProfile({ ...base, member: "o'neil & <co>", household: 'A & B' });
    const p = parsePlist(xml) as any;
    assert.equal(p.PayloadOrganization, 'A & B');
    assert.equal(p.PayloadContent[0].CalDAVUsername, "o'neil & <co>");
    assert.equal(p.PayloadContent[0].CalDAVPrincipalURL, `/caldav/${encodeURIComponent("o'neil & <co>")}/`);
    assert.ok(!/<co>/.test(xml));
  });
  test('a profile with nothing in it, or a payload missing what it needs, is refused', () => {
    assert.throws(() => buildProfile({ ...base, calendar: false, home: false }), /at least one/);
    assert.throws(() => buildProfile({ ...base, home: false, dsmPublicUrl: null }), /address/);
    assert.throws(() => buildProfile({ ...base, calendar: false, origin: null }), /origin/);
  });
  ```

- [ ] **Step 2: Run them to see them fail.** `cd api && node --test --experimental-strip-types test/profile.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `profile.ts`.** Decisions:
  - The writer is a small recursive `plistValue(v)` over string, number (integer), boolean, `Buffer` (`<data>` base64), array and object (keys in insertion order), with `escapeXml` replacing `& < > " '`. The document starts with the XML declaration and the Apple `PLIST 1.0` doctype and wraps one `<plist version="1.0">`.
  - Identifiers: `name.homeplanner.setup.<part>`, where `part` is the member lowercased with every character outside `[a-z0-9-]` made `-`; the sub-payloads append `.caldav` and `.webclip`. The outer payload also carries `PayloadRemovalDisallowed: false`.
  - UUIDs: `profileUuid(seed)` takes the first 16 bytes of sha256, sets the version nibble to 4 and the variant bits to `10`, and formats 8-4-4-4-12 in uppercase. Seeds: outer `${member}\0${calendar ? 1 : 0}${home ? 1 : 0}`; CalDAV `${member}\0caldav`; web clip `${member}\0webclip`.
  - `CalDAVPort` is the URL's port, else 443 for https and 80 for http (the spec says 443 "when none"; 80 is what an http address with no port means).
  - Sub-payload `PayloadDisplayName`s: `Household calendar` and `Home Planner`.
  - A comment over `caldavPath` says it is the one constant to change if a first real install shows iOS wants the bare `/caldav/` (spec, The profile).

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"A phone's configuration profile is written as a property list, with the calendar, the Home Screen icon, or both"`

---

### Task 2: One-time codes

**Files:**
- Create: `api/src/phone-setup.ts`
- Test: `api/test/phone-setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SETUP_CODE_TTL_MS = 10 * 60_000;
  export interface SetupFlags { readonly calendar: boolean; readonly home: boolean }
  export interface SetupEntry {
    readonly member: string; readonly household: string; readonly flags: SetupFlags;
    readonly origin: string; readonly dsmPublicUrl: string | null; readonly expiresAt: number;
  }
  export interface PhoneCodes {
    issue(o: { member: string; household: string; flags: SetupFlags; origin: string; dsmPublicUrl: string | null }):
      { code: string; url: string; expiresAt: number };
    /** The entry, if live, without spending it. */
    peek(code: string): SetupEntry | null;
    /** The entry, if live, spent by this call. */
    redeem(code: string): SetupEntry | null;
  }
  export function createPhoneCodes(now?: () => number): PhoneCodes;   // now defaults to Date.now
  /** The origin itself when it may receive a phone, else null: https anywhere, http only on a loopback host. */
  export function acceptedOrigin(raw: unknown): string | null;
  ```

- [ ] **Step 1: Write the failing tests.** A clock `let t = 1_000_000; const codes = createPhoneCodes(() => t);` and `const ask = { member: 'alex', household: 'Larkspur House', flags: { calendar: true, home: true }, origin: 'https://planner.example.com', dsmPublicUrl: 'https://nas.example.com:5001' }`.
  - `a code is 32 random bytes as base64url, with its link and expiry`: `assert.match(code, /^[A-Za-z0-9_-]{43}$/)`, `url === \`https://planner.example.com/setup/${code}\``, `expiresAt === t + 600_000`; two issues give different codes.
  - `a code is redeemed once`: `redeem(code)` deepEquals `{ ...ask, expiresAt }` (as a `SetupEntry`); a second `redeem` is `null`.
  - `peek does not spend it`: `peek` twice then `redeem` all non-null.
  - `ten minutes and it is gone`: at `t + 599_999` `peek` is live; at `t + 600_000` `redeem` is `null`.
  - `one live code per member, others untouched`: alex issues A then B → `redeem(A)` null, `redeem(B)` live; bob's code issued between them stays live.
  - `unknown and malformed codes are null`: `redeem('')`, `redeem('x')`, `redeem('A'.repeat(43))`, `redeem(42 as any)`.
  - `acceptedOrigin`: accepts and returns `'https://planner.example.com'`, `'https://planner.example.com:8443'`, `'http://localhost:5577'`, `'http://127.0.0.1:5577'`, `'http://[::1]:5577'`, and `'https://planner.example.com/'` as `'https://planner.example.com'`; null for `'http://planner.example.com:8088'`, `'https://planner.example.com/app'`, `'https://u:p@planner.example.com'`, `'ftp://planner.example.com'`, `''`, `null`, `42`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** Decisions: the map is keyed by `createHash('sha256').update(code).digest('hex')`, as `auth.ts` keeps session tokens (`auth.ts:255`); the raw code is never stored. A second map, member to hash, enforces one live code per member. Expired entries are swept on every `issue`. `redeem` looks the hash up, refuses an expired entry (deleting it), deletes a live one and returns it. A code that is not a 43-character base64url string is `null` before any hashing. `acceptedOrigin`: parse with `URL`; refuse credentials, a path other than `/`, a query or a fragment; accept `https:`, or `http:` when the hostname is `localhost`, ends in `.localhost`, is `127.0.0.1` or is `[::1]`; return `u.origin`.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"One-time setup codes are kept hashed in memory for ten minutes, one per member"`

---

### Task 3: The Home Screen icon

**Files:**
- Create: `api/tools/make-icon.ts`
- Create (generated, committed): `site/icon-180.png`
- Modify: `api/tsconfig.json` (`include` gains `"tools/make-icon.ts"`), `api/package.json` (script `"make-icon": "node --experimental-strip-types tools/make-icon.ts"`)
- Test: `api/test/make-icon.test.ts`

**Interfaces:**
- Produces, in `make-icon.ts`:
  ```ts
  /** The fill of the first <rect> in an SVG, as [r, g, b]; throws when there is none. */
  export function backgroundOf(svg: string): [number, number, number];
  /** A size×size PNG of one colour: 8-bit RGB, no interlace, every row filter 0. */
  export function solidPng(size: number, rgb: readonly [number, number, number]): Buffer;
  ```
  Run directly (`process.argv[1] === fileURLToPath(import.meta.url)`), it reads `../site/icon.svg` relative to the script, writes `../site/icon-180.png`, and prints the path and byte count.

- [ ] **Step 1: Write the failing tests.**
  - `the background is the icon's own blue`: `backgroundOf(readFileSync('../site/icon.svg', 'utf8'))` deepEquals `[0x0c, 0x8c, 0xe9]`.
  - `a solid PNG is signed, sized and filled`: for `solidPng(180, [12, 140, 233])`: the first 8 bytes are `89 50 4E 47 0D 0A 1A 0A`; the IHDR chunk reads width 180, height 180, bit depth 8, colour type 2; inflating the IDAT data gives `180 * (1 + 180 * 3)` bytes, every row starting with 0 and every pixel `12, 140, 233`; the last chunk is `IEND`; each chunk's CRC equals `zlib.crc32(type + data)`.
  - `the committed icon is the one the script makes`: `readFileSync('../site/icon-180.png')` equals `solidPng(180, backgroundOf(svg))`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** with `node:zlib` only (`deflateSync`, `crc32`). The household glyph is left out on purpose (spec): a comment says a real rendering of `icon.svg` can replace the file without a code change.

- [ ] **Step 4: Make the file.** `cd api && npm run make-icon`. Expected: `site/icon-180.png` exists, a few hundred bytes. Then run the tests, `npm test`, `npm run typecheck`.

- [ ] **Step 5: Commit** (`site/icon-180.png`, the tool, the test, `tsconfig.json`, `package.json`) — `"A 180-pixel icon for the Home Screen, made once from the icon's own colour"`

---

### Task 4: The setup routes

**Files:**
- Modify: `api/package.json`, `api/package-lock.json` (`npm install qrcode@^1.5.4` and `npm install -D @types/qrcode`)
- Modify: `api/src/server.ts` — the route list comment at the top (~line 117); `start()` opts (~1152); the `/setup/` route beside `/book` (~1661), before the shell; the two `/api/phone-setup/` routes after `const active = await activeStore(...)` (~1954); `settingsOf` (~1037)
- Test: `api/test/server-phone-setup.test.ts` (new; set up as `server-settings.test.ts` is, with the fake DSM on port 0)

**Interfaces:**
- Consumes: Task 1 `buildProfile`, `caldavPath`, `PROFILE_CONTENT_TYPE`, `PROFILE_FILENAME`; Task 2 `createPhoneCodes`, `acceptedOrigin`, `PhoneCodes`; `currentPublicUrl()` from `settings.ts`; `lastSavedBy()` from `connectors.ts`; `guestPage`, `sendPage` already in `server.ts`.
- Produces:
  - `start(opts: { send?; households?; phoneCodes?: PhoneCodes })`: a test hands in `createPhoneCodes(() => clock)`.
  - `POST /api/phone-setup/code`, body `{ calendar: boolean, home: boolean, origin: string }`, session and an open household required. 200 `{ code: string, url: string, expiresAt: string /* ISO */, qr: string /* SVG */ }`. 400 with `{ error }` for: an origin `acceptedOrigin` refuses (`"a phone can be set up only from a page opened over https (or over http on this computer)"`); both flags false (`"choose the Household calendar, Home Planner, or both"`); `calendar` with no public address (`"the NAS's address is not set: a DSM administrator sets it under Settings › This NAS › Where phones reach the NAS"`). 401 without a session.
  - `GET /setup/<code>`, no session: 200 with `content-type: application/x-apple-aspen-config`, `content-disposition: attachment; filename="home-planner.mobileconfig"`, `cache-control: no-store`, `x-content-type-options: nosniff`, and the profile; the code is spent. `HEAD` of a live code: 200, the same headers, no body, not spent. Any other method, or an unknown, spent or expired code: 404 via `sendPage(res, 404, CODE_EXPIRED)` where `CODE_EXPIRED = guestPage('This code has expired', '<p>Open Home Planner on your computer and make a new one from Set up your iPhone.</p>')`.
  - `GET /api/phone-setup/profile?calendar=1&home=1&origin=<page origin>`, session required: 200, the same headers, the profile for the signed-in member and the open household. Decision: the page sends its own `location.origin` as `origin` and it is checked by `acceptedOrigin`, rather than rebuilding an origin from `Host` and `X-Forwarded-*`, which `TRUST_PROXY` only covers for addresses today. `origin` is needed only when `home=1`. The same 400s as the POST.
  - The profile's inputs: `member` is the session's `who`; `household` is `active.state.label`; `dsmPublicUrl` is `currentPublicUrl()` at issue, kept in the entry, so the profile matches the code (Review Focus 5); `iconPng` is `site/icon-180.png` read once in `start()` from `SITE_DIR` (null, with one `console.warn`, if it cannot be read).
  - QR: `await QRCode.toString(url, { type: 'svg', margin: 1 })` from `import QRCode from 'qrcode'`.
  - `settingsOf` gains `phoneSetup: { caldav: string | null; nasAdmin: string | null }`: `caldav` is `currentPublicUrl() + caldavPath(who)` or null; `nasAdmin` is `ADMIN_USER || lastSavedBy() || null`, the name the sheet tells a member to ask.

- [ ] **Step 1: Install the dependency.** `cd api && npm install qrcode@^1.5.4 && npm install -D @types/qrcode`. Expected: both in `package.json`; `npm run typecheck` still passes.

- [ ] **Step 2: Write the failing tests.** Accounts `alex` (`ADMIN_USER: 'alex'`) and `bob`; alex makes the household `Larkspur House`; `saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'alex')` in `before`; `let clock = Date.parse('2026-11-04T12:00:00Z')` and `start({ phoneCodes: createPhoneCodes(() => clock) })`. Profiles are read with `parsePlist` from Task 1. `const origin = 'https://planner.example.com'`.
  - `a code answers its link, its expiry and the QR as SVG`: 200; `url === \`${origin}/setup/${code}\``; `Date.parse(expiresAt) - clock === 600_000`; `qr` starts with `<svg`.
  - `the link serves the profile once, then the expired page`: GET 200 with the four headers above; the plist's CalDAV payload has `CalDAVHostName 'nas.example.com'`, `CalDAVPort 5001`, `CalDAVUsername 'alex'`, `CalDAVPrincipalURL '/caldav/alex/'`; the web clip's `URL === origin` and its `Icon` begins with the PNG signature. The second GET is 404, `text/html`, its body includes `This code has expired` and does not include `Larkspur`.
  - `after ten minutes the link is spent`: issue, `clock += 600_000`, GET 404.
  - `a HEAD does not spend the code`: HEAD 200 with the profile content type and an empty body, then GET 200.
  - `only the payloads asked for`: `{ calendar: true, home: false }` gives types `['com.apple.caldav.account']`; `{ calendar: false, home: true }` gives `['com.apple.webClip.managed']`.
  - `a bad origin is refused 400 and makes no code`: `origin: 'http://planner.example.com:8088'` gives 400 with the words above and no `code` in the body.
  - `both off is refused 400`.
  - `the calendar needs the NAS's address; the Home Screen alone does not`: after `saveConnector('publicUrl', { off: true }, 'alex')`, `{ calendar: true, home: true }` is 400 with the address words, and `{ calendar: false, home: true }` is 200. Restore with `{ clear: true }` then the value.
  - `the address is the one the code was made with`: issue, save `https://other.example.com` as the address, redeem: `CalDAVHostName` is still `nas.example.com`.
  - `a second code replaces the first`: issue A then B for alex; GET A is 404, GET B is 200.
  - `no session, no code and no profile`: POST and `GET /api/phone-setup/profile` without a cookie are 401.
  - `the Mac download is the same profile for the signed-in member`: `GET /api/phone-setup/profile?calendar=1&home=1&origin=${encodeURIComponent(origin)}` as alex: 200, the four headers, both payloads, `CalDAVUsername 'alex'`, `PayloadOrganization 'Larkspur House'`; `?calendar=0&home=0` is 400; `?calendar=0&home=1&origin=http%3A%2F%2Fplanner.example.com` is 400.
  - `settings say where phones reach the NAS and whom to ask`: `GET /api/settings` as alex has `phoneSetup` deepEqual `{ caldav: 'https://nas.example.com:5001/caldav/alex/', nasAdmin: 'alex' }`; with the address off, `caldav` is null.

- [ ] **Step 3: Run to see them fail.** `node --test --experimental-strip-types test/server-phone-setup.test.ts`.

- [ ] **Step 4: Implement the routes and the settings fields** as in Interfaces. The `/setup/` match is `path.startsWith('/setup/')`, placed after the `/book` line and before `if (!path.startsWith('/api/')) return serveStatic(...)`, so it never reaches the shell. The page for a bad code never names the household. Add the three routes to the list in the comment at the top of `server.ts`.

- [ ] **Step 5: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 6: Commit** — `"A phone is set up from a one-time link: the code, its QR, the profile it serves once, and the profile for a Mac"`

---

### Task 5: Today's notices open a Settings row, and the server says This NAS

**Files:**
- Modify: `api/src/setup.ts` (the `SetupNotice['action']` type ~line 61, the four actions ~93, ~102, ~128, ~136; doc comment ~76)
- Modify: `api/src/connectors-view.ts` (`ROW_NAME` ~25, the comments at lines 2, 23 and ~170)
- Modify: `api/src/booking.ts` (`bookingAvailability` words ~210, ~213; comments at 7, 86, 198)
- Modify: `api/src/server.ts` (`bookingView`, for `needsAddress`; `settingsOf` gains `categoriesInUse`; the `Connectors` words in comments and the mail test's text at ~1812)
- Test: `api/test/setup.test.ts`, `api/test/server-setup.test.ts`, `api/test/booking.test.ts`, `api/test/server-plans.test.ts`, `api/test/server-settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // setup.ts
  export type SettingsGroup = 'you' | 'household' | 'nas';
  export const STEP_ROW: Readonly<Record<SetupStep, string>> =
    { folder: 'documents', zone: 'zone', calendar: 'hcal', booking: 'guests', model: 'model' };
  export interface SetupNotice {
    readonly kind: NoticeKind; readonly text: string;
    readonly action?: { readonly label: string; readonly open: 'settings'; readonly group: SettingsGroup; readonly row: string };
  }
  ```
  The household's notices use `group: 'household', row: STEP_ROW[step]`; the NAS notice is `{ label: 'Open This NAS', open: 'settings', group: 'nas', row: <first RowId> }`. NAS row keys are the connector ids as they are (`claude`, `drive`, `calendar`, `mail`, `booking`, `sign-in`, `pricing`): `GET /api/connectors` does not change.
  - `ROW_NAME.calendar = 'Where phones reach the NAS'`, `ROW_NAME.booking = 'Booking address'`.
  - Booking's refusals: `` `Booking is off until ${fixer} sets the booking address under Settings › This NAS.` `` and `` `Booking is off until ${fixer} sets up mail under Settings › This NAS.` ``
  - `settingsOf(...).booking` gains `needsAddress: boolean`, true when `bookUrl(resolvedEnv())` is not a string. `settingsOf(...)` gains `categoriesInUse: number`, the categories not archived.
  - The mail test's text: `'This is the test sent from Settings › This NAS. Mail from Home Planner reaches this address.'`

- [ ] **Step 1: Change the tests first.** Each existing assertion that names an action or the words changes to the new shape; for example `server-setup.test.ts:94-97`:
  ```ts
  assert.deepEqual(mine[0].action, { label: 'Choose a folder', open: 'settings', group: 'household', row: 'documents' });
  assert.equal(mine[1].text, 'Set up the NAS: Claude, Where phones reach the NAS, Mail and Pricing sources.');
  assert.deepEqual(mine[1].action, { label: 'Open This NAS', open: 'settings', group: 'nas', row: 'claude' });
  ```
  `setup.test.ts:125` becomes `{ label: 'Choose a calendar', open: 'settings', group: 'household', row: 'hcal' }`; `setup.test.ts:47,57` take `row: 'documents'`; `setup.test.ts:70` takes `{ label: 'Open This NAS', open: 'settings', group: 'nas', row: 'mail' }`. `booking.test.ts:220-250` and `server-plans.test.ts:552` take the new booking words. Add to `setup.test.ts`: `test('every setup step names a Settings row', () => assert.deepEqual(SETUP_ORDER.map((s) => STEP_ROW[s]), ['documents', 'zone', 'hcal', 'guests', 'model']))`. Add to `server-settings.test.ts`: `categoriesInUse` is a number equal to the household's unarchived categories, and `booking.needsAddress` is `false` with `BOOK_URL` set there (and `true` after `saveConnector('bookUrl', { off: true }, ...)`, cleared after).

- [ ] **Step 2: Run them to see them fail** (`npm test`; the changed files fail on the old words).

- [ ] **Step 3: Implement** the types, the map and the words. Grep `api/src` for the word `Connectors` and `Calendar on phones` in strings a person reads and change each; comments say "This NAS" too where they name the page.

- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. `grep -rn "Calendar on phones\|on Connectors\|Open Connectors" api/src api/test` prints nothing.

- [ ] **Step 5: Commit** — `"Today's notices open a Settings row by group, and the server's words say This NAS"`

---

## Phase 2: The page

No test drives `site/index.html` (nothing in `api/test` loads it or jsdom). Each page task is checked by hand in a browser against the app on port 5577, with the checks listed in its last step. Whatever could be tested on the server was put there in Tasks 1 to 5.

### Task 6: Settings as rows, for You and Household

**Files:**
- Modify: `site/index.html` — CSS for the rows near the existing `.set-sec` rules; `renderSettings` (~6741); `setSec` (~6659) is replaced by `settingRow`; `appearanceSec`, `conflictsSec`, `phoneCalSec`, `setupSec`, `areasSec`, `linksSec`, `budgetSec`, `householdCalSec`, `guestsSec`, `attachmentsSec` (6828-7720); `openSettings` (~6638); `markSettingsIndex` (~6817); `saveSettings` (~6610); the handlers for `#hh-share` (~2026), `#cat-manage` (~4127), `#hh-take` (~1843); `calendarRow` (~7230); callers of `openSettings` at ~2203, ~3116, ~8131, ~8133.

**Interfaces:**
- Consumes: from Task 5, `settingsData.categoriesInUse`, `settingsData.booking.needsAddress`, and Today's `action` as `{ label, open: 'settings', group, row }`; from Task 4, `settingsData.phoneSetup`.
- Produces (later page tasks use these):
  ```js
  /** One row: title, a status line, at most one action (two only where the spec names two). */
  function settingRow({ key, title, status /* string | Node | Node[] */, actions /* [{ label, act?, href?, opens? }] */, form /* () => Node */, list /* bool */ })
  /** The row whose form is open, or null. One at a time. */
  let settingsOpen = null;            // { group: 'you'|'household'|'nas', row: string }
  async function openSettings(group, row)   // replaces openSettings(section, step)
  function inviteSomeone()            // was the #hh-share handler's body
  async function openCategories()     // was the #cat-manage handler's body
  function takeFromBackup()           // was the #hh-take handler's body
  ```

**Decisions** (the spec leaves these to the builder):
- A row is `<section class="set-row" id="set-<key>" aria-labelledby="set-<key>-h">`: an `<h3>` title in a fixed first column (`9.5rem` on the desk, full width above the status on a phone), the status in the second, the action at the end. The action is a `btn bare small` with `data-key="row-<key>"` and `aria-expanded` when it opens a form. The form sits under the status in `<div class="set-form" id="set-<key>-form">`, drawn only while `settingsOpen` names the row. No animation (the spec leaves it open; a page drawn again on every save would replay it).
- A row closes on save when it holds one form. The list editors (`conflicts`, `areas`, `links`, `guests`), where each change saves at once, stay open and carry a **Done** button that closes them. `saveSettings` closes the open row on success unless it is one of those four.
- An owner-only row shows its action to the owner and its status to everyone else: `members`, `hcal`, `documents`, and the zone and model steps in `setup`.
- Each `xxxSec()` becomes `xxxRow()` returning `settingRow(...)`; its old body, without the heading, becomes the row's `form` (the existing `rowForm`, `editRows`, `settingsEdit` and `cancelEdit` keep working inside it).
- Appearance: the spec's status is the segmented control, inline; its labels become **System**, **Light**, **Dark** (`MODES` keeps its keys; `match` is labelled System). The scheme tiles would otherwise be lost, so the row keeps one action, **Colours**, which opens the tiles in place.
- Hcal: the spec names "Rename · Replace"; the row's one action is **Change**, which opens the existing section body, where Rename and Replace already sit as today.
- Budget: one action, **Edit**, opens the savings form, which gains a first line with a button **Edit the categories** calling `openCategories()`.

The rows, in order, with their status lines (exact words where the spec gives them):

| Group | Key | Title | Status | Action |
|---|---|---|---|---|
| you | `appearance` | Appearance | the System / Light / Dark control | Colours |
| you | `conflicts` | Calendars I check | checked calendars' names joined ` · `; the calendarsOff words when they cannot be read; hint "Clashes with these are flagged when you schedule." | Change |
| you | `phone` | Your iPhone and Mac | (Task 9 replaces this row) for now `settingsData.dsmPublicUrl ? 'Apple Calendar can add the Household calendar.' : 'Not set up on this NAS yet.'` | Show how (the old `phoneCalSec` body, with its words changed to "Settings › This NAS › Where phones reach the NAS") |
| household | `setup` | Setup | a two-column grid of the five steps, `✓` or `○` with each step's value; then "Only <owner> chooses these. Each is also a row below." (for the owner, "Only you choose these. Each is also a row below.") The zone and model steps carry **Change** (owner), opening `zoneRow`/`modelRow`'s existing form inside Setup; the folder, calendar and booking steps' values are links to `openSettings('household', STEP_ROW)` (`documents`, `hcal`, `guests`) | — |
| household | `members` | Members | names joined ` · `, the owner's followed by "(owner)" | Invite someone → `inviteSomeone()` |
| household | `areas` | Areas | the areas joined ` · ` | Edit |
| household | `budget` | Budget | `` `Categories: ${n} in use · Savings shown today: ${balance.exact}` `` or `` `Categories: ${n} in use · No savings account chosen` `` | Edit |
| household | `hcal` | Household calendar | `` `${name}, on the NAS, shared with ${listOf(others)}` `` or "No Household calendar yet" | Change |
| household | `guests` | Guests and booking | `` `${n} guests on the list · Booking ${on ? 'on' : 'off'}` ``; when off and `booking.needsAddress`, add "Needs the booking address set under This NAS before it can go on." | Edit |
| household | `documents` | Documents | `` `${team} › ${folder} on Synology Drive · Cards keep files ${on ? 'on' : 'off'}` `` or "No folder chosen" | Change folder → the folder picker, moved here from Setup |
| household | `links` | Links under More | the labels joined ` · ` | Edit |
| household | `backup` | Backup | "The household's log, everything it has decided." | **Download** (`<a href="/api/backup" download>`) · **Restore…** → `takeFromBackup()` |

The groups' headings and hints stay as today's ("Yours" becomes **You**, "The household's" becomes **Household**), and the software line stays the You group's footer.

- [ ] **Step 1: The row and its state.** Add `settingRow`, `settingsOpen`, the CSS, and make `markSettingsIndex` read `.set-row`. The index on the left lists each group's eyebrow, then a link per row to `#set-<key>`.

- [ ] **Step 2: The You rows** as in the table.

- [ ] **Step 3: The Household rows** as in the table. Move the three handlers' bodies into `inviteSomeone`, `openCategories` and `takeFromBackup`; the old `#hh-share`, `#cat-manage` and `#hh-take` listeners call them (the menu items go in Task 8).

- [ ] **Step 4: `openSettings(group, row)`.** It shows Settings, and, when `row` is a row in `group` that this person may act on, opens it (`settingsOpen = { group, row }`) and scrolls it to the top; `zone` and `model` open Setup with that step's form; `documents` opens the folder picker for the owner. A group or row this person does not have (a member asked for `nas`, an unknown key) shows Settings at the top, with no error. Update every caller: Today's notices (`openSettings(a.group, a.row)`), the savings check (`'household', 'budget'`), More's links (`'household', 'links'`), More's Settings (`openSettings()`), `#hh-settings` (`openSettings()`), and `calendarRow`'s jump (`'household', 'hcal'`).

- [ ] **Step 5: Check by hand** on `PORT=5577 npm start`: Settings shows You and Household as rows, nothing open; each action opens its form in place and Save closes it (Areas and Links stay open until Done); a member sees owner-only rows' status with no action; the Today folder notice opens Documents with the picker; the Budget screen's Settings link lands on Budget; at 375 px wide nothing scrolls sideways. Then `cd api && npm test`.

- [ ] **Step 6: Commit** — `"Settings is rows: a title, a line of status and one action, the form opening in place"`

---

### Task 7: This NAS, in Settings

**Files:**
- Modify: `site/index.html` — the Connectors block (~7738-8000: `CONNECTOR_NAMES`, `connPlace`, `loadConnectors`, `openConnectors`, `renderConnectors`, `connRow`, `connForm`, `redrawConnectorRow`); `<div id="connectors">` (~1518); `showView` and `pageWords` (~8976-9010); `#hh-connectors` (~1215, ~9056); `#me-connectors` (~1270, ~7799, ~9250); `bookingOffWords` (~7605); `loadSettings`; `renderSettings`.

**Interfaces:**
- Consumes: `settingRow`, `settingsOpen`, `openSettings` from Task 6; `GET /api/connectors` and its `POST /api/connectors/<route>` saves, unchanged.
- Produces: `let amAdmin = false` (set in `enterApp` from `/api/whoami`'s `admin`); `connData` loaded by `loadSettings` when `amAdmin`; `function nasRow(r)` returning a `settingRow`; `function renderNasPanel()` for the households screen.

- [ ] **Step 1: The group.** For an administrator, `loadSettings` also reads `GET /api/connectors` (in parallel; a failure leaves the group with the error line in the one error box). `renderSettings` adds a third group, heading **This NAS**, hint "Seen by DSM administrators only. Shared by every household on this NAS.", with one `nasRow(r)` per row in the answer's order: title from `CONNECTOR_NAMES` (now `calendar: 'Where phones reach the NAS'`, `booking: 'Booking address'`), status the state chip (On, Off, Broken, as today) then `` `${line} · ${source}` ``, action **Change** (**Show** for Synology Drive), form `connForm(r)`. For anyone else the group and its index links are absent.

- [ ] **Step 2: The forms.** `connForm` keeps its fields, tests and refusals; where it closed the Connectors row it now closes the Settings row, and where it redrew the page it redraws Settings. The phones row's form starts with this hint, verbatim: "DSM's own address from outside the house, with its port, such as `https://nas.example.com:5001`. Not the planner's address and not the LAN one. It is the server Apple Calendar is given, and where 'Open in Synology Calendar' goes."

- [ ] **Step 3: Removal.** Delete `openConnectors`, `leaveConnectors`, `connFrom`, the `connectors` view (`<div id="connectors">`, its lines in `showView` and `pageWords`), the `#me-connectors` item and its listener and its line in `enterApp`. Decision: the households screen keeps its button for an administrator who is in no household yet (Settings needs a household, and such an administrator still has to set the NAS up); it is relabelled **This NAS** and draws the same `nasRow`s into `#hh-panel` with `renderNasPanel()`, its errors in `#hh-err` as today.

- [ ] **Step 4: The words.** `bookingOffWords` says "until an administrator sets it up under Settings › This NAS"; the guests row's "Turn it on with Booking, under Setup." stays. `grep -n "Connectors\|Calendar on phones" site/index.html` prints only code identifiers (`CONNECTOR_*`, `conn*`), no string or comment a person reads.

- [ ] **Step 5: Check by hand.** As an administrator (the developer's own fake DSM account with `::admin`; implementers do not edit `.env`): Settings has three groups; each NAS row opens its form; saving Mail without a password keeps it; Today's "Set up the NAS" opens This NAS at its first row; `openSettings('nas', 'calendar')` from the console lands on Where phones reach the NAS. As a member: two groups, and `openSettings('nas', 'calendar')` shows Settings at the top with no error. An administrator in no household opens This NAS from the households screen. At 375 px nothing scrolls sideways. `cd api && npm test`.

- [ ] **Step 6: Commit** — `"The Connectors page is Settings' This NAS group, for administrators"`

---

### Task 8: One menu, under the person

**Files:**
- Modify: `site/index.html` — the top bar markup (~1248-1274) and its CSS (~333-401: `.menu.house`, `.menu.me`, `.pill .txt`, `.pill .sub`); `setupMenu` (~1552) and its calls (~1590); `#switch-hh` listener (~1817); `enterApp` (~9235); the listeners of the removed items (`#hh-settings` ~6649 and the three from Task 6).

**Interfaces:**
- Consumes: `openSettings`, `inviteSomeone`, `openCategories`, `takeFromBackup` (Task 6); `openHousehold`'s select call and `enterApp`.
- Produces: `let myHouseholds = []` (from `GET /api/households` in `enterApp`); `setupMenu(btnId, listId, onOpen?)`.

- [ ] **Step 1: The markup.** Remove `.menu.house` (`#hh-menu-btn`, `#hh-menu`). The person pill becomes:
  ```html
  <button type="button" class="pill member" id="me-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="me-menu">
    <span class="who mine lg" id="me-disc" aria-hidden="true"></span>
    <span class="txt"><span class="name" id="me-name"></span><span class="sub"><span id="hh-name">Household</span> · <span id="today-date"></span></span></span>
    <svg class="i sm chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
  </button>
  <div class="menu-list end" id="me-menu" role="menu" aria-labelledby="me-menu-btn" hidden>
    <div id="me-main">
      <p class="quiet-line" id="who"></p>
      <button type="button" class="menu-item" role="menuitem" id="me-settings">Settings</button>
      <button type="button" class="menu-item" role="menuitem" id="switch-hh" data-keep-open aria-haspopup="menu" hidden>Switch household <span aria-hidden="true">›</span></button>
      <button type="button" class="menu-item" role="menuitem" id="me-new-hh" hidden>Create a new household</button>
      <div class="menu-sep" role="separator"></div>
      <button type="button" class="menu-item" role="menuitem" id="signout">Sign out</button>
    </div>
    <div id="me-switch" hidden>
      <button type="button" class="menu-item" role="menuitem" id="me-back" data-keep-open><span aria-hidden="true">‹</span> Back</button>
      <div id="me-hh-list" role="group" aria-label="Your households"></div>
      <button type="button" class="menu-item" role="menuitem" id="me-new-hh-2">Create a new household</button>
    </div>
  </div>
  ```
  The ids `hh-name` and `today-date` stay (the spec). `who` reads "Signed in as <account> on the NAS". Task 9 adds **Set up your iPhone** after Settings.

- [ ] **Step 2: The sub-list.** `myHouseholds` comes from `GET /api/households` in `enterApp`. With two or more, `#switch-hh` shows and `#me-new-hh` hides; with one or none, the reverse. `#me-hh-list` holds one `menuitemradio` per household: its name, then a `meta` line of its members joined ` · ` and "you own it" or "<owner> owns it"; the current one `aria-checked="true"` with the check icon. Choosing another posts `/api/households/select` and runs `enterApp()` (errors to `showProblem`); choosing the current one just closes. Both Create items open the households screen with its Start panel (`showHouseholds(await api('/api/auth/check'))`, then `$('hh-new').click()`).

- [ ] **Step 3: The keyboard.** `setupMenu` takes an optional `onOpen`, called before focus is placed; for `#me-menu` it shows `#me-main` and hides `#me-switch`. A click on an item with `data-keep-open` does not close the menu. Opening the sub-list (click, Enter, or ArrowRight on `#switch-hh`) shows `#me-switch`, hides `#me-main` and focuses the current household's item. In the sub-list, Escape, ArrowLeft and Back return to `#me-main` with focus on `#switch-hh` (a keydown listener on `#me-switch` that stops the event before `setupMenu`'s own closes the menu). Up, Down, Home and End already move within the visible pane, since `items()` skips hidden ones.

- [ ] **Step 4: Remove** the old listeners (`#hh-settings`, `#hh-share`, `#cat-manage`, `#hh-take`, the old `#switch-hh`) and `setupMenu('hh-menu-btn', 'hh-menu')`. The CSS that placed the Household pill as a second row on a phone goes; the person pill's `.sub` line truncates with an ellipsis so the bar fits.

- [ ] **Step 5: Check by hand.** One pill, its name, household and date. A member of one household sees Settings, Create a new household, Sign out; with two households Switch household opens the sub-list in the same menu, the current one marked, Back returns; arrow keys and Escape behave as in Step 3. Share, Categories, Backup and Restore are reachable from Settings › Household. `grep -n "hh-menu\|hh-settings\|hh-share\|cat-manage\|hh-take\|hh-backup" site/index.html` prints nothing. At 375 px the bar fits on one line. `cd api && npm test`.

- [ ] **Step 6: Commit** — `"One menu under the person, with the household's name on it and a sub-list to switch households"`

(Order note: this task follows the Settings tasks so that Share, Categories, Backup and Restore already have their rows when the Household menu is removed.)

---

### Task 9: The "Set up your iPhone" sheet

**Files:**
- Modify: `site/index.html` — a `<section id="phone-sec" class="sheet" hidden aria-labelledby="phone-h">` in `main` beside `#cat-sec` (~1279); `#me-menu` (a `#me-phone` item after `#me-settings`); the `phone` row from Task 6; CSS for the code area.

**Interfaces:**
- Consumes: `POST /api/phone-setup/code`, `GET /api/phone-setup/profile` (Task 4); `settingsData.dsmPublicUrl`, `settingsData.phoneSetup` (Task 4); `amAdmin` (Task 7); `openSettings('nas', 'calendar')`.
- Produces: `async function openPhoneSheet()`; the localStorage key `phone-setup-at` (an ISO date).

- [ ] **Step 1: The sheet, with the address set.** Title **Set up your iPhone** and a **Done** button. Then, verbatim from the spec: the paragraph; two checkboxes, both on, **Household calendar** in Apple Calendar ("A CalDAV account for <account> at your NAS. The phone asks for your NAS password once.") and **Home Planner** on the Home Screen ("Opens full screen at the household's address, like Add to Home Screen"); the code area; **Download the profile for a Mac**, an `<a download>` to `` `/api/phone-setup/profile?calendar=${c ? 1 : 0}&home=${h ? 1 : 0}&origin=${encodeURIComponent(location.origin)}` ``; a `<details>` **Type it instead** with the iPhone and Mac steps (from the old `phoneCalSec`), the server address `settingsData.phoneSetup.caldav`, the user name, "your NAS password", and the note that Synology Calendar shows the same address under a calendar's menu, CalDAV Account; the closing line about reaching the NAS from outside, and that members who skip this lose nothing in the app.

- [ ] **Step 2: The code area.** On open and on each checkbox change, post `{ calendar, home, origin: location.origin }`; only the latest answer is drawn (a counter, as search does). The answer's `qr` is drawn at 164 px with the caption and the small print, verbatim. With both boxes off, no request is made and the area says "Tick at least one to make a code." A refusal shows the server's words in the area (Review Focus 3). A timer at `expiresAt` replaces the code with "This code has expired." and a **Make a new code** button.

- [ ] **Step 3: Before the address is set.** The spec says both "a dashed placeholder where the code would be" and "the sheet still offers the code with the calendar checkbox disabled and the Home Screen one on". Decision: the calendar checkbox is disabled and unticked, and under it sits the dashed box: "No code until the NAS's address is set", the sentence that a DSM administrator sets it once under Settings › This NAS › Where phones reach the NAS, and, for `amAdmin`, a button **Set the address ›** that closes the sheet and calls `openSettings('nas', 'calendar')`; for anyone else `` `Ask ${settingsData.phoneSetup.nasAdmin ?? 'an administrator'} to set it.` `` The Home Screen box stays on and the code area offers the Home Screen-only code; untick it and the code area shows the same dashed placeholder.

- [ ] **Step 4: Ways in, and marking the device.** `#me-phone` (**Set up your iPhone**) in the menu, and the `phone` row: title **Your iPhone and Mac**, status "Not set up on this device yet" or `` `Set up on this device on ${date}` `` from `localStorage['phone-setup-at']` (read and written inside try/catch), then "One scan puts the Household calendar and Home Planner on an iPhone."; action **Set up ›** → `openPhoneSheet()`. A code made, or the Mac link pressed, stores `new Date().toISOString()` under `phone-setup-at`. `phoneCalSec` is deleted.

- [ ] **Step 5: Check by hand.** With the address set: a QR appears; unticking one makes a new code; both off says so; the Mac link downloads `home-planner.mobileconfig`; scanning (or opening the code's URL) once downloads the profile and a second time shows the expired page; the row then says "Set up on this device on <date>". With the address off: the dashed box, the admin's button opening Where phones reach the NAS, a member's "Ask <name> to set it.", and a Home Screen-only code. Opened over `http://` from another machine's name (not localhost), the area shows the server's words. At 375 px nothing scrolls sideways. `cd api && npm test`.

- [ ] **Step 6: Commit** — `"Set up your iPhone: a sheet with a one-time QR code, a download for a Mac, and the steps to type it instead"`

---

## Phase 3: The words

### Task 10: DEPLOY, README and the check's README

**Files:**
- Modify: `DEPLOY.md` (line 18, the troubleshooting rows ~104-120, ~156-184, the variable table ~214-241, `## Connectors` ~269-370, `## Calendar on the NAS` ~371-420), `README.md` (`## How it is configured` ~102-150, and one sentence near ~77), `api/tools/synology-check/README.md` (line 315 only)

- [ ] **Step 1: DEPLOY.md.** `## Connectors` becomes `## Settings › This NAS` (fix every `#connectors` anchor), its table names the rows Where phones reach the NAS and Booking address; every "on Connectors" becomes "under Settings › This NAS"; "under the person icon" becomes "in Settings, under This NAS". In Calendar on the NAS, the phone paragraph describes: the sheet under the person menu; the QR's one-time link (`<planner origin>/setup/<code>`, ten minutes, once, one per member, kept in memory so a restart spends it); what the profile carries (a CalDAV account for the member at `DSM_PUBLIC_URL` with the principal `/caldav/<account>/`, and a web clip of the planner's origin); that it is unsigned and iOS says Not Verified; the address rule (the planner must be opened over https for a phone, http only on localhost); and the typed fallback at `<DSM_PUBLIC_URL>/caldav/<account>/`. Add `/setup/` beside `/book` wherever the proxy section lists the paths that must reach the app.

- [ ] **Step 2: README.md.** The configuration paragraphs name Settings › This NAS instead of a Connectors page under the person icon; add one sentence: "Members set up an iPhone or a Mac from Set up your iPhone: one scan of a QR code installs the Household calendar and Home Planner on the Home Screen."

- [ ] **Step 3: The check's README.** Line 315's "The Connectors and Settings pages" becomes "Settings, with its This NAS group,". Nothing else in that file changes.

- [ ] **Step 4: Verify.** `grep -n "Connectors\|Calendar on phones" DEPLOY.md README.md api/tools/synology-check/README.md` prints only `CONNECTORS_PATH`, `connectors.json` and `/api/connectors`. `cd api && npm test && npm run typecheck`.

- [ ] **Step 5: Commit** — `"The deployment notes and the README say This NAS, and how a phone is set up from a QR code"`
