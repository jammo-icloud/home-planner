// api/test/profile.test.ts
//
// The configuration profile a phone installs: read back through a small
// property-list parser, so the tests check what iOS would see.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfile, caldavPath, profileUuid, PROFILE_CONTENT_TYPE, PROFILE_FILENAME } from '../src/profile.ts';
import type { ProfileInput } from '../src/profile.ts';
import { parsePlist } from './plist.ts';

const base: ProfileInput = {
  member: 'alex',
  household: 'Larkspur House',
  dsmPublicUrl: 'https://nas.example.com:5001',
  origin: 'https://planner.example.com',
  calendar: true,
  home: true,
  iconPng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};

const content = (o: ProfileInput): any[] => (parsePlist(buildProfile(o)) as any).PayloadContent;

test('the outer payload is a Configuration named for the member', () => {
  const p = parsePlist(buildProfile(base)) as any;
  assert.equal(p.PayloadType, 'Configuration');
  assert.equal(p.PayloadVersion, 1);
  assert.equal(p.PayloadIdentifier, 'name.homeplanner.setup.alex');
  assert.equal(p.PayloadDisplayName, 'Home Planner');
  assert.equal(p.PayloadDescription, 'The Household calendar in Apple Calendar, and Home Planner on your Home Screen.');
  assert.equal(p.PayloadOrganization, 'Larkspur House');
  assert.equal(p.PayloadRemovalDisallowed, false);
  assert.match(p.PayloadUUID, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

test('the CalDAV payload is read from the public address', () => {
  const [cal] = content({ ...base, home: false });
  assert.deepEqual(Object.keys(cal).sort(), ['CalDAVAccountDescription', 'CalDAVHostName', 'CalDAVPort', 'CalDAVPrincipalURL',
    'CalDAVUseSSL', 'CalDAVUsername', 'PayloadDisplayName', 'PayloadIdentifier', 'PayloadType', 'PayloadUUID', 'PayloadVersion']);
  assert.equal(cal.PayloadType, 'com.apple.caldav.account');
  assert.equal(cal.PayloadDisplayName, 'Household calendar');
  assert.equal(cal.PayloadIdentifier, 'name.homeplanner.setup.alex.caldav');
  assert.equal(cal.CalDAVAccountDescription, 'Household calendar (NAS)');
  assert.equal(cal.CalDAVHostName, 'nas.example.com');
  assert.equal(cal.CalDAVPort, 5001);
  assert.equal(cal.CalDAVUseSSL, true);
  assert.equal(cal.CalDAVUsername, 'alex');
  assert.equal(cal.CalDAVPrincipalURL, '/caldav/alex/');
});

test('an address with no port is 443 over https and 80 over http', () => {
  const [secure] = content({ ...base, home: false, dsmPublicUrl: 'https://nas.example.com' });
  assert.equal(secure.CalDAVPort, 443);
  assert.equal(secure.CalDAVUseSSL, true);
  const [plain] = content({ ...base, home: false, dsmPublicUrl: 'http://nas.example.com' });
  assert.equal(plain.CalDAVPort, 80);
  assert.equal(plain.CalDAVUseSSL, false);
});

test('the web clip opens the kept origin full screen with the icon', () => {
  const [clip] = content({ ...base, calendar: false });
  assert.equal(clip.PayloadType, 'com.apple.webClip.managed');
  assert.equal(clip.PayloadDisplayName, 'Home Planner');
  assert.equal(clip.PayloadIdentifier, 'name.homeplanner.setup.alex.webclip');
  assert.equal(clip.Label, 'Home Planner');
  assert.equal(clip.URL, 'https://planner.example.com');
  assert.equal(clip.FullScreen, true);
  assert.equal(clip.IsRemovable, true);
  assert.equal(clip.Precomposed, true);
  assert.deepEqual(clip.Icon, base.iconPng);
});

test('no icon leaves the Icon key out', () => {
  const [clip] = content({ ...base, calendar: false, iconPng: null });
  assert.ok(!('Icon' in clip));
});

test('exactly the payloads asked for, calendar first', () => {
  assert.deepEqual(content(base).map(p => p.PayloadType), ['com.apple.caldav.account', 'com.apple.webClip.managed']);
  assert.deepEqual(content({ ...base, home: false }).map(p => p.PayloadType), ['com.apple.caldav.account']);
  assert.deepEqual(content({ ...base, calendar: false }).map(p => p.PayloadType), ['com.apple.webClip.managed']);
});

test('the same member and flags give the same UUIDs; other flags another', () => {
  assert.equal(buildProfile(base), buildProfile(base));
  const a = parsePlist(buildProfile(base)) as any;
  const b = parsePlist(buildProfile({ ...base, home: false })) as any;
  assert.notEqual(a.PayloadUUID, b.PayloadUUID);
  assert.notEqual(a.PayloadContent[0].PayloadUUID, a.PayloadContent[1].PayloadUUID);
});

test('an account with XML and URL characters is escaped', () => {
  const xml = buildProfile({ ...base, member: "o'neil & <co>", household: 'A & B' });
  const p = parsePlist(xml) as any;
  assert.equal(p.PayloadOrganization, 'A & B');
  assert.equal(p.PayloadContent[0].CalDAVUsername, "o'neil & <co>");
  assert.equal(p.PayloadContent[0].CalDAVPrincipalURL, `/caldav/${encodeURIComponent("o'neil & <co>")}/`);
  assert.equal(p.PayloadIdentifier, 'name.homeplanner.setup.o-neil----co-');
  assert.ok(!/<co>/.test(xml));
});

test('a profile with nothing in it, or a payload missing what it needs, is refused', () => {
  assert.throws(() => buildProfile({ ...base, calendar: false, home: false }), /at least one/);
  assert.throws(() => buildProfile({ ...base, home: false, dsmPublicUrl: null }), /address/);
  assert.throws(() => buildProfile({ ...base, calendar: false, origin: null }), /origin/);
});

test('the helpers: path, uuid shape, and the download names', () => {
  assert.equal(caldavPath('alex'), '/caldav/alex/');
  assert.match(profileUuid('x'), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.equal(profileUuid('x'), profileUuid('x'));
  assert.equal(PROFILE_CONTENT_TYPE, 'application/x-apple-aspen-config');
  assert.equal(PROFILE_FILENAME, 'home-planner.mobileconfig');
});
