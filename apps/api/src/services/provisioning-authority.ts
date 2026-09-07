import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import {
  type ProjectCapability,
  projectMemberRolesWithCapability,
} from '../middleware/project-auth';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

export class ProvisioningAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningAuthorityError';
  }
}

interface DirectWorkspaceProvisioningAuthorityInput {
  workspaceId: string;
  taskId: string;
  userId: string;
  projectId: string;
  expectedNodeId: string | null;
  chatSessionId?: string | null;
}

interface DeploymentProvisioningAuthorityInput {
  environmentId: string;
  projectId: string;
  userId: string;
  nodeId: string;
  provider: string;
  location: string;
  vmSize: string;
  nodeMode: 'shared' | 'exclusive';
  requiresVolumes: boolean;
}

interface TrialProvisioningAuthorityInput {
  trialId: string;
  projectId: string;
  userId: string;
  nowMs?: number;
}

interface RelayProvisioningAuthorityInput {
  userId: string;
  projectId: string | null;
  sourceNode: {
    id: string;
    vm_location: string;
    cloud_provider: string | null;
    provider_instance_type: string | null;
    provider_instance_boot_disk_size_gb: number | null;
    provider_instance_image: string | null;
    provider_instance_architecture: string | null;
  };
  requiredAgentVersion: string;
  relayNodeId: string;
  relayName: string;
}

export interface FreshProvisioningNodeCleanupInput {
  nodeId: string;
  userId: string;
  nodeRole: 'workspace' | 'deployment';
  reason: string;
}

export type FreshProvisioningNodeCleanupResult =
  | 'strict-deleted'
  | 'placeholder-deleted'
  | 'skipped'
  | 'failed';

function projectMemberCapabilitySql(capability: ProjectCapability): string {
  const roles = projectMemberRolesWithCapability(capability);
  if (roles.length === 0) return '0 = 1';
  return `pm.role IN (${roles.map((role) => `'${role}'`).join(', ')})`;
}

function requireD1(env: Env): D1Database {
  if (!env.DATABASE || typeof env.DATABASE.prepare !== 'function') {
    throw new ProvisioningAuthorityError('Provisioning authority database is unavailable');
  }
  return env.DATABASE;
}

async function requireAuthority(
  env: Env,
  sql: string,
  binds: unknown[],
  message: string
): Promise<void> {
  const ok = await requireD1(env)
    .prepare(sql)
    .bind(...binds)
    .first<{ ok: number }>();
  if (!ok) throw new ProvisioningAuthorityError(message);
}

export async function assertDirectWorkspaceProvisioningAuthority(
  env: Env,
  input: DirectWorkspaceProvisioningAuthorityInput
): Promise<void> {
  await requireAuthority(
    env,
    `SELECT 1 AS ok
       FROM workspaces w
       JOIN tasks t
         ON t.id = ?
        AND t.workspace_id = w.id
        AND t.user_id = w.user_id
        AND t.project_id = w.project_id
       JOIN project_members pm
         ON pm.project_id = w.project_id
         AND pm.user_id = w.user_id
         AND pm.status = 'active'
         AND pm.removed_at IS NULL
         AND ${projectMemberCapabilitySql('workspace:write')}
      WHERE w.id = ?
        AND w.user_id = ?
        AND w.project_id = ?
        AND w.node_id IS ?
        AND w.chat_session_id IS ?
        AND w.status = 'creating'
        AND w.runtime_deletion_confirmed_at IS NULL
        AND t.status IN ('queued', 'in_progress')
        AND t.execution_step IN ('workspace_creation', 'workspace_ready')
        AND t.task_mode = 'conversation'
        AND t.triggered_by = 'user'
      LIMIT 1`,
    [
      input.taskId,
      input.workspaceId,
      input.userId,
      input.projectId,
      input.expectedNodeId,
      input.chatSessionId ?? null,
    ],
    'Direct workspace provisioning authority is no longer current'
  );
}

