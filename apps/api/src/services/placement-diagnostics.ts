/**
 * Builds the canonical placement diagnostics DTO consumed by D3b displays.
 *
 * This is the ONLY place a `PlacementDecisionDiagnostics` is constructed, so the
 * three distinctions the contract exists to preserve (see the DTO's own header)
 * cannot drift between producers, and the user-safety assertion runs on every
 * payload rather than on the ones a reviewer remembered to check.
 *
 * It reads only values the placement runtime already computed —
 * `evaluateWorkspaceReservationCapacity` reasons, `normalizePlacementHostSignals`
 * signals, the exhaustion plan and the admission wait. It makes no placement
 * decision of its own.
 */
import {
  assertPlacementDiagnosticsAreUserSafe,
  type CapacityPoolStrategy,
  PLACEMENT_DIAGNOSTICS_VERSION,
  type PlacementAttemptDiagnostic,
  type PlacementAuthorityDiagnostic,
  type PlacementDecisionDiagnostics,
  type PlacementHostDiagnostic,
  type PlacementQueueDiagnostic,
  type PlacementResourceEvidence,
  type PlacementResourceFacts,
  type PlacementRolloutDiagnostic,
  type ResolvedResourceReservation,
} from '@simple-agent-manager/shared';

import type { TaskStartCapacityPoolSelection } from './placement-resolver-types';
import { PLACEMENT_STRATEGY_HOST_ORDERING, type PlacementHostSignals } from './placement-strategy';

/** A host that was considered, with the capacity gate's verdict on it. */
export interface PlacementHostDiagnosticInput {
  signals: PlacementHostSignals;
  outcome: 'selected' | 'deferred' | 'rejected';
  reasons?: string[];
  provider?: string | null;
  location?: string | null;
  providerInstanceType?: string | null;
}

export interface BuildPlacementDiagnosticsInput {
  previous?: PlacementDecisionDiagnostics;
  rollout?: PlacementRolloutDiagnostic;
  requestedReservation: ResolvedResourceReservation | null;
  selection: TaskStartCapacityPoolSelection | null;
  /**
   * False when the plan being described was resolved under a pool revision or
   * source generation that is no longer current — the run must re-resolve
   * before allocating.
   */
  revalidatedAgainstCurrentAuthority?: boolean;
  hosts?: PlacementHostDiagnosticInput[];
  selectedNodeId?: string | null;
  attempts?: PlacementAttemptDiagnostic[];
  queue?: Partial<PlacementQueueDiagnostic>;
  notes?: string[];
  now?: () => Date;
}

export function buildPlacementDecisionDiagnostics(
  input: BuildPlacementDiagnosticsInput
): PlacementDecisionDiagnostics {
  const now = input.now ?? (() => new Date());
  const rollout = input.rollout ?? input.previous?.rollout ?? input.selection?.rollout;
  const diagnostics: PlacementDecisionDiagnostics = {
    version: PLACEMENT_DIAGNOSTICS_VERSION,
    rollout,
    decidedAt: now().toISOString(),
    requested: requestedFacts(input.requestedReservation),
    authority: authorityDiagnostic(
      input.selection,
      input.revalidatedAgainstCurrentAuthority ?? false,
      rollout?.appliedStrategy
    ),
    selectedNodeId: input.selectedNodeId ?? null,
    hosts: input.hosts ? input.hosts.map(hostDiagnostic) : (input.previous?.hosts ?? []),
    attempts: input.attempts ?? input.previous?.attempts ?? [],
    queue: queueDiagnostic(input.queue ?? input.previous?.queue),
    notes: [...(input.notes ?? input.previous?.notes ?? [])],
  };

  // Fail loudly if a credential reference ever reaches a user-facing payload.
  // The source objects carry them, so a future spread would leak silently.
  assertPlacementDiagnosticsAreUserSafe(diagnostics);
  return diagnostics;
}

