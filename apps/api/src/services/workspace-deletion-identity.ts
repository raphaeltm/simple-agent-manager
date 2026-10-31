import type { WorkspaceDeletionIdentity } from './workspace-deletion';

export function workspaceDeletionIdentityLogContext(
  expected: WorkspaceDeletionIdentity,
  current: WorkspaceDeletionIdentity | null
): Record<string, string | null> {
  return {
    expectedWorkspaceId: expected.workspaceId,
    currentWorkspaceId: current?.workspaceId ?? null,
    expectedUserId: expected.userId,
    currentUserId: current?.userId ?? null,
    expectedProjectId: expected.projectId,
    currentProjectId: current?.projectId ?? null,
    expectedChatSessionId: expected.chatSessionId,
    currentChatSessionId: current?.chatSessionId ?? null,
    expectedNodeId: expected.nodeId,
    currentNodeId: current?.nodeId ?? null,
    expectedNodeUserId: expected.nodeUserId,
    currentNodeUserId: current?.nodeUserId ?? null,
    expectedNodeRuntime: expected.nodeRuntime,
    currentNodeRuntime: current?.nodeRuntime ?? null,
    expectedNodeProviderInstanceId: expected.nodeProviderInstanceId,
    currentNodeProviderInstanceId: current?.nodeProviderInstanceId ?? null,
    expectedNodeRuntimeIncarnationId: expected.nodeRuntimeIncarnationId,
    currentNodeRuntimeIncarnationId: current?.nodeRuntimeIncarnationId ?? null,
  };
}

function nullableEqual(left: string | null, right: string | null): boolean {
  return left === right;
}

export function sameOwnership(
  current: WorkspaceDeletionIdentity,
  expected: WorkspaceDeletionIdentity
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    (current.workspaceGeneration ?? null) === (expected.workspaceGeneration ?? null) &&
    current.userId === expected.userId &&
    nullableEqual(current.projectId, expected.projectId) &&
    nullableEqual(current.chatSessionId, expected.chatSessionId) &&
    nullableEqual(current.nodeId, expected.nodeId) &&
    nullableEqual(current.nodeUserId, expected.nodeUserId) &&
    nullableEqual(current.nodeRuntime, expected.nodeRuntime) &&
    nullableEqual(current.nodeProviderInstanceId, expected.nodeProviderInstanceId) &&
    nullableEqual(current.nodeRuntimeIncarnationId, expected.nodeRuntimeIncarnationId)
  );
}

export function sameOwnershipExceptTerminalNode(
  current: WorkspaceDeletionIdentity,
  expected: WorkspaceDeletionIdentity
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    (current.workspaceGeneration ?? null) === (expected.workspaceGeneration ?? null) &&
    current.userId === expected.userId &&
    nullableEqual(current.projectId, expected.projectId) &&
    nullableEqual(current.chatSessionId, expected.chatSessionId) &&
    (current.nodeId === null ||
      (nullableEqual(current.nodeId, expected.nodeId) &&
        nullableEqual(current.nodeUserId, expected.nodeUserId) &&
        nullableEqual(current.nodeRuntime, expected.nodeRuntime) &&
        nullableEqual(current.nodeProviderInstanceId, expected.nodeProviderInstanceId) &&
        nullableEqual(current.nodeRuntimeIncarnationId, expected.nodeRuntimeIncarnationId)))
  );
}
