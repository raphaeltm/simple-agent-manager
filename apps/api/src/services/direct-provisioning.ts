import type { NodeLifecycle } from '../durable-objects/node-lifecycle';
import type { Env } from '../env';
import type { DirectWorkspaceCreationInput } from './direct-workspace-creation';

export interface DirectProvisioningInput {
  nodeId: string;
  userId: string;
  workspace?: DirectWorkspaceCreationInput;
}

/** The RPC durably accepts work before the HTTP response; no allocation belongs to request waitUntil. */
export async function scheduleDirectProvisioning(
  env: Env,
  input: DirectProvisioningInput
): Promise<void> {
  const key = input.workspace
    ? `workspace-create:${input.workspace.placement.id}`
    : `allocation:${input.nodeId}`;
  const stub = env.NODE_LIFECYCLE.get(
    env.NODE_LIFECYCLE.idFromName(key)
  ) as DurableObjectStub<NodeLifecycle>;
  await stub.startProvisioning(input);
}
