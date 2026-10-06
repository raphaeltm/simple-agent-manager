import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';

import type { LocationMeta } from './types';
import type { HetznerServerTypePayload } from './validation';

const HETZNER_CATALOG_CURRENCY = 'EUR';
const HETZNER_CATALOG_CURRENCY_SYMBOL = '€';

function parseHetznerCatalogPrice(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapHetznerServerTypeOfferings(
  serverType: HetznerServerTypePayload,
  lastSeenAt: string,
  locationMetadata: Readonly<Record<string, LocationMeta>>
): ProviderInstanceOffering[] {
  if (serverType.deprecated === true) return [];

  return serverType.prices.map((price) => {
    const hourly = parseHetznerCatalogPrice(price.price_hourly.gross);
    const monthly = parseHetznerCatalogPrice(price.price_monthly.gross);
    const locationMeta = locationMetadata[price.location];
    const displayName =
      serverType.description ||
      `${serverType.name} · ${serverType.cores} vCPU · ${serverType.memory} GB RAM · ${serverType.disk} GB disk`;

    return {
      provider: 'hetzner',
      location: price.location,
      providerInstanceType: serverType.name,
      providerInstanceSku: null,
      displayName,
      id: serverType.name,
      sku: serverType.name,
      instanceType: serverType.name,
      type: serverType.name,
      name: displayName,
      vcpu: serverType.cores,
      ramGb: serverType.memory,
      memoryGb: serverType.memory,
      memoryMb: serverType.memory * 1024,
      storageGb: serverType.disk,
      diskGb: serverType.disk,
      ...(monthly !== null
        ? { price: `${HETZNER_CATALOG_CURRENCY_SYMBOL}${monthly.toFixed(2)}/mo` }
        : {}),
      priceMonthlyUsd: null,
      priceHourlyUsd: null,
      priceMonthly: monthly,
      priceHourly: hourly,
      currency: HETZNER_CATALOG_CURRENCY,
      available: true,
      stale: false,
      catalogSource: 'api',
      catalogLastSeenAt: lastSeenAt,
      catalogMetadata: {
        hetznerServerTypeId: serverType.id,
        ...(serverType.architecture ? { architecture: serverType.architecture } : {}),
        ...(serverType.cpu_type ? { cpuType: serverType.cpu_type } : {}),
        ...(locationMeta
          ? { locationName: locationMeta.name, locationCountry: locationMeta.country }
          : {}),
      },
      ...(locationMeta ? { locationName: locationMeta.name, country: locationMeta.country } : {}),
    };
  });
}
