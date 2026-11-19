/**
 * The queued deletion's chat binding against the workspace's current binding when an attempt
 * is claimed (`deletionEntryMatchesClaimIdentity`). A wake may release the binding; nothing may
 * bind a chat to a workspace that was queued unbound.
 */
import { describe, expect, it } from 'vitest';

import { deletionEntryMatchesClaimIdentity } from '../../../src/durable-objects/node-lifecycle-workspace-deletion-entry';
import type { PendingWorkspaceDeletion } from '../../../src/durable-objects/node-lifecycle-workspace-deletion-support';
import type { WorkspaceDeletionIdentity } from '../../../src/services/workspace-deletion';

const identity: WorkspaceDeletionIdentity = {
  workspaceId: 'workspace',
  workspaceGeneration: 'generation',
  nodeId: 'node',
  nodeUserId: 'user',
  nodeRuntime: 'vm',
  nodeProviderInstanceId: 'instance',
  nodeRuntimeIncarnationId: 'incarnation',
  userId: 'user',
  projectId: 'project',
  chatSessionId: null,
};

function entry(chatSessionId: string | null | undefined): PendingWorkspaceDeletion {
  const queued: PendingWorkspaceDeletion = {
    ...identity,
    nodeId: 'node',
    deleteAt: 0,
  };
  if (chatSessionId === undefined) delete queued.chatSessionId;
  else queued.chatSessionId = chatSessionId;
  return queued;
}

const matches = (queued: string | null | undefined, current: string | null) =>
  deletionEntryMatchesClaimIdentity({
    entry: entry(queued),
    nodeId: 'node',
    userId: 'user',
    expected: { ...identity, chatSessionId: current },
  });

describe('deletionEntryMatchesClaimIdentity chat binding', () => {
  it('fences a chat that bound a workspace queued unbound', () => {
    expect(matches(null, 'chat')).toBe(false);
  });

  it('accepts a binding a wake released after the deletion was queued', () => {
    expect(matches('chat', null)).toBe(true);
  });

  it('fences a different chat', () => {
    expect(matches('chat', 'other-chat')).toBe(false);
  });

  it('keeps the unchanged binding and an entry written before bindings were recorded', () => {
    expect(matches('chat', 'chat')).toBe(true);
    expect(matches(null, null)).toBe(true);
    expect(matches(undefined, 'chat')).toBe(true);
  });
});
