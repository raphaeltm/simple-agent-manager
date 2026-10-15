import type {
  CapacityPoolCandidate,
  CapacitySourceIdentity,
  ProviderCatalog,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildMachineChanges,
  buildMachineGroups,
  isCellAllowed,
  type MachineCell,
  type MachineGroup,
  rowPriceLabel,
  summarizeAllowedMachines,
  toggleCell,
} from '../../../src/lib/compute-pool-machines';

const TS = '2026-10-01T00:00:00.000Z';
type CatalogOffering = NonNullable<ProviderCatalog['offerings']>[number];

const SPECS: Record<string, { vcpu: number; memoryGb: number; diskGb: number; price: number }> = {
  cx23: { vcpu: 2, memoryGb: 4, diskGb: 40, price: 4.49 },
  cx33: { vcpu: 4, memoryGb: 8, diskGb: 80, price: 7.49 },
  ccx63: { vcpu: 48, memoryGb: 192, diskGb: 960, price: 360.49 },
};
const LOCATIONS = [
  { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
  { id: 'hel1', name: 'Helsinki', country: 'FI' },
  { id: 'ash', name: 'Ashburn, VA', country: 'US' },
];

function source(overrides: Partial<CapacitySourceIdentity> = {}): CapacitySourceIdentity {
  return {
    id: 'source-legacy',
    scope: 'user',
    ownerUserId: 'user-1',
    ownerProjectId: null,
    sourceKind: 'cloud-provider-credential',
    provider: 'hetzner',
    credentialSource: 'user',
    credentialId: 'cred-legacy',
    platformCredentialId: null,
    credentialReference: 'credentials:cred-legacy',
    credentialVersion: 1,
    externalSourceRef: null,
    status: 'active',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function offering(sku: string, location: string, overrides: Partial<CatalogOffering> = {}) {
  const spec = SPECS[sku]!;
  const loc = LOCATIONS.find((item) => item.id === location)!;
  const price = location === 'ash' ? spec.price * 1.2 : spec.price;
  return {
    provider: 'hetzner',
    location,
    locationName: loc.name,
    country: loc.country,
    providerInstanceType: sku,
    providerInstanceSku: null,
    displayName: sku,
    sku,
    vcpu: spec.vcpu,
    memoryMb: spec.memoryGb * 1024,
    memoryGb: spec.memoryGb,
    diskGb: spec.diskGb,
    price: `€${price.toFixed(2)}/mo`,
    priceMonthly: price,
    currency: 'EUR',
    available: true,
    catalogSource: 'api',
    catalogLastSeenAt: TS,
    ...overrides,
  } satisfies CatalogOffering;
}

function catalog(
  credential: { credentialId: string; externalSourceRef?: string | null },
  offerings: CatalogOffering[]
): ProviderCatalog {
  return {
    provider: 'hetzner',
    credentialSource: 'user',
    credentialId: credential.credentialId,
    externalSourceRef: credential.externalSourceRef ?? null,
    locations: LOCATIONS,
    sizes: {},
    offerings,
    defaultLocation: 'fsn1',
  } as ProviderCatalog;
}

function candidate(
  id: string,
  sku: string,
  location: string,
  status: CapacityPoolCandidate['status'],
  sourceId = 'source-legacy'
): CapacityPoolCandidate {
  const spec = SPECS[sku]!;
  return {
    id,
    poolId: 'pool-user',
    capacitySourceId: sourceId,
    provider: 'hetzner',
    location,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: null,
    providerInstanceType: sku,
    providerInstanceVcpuCount: spec.vcpu,
    providerInstanceMemoryMb: spec.memoryGb * 1024,
    providerInstanceDiskGb: spec.diskGb,
    providerInstancePriceDisplay: `€${spec.price.toFixed(2)}/mo`,
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: Math.round(spec.price * 100),
    providerInstancePriceHourlyMicros: null,
    priority: 0,
    candidateOrder: 0,
    status,
    createdAt: TS,
    updatedAt: TS,
  };
}

const LEGACY_CATALOG = catalog({ credentialId: 'cred-legacy' }, [
  offering('cx23', 'fsn1'),
  offering('cx23', 'hel1'),
  offering('cx33', 'fsn1'),
  offering('ccx63', 'ash'),
  offering('ccx63', 'fsn1'),
]);

function typicalGroups(): MachineGroup[] {
  return buildMachineGroups(
    [
      candidate('cx23-hel1', 'cx23', 'hel1', 'active'),
      candidate('cx23-fsn1', 'cx23', 'fsn1', 'active'),
      candidate('cx33-fsn1', 'cx33', 'fsn1', 'deleted'),
      candidate('ccx63-ash', 'ccx63', 'ash', 'disabled'),
    ],
    [LEGACY_CATALOG],
    [source()]
  );
}

function cell(groups: MachineGroup[], sku: string, location: string): MachineCell {
  for (const group of groups) {
    for (const row of group.rows) {
      const found = row.cells.find((item) => row.sku === sku && item.location === location);
      if (found) return found;
    }
  }
  throw new Error(`no cell ${sku}/${location}`);
}

describe('buildMachineGroups', () => {
  it('groups regions under one row per machine type, allowed types first', () => {
    const [group, ...rest] = typicalGroups();
    expect(rest).toHaveLength(0);
    expect(group!.kind).toBe('cloud-provider-key');
    expect(group!.rows.map((row) => [row.sku, row.allowed])).toEqual([
      ['cx23', true],
      ['cx33', false],
      ['ccx63', false],
    ]);
    // Regions sorted by country, then name; city names come from the catalog.
    expect(group!.rows[0]!.cells.map((item) => [item.locationLabel, item.allowed])).toEqual([
      ['Falkenstein', true],
      ['Helsinki', true],
    ]);
  });

  it('offers catalog machines the pool has no row for, through their source', () => {
    const fsn1 = cell(typicalGroups(), 'ccx63', 'fsn1');
    expect(fsn1).toMatchObject({ allowed: false, canAllow: true, candidates: [] });
    expect(fsn1.catalogAddition).toEqual({
      sourceId: 'source-legacy',
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'ccx63',
      providerInstanceSku: null,
    });
  });

  it('marks machines the provider no longer offers, and keeps allowed ones removable', () => {
    const groups = buildMachineGroups(
      [
        candidate('cx23-fsn1', 'cx23', 'fsn1', 'active'),
        candidate('cx33-fsn1', 'cx33', 'fsn1', 'active'),
      ],
      [
        catalog({ credentialId: 'cred-legacy' }, [
          offering('cx23', 'fsn1', { available: false, status: 'temporarily unavailable' }),
        ]),
      ],
      [source()]
    );
    expect(cell(groups, 'cx23', 'fsn1')).toMatchObject({
      allowed: true,
      canAllow: false,
      issue: 'Temporarily unavailable',
    });
    expect(cell(groups, 'cx33', 'fsn1')).toMatchObject({
      allowed: true,
      canAllow: false,
      issue: 'Not currently offered',
    });
  });

  it('keeps each connection separate and labels composable connections', () => {
    const groups = buildMachineGroups(
      [
        candidate('legacy-cx23', 'cx23', 'fsn1', 'active'),
        candidate('cc-cx23', 'cx23', 'fsn1', 'deleted', 'source-cc'),
      ],
      [
        LEGACY_CATALOG,
        catalog({ credentialId: 'cc-cred', externalSourceRef: 'cc_attachments:att-1' }, [
          offering('cx23', 'fsn1'),
        ]),
      ],
      [
        source(),
        source({
          id: 'source-cc',
          credentialId: 'cc-cred',
          credentialReference: 'cc_credentials:cc-cred',
          externalSourceRef: 'cc_attachments:att-1',
        }),
      ]
    );
    expect(groups.map((group) => [group.key, group.kind])).toEqual([
      ['source-legacy', 'cloud-provider-key'],
      ['source-cc', 'connection'],
    ]);
    const ccCell = groups[1]!.rows[0]!.cells[0]!;
    expect(ccCell).toMatchObject({ allowed: false, canAllow: true, locationLabel: 'Falkenstein' });
  });

  it('trusts rows whose account catalog is not loaded, and names their regions', () => {
    // A project page shows the personal pool it falls back to. The project-scoped catalog
    // request covers project credentials only, so no catalog describes these rows.
    const groups = buildMachineGroups(
      [
        candidate('cx23-hel1', 'cx23', 'hel1', 'active'),
        candidate('cx23-fsn1', 'cx23', 'fsn1', 'active'),
        candidate('cx33-fsn1', 'cx33', 'fsn1', 'disabled'),
      ],
      [],
      [source()]
    );
    expect(cell(groups, 'cx23', 'fsn1')).toMatchObject({
      allowed: true,
      issue: null,
      locationLabel: 'Falkenstein',
      country: 'DE',
    });
    expect(cell(groups, 'cx23', 'hel1')).toMatchObject({ allowed: true, issue: null });
    expect(cell(groups, 'cx33', 'fsn1')).toMatchObject({ allowed: false, issue: null });
    expect(summarizeAllowedMachines(groups).regions).toEqual(['Falkenstein', 'Helsinki']);
  });

  it('leaves out catalog rows that no pool source can write', () => {
    const groups = buildMachineGroups(
      [],
      [catalog({ credentialId: 'unknown-credential' }, [offering('cx23', 'fsn1')])],
      [source()]
    );
    expect(groups).toEqual([]);
  });
});

describe('draft and update request', () => {
  it('toggling twice returns to the server state', () => {
    const target = cell(typicalGroups(), 'cx23', 'fsn1');
    const once = toggleCell(new Map(), target);
    expect(isCellAllowed(target, once)).toBe(false);
    const twice = toggleCell(once, target);
    expect(twice.size).toBe(0);
    expect(isCellAllowed(target, twice)).toBe(true);
  });

  it('writes active, deleted, and catalog additions for changed cells only', () => {
    const groups = typicalGroups();
    let draft: Map<string, boolean> = new Map();
    draft = toggleCell(draft, cell(groups, 'cx23', 'fsn1')); // allowed -> blocked
    draft = toggleCell(draft, cell(groups, 'cx33', 'fsn1')); // deleted -> allowed
    draft = toggleCell(draft, cell(groups, 'ccx63', 'ash')); // disabled -> allowed
    draft = toggleCell(draft, cell(groups, 'ccx63', 'fsn1')); // catalog only -> allowed

    expect(buildMachineChanges(groups, draft)).toEqual({
      candidates: [
        { id: 'cx23-fsn1', status: 'deleted' },
        { id: 'cx33-fsn1', status: 'active' },
        { id: 'ccx63-ash', status: 'active' },
      ],
      catalogAdditions: [
        {
          sourceId: 'source-legacy',
          provider: 'hetzner',
          location: 'fsn1',
          providerInstanceType: 'ccx63',
          providerInstanceSku: null,
        },
      ],
    });
  });

  it('blocking a region turns off every active row in it, and nothing else', () => {
    const groups = buildMachineGroups(
      [candidate('dup-a', 'cx23', 'fsn1', 'active'), candidate('dup-b', 'cx23', 'fsn1', 'deleted')],
      [LEGACY_CATALOG],
      [source()]
    );
    const draft = toggleCell(new Map(), cell(groups, 'cx23', 'fsn1'));
    expect(buildMachineChanges(groups, draft).candidates).toEqual([
      { id: 'dup-a', status: 'deleted' },
    ]);
  });
});

describe('summaries', () => {
  it('summarizes what the pool allows today', () => {
    const summary = summarizeAllowedMachines(typicalGroups());
    expect(summary).toMatchObject({
      providers: ['Hetzner'],
      regions: ['Falkenstein', 'Helsinki'],
      machineTypeCount: 1,
    });
    expect(summary.smallest?.sku).toBe('cx23');
    expect(summary.largest?.sku).toBe('cx23');
  });

  it('shows one price when regions agree and a starting price when they differ', () => {
    const rows = typicalGroups()[0]!.rows;
    expect(rowPriceLabel(rows.find((row) => row.sku === 'cx23')!)).toBe('€4.49/mo');
    expect(rowPriceLabel(rows.find((row) => row.sku === 'ccx63')!)).toBe('from €360.49/mo');
  });
});

describe('region order', () => {
  it('lists regions with a known country first, then numbered regions in order', () => {
    const groups = buildMachineGroups(
      [
        candidate('r10', 'cx23', 'region-10', 'active'),
        candidate('r2', 'cx23', 'region-2', 'active'),
        candidate('fsn1', 'cx23', 'fsn1', 'active'),
      ],
      [LEGACY_CATALOG],
      [source()]
    );
    // Helsinki comes from the catalog (offered, not yet allowed).
    expect(groups[0]!.rows[0]!.cells.map((item) => item.locationLabel)).toEqual([
      'Falkenstein',
      'Helsinki',
      'region-2',
      'region-10',
    ]);
  });
});
