import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  getNodeAgentBackgroundRequestTimeoutMs,
  type GuardedNodeAgentMutationOptions,
  nodeAgentRequest,
} from './node-agent';

export const DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionSnapshotRequest {
  chatSessionId: string;
  runtime: string;
  agentType?: string;
  background?: boolean;
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

export function hibernateAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  input: SessionSnapshotRequest
): Promise<unknown> {
  return requestSessionSnapshot('hibernate', nodeId, workspaceId, sessionId, env, userId, input);
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
