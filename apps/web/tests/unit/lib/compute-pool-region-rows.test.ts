import { describe, expect, it } from 'vitest';

import {
  catalogCurrencies,
  cheapestRegionKeys,
  DEFAULT_CATALOG_FILTERS,
  filterCatalogRows,
  nextSort,
  sortCatalogRows,
} from '../../../src/lib/compute-pool-catalog-view';
import type { MachineCell, MachineGroup } from '../../../src/lib/compute-pool-machines';
import {
  ambiguousRowKeys,
  buildMachineRegionRows,
  continentForCountry,
  isRowAllowed,
  type MachineRegionRow,
  priceCurrency,
  rowControlName,
  setRows,
  zoneDraftForRows,
} from '../../../src/lib/compute-pool-region-rows';

function zone(location: string, overrides: Partial<MachineCell> = {}): MachineCell {
  return {
    key: `src|${location}`,
    location,
    locationLabel: location,
    country: null,
    candidates: [],
    catalogAddition: null,
    allowed: false,
    canAllow: true,
    issue: null,
    priceLabel: '$97.09/mo',
    monthlyPrice: 97.09,
    ...overrides,
  };
}

function group(
  key: string,
  provider: string,
  machines: Array<{ sku: string; vcpu: number; ramGb: number; cells: MachineCell[] }>
): MachineGroup {
  return {
    key,
    provider,
    providerLabel: provider === 'gcp' ? 'Google Cloud' : 'Hetzner',
    kind: 'connection',
    credentialSource: 'user',
    label: null,
    rows: machines.map((machine) => ({
      key: `${key}|${machine.sku}`,
      provider,
      providerLabel: provider === 'gcp' ? 'Google Cloud' : 'Hetzner',
      sku: machine.sku,
      vcpu: machine.vcpu,
      ramGb: machine.ramGb,
      diskGb: 50,
      cells: machine.cells,
      allowed: machine.cells.some((cell) => cell.allowed),
    })),
  };
}

const GCP = group('gcp-src', 'gcp', [
  {
    sku: 'e2-standard-4',
    vcpu: 4,
    ramGb: 16,
    cells: [
      zone('europe-west1-b', {
        key: 'b',
        allowed: true,
        candidates: [{ id: 'b-row', status: 'active', addable: true }],
      }),
      zone('europe-west1-c', {
        key: 'c',
        candidates: [{ id: 'c-row', status: 'disabled', addable: true }],
      }),
      zone('europe-west1-d', {
        key: 'd',
        canAllow: false,
        issue: 'Not currently offered',
        candidates: [{ id: 'd-row', status: 'disabled', addable: false }],
      }),
      zone('us-central1-a', {
        key: 'iowa',
        priceLabel: '$90.00/mo',
        monthlyPrice: 90,
        candidates: [{ id: 'iowa-row', status: 'disabled', addable: true }],
      }),
    ],
  },
]);
const HETZNER = group('hz-src', 'hetzner', [
  {
    sku: 'cx33',
    vcpu: 4,
    ramGb: 8,
    cells: [
      zone('fsn1', {
        key: 'fsn1',
        locationLabel: 'Falkenstein',
        country: 'DE',
        priceLabel: '€7.49/mo',
        monthlyPrice: 7.49,
        catalogAddition: {
          sourceId: 'hz-src',
          provider: 'hetzner',
          location: 'fsn1',
          providerInstanceType: 'cx33',
          providerInstanceSku: null,
        },
      }),
    ],
  },
]);

function row(rows: MachineRegionRow[], region: string): MachineRegionRow {
  const found = rows.find((candidate) => candidate.region === region);
  if (!found) throw new Error(`no row for ${region}`);
  return found;
}