function requestedFacts(reservation: ResolvedResourceReservation | null): PlacementResourceFacts {
  if (!reservation) {
    return { cpuMillis: null, memoryMb: null, diskMb: null, evidence: 'unknown' };
  }
  return {
    cpuMillis: reservation.cpuMillis,
    memoryMb: reservation.memoryMb,
    diskMb: reservation.diskMb,
    // A reservation translated from a legacy VM size is an ESTIMATE of what the
    // caller wanted, not a figure they authored. The adapter records that on the
    // reservation's field provenance; surfacing it keeps a translated value from
    // being displayed as an explicit request.
    evidence: reservationWasTranslated(reservation) ? 'compatibility-estimate' : 'requested',
  };
}

function reservationWasTranslated(reservation: ResolvedResourceReservation): boolean {
  const provenance = reservation.fieldProvenance;
  if (!provenance) return false;
  return Object.values(provenance).some((field) => field?.compatibility !== undefined);
}

function hostDiagnostic(input: PlacementHostDiagnosticInput): PlacementHostDiagnostic {
  const { signals } = input;
  return {
    nodeId: signals.nodeId,
    outcome: input.outcome,
    reasons: [...(input.reasons ?? [])],
    capacity: {
      cpuMillis: signals.cpuMillisCapacity,
      memoryMb: signals.memoryMbCapacity,
      diskMb: signals.diskMbCapacity,
      evidence: hostEvidence(signals.capacitySource),
    },
    coTenantCount: signals.coTenantCount,
    projectedUtilizationPercent:
      signals.projectedUtilization === null
        ? null
        : Math.round(signals.projectedUtilization * 1000) / 10,
    provider: input.provider ?? null,
    location: input.location ?? null,
    providerInstanceType: input.providerInstanceType ?? null,
  };
}

function hostEvidence(source: PlacementHostSignals['capacitySource']): PlacementResourceEvidence {
  if (source === 'observed') return 'observed';
  if (source === 'planned') return 'planned';
  // No trusted hardware at all. Never report this as `planned`: a display would
  // present an unverified legacy label as the host's real capacity.
  return 'unknown';
}

function authorityDiagnostic(
  selection: TaskStartCapacityPoolSelection | null,
  revalidated: boolean,
  appliedStrategy?: CapacityPoolStrategy
): PlacementAuthorityDiagnostic {
  if (!selection) {
    return {
      capacityPoolId: null,
      capacityPoolScope: null,
      capacityPoolRevision: null,
      effectivePoolState: null,
      strategy: null,
      strategyOrdering: null,
      exhaustionPolicy: null,
      revalidatedAgainstCurrentAuthority: revalidated,
    };
  }
  return {
    capacityPoolId: selection.poolId,
    capacityPoolScope: selection.scope,
    capacityPoolRevision: selection.revision,
    effectivePoolState: selection.effectiveState,
    strategy: appliedStrategy ?? selection.strategy,
    strategyOrdering: describePlacementStrategyOrdering(appliedStrategy ?? selection.strategy),
    exhaustionPolicy: selection.exhaustionPolicy,
    revalidatedAgainstCurrentAuthority: revalidated,
  };
}

/** The human-readable ranking key a strategy applied, for "why this node". */
export function describePlacementStrategyOrdering(
  strategy: CapacityPoolStrategy | null | undefined
): string | null {
  if (!strategy) return null;
  return PLACEMENT_STRATEGY_HOST_ORDERING[strategy] ?? null;
}

function queueDiagnostic(
  queue: Partial<PlacementQueueDiagnostic> | undefined
): PlacementQueueDiagnostic {
  return {
    state: queue?.state ?? null,
    reason: queue?.reason ?? null,
    nextRetryAt: queue?.nextRetryAt ?? null,
    waitDeadlineAt: queue?.waitDeadlineAt ?? null,
    attemptCount: queue?.attemptCount ?? null,
  };
}
