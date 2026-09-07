import type {
  CapacityPlacementSnapshot,
  CapacityPoolScope,
  CapacityWorkloadRole,
} from '@simple-agent-manager/shared';

import {
  type ProjectCapability,
  projectMemberRolesWithCapability,
} from '../middleware/project-auth';
import {
  buildAnyDefaultCapacityPoolExclusionSql,
  buildHigherPrecedenceDefaultCapacityPoolExclusionSql,
} from './capacity-pool-precedence';

export type PlacementSqlBind = string | number | null;
export type PlacementAuthorityNodeClass = 'managed' | 'user-owned';

export interface PlacementAuthoritySqlPredicate {
  sql: string;
  binds: PlacementSqlBind[];
}

export interface PlacementAuthoritySqlInput {
  nodeAlias?: string;
  userId: string;
  projectId?: string | null;
  nodeRole: 'workspace' | 'deployment';
  workloadRole: CapacityWorkloadRole;
  nodeClass?: PlacementAuthorityNodeClass;
  projectCapability?: ProjectCapability;
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
  requireProjectMembership?: boolean;
}

export interface LegacyNodeAdoptionInput {
  node: {
    capacityPoolId?: string | null;
    capacityPoolScope?: string | null;
    capacitySourceId?: string | null;
    capacityPoolCandidateId?: string | null;
    cloudProvider?: string | null;
    vmLocation?: string | null;
    providerInstanceType?: string | null;
    providerInstanceVcpuCount?: number | null;
    providerInstanceMemoryMb?: number | null;
    providerInstanceDiskGb?: number | null;
    observedProviderInstanceType?: string | null;
    observedProviderInstanceVcpuCount?: number | null;
    observedProviderInstanceMemoryMb?: number | null;
    observedProviderInstanceDiskGb?: number | null;
    observedHardwareSource?: string | null;
  };
  snapshot: CapacityPlacementSnapshot | null | undefined;
}

export type LegacyNodeAdoptionDecision =
  | { kind: 'verified-current'; reason: string }
  | { kind: 'grandfathered-draining'; reason: string }
  | { kind: 'incompatible'; reason: string };

export const PROVIDER_ALLOCATION_ACTIVE_STATUS_SQL = "'creating', 'running'";

const SQLITE_CC_CREDENTIAL_PREFIX = 'cc_credentials:';
const SQLITE_CC_ATTACHMENT_PREFIX = 'cc_attachments:';
const SQLITE_CREDENTIAL_PREFIX = 'credentials:';
const SQLITE_PLATFORM_CREDENTIAL_PREFIX = 'platform_credentials:';

type ParsedCredentialReference =
  | { kind: 'credential'; id: string }
  | { kind: 'ccCredential'; id: string }
  | { kind: 'platformCredential'; id: string };

