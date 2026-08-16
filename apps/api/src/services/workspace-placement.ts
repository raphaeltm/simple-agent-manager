import type { VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';

export interface WorkspacePlacementInput {
  id: string;
  nodeId: string;
  projectId: string;
  userId: string;
  installationId: string;
  name: string;
  displayName: string;
  normalizedDisplayName: string;
  repository: string;
  branch: string;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  agentProfileHint: string | null;
  createdAt: string;
}

/**
 * Atomically reserve one workspace slot and create its durable `creating` row.
 *
 * Node selection is advisory: another TaskRunner or cleanup loop can change D1
 * before workspace creation. Keeping the node-state and capacity predicates in
 * the INSERT makes that final placement decision one D1 statement. Concurrent
 * inserts cannot both consume the same final slot, and a cleanup claim that wins
 * first changes the node out of `running`, causing this operation to return false.
 */
export async function reserveWorkspacePlacement(
  database: D1Database,
  input: WorkspacePlacementInput,
  maxWorkspaces: number
): Promise<boolean> {
  const result = await database
    .prepare(
      `INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?
       FROM nodes n
       WHERE n.id = ?
         AND n.user_id = ?
         AND n.status = 'running'
         AND n.node_role = 'workspace'
         AND (
           SELECT COUNT(*)
           FROM workspaces active
           WHERE active.node_id = n.id
             AND active.status IN ('running', 'creating', 'recovery')
         ) < ?`
    )
    .bind(
      input.id,
      input.nodeId,
      input.projectId,
      input.userId,
      input.installationId,
      input.name,
      input.displayName,
      input.normalizedDisplayName,
      input.repository,
      input.branch,
      input.vmSize,
      input.vmLocation,
      input.workspaceProfile,
      input.devcontainerConfigName,
      input.agentProfileHint,
      input.createdAt,
      input.createdAt,
      input.nodeId,
      input.userId,
      maxWorkspaces
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}
