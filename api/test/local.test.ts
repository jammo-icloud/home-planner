import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { rentFromZillow, censusCounty, electricityFromEia, lookUp, placeForZip } from '../src/local.ts';
import { fmt } from '../src/money.ts';

/** The real shape of Zillow's file: trailing months are blank until published. */
const ZORI = [
  'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,2026-04-30,2026-05-31,2026-06-30',
  '61639,300,12345,zip,OH,OH,Lakeside,3850.11,3880.4,3909.22',
  '61700,900,54322,zip,NM,NM,Ridgefield,1610.5,1622.75,',
  '61800,999,99999,zip,XX,XX,Nowhere,,,',
].join('\n');

const zillow = (body = ZORI, ok = true) =>
  (async () => ({ ok, status: ok ? 200 : 503, text: async () => body })) as unknown as typeof globalThis.fetch;

/**
 * A Census reply as it arrives: a status, a content type and a body. Census
 * answers some ordinary questions with things that are not JSON — see the
 * replies recorded below.
 */
const censusReply = (status: number, body: string, type = 'application/json;charset=utf-8') => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ 'content-type': type }),
  text: async () => body,
  json: async () => JSON.parse(body),
});
const census = (rows: unknown) =>
  (async () => censusReply(200, JSON.stringify(rows))) as unknown as typeof globalThis.fetch;

describe('rent, from a published index', () => {
  test('the latest published month is used, not the last column', async () => {
    const e = (await rentFromZillow('12345', zillow()))!;
    assert.equal(fmt(e.monthly), '$3,909');
    assert.equal(e.asOf, '2026-06');
  });

  test('a series that stops early reports the month it actually stopped', async () => {
    // The file carries trailing blanks. Reading the last column would give an
    // empty string; reading the last *filled* one gives a real measurement and
    // an honest date for it.
    const e = (await rentFromZillow('54322', zillow()))!;
    assert.equal(fmt(e.monthly), '$1,623');
    assert.equal(e.asOf, '2026-05');
  });

  test('a ZIP with no data returns nothing rather than zero', async () => {
    assert.equal(await rentFromZillow('99999', zillow()), null);
    assert.equal(await rentFromZillow('00000', zillow()), null);
  });

  test('every figure carries where it came from and what it cannot tell you', async () => {
    const e = (await rentFromZillow('12345', zillow()))!;
    assert.match(e.source, /Zillow/);
    assert.equal(e.measuredOver, 'ZIP 12345');
    assert.ok(e.caveat.length > 20, 'a number with no caveat gets believed');
    assert.match(e.caveat, /not for a particular house/);
  });

  test('an unreachable source is an error, never an empty answer', async () => {
    await assert.rejects(() => rentFromZillow('12345', zillow('', false)), /503/);
  });
});