export function buildPlacementAuthoritySqlPredicate(
  input: PlacementAuthoritySqlInput
): PlacementAuthoritySqlPredicate {
  const nodeAlias = safeSqlAlias(input.nodeAlias ?? 'n');
  const nodeClass = input.nodeClass ?? 'managed';
  const projectCapability =
    input.projectCapability ??
    (input.nodeRole === 'deployment' ? 'deployment:deploy' : 'workspace:write');
  const binds: PlacementSqlBind[] = [];
  // Node ownership is asserted by the helper itself rather than left to each
  // caller. Every downstream comparison then reuses `<alias>.user_id` instead of
  // binding the same user id again, which is what keeps the composed
  // final-admission statement under D1's 100 bound-parameter ceiling.
  const nodeUserIdSql = `${nodeAlias}.user_id`;
  const clauses: string[] = [
    `AND ${nodeUserIdSql} = ?`,
    `AND ${nodeAlias}.runtime = 'vm'`,
    `AND ${nodeAlias}.node_class = ?`,
    `AND ${nodeAlias}.node_role = ?`,
    // nodes.workload_role is nullable: rows provisioned before migration 0125 have
    // no value, and 'workspace' is the role they were created with. Requiring a
    // literal match would refuse every pre-0125 node, which is exactly the legacy
    // work this slice must keep drainable. Matches (node.workloadRole ?? 'workspace')
    // used by the direct workspace route.
    `AND COALESCE(${nodeAlias}.workload_role, 'workspace') = ?`,
  ];
  binds.push(input.userId, nodeClass, input.nodeRole, input.workloadRole);

  const requireProjectMembership =
    input.requireProjectMembership ?? (input.projectId !== null && input.projectId !== undefined);
  if (requireProjectMembership) {
    if (!input.projectId) return impossiblePredicate();
    clauses.push(
      `AND EXISTS (
        SELECT 1
        FROM project_members current_project_member
        WHERE current_project_member.project_id = ?
          AND current_project_member.user_id = ${nodeUserIdSql}
          AND current_project_member.status = 'active'
          AND current_project_member.removed_at IS NULL
          AND ${projectMemberRoleCapabilitySql('current_project_member', projectCapability)}
      )`
    );
    binds.push(input.projectId);
  }

  const snapshot = input.capacityPlacementSnapshot ?? null;
  if (nodeClass === 'user-owned') {
    if (snapshot?.capacityPoolId) return impossiblePredicate();
    return {
      sql: clauses.join('\n'),
      binds,
    };
  }

  if (!snapshot?.capacityPoolId) {
    const legacy = buildLegacyUnpooledAuthorityPredicate(nodeAlias, nodeUserIdSql, input);
    return joinPredicates({ sql: clauses.join('\n'), binds }, legacy);
  }

  const concrete = normalizeConcreteSnapshot(snapshot);
  if (!concrete) return impossiblePredicate();
  if (concrete.workloadRole !== input.workloadRole) return impossiblePredicate();
  if (
    concrete.capacityPoolScope === 'project' &&
    concrete.capacityPoolProjectId !== input.projectId
  ) {
    return impossiblePredicate();
  }

  const credential = buildCredentialAuthoritySql(nodeAlias, nodeUserIdSql, input, concrete);
  if (!credential) return impossiblePredicate();

  const poolScope = poolScopeSql('p', concrete.capacityPoolScope, nodeAlias, nodeUserIdSql);
  const sourceScope = poolScopeSql('s', concrete.capacityPoolScope, nodeAlias, nodeUserIdSql);
  if (!poolScope || !sourceScope) return impossiblePredicate();

  // The claimed pool must still BE the effective pool for this run: the current
  // default of its own scope, with nothing authoritative outranking it. Without
  // this, a plan resolved against a user/installation pool stays admissible after
  // a project default pool is configured (even a configured-empty one), which is
  // exactly the cross-pool fallback v1 forbids. Mirrors
  // `resolveEffectiveDefaultCapacityPoolSummary` through one shared ordering.
  const higherPrecedenceExclusion = buildHigherPrecedenceDefaultCapacityPoolExclusionSql(
    concrete.capacityPoolScope,
    { userId: input.userId, projectId: input.projectId ?? null },
    { userIdSql: nodeUserIdSql }
  );

  clauses.push(
    `AND ${nodeAlias}.capacity_pool_id = ?`,
    `AND ${nodeAlias}.capacity_pool_scope = ?`,
    `AND ${nodeAlias}.capacity_pool_revision = ?`,
    `AND ${nodeAlias}.capacity_source_id = ?`,
    `AND ${nodeAlias}.capacity_source_generation = ?`,
    `AND ${nodeAlias}.capacity_source_external_ref IS ?`,
    `AND ${nodeAlias}.capacity_pool_candidate_id = ?`,
    `AND ${nodeAlias}.capacity_pool_project_id IS ?`,
    `AND ${nodeAlias}.placement_credential_source = ?`,
    `AND ${nodeAlias}.placement_credential_reference = ?`,
    `AND ${nodeAlias}.placement_credential_version = ?`,
    `AND ${nodeAlias}.provider_instance_type = ?`,
    `AND ${nodeAlias}.provider_instance_boot_disk_size_gb IS ?`,
    `AND ${nodeAlias}.provider_instance_image IS ?`,
    `AND ${nodeAlias}.provider_instance_architecture IS ?`
  );
  binds.push(
    concrete.capacityPoolId,
    concrete.capacityPoolScope,
    concrete.capacityPoolRevision,
    concrete.capacitySourceId,
    concrete.capacitySourceGeneration,
    concrete.capacitySourceExternalRef,
    concrete.capacityPoolCandidateId,
    concrete.capacityPoolProjectId,
    concrete.placementCredentialSource,
    concrete.placementCredentialReference,
    concrete.placementCredentialVersion,
    concrete.providerInstanceType,
    concrete.providerInstanceBootDiskSizeGb,
    concrete.providerInstanceImage,
    concrete.providerInstanceArchitecture
  );

  if (higherPrecedenceExclusion) {
    clauses.push(`AND ${higherPrecedenceExclusion.sql}`);
    binds.push(...higherPrecedenceExclusion.binds);
  }

  // Every identity below is already pinned to a bound value through the node
  // columns asserted above, so the joins compare against those columns instead of
  // re-binding the same snapshot values.
  clauses.push(
    `AND EXISTS (
      SELECT 1
      FROM capacity_pools p
      JOIN capacity_sources s
        ON s.id = ${nodeAlias}.capacity_source_id
      JOIN capacity_pool_candidates c
        ON c.id = ${nodeAlias}.capacity_pool_candidate_id
       AND c.pool_id = p.id
       AND c.capacity_source_id = s.id
      WHERE p.id = ${nodeAlias}.capacity_pool_id
        AND p.scope = ${nodeAlias}.capacity_pool_scope
        AND p.revision = ${nodeAlias}.capacity_pool_revision
        AND p.status = 'active'
        AND p.configuration_state = 'configured-ready'
        AND p.is_default = 1
        ${poolScope.sql}
        AND s.scope = p.scope
        AND s.source_kind = 'cloud-provider-credential'
        AND s.status = 'active'
        AND s.provider = ${nodeAlias}.cloud_provider
        AND s.credential_source = ${nodeAlias}.placement_credential_source
        AND s.credential_reference = ${nodeAlias}.placement_credential_reference
        AND s.credential_version = ${nodeAlias}.placement_credential_version
        AND ${sqliteTimestampVersion('s.updated_at')} = ${nodeAlias}.capacity_source_generation
        AND s.external_source_ref IS ${nodeAlias}.capacity_source_external_ref
        ${sourceScope.sql}
        AND c.status = 'active'
        AND c.catalog_availability = 'available'
        AND c.provider = ${nodeAlias}.cloud_provider
        AND c.location = ${nodeAlias}.vm_location
        AND ${capacityCandidateWorkloadRoleSql('c.workload_role', concrete.workloadRole)}
        AND c.provider_instance_type = ${nodeAlias}.provider_instance_type
        AND c.provider_instance_vcpu_count = ?
        AND c.provider_instance_memory_mb = ?
        AND c.provider_instance_disk_gb IS ?
        AND c.provider_instance_boot_disk_size_gb IS ${nodeAlias}.provider_instance_boot_disk_size_gb
        AND c.provider_instance_image IS ${nodeAlias}.provider_instance_image
        AND c.provider_instance_architecture IS ${nodeAlias}.provider_instance_architecture
        ${credential.sql}
    )`
  );
  binds.push(
    ...poolScope.binds,
    ...sourceScope.binds,
    concrete.providerInstanceVcpuCount,
    concrete.providerInstanceMemoryMb,
    concrete.providerInstanceDiskGb,
    ...credential.binds
  );

  return { sql: clauses.join('\n'), binds };
}

