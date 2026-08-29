import type { CapacityPoolScope, CredentialProvider } from '@simple-agent-manager/shared';
import type { VMSize } from '@simple-agent-manager/shared';
import {
  getDefaultLocationForProvider,
  getLocationsForProvider,
} from '@simple-agent-manager/shared';

export interface DefaultPoolScopeIdentity {
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
}

export interface DefaultCapacitySourceReference {
  scope: CapacityPoolScope;
  credentialId: string | null;
  platformCredentialId: string | null;
}

export function orderedLocationsForProvider(provider: CredentialProvider) {
  const locations = getLocationsForProvider(provider);
  const defaultLocation = getDefaultLocationForProvider(provider);
  return [
    ...locations.filter((location) => location.id === defaultLocation),
    ...locations.filter((location) => location.id !== defaultLocation),
  ];
}

export function defaultPoolId(scope: DefaultPoolScopeIdentity): string {
  switch (scope.scope) {
    case 'installation':
      return 'cap-pool-default:installation';
    case 'user':
      return `cap-pool-default:user:${scope.ownerUserId}`;
    case 'project':
      return `cap-pool-default:project:${scope.ownerProjectId}`;
  }
}

export function defaultCapacitySourceId(seed: DefaultCapacitySourceReference): string {
  if (seed.platformCredentialId) {
    return `cap-source-default:platform:${seed.platformCredentialId}`;
  }
  return `cap-source-default:${seed.scope}:${seed.credentialId}`;
}

export function defaultCandidateId(
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  location: string,
  instanceType: string,
  instanceSku?: string | null
): string {
  const offeringKey = encodeURIComponent(instanceSku ?? instanceType);
  return `cap-candidate-default:${poolId}:${sourceId}:${provider}:${location}:${offeringKey}`;
}

export function legacyDefaultCandidateId(
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  location: string,
  size: VMSize
): string {
  return `cap-candidate-default:${poolId}:${sourceId}:${provider}:${location}:${size}`;
}

export function legacyCredentialReference(credentialId: string): string {
  return `credentials:${credentialId}`;
}

export function platformCredentialReference(credentialId: string): string {
  return `platform_credentials:${credentialId}`;
}

export function timestampVersion(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}
