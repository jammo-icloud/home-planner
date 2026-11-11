/**
 * What things cost where the household is.
 *
 * Public, measured data — not an opinion about a place. Every figure that comes
 * out of here carries the source it came from, the geography it was measured
 * over, and when it was measured, because those three things are the difference
 * between evidence and a guess that looks like evidence.
 *
 * This exists because of a specific mistake: an estimate of $5,700 a year for
 * homeowners insurance when the real figure was $1,800. A number with no
 * provenance is worse than no number, since it gets believed.
 *
 * Nothing here is ever applied. It produces a proposal you read and edit.
 */

import { parseDollars, cents } from './money.ts';
import { splitCsvLine } from './parse.ts';
import { STARTER_CATEGORIES } from './starter.ts';
import type { Cents } from './money.ts';
import type { Location } from './types.ts';

export interface Estimate {
  /** The category this is evidence about. */
  readonly category: string;
  /** The name a person sees for that category, the starter set's own label. */
  readonly label: string;
  readonly monthly: Cents;
  /** Named so nobody mistakes a county median for their own bill. */
  readonly source: string;
  readonly measuredOver: string;
  readonly asOf: string;
  /** What this figure cannot tell you. Always populated. */
  readonly caveat: string;
}

export interface LookupResult {
  readonly location: Location;
  readonly estimates: readonly Estimate[];
  /** Sources that were asked and had nothing for this place. */
  readonly missing: readonly string[];
}

