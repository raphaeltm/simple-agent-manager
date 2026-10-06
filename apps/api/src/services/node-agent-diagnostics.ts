import type { Env } from '../env';
import { nodeAgentRequest } from './node-agent';

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
