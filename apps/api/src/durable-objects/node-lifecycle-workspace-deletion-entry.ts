import type { WorkspaceDeletionIdentity } from '../services/workspace-deletion';
import type { PendingWorkspaceDeletion } from './node-lifecycle-workspace-deletion-support';

export function deletionEntryClaimedWithoutNodeIncarnation(
  entry: PendingWorkspaceDeletion
): boolean {
  return (
    (entry.attemptCount ?? 0) > 0 &&
    (entry.nodeUserId === undefined ||
      entry.nodeRuntime === undefined ||
      entry.nodeProviderInstanceId === undefined ||
      entry.nodeRuntimeIncarnationId === undefined)
  );
}

export function deletionEntryMatchesScheduledIdentity(
  entry: PendingWorkspaceDeletion | undefined,
  identity: WorkspaceDeletionIdentity
): boolean {
  return Boolean(
    entry &&
    !deletionEntryClaimedWithoutNodeIncarnation(entry) &&
    entry.nodeId === identity.nodeId &&
    (entry.nodeUserId === undefined || entry.nodeUserId === identity.nodeUserId) &&
    (entry.nodeRuntime === undefined || entry.nodeRuntime === identity.nodeRuntime) &&
    (entry.nodeProviderInstanceId === undefined ||
      entry.nodeProviderInstanceId === identity.nodeProviderInstanceId) &&
    (entry.nodeRuntimeIncarnationId === undefined ||
      entry.nodeRuntimeIncarnationId === identity.nodeRuntimeIncarnationId) &&
    entry.userId === identity.userId &&
    entry.projectId === identity.projectId &&
    entry.chatSessionId === identity.chatSessionId
  );
}

export function scheduledDeletionIdentity(input: {
  supplied: WorkspaceDeletionIdentity | undefined;
  current: WorkspaceDeletionIdentity | null;
  workspaceId: string;
  nodeId: string;
  userId: string;
}): WorkspaceDeletionIdentity {
  return (
    input.supplied ??
    input.current ?? {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      nodeUserId: null,
      nodeRuntime: null,
      nodeProviderInstanceId: null,
      nodeRuntimeIncarnationId: null,
      userId: input.userId,
      projectId: null,
      chatSessionId: null,
    }
  );
}

export function scheduledDeletionEntry(input: {
  existing: PendingWorkspaceDeletion | undefined;
  existingMatches: boolean;
  identity: WorkspaceDeletionIdentity;
  fallbackNodeId: string;
  workspaceId: string;
  now: number;
  delayMs: number;
  lastError: string | null | undefined;
}): PendingWorkspaceDeletion {
  const { existing, existingMatches, identity, now } = input;
  const preserved = existingMatches ? existing : undefined;
  return {
    nodeId: identity.nodeId ?? input.fallbackNodeId,
    nodeUserId: identity.nodeUserId,
    nodeRuntime: identity.nodeRuntime,
    nodeProviderInstanceId: identity.nodeProviderInstanceId,
    nodeRuntimeIncarnationId: identity.nodeRuntimeIncarnationId,
    workspaceId: input.workspaceId,
    userId: identity.userId,
    projectId: identity.projectId,
    chatSessionId: identity.chatSessionId,
    deleteAt: preserved ? Math.min(preserved.deleteAt, now + input.delayMs) : now + input.delayMs,
    firstScheduledAt: preserved?.firstScheduledAt ?? now,
    attemptCount: preserved?.attemptCount ?? 0,
    lastAttemptAt: preserved?.lastAttemptAt ?? null,
    lastError: input.lastError ?? preserved?.lastError ?? null,
    claimId: preserved?.claimId ?? null,
    deadLetteredAt: preserved?.deadLetteredAt ?? null,
    deadLetterReason: preserved?.deadLetterReason ?? null,
  };
}

