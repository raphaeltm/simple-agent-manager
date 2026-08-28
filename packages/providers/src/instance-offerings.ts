import type { CredentialProvider, VMSize } from '@simple-agent-manager/shared';

import { DIGITALOCEAN_SIZE_CONFIGS } from './digitalocean';
import { SIZE_MAP as GCP_SIZE_CONFIGS } from './gcp-metadata';
import { HETZNER_SIZE_CONFIGS } from './hetzner-metadata';
import { INFOMANIAK_SIZE_CONFIGS } from './infomaniak';
import { SCALEWAY_SIZE_CONFIGS } from './scaleway';
import type { SizeConfig } from './types';
import { UPCLOUD_SIZE_CONFIGS } from './upcloud';
import { VULTR_SIZE_CONFIGS } from './vultr';

const MONTHLY_HOURS = 730;
const PRICE_CURRENCIES: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

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
  vcpuCount: number;
  memoryMb: number;
  diskGb: number;
}

export function normalizeProviderPrice(price: string | null | undefined): NormalizedProviderPrice {
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
    return {
      priceDisplay,
      priceCurrency: currency,
      priceHourlyMicros,
      priceMonthlyCents: Math.round((priceHourlyMicros * MONTHLY_HOURS) / 10_000),
    };
  }

  if (isMonthly) {
    const priceMonthlyCents = Math.round(amount * 100);
    return {
      priceDisplay,
      priceCurrency: currency,
      priceMonthlyCents,
      priceHourlyMicros: Math.round((priceMonthlyCents * 10_000) / MONTHLY_HOURS),
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
  provider: CredentialProvider
): ProviderInstanceOffering[] {
  const sizeConfigs = getProviderSizeConfigs(provider);
  return (Object.entries(sizeConfigs) as Array<[VMSize, SizeConfig]>).map(([legacyVmSize, config]) =>
    toOffering(provider, legacyVmSize, config)
  );
}

export function getProviderInstanceOfferingForLegacySize(
  provider: CredentialProvider,
  legacyVmSize: VMSize
): ProviderInstanceOffering | null {
  const config = getProviderSizeConfigs(provider)[legacyVmSize];
  return config ? toOffering(provider, legacyVmSize, config) : null;
}

function getProviderSizeConfigs(provider: CredentialProvider): Readonly<Record<VMSize, SizeConfig>> {
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
  config: SizeConfig
): ProviderInstanceOffering {
  return {
    provider,
    legacyVmSize,
    instanceType: config.type,
    vcpuCount: config.vcpu,
    memoryMb: config.ramGb * 1024,
    diskGb: config.storageGb,
    ...normalizeProviderPrice(config.price),
  };
}
