import type {
  ProviderCatalog,
  ProviderCatalogOfferingInfo,
  ProviderInstanceOffering,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { getLocationsForProvider } from '@simple-agent-manager/shared';

type NativeOffering = Pick<ProviderInstanceOffering,
  'provider' | 'location' | 'providerInstanceType' | 'displayName' | 'vcpu' | 'memoryMb' | 'diskGb'
> & Pick<ProviderCatalogOfferingInfo, 'price' | 'available' | 'stale'>;

export interface NodeCreationCatalog extends Pick<ProviderCatalog, 'provider' | 'defaultLocation' | 'locations'> {
  offerings?: NativeOffering[];
  sizes?: ProviderCatalog['sizes'];
}

/** A configured effective pool outranks credential-editor catalogs, including empty pools. */
export function nodeCreationCatalogs(
  personalCatalogs: ProviderCatalog[],
  summary: SafeEffectiveCapacityPoolSummary | undefined
): NodeCreationCatalog[] {
  if (!summary) return [];
  if (summary.state === 'unconfigured') return personalCatalogs;
  if (summary.state !== 'configured-ready') return [];
  const grouped = new Map<string, NodeCreationCatalog & { offerings: NativeOffering[] }>();
  for (const offering of summary.nativeOfferings ?? []) {
    let catalog = grouped.get(offering.provider);
    if (!catalog) {
      catalog = { provider: offering.provider, defaultLocation: offering.location, locations: [], offerings: [] };
      grouped.set(offering.provider, catalog);
    }
    if (!catalog.locations.some((location) => location.id === offering.location)) {
      const known = getLocationsForProvider(offering.provider).find((location) => location.id === offering.location);
      catalog.locations.push(known ?? { id: offering.location, name: offering.location, country: '' });
    }
    catalog.offerings.push({ ...offering, price: offering.price ?? undefined, available: true, stale: false });
  }
  return [...grouped.values()];
}
