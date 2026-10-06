import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  formatVmSizeInline,
  formatVmSizeOption,
  lookupSizeInfo,
  selectProviderCatalog,
} from '../../../../src/components/vm/format-vm-size';

const catalog: ProviderCatalog = {
  provider: 'hetzner',
  defaultLocation: 'nbg1',
  locations: [{ id: 'nbg1', name: 'Nuremberg', country: 'DE' }],
  sizes: {
    small: { type: 'cx22', vcpu: 2, ramGb: 4, storageGb: 40, price: '€4.35/mo' },
    medium: { type: 'cx32', vcpu: 4, ramGb: 8, storageGb: 80, price: '€7.69/mo' },
    large: { type: 'cx42', vcpu: 8, ramGb: 16, storageGb: 160, price: '€14.51/mo' },
  },
};

const secondCatalog: ProviderCatalog = {
  ...catalog,
  provider: 'scaleway',
  defaultLocation: 'fr-par-1',
  locations: [{ id: 'fr-par-1', name: 'Paris', country: 'FR' }],
  sizes: {
    small: { type: 'DEV1-M', vcpu: 3, ramGb: 4, storageGb: 40, price: '€9.99/mo' },
    medium: { type: 'DEV1-L', vcpu: 4, ramGb: 8, storageGb: 80, price: '€19.99/mo' },
    large: { type: 'DEV1-XL', vcpu: 4, ramGb: 12, storageGb: 120, price: '€29.99/mo' },
  },
};

describe('VM size formatting', () => {
  it('formats exact catalog data including server type, CPU, RAM, storage, and price', () => {
    expect(formatVmSizeInline('medium', catalog.sizes.medium)).toBe(
      'cx32 · 4 vCPU, 8 GB RAM, 80 GB storage · €7.69/mo',
    );
    expect(formatVmSizeOption('medium', catalog.sizes.medium)).toBe(
      'Medium — cx32 (4 vCPU, 8 GB RAM, 80 GB storage) €7.69/mo',
    );
  });

  it('uses non-misleading fallback labels when catalog specs are unavailable', () => {
    expect(formatVmSizeInline('large', null)).toBe('Large — exact specs unavailable');
    expect(formatVmSizeOption('large', null)).toBe('Large — exact specs unavailable');
  });

  it('does not pick an arbitrary provider when multiple catalogs are available', () => {
    expect(selectProviderCatalog([catalog, secondCatalog], null)).toBeNull();
    expect(lookupSizeInfo([catalog, secondCatalog], 'scaleway', 'small')).toEqual(secondCatalog.sizes.small);
  });

  it('uses a single catalog when no provider discriminator is needed', () => {
    expect(selectProviderCatalog([catalog], null)).toBe(catalog);
    expect(lookupSizeInfo([catalog], null, 'small')).toEqual(catalog.sizes.small);
  });
});
