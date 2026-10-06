/**
 * Workspace callback identity: the D1 facts a VM-agent workspace callback is
 * authorized against. Dependency-free so lightweight callers (for example the
 * hibernate token delivery in node-agent-session-snapshots.ts) can share them
 * without importing the route helpers that re-export them
 * (routes/workspaces/_helpers.ts).
 */

export const WORKSPACE_CALLBACK_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'running',
  'recovery',
]);

export interface WorkspaceCallbackIdentitySnapshot {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  chatSessionId: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
}

export function sameWorkspaceCallbackIdentity(
  current: WorkspaceCallbackIdentitySnapshot,
  expected: WorkspaceCallbackIdentitySnapshot
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    current.userId === expected.userId &&
    current.projectId === expected.projectId &&
    current.chatSessionId === expected.chatSessionId &&
    current.status === expected.status &&
    current.nodeId === expected.nodeId &&
    current.nodeStatus === expected.nodeStatus
  );
}
