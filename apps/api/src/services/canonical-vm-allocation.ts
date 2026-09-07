import type { NativeVMConfig } from '@simple-agent-manager/providers';
import type {
  CapacityPlacementSnapshot,
  CapacityWorkloadRole,
  CredentialProvider,
  CredentialSource,
  ResourceResolutionInput,
  VMLocation,
  VMSize,
} from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import {
  capacityPlacementSnapshotForCandidate,
  hasNoCapacityPoolCandidates,
  type PlacementCredentialAttributionInput,
  type PlacementCredentialProjectPolicy,
  type PlacementEntryPoint,
  type PlacementProjectDefaults,
  PlacementResolutionError,
  type PlacementTaskModeDefault,
  resolveCapacityAwareCredentialLookup,
  resolveCapacityAwareQuotaCredentialSource,
  resolveCapacityPlacementCredentialAttribution,
  resolvePlacementCredentialAttribution,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
  type TaskStartCapacityCandidate,
  type TaskStartCapacityPoolSelection,
  type TaskStartPlacement,
} from './placement-resolver';
import { type ProviderResolutionResult, resolveCredentialSource } from './provider-credentials';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type VMArchitecture = NonNullable<NativeVMConfig['architecture']>;

type NativeAllocationRequest = {
  providerInstanceType?: string | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: VMArchitecture | string | null;
};

export interface CanonicalVmAllocationInput {
  entryPoint: PlacementEntryPoint;
  taskId: string;
  userId: string;
  projectId?: string | null;
  project?: PlacementProjectDefaults | null;
  explicit?: {
    vmSize?: VMSize | string | null;
    provider?: CredentialProvider | string | null;
    vmLocation?: string | null;
    native?: NativeAllocationRequest | null;
  };
  inheritedCredentialAttribution?: PlacementCredentialAttributionInput | null;
  credentialProjectPolicy?: PlacementCredentialProjectPolicy;
  taskModeDefault?: PlacementTaskModeDefault;
  resourceRequirements?: ResourceResolutionInput;
  workloadRole?: CapacityWorkloadRole;
  requiredCredentialSource?: CredentialSource;
  credentialsRequiredMessage?: string;
  capacityPoolEnsure?: boolean;
}

export interface CanonicalVmAllocationPlan {
  placement: TaskStartPlacement;
  credential: Pick<ProviderResolutionResult, 'credentialSource' | 'providerName'>;
  quotaCredentialSource: CredentialSource;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
  effectiveProvider: CredentialProvider;
  vmSize: VMSize;
  vmLocation: VMLocation;
  providerInstanceType: string | null;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: VMArchitecture | null;
  capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
}

export type CanonicalVmAllocationResult =
  | CanonicalVmAllocationPlan
  | { error: string; errorKind: 'placement' | 'credentials' };

export function placementProjectDefaultsFromRow(project: {
  id: string;
  defaultVmSize?: string | null;
  defaultProvider?: string | null;
  defaultLocation?: string | null;
  defaultWorkspaceProfile?: string | null;
  defaultDevcontainerConfigName?: string | null;
  defaultAgentType?: string | null;
}): PlacementProjectDefaults {
  return {
    id: project.id,
    defaultVmSize: project.defaultVmSize ?? null,
    defaultProvider: project.defaultProvider ?? null,
    defaultLocation: project.defaultLocation ?? null,
    defaultWorkspaceProfile: project.defaultWorkspaceProfile ?? null,
    defaultDevcontainerConfigName: project.defaultDevcontainerConfigName ?? null,
    defaultAgentType: project.defaultAgentType ?? null,
  };
}

