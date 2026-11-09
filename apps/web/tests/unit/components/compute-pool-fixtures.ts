/** Shared fixtures for the compute pool panel and editor tests. */
import type {
  CapacityPoolCandidate,
  CapacityPoolScope,
  DefaultCapacityPoolSummary,
  ProjectDefaultCapacityPoolsResponse,
  ProviderCatalog,
} from '@simple-agent-manager/shared';

export function providerCatalog(credentialId = 'credential-project'): ProviderCatalog {
  return {
    provider: 'hetzner',
    credentialSource: 'project',
    credentialId,
    locations: [
      { id: 'fsn1', name: 'Nuremberg', country: 'DE' },
      { id: 'ash', name: 'Ashburn', country: 'US' },
      { id: 'hil', name: 'Hillsboro', country: 'US' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
    ],
    sizes: {
      small: {
        type: 'cx22',
        price: '€3.79/mo',
        vcpu: 2,
        ramGb: 4,
        storageGb: 40,
      },
      medium: {
        type: 'cpx31',
        price: '€13.10/mo',
        vcpu: 4,
        ramGb: 8,
        storageGb: 160,
      },
      large: {
        type: 'ccx33',
        price: '€55.20/mo',
        vcpu: 8,
        ramGb: 32,
        storageGb: 240,
      },
    },
    offerings: [
      {
        provider: 'hetzner',
        providerInstanceType: 'cx22',
        providerInstanceSku: null,
        displayName: 'CX22',
        sku: 'cx22',
        location: 'fsn1',
        locationName: 'Nuremberg',
        country: 'DE',
        vcpu: 2,
        memoryMb: 4096,
        memoryGb: 4,
        diskGb: 40,
        price: '€3.79/mo',
        priceMonthly: 3.79,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'cpx31',
        providerInstanceSku: null,
        displayName: 'CPX31',
        sku: 'cpx31',
        location: 'ash',
        locationName: 'Ashburn',
        country: 'US',
        vcpu: 4,
        memoryMb: 8192,
        memoryGb: 8,
        diskGb: 160,
        price: '€13.10/mo',
        priceMonthly: 13.1,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'ccx33',
        providerInstanceSku: null,
        displayName: 'CCX33',
        sku: 'ccx33',
        location: 'hil',
        locationName: 'Hillsboro',
        country: 'US',
        vcpu: 8,
        memoryMb: 32_768,
        memoryGb: 32,
        diskGb: 240,
        price: '€55.20/mo',
        priceMonthly: 55.2,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType:
          'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only',
        providerInstanceSku: null,
        displayName: 'Long catalog-only SKU',
        sku: 'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only',
        location: 'hel1',
        locationName: 'Helsinki',
        country: 'FI',
        vcpu: 16,
        memoryMb: 65_536,
        memoryGb: 64,
        diskGb: 480,
        price: '€220.00/mo',
        priceMonthly: 220,
        currency: 'EUR',
        available: false,
        status: 'temporarily unavailable',
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
    ],
    defaultLocation: 'fsn1',
  };
}

export function candidate(overrides: Partial<CapacityPoolCandidate> = {}): CapacityPoolCandidate {
  const machineSize = overrides.machineSize ?? 'medium';
  const sku =
    overrides.providerInstanceType ??
    (machineSize === 'small' ? 'cx22' : machineSize === 'large' ? 'ccx33' : 'cpx31');
  const vcpu = sku === 'cx22' ? 2 : sku === 'ccx33' ? 8 : 4;
  const memoryMb = sku === 'cx22' ? 4096 : sku === 'ccx33' ? 32_768 : 8192;
  const diskGb = sku === 'cx22' ? 40 : sku === 'ccx33' ? 240 : 160;
  const priceDisplay = sku === 'cx22' ? '€3.79/mo' : sku === 'ccx33' ? '€55.20/mo' : '€13.10/mo';

  return {
    id: 'candidate-1',
    poolId: 'pool-project',
    capacitySourceId: 'source-project',
    provider: 'hetzner',
    location: 'fsn1',
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize,
    providerInstanceType: sku,
    providerInstanceVcpuCount: vcpu,
    providerInstanceMemoryMb: memoryMb,
    providerInstanceDiskGb: diskGb,
    providerInstancePriceDisplay: priceDisplay,
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: sku === 'cx22' ? 379 : sku === 'ccx33' ? 5520 : 1310,
    providerInstancePriceHourlyMicros: null,
    priority: 0,
    candidateOrder: 0,
    status: 'active',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

export function summary(scope: CapacityPoolScope): DefaultCapacityPoolSummary {
  return {
    pool: {
      id: `pool-${scope}`,
      scope,
      ownerUserId: scope === 'user' ? 'user-1' : null,
      ownerProjectId: scope === 'project' ? 'project-1' : null,
      name: `${scope} default pool`,
      isDefault: true,
      revision: 3,
      status: 'active',
      strategy: 'balanced',
      deploymentStrategy: 'smallest-fit',
      exhaustionPolicy: 'queue',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    sources: [
      {
        id: `source-${scope}`,
        scope,
        ownerUserId: scope === 'user' ? 'user-1' : null,
        ownerProjectId: scope === 'project' ? 'project-1' : null,
        sourceKind: 'cloud-provider-credential',
        provider: 'hetzner',
        credentialSource: scope === 'installation' ? 'platform' : scope,
        credentialId: scope === 'installation' ? null : `credential-${scope}`,
        platformCredentialId: scope === 'installation' ? 'platform-credential-1' : null,
        credentialReference:
          scope === 'installation'
            ? 'platform_credentials:platform-credential-1'
            : `credentials:credential-${scope}`,
        credentialVersion: 1787875200000,
        externalSourceRef: null,
        status: 'active',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
    ],
    candidates: [
      candidate({
        id: `candidate-${scope}-cx22`,
        machineSize: 'small',
        providerInstanceType: 'cx22',
      }),
      candidate({
        id: `candidate-${scope}-cpx31`,
        location: 'ash',
        machineSize: 'medium',
        providerInstanceType: 'cpx31',
        candidateOrder: 1,
      }),
    ],
    activeCandidateCount: 2,
  };
}

export function response(
  effectiveScope: CapacityPoolScope | null,
  effective: DefaultCapacityPoolSummary | null
): ProjectDefaultCapacityPoolsResponse {
  const installationContext = effectiveScope === 'installation';
  return {
    effective,
    effectiveScope,
    defaults: [
      {
        scope: 'project',
        visibility: installationContext ? 'hidden' : 'visible',
        visibilityReason: installationContext ? 'project-context-required' : 'project-secret-read',
        canReconcile: !installationContext,
        summary: effectiveScope === 'project' ? effective : null,
      },
      {
        scope: 'user',
        visibility: installationContext ? 'hidden' : 'visible',
        visibilityReason: installationContext
          ? 'authenticated-user-context-required'
          : 'authenticated-user',
        canReconcile: !installationContext,
        summary: effectiveScope === 'user' ? effective : null,
      },
      {
        scope: 'installation',
        visibility: installationContext ? 'visible' : 'hidden',
        visibilityReason: installationContext ? 'superadmin' : 'superadmin-required',
        canReconcile: installationContext,
        summary: effectiveScope === 'installation' ? effective : null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: ['project', 'user'],
    policyMutationSupported: true,
  };
}

export const LONG_SKU = 'long-provider-native-sku-name-that-needs-to-wrap-cleanly-catalog-only';