/** The starter label for a category id, so every source names it the way an envelope does. */
function labelOf(id: string): string {
  return STARTER_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export type Fetch = typeof globalThis.fetch;

const ZORI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv';

/**
 * Zillow's observed rent index, by ZIP.
 *
 * Free and needs no key, which is why it is first. It is thin for small places:
 * a rural ZIP is simply absent rather than wrong, and saying "no data" is the
 * correct answer there.
 */
export async function rentFromZillow(
  postal: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<Estimate | null> {
  const res = await fetchImpl(ZORI_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Zillow returned ${res.status}`);
  const text = await res.text();

  // Split properly: Zillow quotes city names, and some of them contain commas.
  // Naive splitting shifted every column after one, which read a rent figure
  // correctly by luck and lost the date it was measured on.
  const lines = text.split(/\r?\n/);
  const header = lines[0] ? splitCsvLine(lines[0]) : [];
  const iZip = header.indexOf('RegionName');
  // The series starts after seven metadata columns. Find where by looking for a
  // date, rather than counting: scanning back past it read the city name as a
  // rent figure on any row whose whole series was blank.
  const iFirstMonth = header.findIndex((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.trim()));
  if (iZip < 0 || iFirstMonth < 0) throw new Error('Zillow changed the shape of that file');

  for (const line of lines) {
    if (!line.includes(postal)) continue; // cheap reject before the real parse
    const cols = splitCsvLine(line);
    if (cols[iZip] !== postal) continue;
    // The series runs to the present with trailing blanks where a month has not
    // been published; the last filled column is the most recent measurement.
    let latest = '';
    let column = '';
    for (let i = cols.length - 1; i >= iFirstMonth; i--) {
      if (cols[i]?.trim()) { latest = cols[i]!.trim(); column = header[i]?.trim() ?? ''; break; }
    }
    if (!latest) return null;
    return {
      category: 'rent',
      label: labelOf('rent'),
      monthly: parseDollars(Number(latest).toFixed(2)),
      source: 'Zillow Observed Rent Index',
      measuredOver: `ZIP ${postal}`,
      asOf: column.slice(0, 7),
      caveat: 'A typical asking rent for the whole ZIP, not for a particular house.',
    };
  }
  return null;
}

// ─── where a ZIP is ──────────────────────────────────────────────────────────

const ZCTA_COUNTY_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt';

/** State FIPS to the two letters state-level series are keyed on. */
const STATE_BY_FIPS: Readonly<Record<string, string>> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR',
};

export interface ZipPlace {
  readonly state: string;
  readonly stateFips: string;
  readonly countyFips: string;
  readonly county: string;
  /** How much of the ZIP's land is in that county, 0–1. */
  readonly share: number;
  /** Other counties the ZIP reaches into, largest first. */
  readonly others: readonly string[];
}

interface ZctaPart { readonly geoid: string; readonly county: string; readonly land: number }

/**
 * Parsed once per process. The file is the 2020 census geography and does not
 * change, unlike Zillow's index, which is refetched because it is republished
 * monthly. Keyed by the fetch it came through so a test's stand-in network
 * never leaks into another's.
 */
const zctaIndexes = new WeakMap<Fetch, Promise<Map<string, ZctaPart[]>>>();

async function zctaIndex(fetchImpl: Fetch): Promise<Map<string, ZctaPart[]>> {
  let pending = zctaIndexes.get(fetchImpl);
  if (!pending) {
    pending = (async () => {
      const res = await fetchImpl(ZCTA_COUNTY_URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`the Census returned ${res.status}`);
      const lines = (await res.text()).replace(/^\uFEFF/, '').split(/\r?\n/);
      // Columns found by name, so a reordered file is refused rather than misread.
      const header = (lines[0] ?? '').split('|');
      const iZip = header.indexOf('GEOID_ZCTA5_20');
      const iCounty = header.indexOf('GEOID_COUNTY_20');
      const iName = header.indexOf('NAMELSAD_COUNTY_20');
      const iLand = header.indexOf('AREALAND_PART');
      if ([iZip, iCounty, iName, iLand].some((i) => i < 0)) {
        throw new Error('the Census changed the shape of its ZIP-to-county file');
      }
      const index = new Map<string, ZctaPart[]>();
      for (const line of lines.slice(1)) {
        const cols = line.split('|');
        const zip = cols[iZip];
        const geoid = cols[iCounty];
        // Counties with no ZIP area in them have a blank ZIP column.
        if (!zip || !geoid || geoid.length !== 5) continue;
        const parts = index.get(zip) ?? [];
        parts.push({ geoid, county: cols[iName] ?? '', land: Number(cols[iLand]) || 0 });
        index.set(zip, parts);
      }
      return index;
    })();
    zctaIndexes.set(fetchImpl, pending);
    // A failed download is not kept, so the next lookup tries again.
    pending.catch(() => zctaIndexes.delete(fetchImpl));
  }
  return pending;
}

/**
 * Which state and county a ZIP is in, from the Census ZIP-to-county file.
 *
 * Free, needs no key, and covers every ZIP that has an area — including the
 * small rural ones Zillow's index leaves out. A ZIP that crosses a county line
 * is put in the county holding most of its land, and the others are kept so
 * the proposal can say so. A ZIP with no area of its own (a PO box) is not in
 * the file, and that is null rather than a guess.
 */
export async function placeForZip(postal: string, fetchImpl: Fetch = globalThis.fetch): Promise<ZipPlace | null> {
  const parts = (await zctaIndex(fetchImpl)).get(postal.trim());
  if (!parts?.length) return null;
  const sorted = [...parts].sort((a, b) => b.land - a.land);
  const top = sorted[0]!;
  const total = sorted.reduce((n, x) => n + x.land, 0);
  const stateFips = top.geoid.slice(0, 2);
  const state = STATE_BY_FIPS[stateFips];
  if (!state) return null;
  return {
    state, stateFips, countyFips: top.geoid.slice(2), county: top.county,
    share: total ? Math.round((top.land / total) * 100) / 100 : 1,
    others: sorted.slice(1).map((x) => x.county),
  };
}

/**
 * Census ACS five-year estimates, by county.
 *
 * Needs a free key — Census stopped serving anonymous requests. Without one this
 * returns nothing and says so, rather than pretending the place has no data.
 *
 * B25064 median gross rent, B25103 median real estate taxes paid.
 *
 * Checked against live replies on 2026-10-28. Two ordinary answers are not
 * JSON: a county with no figures is a 204 with an empty body, and a refused key
 * is a 200 carrying an HTML page titled "Invalid Key". Both are named rather
 * than surfacing as a parse error. The columns are checked by name before any
 * are read, because read by position a reordered table would file property tax
 * as rent.
 */
const ACS_YEAR = '2024';
const ACS_COLUMNS = ['NAME', 'B25064_001E', 'B25103_001E'] as const;

export async function censusCounty(
  loc: Location,
  key: string | undefined,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<Estimate[]> {
  if (!key) throw new Error('no CENSUS_API_KEY is set');
  if (!loc.stateFips || !loc.countyFips) throw new Error('no county is recorded for that location');

  const url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${ACS_COLUMNS.join(',')}`
    + `&for=county:${loc.countyFips}&in=state:${loc.stateFips}&key=${key}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`Census returned ${res.status}`);
  const text = await res.text();
  let rows: string[][];
  try {
    rows = JSON.parse(text) as string[][];
  } catch {
    if (/invalid key/i.test(text)) throw new Error('the key was refused — check CENSUS_API_KEY');
    throw new Error(`Census sent something that is not data (${res.headers.get('content-type') ?? 'no content-type'})`);
  }
  const header = Array.isArray(rows) ? rows[0] : undefined;
  if (!Array.isArray(header) || ACS_COLUMNS.some((c, i) => header[i] !== c)) {
    throw new Error(`Census returned columns this does not recognise (${Array.isArray(header) ? header.join(', ') : 'none'})`);
  }
  const row = rows[1];
  if (!row) return [];
  const [name, rent, tax] = row;

  const out: Estimate[] = [];
  if (rent && Number(rent) > 0) {
    out.push({
      category: 'rent',
      label: labelOf('rent'),
      monthly: parseDollars(Number(rent).toFixed(2)),
      source: 'US Census ACS 5-year, table B25064',
      measuredOver: name ?? 'the county',
      asOf: ACS_YEAR,
      caveat: 'A county-wide median across all sizes of home, and two years behind.',
    });
  }
  if (tax && Number(tax) > 0) {
    out.push({
      category: 'tax',
      label: labelOf('tax'),
      // Published annually; the budget holds monthly figures.
      monthly: cents(Math.round(parseDollars(Number(tax).toFixed(2)) / 12)),
      source: 'US Census ACS 5-year, table B25103',
      measuredOver: name ?? 'the county',
      asOf: ACS_YEAR,
      caveat: 'Median real estate taxes for owner-occupied homes across the county, '
        + 'divided by twelve. Your own assessment is what actually decides this.',
    });
  }
  return out;
}

/**
 * The average residential electricity bill in a state.
 *
 * EIA publishes revenue, customer count and sales for every state; the bill is
 * revenue divided by customers divided by twelve. That is arithmetic over
 * measured quantities rather than an estimate — but it is a state-wide average
 * across every household, which is a blunter instrument than a rent index for
 * one ZIP, and the caveat says so.
 *
 * Written from EIA's documented v2 format and checked against live replies on
 * 2026-10-28: revenue arrives in millions of dollars and customers as a count,
 * both as strings. It still refuses anything it does not recognise rather than
 * reaching into an unfamiliar object and returning a number that happens to parse.
 */
export async function electricityFromEia(
  loc: Location,
  key: string | undefined,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<Estimate | null> {
  if (!key) throw new Error('no EIA_API_KEY is set');
  if (!loc.state) throw new Error('no state is recorded for that location');

  const url = 'https://api.eia.gov/v2/electricity/retail-sales/data/'
    + '?frequency=annual&data[0]=revenue&data[1]=customers&data[2]=price'
    + `&facets[stateid][]=${encodeURIComponent(loc.state)}&facets[sectorid][]=RES`
    + '&sort[0][column]=period&sort[0][direction]=desc&length=1'
    + `&api_key=${key}`;

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`EIA returned ${res.status}`);
  const body = await res.json() as { response?: { data?: Record<string, unknown>[] } };
  const row = body.response?.data?.[0];
  if (!row) return null;

  // Revenue is published in millions of dollars, for the whole year.
  const revenueMillions = Number(row['revenue']);
  const customers = Number(row['customers']);
  const period = String(row['period'] ?? '');
  if (!Number.isFinite(revenueMillions) || !Number.isFinite(customers) || customers <= 0) {
    throw new Error('EIA returned a row without usable revenue and customer figures');
  }

  const monthly = (revenueMillions * 1_000_000) / customers / 12;
  // A state-wide average residential bill lives between about $50 and $300.
  // Bounding it at $10 and $1,000 leaves room for anywhere unusual while still
  // catching a units change: revenue moving from millions to dollars would
  // still divide cleanly and produce a number six orders of magnitude out.
  // A wrong number that parses is worse than no number.
  if (!Number.isFinite(monthly) || monthly < 10 || monthly > 1_000) {
    throw new Error(`EIA gave an average bill of ${monthly.toFixed(2)}, which is not credible — `
      + 'the published units have probably changed');
  }

  const price = Number(row['price']);
  return {
    category: 'elec',
    label: labelOf('elec'),
    monthly: parseDollars(monthly.toFixed(2)),
    source: 'US EIA, electricity retail sales'
      + (Number.isFinite(price) ? ` (${price.toFixed(1)}¢/kWh residential)` : ''),
    measuredOver: `the state of ${loc.state}`,
    asOf: period,
    caveat: 'Total residential revenue divided by customers, across the whole state and averaged '
      + 'over a year. Your own house, its heating and the season all move this a long way.',
  };
}

/**
 * Everything the public sources will say about a place.
 *
 * A source that has nothing is listed in `missing` rather than dropped: knowing
 * that Zillow does not cover a rural ZIP is itself worth reading, and stops the
 * silence being mistaken for a zero.
 */
export async function lookUp(
  loc: Location,
  opts: { censusKey?: string | undefined; eiaKey?: string | undefined; fetchImpl?: Fetch } = {},
): Promise<LookupResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const estimates: Estimate[] = [];
  const missing: string[] = [];

  if (loc.postal) {
    try {
      const rent = await rentFromZillow(loc.postal, fetchImpl);
      if (rent) estimates.push(rent); else missing.push(`Zillow has no rent index for ZIP ${loc.postal}`);
    } catch (err) {
      missing.push(`Zillow could not be reached: ${(err as Error).message}`);
    }
  } else {
    missing.push('no ZIP recorded, so rent data could not be looked up');
  }

  try {
    const elec = await electricityFromEia(loc, opts.eiaKey, fetchImpl);
    if (elec) estimates.push(elec); else missing.push(`EIA had no figures for ${loc.state}`);
  } catch (err) {
    missing.push(`EIA: ${(err as Error).message}`);
  }

  try {
    const rows = await censusCounty(loc, opts.censusKey, fetchImpl);
    if (rows.length) {
      // Prefer the ZIP-level rent when there is one; a county median is a
      // fallback, not a second opinion.
      for (const r of rows) {
        if (r.category === 'rent' && estimates.some((e) => e.category === 'rent')) continue;
        estimates.push(r);
      }
    } else {
      missing.push('Census had no figures for that county');
    }
  } catch (err) {
    missing.push(`Census: ${(err as Error).message}`);
  }

  return { location: loc, estimates, missing };
}
