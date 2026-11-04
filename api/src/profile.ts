/**
 * The configuration profile a phone installs to set itself up: the household
 * calendar as a CalDAV account on the NAS. The Home Screen icon is not in it:
 * that has its own QR, the page's address. It is a property list that iOS reads, written here
 * by hand so nothing is needed beyond Node.
 *
 * Nothing in it is secret. The CalDAV payload names the account but carries no
 * password, so the phone asks for it when the profile is installed.
 *
 * The UUIDs are derived from the member, not random, so
 * fetching the profile twice gives the same one and iOS replaces the install
 * rather than adding a second.
 */
import { createHash } from 'node:crypto';

export interface ProfileInput {
  member: string;               // the DSM account
  household: string;            // the household's label
  dsmPublicUrl: string | null;  // an origin, as dsmPublicUrl() answers it
}

export const PROFILE_CONTENT_TYPE = 'application/x-apple-aspen-config';
export const PROFILE_FILENAME = 'home-planner.mobileconfig';

/**
 * Where the account's calendars live on the NAS. This is the one constant to
 * change if a first real install shows iOS wants the bare `/caldav/` instead
 * (spec, The profile).
 */
export function caldavPath(account: string): string {
  return `/caldav/${encodeURIComponent(account)}/`;
}

/** A v4-shaped UUID, uppercase, taken from the sha256 of the seed. */
export function profileUuid(seed: string): string {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

type PlistValue = string | number | boolean | Buffer | PlistValue[] | { [key: string]: PlistValue };

function plistValue(v: PlistValue, pad: string): string {
  if (typeof v === 'string') return `${pad}<string>${escapeXml(v)}</string>`;
  if (typeof v === 'number') return `${pad}<integer>${Math.trunc(v)}</integer>`;
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (Buffer.isBuffer(v)) return `${pad}<data>${v.toString('base64')}</data>`;
  if (Array.isArray(v)) {
    return [`${pad}<array>`, ...v.map(x => plistValue(x, pad + '  ')), `${pad}</array>`].join('\n');
  }
  const lines = [`${pad}<dict>`];
  for (const [k, x] of Object.entries(v)) {
    lines.push(`${pad}  <key>${escapeXml(k)}</key>`, plistValue(x, pad + '  '));
  }
  lines.push(`${pad}</dict>`);
  return lines.join('\n');
}

/** The part of an identifier a member contributes: lowercase letters, digits and hyphens. */
const idPart = (member: string): string => member.toLowerCase().replace(/[^a-z0-9-]/g, '-');

export function buildProfile(o: ProfileInput): string {
  if (!o.dsmPublicUrl) throw new Error('the calendar needs the NAS public address, and none is set');
  const id = `name.homeplanner.setup.${idPart(o.member)}`;
  const url = new URL(o.dsmPublicUrl);
  const ssl = url.protocol === 'https:';
  const content: PlistValue[] = [{
    PayloadType: 'com.apple.caldav.account',
    PayloadVersion: 1,
    PayloadIdentifier: `${id}.caldav`,
    PayloadUUID: profileUuid(`${o.member}\0caldav`),
    PayloadDisplayName: 'Household calendar',
    CalDAVAccountDescription: 'Household calendar (NAS)',
    CalDAVHostName: url.hostname,
    // An address with no port means the scheme's own.
    CalDAVPort: url.port ? Number(url.port) : ssl ? 443 : 80,
    CalDAVUseSSL: ssl,
    CalDAVUsername: o.member,
    CalDAVPrincipalURL: caldavPath(o.member),
  }];

  const profile: PlistValue = {
    PayloadType: 'Configuration',
    PayloadVersion: 1,
    PayloadIdentifier: id,
    PayloadUUID: profileUuid(`${o.member}\0calendar`),
    PayloadDisplayName: 'Home Planner',
    PayloadDescription: 'The Household calendar in Apple Calendar.',
    PayloadOrganization: o.household,
    PayloadRemovalDisallowed: false,
    PayloadContent: content,
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(profile, ''),
    '</plist>',
    '',
  ].join('\n');
}
