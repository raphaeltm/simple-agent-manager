import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { parseMs } from '../../scheduled/node-cleanup/config';
import { deleteNodeResourcesStrict } from '../../services/strict-node-deletion';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';
import { assertTaskExecutionAuthority } from './task-execution-authority';
import type { TaskRunnerContext, TaskRunnerState } from './types';

const DEFAULT_BOOT_MAX_REPLACEMENTS = 1;

/** Durable cleanup intent is retained across every I/O boundary; never warm a failed boot. */
export async function recoverNodeBoot(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  reason: string
): Promise<void> {
  const pending = state.bootRecovery;
  if (!pending) {
    const configured = Number(
      rc.env.TASK_RUNNER_BOOT_MAX_REPLACEMENTS ?? DEFAULT_BOOT_MAX_REPLACEMENTS
    );
    const limit =
      Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_BOOT_MAX_REPLACEMENTS;
    if (
      !state.stepResults.autoProvisioned ||
      !state.stepResults.nodeId ||
      state.stepResults.workspaceId ||
      state.stepResults.agentStarted ||
      !['node_agent_ready', 'node_provisioning'].includes(state.currentStep)
    ) {
      throw Object.assign(new Error(`Node boot recovery exhausted or unavailable: ${reason}`), {
        permanent: true,
      });
    }
    const replace = (state.bootReplacementCount ?? 0) < limit;
    if (replace) state.bootReplacementCount = (state.bootReplacementCount ?? 0) + 1;
    state.bootRecovery = { nodeId: state.stepResults.nodeId, reason, replace };
    state.stepResults.autoProvisioned = false;
    await rc.ctx.storage.put('state', state);
  }
  const intent = state.bootRecovery;
  if (!intent) throw new Error('Missing persisted boot recovery intent');
  await assertTaskExecutionAuthority(rc.env, state);
  // Quarantine atomically with the no-workspace and task-ownership guards. A
  // reused/occupied/BYO node is never eligible, even if local state is stale.
  if (!intent.terminated) {
    const warmClaimCutoff = new Date(
      Date.now() -
        parseMs(
          rc.env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? rc.env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
          DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
        )
    ).toISOString();
    const quarantined = await rc.env.DATABASE.prepare(
      `UPDATE nodes SET status = 'destroying', health_status = 'stale', updated_at = ?
     WHERE id = ? AND user_id = ? AND node_class = 'managed' AND runtime = 'vm'
       AND node_role = 'workspace'
       AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND auto_provisioned_node_id = nodes.id)
       AND NOT EXISTS (SELECT 1 FROM workspaces WHERE node_id = nodes.id)
       AND NOT EXISTS (SELECT 1 FROM tasks other WHERE other.auto_provisioned_node_id = nodes.id AND other.id != ?)
       ${boundedWarmPlacementClaimGuardSql('nodes.id')}
       AND status IN ('creating', 'running', 'error', 'stopped', 'destroying', 'deleted')`
    )
      .bind(
        new Date().toISOString(),
        intent.nodeId,
        state.userId,
        state.taskId,
        state.taskId,
        warmClaimCutoff
      )
      .run();
    if ((quarantined.meta.changes ?? 0) !== 1) {
      throw Object.assign(
        new Error(
          `Cannot safely replace boot-failed node ${intent.nodeId}: ownership or empty-node proof missing`
        ),
        { permanent: true }
      );
    }
    // This confirms external termination, including already-deleted provider VMs.
    // Failure leaves the intent and node pointer intact; no second VM is allocated.
    await deleteNodeResourcesStrict(intent.nodeId, state.userId, rc.env);
    intent.terminated = true;
    await rc.ctx.storage.put('state', state);
  }
  await rc.env.DATABASE.batch([
    rc.env.DATABASE.prepare(
      `UPDATE nodes SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'destroying' AND runtime_termination_confirmed_at IS NOT NULL`
    ).bind(new Date().toISOString(), intent.nodeId),
    rc.env.DATABASE.prepare(
      `UPDATE tasks SET auto_provisioned_node_id = NULL, provisioned_vm_size = NULL, updated_at = ? WHERE id = ? AND auto_provisioned_node_id = ?`
    ).bind(new Date().toISOString(), state.taskId, intent.nodeId),
  ]);
  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'node_boot_failed'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  state.stepResults.nodeId = null;
  state.stepResults.provisionedVmSize = null;
  state.stepResults.capacityPlacementSnapshot = null;
  state.provisioningStartedAt = null;
  state.agentReadyStartedAt = null;
  state.bootRecovery = null;
  log.warn('task_runner_do.node_boot_replacement', {
    taskId: state.taskId,
    nodeId: intent.nodeId,
    reason: intent.reason,
    replacement: state.bootReplacementCount,
  });
  if (!intent.replace) {
    state.bootRecovery = intent;
    await rc.ctx.storage.put('state', state);
    throw Object.assign(new Error(`Node boot recovery exhausted: ${intent.reason}`), {
      permanent: true,
    });
  }
  await rc.advanceToStep(state, 'node_provisioning');
}
