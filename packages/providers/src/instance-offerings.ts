import {
  type CredentialProvider,
  type ProviderInstanceOffering as SharedProviderInstanceOffering,
  resolveApproximateBillingMonthHours,
  type VMSize,
} from '@simple-agent-manager/shared';

import { DIGITALOCEAN_SIZE_CONFIGS } from './digitalocean';
import { SIZE_MAP as GCP_SIZE_CONFIGS } from './gcp-metadata';
import { HETZNER_SIZE_CONFIGS } from './hetzner-metadata';
import { INFOMANIAK_SIZE_CONFIGS } from './infomaniak';
import { SCALEWAY_SIZE_CONFIGS } from './scaleway';
import type { LocationMeta, SizeConfig } from './types';
import { UPCLOUD_SIZE_CONFIGS } from './upcloud';
import { VULTR_SIZE_CONFIGS } from './vultr';

const PRICE_CURRENCIES: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};
const STATIC_CATALOG_SOURCE = 'static';

export interface ProviderPriceNormalizationOptions {
  approximateBillingMonthHours?: number | null;
}

export interface NormalizedProviderPrice {
  priceDisplay: string | null;
  priceCurrency: string | null;
  priceMonthlyCents: number | null;
  priceHourlyMicros: number | null;
}

export interface ProviderInstanceOffering extends NormalizedProviderPrice {
  provider: CredentialProvider;
  legacyVmSize: VMSize;
  instanceType: string;
  instanceSku: string | null;
  displayName: string;
  vcpuCount: number;
  memoryMb: number;
  diskGb: number;
  catalogSource: typeof STATIC_CATALOG_SOURCE;
  catalogLastSeenAt: string | null;
}

export function normalizeProviderPrice(
  price: string | null | undefined,
  options: ProviderPriceNormalizationOptions = {}
): NormalizedProviderPrice {
  const priceDisplay = price?.trim() || null;
  if (!priceDisplay) {
    return {
      priceDisplay: null,
      priceCurrency: null,
      priceMonthlyCents: null,
      priceHourlyMicros: null,
    };
  }

  const match = priceDisplay.match(/([$€£])\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    return {
      priceDisplay,
      priceCurrency: null,
      priceMonthlyCents: null,
      priceHourlyMicros: null,
    };
  }

  const currency = PRICE_CURRENCIES[match[1] ?? ''] ?? null;
  const amount = Number(match[2]);
  if (!currency || !Number.isFinite(amount)) {
    return {
      priceDisplay,
      priceCurrency: null,
      priceMonthlyCents: null,
      priceHourlyMicros: null,
    };
  }

  const isHourly = /(?:\/\s*h\b|\/\s*hr\b|hour)/i.test(priceDisplay);
  const isMonthly = /(?:\/\s*mo\b|month)/i.test(priceDisplay);

  if (isHourly) {
    const priceHourlyMicros = Math.round(amount * 1_000_000);
    const billingMonthHours = resolveApproximateBillingMonthHours(
      options.approximateBillingMonthHours
    );
    return {
      priceDisplay,
      priceCurrency: currency,
      priceHourlyMicros,
      priceMonthlyCents: Math.round((priceHourlyMicros * billingMonthHours) / 10_000),
    };
  }

  if (isMonthly) {
    const priceMonthlyCents = Math.round(amount * 100);
    const billingMonthHours = resolveApproximateBillingMonthHours(
      options.approximateBillingMonthHours
    );
    return {
      priceDisplay,
      priceCurrency: currency,
      priceMonthlyCents,
      priceHourlyMicros: Math.round((priceMonthlyCents * 10_000) / billingMonthHours),
    };
  }

  return {
    priceDisplay,
    priceCurrency: currency,
    priceMonthlyCents: null,
    priceHourlyMicros: null,
  };
}

export function getProviderInstanceOfferings(
  provider: CredentialProvider,
  options: ProviderPriceNormalizationOptions = {}
): ProviderInstanceOffering[] {
  const sizeConfigs = getProviderSizeConfigs(provider);
  return (Object.entries(sizeConfigs) as Array<[VMSize, SizeConfig]>).map(([legacyVmSize, config]) =>
    toOffering(provider, legacyVmSize, config, options)
  );
}

