import type { ProviderInstanceOffering } from '@simple-agent-manager/providers';

import type * as schema from '../db/schema';

export function providerInstanceOfferingDbValues(offering: ProviderInstanceOffering): Pick<
  schema.NewCapacityPoolCandidate,
  | 'providerInstanceType'
  | 'providerInstanceVcpuCount'
  | 'providerInstanceMemoryMb'
  | 'providerInstanceDiskGb'
  | 'providerInstancePriceDisplay'
  | 'providerInstancePriceCurrency'
  | 'providerInstancePriceMonthlyCents'
  | 'providerInstancePriceHourlyMicros'
> {
  return {
    providerInstanceType: offering.instanceType,
    providerInstanceVcpuCount: offering.vcpuCount,
    providerInstanceMemoryMb: offering.memoryMb,
    providerInstanceDiskGb: offering.diskGb,
    providerInstancePriceDisplay: offering.priceDisplay,
    providerInstancePriceCurrency: offering.priceCurrency,
    providerInstancePriceMonthlyCents: offering.priceMonthlyCents,
    providerInstancePriceHourlyMicros: offering.priceHourlyMicros,
  };
}
