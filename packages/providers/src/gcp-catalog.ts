/**
 * Live GCP instance offerings: which machine types exist in which zones (Compute
 * `machineTypes.aggregatedList`), priced from the Cloud Billing Catalog (`gcp-pricing.ts`).
 *
 * Nothing here is a hardcoded zone or price list. The machine types offered are an
 * admin-editable list of exact names; zones are whatever Google reports for them.
 */
import {
  type ProviderInstanceOffering,
  providerLocationRegion,
} from '@simple-agent-manager/shared';

import { fetchPaginatedGcpList, GCP_UNREACHABLE_WARNING, type GcpApiScope } from './gcp-api';
import { LOCATION_METADATA, SIZE_MAP } from './gcp-metadata';
import type { GcpPriceTable } from './gcp-pricing';
import { throwIfProviderRequestAborted } from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import {
  expectObject,
  optionalArray,
  optionalObject,
  optionalString,
  requirePositiveInteger,
  requireString,
  validationError,
} from './validation-core';

/** Hours GCP uses for a month in its monthly price estimates. */
export const GCP_HOURS_PER_MONTH = 730;
/** A Compute Engine machine type name. Also the guard that keeps the list filter injection-free. */
export const GCP_MACHINE_TYPE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Billed vCPUs for shared-core types. Google bills these as a fraction of the vCPUs they expose
 * (an e2-medium shows 2 vCPUs and bills 1). A shared-core type not listed here gets no price.
 */
const SHARED_CORE_BILLED_VCPUS: Readonly<Record<string, number>> = {
  'e2-micro': 0.25,
  'e2-small': 0.5,
  'e2-medium': 1,
};

const LEGACY_SIZE_BY_TYPE = new Map(
  Object.entries(SIZE_MAP).map(([size, config]) => [config.type, size])
);

export interface GcpMachineType {
  name: string;
  zone: string;
  guestCpus: number;
  memoryMb: number;
  isSharedCpu: boolean;
}

/**
 * Build the Compute list filter matching exactly these machine type names. `eq` takes an RE2
 * full-match regex; names are restricted to `[a-z0-9-]`, which has no regex metacharacters.
 */
export function gcpMachineTypeFilter(names: readonly string[]): string {
  if (names.length === 0) {
    throw new ProviderError('gcp', undefined, 'No GCP machine types are configured', {
      category: 'invalid_config',
    });
  }
  for (const name of names) {
    if (!GCP_MACHINE_TYPE_NAME_PATTERN.test(name)) {
      throw new ProviderError('gcp', undefined, `Invalid GCP machine type name: ${name}`, {
        category: 'invalid_config',
      });
    }
  }
  return `name eq "(${names.join('|')})"`;
}

/**
 * Every listed machine type in every zone of the project. An unreachable zone makes the list
 * partial, so it throws: the catalog caller then keeps the last-known live offerings instead of
 * reading the missing zone as "sold out".
 */
export async function fetchGcpMachineTypes(
  scope: GcpApiScope,
  names: readonly string[],
  context?: ProviderRequestContext
): Promise<GcpMachineType[]> {
  const filter = gcpMachineTypeFilter(names);
  const wanted = new Set(names);
  throwIfProviderRequestAborted(context);
  const headers = await scope.authHeaders(context);
  const types: GcpMachineType[] = [];
  const unreachable: string[] = [];
  await fetchPaginatedGcpList(
    scope,
    `${scope.projectUrl}/aggregated/machineTypes`,
    new URLSearchParams({ filter }),
    headers,
    'listMachineTypes.aggregated',
    async (payload) => {
      const root = expectObject(payload, 'gcp', 'machineTypes');
      // Every page lists every zone (an empty one carries a warning), so a page without
      // `items` is malformed; reading it as empty would mark the whole catalog sold out.
      const items = optionalObject(root, 'items', 'gcp', 'machineTypes');
      if (!items) throw validationError('gcp', 'machineTypes', 'expected items');
      for (const [scopeKey, scopePayload] of Object.entries(items)) {
        const scopeContext = `machineTypes.items.${scopeKey}`;
        const scopeObj = expectObject(scopePayload, 'gcp', scopeContext);
        const warning = optionalObject(scopeObj, 'warning', 'gcp', scopeContext);
        if (
          warning &&
          requireString(warning, 'code', 'gcp', scopeContext) === GCP_UNREACHABLE_WARNING
        ) {
          unreachable.push(scopeKey);
        }
        const entries = optionalArray(scopeObj, 'machineTypes', 'gcp', scopeContext);
        // GCP marks an empty scope with a warning; a scope with neither is malformed, and
        // reading it as empty would silently drop that zone from the catalog.
        if (!entries && !warning) {
          throw validationError('gcp', scopeContext, 'expected machineTypes or warning');
        }
        (entries ?? []).forEach((entry, index) => {
          const type = parseMachineType(entry, scopeKey, `${scopeContext}.machineTypes[${index}]`);
          // The server-side filter is the narrowing; this re-check keeps an unexpected
          // filter interpretation from widening the catalog.
          if (type && wanted.has(type.name)) types.push(type);
        });
      }
      return { nextPageToken: optionalString(root, 'nextPageToken', 'gcp', 'machineTypes') };
    },
    context
  );
  if (unreachable.length > 0) {
    throw new ProviderError(
      'gcp',
      undefined,
      `GCP machine type list is incomplete: unreachable ${unreachable.join(', ')}`
    );
  }
  return types;
}