export function capacityCandidateWorkloadRoleEligible(
  candidateRole: string | null | undefined,
  requestedRole: CapacityWorkloadRole
): boolean {
  if (requestedRole === 'deployment') {
    return candidateRole === 'deployment' || candidateRole === 'workspace';
  }
  return candidateRole === 'workspace';
}

export function capacityCandidateWorkloadRoleSql(
  candidateColumnSql: string,
  requestedRole: CapacityWorkloadRole
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(candidateColumnSql)) {
    throw new Error(`Unsafe capacity candidate role SQL column: ${candidateColumnSql}`);
  }
  return requestedRole === 'deployment'
    ? `${candidateColumnSql} IN ('deployment', 'workspace')`
    : `${candidateColumnSql} = 'workspace'`;
}

export function evaluateLegacyNodeAdoptionCompatibility(
  input: LegacyNodeAdoptionInput
): LegacyNodeAdoptionDecision {
  const snapshot = input.snapshot ?? null;
  const node = input.node;
  if (!snapshot?.capacityPoolId) {
    return {
      kind: 'grandfathered-draining',
      reason:
        'node has no capacity-pool snapshot and requires explicit adoption before new placement',
    };
  }
  if (!node.capacityPoolId || node.capacityPoolId !== snapshot.capacityPoolId) {
    return { kind: 'incompatible', reason: 'node pool id does not match the placement snapshot' };
  }
  if (node.capacitySourceId !== snapshot.capacitySourceId) {
    return { kind: 'incompatible', reason: 'node source id does not match the placement snapshot' };
  }
  if (node.capacityPoolCandidateId !== snapshot.capacityPoolCandidateId) {
    return {
      kind: 'incompatible',
      reason: 'node candidate id does not match the placement snapshot',
    };
  }
  if (
    !snapshot.providerInstanceType ||
    node.providerInstanceType !== snapshot.providerInstanceType
  ) {
    return {
      kind: 'grandfathered-draining',
      reason: 'node has no verified provider-native instance identity',
    };
  }
  if (
    node.observedHardwareSource === 'observed' &&
    node.observedProviderInstanceType &&
    node.observedProviderInstanceType !== snapshot.providerInstanceType
  ) {
    return {
      kind: 'incompatible',
      reason: 'observed provider-native instance identity differs from placement snapshot',
    };
  }
  return { kind: 'verified-current', reason: 'node matches capacity snapshot identity' };
}

