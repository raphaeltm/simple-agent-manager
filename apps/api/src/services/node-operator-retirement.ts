/**
 * The operator path for a node on SAM-managed capacity that SAM failed to delete and whose
 * cloud server is gone (self-host box R1, 2026-11-12: seven installation-capacity rows stuck at
 * "operator recovery required" with no VM behind them). The owner path
 * (`node-manual-deletion.ts`) refuses these rows, because the server lives in SAM's own cloud
 * account and an ordinary user cannot have deleted it. A superadmin is SAM's operator; on a
 * self-hosted install there is no one else.
 *
 * This path never deletes a cloud instance. It retires the row only on one of two proofs:
 * - `provider_absent`: the provider, asked with the node's exact provisioning credential,
 *   lists no server carrying the node's exact ownership labels, and reports no server under its
 *   recorded instance id (the label lookup strict deletion uses, `strict-node-deletion.ts`).
 * - `typed_confirmation`: the provider cannot be asked at all (no exact credential binding, the
 *   credential is gone or rejected, or the provider's inventory cannot prove absence), and the
 *   operator typed the node's name or id.
 * A server that is still listed always refuses, whatever was typed. So does a transient
 * provider failure (retry) and a node still inside its provisioning window (a create may land).
 */
import { ProviderError } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { AppError, errors } from '../middleware/error';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { recordOperationsAudit } from './operations-access';
import {
  COMPLETE_INVENTORY_PROVIDERS,
  type NodeDb,
  type NodeRow,
  providerInventoryMatchesLabels,
  requireStrictNodeProvider,
} from './strict-node-deletion-shared';
import { getProvisioningTimeoutMs } from './timeout';

export type OperatorAbsenceProof =
  | { kind: 'provider_absent'; provider: string }
  | { kind: 'typed_confirmation'; providerUnavailableReason: string };

/** API error code the UI answers by asking the operator to type the node's name. */
export const OPERATOR_CONFIRMATION_REQUIRED = 'OPERATOR_CONFIRMATION_REQUIRED';

/** `operations_audit_log.task_id` is required; a UI action has no task. */
const NO_TASK = 'ui';

type ProviderAnswer =
  | { status: 'absent'; provider: string }
  | { status: 'present'; reason: string }
  | { status: 'unavailable'; reason: string };

/** 401/403/auth_error: this credential can never see the server (same test as the owner path). */
function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.statusCode === 401 || error.statusCode === 403 || error.category === 'auth_error';
}

async function askProvider(db: NodeDb, env: Env, node: NodeRow): Promise<ProviderAnswer> {
  const provider = node.cloudProvider ?? 'unknown';
  // Only a complete (or fail-closed) inventory can show a server is NOT there.
  if (!COMPLETE_INVENTORY_PROVIDERS.has(provider)) {
    return {
      status: 'unavailable',
      reason: `${provider} inventory cannot prove a server is gone`,
    };
  }
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel || !node.runtimeIncarnationId) {
    return { status: 'unavailable', reason: 'the node has no exact ownership labels to look up' };
  }
  let providerResult: Awaited<ReturnType<typeof requireStrictNodeProvider>>;
  try {
    providerResult = await requireStrictNodeProvider(db, node, node.userId, env);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  }
  if (providerResult.providerName !== provider) {
    return { status: 'unavailable', reason: 'the recorded credential resolves another provider' };
  }
  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: node.nodeRole === 'deployment',
    environmentLabel,
    installationId,
    runtimeIncarnationId: node.runtimeIncarnationId,
  });
  try {
    const servers = await providerResult.provider.listVMs(labels);
    const exact = servers.filter((server) => providerInventoryMatchesLabels(server, labels));
    if (exact.length > 0) {
      return {
        status: 'present',
        reason: `${provider} still has server ${exact.map((s) => s.id).join(', ')} labelled for this node`,
      };
    }
    if (servers.length > 0) {
      // The filter returned servers whose labels do not repeat exactly: SAM cannot rule them out.
      return {
        status: 'present',
        reason: `${provider} returned ${servers.length} server(s) for this node's labels that SAM cannot rule out`,
      };
    }
    if (node.providerInstanceId) {
      const byId = await providerResult.provider.getVM(node.providerInstanceId);
      if (byId) {
        return {
          status: 'present',
          reason: `${provider} still has server ${node.providerInstanceId}`,
        };
      }
    }
    return { status: 'absent', provider };
  } catch (error) {
    if (isCredentialRejection(error)) {
      return { status: 'unavailable', reason: `${provider} rejected the node's credential` };
    }
    log.warn('node_operator_retirement.provider_check_unavailable', {
      nodeId: node.id,
      provider,
      error: serializeError(error),
    });
    throw errors.serviceUnavailable(
      `Could not check with ${provider} whether this node's server still exists. Try again in a minute.`
    );
  }
}

function typedNameMatches(node: NodeRow, typed: string | undefined): boolean {
  const value = typed?.trim();
  return !!value && (value === node.name || value === node.id);
}

/**
 * Decides whether a superadmin may retire this SAM-capacity node, and returns the proof.
 * Throws (409/503) with the reason when it may not. Writes nothing.
 */
export async function proveOperatorRetirement(
  db: NodeDb,
  env: Env,
  node: NodeRow,
  confirmNodeName: string | undefined
): Promise<OperatorAbsenceProof> {
  const createdAt = Date.parse(node.createdAt);
  const windowEnds = createdAt + getProvisioningTimeoutMs(env);
  if (!Number.isFinite(createdAt) || Date.now() < windowEnds) {
    throw errors.conflict(
      'This node is still inside its provisioning window, so its server may still appear. ' +
        `Try again after ${Number.isFinite(windowEnds) ? new Date(windowEnds).toISOString() : 'the window ends'}.`
    );
  }
  const answer = await askProvider(db, env, node);
  if (answer.status === 'present') {
    throw errors.conflict(
      `Not removed: ${answer.reason}. Delete that server first (Delete Node retries it), then try again.`
    );
  }
  if (answer.status === 'absent') return { kind: 'provider_absent', provider: answer.provider };
  if (!typedNameMatches(node, confirmNodeName)) {
    throw new AppError(
      409,
      OPERATOR_CONFIRMATION_REQUIRED,
      `SAM cannot ask the provider whether this server still exists (${answer.reason}). ` +
        `Check your cloud console, then type the node name "${node.name}" to remove it.`,
      { nodeName: node.name }
    );
  }
  return { kind: 'typed_confirmation', providerUnavailableReason: answer.reason };
}

/** Who retired the node and why, in the operations audit trail. Never throws. */
export async function recordOperatorRetirementAudit(
  env: Env,
  actorUserId: string,
  node: NodeRow,
  proof: OperatorAbsenceProof
): Promise<void> {
  await recordOperationsAudit(env, {
    actorUserId,
    taskId: NO_TASK,
    tool: 'node_operator_retire',
    targetType: 'node',
    targetId: node.id,
    outcome: 'succeeded',
    detail: {
      proof: proof.kind,
      ...(proof.kind === 'typed_confirmation'
        ? { providerUnavailableReason: proof.providerUnavailableReason }
        : {}),
      nodeName: node.name,
      ownerUserId: node.userId,
      previousStatus: node.status,
      provider: node.cloudProvider,
      providerInstanceId: node.providerInstanceId,
      runtimeIncarnationId: node.runtimeIncarnationId,
    },
  });
  log.info('node_operator_retirement.retired', {
    nodeId: node.id,
    actorUserId,
    proof: proof.kind,
    provider: node.cloudProvider,
  });
}