export function getProviderCatalogOfferings(
  provider: CredentialProvider,
  locations: readonly string[],
  locationMetadata: Readonly<Record<string, LocationMeta>>
): SharedProviderInstanceOffering[] {
  const offerings = getProviderInstanceOfferings(provider);

  return locations.flatMap((location) =>
    offerings.map((offering) => {
      const locationMeta = locationMetadata[location];
      const priceMonthly =
        offering.priceMonthlyCents === null ? null : offering.priceMonthlyCents / 100;
      const priceHourly =
        offering.priceHourlyMicros === null ? null : offering.priceHourlyMicros / 1_000_000;
      const isUsd = offering.priceCurrency === 'USD';

      return {
        provider,
        location,
        providerInstanceType: offering.instanceType,
        providerInstanceSku: offering.instanceSku,
        displayName: offering.displayName,
        id: offering.instanceType,
        sku: offering.instanceSku ?? offering.instanceType,
        instanceType: offering.instanceType,
        type: offering.instanceType,
        name: offering.displayName,
        vcpu: offering.vcpuCount,
        ramGb: offering.memoryMb / 1024,
        memoryGb: offering.memoryMb / 1024,
        memoryMb: offering.memoryMb,
        storageGb: offering.diskGb,
        diskGb: offering.diskGb,
        priceMonthlyUsd: isUsd ? priceMonthly : null,
        priceHourlyUsd: isUsd ? priceHourly : null,
        priceMonthly,
        priceHourly,
        currency: offering.priceCurrency,
        available: true,
        stale: false,
        status: null,
        machineSize: offering.legacyVmSize,
        catalogSource: offering.catalogSource,
        catalogLastSeenAt: offering.catalogLastSeenAt,
        catalogMetadata: {
          priceLabel: offering.priceDisplay,
          ...(locationMeta
            ? { locationName: locationMeta.name, locationCountry: locationMeta.country }
            : {}),
        },
        ...(offering.priceDisplay ? { price: offering.priceDisplay } : {}),
        ...(locationMeta ? { locationName: locationMeta.name, country: locationMeta.country } : {}),
      };
    })
  );
}

export function getProviderInstanceOfferingForLegacySize(
  provider: CredentialProvider,
  legacyVmSize: VMSize,
  options: ProviderPriceNormalizationOptions = {}
): ProviderInstanceOffering | null {
  const config = getProviderSizeConfigs(provider)[legacyVmSize];
  return config ? toOffering(provider, legacyVmSize, config, options) : null;
}

function getProviderSizeConfigs(
  provider: CredentialProvider
): Readonly<Record<VMSize, SizeConfig>> {
  switch (provider) {
    case 'hetzner':
      return HETZNER_SIZE_CONFIGS;
    case 'infomaniak':
      return INFOMANIAK_SIZE_CONFIGS;
    case 'scaleway':
      return SCALEWAY_SIZE_CONFIGS;
    case 'vultr':
      return VULTR_SIZE_CONFIGS;
    case 'digitalocean':
      return DIGITALOCEAN_SIZE_CONFIGS;
    case 'upcloud':
      return UPCLOUD_SIZE_CONFIGS;
    case 'gcp':
      return GCP_SIZE_CONFIGS;
  }
}

function toOffering(
  provider: CredentialProvider,
  legacyVmSize: VMSize,
  config: SizeConfig,
  options: ProviderPriceNormalizationOptions
): ProviderInstanceOffering {
  return {
    provider,
    legacyVmSize,
    instanceType: config.type,
    instanceSku: null,
    displayName: displayNameForSize(config),
    vcpuCount: config.vcpu,
    memoryMb: config.ramGb * 1024,
    diskGb: config.storageGb,
    catalogSource: STATIC_CATALOG_SOURCE,
    catalogLastSeenAt: null,
    ...normalizeProviderPrice(config.price, options),
  };
}

function displayNameForSize(config: SizeConfig): string {
  return `${config.type} · ${config.vcpu} vCPU · ${config.ramGb} GB RAM · ${config.storageGb} GB disk`;
}