describe('buildMachineRegionRows', () => {
  it('folds zones into one row per region with the region name, country and continent', () => {
    const rows = buildMachineRegionRows([GCP, HETZNER]);
    expect(rows.map((r) => `${r.sku}@${r.region}`).sort()).toEqual([
      'cx33@fsn1',
      'e2-standard-4@europe-west1',
      'e2-standard-4@us-central1',
    ]);
    const belgium = row(rows, 'europe-west1');
    expect(belgium).toMatchObject({
      regionLabel: 'Belgium',
      country: 'BE',
      continent: 'Europe',
      allowed: true,
      canAllow: true,
      sourceId: 'gcp-src',
    });
    expect(belgium.zones.map((z) => z.location)).toEqual([
      'europe-west1-b',
      'europe-west1-c',
      'europe-west1-d',
    ]);
    expect(row(rows, 'us-central1')).toMatchObject({
      regionLabel: 'Iowa',
      continent: 'North America',
      allowed: false,
      priceLabel: '$90.00/mo',
    });
    // A provider without zones keeps its location as the region, with the catalog's name.
    expect(row(rows, 'fsn1')).toMatchObject({ regionLabel: 'Falkenstein', continent: 'Europe' });
  });

  it('marks a region unavailable only when none of its zones can be added', () => {
    const only = group('gcp-src', 'gcp', [
      {
        sku: 'n2-standard-8',
        vcpu: 8,
        ramGb: 32,
        cells: [zone('asia-east1-a', { canAllow: false, issue: 'Not currently offered' })],
      },
    ]);
    expect(buildMachineRegionRows([only])[0]).toMatchObject({
      canAllow: false,
      issue: 'Not currently offered',
      continent: 'Asia',
    });
  });
});

describe('region edits become zone edits', () => {
  it('adds every zone that can be added and removes every zone of a region', () => {
    const rows = buildMachineRegionRows([GCP, HETZNER]);
    const iowa = row(rows, 'us-central1');
    const belgium = row(rows, 'europe-west1');
    const fsn = row(rows, 'fsn1');

    const draft = setRows(setRows(new Map(), [iowa, fsn], true), [belgium], false);
    expect(isRowAllowed(iowa, draft)).toBe(true);
    expect(isRowAllowed(belgium, draft)).toBe(false);
    expect(Object.fromEntries(zoneDraftForRows(rows, draft))).toEqual({
      iowa: true,
      fsn1: true,
      // Removing a region removes all its zones, including ones that cannot be added now.
      b: false,
      c: false,
      d: false,
    });
  });

  it('returning a row to its server state drops it from the draft', () => {
    const rows = buildMachineRegionRows([GCP]);
    const belgium = row(rows, 'europe-west1');
    const removed = setRows(new Map(), [belgium], false);
    expect(removed.size).toBe(1);
    expect(setRows(removed, [belgium], true).size).toBe(0);
  });

  it('never adds a region that cannot be added', () => {
    const only = buildMachineRegionRows([
      group('gcp-src', 'gcp', [
        { sku: 'x', vcpu: 1, ramGb: 1, cells: [zone('asia-east1-a', { canAllow: false })] },
      ]),
    ]);
    expect(setRows(new Map(), only, true).size).toBe(0);
  });
});

