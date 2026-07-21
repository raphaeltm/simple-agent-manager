/**
 * Production-incident regression: Instant (cf-container) lifecycle wiring across
 * BOTH control loops that can terminate a task/session.
 *
 * A single seeded cf-container node/workspace/task/ACP-session row set is driven
 * through the two real reconcilers against the SAME state:
 *   1. ProjectData.alarm() stale-heartbeat pass  (heartbeat-timeout policy)
 *   2. recoverStuckTasks() sweep                  (stuck-task liveness gate)
 *
 * With the container asleep ('sleeping', a resumable state) BOTH loops must
 * preserve the work: the ACP session stays running, the task stays in_progress,
 * and the workspace row survives. Once the container is terminated ('stopped'),
 * the sweep MUST reconcile the now-dead runtime and fail the task.
 *
 * This exercises the REAL heartbeat policy (shouldDeferRuntimeHeartbeatTimeout),
 * the REAL container-lifecycle classifier, and the REAL sweep — with only the
 * container shell replaced by VmAgentContainerTestDouble (bound as
 * VM_AGENT_CONTAINER; see tests/workers/support/). Before this wiring the policy
 * short-circuited with 'cf_container_lifecycle_binding_unavailable' and the
 * classifier never ran.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { shouldDeferRuntimeHeartbeatTimeout } from '../../src/durable-objects/project-data/runtime-heartbeat-policy';
import type { VmAgentContainerLifecycleStatus } from '../../src/durable-objects/vm-agent-container-lifecycle';
import type { Env } from '../../src/env';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { VmAgentContainerTestDouble } from './support/vm-agent-container-double';

function getProjectStub(projectId: string): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId),
  ) as DurableObjectStub<ProjectData>;
}

function seedContainerLifecycle(
  nodeId: string,
  status: VmAgentContainerLifecycleStatus,
): Promise<void> {
  const ns = env.VM_AGENT_CONTAINER!;
  const stub = ns.get(
    ns.idFromName(nodeId.toLowerCase()),
  ) as unknown as DurableObjectStub<VmAgentContainerTestDouble>;
  return stub.__seedLifecycle(status);
}

async function getTask(taskId: string) {
  return env.DATABASE.prepare('SELECT status, error_message FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ status: string; error_message: string | null }>();
}

describe('Instant container lifecycle wiring — alarm + sweep', () => {
  it('preserves a sleeping cf-container task+session across both loops, then reconciles once stopped', async () => {
    const prefix = `instant-wiring-${Date.now()}-${crypto.randomUUID()}`;
    const userId = `${prefix}-user`;
    const installationId = `${prefix}-install`;
    const projectId = `${prefix}-project`;
    const nodeId = `${prefix}-node`;
    const workspaceId = `${prefix}-workspace`;
    const taskId = `${prefix}-task`;
    const cursorKey = `test:stuck-task-cursor:${prefix}`;
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // --- Seed a single cf-container row set across D1 + ProjectData DO ---
    await seedUser(userId);
    await seedInstallation(installationId, userId, { installationIdValue: `${prefix}-ext` });
    await seedProject(projectId, userId, installationId);
    await seedNode(nodeId, userId, { status: 'running' });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(nodeId)
      .run();

    const stub = getProjectStub(projectId);
    const chatSessionId = await stub.createSession(null, 'Instant wiring');
    const acpSession = await stub.createAcpSession({
      chatSessionId,
      initialPrompt: 'Do the thing',
      agentType: 'codex',
    });

    // Workspace 'running' so BOTH the policy (non-terminal) and the sweep
    // (LIVE_WORKSPACE_STATUSES) reach the container-lifecycle probe.
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'running',
      chatSessionId,
    });
    await seedTask(taskId, projectId, userId, {
      status: 'in_progress',
      workspaceId,
      startedAt: oldIso,
      updatedAt: oldIso,
      taskMode: 'task',
    });

    await stub.transitionAcpSession(acpSession.id, 'assigned', {
      actorType: 'system',
      workspaceId,
      nodeId,
    });
    await stub.transitionAcpSession(acpSession.id, 'running', {
      actorType: 'vm-agent',
      actorId: nodeId,
      acpSdkSessionId: `${prefix}-sdk`,
    });

    // The sweep gates the container probe behind CF_CONTAINER_ENABLED and uses a
    // KV scan cursor; force a bounded, deterministic scan of this task.
    const sweepEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      TASK_DO_MISMATCH_GRACE_MS: '60000',
      TASK_RUN_MAX_EXECUTION_MS: '3600000',
      STUCK_TASK_SCAN_CURSOR_KV_KEY: cursorKey,
    } as unknown as Env;

    // ================= Phase 1: container sleeping (resumable) =================
    await seedContainerLifecycle(nodeId, 'sleeping');

    // Policy runs the REAL inspectLifecycle RPC + classifier — reason is
    // lifecycle-based, NOT the binding-unavailable short-circuit.
    expect(
      await shouldDeferRuntimeHeartbeatTimeout(env as unknown as Env, { workspaceId, nodeId }),
    ).toEqual({ defer: true, reason: 'cf_container_sleeping' });

    // Actor 1 — ProjectData alarm stale-heartbeat pass: session stays running.
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE acp_sessions SET last_heartbeat_at = ? WHERE id = ?`,
        Date.now() - 10 * 60 * 1000,
        acpSession.id,
      );
      await instance.alarm();
    });
    expect((await stub.getAcpSession(acpSession.id))?.status).toBe('running');

    // Actor 2 — stuck-task sweep: a resumable runtime is NOT reconciled.
    await env.KV.delete(cursorKey);
    const firstSweep = await recoverStuckTasks(sweepEnv);
    expect(firstSweep.deadRuntimeReconciled).toBe(0);
    expect((await getTask(taskId))?.status).toBe('in_progress');

    // Actor 3 — workspace row survives.
    const wsAfterSleep = await env.DATABASE.prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ status: string }>();
    expect(wsAfterSleep?.status).toBe('running');

    // ================= Phase 2: container stopped (terminal) =================
    await seedContainerLifecycle(nodeId, 'stopped');

    expect(
      await shouldDeferRuntimeHeartbeatTimeout(env as unknown as Env, { workspaceId, nodeId }),
    ).toEqual({ defer: false, reason: 'cf_container_stopped' });

    // The sweep now sees a conclusively-dead runtime and reconciles the task.
    await env.KV.delete(cursorKey);
    const secondSweep = await recoverStuckTasks(sweepEnv);
    expect(secondSweep.deadRuntimeReconciled).toBeGreaterThanOrEqual(1);

    const taskAfterStop = await getTask(taskId);
    expect(taskAfterStop?.status).toBe('failed');
    expect(taskAfterStop?.error_message).toContain('cf_container_stopped');
  });
});