describe('county figures, from the Census', () => {
  const loc = { label: 'Ridgefield County, OH', stateFips: '39', countyFips: '055' };
  const rows = [
    ['NAME', 'B25064_001E', 'B25103_001E', 'state', 'county'],
    ['Ridgefield County, Coldwater', '1350', '2400', '39', '055'],
  ];

  test('annual property tax is divided into the monthly figure a budget holds', async () => {
    const out = await censusCounty(loc, 'k', census(rows));
    const tax = out.find((e) => e.category === 'tax')!;
    assert.equal(fmt(tax.monthly), '$200', '$2,400 a year');
    assert.match(tax.caveat, /your own assessment/i);
  });

  test('it refuses without a key rather than returning nothing quietly', async () => {
    await assert.rejects(() => censusCounty(loc, undefined, census(rows)), /CENSUS_API_KEY/);
  });

  test('it refuses without a county, since that is the only reliable key', async () => {
    await assert.rejects(
      () => censusCounty({ label: 'Somewhere' }, 'k', census(rows)), /no county/);
  });

  // The next three are replies Census actually gave on 2026-10-28.

  test('a county with no figures is nothing, not a parse error', async () => {
    // Census answers 204 with an empty body rather than an empty table.
    const empty = (async () => censusReply(204, '')) as unknown as typeof globalThis.fetch;
    assert.deepEqual(await censusCounty(loc, 'k', empty), []);
    const out = await lookUp(loc, { censusKey: 'k', fetchImpl: empty });
    assert.ok(out.missing.includes('Census had no figures for that county'));
  });

  test('a refused key says so, rather than "Unexpected token <"', async () => {
    // A bad key is a 200 carrying an HTML page titled "Invalid Key".
    const refused = (async () => censusReply(200,
      '<html style="font-size: 14px;"><head><title>Invalid Key</title></head><body>…</body></html>',
      'text/html')) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => censusCounty(loc, 'k', refused), /key was refused.*CENSUS_API_KEY/);
  });

  test('columns in an order it does not recognise are refused, not read', async () => {
    // Read by position, a reordered table would file property tax as rent.
    const swapped = [['NAME', 'B25103_001E', 'B25064_001E', 'state', 'county'], ['Ridgefield County', '2400', '1350', '39', '055']];
    await assert.rejects(() => censusCounty(loc, 'k', census(swapped)), /columns/);
  });

  test('it reads the latest five-year release and dates figures by it', async () => {
    let asked = '';
    const spy = (async (url: string) => { asked = String(url); return censusReply(200, JSON.stringify(rows)); }) as
      unknown as typeof globalThis.fetch;
    const out = await censusCounty(loc, 'k', spy);
    assert.match(asked, /\/data\/2024\/acs\/acs5\?/);
    assert.ok(out.every((e) => e.asOf === '2024'));
  });
});

describe('electricity, from EIA', () => {
  const loc = { label: 'Ridge, NM', state: 'NM' };
  // The documented v2 shape: revenue in millions of dollars, for the year.
  const eia = (row: Record<string, unknown> | null) =>
    (async () => ({ ok: true, status: 200,
      json: async () => ({ response: { data: row ? [row] : [] } }) })) as unknown as typeof globalThis.fetch;

  const NM = { period: '2024', stateid: 'NM', revenue: 1_100, customers: 800_000, price: 14.2 };

  test('the bill is revenue over customers over twelve, not a price per kWh', async () => {
    // A price in cents per kilowatt-hour is not a budget line. What goes in an
    // envelope is what leaves the account each month.
    const e = (await electricityFromEia(loc, 'k', eia(NM)))!;
    assert.equal(fmt(e.monthly), '$115', '$1.1bn over 800,000 homes over 12 months');
    assert.equal(e.category, 'elec');
    assert.equal(e.asOf, '2024');
  });

  test('the price per kWh rides along as context, not as the figure', async () => {
    const e = (await electricityFromEia(loc, 'k', eia(NM)))!;
    assert.match(e.source, /14\.2¢\/kWh/);
    assert.match(e.caveat, /whole state/);
  });

  test('a bill outside any believable range is refused, not published', async () => {
    // If EIA ever changes revenue from millions to dollars, the arithmetic
    // still "works" and produces a number six orders of magnitude out. Better
    // to fail loudly than to seed an envelope with it.
    await assert.rejects(
      () => electricityFromEia(loc, 'k', eia({ ...NM, revenue: 1_100_000_000 })),
      /not credible/);
    await assert.rejects(
      () => electricityFromEia(loc, 'k', eia({ ...NM, revenue: 0.0001 })), /not credible/);
  });

  test('a row without the fields it needs is an error, never a guess', async () => {
    await assert.rejects(
      () => electricityFromEia(loc, 'k', eia({ period: '2024', price: 14.2 })), /without usable/);
    await assert.rejects(
      () => electricityFromEia(loc, 'k', eia({ ...NM, customers: 0 })), /without usable/);
  });

  test('no state, no lookup — the series is published by state', async () => {
    await assert.rejects(
      () => electricityFromEia({ label: 'Somewhere' }, 'k', eia(NM)), /no state/);
  });

  test('it refuses without a key rather than answering quietly', async () => {
    await assert.rejects(() => electricityFromEia(loc, undefined, eia(NM)), /EIA_API_KEY/);
  });

  test('an empty result is nothing, not zero', async () => {
    assert.equal(await electricityFromEia(loc, 'k', eia(null)), null);
  });
});

