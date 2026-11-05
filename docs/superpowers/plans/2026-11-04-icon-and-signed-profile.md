# A real icon and a signed calendar profile: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app has an icon that is a picture (Lucide's house-heart on the app's blue) everywhere a browser or a phone shows one, and the calendar profile goes out signed by the NAS's own Let's Encrypt certificate so iOS says Verified instead of Not Signed.

**Architecture:** The icon is one source SVG rendered to PNGs by the existing `make-icon` tool, which now drives a renderer the Mac already has (Quick Look's `qlmanage`, or `rsvg-convert` when present) instead of writing a flat square by hand; the PNGs are committed and a test decodes them. Signing is a new module `api/src/sign.ts` that reads DSM's certificate files from a directory on the data volume, inspects them with Node's own `X509Certificate`, and signs the profile XML with the `openssl smime` command, which the image gains. The directory is filled by a DSM Task Scheduler job documented in DEPLOY.md; the app never touches DSM's own certificate store. Settings and Today say whether the profile is signed and warn an administrator before the certificate expires.

**Tech Stack:** Node 22+ native TypeScript (`--experimental-strip-types`), `node:test`, `node:crypto` X509Certificate, `openssl` CLI (LibreSSL on the Mac, OpenSSL on Alpine), vanilla JS page.

**Spec:** This file is its own spec; James's rulings were given in chat on 2026-11-04: house-heart from Lucide, the certificate on DSM is Let's Encrypt, signing may read a copy of it from the data volume.

## Global Constraints

- Commit with `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. The message is a plain sentence, no conventional-commit prefix, ending with a blank line and exactly this trailer, whatever model you are: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`, or anything under `.claude/`.
- Nothing in the tree may name the household: no real domain, no private IP, no first names, no banks or vendors. Examples use `planner.example.com`, `nas.example.com`, `alex` and `bob`.
- No new npm dependencies. The image stays `node:26-alpine`.
- A private key is never logged, never read into a log line, never copied anywhere by the app. The app only passes file paths to openssl.
- Tests: `cd api && npm test` (1746 pass at the base commit) and `npm run typecheck` must stay green after every task.
- Copy on the page is in sentences, in the voice of the rest of Settings: plain words, no exclamation marks, "iOS" and "Apple Calendar" as Apple writes them.

## Review Focus

1. **A certificate directory that exists but holds an unreadable key** (root-owned, mode 600, before the DSM task's chown ran): the profile must still download, unsigned, and Settings must say why. Pinned in Task 2's "unreadable" test.
2. **An expired certificate**: iOS shows an expired signature in red too, so the profile goes out unsigned and the administrator is told. Pinned in Task 2 ("expired") and Task 3 (the Today notice).
3. **openssl missing or failing at request time** (a laptop without it, a malformed file): the download falls back to the plain XML with one log line that names no file contents. Pinned in Task 2's "openssl failure falls back" test.
4. **A Home Screen icon with transparent corners goes black on iOS.** The SVG is full-bleed, and Task 1's test asserts every corner pixel of `icon-180.png` is the blue, fully opaque.
5. **The 16-pixel favicon must still read as a house.** Task 1 renders 16 and 32 from the same SVG; the reviewer checks the 16 by eye in the task review (the Read tool shows PNGs).

---

### Task 1: The icon is house-heart, rendered, everywhere

**Files:**
- Modify: `site/icon.svg` (rewrite), `site/manifest.webmanifest`, `site/index.html:14-19`, `site/book.html` (head)
- Create: `site/mask-icon.svg`, `site/icon-32.png`, `site/icon-192.png`, `site/icon-512.png`, `site/favicon.ico`
- Replace: `site/icon-180.png` (rendered, no longer flat)
- Rewrite: `api/tools/make-icon.ts`
- Rewrite: `api/test/make-icon.test.ts`

**Interfaces:**
- Produces: `api/tools/make-icon.ts` exports `decodePng(png: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Uint8Array }` (8-bit colour types 2 and 6, all five scanline filters, no interlace; throws otherwise), `icoOf(pngs: readonly Buffer[]): Buffer` (an ICO whose entries are PNG payloads, sizes read from each IHDR), and `render(svgPath: string, size: number): Promise<Buffer>` (a PNG of the SVG at `size`, via `rsvg-convert` when on PATH, else `qlmanage -t -s <size> -o <tmpdir>`; throws naming both tools when neither works). Run as a script (`npm run make-icon` from `api/`) it writes the five PNGs and `favicon.ico` under `site/`.

- [ ] **Step 1: Write `site/icon.svg`**

Full-bleed, 512 by 512, no rounded corners (iOS masks the icon itself, and a transparent corner turns black on a Home Screen): `<rect width="512" height="512" fill="#0C8CE9"/>`, then Lucide's `house-heart` paths (copied exactly from lucide.dev, which is ISC licensed, as the page's tab icons already are at `site/index.html:6079`) in a `<g>` scaled so the 24-unit glyph fills 70% of the tile and sits centred: `transform="translate(76.8 76.8) scale(14.933)"`, `fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"`. `role="img" aria-label="Home Planner"`. A one-line comment credits Lucide and the licence. The two paths:

```
M8.62 13.8A2.25 2.25 0 1 1 12 10.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z
M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z
```

- [ ] **Step 2: Write `site/mask-icon.svg`**

Safari's pinned-tab icon: viewBox `0 0 24 24`, the same two paths, `fill="none" stroke="#000" stroke-width="2"`, round caps and joins, no rect. Safari colours it from the link's `color` attribute.

- [ ] **Step 3: Write the failing tests in `api/test/make-icon.test.ts`**

Replace the file. Tests:

```ts
test('each committed PNG is the size its name says and is a picture, not a square of one colour', ...)
// for 32, 180, 192, 512: decodePng(readFileSync(site(`icon-${n}.png`))) has width === height === n,
// the four corner pixels are within ±3 of [12, 140, 233] and, when channels === 4, alpha 255,
// and at least one pixel in the middle third has r, g and b all >= 235 (the white house).

test('favicon.ico holds the 16 and 32 pixel PNGs', ...)
// header: reserved 0, type 1, count 2; each entry's payload at its offset starts with the PNG signature
// and decodes to 16×16 and 32×32 respectively.

test('decodePng undoes every filter', ...)
// build a 3×2 RGB PNG by hand (reuse a small encoder in the test) with rows filtered Sub and Up,
// and assert the decoded pixels equal the source.

test('icoOf reads each entry size from the PNG itself', ...)
// icoOf([png16, png32]) entry widths are 16 and 32 (0 means 256; not needed here).
```

The old test "the committed icon is the one the script makes" goes: the renderer is not byte-stable across machines.

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd api && node --test --experimental-strip-types test/make-icon.test.ts`
Expected: FAIL, `decodePng` is not exported, and the PNG files are missing.

- [ ] **Step 5: Rewrite `api/tools/make-icon.ts`**

Keep the file's purpose comment, rewritten for what it now does. Implement `render`, `decodePng`, `icoOf` as in Interfaces. `render` writes the SVG's PNG via `execFile` (`node:child_process`, promisified) into a `mkdtemp` directory and reads it back; `qlmanage` names its output `<basename>.png`. The script body (guarded by `import.meta.main`-style check as the file does today, or `process.argv[1]` comparison) renders 16, 32, 180, 192 and 512, writes `icon-32.png`, `icon-180.png`, `icon-192.png`, `icon-512.png` and `favicon.ico` (16 then 32) under `site/`. Alpha stays as rendered; the SVG is opaque so every pixel is.

- [ ] **Step 6: Make the files**

Run: `cd api && npm run make-icon`
Expected: the six files under `site/` are written; `file site/icon-180.png` says `180 x 180`.
Then look at `site/icon-180.png` and `site/icon-32.png` with the Read tool: a white house with a heart on blue, nothing clipped.

- [ ] **Step 7: Run the tests to see them pass**

Run: `cd api && node --test --experimental-strip-types test/make-icon.test.ts`
Expected: PASS.

- [ ] **Step 8: Name the icons in the page, the booking page and the manifest**

`site/index.html` head, replacing lines 15–19 (keep the manifest line and the comments' spirit):

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/icon-180.png" />
<link rel="mask-icon" href="/mask-icon.svg" color="#0C8CE9" />
```

Safari ignores an SVG favicon, which is why the `.ico` comes first. `site/book.html`: add the first three of those lines to its head (it has no manifest). `site/manifest.webmanifest` icons:

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
  { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
]
```

`api/src/server.ts:600` MIME already has `.ico`, `.png`, `.svg`; nothing to add there. Check `api/test/pages.test.ts` and `page-drift.test.ts` for assertions on the head's link tags and update them if any.

- [ ] **Step 9: Whole suite, then commit**

Run: `cd api && npm test && npm run typecheck`
Expected: all pass.

```bash
git add site/icon.svg site/mask-icon.svg site/icon-32.png site/icon-180.png site/icon-192.png site/icon-512.png site/favicon.ico site/manifest.webmanifest site/index.html site/book.html api/tools/make-icon.ts api/test/make-icon.test.ts
git commit  # "The icon is a house with a heart, rendered for the Home Screen, the tab and the manifest"
```

---

### Task 2: The profile is signed when the NAS's certificate is there

**Files:**
- Create: `api/src/sign.ts`, `api/test/sign.test.ts`
- Modify: `api/src/server.ts` (`sendProfile` ~574, the `/setup/:code` route ~1733, `/api/phone-setup/profile` ~2044, the startup log near 1287), `api/Dockerfile` (the `apk add` line and an `ENV`), `docker.yml`, `docker-compose.yml`, `api/test/server-phone-setup.test.ts`

**Interfaces:**
- Produces, in `api/src/sign.ts`:

```ts
export type SigningStatus =
  | { readonly signed: true; readonly signedAs: string; readonly validTo: string }     // validTo ISO 8601
  | { readonly signed: false; readonly reason: 'no-directory' | 'no-certificate' | 'unreadable' | 'expired' | 'invalid' };
export interface Signer { readonly cert: string; readonly key: string; readonly chain: string | null; readonly signedAs: string; readonly validTo: string }
/** Reads cert.pem, privkey.pem and (optionally) chain.pem from `dir`; never throws. */
export function loadSigner(dir: string | undefined, now?: () => number): Promise<{ signer: Signer | null; status: SigningStatus }>;
/** `openssl smime -sign … -nodetach -outform DER`, the XML on stdin, DER on stdout. Rejects on any openssl failure. */
export function signProfile(xml: string, signer: Signer): Promise<Buffer>;
/** The signed DER when the directory yields a signer and openssl succeeds, else the XML; one console.warn line on an openssl failure, naming the reason and never a file's contents. */
export function signedOrPlain(xml: string, dir: string | undefined): Promise<Buffer | string>;
```

- `PROFILE_CERT_DIR` is the environment variable, read through `resolvedEnv()` from `api/src/connectors.ts` like `DSM_PUBLIC_URL` is (so an empty string means unset). Task 3 calls `loadSigner` for its status.

- [ ] **Step 1: Write the failing tests in `api/test/sign.test.ts`**

A `before` makes a temp dir and, with `openssl req -x509 -newkey rsa:2048 -nodes -keyout privkey.pem -out cert.pem -days 3 -subj /CN=planner.example.com -addext subjectAltName=DNS:planner.example.com`, a self-signed certificate (if `openssl version` fails, every test in the file is `test.skip` with the reason). `chain.pem` is a copy of `cert.pem`.

```ts
test('a directory with a certificate signs as its DNS name until its expiry', ...)
// loadSigner(dir): status.signed === true, signedAs === 'planner.example.com', validTo parses within 3 days of now.
test('the signature wraps the exact profile and openssl can verify it', ...)
// const der = await signProfile(xml, signer); der[0] === 0x30;
// execFile('openssl', ['smime', '-verify', '-noverify', '-inform', 'DER'], der on stdin) → stdout, with \r\n → \n, equals xml.
test('no directory, a missing certificate, an unreadable key, an expired certificate, a bad file', ...)
// undefined → 'no-directory'; an empty dir → 'no-certificate'; chmod 000 on privkey.pem → 'unreadable' (skipped when process.getuid() === 0);
// now = Date.now() + 10 days → 'expired'; cert.pem containing "not a certificate" → 'invalid'.
test('signedOrPlain falls back to the XML when openssl cannot sign', ...)
// a dir whose privkey.pem is a valid-looking but wrong key (a second generated key for another cert) → returns the string xml,
// and console.warn was called once with a message containing 'profile signing' and not containing '-----BEGIN'.
```

- [ ] **Step 2: Run to see them fail**

Run: `cd api && node --test --experimental-strip-types test/sign.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `api/src/sign.ts`**

`loadSigner`: `dir` undefined or '' → no-directory; `stat` fails → no-directory; `cert.pem` missing → no-certificate; `privkey.pem` missing → no-certificate; either unreadable (EACCES on `access(R_OK)`) → unreadable; `new X509Certificate(certPem)` throws → invalid; `validTo <= now()` → expired. `signedAs` is the first `DNS:` entry of `subjectAltName`, else the subject's `CN=`, else 'the certificate'. `chain` is `chain.pem` when readable, else null. `signProfile`: `execFile('openssl', ['smime', '-sign', '-signer', cert, '-inkey', key, ...(chain ? ['-certfile', chain] : []), '-nodetach', '-outform', 'DER'], { encoding: 'buffer', maxBuffer: 4 << 20 })`, the XML written to stdin. `signedOrPlain` composes the two.

- [ ] **Step 4: Wire the server**

`sendProfile(res, body: string | Buffer, head)`: same headers, `res.end(head ? undefined : body)`. Both routes: `const dir = resolvedEnv()['PROFILE_CERT_DIR'] || undefined; return sendProfile(res, await signedOrPlain(xml, dir), head)`. HEAD still needs no signing: send the headers only. At startup, beside the admin line at ~1287, one line: `[budget] profile signing: signed as <signedAs> until <date>` or `[budget] profile signing: off (<reason>)`.

- [ ] **Step 5: The image and the compose files**

`api/Dockerfile`: `RUN apk add --no-cache su-exec openssl` with the comment extended ("openssl signs the calendar profile; see DEPLOY.md, Signing the calendar profile"), and after `ENV CONNECTORS_PATH` a commented `ENV PROFILE_CERT_DIR=/data/cert`. `docker.yml` environment: `PROFILE_CERT_DIR: "${PROFILE_CERT_DIR:-/data/cert}"` with a comment pointing at DEPLOY.md; `docker-compose.yml`: `PROFILE_CERT_DIR: "${PROFILE_CERT_DIR:-}"` with a comment that a laptop leaves it empty and the profile goes out unsigned.

- [ ] **Step 6: Server test**

In `api/test/server-phone-setup.test.ts` add, using the same openssl-generated certificate (skip when openssl is missing): with `PROFILE_CERT_DIR` pointed at it (set via `saveConnector`? No: `resolvedEnv` merges saved connector rows over `process.env`; set `process.env.PROFILE_CERT_DIR` before the request), `GET /api/phone-setup/profile` answers `application/x-apple-aspen-config` and a body whose first byte is 0x30 and which `openssl smime -verify -noverify -inform DER` turns back into a plist that `parsePlist` reads with `PayloadDisplayName === 'Home Planner'`; with the variable deleted, the body is the XML as before. `HEAD /setup/:code` still answers headers and no body.

- [ ] **Step 7: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass.

```bash
git add api/src/sign.ts api/test/sign.test.ts api/src/server.ts api/Dockerfile docker.yml docker-compose.yml api/test/server-phone-setup.test.ts
git commit  # "The calendar profile is signed with the NAS's certificate when a copy of it is on the volume"
```

---

### Task 3: Settings and Today say whether the profile is signed

**Files:**
- Modify: `api/src/server.ts` (the settings payload's `phoneSetup` ~1149, the `/api/today` route ~2682), `api/src/setup.ts` (`NoticeKind`, `setupNotices`), `site/index.html` (`phoneAddButton` ~8003 and the `phoneSheet` data flow ~7891), `api/test/setup.test.ts`, `api/test/server-settings.test.ts` or `server-phone-setup.test.ts`

**Interfaces:**
- Consumes: `loadSigner` and `SigningStatus` from Task 2.
- Produces: the settings payload's `phoneSetup.signing: SigningStatus`; `setupNotices` takes `signing: SigningStatus` and may push `{ kind: 'certificate', text }` for an administrator.

- [ ] **Step 1: Failing tests**

`api/test/setup.test.ts`:

```ts
test('an administrator is warned 30 days before the profile certificate expires', ...)
// signing: { signed: true, signedAs: 'planner.example.com', validTo: <now + 12 days> }, admin: true
// → one notice kind 'certificate', text 'The certificate that signs the calendar profile expires in 12 days. Check the NAS task that copies it.'
// admin: false → none. validTo now + 45 days → none. validTo now + 1 day → 'expires tomorrow'; same day → 'expires today'.
test('an expired certificate tells the administrator the profile goes out unsigned', ...)
// signing: { signed: false, reason: 'expired' }, admin → 'The certificate that signs the calendar profile has expired, so the profile goes out unsigned. Check the NAS task that copies it.'
// reasons other than 'expired' → no notice (unsigned by choice is not a fault).
```

Server test: the settings JSON has `phoneSetup.signing.signed === false` with `reason: 'no-directory'` when the variable is unset, and `signed === true` with `signedAs: 'planner.example.com'` when it points at the test certificate.

- [ ] **Step 2: Run to see them fail**

Run: `cd api && node --test --experimental-strip-types test/setup.test.ts`
Expected: FAIL on the unknown `signing` option / missing notices.

- [ ] **Step 3: Implement**

`setup.ts`: add `'certificate'` to `NoticeKind`; `setupNotices` takes `signing: SigningStatus` and `today: Day` (or computes days from `Date.now()`, whichever the existing code's clock pattern supports; use the same clock the file already uses for `moving`). Days left = whole days between now and `validTo`, floor. `server.ts`: `const signing = (await loadSigner(dir)).status` in both the settings payload and `/api/today`. Page: `phoneAddButton` reads `settingsData.phoneSetup.signing`; the paragraph beside the button becomes

- signed: `Opens as a profile: Settings → Profile Downloaded → Install. It is signed as <signedAs>, so iOS shows it as Verified.`
- unsigned: `Opens as a profile: Settings → Profile Downloaded → Install. It is not signed, so iOS shows "Not Signed" in red; it installs all the same.` and, when `amAdmin` (`site/index.html:10374`), a following sentence `To sign it, see DEPLOY.md, Signing the calendar profile.`

The notice card on Today already renders any `setup` notice by its text; confirm `kind: 'certificate'` needs no new icon mapping on the page (look at how `connectors` is drawn near `site/index.html:2475`), and add one if kinds are switched on.

- [ ] **Step 4: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass.

```bash
git add api/src/setup.ts api/src/server.ts site/index.html api/test/setup.test.ts api/test/server-phone-setup.test.ts
git commit  # "Settings says whether the calendar profile is signed, and Today warns an administrator before the certificate runs out"
```

---

### Task 4: Deploy notes, the README and version 0.3.1

**Files:**
- Modify: `DEPLOY.md` (Environment table ~210, a new section after "## TLS" ~878), `README.md` (Calendar section ~72, On the NAS ~140), `api/package.json` (version), `api/package-lock.json` (its two version fields)

- [ ] **Step 1: DEPLOY.md**

Environment table row: `PROFILE_CERT_DIR` | unset (`/data/cert` in the image) | The folder the app reads `cert.pem`, `privkey.pem` and `chain.pem` from to sign the calendar profile. Empty, or a folder with no certificate, means the profile goes out unsigned and iOS marks it Not Signed. See Signing the calendar profile.

New section `## Signing the calendar profile`, after TLS:

- Why: iOS marks an unsigned configuration profile Not Signed in red; one signed by a certificate iOS trusts, such as Let's Encrypt, shows Verified. The NAS already has that certificate from step 6 of the install; the app only needs a copy it can read. DSM keeps its certificates root-only, and the container runs as an unprivileged user, so a bind mount of DSM's store does not work. A DSM task copies them instead.
- The task: Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script. User `root`, daily, early morning (Let's Encrypt renews at night). The script, with `planner.example.com` and the project folder to change:

```sh
#!/bin/sh
# Copies the Let's Encrypt certificate for planner.example.com into Home
# Planner's data folder, where the app signs the calendar profile with it.
set -eu
host=planner.example.com
dest=/volume1/docker/home-planner/data/cert
for d in /usr/syno/etc/certificate/_archive/*/; do
  if openssl x509 -in "$d/cert.pem" -noout -text 2>/dev/null | grep -q "DNS:$host"; then
    mkdir -p "$dest"
    for f in cert.pem privkey.pem chain.pem; do
      install -m 600 -o 1000 -g 1000 "$d/$f" "$dest/$f"
    done
    exit 0
  fi
done
echo "no certificate for $host under /usr/syno/etc/certificate/_archive" >&2
exit 1
```

- Why `1000`: the app runs as the image's `node` user, uid 1000; the container gives `/data` to that user only when it starts, so files copied later must already be its.
- Run it once by hand (Task Scheduler → Run), then Settings › Set up your iPhone says "signed as planner.example.com" beside the button, and the container log says `profile signing: signed as …`. Today warns an administrator 30 days before the copy expires, which means the task has stopped running.
- What is and is not exposed: the private key is the same one the reverse proxy already serves https with; the copy is readable by the app's user only, lives beside the household logs, and is part of the `data` folder backup like the rest. The app never logs it and never sends it anywhere; openssl reads it from the path.

Also: in the TLS section's last paragraph, one sentence pointing here. In "Calendar on the NAS", wherever the profile and "Not Verified" are mentioned, update to the new wording and link the section.

- [ ] **Step 2: README.md**

In Calendar: one sentence that the profile is signed with the NAS's certificate when a copy is on the volume. In On the NAS: a bullet or sentence pointing at DEPLOY.md's Signing the calendar profile. Mention the new icon nowhere; it is not a feature.

- [ ] **Step 3: Version**

`api/package.json` `"version": "0.3.1"` and the matching two fields in `api/package-lock.json` (`npm version 0.3.1 --no-git-tag-version` from `api/` does both). Check `api/test/version.test.ts` does not pin the number.

- [ ] **Step 4: Suite, typecheck, identity sweep, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass.
Run: `grep -rniE 'mofamily|motown|192\.168|10\.0\.|jamesmorris' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude . | grep -v 'api/data\|\.jsonl'`
Expected: no output.

```bash
git add DEPLOY.md README.md api/package.json api/package-lock.json
git commit  # "Version 0.3.1: a signed calendar profile and the house-heart icon"
```
