/**
 * Test-only Durable Object that stands in for VmAgentContainer under the
 * Miniflare workers pool.
 *
 * WHY A DOUBLE (constructor investigation): the real VmAgentContainer extends
 * `Container` from `@cloudflare/containers`, whose constructor throws when
 * `ctx.container === undefined`:
 *
 *   // @cloudflare/containers dist/lib/container.js (constructor)
 *   if (ctx.container === undefined) {
 *     throw new Error('Containers have not been enabled for this Durable Object
 *     class. Have you correctly setup your Wrangler config? ...');
 *   }
 *
 * Under `@cloudflare/vitest-pool-workers` there is no container service attached
 * to the DO, so `ctx.container` is always `undefined` and constructing the real
 * class throws on instantiation. The Container base additionally creates SQLite
 * schedule tables, schedules alarms, and wires a container monitor — none of
 * which can run in workerd-without-containers. Binding the real class is
 * therefore infeasible.
 *
 * This double mocks ONLY that container shell. It is a plain Durable Object
 * that stores the same `lifecycleStatus` key the real container persists, and
 * its `inspectLifecycle()` RPC calls the REAL shared read helper
 * (`inspectStoredVmAgentContainerLifecycle`) over its own `ctx.storage`. The
 * production heartbeat policy (`shouldDeferRuntimeHeartbeatTimeout`), the RPC
 * shape (`VmAgentContainerLifecycleInspection`), and the terminal classifier
 * (`isVmAgentContainerLifecycleTerminal`) all run on the real code path — only
 * the container runtime itself is replaced.
 */
import { DurableObject } from 'cloudflare:workers';

import { ACTIVE_WORK_KEY } from '../../../src/durable-objects/vm-agent-container-active-work';
import {
  inspectStoredVmAgentContainerLifecycle,
  type VmAgentContainerLifecycleInspection,
  type VmAgentContainerLifecycleStatus,
} from '../../../src/durable-objects/vm-agent-container-lifecycle';
import type { Env } from '../../../src/env';

// These keys MUST match VmAgentContainer's private storage keys so the shared
// read helper observes the same state the production DO would. `lifecycleStatus`
// and RECOVERY_STATE_KEY (`'runtimeRecovery'`) are the container's private
// constants in vm-agent-container.ts; ACTIVE_WORK_KEY is imported from its
// source module to stay drift-safe.
const LIFECYCLE_STATUS_KEY = 'lifecycleStatus';
const RECOVERY_STATE_KEY = 'runtimeRecovery';

export class VmAgentContainerTestDouble extends DurableObject<Env> {
  private previewResponseHeaders(request: Request): Headers {
    const url = new URL(request.url);
    const headers = new Headers({
      'X-Preview-Observed-Authorization': request.headers.get('authorization') ?? '',
      'X-Preview-Observed-Cookie': request.headers.get('cookie') ?? '',
      'X-Preview-Observed-Path': url.pathname,
      'X-Preview-Observed-Channel': url.searchParams.get('channel') ?? '',
      'X-Preview-Client-Token-Leaked': String(url.searchParams.get('token') === 'client-sam-token'),
      'X-Preview-Port-Token-Leaked': String(url.searchParams.has('port_token')),
      'Clear-Site-Data': '"cache", "cookies"',
    });
    headers.append('Set-Cookie', 'sam_port_access=evil; Path=/');
    headers.append('Set-Cookie', 'preview_session=ordinary; Domain=.test.example.com; Path=/');
    return headers;
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    pair[1].accept();
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: this.previewResponseHeaders(request),
    });
  }

  async proxyHttp(request: Request, _port?: number): Promise<Response> {
    return new Response('preview', {
      headers: this.previewResponseHeaders(request),
    });
  }

  /**
   * Mirrors VmAgentContainer.inspectLifecycle() exactly: same shared read
   * helper, same storage keys. Keeps the real RPC contract on the code path.
   */
  async inspectLifecycle(): Promise<VmAgentContainerLifecycleInspection> {
    return inspectStoredVmAgentContainerLifecycle(
      this.ctx.storage,
      RECOVERY_STATE_KEY,
      ACTIVE_WORK_KEY
    );
  }

  /**
   * Test-only seeding RPC: writes the lifecycle status the real container would
   * have persisted (e.g. 'sleeping' after idle handback, 'stopped'/'error' after
   * termination) so the real classifier decides the outcome.
   */
  async __seedLifecycle(status: VmAgentContainerLifecycleStatus): Promise<void> {
    await this.ctx.storage.put(LIFECYCLE_STATUS_KEY, status);
  }

  /**
   * Production cleanup calls VmAgentContainer.destroyForUser() after a stuck
   * cf-container task is failed. The workers tests only need the RPC contract
   * and persisted terminal lifecycle; no real container runtime exists here.
   */
  async destroyForUser(_userId: string): Promise<void> {
    await this.ctx.storage.put(LIFECYCLE_STATUS_KEY, 'stopped');
  }
}