describe('putting the sources together', () => {
  const loc = { label: 'Lakeside, OH', postal: '12345', stateFips: '39', countyFips: '085' };

  test('the ZIP-level rent wins over the county median', async () => {
    // A county median is a fallback, not a second opinion — offering both would
    // invite picking whichever suited.
    const fetchImpl = (async (url: string) =>
      String(url).includes('zillow')
        ? { ok: true, status: 200, text: async () => ZORI }
        : censusReply(200, JSON.stringify([
            ['NAME', 'B25064_001E', 'B25103_001E'],
            ['Lake County, Harbor', '2100', '6000'],
          ]))) as unknown as typeof globalThis.fetch;

    const out = await lookUp(loc, { censusKey: 'k', fetchImpl });
    const rents = out.estimates.filter((e) => e.category === 'rent');
    assert.equal(rents.length, 1);
    assert.match(rents[0]!.source, /Zillow/);
    assert.equal(fmt(out.estimates.find((e) => e.category === 'tax')!.monthly), '$500');
  });

  test('a source with nothing is named, so silence is not read as zero', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes('zillow')
        ? { ok: true, status: 200, text: async () => ZORI }
        : censusReply(200, JSON.stringify([['NAME']]))) as unknown as typeof globalThis.fetch;

    const out = await lookUp({ label: 'Ridge, OH', postal: '54321', stateFips: '39', countyFips: '055' },
      { censusKey: 'k', fetchImpl });
    assert.equal(out.estimates.length, 0);
    assert.ok(out.missing.some((m) => /no rent index for ZIP 54321/.test(m)),
      'a rural ZIP genuinely missing from the index has to say so');
    assert.ok(out.missing.some((m) => /Census/.test(m)));
  });

  test('with no key, Census is reported as unavailable rather than as no data', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => ZORI })) as unknown as typeof globalThis.fetch;
    const out = await lookUp(loc, { fetchImpl });
    assert.equal(out.estimates.length, 1, 'Zillow still works without a key');
    assert.ok(out.missing.some((m) => /CENSUS_API_KEY/.test(m)));
  });

  test('a location with no ZIP says why rent could not be looked up', async () => {
    const fetchImpl = (async () => censusReply(200, JSON.stringify([['NAME']]))) as
      unknown as typeof globalThis.fetch;
    const out = await lookUp({ label: 'Somewhere' }, { censusKey: 'k', fetchImpl });
    assert.ok(out.missing.some((m) => /no ZIP recorded/.test(m)));
  });
});

// ─── seeding a budget from what a place actually costs ──────────────────────

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { toolByName, commit, ProposalStore, ToolError } from '../src/tools.ts';
import { parseDollars } from '../src/money.ts';

const ZORI_ROWS = [
  'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,2026-05-31,2026-06-30',
  '1,1,12345,zip,OH,OH,Lakeside,3880.4,3909.22',
].join('\n');

async function seedFixture(opts: { withEnvelope?: boolean } = {}) {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-seed-')), 'events.jsonl');
  const store = new Store({ path });
  await store.load();
  await store.append('system', [
    { op: 'budget.create', budget: 'harbor', label: 'Lakeside' },
    { op: 'budget.locate', budget: 'harbor', why: 'setup',
      location: { label: 'Lakeside, OH', postal: '12345', stateFips: '39', countyFips: '085' } },
  ]);
  if (opts.withEnvelope) {
    await store.append('system', [
      { op: 'category.define', category: 'rent', label: 'Rent', kind: 'House' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'carry', label: 'Home carrying',
        group: 'House', match: { categories: ['rent'] }, template: parseDollars('2500.00'), order: 0 },
    ]);
  }
  return { store, ctx: { store, who: 'alice', today: '2026-08-13', proposals: new ProposalStore(), sid: null } as never };
}

const seedRun = (args: Record<string, unknown>, ctx: never) =>
  toolByName.get('seed_from_location')!.run(args, ctx) as Promise<{ id: string; summary: string; effects: string[] }>;

