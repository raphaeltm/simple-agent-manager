/**
 * A superadmin's attestation that a SAM-capacity node's server is gone, for a node SAM can never
 * finish tearing down by itself (idea 01M6DFJTV3VCFEJEBYMK3KYF7A, the admin half; incident node
 * 01M7MTMV89F5ZV23VSF0ZVPJPS, idea 01M76T4XXVQS1TX8VQM2BRPWFG).
 *
 * The owner path (`services/node-manual-deletion.ts`) refuses SAM capacity, because the server
 * lives in SAM's own cloud account where only an operator can look. The classic case: a
 * providerless node (its create failed before a server ID was recorded) whose pinned platform
 * credential was later re-saved. Only that exact credential generation could prove no server was
 * created, so strict teardown refuses forever (`teardown_credential_generation_changed`).
 *
 * The failure mode of this path is an orphaned VM that keeps billing, so admission is narrow:
 * - SAM capacity, managed VM, `destroying`, with a recorded teardown refusal from the allowlist
 *   `OPERATOR_REMOVABLE_BLOCK_REASONS` (refusals that mean a server may be live are excluded);
 * - a providerless node must be past its provisioning recovery window (no create still in flight);
 * - the caller types the node ID and gives a note; the audit row naming them is written BEFORE
 *   the proof and the attestation is refused if it cannot be written;
 * - the node's pinned credential, else every enabled platform credential for its provider, is
 *   asked first, and any server it returns for this node refuses the attestation
 *   (`findNodeServerAtProvider`); a providerless node whose ownership labels cannot be built is
 *   refused while a credential could have looked;
 * - the final proof CAS re-checks, atomically, the exact refusal the operator saw, that no
 *   workspace is active, that no live task holds a placement claim on the node, and that its
 *   heartbeat is stale (`operatorAttestationAdmissionSql`, rule 69).
 *
 * The proof is attested (`runtime_termination_attested_at`), never strict. Who attested lives in
 * the audit rows (`operations_audit_log`, then `node_health_events` `deleted_by_operator`).
 */
