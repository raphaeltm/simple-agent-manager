/**
 * Canonical placement diagnostics — the stable "why this node / why queued /
 * why rejected" contract between the placement runtime and its displays.
 *
 * The API builds these (services/placement-diagnostics.ts); the web surfaces
 * render them (D3b). Keeping the shape here means a display can never
 * reconstruct placement reasoning from incidental fields it happened to find on
 * a node row.
 *
 * THREE DISTINCTIONS THIS CONTRACT EXISTS TO PRESERVE
 * ---------------------------------------------------
 * 1. requested vs observed vs compatibility-estimate. A node's advertised size
 *    is not its measured hardware, and a legacy `vm_size` label translated
 *    through the compatibility adapter is neither. Collapsing the three is how
 *    a stale label ends up displayed as fact.
 * 2. original resource intent vs current authority. The intent a run was
 *    admitted with is replayed on retry and wake; the pool revision, source
 *    generation and credential state that authorize it are revalidated at
 *    allocation. A display must be able to say which one it is showing.
 * 3. rejected vs queued. "No node was selected" covers both a hard
 *    incompatibility and a survivable wait, and they need different UI.
 *
 * SECURITY
 * --------
 * This DTO is user-facing. It carries NO secret material and NO installation
 * credential references — no `placementCredentialReference`, no
 * `capacitySourceId`, no credential version. Pool identity and scope are safe
 * (the user already sees which pool governs their project); the credential that
 * backs a source is not. `assertPlacementDiagnosticsAreUserSafe` enforces this
 * at the build boundary.
 */
import type {
  CapacityExhaustionPolicy,
  CapacityPoolScope,
  CapacityPoolStrategy,
  DefaultCapacityPoolEffectiveState,
} from './capacity-pool';

export const PLACEMENT_DIAGNOSTICS_VERSION = 1;

/**
 * How much a resource figure can be trusted.
 *
 * `observed` is measured hardware the running agent reported. `planned` is the
 * provider-native offering the placement asked for, correct until the host
 * heartbeats. `compatibility-estimate` is derived from a legacy VM size through
 * the translation adapter and must always be LABELLED as an estimate in the UI.
 */
export type PlacementResourceEvidence =
  | 'requested'
  | 'observed'
  | 'planned'
  | 'compatibility-estimate'
  | 'unknown';

export interface PlacementResourceFacts {
  cpuMillis: number | null;
  memoryMb: number | null;
  diskMb: number | null;
  evidence: PlacementResourceEvidence;
}

/** Why one candidate host won or lost. */
export interface PlacementHostDiagnostic {
  nodeId: string;
  outcome: 'selected' | 'rejected';
  /** Already-sanitized admission reasons, verbatim from the capacity gate. */
  reasons: string[];
  /** The host's own capacity, tagged with how it was established. */
  capacity: PlacementResourceFacts;
  /** Active workspaces already placed on the host. */
  coTenantCount: number | null;
  /** Dominant-resource utilization after placing this run, 0-100. */
  projectedUtilizationPercent: number | null;
  provider: string | null;
  location: string | null;
  providerInstanceType: string | null;
}

/** One provisioning attempt in the exhaustion plan. */
export interface PlacementAttemptDiagnostic {
  order: number;
  provider: string | null;
  location: string | null;
  providerInstanceType: string | null;
  outcome: 'pending' | 'succeeded' | 'capacity-exhausted' | 'failed' | 'not-attempted';
  reason: string | null;
}

/** Why a run is waiting rather than failed. */
export interface PlacementQueueDiagnostic {
  state: 'waiting' | 'expired' | null;
  /** The admission reason code, e.g. `provider_account_capacity`. */
  reason: string | null;
  nextRetryAt: string | null;
  waitDeadlineAt: string | null;
  attemptCount: number | null;
}

/**
 * The authority a placement was resolved under, and whether it is still current.
 *
 * `revalidatedAgainstCurrentAuthority` is true only after the final atomic
 * placement fence succeeds. False includes advisory selection and queued runs;
 * it does not by itself prove a stale plan. The UI must describe verification rather
 * than presenting stale placement as settled.
 */
export interface PlacementAuthorityDiagnostic {
  capacityPoolId: string | null;
  capacityPoolScope: CapacityPoolScope | null;
  capacityPoolRevision: number | null;
  effectivePoolState: DefaultCapacityPoolEffectiveState | null;
  strategy: CapacityPoolStrategy | null;
  /** Human-readable ordering key the strategy applied, for "why this node". */
  strategyOrdering: string | null;
  exhaustionPolicy: CapacityExhaustionPolicy | null;
  revalidatedAgainstCurrentAuthority: boolean;
}

export interface PlacementRolloutDiagnostic {
  cohortPercent: number;
  mode: 'enabled' | 'shadow';
  configuredStrategy: CapacityPoolStrategy;
  appliedStrategy: CapacityPoolStrategy;
  baselineSelectedNodeId: string | null;
  configuredSelectedNodeId: string | null;
  differenceReasons: Array<'strategy-order-differs' | 'same-selection' | 'no-eligible-hosts'>;
}

export interface PlacementDecisionDiagnostics {
  rollout?: PlacementRolloutDiagnostic;
  version: typeof PLACEMENT_DIAGNOSTICS_VERSION;
  decidedAt: string;
  /** The ORIGINAL canonical intent this run was admitted with. */
  requested: PlacementResourceFacts;
  authority: PlacementAuthorityDiagnostic;
  selectedNodeId: string | null;
  /** Candidate hosts considered for reuse, selected first. */
  hosts: PlacementHostDiagnostic[];
  /** Fresh-provisioning attempts, in the order the exhaustion policy allows. */
  attempts: PlacementAttemptDiagnostic[];
  queue: PlacementQueueDiagnostic;
  /** Sanitized operator/user notes: compatibility translation, exclusions. */
  notes: string[];
}

/**
 * Field names that must never appear anywhere in a user-facing placement
 * diagnostic. Enforced structurally rather than by review, because the source
 * objects (`CapacityPlacementSnapshot`, `TaskStartCapacityCandidate`) DO carry
 * them and a future spread would silently leak them.
 */
export const PLACEMENT_DIAGNOSTICS_FORBIDDEN_KEYS: readonly string[] = [
  'placementCredentialReference',
  'placementCredentialSource',
  'placementCredentialVersion',
  'capacitySourceId',
  'capacitySourceExternalRef',
  'capacitySourceGeneration',
  'credentialAttributionSource',
  'credentialAttributionUserId',
  'credentialAttributionProjectId',
  'credentialDomainKey',
  'providerDomainKey',
  'scopeKey',
  'token',
  'apiKey',
  'secret',
];

/**
 * Throw if a diagnostics payload carries any credential reference or secret-like
 * key at any depth. Called at the build boundary so a leak fails loudly in tests
 * and in development rather than reaching a user surface.
 */
export function assertPlacementDiagnosticsAreUserSafe(value: unknown, path = 'diagnostics'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPlacementDiagnosticsAreUserSafe(entry, `${path}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PLACEMENT_DIAGNOSTICS_FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`Placement diagnostics must not expose ${path}.${key}`);
    }
    assertPlacementDiagnosticsAreUserSafe(entry, `${path}.${key}`);
  }
}
