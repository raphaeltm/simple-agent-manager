import { drizzle } from 'drizzle-orm/d1';

import type { DirectProvisioningIntent } from '../durable-objects/node-lifecycle-provisioning';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getTimeoutMs } from './fetch-timeout';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { hasExactProviderCredentialGenerationProof } from './provider-credential-exact';
import {
  createProviderForUser,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

/** Reconcile only an explicit orphan deletion whose original owner already deleted its host.
 * A strict owner-deletion audit establishes completed host teardown; the sealed terminal
 * intent prevents replay, and fresh complete inventory checks the original account again.
 * Empty inventory alone, age, or missing D1 rows are never sufficient proof.
 * The caller holds the provisioning controller lock, excluding alarm/start/replay.
 */
export async function confirmUnassignedWorkspaceAbsence(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  intent: DirectProvisioningIntent
): Promise<boolean> {
  const input = intent.input;
  const workspace = input.workspace;
  if (
    !workspace?.mustProvisionNode ||
    intent.allocationComplete ||
    !['failed', 'unresolved'].includes(intent.status) ||
    intent.nextAttemptAt !== null ||
    !Number.isFinite(intent.createdAt) ||
    intent.createdAt > Date.now() ||
    expected.workspaceGeneration != null ||
    expected.nodeId !== null ||
    expected.nodeUserId !== null ||
    expected.nodeRuntime !== null ||
    expected.nodeProviderInstanceId !== null ||
    expected.nodeRuntimeIncarnationId !== null ||
    workspace.placement.id !== expected.workspaceId ||
    input.userId !== expected.userId ||
    workspace.placement.userId !== expected.userId ||
    workspace.placement.nodeId !== input.nodeId ||
    workspace.placement.projectId !== expected.projectId ||
    workspace.chatSessionId !== expected.chatSessionId
  )
    return false;

  const snapshot = workspace.placement.capacityPlacementSnapshot;
  const binding = snapshot && exactProviderCredentialBindingFromPlacementSnapshot(snapshot);
  if (!binding || !hasExactProviderCredentialGenerationProof(binding)) return false;
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel) return false;

  const stillOwned = async () =>
    Boolean(
      await env.DATABASE.prepare(
        `SELECT 1 AS ok FROM workspaces w
      WHERE w.id=? AND w.user_id=? AND w.project_id IS ? AND w.chat_session_id IS ?
        AND w.node_id IS NULL AND w.eviction_generation IS NULL AND w.status='stopping'
        AND w.runtime_deletion_confirmed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=?)
        AND EXISTS (SELECT 1 FROM node_health_events e WHERE e.node_id=?
          AND e.event='deleted_by_owner' AND e.reason='owner_requested_node_deletion'
          AND e.created_at > ?)`
      )
        .bind(
          expected.workspaceId,
          expected.userId,
          expected.projectId,
          expected.chatSessionId,
          input.nodeId,
          input.nodeId,
          new Date(intent.createdAt).toISOString()
        )
        .first()
    );
  if (!(await stillOwned())) return false;

  // Resolve ONLY the saved credential generation. No project/user/platform fallback.
  const resolve = () =>
    createProviderForUser(
      drizzle(env.DATABASE),
      expected.userId,
      getCredentialEncryptionKey(env),
      env,
      'hetzner',
      expected.projectId,
      binding
    );
  const provider = await resolve();
  if (!provider || provider.providerName !== 'hetzner') return false;
  // Omit incarnation deliberately: any surviving allocation for this original node blocks.
  const labels = buildNodeProviderLabels({
    nodeId: input.nodeId,
    isDeploymentNode: false,
    installationId,
    environmentLabel,
  });
  const servers = await provider.provider.listVMs(labels, {
    signal: AbortSignal.timeout(getTimeoutMs(env.CF_API_TIMEOUT_MS)),
  });
  // Hetzner's adapter validates pagination and response shapes. Do not filter foreign
  // or ambiguous responses into an apparent zero; any result fails closed.
  if (servers.length !== 0) return false;
  const currentProvider = await resolve();
  return Boolean(currentProvider?.providerName === 'hetzner' && (await stillOwned()));
}
