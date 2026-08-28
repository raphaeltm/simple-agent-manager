import type {
  AgentProfileRuntime,
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
  CapacityWorkloadRole,
  CredentialProvider,
  CredentialSource,
  ResolvedResourceReservation,
  ResourceRequirementsSource,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import {
  canSatisfyVmSize,
  CREDENTIAL_PROVIDERS,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  getLocationsForProvider,
  isCapacityPlacementCredentialSource,
  isValidLocationForProvider,
  isValidProvider,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import { log } from '../lib/logger';
import {
  type CapacityPoolSummary,
  resolveEffectiveDefaultCapacityPoolSummary,
} from './default-capacity-pools';
import type {
  CapacityAwareNodePlacementRow,
  PlacementCredentialAttribution,
  PlacementCredentialAttributionInput,
  PlacementCredentialLookup,
  PlacementCredentialProjectPolicy,
  PlacementCredentialSourceResult,
  PlacementExplicitOverrides,
  PlacementProfileDefaults,
  PlacementProfileVmSizeSource,
  PlacementProjectDefaults,
  PlacementResolutionErrorCode,
  PlacementRuntimeResolution,
  PlacementTaskModeDefault,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
  TaskStartPlacementInput,
  TaskStartPlacementWithCredential,
} from './placement-resolver-types';
import { resolveCredentialSource } from './provider-credentials';
import type { WorkspaceRuntimeDecision } from './workspace-runtime';

export type {
  CapacityAwareNodePlacementRow,
  PlacementCredentialAttribution,
  PlacementCredentialAttributionInput,
  PlacementCredentialLookup,
  PlacementCredentialProjectPolicy,
  PlacementCredentialSourceResult,
  PlacementEntryPoint,
  PlacementExplicitOverrides,
  PlacementProfileDefaults,
  PlacementProfileVmSizeSource,
  PlacementProjectDefaults,
  PlacementResolutionErrorCode,
  PlacementRuntimeResolution,
  PlacementTaskModeDefault,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
  TaskStartPlacementInput,
  TaskStartPlacementWithCredential,
} from './placement-resolver-types';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export class PlacementResolutionError extends Error {
  readonly code: PlacementResolutionErrorCode;
  readonly validValues: readonly string[];

  constructor(code: PlacementResolutionErrorCode, message: string, validValues: readonly string[]) {
    super(message);
    this.name = 'PlacementResolutionError';
    this.code = code;
    this.validValues = validValues;
  }
}

export function resolvePlacementRuntimePreference(input: {
  explicitRuntime?: AgentProfileRuntime | null;
  profile?: PlacementProfileDefaults | null;
}): AgentProfileRuntime | null {
  return input.explicitRuntime ?? input.profile?.runtime ?? null;
}

export function resolveEffectivePlacementRuntime(input: {
  requestedRuntime: AgentProfileRuntime | null;
  runtimeDecision?: WorkspaceRuntimeDecision | null;
}): PlacementRuntimeResolution {
  const decision = input.runtimeDecision ?? null;
  const isInstantRuntime = decision?.reason === 'explicit-cf-container';

  return {
    requestedRuntime: input.requestedRuntime,
    decision,
    executionRuntime: isInstantRuntime ? 'cf-container' : 'vm',
    isInstantRuntime,
    reason: decision?.reason ?? 'vm-only',
  };
}

export function resolveTaskStartPlacement(input: TaskStartPlacementInput): TaskStartPlacement {
  const profile = input.profile ?? null;
  const explicit = input.explicit ?? {};
  const provider = resolveProvider(explicit.provider, profile, input.project);
  const vmLocation = resolveVmLocation(explicit.vmLocation, profile, input.project, provider);
  const workspaceProfile = resolveWorkspaceProfile(
    explicit.workspaceProfile,
    profile,
    input.project
  );
  const runtime = resolveEffectivePlacementRuntime({
    requestedRuntime: resolvePlacementRuntimePreference({
      explicitRuntime: explicit.runtime,
      profile,
    }),
    runtimeDecision: input.runtimeDecision,
  });

  if (input.validateLocation !== false && !runtime.isInstantRuntime) {
    validateResolvedLocation(provider, vmLocation);
  }

  const inheritedCredentialAttribution = normalizeCredentialAttribution(
    input.inheritedCredentialAttribution
  );

  return {
    entryPoint: input.entryPoint,
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    vmSize: resolveVmSize(explicit.vmSize, profile, input.project),
    vmSizeSource: resolveVmSizeSource(
      explicit,
      profile,
      input.project,
      input.profileVmSizeSource ?? 'agent-profile'
    ),
    provider,
    vmLocation,
    explicitVmLocation: explicit.vmLocation != null,
    workspaceProfile,
    devcontainerConfigName: resolveDevcontainerConfigName(
      workspaceProfile,
      explicit.devcontainerConfigName,
      profile,
      input.project
    ),
    taskMode: resolveTaskMode(explicit.taskMode, profile, workspaceProfile, input.taskModeDefault),
    agentType: explicit.agentType ?? profile?.agentType ?? input.project.defaultAgentType ?? null,
    resolvedReservation: resolveResourceReservation(input.resourceRequirements ?? {}, {
      taskId: input.taskId,
      triggerId: input.triggerId,
      skillId: profile?.skillId ?? undefined,
      agentProfileId: profile?.profileId ?? undefined,
      projectId: input.projectId,
      userId: input.userId,
    }),
    credentialLookup: resolveCredentialLookup({
      userId: input.userId,
      projectId: input.projectId,
      provider,
      inheritedCredentialAttribution,
      projectPolicy: input.credentialProjectPolicy,
    }),
    inheritedCredentialAttribution,
    runtime,
  };
}

export function resolvePlacementCredentialAttribution(
  placement: TaskStartPlacement,
  credential: PlacementCredentialSourceResult
): PlacementCredentialAttribution {
  const inherited = placement.inheritedCredentialAttribution;
  const credentialAttributionSource = inherited.source ?? credential.credentialSource;
  const credentialAttributionProjectId =
    credentialAttributionSource === 'project'
      ? (inherited.projectId ?? placement.credentialLookup.projectId ?? placement.projectId)
      : null;

  return {
    effectiveProvider: placement.provider ?? credential.providerName,
    credentialAttributionUserId: inherited.userId ?? placement.credentialLookup.userId,
    credentialAttributionProjectId,
    credentialAttributionSource,
  };
}

export async function resolveTaskStartCapacityPoolSelection(
  db: Db,
  placement: TaskStartPlacement,
  options: { ensure?: boolean; failOpen?: boolean } = {}
): Promise<TaskStartCapacityPoolSelection | null> {
  if (placement.runtime.isInstantRuntime) return null;

  try {
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db, {
      userId: placement.userId,
      projectId: placement.projectId,
      ensure: options.ensure ?? true,
    });
    if (!summary) return null;

    const selection = buildCapacityPoolSelection(summary, placement, 'workspace');
    return selection?.candidates.length ? selection : null;
  } catch (error) {
    if (options.failOpen === false) throw error;
    log.warn('placement_resolver.capacity_pool_unavailable', {
      taskId: placement.taskId,
      projectId: placement.projectId,
      userId: placement.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function resolveCapacityAwareCredentialLookup(
  placement: TaskStartPlacement,
  capacityPoolSelection: TaskStartCapacityPoolSelection | null
): PlacementCredentialLookup {
  const candidate = capacityPoolSelection?.candidates[0] ?? null;
  if (!candidate) return placement.credentialLookup;

  return {
    userId: placement.credentialLookup.userId,
    projectId:
      candidate.credentialAttributionSource === 'project'
        ? (candidate.capacityPoolProjectId ?? placement.projectId)
        : null,
    provider: candidate.provider,
  };
}

export function resolveCapacityPlacementCredentialAttribution(
  placement: TaskStartPlacement,
  candidate: TaskStartCapacityCandidate
): PlacementCredentialAttribution {
  return {
    effectiveProvider: candidate.provider,
    credentialAttributionUserId: placement.credentialLookup.userId,
    credentialAttributionProjectId:
      candidate.credentialAttributionSource === 'project'
        ? (candidate.capacityPoolProjectId ?? placement.projectId)
        : null,
    credentialAttributionSource: candidate.credentialAttributionSource,
  };
}

export function resolveCapacityAwareQuotaCredentialSource(
  credential: PlacementCredentialSourceResult,
  capacityPoolSelection: TaskStartCapacityPoolSelection | null
): CredentialSource {
  const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;
  if (
    credential.credentialSource === 'platform' ||
    capacityCandidate?.credentialAttributionSource === 'platform'
  ) {
    return 'platform';
  }
  return capacityCandidate?.credentialAttributionSource ?? credential.credentialSource;
}

export async function resolveTaskStartPlacementCredentialAttribution(
  db: Db,
  input: TaskStartPlacementInput,
  options?: { credentialsRequiredMessage?: string }
): Promise<TaskStartPlacementWithCredential | { error: string }> {
  let placement: TaskStartPlacement;
  try {
    placement = resolveTaskStartPlacement(input);
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message };
    }
    throw err;
  }

  const capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement);
  const credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
  const credential = await resolveCredentialSource(
    db,
    credentialLookup.userId,
    credentialLookup.provider,
    credentialLookup.projectId
  );
  if (!credential) {
    return {
      error:
        options?.credentialsRequiredMessage ??
        'No cloud provider credentials found. The user must connect a cloud provider in Settings.',
    };
  }

  const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;

  return {
    placement,
    credential,
    capacityPoolSelection,
    ...(capacityCandidate
      ? resolveCapacityPlacementCredentialAttribution(placement, capacityCandidate)
      : resolvePlacementCredentialAttribution(placement, credential)),
  };
}

export function capacityPoolSnapshotForPool(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    'poolId' | 'scope' | 'revision' | 'strategy' | 'capacityPoolProjectId' | 'workloadRole'
  >
): CapacityPlacementSnapshot {
  return {
    capacityPoolId: selection.poolId,
    capacityPoolScope: selection.scope,
    capacityPoolRevision: selection.revision,
    capacitySourceId: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: selection.capacityPoolProjectId,
    workloadRole: selection.workloadRole,
    placementExplanationJson: buildCapacityPlacementExplanation(selection),
  };
}

export function capacityPlacementSnapshotForTaskStart(
  selection: TaskStartCapacityPoolSelection | null | undefined
): CapacityPlacementSnapshot | null {
  return selection?.candidates[0]?.snapshot ?? selection?.poolSnapshot ?? null;
}

export function resolveReusableNodeCapacitySnapshot(input: {
  selection: TaskStartCapacityPoolSelection | null | undefined;
  node: CapacityAwareNodePlacementRow;
  projectId: string;
  requestedVmSize: string;
  requestedReservation?: ResolvedResourceReservation | null;
}): CapacityPlacementSnapshot | null | undefined {
  const selection = input.selection ?? null;
  const node = input.node;

  if (!selection) {
    if (node.capacityPoolScope === 'project') return undefined;
    return null;
  }

  if (!node.capacityPoolId) {
    return selection.scope === 'project' ? undefined : capacityPoolSnapshotForPool(selection);
  }

  if (selection.scope === 'project') {
    if (node.capacityPoolScope !== 'project') return undefined;
    if (node.capacityPoolId !== selection.poolId) return undefined;
    if (node.capacityPoolProjectId !== input.projectId) return undefined;
  } else {
    if (node.capacityPoolScope === 'project') return undefined;
    if (node.capacityPoolId !== selection.poolId) return undefined;
  }

  const candidate = selectCandidateForReusableNode(
    selection,
    node,
    input.requestedVmSize,
    input.requestedReservation ?? null
  );
  return candidate?.snapshot;
}

function buildCapacityPoolSelection(
  summary: CapacityPoolSummary,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole
): TaskStartCapacityPoolSelection | null {
  const pool = summary.pool;
  const sourceById = new Map(summary.sources.map((source) => [source.id, source]));
  const baseSelection: Omit<TaskStartCapacityPoolSelection, 'poolSnapshot' | 'candidates'> = {
    poolId: pool.id,
    scope: pool.scope,
    revision: pool.revision,
    strategy: pool.strategy,
    capacityPoolProjectId:
      pool.scope === 'project' ? (pool.ownerProjectId ?? placement.projectId) : null,
    workloadRole,
  };
  const poolSnapshot = capacityPoolSnapshotForPool(baseSelection);

  const candidates = summary.candidates
    .flatMap((candidate) => {
      const source = sourceById.get(candidate.capacitySourceId);
      if (!source) return [];
      const normalized = normalizeCapacityCandidate(
        pool,
        candidate,
        source,
        placement,
        workloadRole
      );
      return normalized ? [normalized] : [];
    })
    .sort((a, b) => compareCapacityCandidates(a, b, pool.strategy, placement.resolvedReservation));

  return {
    ...baseSelection,
    poolSnapshot,
    candidates,
  };
}

function normalizeCapacityCandidate(
  pool: CapacityPoolDto,
  candidate: CapacityPoolCandidateDto,
  source: CapacitySourceIdentity,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole
): TaskStartCapacityCandidate | null {
  if (!isActiveCapacityPlacementOption(pool, source, candidate)) return null;
  if (candidate.workloadRole !== workloadRole) return null;
  if (candidate.runtime && candidate.runtime !== placement.runtime.executionRuntime) return null;
  if (source.sourceKind !== 'cloud-provider-credential') return null;
  if (!candidate.provider || !isValidProvider(candidate.provider)) return null;
  if (!candidate.location || !isValidLocationForProvider(candidate.provider, candidate.location)) {
    return null;
  }
  const providerInstanceType = nonEmptyString(candidate.providerInstanceType);
  if (!providerInstanceType) return null;
  const providerInstanceVcpuCount = positiveInteger(candidate.providerInstanceVcpuCount);
  const providerInstanceMemoryMb = positiveInteger(candidate.providerInstanceMemoryMb);
  if (providerInstanceVcpuCount === null || providerInstanceMemoryMb === null) return null;
  const providerInstanceDiskGb = optionalPositiveInteger(candidate.providerInstanceDiskGb);
  if (
    !capacityCandidateSatisfiesReservation(
      {
        providerInstanceVcpuCount,
        providerInstanceMemoryMb,
        providerInstanceDiskGb,
      },
      placement.resolvedReservation
    )
  ) {
    return null;
  }
  // Keep the candidate aligned with the resolved placement: reject a candidate
  // whose provider differs from the resolved provider (credential/source may be
  // provider-specific), and reject a candidate whose location differs from an
  // explicitly requested vmLocation. When no location is explicitly requested,
  // preserve flexible location matching for the resolved provider.
  if (placement.provider && candidate.provider !== placement.provider) return null;
  if (placement.explicitVmLocation && candidate.location !== placement.vmLocation) return null;
  if (!isCredentialPlacementSource(source.credentialSource)) return null;

  const capacityPoolProjectId =
    pool.scope === 'project' ? (pool.ownerProjectId ?? placement.projectId) : null;
  const normalized: Omit<TaskStartCapacityCandidate, 'snapshot'> = {
    id: candidate.id,
    poolId: candidate.poolId,
    capacitySourceId: candidate.capacitySourceId,
    provider: candidate.provider,
    location: candidate.location as VMLocation,
    workloadRole: candidate.workloadRole,
    runtime: candidate.runtime,
    machineClass: candidate.machineClass,
    machineSize: normalizeLegacyVmSize(candidate.machineSize),
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstancePriceDisplay: candidate.providerInstancePriceDisplay,
    providerInstancePriceCurrency: nonEmptyString(candidate.providerInstancePriceCurrency),
    providerInstancePriceMonthlyCents: nonNegativeInteger(
      candidate.providerInstancePriceMonthlyCents
    ),
    providerInstancePriceHourlyMicros: nonNegativeInteger(
      candidate.providerInstancePriceHourlyMicros
    ),
    priority: candidate.priority,
    candidateOrder: candidate.candidateOrder,
    credentialAttributionSource: source.credentialSource,
    placementCredentialSource: source.credentialSource,
    placementCredentialReference: source.credentialReference,
    placementCredentialVersion: source.credentialVersion,
    capacityPoolProjectId,
  };

  return {
    ...normalized,
    snapshot: {
      capacityPoolId: pool.id,
      capacityPoolScope: pool.scope,
      capacityPoolRevision: pool.revision,
      capacitySourceId: source.id,
      capacityPoolCandidateId: candidate.id,
      placementCredentialSource: source.credentialSource,
      placementCredentialReference: source.credentialReference,
      placementCredentialVersion: source.credentialVersion,
      capacityPoolProjectId,
      workloadRole: candidate.workloadRole,
      providerInstanceType,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      providerInstancePriceDisplay: candidate.providerInstancePriceDisplay,
      providerInstancePriceCurrency: nonEmptyString(candidate.providerInstancePriceCurrency),
      providerInstancePriceMonthlyCents: nonNegativeInteger(
        candidate.providerInstancePriceMonthlyCents
      ),
      providerInstancePriceHourlyMicros: nonNegativeInteger(
        candidate.providerInstancePriceHourlyMicros
      ),
      placementExplanationJson: buildCapacityPlacementExplanation(
        {
          poolId: pool.id,
          scope: pool.scope,
          revision: pool.revision,
          strategy: pool.strategy,
          capacityPoolProjectId,
          workloadRole,
        },
        normalized
      ),
    },
  };
}

function isActiveCapacityPlacementOption(
  pool: CapacityPoolDto,
  source: CapacitySourceIdentity,
  candidate: CapacityPoolCandidateDto
): boolean {
  return pool.status === 'active' && source.status === 'active' && candidate.status === 'active';
}

function selectCandidateForReusableNode(
  selection: TaskStartCapacityPoolSelection,
  node: CapacityAwareNodePlacementRow,
  requestedVmSize: string,
  requestedReservation: ResolvedResourceReservation | null
): TaskStartCapacityCandidate | null {
  if (!node.capacitySourceId) return null;

  const exactCandidate = node.capacityPoolCandidateId
    ? selection.candidates.find((candidate) => candidate.id === node.capacityPoolCandidateId)
    : null;
  if (
    exactCandidate &&
    capacityCandidateMatchesNode(exactCandidate, node, requestedVmSize, requestedReservation)
  ) {
    return exactCandidate;
  }

  return (
    selection.candidates.find((candidate) =>
      capacityCandidateMatchesNode(candidate, node, requestedVmSize, requestedReservation)
    ) ?? null
  );
}

function capacityCandidateMatchesNode(
  candidate: TaskStartCapacityCandidate,
  node: CapacityAwareNodePlacementRow,
  requestedVmSize: string,
  requestedReservation: ResolvedResourceReservation | null
): boolean {
  if (candidate.capacitySourceId !== node.capacitySourceId) return false;
  if (node.cloudProvider && candidate.provider !== node.cloudProvider) return false;
  if (node.vmLocation && candidate.location !== node.vmLocation) return false;
  if (node.providerInstanceType) {
    if (candidate.providerInstanceType !== node.providerInstanceType) return false;
  } else if (candidate.machineSize && node.vmSize) {
    if (!canSatisfyVmSize(node.vmSize, candidate.machineSize)) return false;
  } else {
    return false;
  }

  if (requestedReservation) {
    if (
      !nodeOfferingSatisfiesReservation(
        node,
        requestedReservation,
        node.providerInstanceType ? candidate : null
      )
    ) {
      return false;
    }
  }

  if (node.providerInstanceType) return true;
  return node.vmSize ? canSatisfyVmSize(node.vmSize, requestedVmSize) : false;
}

function compareCapacityCandidates(
  a: TaskStartCapacityCandidate,
  b: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation
): number {
  const capacityDiff = compareOfferingCapacity(a, b);
  if (strategy === 'pack' && capacityDiff !== 0) return -capacityDiff;
  if (strategy === 'smallest-fit') {
    const fitDiff = compareOfferingFitSurplus(a, b, reservation);
    if (fitDiff !== 0) return fitDiff;
    const priceDiff = compareOfferingPrice(a, b);
    if (priceDiff !== 0) return priceDiff;
    if (capacityDiff !== 0) return capacityDiff;
  }
  if (a.priority !== b.priority) return a.priority - b.priority;
  const priceDiff = compareOfferingPrice(a, b);
  if (priceDiff !== 0) return priceDiff;
  if (strategy !== 'pack' && capacityDiff !== 0) return capacityDiff;
  if (a.candidateOrder !== b.candidateOrder) return a.candidateOrder - b.candidateOrder;
  return a.id.localeCompare(b.id);
}

function capacityCandidateSatisfiesReservation(
  candidate: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): boolean {
  if (candidate.providerInstanceVcpuCount * 1000 < reservation.cpuMillis) return false;
  if (candidate.providerInstanceMemoryMb < reservation.memoryMb) return false;
  if (
    candidate.providerInstanceDiskGb !== null &&
    candidate.providerInstanceDiskGb * 1024 < reservation.diskMb
  ) {
    return false;
  }
  return true;
}

function nodeOfferingSatisfiesReservation(
  node: CapacityAwareNodePlacementRow,
  reservation: ResolvedResourceReservation,
  fallbackCandidate: TaskStartCapacityCandidate | null
): boolean {
  const vcpuCount = positiveInteger(node.providerInstanceVcpuCount);
  const memoryMb = positiveInteger(node.providerInstanceMemoryMb);
  const diskGb = optionalPositiveInteger(node.providerInstanceDiskGb);

  if (vcpuCount !== null && memoryMb !== null) {
    return capacityCandidateSatisfiesReservation(
      {
        providerInstanceVcpuCount: vcpuCount,
        providerInstanceMemoryMb: memoryMb,
        providerInstanceDiskGb: diskGb,
      },
      reservation
    );
  }

  if (fallbackCandidate) {
    return capacityCandidateSatisfiesReservation(fallbackCandidate, reservation);
  }

  return true;
}

function compareOfferingCapacity(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >
): number {
  const cpuDiff = a.providerInstanceVcpuCount - b.providerInstanceVcpuCount;
  if (cpuDiff !== 0) return cpuDiff;
  const memoryDiff = a.providerInstanceMemoryMb - b.providerInstanceMemoryMb;
  if (memoryDiff !== 0) return memoryDiff;
  return (a.providerInstanceDiskGb ?? 0) - (b.providerInstanceDiskGb ?? 0);
}

function compareOfferingFitSurplus(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  return offeringFitSurplus(a, reservation) - offeringFitSurplus(b, reservation);
}

function offeringFitSurplus(
  candidate: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  const cpuBase = Math.max(1, reservation.cpuMillis);
  const memoryBase = Math.max(1, reservation.memoryMb);
  const diskBase = Math.max(1, reservation.diskMb);
  const cpuSurplus = Math.max(0, candidate.providerInstanceVcpuCount * 1000 - reservation.cpuMillis);
  const memorySurplus = Math.max(0, candidate.providerInstanceMemoryMb - reservation.memoryMb);
  const diskSurplus =
    candidate.providerInstanceDiskGb === null
      ? 0
      : Math.max(0, candidate.providerInstanceDiskGb * 1024 - reservation.diskMb);
  return cpuSurplus / cpuBase + memorySurplus / memoryBase + diskSurplus / diskBase;
}

function compareOfferingPrice(
  a: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): number {
  const aPrice = comparablePriceMicros(a);
  const bPrice = comparablePriceMicros(b);
  if (aPrice === null && bPrice === null) return 0;
  if (aPrice === null) return 1;
  if (bPrice === null) return -1;
  if (aPrice.currency !== bPrice.currency) return 0;
  return aPrice.value - bPrice.value;
}

function comparablePriceMicros(
  candidate: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): { currency: string; value: number } | null {
  const currency = nonEmptyString(candidate.providerInstancePriceCurrency);
  if (!currency) return null;
  const hourly = nonNegativeInteger(candidate.providerInstancePriceHourlyMicros);
  if (hourly !== null) return { currency, value: hourly };
  const monthly = nonNegativeInteger(candidate.providerInstancePriceMonthlyCents);
  if (monthly !== null) return { currency, value: monthly };
  return null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeLegacyVmSize(value: string | null): VMSize | null {
  switch (value) {
    case 'small':
    case 'medium':
    case 'large':
      return value;
    default:
      return null;
  }
}

function isCredentialPlacementSource(value: unknown): value is CredentialSource {
  return (
    isCapacityPlacementCredentialSource(value) &&
    (value === 'user' || value === 'project' || value === 'platform')
  );
}

function buildCapacityPlacementExplanation(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    'poolId' | 'scope' | 'revision' | 'strategy' | 'capacityPoolProjectId' | 'workloadRole'
  >,
  candidate?: Pick<
    TaskStartCapacityCandidate,
    | 'id'
    | 'capacitySourceId'
    | 'provider'
    | 'location'
    | 'machineSize'
    | 'providerInstanceType'
    | 'providerInstanceVcpuCount'
    | 'providerInstanceMemoryMb'
    | 'providerInstanceDiskGb'
    | 'providerInstancePriceDisplay'
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): string {
  return JSON.stringify({
    kind: 'capacity_pool_default',
    poolId: selection.poolId,
    scope: selection.scope,
    revision: selection.revision,
    strategy: selection.strategy,
    capacityPoolProjectId: selection.capacityPoolProjectId,
    workloadRole: selection.workloadRole,
    capacitySourceId: candidate?.capacitySourceId ?? null,
    capacityPoolCandidateId: candidate?.id ?? null,
    provider: candidate?.provider ?? null,
    location: candidate?.location ?? null,
    machineSize: candidate?.machineSize ?? null,
    providerInstanceType: candidate?.providerInstanceType ?? null,
    providerInstanceVcpuCount: candidate?.providerInstanceVcpuCount ?? null,
    providerInstanceMemoryMb: candidate?.providerInstanceMemoryMb ?? null,
    providerInstanceDiskGb: candidate?.providerInstanceDiskGb ?? null,
    providerInstancePriceDisplay: candidate?.providerInstancePriceDisplay ?? null,
    providerInstancePriceCurrency: candidate?.providerInstancePriceCurrency ?? null,
    providerInstancePriceMonthlyCents: candidate?.providerInstancePriceMonthlyCents ?? null,
    providerInstancePriceHourlyMicros: candidate?.providerInstancePriceHourlyMicros ?? null,
    decidedAt: new Date().toISOString(),
  });
}

function resolveProvider(
  explicitProvider: CredentialProvider | string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): CredentialProvider | null {
  if (explicitProvider != null) {
    if (!isValidProvider(explicitProvider)) {
      throw new PlacementResolutionError(
        'invalid-provider',
        `provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`,
        CREDENTIAL_PROVIDERS
      );
    }
    return explicitProvider;
  }

  return (
    providerFromTrustedLayer(profile?.provider) ?? providerFromTrustedLayer(project.defaultProvider)
  );
}

function providerFromTrustedLayer(provider: string | null | undefined): CredentialProvider | null {
  return typeof provider === 'string' && isValidProvider(provider) ? provider : null;
}

function resolveVmSize(
  explicitVmSize: VMSize | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): VMSize {
  return (
    explicitVmSize ??
    (profile?.vmSizeOverride as VMSize | null) ??
    (project.defaultVmSize as VMSize | null) ??
    DEFAULT_VM_SIZE
  );
}

function resolveVmSizeSource(
  explicit: PlacementExplicitOverrides,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  profileVmSizeSource: PlacementProfileVmSizeSource
): ResourceRequirementsSource {
  if (explicit.vmSize) return explicit.vmSizeSource ?? 'task';
  if (profile?.vmSizeOverride) return profileVmSizeSource;
  if (project.defaultVmSize) return 'project';
  return 'platform';
}

function resolveVmLocation(
  explicitLocation: string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  provider: CredentialProvider | null
): VMLocation {
  return ((explicitLocation as VMLocation | null) ??
    (profile?.vmLocation as VMLocation | null) ??
    (project.defaultLocation as VMLocation | null) ??
    (provider ? (getDefaultLocationForProvider(provider) as VMLocation | null) : null) ??
    DEFAULT_VM_LOCATION) as VMLocation;
}

function validateResolvedLocation(
  provider: CredentialProvider | null,
  vmLocation: VMLocation
): void {
  if (provider === null || isValidLocationForProvider(provider, vmLocation)) return;

  const validLocations = getLocationsForProvider(provider).map((location) => location.id);
  throw new PlacementResolutionError(
    'invalid-location',
    `Location '${vmLocation}' is not valid for provider '${provider}'. Valid locations: ${validLocations.join(', ')}`,
    validLocations
  );
}

function resolveWorkspaceProfile(
  explicitWorkspaceProfile: WorkspaceProfile | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): WorkspaceProfile {
  return (
    explicitWorkspaceProfile ??
    (profile?.workspaceProfile as WorkspaceProfile | null) ??
    (project.defaultWorkspaceProfile as WorkspaceProfile | null) ??
    DEFAULT_WORKSPACE_PROFILE
  );
}

function resolveDevcontainerConfigName(
  workspaceProfile: WorkspaceProfile,
  explicitDevcontainerConfigName: string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): string | null {
  if (workspaceProfile === 'lightweight') return null;
  return (
    explicitDevcontainerConfigName ??
    profile?.devcontainerConfigName ??
    project.defaultDevcontainerConfigName ??
    null
  );
}

function resolveTaskMode(
  explicitTaskMode: TaskMode | null | undefined,
  profile: PlacementProfileDefaults | null,
  workspaceProfile: WorkspaceProfile,
  defaultPolicy: PlacementTaskModeDefault
): TaskMode {
  if (explicitTaskMode != null) return explicitTaskMode;
  if (profile?.taskMode != null) return profile.taskMode as TaskMode;
  return defaultPolicy === 'workspace-profile' && workspaceProfile === 'lightweight'
    ? 'conversation'
    : 'task';
}

function normalizeCredentialAttribution(
  input: PlacementCredentialAttributionInput | null | undefined
): Required<PlacementCredentialAttributionInput> {
  return {
    userId: input?.userId ?? null,
    projectId: input?.source === 'project' ? (input.projectId ?? null) : null,
    source: input?.source ?? null,
  };
}

function resolveCredentialLookup(input: {
  userId: string;
  projectId: string;
  provider: CredentialProvider | null;
  inheritedCredentialAttribution: Required<PlacementCredentialAttributionInput>;
  projectPolicy: PlacementCredentialProjectPolicy;
}): PlacementCredentialLookup {
  const inheritedUserId = input.inheritedCredentialAttribution.userId;
  const inheritedProjectId =
    input.inheritedCredentialAttribution.source === 'project'
      ? (input.inheritedCredentialAttribution.projectId ?? input.projectId)
      : input.inheritedCredentialAttribution.projectId;
  return {
    userId: inheritedUserId ?? input.userId,
    projectId: resolveCredentialLookupProjectId({
      projectId: input.projectId,
      inheritedUserId,
      inheritedProjectId,
      projectPolicy: input.projectPolicy,
    }),
    provider: input.provider ?? undefined,
  };
}

function resolveCredentialLookupProjectId(input: {
  projectId: string;
  inheritedUserId: string | null;
  inheritedProjectId: string | null;
  projectPolicy: PlacementCredentialProjectPolicy;
}): string | null {
  switch (input.projectPolicy) {
    case 'current-project':
      return input.projectId;
    case 'current-project-unless-inherited':
      return input.inheritedUserId ? input.inheritedProjectId : input.projectId;
    case 'inherited-or-none':
      return input.inheritedProjectId;
    default: {
      const exhaustive: never = input.projectPolicy;
      return exhaustive;
    }
  }
}