/**
 * Legacy nodes carry no capacity snapshot. They stay admissible only while this
 * caller has no default pool at all: once any scope in the effective-default
 * chain has one, current placement authority governs the run and the unpooled
 * node must drain instead. Uses the same scope chain as the resolver.
 */
function buildLegacyUnpooledAuthorityPredicate(
  nodeAlias: string,
  nodeUserIdSql: string,
  input: PlacementAuthoritySqlInput
): PlacementAuthoritySqlPredicate {
  const exclusion = buildAnyDefaultCapacityPoolExclusionSql(
    { userId: input.userId, projectId: input.projectId ?? null },
    { userIdSql: nodeUserIdSql }
  );

  const unpooledSql = `AND ${nodeAlias}.capacity_pool_id IS NULL
      AND ${nodeAlias}.capacity_pool_scope IS NULL
      AND ${nodeAlias}.capacity_source_id IS NULL
      AND ${nodeAlias}.capacity_pool_candidate_id IS NULL
      AND ${nodeAlias}.capacity_pool_project_id IS NULL`;

  if (!exclusion) return { sql: unpooledSql, binds: [] };
  return {
    sql: `${unpooledSql}
      AND ${exclusion.sql}`,
    binds: exclusion.binds,
  };
}

function buildCredentialAuthoritySql(
  nodeAlias: string,
  nodeUserIdSql: string,
  input: PlacementAuthoritySqlInput,
  snapshot: ConcreteCapacitySnapshot
): PlacementAuthoritySqlPredicate | null {
  const reference = parseCredentialReference(snapshot.placementCredentialReference);
  if (!reference) return null;
  // The credential version is already pinned by the node's
  // `placement_credential_version` column, so the rotation check compares against
  // that column instead of re-binding the same value.
  const credentialVersionSql = `${nodeAlias}.placement_credential_version`;

  if (snapshot.placementCredentialSource === 'platform') {
    if (reference.kind !== 'platformCredential') return null;
    return {
      sql: `AND s.credential_id IS NULL
        AND s.platform_credential_id = ?
        AND EXISTS (
          SELECT 1
          FROM platform_credentials current_platform_credential
          WHERE current_platform_credential.id = s.platform_credential_id
            AND current_platform_credential.credential_type = 'cloud-provider'
            AND current_platform_credential.is_enabled = 1
            AND current_platform_credential.provider = ${nodeAlias}.cloud_provider
            AND ${sqliteTimestampVersion('current_platform_credential.updated_at')} = ${credentialVersionSql}
        )`,
      binds: [reference.id],
    };
  }

  if (reference.kind === 'credential') {
    if (snapshot.placementCredentialSource === 'project' && !input.projectId) return null;
    const projectClause =
      snapshot.placementCredentialSource === 'project'
        ? {
            sql: `AND current_legacy_credential.project_id = ?`,
            binds: [input.projectId ?? null],
          }
        : {
            sql: `AND current_legacy_credential.user_id = ${nodeUserIdSql}
              AND current_legacy_credential.project_id IS NULL`,
            binds: [],
          };
    return {
      sql: `AND s.credential_id = ?
        AND s.platform_credential_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM credentials current_legacy_credential
          WHERE current_legacy_credential.id = s.credential_id
            ${projectClause.sql}
            AND current_legacy_credential.credential_type = 'cloud-provider'
            AND current_legacy_credential.is_active = 1
            AND current_legacy_credential.provider = ${nodeAlias}.cloud_provider
            AND ${sqliteTimestampVersion('current_legacy_credential.updated_at')} = ${credentialVersionSql}
        )`,
      binds: [reference.id, ...projectClause.binds],
    };
  }

  if (reference.kind === 'ccCredential') {
    const attachment = parseComposableAttachmentReference(snapshot.capacitySourceExternalRef);
    if (!attachment) return null;
    if (snapshot.placementCredentialSource === 'project' && !input.projectId) return null;
    const attachmentScope =
      snapshot.placementCredentialSource === 'project'
        ? { sql: `AND current_cc_attachment.project_id = ?`, binds: [input.projectId ?? null] }
        : {
            sql: `AND current_cc_attachment.user_id = ${nodeUserIdSql}
              AND current_cc_attachment.project_id IS NULL`,
            binds: [],
          };
    return {
      sql: `AND s.credential_id IS NULL
        AND s.platform_credential_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM cc_credentials current_cc_credential
          JOIN cc_configurations current_cc_configuration
            ON current_cc_configuration.credential_id = current_cc_credential.id
          JOIN cc_attachments current_cc_attachment
            ON current_cc_attachment.configuration_id = current_cc_configuration.id
          WHERE current_cc_credential.id = ?
            AND current_cc_attachment.id = ?
            AND current_cc_credential.owner_id = current_cc_configuration.owner_id
            AND current_cc_configuration.owner_id = current_cc_attachment.user_id
            AND current_cc_credential.kind = 'cloud-provider'
            AND current_cc_credential.is_active = 1
            AND current_cc_configuration.consumer_kind = 'compute'
            AND current_cc_configuration.consumer_target = ${nodeAlias}.cloud_provider
            AND current_cc_configuration.is_active = 1
            AND current_cc_attachment.consumer_kind = 'compute'
            AND current_cc_attachment.consumer_target = ${nodeAlias}.cloud_provider
            AND current_cc_attachment.is_active = 1
            ${attachmentScope.sql}
            AND ${sqliteTimestampVersion('current_cc_credential.updated_at')} = ${credentialVersionSql}
        )`,
      binds: [reference.id, attachment.id, ...attachmentScope.binds],
    };
  }

  return null;
}