export function deletionEntryMatchesClaimIdentity(input: {
  entry: PendingWorkspaceDeletion | undefined;
  nodeId: string;
  userId: string;
  expected: WorkspaceDeletionIdentity;
}): boolean {
  const { entry, expected } = input;
  if (!entry) return true;
  return (
    (entry.nodeId ?? input.nodeId) === (expected.nodeId ?? input.nodeId) &&
    (entry.nodeUserId === undefined ? expected.nodeUserId : entry.nodeUserId) ===
      expected.nodeUserId &&
    (entry.nodeRuntime === undefined ? expected.nodeRuntime : entry.nodeRuntime) ===
      expected.nodeRuntime &&
    (entry.nodeProviderInstanceId === undefined
      ? expected.nodeProviderInstanceId
      : entry.nodeProviderInstanceId) === expected.nodeProviderInstanceId &&
    (entry.nodeRuntimeIncarnationId === undefined
      ? expected.nodeRuntimeIncarnationId
      : entry.nodeRuntimeIncarnationId) === expected.nodeRuntimeIncarnationId &&
    entry.userId === input.userId &&
    (entry.projectId ?? expected.projectId) === expected.projectId &&
    (entry.chatSessionId ?? expected.chatSessionId) === expected.chatSessionId
  );
}

export function deletionIdentityFromEntry(
  entry: PendingWorkspaceDeletion | null | undefined
): WorkspaceDeletionIdentity | null {
  if (!entry) return null;
  return {
    workspaceId: entry.workspaceId,
    nodeId: entry.nodeId ?? null,
    nodeUserId: entry.nodeUserId ?? null,
    nodeRuntime: entry.nodeRuntime ?? null,
    nodeProviderInstanceId: entry.nodeProviderInstanceId ?? null,
    nodeRuntimeIncarnationId: entry.nodeRuntimeIncarnationId ?? null,
    userId: entry.userId,
    projectId: entry.projectId ?? null,
    chatSessionId: entry.chatSessionId ?? null,
  };
}

export function deletionIdentityForAttempt(input: {
  entry: PendingWorkspaceDeletion;
  current: WorkspaceDeletionIdentity | null;
  storedNodeId: string | undefined;
}): WorkspaceDeletionIdentity {
  const { entry, current } = input;
  return {
    workspaceId: entry.workspaceId,
    nodeId: entry.nodeId ?? input.storedNodeId ?? current?.nodeId ?? null,
    nodeUserId: entry.nodeUserId === undefined ? (current?.nodeUserId ?? null) : entry.nodeUserId,
    nodeRuntime:
      entry.nodeRuntime === undefined ? (current?.nodeRuntime ?? null) : entry.nodeRuntime,
    nodeProviderInstanceId:
      entry.nodeProviderInstanceId === undefined
        ? (current?.nodeProviderInstanceId ?? null)
        : entry.nodeProviderInstanceId,
    nodeRuntimeIncarnationId:
      entry.nodeRuntimeIncarnationId === undefined
        ? (current?.nodeRuntimeIncarnationId ?? null)
        : entry.nodeRuntimeIncarnationId,
    userId: entry.userId,
    projectId: entry.projectId === undefined ? (current?.projectId ?? null) : entry.projectId,
    chatSessionId:
      entry.chatSessionId === undefined ? (current?.chatSessionId ?? null) : entry.chatSessionId,
  };
}

export function claimedDeletionEntry(input: {
  entry: PendingWorkspaceDeletion;
  expected: WorkspaceDeletionIdentity;
  attempt: number;
  claimId: string;
  now: number;
  retryDelayMs: number;
}): PendingWorkspaceDeletion {
  const { entry, expected } = input;
  return {
    ...entry,
    nodeId: expected.nodeId ?? undefined,
    nodeUserId: expected.nodeUserId,
    nodeRuntime: expected.nodeRuntime,
    nodeProviderInstanceId: expected.nodeProviderInstanceId,
    nodeRuntimeIncarnationId: expected.nodeRuntimeIncarnationId,
    projectId: expected.projectId,
    chatSessionId: expected.chatSessionId,
    deleteAt: input.now + input.retryDelayMs,
    firstScheduledAt: entry.firstScheduledAt ?? input.now,
    attemptCount: input.attempt,
    lastAttemptAt: input.now,
    claimId: input.claimId,
    deadLetteredAt: null,
    deadLetterReason: null,
  };
}
