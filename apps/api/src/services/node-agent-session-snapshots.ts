import type { Env } from '../env';
import { getNodeAgentRequestTimeoutMs, nodeAgentRequest } from './node-agent';

interface SessionSnapshotRequest {
  chatSessionId: string;
  runtime: string;
  agentType?: string;
}

function requestSessionSnapshot(
  action: 'hibernate' | 'restore',
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  input: SessionSnapshotRequest
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/${action}`,
    {
      method: 'POST',
      userId,
      workspaceId,
      requestTimeoutMs: getNodeAgentRequestTimeoutMs(env),
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
  input: SessionSnapshotRequest
): Promise<unknown> {
  return requestSessionSnapshot('restore', nodeId, workspaceId, sessionId, env, userId, input);
}