/**
 * Scope-ownership predicate for a pool/source row. Owner ids come from the node's
 * own already-bound columns (`user_id`, `capacity_pool_project_id`) rather than
 * fresh bound parameters, so composing this into the final admission statement
 * costs zero additional binds.
 */
function poolScopeSql(
  alias: string,
  scope: CapacityPoolScope,
  nodeAlias: string,
  nodeUserIdSql: string
): PlacementAuthoritySqlPredicate | null {
  switch (scope) {
    case 'installation':
      return {
        sql: `AND ${alias}.owner_user_id IS NULL
          AND ${alias}.owner_project_id IS NULL`,
        binds: [],
      };
    case 'user':
      return {
        sql: `AND ${alias}.owner_user_id = ${nodeUserIdSql}
          AND ${alias}.owner_project_id IS NULL`,
        binds: [],
      };
    case 'project':
      return {
        sql: `AND ${alias}.owner_user_id IS NULL
          AND ${alias}.owner_project_id = ${nodeAlias}.capacity_pool_project_id`,
        binds: [],
      };
    default:
      return null;
  }
}

function normalizeConcreteSnapshot(
  snapshot: CapacityPlacementSnapshot
): ConcreteCapacitySnapshot | null {
  const capacityPoolId = nonEmptyString(snapshot.capacityPoolId);
  if (!capacityPoolId) return null;

  const capacityPoolScope = snapshot.capacityPoolScope;
  if (!isCapacityPoolScope(capacityPoolScope)) return null;

  const capacityPoolRevision = positiveInteger(snapshot.capacityPoolRevision);
  if (capacityPoolRevision === null) return null;

  const capacitySourceId = nonEmptyString(snapshot.capacitySourceId);
  if (!capacitySourceId) return null;

  const capacitySourceGeneration = positiveInteger(snapshot.capacitySourceGeneration);
  if (capacitySourceGeneration === null) return null;

  const capacityPoolCandidateId = nonEmptyString(snapshot.capacityPoolCandidateId);
  if (!capacityPoolCandidateId) return null;

  const placementCredentialSource = snapshot.placementCredentialSource;
  if (
    placementCredentialSource !== 'user' &&
    placementCredentialSource !== 'project' &&
    placementCredentialSource !== 'platform'
  ) {
    return null;
  }

  const placementCredentialReference = nonEmptyString(snapshot.placementCredentialReference);
  if (!placementCredentialReference) return null;

  const placementCredentialVersion = positiveInteger(snapshot.placementCredentialVersion);
  if (placementCredentialVersion === null) return null;

  const capacityPoolProjectId =
    capacityPoolScope === 'project' ? nonEmptyString(snapshot.capacityPoolProjectId) : null;
  if (capacityPoolScope === 'project' && !capacityPoolProjectId) return null;
  if (capacityPoolScope !== 'project' && snapshot.capacityPoolProjectId !== null) return null;

  const workloadRole = snapshot.workloadRole;
  if (workloadRole !== 'workspace' && workloadRole !== 'deployment') return null;

  const providerInstanceType = nonEmptyString(snapshot.providerInstanceType);
  if (!providerInstanceType) return null;

  const providerInstanceVcpuCount = positiveInteger(snapshot.providerInstanceVcpuCount);
  if (providerInstanceVcpuCount === null) return null;

  const providerInstanceMemoryMb = positiveInteger(snapshot.providerInstanceMemoryMb);
  if (providerInstanceMemoryMb === null) return null;

  const providerInstanceDiskGb = nullableNonNegativeInteger(snapshot.providerInstanceDiskGb);
  if (providerInstanceDiskGb === undefined) return null;

  const providerInstanceBootDiskSizeGb = nullableNonNegativeInteger(
    snapshot.providerInstanceBootDiskSizeGb
  );
  if (providerInstanceBootDiskSizeGb === undefined) return null;

  return {
    capacityPoolId,
    capacityPoolScope,
    capacityPoolRevision,
    capacitySourceId,
    capacitySourceGeneration,
    capacitySourceExternalRef: snapshot.capacitySourceExternalRef ?? null,
    capacityPoolCandidateId,
    placementCredentialSource,
    placementCredentialReference,
    placementCredentialVersion,
    capacityPoolProjectId,
    workloadRole,
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb,
    providerInstanceImage: snapshot.providerInstanceImage ?? null,
    providerInstanceArchitecture: snapshot.providerInstanceArchitecture ?? null,
  };
}
interface ConcreteCapacitySnapshot {
  capacityPoolId: string;
  capacityPoolScope: CapacityPoolScope;
  capacityPoolRevision: number;
  capacitySourceId: string;
  capacitySourceGeneration: number;
  capacitySourceExternalRef: string | null;
  capacityPoolCandidateId: string;
  placementCredentialSource: 'user' | 'project' | 'platform';
  placementCredentialReference: string;
  placementCredentialVersion: number;
  capacityPoolProjectId: string | null;
  workloadRole: CapacityWorkloadRole;
  providerInstanceType: string;
  providerInstanceVcpuCount: number;
  providerInstanceMemoryMb: number;
  providerInstanceDiskGb: number | null;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: string | null;
}

