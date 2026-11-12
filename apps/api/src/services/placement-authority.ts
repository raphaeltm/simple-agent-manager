import {
  type ConcreteCapacitySnapshot,
  normalizeConcreteSnapshot,
} from '@simple-agent-manager/scheduler-core';
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
        -- A switched-off account keeps its picks but is never placed (new VMs or reuse).
        AND NOT EXISTS (
          SELECT 1 FROM json_each(COALESCE(p.excluded_source_ids_json, '[]')) AS excluded
          WHERE excluded.value = s.id
        )
        AND s.provider = ${nodeAlias}.cloud_provider
        AND s.credential_source = ${nodeAlias}.placement_credential_source
        AND s.credential_reference = ${nodeAlias}.placement_credential_reference
        AND s.credential_version = ${nodeAlias}.placement_credential_version
        AND (CASE WHEN s.authority_generation > 0 THEN s.authority_generation
             ELSE ${sqliteTimestampVersion('s.updated_at')} END) = ${nodeAlias}.capacity_source_generation
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

export function capacityCandidateWorkloadRoleSql(
  candidateColumnSql: string,
  requestedRole: CapacityWorkloadRole
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(candidateColumnSql)) {
    throw new Error(`Unsafe capacity candidate role SQL column: ${candidateColumnSql}`);
  }
  return requestedRole === 'deployment'
    ? `${candidateColumnSql} = 'deployment'`
    : `${candidateColumnSql} = 'workspace'`;
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

/** SQL predicate: the `project_members` row aliased `alias` grants `capability`. */
export function projectMemberRoleCapabilitySql(
  alias: string,
  capability: ProjectCapability
): string {
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