export async function assertDeploymentProvisioningAuthority(
  env: Env,
  input: DeploymentProvisioningAuthorityInput
): Promise<void> {
  await requireAuthority(
    env,
    `SELECT 1 AS ok
       FROM deployment_environments de
       JOIN project_members pm
         ON pm.project_id = de.project_id
         AND pm.user_id = ?
         AND pm.status = 'active'
         AND pm.removed_at IS NULL
         AND ${projectMemberCapabilitySql('deployment:deploy')}
       JOIN nodes n
         ON n.id = de.node_id
        AND n.user_id = ?
      WHERE de.id = ?
        AND de.project_id = ?
        AND de.status = 'active'
        AND de.node_id = ?
        AND de.provider IS ?
        AND de.location IS ?
        AND de.requires_volumes = ?
        AND n.status IN ('creating', 'running')
        AND n.runtime = 'vm'
        AND n.node_class = 'managed'
        AND n.node_role = 'deployment'
        AND n.node_mode = ?
        AND n.cloud_provider = ?
        AND n.vm_location = ?
        AND n.vm_size = ?
      LIMIT 1`,
    [
      input.userId,
      input.userId,
      input.environmentId,
      input.projectId,
      input.nodeId,
      input.provider,
      input.location,
      input.requiresVolumes ? 1 : 0,
      input.nodeMode,
      input.provider,
      input.location,
      input.vmSize,
    ],
    'Deployment provisioning authority is no longer current'
  );
}

export async function assertTrialProvisioningAuthority(
  env: Env,
  input: TrialProvisioningAuthorityInput
): Promise<void> {
  await requireAuthority(
    env,
    `SELECT 1 AS ok
       FROM trials t
       JOIN projects p
         ON p.id = t.project_id
        AND p.user_id = ?
       JOIN project_members pm
         ON pm.project_id = p.id
         AND pm.user_id = ?
         AND pm.status = 'active'
         AND pm.removed_at IS NULL
         AND ${projectMemberCapabilitySql('workspace:write')}
      WHERE t.id = ?
        AND t.project_id = ?
        AND t.status = 'pending'
        AND t.claimed_by_user_id IS NULL
        AND t.expires_at > ?
      LIMIT 1`,
    [input.userId, input.userId, input.trialId, input.projectId, input.nowMs ?? Date.now()],
    'Trial provisioning authority is no longer current'
  );
}

export async function assertRelayProvisioningAuthority(
  env: Env,
  input: RelayProvisioningAuthorityInput
): Promise<void> {
  const projectMembershipSql = input.projectId
    ? `AND EXISTS (
         SELECT 1
           FROM project_members pm
          WHERE pm.project_id = ?
             AND pm.user_id = ?
             AND pm.status = 'active'
             AND pm.removed_at IS NULL
             AND ${projectMemberCapabilitySql('workspace:write')}
       )`
    : '';
  const projectMembershipBinds = input.projectId ? [input.projectId, input.userId] : [];

  await requireAuthority(
    env,
    `SELECT 1 AS ok
       FROM nodes source
       JOIN nodes relay
         ON relay.id = ?
        AND relay.user_id = ?
        AND relay.name = ?
        AND relay.status IN ('creating', 'running')
        AND relay.runtime = 'vm'
        AND relay.node_class = 'managed'
        AND relay.node_role = 'workspace'
      WHERE source.id = ?
        AND source.user_id = ?
        AND source.status = 'running'
        AND source.runtime = 'vm'
        AND source.node_class = 'managed'
        AND (source.agent_version IS NULL OR source.agent_version != ?)
        AND source.cloud_provider IS ?
        AND source.vm_location = ?
        AND source.provider_instance_type IS ?
        AND source.provider_instance_boot_disk_size_gb IS ?
        AND source.provider_instance_image IS ?
        AND source.provider_instance_architecture IS ?
        ${projectMembershipSql}
        AND NOT EXISTS (
          SELECT 1
            FROM nodes duplicate
           WHERE duplicate.user_id = ?
             AND duplicate.name = ?
             AND duplicate.status IN ('creating', 'running')
             AND duplicate.runtime = 'vm'
             AND duplicate.node_class = 'managed'
             AND duplicate.node_role = 'workspace'
             AND duplicate.cloud_provider IS relay.cloud_provider
             AND duplicate.vm_location = relay.vm_location
             AND duplicate.vm_size = relay.vm_size
             AND duplicate.provider_instance_type IS relay.provider_instance_type
             AND duplicate.provider_instance_boot_disk_size_gb IS relay.provider_instance_boot_disk_size_gb
             AND duplicate.provider_instance_image IS relay.provider_instance_image
             AND duplicate.provider_instance_architecture IS relay.provider_instance_architecture
             AND duplicate.id <> ?
        )
      LIMIT 1`,
    [
      input.relayNodeId,
      input.userId,
      input.relayName,
      input.sourceNode.id,
      input.userId,
      input.requiredAgentVersion,
      input.sourceNode.cloud_provider,
      input.sourceNode.vm_location,
      input.sourceNode.provider_instance_type,
      input.sourceNode.provider_instance_boot_disk_size_gb,
      input.sourceNode.provider_instance_image,
      input.sourceNode.provider_instance_architecture,
      ...projectMembershipBinds,
      input.userId,
      input.relayName,
      input.relayNodeId,
    ],
    'Session snapshot relay provisioning authority is no longer current'
  );
}