describe('seeding envelopes from a location', () => {
  const ok = () => { globalThis.fetch = (async (url: string) =>
    String(url).includes('zillow')
      ? { ok: true, status: 200, text: async () => ZORI_ROWS }
      : censusReply(200, JSON.stringify([['NAME']]))) as never; };

  test('it builds the category and the envelope when neither exists', async () => {
    ok();
    const { store, ctx } = await seedFixture();
    const p = await seedRun({ budget: 'harbor' }, ctx);
    assert.ok(p.effects.some((e) => /A new envelope "rent" funded at \$3,909\.22/.test(e)), 'the cents it will write');
    await commit(p.id, ctx);

    assert.ok(store.state.categories.has('rent'), 'evidence needs somewhere to go');
    assert.equal(fmt(store.state.budgets.get('harbor')!.envelopes.get('rent')!.template), '$3,909');
  });

  test('an envelope that already has a figure is never overwritten silently', async () => {
    ok();
    const { ctx } = await seedFixture({ withEnvelope: true });
    const p = await seedRun({ budget: 'harbor' }, ctx);
    assert.ok(p.effects.some((e) => /Home carrying: \$2,500\.00 would become \$3,909\.22/.test(e)),
      'both numbers have to be on screen at the moment of approval');
  });

  test('every figure carries its source and caveat into the proposal', async () => {
    ok();
    const { ctx } = await seedFixture();
    const p = await seedRun({ budget: 'harbor' }, ctx);
    assert.ok(p.effects.some((e) => /Zillow Observed Rent Index, ZIP 12345, 2026-06/.test(e)));
    assert.ok(p.effects.some((e) => /not for a particular house/.test(e)));
  });

  test('it says how little it covers rather than implying it seeded a budget', async () => {
    ok();
    const { ctx } = await seedFixture({ withEnvelope: true });
    const p = await seedRun({ budget: 'harbor' }, ctx);
    assert.ok(p.effects.some((e) => /still yours to set/.test(e)));
    assert.ok(p.effects.some((e) => /Not found:/.test(e)), 'and which sources had nothing');
  });

  test('with no data for the place it refuses rather than inventing figures', async () => {
    // The failure this whole module exists to prevent: a number with no
    // provenance, which gets believed.
    globalThis.fetch = (async (url: string) =>
      String(url).includes('zillow')
        ? { ok: true, status: 200, text: async () =>
            'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,2026-06-30\n1,1,00000,zip,XX,XX,None,5' }
        : censusReply(200, JSON.stringify([['NAME']]))) as never;
    const { ctx } = await seedFixture();
    await assert.rejects(() => seedRun({ budget: 'harbor' }, ctx), /No public data was found/);
  });

  test('a budget with no location has nothing to look up', async () => {
    ok();
    const { store, ctx } = await seedFixture();
    await store.append('alice', { op: 'budget.locate', budget: 'harbor', location: null, why: 'it is a period' });
    await assert.rejects(() => seedRun({ budget: 'harbor' }, ctx), ToolError);
  });

  test('only the categories asked for', async () => {
    ok();
    const { ctx } = await seedFixture();
    await assert.rejects(() => seedRun({ budget: 'harbor', only: ['tax'] }, ctx), /No public data/);
  });
});

// ─── where a ZIP is ──────────────────────────────────────────────────────────

/**
 * The Census ZIP-to-county relationship file, cut down: the real one is 6.8 MB
 * of these, pipe-separated, with a byte-order mark in front of the header.
 */
const ZCTA = [
  '\uFEFFOID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART',
  '|||||||||39001|Adams County|||||||',
  '1|12345|ZCTA5 12345|900|0|G6350|B5|S|2|39085|Lake County|1|0|G4020|H1|A|900|0',
  '3|54321|ZCTA5 54321|1000|0|G6350|B5|S|4|39055|Geauga County|1|0|G4020|H1|A|700|0',
  '3|54321|ZCTA5 54321|1000|0|G6350|B5|S|5|39007|Ashtabula County|1|0|G4020|H1|A|300|0',
].join('\n');

/** Stands in for the network, and counts what was asked of it. */
const network = (opts: { zcta?: string | Error } = {}) => {
  const asked: string[] = [];
  const fn = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes('zcta520')) {
      if (opts.zcta instanceof Error) throw opts.zcta;
      return { ok: true, status: 200, text: async () => opts.zcta ?? ZCTA };
    }
    return censusReply(200, JSON.stringify([['NAME']]));
  }) as unknown as typeof globalThis.fetch;
  return { fn, asked };
};

