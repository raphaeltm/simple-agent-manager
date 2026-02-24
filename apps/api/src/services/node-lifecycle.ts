/**
 * Service layer for interacting with the per-node NodeLifecycle Durable Object.
 *
 * Provides typed wrapper methods that resolve the DO stub from a nodeId
 * and forward calls to the NodeLifecycle DO via RPC.
 *
 * See: specs/021-task-chat-architecture/tasks.md (Phase 5)
 */
import type { Env } from '../index';
import type { NodeLifecycle } from '../durable-objects/node-lifecycle';
import type { NodeLifecycleState } from '@simple-agent-manager/shared';

/**
 * Get a typed DO stub for the given node.
 * Uses `idFromName(nodeId)` for deterministic mapping.
 */
function getStub(env: Env, nodeId: string): DurableObjectStub<NodeLifecycle> {
  const id = env.NODE_LIFECYCLE.idFromName(nodeId);
  return env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycle>;
}

/**
 * Mark a node as idle (warm). Called after the last workspace is destroyed.
 * Schedules a warm timeout alarm in the DO.
 */
export async function markIdle(
  env: Env,
  nodeId: string,
  userId: string
): Promise<NodeLifecycleState> {
  const stub = getStub(env, nodeId);
  return stub.markIdle(nodeId, userId);
}

/**
 * Mark a node as active. Called when a new workspace starts.
 * Cancels any pending warm timeout alarm.
 */
export async function markActive(
  env: Env,
  nodeId: string
): Promise<NodeLifecycleState> {
  const stub = getStub(env, nodeId);
  return stub.markActive();
}

/**
 * Try to claim a warm node for a new task.
 * Returns { claimed: true } if the node was warm and has been reserved.
 */
export async function tryClaim(
  env: Env,
  nodeId: string,
  taskId: string
): Promise<{ claimed: boolean; state: NodeLifecycleState }> {
  const stub = getStub(env, nodeId);
  return stub.tryClaim(taskId);
}

/**
 * Get the current lifecycle state of a node.
 */
export async function getStatus(
  env: Env,
  nodeId: string
): Promise<NodeLifecycleState> {
  const stub = getStub(env, nodeId);
  return stub.getStatus();
}
