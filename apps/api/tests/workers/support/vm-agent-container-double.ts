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
import {
  isSessionRecoverySourceTaskGuardValid,
  type SessionRecoverySourceTaskGuard,
} from '../../../src/services/session-recovery-authority';

// These keys MUST match VmAgentContainer's private storage keys so the shared
// read helper observes the same state the production DO would. `lifecycleStatus`
// and RECOVERY_STATE_KEY (`'runtimeRecovery'`) are the container's private
// constants in vm-agent-container.ts; ACTIVE_WORK_KEY is imported from its
// source module to stay drift-safe.
const LIFECYCLE_STATUS_KEY = 'lifecycleStatus';
const RECOVERY_STATE_KEY = 'runtimeRecovery';

export class VmAgentContainerTestDouble extends DurableObject<Env> {
  /**
   * Container-less vertical slice for the production guard's D1 check and DO
   * preparation boundary. The real Container base cannot run in Miniflare,
   * but this method deliberately uses the production SQL helper before
   * recording that request preparation was reached.
   */
  async __guardedPrepare(sourceTaskGuard: SessionRecoverySourceTaskGuard): Promise<{
    authorized: boolean;
    prepared: boolean;
  }> {
    const authorized = await isSessionRecoverySourceTaskGuardValid(
      this.env.DATABASE,
      sourceTaskGuard
    );
    if (!authorized) return { authorized: false, prepared: false };
    await this.ctx.storage.put('guardedPrepareReached', true);
    return { authorized: true, prepared: true };
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
