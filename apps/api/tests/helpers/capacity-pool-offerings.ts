/**
 * Provider catalog offerings for compute pool tests that run the real publication path
 * (`ensureDefaultCapacityPoolsForExistingCredentials`) on a real SQLite engine.
 */
import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';

export function offering(
  provider: string,
  location: string,
  type: string,
  extra: Partial<ProviderInstanceOffering> = {}
): ProviderInstanceOffering {
  return {
    provider: provider as ProviderInstanceOffering['provider'],
    providerInstanceSku: null,
    id: type,
    sku: type,
    instanceType: type,
    type,
    providerInstanceType: type,
    name: type,
    displayName: type,
    location,
    vcpu: 4,
    ramGb: 16,
    memoryGb: 16,
    memoryMb: 16_384,
    storageGb: 50,
    diskGb: 50,
    price: '$97.09/mo',
    priceMonthlyUsd: null,
    priceHourlyUsd: null,
    priceMonthly: 97.09,
    priceHourly: 0.133,
    currency: 'USD',
    available: true,
    stale: false,
    status: null,
    catalogSource: 'api',
    catalogLastSeenAt: '2026-11-09T00:00:00.000Z',
    ...extra,
  } as ProviderInstanceOffering;
}
