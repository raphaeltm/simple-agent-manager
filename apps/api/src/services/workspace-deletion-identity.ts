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

/**
 * The workspace's chat binding still allows deleting the identity that was queued.
 * A wake releases the source's binding (`reactivateSleepingTask`) while its deletion is
 * queued or claimed, and that release is authorized: the closure then skips the chat,
 * because it reads the row's current (NULL) binding, so the successor is never touched.
 * Directional on purpose: a different chat, or a binding appearing on a workspace queued
 * unbound, still fences. SQL twin: `CHAT_BINDING_RELEASE_TOLERANT_SQL`.
 */
export function chatBindingAllowsDeletion(
  currentChatSessionId: string | null,
  expectedChatSessionId: string | null
): boolean {
  return currentChatSessionId === expectedChatSessionId || currentChatSessionId === null;
}

/** `chat_session_id` predicate for deletion writes; bind the queued (expected) chat once. */
export const CHAT_BINDING_RELEASE_TOLERANT_SQL =
  '(chat_session_id IS ? OR chat_session_id IS NULL)';

export function sameOwnership(
  current: WorkspaceDeletionIdentity,
  expected: WorkspaceDeletionIdentity
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    (current.workspaceGeneration ?? null) === (expected.workspaceGeneration ?? null) &&
    current.userId === expected.userId &&
    nullableEqual(current.projectId, expected.projectId) &&
    chatBindingAllowsDeletion(current.chatSessionId, expected.chatSessionId) &&
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
    chatBindingAllowsDeletion(current.chatSessionId, expected.chatSessionId) &&
    (current.nodeId === null ||
      (nullableEqual(current.nodeId, expected.nodeId) &&
        nullableEqual(current.nodeUserId, expected.nodeUserId) &&
        nullableEqual(current.nodeRuntime, expected.nodeRuntime) &&
        nullableEqual(current.nodeProviderInstanceId, expected.nodeProviderInstanceId) &&
        nullableEqual(current.nodeRuntimeIncarnationId, expected.nodeRuntimeIncarnationId)))
  );
}
