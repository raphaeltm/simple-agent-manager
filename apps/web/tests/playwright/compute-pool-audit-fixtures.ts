type LegacyMachineSize = 'small' | 'medium' | 'large';

const LEGACY_HETZNER_MACHINE_SIZE_BY_SKU = {
  cx23: 'small',
  cx33: 'medium',
  cx43: 'large',
} satisfies Record<string, LegacyMachineSize>;

export function legacyHetznerMachineSizeForSku(sku: string): LegacyMachineSize | null {
  // Keep this Playwright-only mock fixture in sync with
  // packages/providers/src/hetzner-metadata.ts. The production reconciliation
  // policy derives legacy matches directly from provider metadata.
  return LEGACY_HETZNER_MACHINE_SIZE_BY_SKU[sku] ?? null;
}
