import type { ProviderInstanceOffering } from '@simple-agent-manager/providers';

import type * as schema from '../db/schema';

export function providerInstanceOfferingDbValues(offering: ProviderInstanceOffering): Pick<
  schema.NewCapacityPoolCandidate,
  | 'providerInstanceType'
  | 'providerInstanceSku'
  | 'providerInstanceDisplayName'
  | 'providerInstanceVcpuCount'
  | 'providerInstanceMemoryMb'
  | 'providerInstanceDiskGb'
  | 'providerInstancePriceDisplay'
  | 'providerInstancePriceCurrency'
  | 'providerInstancePriceMonthlyCents'
  | 'providerInstancePriceHourlyMicros'
  | 'providerInstanceCatalogSource'
  | 'providerInstanceCatalogLastSeenAt'
> {
  return {
    providerInstanceType: offering.instanceType,
    providerInstanceSku: offering.instanceSku,
    providerInstanceDisplayName: offering.displayName,
    providerInstanceVcpuCount: offering.vcpuCount,
    providerInstanceMemoryMb: offering.memoryMb,
    providerInstanceDiskGb: offering.diskGb,
    providerInstancePriceDisplay: offering.priceDisplay,
    providerInstancePriceCurrency: offering.priceCurrency,
    providerInstancePriceMonthlyCents: offering.priceMonthlyCents,
    providerInstancePriceHourlyMicros: offering.priceHourlyMicros,
    providerInstanceCatalogSource: offering.catalogSource,
    providerInstanceCatalogLastSeenAt: offering.catalogLastSeenAt,
  };
}
