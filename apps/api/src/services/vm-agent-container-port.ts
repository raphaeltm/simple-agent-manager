import type { Env } from '../env';

export const DEFAULT_CF_CONTAINER_VM_AGENT_PORT = 8080;

/**
 * The port the container's vm-agent listens on. The container runtime, its
 * launch env and the Worker's port-route guard must all agree, so every reader
 * resolves it here; a malformed value falls back to the default.
 */
export function resolveVmAgentContainerPort(
  env: Pick<Env, 'CF_CONTAINER_VM_AGENT_PORT' | 'SANDBOX_VM_AGENT_PORT'>
): number {
  const configured = Number.parseInt(
    env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '',
    10
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CF_CONTAINER_VM_AGENT_PORT;
}
