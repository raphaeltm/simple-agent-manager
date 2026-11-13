import type { NodeLifecycle } from '../durable-objects/node-lifecycle';
import type { RuntimePort } from '../durable-objects/project-data/ports';
import type { VmAgentContainer } from '../durable-objects/vm-agent-container';
import { isVmAgentContainerLifecycleTerminal } from '../durable-objects/vm-agent-container-lifecycle';
import { cancelAgentSessionOnNode, listAgentSessionsOnNode } from '../services/node-agent';
import { isSleepingContainerRuntime } from '../services/sleeping-container-runtime';
import { DefaultVmPromptDeliveryAdapter } from '../services/vm-prompt-delivery-adapter';
import { workerEnv } from './worker-env';

/** Node agents, prompt transport and runtime containers. */
export const runtimePort: RuntimePort = {
  createPromptDeliveryAdapter: (env) => new DefaultVmPromptDeliveryAdapter(workerEnv(env)),
  cancelAgentSession: (env, request) =>
    cancelAgentSessionOnNode(
      request.nodeId,
      request.workspaceId,
      request.agentSessionId,
      workerEnv(env),
      request.userId,
      request.requestTimeoutMs ? { requestTimeoutMs: request.requestTimeoutMs } : {}
    ),
  listAgentSessions: (env, request) =>
    listAgentSessionsOnNode(
      request.nodeId,
      request.workspaceId,
      workerEnv(env),
      request.userId,
      request.requestTimeoutMs ? { requestTimeoutMs: request.requestTimeoutMs } : {}
    ),
  isSleepingContainerRuntime,
  async inspectContainerLifecycle(env, nodeId) {
    const binding = workerEnv(env).VM_AGENT_CONTAINER;
    if (!binding) throw new Error('VM_AGENT_CONTAINER binding is unavailable');
    const stub = binding.get(
      binding.idFromName(nodeId.toLowerCase())
    ) as DurableObjectStub<VmAgentContainer>;
    const lifecycle = await stub.inspectLifecycle();
    return {
      status: lifecycle.status,
      terminal: isVmAgentContainerLifecycleTerminal(lifecycle.status),
    };
  },
  async scheduleWorkspaceDeletion(env, input) {
    const namespace = workerEnv(env).NODE_LIFECYCLE;
    const stub = namespace.get(namespace.idFromName(input.nodeId));
    await (stub as unknown as NodeLifecycle).scheduleWorkspaceDeletion(
      input.nodeId,
      input.workspaceId,
      input.userId
    );
  },
};