describe('catalog filters and order', () => {
  const rows = buildMachineRegionRows([GCP, HETZNER]);
  const titles = new Map([
    ['gcp-src', 'Google Cloud · SAM GCP Prod'],
    ['hz-src', 'Hetzner · Personal'],
  ]);
  const regions = (list: MachineRegionRow[]) => list.map((r) => r.region);

  it('filters by view, account, continent, size, price and search', () => {
    const f = (patch: Partial<typeof DEFAULT_CATALOG_FILTERS>) =>
      regions(filterCatalogRows(rows, { ...DEFAULT_CATALOG_FILTERS, ...patch }, new Map(), titles));
    expect(f({ view: 'in' })).toEqual(['europe-west1']);
    expect(f({ view: 'out' }).sort()).toEqual(['fsn1', 'us-central1']);
    expect(f({ accounts: new Set(['hz-src']) })).toEqual(['fsn1']);
    expect(f({ continents: new Set(['North America'] as const) })).toEqual(['us-central1']);
    expect(f({ minMemoryGb: 10 }).sort()).toEqual(['europe-west1', 'us-central1']);
    // A price limit applies only to rows priced in its own currency: nothing is converted.
    expect(f({ maxMonthlyPrices: new Map([['$', 92]]) }).sort()).toEqual(['fsn1', 'us-central1']);
    expect(f({ maxMonthlyPrices: new Map([['€', 5]]) }).sort()).toEqual([
      'europe-west1',
      'us-central1',
    ]);
    expect(f({ query: 'sam gcp iowa' })).toEqual(['us-central1']);
    expect(f({ query: 'personal' })).toEqual(['fsn1']);
  });

  it('hides unavailable rows unless they are in the pool', () => {
    const unavailable = buildMachineRegionRows([
      group('gcp-src', 'gcp', [
        { sku: 'gone', vcpu: 1, ramGb: 1, cells: [zone('asia-east1-a', { canAllow: false })] },
        {
          sku: 'kept',
          vcpu: 1,
          ramGb: 1,
          cells: [zone('asia-east1-b', { canAllow: false, allowed: true })],
        },
      ]),
    ]);
    expect(
      filterCatalogRows(unavailable, DEFAULT_CATALOG_FILTERS, new Map(), titles).map((r) => r.sku)
    ).toEqual(['kept']);
    expect(
      filterCatalogRows(
        unavailable,
        { ...DEFAULT_CATALOG_FILTERS, hideUnavailable: false },
        new Map(),
        titles
      )
    ).toHaveLength(2);
  });

  it('orders by account priority, then machine, then region, and sorts columns both ways', () => {
    const rank = new Map([
      ['hz-src', 0],
      ['gcp-src', 1],
    ]);
    expect(regions(sortCatalogRows(rows, null, rank))).toEqual([
      'fsn1',
      'europe-west1',
      'us-central1',
    ]);
    // Price sorts within each currency: the dollar rows together, then the euro row.
    expect(regions(sortCatalogRows(rows, { key: 'price', direction: 'asc' }, rank))).toEqual([
      'us-central1',
      'europe-west1',
      'fsn1',
    ]);
    expect(regions(sortCatalogRows(rows, { key: 'price', direction: 'desc' }, rank))).toEqual([
      'fsn1',
      'europe-west1',
      'us-central1',
    ]);
  });

  it('never compares amounts across currencies', () => {
    const euro = buildMachineRegionRows([
      group('hz-src', 'hetzner', [
        {
          sku: 'eu',
          vcpu: 2,
          ramGb: 4,
          cells: [zone('fsn1', { key: 'eu', priceLabel: '€20.00/mo', monthlyPrice: 20 })],
        },
      ]),
      group('gcp-src', 'gcp', [
        {
          sku: 'us',
          vcpu: 2,
          ramGb: 4,
          cells: [zone('us-east1-b', { key: 'us', priceLabel: '$20.00/mo', monthlyPrice: 20 })],
        },
      ]),
    ]);
    expect(euro.map((r) => r.currency).sort()).toEqual(['$', '€']);
    expect(catalogCurrencies(euro)).toEqual(['$', '€']);
    const limited = filterCatalogRows(
      euro,
      { ...DEFAULT_CATALOG_FILTERS, maxMonthlyPrices: new Map([['€', 19]]) },
      new Map(),
      titles
    );
    expect(limited.map((r) => r.sku)).toEqual(['us']);
  });

  it('keeps unknown values last in both directions', () => {
    const withUnknown = rows.map((r) =>
      r.region === 'fsn1' ? { ...r, monthlyPrice: null, priceLabel: null } : r
    );
    const rank = new Map<string, number>();
    expect(
      regions(sortCatalogRows(withUnknown, { key: 'price', direction: 'asc' }, rank)).at(-1)
    ).toBe('fsn1');
    expect(
      regions(sortCatalogRows(withUnknown, { key: 'price', direction: 'desc' }, rank)).at(-1)
    ).toBe('fsn1');
  });

  it('cycles a column through ascending, descending and the default order', () => {
    const asc = nextSort(null, 'vcpu');
    const desc = nextSort(asc, 'vcpu');
    expect(asc).toEqual({ key: 'vcpu', direction: 'asc' });
    expect(desc).toEqual({ key: 'vcpu', direction: 'desc' });
    expect(nextSort(desc, 'vcpu')).toBeNull();
    expect(nextSort(desc, 'price')).toEqual({ key: 'price', direction: 'asc' });
  });

  it('flags the cheapest region of a machine only when regions differ in price', () => {
    expect([...cheapestRegionKeys(rows)].map((key) => key.split('|').at(-1))).toEqual([
      'us-central1',
    ]);
  });

  it('keeps a row the person changed listed whatever the view', () => {
    const belgium = row(rows, 'europe-west1');
    const removed = setRows(new Map(), [belgium], false);
    const inView = filterCatalogRows(
      rows,
      { ...DEFAULT_CATALOG_FILTERS, view: 'in' },
      removed,
      titles
    );
    expect(regions(inView)).toEqual(['europe-west1']);
    // An unchanged row still follows the view.
    expect(
      regions(
        filterCatalogRows(rows, { ...DEFAULT_CATALOG_FILTERS, view: 'in' }, new Map(), titles)
      )
    ).toEqual(['europe-west1']);
    expect(
      regions(
        filterCatalogRows(rows, { ...DEFAULT_CATALOG_FILTERS, view: 'out' }, removed, titles)
      ).sort()
    ).toEqual(['europe-west1', 'fsn1', 'us-central1']);
  });

  it('maps unknown countries to Other', () => {
    expect(continentForCountry(null)).toBe('Other');
    expect(continentForCountry('zz')).toBe('Other');
    expect(continentForCountry('jp')).toBe('Asia');
  });
});