export async function resolveCanonicalVmAllocationPlan(
  db: Db,
  env: Env,
  input: CanonicalVmAllocationInput
): Promise<CanonicalVmAllocationResult> {
  let placement: TaskStartPlacement;
  try {
    placement = resolveTaskStartPlacement({
      entryPoint: input.entryPoint,
      taskId: input.taskId,
      projectId: input.projectId ?? '',
      userId: input.userId,
      project: input.project ?? directPlacementProjectDefaults(input.projectId ?? null),
      explicit: {
        vmSize: (input.explicit?.vmSize as VMSize | null | undefined) ?? null,
        provider: input.explicit?.provider ?? null,
        vmLocation: input.explicit?.vmLocation ?? null,
      },
      inheritedCredentialAttribution: input.inheritedCredentialAttribution ?? null,
      credentialProjectPolicy: input.credentialProjectPolicy ?? 'current-project',
      taskModeDefault: input.taskModeDefault ?? 'task',
      resourceRequirements: input.resourceRequirements,
      workloadRole: input.workloadRole ?? 'workspace',
    });
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message, errorKind: 'placement' };
    }
    throw err;
  }

  let capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  try {
    capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement, {
      failOpen: false,
      ensure: input.capacityPoolEnsure ?? true,
      env,
    });
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message, errorKind: 'placement' };
    }
    throw err;
  }

  if (capacityPoolSelection && hasNoCapacityPoolCandidates(capacityPoolSelection)) {
    return {
      error: noEligibleCapacityCandidateMessage(placement, capacityPoolSelection),
      errorKind: 'placement',
    };
  }

  const selectedCandidate = selectCapacityCandidate(capacityPoolSelection, input.explicit?.native);
  if (capacityPoolSelection && !selectedCandidate) {
    return {
      error: requestedNativeOfferingUnavailableMessage(input.explicit?.native),
      errorKind: 'placement',
    };
  }

  const effectiveSelection =
    capacityPoolSelection && selectedCandidate
      ? { ...capacityPoolSelection, candidates: [selectedCandidate] }
      : capacityPoolSelection;

  const credentialLookup = resolveCapacityAwareCredentialLookup(placement, effectiveSelection);
  const credential = await resolveCredentialSource(
    db,
    credentialLookup.userId,
    credentialLookup.provider,
    credentialLookup.projectId
  );
  if (!credential) {
    return {
      error:
        input.credentialsRequiredMessage ??
        'No cloud provider credentials found. The user must connect a cloud provider in Settings.',
      errorKind: 'credentials',
    };
  }

  if (
    input.requiredCredentialSource &&
    credential.credentialSource !== input.requiredCredentialSource
  ) {
    return {
      error: `A ${input.requiredCredentialSource} cloud provider credential is required for this allocation.`,
      errorKind: 'credentials',
    };
  }

  if (selectedCandidate) {
    if (!capacityPoolSelection || !effectiveSelection) {
      return {
        error: 'Selected compute-pool candidate is missing its capacity-pool context.',
        errorKind: 'placement',
      };
    }
    if (
      credential.providerName !== selectedCandidate.provider ||
      credential.credentialSource !== selectedCandidate.credentialAttributionSource
    ) {
      return {
        error:
          'The selected compute-pool credential is no longer the active credential for this allocation.',
        errorKind: 'credentials',
      };
    }
    const attribution = resolveCapacityPlacementCredentialAttribution(placement, selectedCandidate);
    const snapshot = capacityPlacementSnapshotForCandidate(
      capacityPoolSelection,
      selectedCandidate
    );
    return planFromAttribution({
      placement,
      credential,
      quotaCredentialSource: resolveCapacityAwareQuotaCredentialSource(
        credential,
        effectiveSelection
      ),
      attribution,
      capacityPoolSelection: effectiveSelection,
      capacityPlacementSnapshot: snapshot,
      vmSize: selectedCandidate.machineSize ?? placement.vmSize,
      vmLocation: selectedCandidate.location,
      native: nativeAllocationFromSnapshot(snapshot),
    });
  }

  const attribution = resolvePlacementCredentialAttribution(placement, credential);
  return planFromAttribution({
    placement,
    credential,
    quotaCredentialSource: resolveCapacityAwareQuotaCredentialSource(credential, null),
    attribution,
    capacityPoolSelection: null,
    capacityPlacementSnapshot: null,
    vmSize: placement.vmSize,
    vmLocation: placement.vmLocation,
    native: normalizeNativeRequest(input.explicit?.native),
  });
}

export function explicitRuntimeAdapterSnapshot(input: {
  runtime: 'cf-container';
  workloadRole?: CapacityWorkloadRole;
  providerInstanceType?: string | null;
}): CapacityPlacementSnapshot {
  return {
    placementPlanVersion: 1,
    capacityPoolId: null,
    capacityPoolScope: null,
    capacityPoolRevision: null,
    capacitySourceId: null,
    capacitySourceGeneration: null,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: null,
    workloadRole: input.workloadRole ?? 'workspace',
    providerInstanceType: input.providerInstanceType ?? input.runtime,
    placementExplanationJson: JSON.stringify({
      kind: 'explicit_runtime_adapter',
      runtime: input.runtime,
      workloadRole: input.workloadRole ?? 'workspace',
    }),
  };
}