export async function cleanupFreshProvisioningNode(
  env: Env,
  input: FreshProvisioningNodeCleanupInput
): Promise<FreshProvisioningNodeCleanupResult> {
  const database = requireD1(env);
  const row = await database
    .prepare(
      `SELECT n.id, n.status, n.provider_instance_id AS providerInstanceId
         FROM nodes n
        WHERE n.id = ?
          AND n.user_id = ?
          AND n.runtime = 'vm'
          AND n.node_class = 'managed'
          AND n.node_role = ?
          AND n.status IN ('creating', 'running', 'error', 'destroying')
          AND NOT EXISTS (
            SELECT 1 FROM workspaces w
             WHERE w.node_id = n.id
               AND w.status IN ('creating', 'running', 'recovery', 'stopping')
          )
          AND NOT EXISTS (
            SELECT 1 FROM deployment_environments de
             WHERE de.node_id = n.id
          )
        LIMIT 1`
    )
    .bind(input.nodeId, input.userId, input.nodeRole)
    .first<{ id: string; status: string; providerInstanceId: string | null }>();

  if (!row) return 'skipped';

  if (!row.providerInstanceId) {
    const deleted = await database
      .prepare(
        `DELETE FROM nodes
          WHERE id = ?
            AND user_id = ?
            AND runtime = 'vm'
            AND node_class = 'managed'
            AND node_role = ?
            AND provider_instance_id IS NULL
            AND status IN ('creating', 'error')
            AND NOT EXISTS (
              SELECT 1 FROM workspaces w
               WHERE w.node_id = nodes.id
                 AND w.status IN ('creating', 'running', 'recovery', 'stopping')
            )
            AND NOT EXISTS (
              SELECT 1 FROM deployment_environments de
               WHERE de.node_id = nodes.id
            )`
      )
      .bind(input.nodeId, input.userId, input.nodeRole)
      .run();
    return (deleted.meta?.changes ?? 0) > 0 ? 'placeholder-deleted' : 'skipped';
  }

  try {
    await deleteNodeResourcesStrict(input.nodeId, input.userId, env);
    return 'strict-deleted';
  } catch (err) {
    log.error('provisioning_authority.fresh_node_cleanup_failed', {
      nodeId: input.nodeId,
      userId: input.userId,
      nodeRole: input.nodeRole,
      reason: input.reason,
      ...serializeError(err),
    });
    return 'failed';
  }
}
