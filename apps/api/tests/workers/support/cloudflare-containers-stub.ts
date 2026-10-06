/**
 * Test-only replacement for @cloudflare/containers in vitest-pool-workers.
 *
 * The real package expects Cloudflare's Containers runtime to be attached to
 * Durable Object state. API Worker/DO tests bind VM_AGENT_CONTAINER to
 * VmAgentContainerTestDouble and do not exercise Sandbox/Containers runtime
 * behavior, but src/index.ts still imports modules that load this package during
 * worker module evaluation. This stub preserves import shapes without enabling
 * container behavior in Miniflare.
 */
import { DurableObject } from 'cloudflare:workers';

export class Container<Env = unknown> extends DurableObject<Env> {}

export class ContainerProxy {
  constructor(..._args: unknown[]) {}
}

export function getContainer(..._args: unknown[]): ContainerProxy {
  return new ContainerProxy();
}

export function switchPort(port: number): number {
  return port;
}
