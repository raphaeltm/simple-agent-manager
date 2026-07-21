import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import {
  DEFAULT_CF_CONTAINER_SLEEP_AFTER,
  type VmAgentContainer,
  type VmAgentContainerLaunchConfig,
  type VmAgentContainerLaunchSecrets,
  type VmAgentContainerRecoveryResult,
} from '../durable-objects/vm-agent-container';
import type { VmAgentContainerLifecycleInspection } from '../durable-objects/vm-agent-container-lifecycle';
import type { Env } from '../env';
import { log } from '../lib/logger';
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
    vmAgentPort: Number.parseInt(
      env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '8080',
      10
    ),
    sleepAfter:
      env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || DEFAULT_CF_CONTAINER_SLEEP_AFTER,
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

export async function resumeVmAgentContainer(
  env: Env,
  nodeId: string,
  agentSessionId: string
): Promise<VmAgentContainerRecoveryResult> {
  const container = getVmAgentContainer(env, nodeId);
  return container.resumeRuntime(agentSessionId);
}

export async function inspectVmAgentContainerLifecycle(
  env: Env,
  nodeId: string
): Promise<VmAgentContainerLifecycleInspection> {
  return getVmAgentContainer(env, nodeId).inspectLifecycle();
}

export async function markVmAgentContainerRequestInterrupted(
  env: Env,
  nodeId: string,
  input: { method: string; errorName: string }
): Promise<VmAgentContainerRecoveryResult> {
  const container = getVmAgentContainer(env, nodeId);
  return container.markRequestInterrupted(input);
}

export async function destroyVmAgentContainer(env: Env, nodeId: string): Promise<void> {
  const container = getVmAgentContainer(env, nodeId);
  await container.destroyForUser();
}

export async function stopVmAgentContainer(env: Env, nodeId: string): Promise<void> {
  const container = getVmAgentContainer(env, nodeId);
  await container.stopForUser();
}

async function isCfContainerNode(env: Env, nodeId: string): Promise<boolean> {
  if (!env.DATABASE || typeof env.DATABASE.prepare !== 'function') {
    return false;
  }
  const db = drizzle(env.DATABASE, { schema });
  const node = await db
    .select({ runtime: schema.nodes.runtime })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .get();
  return node?.runtime === 'cf-container';
}

export async function markVmAgentContainerActiveWorkStarted(
  env: Env,
  nodeId: string,
  input: { workspaceId: string; agentSessionId: string; reason: string }
): Promise<void> {
  if (!(await isCfContainerNode(env, nodeId))) {
    return;
  }
  const container = getVmAgentContainer(env, nodeId);
  await container.markActiveWorkStarted(input);
}

export async function markVmAgentContainerActiveWorkEnded(
  env: Env,
  nodeId: string,
  reason: string
): Promise<void> {
  if (!(await isCfContainerNode(env, nodeId))) {
    return;
  }
  const container = getVmAgentContainer(env, nodeId);
  await container.markActiveWorkEnded(reason);
}

export async function markVmAgentContainerActiveWorkEndedBestEffort(
  env: Env,
  nodeId: string | null | undefined,
  reason: string
): Promise<void> {
  if (!nodeId) {
    return;
  }
  await markVmAgentContainerActiveWorkEnded(env, nodeId, reason).catch((err) => {
    log.warn('vm_agent_container_active_work_end_failed', {
      nodeId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