describe('price currency and control names', () => {
  it('reads the currency marker from a price label', () => {
    expect(priceCurrency('€3.99/mo')).toBe('€');
    expect(priceCurrency('$97.09/mo')).toBe('$');
    expect(priceCurrency('USD 12.00/mo')).toBe('USD');
    expect(priceCurrency('CHF 0.0120/hr')).toBe('CHF');
    expect(priceCurrency('from €3.99/mo')).toBe('€');
    expect(priceCurrency(null)).toBeNull();
    expect(priceCurrency('12.00/mo')).toBeNull();
  });

  it('adds the account to a control name only when another account offers the same row', () => {
    const second = group('hz-2', 'hetzner', [
      {
        sku: 'cx33',
        vcpu: 4,
        ramGb: 8,
        cells: [zone('fsn1', { key: 'fsn1-2', locationLabel: 'Falkenstein', country: 'DE' })],
      },
    ]);
    const rows = buildMachineRegionRows([GCP, HETZNER, second]);
    const ambiguous = ambiguousRowKeys(rows);
    const fsn = rows.filter((r) => r.region === 'fsn1');
    expect(fsn).toHaveLength(2);
    expect(fsn.every((r) => ambiguous.has(r.key))).toBe(true);
    expect(rowControlName(fsn[0]!, 'Hetzner · Personal', ambiguous)).toBe(
      'cx33 in Falkenstein, Hetzner · Personal'
    );
    const belgium = rows.find((r) => r.region === 'europe-west1')!;
    expect(ambiguous.has(belgium.key)).toBe(false);
    expect(rowControlName(belgium, 'Google Cloud · Prod', ambiguous)).toBe(
      'e2-standard-4 in Belgium'
    );
  });
});
