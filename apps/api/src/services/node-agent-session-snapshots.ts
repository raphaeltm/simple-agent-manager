import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  getNodeAgentBackgroundRequestTimeoutMs,
  type GuardedNodeAgentMutationOptions,
  nodeAgentRequest,
} from './node-agent';
import { mintWorkspaceCallbackTokenForNodeDelivery } from './workspace-callback-token-binding';

export const DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionSnapshotRequest {
  chatSessionId: string;
  runtime: string;
  agentType?: string;
  background?: boolean;
  /**
   * Fresh workspace-scoped callback token the agent stores before capturing (VM agents
   * accept it on hibernate since 2026-07-11). Without it, a workspace awake longer than
   * CALLBACK_TOKEN_EXPIRY_MS fails every snapshot callback with 401.
   */
  workspaceCallbackToken?: string;
}

export function getSessionSnapshotRequestTimeoutMs(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS,
    DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS
  );
}

function requestSessionSnapshot(
  action: 'hibernate' | 'restore',
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  input: SessionSnapshotRequest,
  options?: GuardedNodeAgentMutationOptions
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/${action}`,
    {
      method: 'POST',
      userId,
      workspaceId,
      sourceTaskGuard: options?.sourceTaskGuard,
      beforeExternalMutation: options?.beforeExternalMutation,
      requestTimeoutMs: input.background
        ? getNodeAgentBackgroundRequestTimeoutMs(env)
        : getSessionSnapshotRequestTimeoutMs(env),
      body: JSON.stringify(input),
    }
  );
}

/** Supplies the workspace token one hibernate request delivers; null delivers none. */
export type HibernateCallbackTokenDelivery = () => Promise<string | null>;

/**
 * Mint at most one delivered workspace token for repeats of the same hibernate request.
 * The agent installs a delivered token as soon as it reads the request, accepted or not,
 * so a caller that repeats the request until the agent accepts it resends the token it
 * minted first instead of signing a new one on every poll.
 */
export function hibernateCallbackTokenDelivery(
  env: Env,
  target: { workspaceId: string; nodeId: string }
): HibernateCallbackTokenDelivery {
  let minted: Promise<string | null> | undefined;
  return () => (minted ??= mintWorkspaceCallbackTokenForNodeDelivery(env, target));
}

export async function hibernateAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  input: SessionSnapshotRequest,
  deliverWorkspaceCallbackToken: HibernateCallbackTokenDelivery = hibernateCallbackTokenDelivery(
    env,
    { workspaceId, nodeId }
  )
): Promise<unknown> {
  // The capture's prepare/progress/complete/failure callbacks authenticate with the
  // workspace token the agent holds. Deliver a fresh one over this node-management
  // request, exactly as create/restore do, so a long-awake workspace can still sleep.
  const workspaceCallbackToken = await deliverWorkspaceCallbackToken();
  return requestSessionSnapshot('hibernate', nodeId, workspaceId, sessionId, env, userId, {
    ...input,
    ...(workspaceCallbackToken ? { workspaceCallbackToken } : {}),
  });
}

export function restoreAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  input: SessionSnapshotRequest,
  options?: GuardedNodeAgentMutationOptions
): Promise<unknown> {
  return requestSessionSnapshot(
    'restore',
    nodeId,
    workspaceId,
    sessionId,
    env,
    userId,
    input,
    options
  );
}
