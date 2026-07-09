import type { VmAgentContainer, VmAgentContainerLaunchConfig, VmAgentContainerLaunchSecrets } from '../durable-objects/vm-agent-container';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { runCloudflareRuntimePhase } from './cloudflare-runtime-phase';

export interface VmAgentContainerConfig {
  enabled: boolean;
  vmAgentPort: number;
  sleepAfter: string;
}

export function getVmAgentContainerConfig(env: Env): VmAgentContainerConfig {
  return {
    enabled: (env.CF_CONTAINER_ENABLED ?? env.SANDBOX_ENABLED) === 'true',
    vmAgentPort: Number.parseInt(env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '8080', 10),
    sleepAfter: env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || '10m',
  };
}

export function requireVmAgentContainer(env: Env): void {
  const config = getVmAgentContainerConfig(env);
  if (!config.enabled) {
    throw errors.badRequest('Cloudflare Container workspace runtime is disabled.');
  }
  if (!env.VM_AGENT_CONTAINER) {
    throw errors.badRequest('VM_AGENT_CONTAINER binding is unavailable.');
  }
}

export function getVmAgentContainer(env: Env, nodeId: string): DurableObjectStub<VmAgentContainer> {
  requireVmAgentContainer(env);
  const binding = env.VM_AGENT_CONTAINER;
  if (!binding) {
    throw errors.badRequest('VM_AGENT_CONTAINER binding is unavailable.');
  }
  const id = binding.idFromName(nodeId.toLowerCase());
  return binding.get(id);
}

export async function launchVmAgentContainer(
  env: Env,
  nodeId: string,
  config: VmAgentContainerLaunchConfig,
  secrets: VmAgentContainerLaunchSecrets
): Promise<void> {
  const container = getVmAgentContainer(env, nodeId);
  await container.launch(config, secrets);
}

export async function fetchVmAgentContainer(
  env: Env,
  nodeId: string,
  request: Request,
  port?: number
): Promise<Response> {
  const container = getVmAgentContainer(env, nodeId);
  const isWebSocketUpgrade =
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    request.headers.get('connection')?.toLowerCase().includes('upgrade');
  if (isWebSocketUpgrade) {
    return container.fetch(request);
  }
  return container.proxyHttp(request, port);
}

export async function destroyVmAgentContainer(env: Env, nodeId: string): Promise<void> {
  const container = getVmAgentContainer(env, nodeId);
  await container.destroyForUser();
}

export async function stopVmAgentContainer(env: Env, nodeId: string): Promise<void> {
  const container = getVmAgentContainer(env, nodeId);
  await container.stopForUser();
}

export async function runContainerPhase<T>(
  phase: string,
  detail: { nodeId?: string; workspaceId?: string; containerId?: string },
  fn: () => Promise<T>
): Promise<T> {
  return runCloudflareRuntimePhase(
    {
      start: 'vm_agent_container_phase_start',
      success: 'vm_agent_container_phase_success',
      error: 'vm_agent_container_phase_error',
    },
    phase,
    detail,
    fn
  );
}
