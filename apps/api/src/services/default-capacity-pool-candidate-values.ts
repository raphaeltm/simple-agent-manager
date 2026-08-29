import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';

function normalizedNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedMemoryMb(offering: ProviderInstanceOffering): number | null {
  const memoryMb = normalizedNumber(offering.memoryMb);
  if (memoryMb !== null) return memoryMb;

  const memoryGb = normalizedNumber(offering.memoryGb ?? offering.ramGb);
  return memoryGb === null ? null : Math.round(memoryGb * 1024);
}

function normalizedDiskGb(offering: ProviderInstanceOffering): number | null {
  return normalizedNumber(offering.diskGb ?? offering.storageGb);
}

function priceDisplay(offering: ProviderInstanceOffering): string | null {
  const explicit = offering.price?.trim();
  if (explicit) return explicit;

  const currency = offering.currency ?? (hasUsdPrice(offering) ? 'USD' : null);
  if (!currency) return null;

  const monthly = normalizedNumber(offering.priceMonthly ?? offering.priceMonthlyUsd);
  if (monthly !== null) return `${currency} ${monthly.toFixed(2)}/mo`;

  const hourly = normalizedNumber(offering.priceHourly ?? offering.priceHourlyUsd);
  if (hourly !== null) return `${currency} ${hourly.toFixed(4)}/hr`;

  return null;
}

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
  const monthly = normalizedNumber(offering.priceMonthly ?? offering.priceMonthlyUsd);
  const hourly = normalizedNumber(offering.priceHourly ?? offering.priceHourlyUsd);
  const currency = offering.currency ?? (hasUsdPrice(offering) ? 'USD' : null);

  return {
    providerInstanceType: offering.providerInstanceType,
    providerInstanceSku: offering.providerInstanceSku,
    providerInstanceDisplayName: offering.displayName,
    providerInstanceVcpuCount: normalizedNumber(offering.vcpu),
    providerInstanceMemoryMb: normalizedMemoryMb(offering),
    providerInstanceDiskGb: normalizedDiskGb(offering),
    providerInstancePriceDisplay: priceDisplay(offering),
    providerInstancePriceCurrency: currency,
    providerInstancePriceMonthlyCents: monthly === null ? null : Math.round(monthly * 100),
    providerInstancePriceHourlyMicros: hourly === null ? null : Math.round(hourly * 1_000_000),
    providerInstanceCatalogSource: offering.catalogSource,
    providerInstanceCatalogLastSeenAt: offering.catalogLastSeenAt,
  };
}

function hasUsdPrice(offering: ProviderInstanceOffering): boolean {
  return offering.priceMonthlyUsd != null || offering.priceHourlyUsd != null;
}