function planFromAttribution(input: {
  placement: TaskStartPlacement;
  credential: Pick<ProviderResolutionResult, 'credentialSource' | 'providerName'>;
  quotaCredentialSource: CredentialSource;
  attribution: {
    effectiveProvider: CredentialProvider;
    credentialAttributionUserId: string;
    credentialAttributionProjectId: string | null;
    credentialAttributionSource: CredentialSource;
  };
  capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
  vmSize: VMSize;
  vmLocation: VMLocation;
  native: Required<NativeAllocationRequest>;
}): CanonicalVmAllocationPlan {
  return {
    placement: input.placement,
    credential: input.credential,
    quotaCredentialSource: input.quotaCredentialSource,
    credentialAttributionUserId: input.attribution.credentialAttributionUserId,
    credentialAttributionProjectId: input.attribution.credentialAttributionProjectId,
    credentialAttributionSource: input.attribution.credentialAttributionSource,
    effectiveProvider: input.attribution.effectiveProvider,
    vmSize: input.vmSize,
    vmLocation: input.vmLocation,
    providerInstanceType: input.native.providerInstanceType,
    providerInstanceBootDiskSizeGb: input.native.providerInstanceBootDiskSizeGb,
    providerInstanceImage: input.native.providerInstanceImage,
    providerInstanceArchitecture: input.native
      .providerInstanceArchitecture as VMArchitecture | null,
    capacityPoolSelection: input.capacityPoolSelection,
    capacityPlacementSnapshot: input.capacityPlacementSnapshot,
  };
}

function selectCapacityCandidate(
  selection: TaskStartCapacityPoolSelection | null,
  native: NativeAllocationRequest | null | undefined
): TaskStartCapacityCandidate | null {
  if (!selection) return null;
  const requestedType = normalizeString(native?.providerInstanceType);
  if (!requestedType) return selection.candidates[0] ?? null;
  return (
    selection.candidates.find((candidate) => candidateMatchesNativeRequest(candidate, native)) ??
    null
  );
}

function candidateMatchesNativeRequest(
  candidate: TaskStartCapacityCandidate,
  native: NativeAllocationRequest | null | undefined
): boolean {
  const requestedType = normalizeString(native?.providerInstanceType);
  if (requestedType && candidate.providerInstanceType !== requestedType) return false;

  const requestedBootDisk = native?.providerInstanceBootDiskSizeGb;
  if (requestedBootDisk !== undefined && requestedBootDisk !== null) {
    if (candidate.providerInstanceBootDiskSizeGb !== requestedBootDisk) return false;
  }

  const requestedImage = normalizeString(native?.providerInstanceImage);
  if (requestedImage && candidate.providerInstanceImage !== requestedImage) return false;

  const requestedArchitecture = normalizeArchitecture(native?.providerInstanceArchitecture);
  if (requestedArchitecture && candidate.providerInstanceArchitecture !== requestedArchitecture)
    return false;

  return true;
}

function nativeAllocationFromSnapshot(
  snapshot: CapacityPlacementSnapshot
): Required<NativeAllocationRequest> {
  return {
    providerInstanceType: snapshot.providerInstanceType ?? null,
    providerInstanceBootDiskSizeGb: snapshot.providerInstanceBootDiskSizeGb ?? null,
    providerInstanceImage: snapshot.providerInstanceImage ?? null,
    providerInstanceArchitecture: normalizeArchitecture(snapshot.providerInstanceArchitecture),
  };
}

function normalizeNativeRequest(
  native: NativeAllocationRequest | null | undefined
): Required<NativeAllocationRequest> {
  return {
    providerInstanceType: normalizeString(native?.providerInstanceType),
    providerInstanceBootDiskSizeGb: native?.providerInstanceBootDiskSizeGb ?? null,
    providerInstanceImage: normalizeString(native?.providerInstanceImage),
    providerInstanceArchitecture: normalizeArchitecture(native?.providerInstanceArchitecture),
  };
}

function directPlacementProjectDefaults(projectId: string | null): PlacementProjectDefaults {
  return {
    id: projectId ?? '',
    defaultVmSize: DEFAULT_VM_SIZE,
    defaultLocation: DEFAULT_VM_LOCATION,
  };
}

function requestedNativeOfferingUnavailableMessage(
  native: NativeAllocationRequest | null | undefined
): string {
  const requestedType = normalizeString(native?.providerInstanceType);
  return requestedType
    ? `Requested native compute offering '${requestedType}' is not active in the current default compute pool.`
    : 'No active compute-pool offering satisfies the requested allocation.';
}

function noEligibleCapacityCandidateMessage(
  placement: TaskStartPlacement,
  selection: TaskStartCapacityPoolSelection
): string {
  const provider = placement.provider ? ` provider ${placement.provider}` : '';
  const location = placement.explicitVmLocation ? ` location ${placement.vmLocation}` : '';
  return (
    `No eligible compute-pool offering is available in the ${selection.scope} default pool` +
    `${provider}${location} for the requested ${placement.workloadRole} allocation.`
  );
}

function normalizeString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizeArchitecture(value: string | null | undefined): VMArchitecture | null {
  return value === 'x86_64' || value === 'arm64' ? value : null;
}