/** Null for a deprecated/obsolete type; throws on a structurally malformed entry. */
function parseMachineType(raw: unknown, scopeKey: string, context: string): GcpMachineType | null {
  const entry = expectObject(raw, 'gcp', context);
  const deprecated = optionalObject(entry, 'deprecated', 'gcp', context);
  if (deprecated && typeof deprecated.state === 'string' && deprecated.state !== 'ACTIVE') {
    return null;
  }
  // SAM boots GCP nodes from an amd64 image and ships an amd64 VM agent, so an Arm type
  // (t2a, c4a) could be placed but never boot. Leave it out of the catalog.
  if (entry.architecture === 'ARM64') return null;
  const zone = scopeKey.startsWith('zones/') ? scopeKey.slice('zones/'.length) : '';
  if (!zone) throw validationError('gcp', context, `unexpected scope ${scopeKey}`);
  return {
    name: requireString(entry, 'name', 'gcp', context),
    zone,
    guestCpus: requirePositiveInteger(entry, 'guestCpus', 'gcp', context),
    memoryMb: requirePositiveInteger(entry, 'memoryMb', 'gcp', context),
    isSharedCpu: entry.isSharedCpu === true,
  };
}

/** `us-central1-a` → `us-central1`. */
export function gcpZoneRegion(zone: string): string {
  return providerLocationRegion('gcp', zone);
}

/** Hourly list price in the table's currency, or null when any part of it is unknown. */
export function gcpMachineTypeHourlyPrice(
  type: GcpMachineType,
  table: GcpPriceTable | null
): number | null {
  if (!table) return null;
  const series = type.name.split('-')[0] ?? '';
  const prices = table.regions[gcpZoneRegion(type.zone)]?.[series];
  if (!prices || prices.coreHourly === null || prices.ramGibHourly === null) return null;
  const billedVcpus = type.isSharedCpu ? SHARED_CORE_BILLED_VCPUS[type.name] : type.guestCpus;
  if (billedVcpus === undefined) return null;
  return billedVcpus * prices.coreHourly + (type.memoryMb / 1024) * prices.ramGibHourly;
}

export function gcpOfferingsFromMachineTypes(
  types: readonly GcpMachineType[],
  table: GcpPriceTable | null,
  input: { bootDiskGb: number; lastSeenAt: string }
): ProviderInstanceOffering[] {
  return types.map((type) => {
    const hourly = gcpMachineTypeHourlyPrice(type, table);
    const monthly = hourly === null ? null : hourly * GCP_HOURS_PER_MONTH;
    const currency = hourly === null ? null : (table?.currency ?? null);
    const location = LOCATION_METADATA[type.zone];
    const legacySize = LEGACY_SIZE_BY_TYPE.get(type.name);
    return {
      provider: 'gcp',
      location: type.zone,
      ...(location ? { locationName: location.name, country: location.country } : {}),
      providerInstanceType: type.name,
      providerInstanceSku: null,
      id: type.name,
      sku: type.name,
      instanceType: type.name,
      type: type.name,
      name: type.name,
      displayName: type.name,
      vcpu: type.guestCpus,
      ramGb: type.memoryMb / 1024,
      memoryGb: type.memoryMb / 1024,
      memoryMb: type.memoryMb,
      storageGb: input.bootDiskGb,
      diskGb: input.bootDiskGb,
      price: monthly === null ? 'Price unavailable' : `$${monthly.toFixed(2)}/mo`,
      priceHourly: hourly,
      priceMonthly: monthly,
      priceHourlyUsd: currency === 'USD' ? hourly : null,
      priceMonthlyUsd: currency === 'USD' ? monthly : null,
      currency,
      available: true,
      stale: false,
      status: null,
      ...(legacySize ? { machineSize: legacySize } : {}),
      catalogSource: 'api',
      catalogLastSeenAt: input.lastSeenAt,
      catalogMetadata: {
        region: gcpZoneRegion(type.zone),
        sharedCpu: type.isSharedCpu,
        priceSource: hourly === null ? 'unavailable' : 'cloud-billing-catalog',
      },
    } satisfies ProviderInstanceOffering;
  });
}