import {
  type AdminStrandedNode,
  isOperatorRemovableBlockReason,
  isUserOwnedNodeClass,
  OPERATOR_NODE_DELETION_NOTE_MAX_CHARS,
  primaryCleanupBlockReason,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';
import { eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { errors } from '../middleware/error';
import { isOnSamCapacity } from './node-manual-deletion';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { releaseTerminatedNodeIngress } from './node-provisioning-ingress';
import {
  NodeTeardownBlockedError,
  resolveStrictNodeTeardownAuthority,
} from './node-teardown-authority';
import { isCredentialRejection } from './node-teardown-credential-rejection';
import { recordOperationsAudit } from './operations-access';
import {
  type NodeDb,
  NodeIncarnationFenceError,
  type NodeRow,
  type ProviderForUserResult,
} from './strict-node-deletion-shared';
import { markRuntimeTerminationConfirmed } from './strict-node-termination-proof';
import { getProvisioningTimeoutMs } from './timeout';

/** Audit reason for a removal whose proof a superadmin attested (`node_health_events`). */
export const OPERATOR_ATTESTED_REMOVAL_REASON = 'operator_attested_manual_deletion';
/** `operations_audit_log.task_id` for actions taken in the admin UI rather than by an agent task. */
export const ADMIN_UI_AUDIT_TASK_ID = 'admin-ui';
export const OPERATOR_NODE_DELETION_AUDIT_TOOL = 'admin_operator_node_deletion';

/** Workspace statuses that mean the node may still be running work (or about to). */
const ACTIVE_WORKSPACE_STATUSES_SQL = "('running', 'creating', 'recovery', 'pending')";
const TERMINAL_TASK_STATUSES_SQL = `(${TASK_TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})`;

export interface OperatorNodeDeletionInput {
  nodeId: string;
  operatorUserId: string;
  /** Must equal `nodeId`: the operator typed the exact node they checked at the provider. */
  confirmation: string;
  note: string;
  /** The request came from an agent sign-in session; recorded in the audit, not refused. */
  agentSignIn: boolean;
}

export interface OperatorNodeDeletionProof {
  node: NodeRow;
  runtimeTerminationConfirmedAt: string;
}

/**
 * The reciprocal admission predicate (rule 69), evaluated inside the proof CAS so nothing that
 * would make the node live again can land between the checks and the write:
 * - the recorded refusal is still exactly the one the operator was shown;
 * - no workspace is active or pending (`running`, `creating` and `recovery` match the cleanup
 *   refusal diagnosis; `pending` is added because it is about to start);
 * - no non-terminal task holds a warm placement claim on the node, whatever the claim's age
 *   (the same terminal set as the live-claim index on `tasks`);
 * - the heartbeat is older than the node's own `heartbeat_stale_after_seconds`, as in the
 *   stale-heartbeat anomaly. A heartbeat is a liveness signal: it backs up, never replaces, the
 *   provider lookup.
 * `nodes.<column>` resolves to the UPDATE target: drizzle renders the update as
 * `update "nodes" ...` and none of the subquery tables is named `nodes`.
 */
export function operatorAttestationAdmissionSql(cleanupBlockedReason: string | null) {
  return sql`nodes.cleanup_blocked_since IS NOT NULL
    AND nodes.cleanup_blocked_reason IS ${cleanupBlockedReason}
    AND NOT EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.node_id = nodes.id AND w.status IN ${sql.raw(ACTIVE_WORKSPACE_STATUSES_SQL)}
    )
    AND NOT EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.claimed_warm_node_id = nodes.id
        AND t.status NOT IN ${sql.raw(TERMINAL_TASK_STATUSES_SQL)}
    )
    AND (nodes.last_heartbeat_at IS NULL OR julianday(nodes.last_heartbeat_at) <
      julianday('now') - MAX(1, nodes.heartbeat_stale_after_seconds) / 86400.0)`;
}

type ProviderLookup =
  | { found: true; serverId: string }
  | { found: false; pinnedCredentialResolved: boolean; credentialsAnswered: number };

/**
 * Ask the credentials that can see SAM's own account whether this node's server exists: the
 * node's pinned credential while it still resolves, otherwise every enabled platform credential
 * for the provider. The owner's own credentials are never used: a SAM-capacity server does not
 * live there, and asking would expose the owner's account to an operator action.
 *
 * Only a returned server is evidence: it refuses the attestation, whichever credential returned
 * it and whatever its labels say (a false refusal costs the operator one more look at the
 * provider; a false acceptance orphans a billing VM). A credential the provider rejects cannot
 * see the server either way and is skipped. Any other lookup failure leaves the answer unknown,
 * so the operator is asked to retry. When no credential resolves at all, nothing can look and the
 * operator's own check is the evidence, which is what this path exists for. `credentialsAnswered`
 * says how many credentials actually answered; an answer from a credential other than the pinned
 * one cannot prove absence (it may reach another account), so the audit records both.
 */
async function findNodeServerAtProvider(
  db: NodeDb,
  env: Env,
  node: NodeRow
): Promise<ProviderLookup> {
  const none = { found: false as const, pinnedCredentialResolved: false, credentialsAnswered: 0 };
  if (!node.cloudProvider) return none;
  let providers: ProviderForUserResult[];
  let pinnedCredentialResolved = false;
  try {
    const authority = await resolveStrictNodeTeardownAuthority(db, node, node.userId, env);
    if (authority.kind === 'pinned') {
      providers = [authority.providerResult];
      pinnedCredentialResolved = true;
    } else {
      providers = authority.candidates.filter((c) => c.credentialSource === 'platform');
    }
  } catch (error) {
    if (error instanceof NodeTeardownBlockedError) return none;
    log.warn('node_operator_deletion.credential_resolution_failed', {
      nodeId: node.id,
      error: serializeError(error),
    });
    throw errors.serviceUnavailable(
      `Could not resolve SAM's ${node.cloudProvider} credentials to check this node. Try again in a minute.`
    );
  }
  if (providers.length === 0) return none;

  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  const labels =
    installationId && environmentLabel && node.runtimeIncarnationId
      ? buildNodeProviderLabels({
          nodeId: node.id,
          isDeploymentNode: node.nodeRole === 'deployment',
          environmentLabel,
          installationId,
          runtimeIncarnationId: node.runtimeIncarnationId,
        })
      : null;
  if (!node.providerInstanceId && !labels) {
    // A credential could look, but SAM cannot say what to look for. Refuse rather than accept
    // a check that asked nothing (strict teardown refuses the same state).
    throw errors.conflict(
      'SAM cannot identify this node’s server at the provider (its installation or runtime ' +
        'identity is missing), so it cannot check it. Fix the identity first.'
    );
  }
  let credentialsAnswered = 0;
  for (const candidate of providers) {
    try {
      if (node.providerInstanceId) {
        const server = await candidate.provider.getVM(node.providerInstanceId);
        if (server) return { found: true, serverId: server.id };
      } else if (labels) {
        const servers = await candidate.provider.listVMs(labels);
        if (servers[0]) return { found: true, serverId: servers[0].id };
      }
      credentialsAnswered++;
    } catch (error) {
      if (isCredentialRejection(error)) {
        log.warn('node_operator_deletion.credential_rejected', {
          nodeId: node.id,
          credentialSource: candidate.credentialSource,
          error: serializeError(error),
        });
        continue;
      }
      log.warn('node_operator_deletion.provider_check_unavailable', {
        nodeId: node.id,
        credentialSource: candidate.credentialSource,
        error: serializeError(error),
      });
      throw errors.serviceUnavailable(
        `Could not check with ${node.cloudProvider} whether this node's server still exists. Try again in a minute.`
      );
    }
  }
  return { found: false, pinnedCredentialResolved, credentialsAnswered };
}

/**
 * Record a superadmin's attestation as the node's termination proof (attested provenance), after
 * every admission check. The caller then runs the shared removal tail
 * (`completeAttestedNodeRemoval`) as the node's owner.
 */
export async function recordOperatorNodeDeletion(
  db: NodeDb,
  env: Env,
  input: OperatorNodeDeletionInput
): Promise<OperatorNodeDeletionProof> {
  const note = input.note.trim().slice(0, OPERATOR_NODE_DELETION_NOTE_MAX_CHARS);
  if (!note) throw errors.badRequest('Describe what you checked at the provider');
  if (input.confirmation.trim() !== input.nodeId) {
    throw errors.badRequest('Type the node ID exactly to confirm');
  }
  const [node] = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, input.nodeId))
    .limit(1);
  if (!node) throw errors.notFound('Node');
  if (
    isUserOwnedNodeClass(node.nodeClass) ||
    node.nodeClass !== 'managed' ||
    node.runtime !== 'vm'
  ) {
    throw errors.conflict('Only a managed cloud server can be removed this way');
  }
  if (!isOnSamCapacity(node)) {
    // The server lives in the owner's own cloud account: the owner checks and removes it.
    throw errors.forbidden(
      "This node runs on its owner's cloud account; the owner removes it from the node page"
    );
  }
  if (node.status !== 'destroying' || !node.cleanupBlockedSince) {
    throw errors.conflict(
      'Only a node SAM has failed to tear down can be removed this way. Wait for cleanup to try first.'
    );
  }
  if (!isOperatorRemovableBlockReason(node.cleanupBlockedReason)) {
    throw errors.conflict(
      `SAM's last teardown refusal (${primaryCleanupBlockReason(node.cleanupBlockedReason) ?? 'unknown'}) ` +
        'means the server may still exist. Resolve it at the provider first.'
    );
  }
  if (!node.providerInstanceId) {
    const createdAt = Date.parse(node.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < getProvisioningTimeoutMs(env)) {
      throw errors.conflict(
        'This node was created recently and its server may still be starting. Try again later.'
      );
    }
  }

  const lookup = await findNodeServerAtProvider(db, env, node);
  if (lookup.found) {
    throw errors.conflict(
      `${node.cloudProvider} still has server ${lookup.serverId} for this node. ` +
        'Delete it there first, then try again.'
    );
  }

  const audit = {
    actorUserId: input.operatorUserId,
    taskId: ADMIN_UI_AUDIT_TASK_ID,
    tool: OPERATOR_NODE_DELETION_AUDIT_TOOL,
    targetType: 'node',
    targetId: node.id,
  };
  const detail = {
    ownerUserId: node.userId,
    provider: node.cloudProvider,
    providerInstanceId: node.providerInstanceId,
    nodeRole: node.nodeRole,
    cleanupBlockedSince: node.cleanupBlockedSince,
    cleanupBlockedReason: node.cleanupBlockedReason,
    pinnedCredentialResolved: lookup.pinnedCredentialResolved,
    credentialsAnswered: lookup.credentialsAnswered,
    agentSignIn: input.agentSignIn,
    note,
  };
  // The attestation is recorded before it takes effect, so a removal can never exist without a
  // record of who asserted it. If the record cannot be written, nothing is changed.
  if (!(await recordOperationsAudit(env, { ...audit, outcome: 'attested', detail }))) {
    throw errors.serviceUnavailable(
      'Could not record the audit entry; nothing was changed. Try again.'
    );
  }

  let runtimeTerminationConfirmedAt: string;
  try {
    runtimeTerminationConfirmedAt = await markRuntimeTerminationConfirmed(
      db,
      node,
      'attested',
      operatorAttestationAdmissionSql(node.cleanupBlockedReason)
    );
  } catch (error) {
    const refused = error instanceof NodeIncarnationFenceError;
    await recordOperationsAudit(env, {
      ...audit,
      outcome: refused ? 'refused' : 'failed',
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    if (!refused) throw error;
    log.warn('node_operator_deletion.admission_refused', {
      nodeId: node.id,
      error: serializeError(error),
    });
    throw errors.conflict(
      'The node changed, is still active (a workspace, a task placement or a recent heartbeat), ' +
        'or its teardown refusal changed. Reload and check again.'
    );
  }
  await releaseTerminatedNodeIngress(env, node, 'operator_attested_termination');
  log.info('node_operator_deletion.attested', {
    nodeId: node.id,
    operatorUserId: input.operatorUserId,
    ...detail,
    note: undefined,
    runtimeTerminationConfirmedAt,
  });
  return { node, runtimeTerminationConfirmedAt };
}

/** Teardown error text is shown to the operator only as a hint; keep the page small. */
const STRANDED_NODE_ERROR_MESSAGE_MAX_CHARS = 500;

type StrandedNodeRow = Record<string, unknown>;

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * SAM-capacity managed VM nodes in `destroying` with a recorded teardown refusal, oldest first, for Admin →
 * Infrastructure. The capacity predicate mirrors `isOnSamCapacity` (any of the three source
 * columns). `total` counts every match, so a capped page discloses what it left out (rule 65).
 * Mapping cannot throw: every column is read through a type guard (rule 50).
 */
export async function listStrandedPlatformNodes(
  env: Env,
  limit: number
): Promise<{ nodes: AdminStrandedNode[]; total: number }> {
  const result = await env.DATABASE.prepare(
    `SELECT n.id, n.user_id, u.email AS owner_email, n.node_role, n.cloud_provider,
            n.provider_instance_id, n.vm_location, n.created_at, n.last_heartbeat_at,
            n.cleanup_blocked_since, n.cleanup_blocked_reason, n.error_message,
            COUNT(*) OVER () AS total
       FROM nodes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.status = 'destroying' AND n.node_class = 'managed' AND n.runtime = 'vm'
        AND n.cleanup_blocked_since IS NOT NULL
        AND (n.credential_source = 'platform' OR n.placement_credential_source = 'platform'
          OR n.credential_attribution_source = 'platform')
      ORDER BY n.cleanup_blocked_since ASC, n.id ASC
      LIMIT ?`
  )
    .bind(limit)
    .all<StrandedNodeRow>();
  const rows = result.results ?? [];
  const nodes = rows.map((row) => ({
    id: String(row.id),
    ownerUserId: String(row.user_id),
    ownerEmail: textOrNull(row.owner_email),
    nodeRole: textOrNull(row.node_role) ?? 'workspace',
    cloudProvider: textOrNull(row.cloud_provider),
    providerInstanceId: textOrNull(row.provider_instance_id),
    vmLocation: textOrNull(row.vm_location),
    createdAt: String(row.created_at),
    lastHeartbeatAt: textOrNull(row.last_heartbeat_at),
    cleanupBlockedSince: String(row.cleanup_blocked_since),
    cleanupBlockedReason: textOrNull(row.cleanup_blocked_reason),
    errorMessage:
      textOrNull(row.error_message)?.slice(0, STRANDED_NODE_ERROR_MESSAGE_MAX_CHARS) ?? null,
    operatorRemovable: isOperatorRemovableBlockReason(textOrNull(row.cleanup_blocked_reason)),
  }));
  const total = Number(rows[0]?.total ?? 0);
  return { nodes, total: Number.isFinite(total) ? total : nodes.length };
}