describe('where a ZIP is', () => {
  test('a ZIP gives its state and county', async () => {
    const place = await placeForZip('12345', network().fn);
    assert.deepEqual(place, {
      state: 'OH', stateFips: '39', countyFips: '085', county: 'Lake County', share: 1, others: [],
    });
  });

  test('a ZIP across two counties takes the one with most of its land, and keeps the other', async () => {
    const place = (await placeForZip('54321', network().fn))!;
    assert.equal(place.county, 'Geauga County');
    assert.equal(place.countyFips, '055');
    assert.equal(place.share, 0.7);
    assert.deepEqual(place.others, ['Ashtabula County']);
  });

  test('a ZIP the file does not know is nothing, not a guess', async () => {
    assert.equal(await placeForZip('99999', network().fn), null);
  });

  test('a file of a shape it does not recognise is refused', async () => {
    await assert.rejects(() => placeForZip('12345', network({ zcta: 'A|B|C\n1|2|3' }).fn), /shape/);
  });
});

describe('recording where a budget is', () => {
  const locate = (args: Record<string, unknown>, ctx: never) =>
    toolByName.get('set_budget_location')!.run({ budget: 'harbor', why: 'test', ...args }, ctx) as
      Promise<{ id: string; effects: string[]; events: { location: Record<string, unknown> | null }[] }>;
  let saved: typeof globalThis.fetch;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  test('a ZIP is enough: state and county are found, so every source can be asked', async () => {
    // The app asked for Census state and county codes by hand, and had no field
    // for the state at all — so the electricity figure could never be reached.
    globalThis.fetch = network().fn;
    const { ctx } = await seedFixture();
    const p = await locate({ label: 'Lakeside, OH', postal: '12345' }, ctx);
    assert.deepEqual(p.events[0]!.location, {
      label: 'Lakeside, OH', postal: '12345', state: 'OH', stateFips: '39', countyFips: '085', county: 'Lake County',
    });
    assert.ok(p.effects.some((e) => /ZIP 12345 is in Lake County, OH/.test(e)));
  });

  test('a ZIP across counties says which one it took and why', async () => {
    globalThis.fetch = network().fn;
    const { ctx } = await seedFixture();
    const p = await locate({ label: 'Ridge, OH', postal: '54321' }, ctx);
    assert.equal(p.events[0]!.location!['countyFips'], '055');
    assert.ok(p.effects.some((e) => /mostly in Geauga County, OH \(70% of its land\).*Ashtabula County/.test(e)));
  });

  test('codes typed by hand are kept, and nothing is looked up', async () => {
    const net = network();
    globalThis.fetch = net.fn;
    const { ctx } = await seedFixture();
    const p = await locate({ label: 'Lakeside, OH', postal: '12345', state: 'oh', stateFips: '39', countyFips: '093' }, ctx);
    assert.equal(p.events[0]!.location!['countyFips'], '093');
    assert.equal(net.asked.length, 0);
  });

  test('a ZIP the file does not know is recorded as given, and says what that costs', async () => {
    globalThis.fetch = network().fn;
    const { ctx } = await seedFixture();
    const p = await locate({ label: 'Nowhere', postal: '99999' }, ctx);
    assert.deepEqual(p.events[0]!.location, { label: 'Nowhere', postal: '99999' });
    assert.ok(p.effects.some((e) => /99999 is not in the Census ZIP-to-county file/.test(e)));
  });

  test('an unreachable Census still records the place, and says so', async () => {
    globalThis.fetch = network({ zcta: new Error('ECONNRESET') }).fn;
    const { ctx } = await seedFixture();
    const p = await locate({ label: 'Lakeside, OH', postal: '12345' }, ctx);
    assert.deepEqual(p.events[0]!.location, { label: 'Lakeside, OH', postal: '12345' });
    assert.ok(p.effects.some((e) => /could not reach the Census.*ECONNRESET/i.test(e)));
  });
});