function joinPredicates(
  left: PlacementAuthoritySqlPredicate,
  right: PlacementAuthoritySqlPredicate
): PlacementAuthoritySqlPredicate {
  return {
    sql: [left.sql, right.sql].filter(Boolean).join('\n'),
    binds: [...left.binds, ...right.binds],
  };
}

function impossiblePredicate(): PlacementAuthoritySqlPredicate {
  return { sql: 'AND 0 = 1', binds: [] };
}

function projectMemberRoleCapabilitySql(alias: string, capability: ProjectCapability): string {
  const safeAliasName = safeSqlAlias(alias);
  const roles = projectMemberRolesWithCapability(capability);
  if (roles.length === 0) return '0 = 1';
  return `${safeAliasName}.role IN (${roles.map((role) => `'${role}'`).join(', ')})`;
}

function safeSqlAlias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL alias: ${value}`);
  }
  return value;
}

function sqliteTimestampVersion(expression: string): string {
  return `(CAST(strftime('%s', ${expression}) AS INTEGER) * 1000
    + CAST(substr(strftime('%f', ${expression}), 4, 3) AS INTEGER))`;
}

function parseCredentialReference(reference: string): ParsedCredentialReference | null {
  if (reference.startsWith(SQLITE_CREDENTIAL_PREFIX)) {
    const id = reference.slice(SQLITE_CREDENTIAL_PREFIX.length).trim();
    return id ? { kind: 'credential', id } : null;
  }
  if (reference.startsWith(SQLITE_CC_CREDENTIAL_PREFIX)) {
    const id = reference.slice(SQLITE_CC_CREDENTIAL_PREFIX.length).trim();
    return id ? { kind: 'ccCredential', id } : null;
  }
  if (reference.startsWith(SQLITE_PLATFORM_CREDENTIAL_PREFIX)) {
    const id = reference.slice(SQLITE_PLATFORM_CREDENTIAL_PREFIX.length).trim();
    return id ? { kind: 'platformCredential', id } : null;
  }
  return null;
}

function parseComposableAttachmentReference(
  reference: string | null | undefined
): { id: string } | null {
  if (!reference?.startsWith(SQLITE_CC_ATTACHMENT_PREFIX)) return null;
  const id = reference.slice(SQLITE_CC_ATTACHMENT_PREFIX.length).trim();
  return id ? { id } : null;
}

function isCapacityPoolScope(value: unknown): value is CapacityPoolScope {
  return value === 'installation' || value === 'user' || value === 'project';
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
