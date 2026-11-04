import type { Env } from '../env';
import { nodeAgentRawRequest, nodeAgentRequest } from './node-agent';

export async function getNodeSystemInfoFromNode(
  nodeId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, '/system-info', {
    method: 'GET',
    userId,
  });
}

export async function getNodeLogsFromNode(
  nodeId: string,
  env: Env,
  userId: string,
  queryString: string
): Promise<unknown> {
  const path = queryString ? `/logs?${queryString}` : '/logs';
  return nodeAgentRequest(nodeId, env, path, {
    method: 'GET',
    userId,
  });
}

export async function listNodeContainersFromNode(
  nodeId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, '/containers', {
    method: 'GET',
    userId,
  });
}

/** Opens a raw diagnostic artifact stream (debug package, events/metrics export) from a node. */
export async function openNodeDiagnosticDownload(
  nodeId: string,
  env: Env,
  userId: string,
  path: '/debug-package' | '/events/export' | '/metrics/export'
): Promise<Response> {
  const response = await nodeAgentRawRequest(nodeId, env, path, userId);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`VM agent returned ${response.status}: ${body}`);
  }
  return response;
}
