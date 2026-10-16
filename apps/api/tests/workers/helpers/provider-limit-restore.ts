/** Real Workers restoration fixture; only external VM HTTP is doubled. */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { expect, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { resolveDurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import {
  claimDuePromptDeliveries,
  type PromptDeliveryResult,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery-runner';
import type { TaskRunner } from '../../../src/durable-objects/task-runner';
import type { Env } from '../../../src/env';
import { getSelectedAgentCredentialReference } from '../../../src/routes/credentials';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../../src/services/capacity-placement-snapshot';
import { encrypt } from '../../../src/services/encryption';
import { signCallbackToken } from '../../../src/services/jwt';
import { resolveTaskStartPlacementCredentialAttribution } from '../../../src/services/placement-resolver';
import { resolveSessionRuntimeContract } from '../../../src/services/session-runtime-contract';
import { DefaultVmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { projectStub, sqlRows, testEnv } from './agent-message-channels';
import { pauseAlarms, pauseNodeAlarms, type StateWriteHook } from './durable-alarm-control';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './seed-d1';
const config = resolveDurableExecutionConfig({});
export function taskRunner(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

type TaskMode = 'task' | 'conversation';
export type Fixture = Awaited<ReturnType<typeof agentOnVm>>;

/** One task agent running on a VM node, its chat, and the snapshot its runtime keeps saving. */
export async function agentOnVm(taskMode: TaskMode, agentType = 'claude-code') {
  const id = crypto.randomUUID();
  const userId = `user-${id}`;
  const projectId = `p-${id}`;
  const nodeId = `n-${id}`;
  const workspaceId = `w-${id}`;
  const taskId = `t-${id}`;
  await seedUser(userId);
  await env.DATABASE.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(userId).run();
  await seedInstallation(id, userId, { installationIdValue: id, accountName: userId });
  await seedProject(projectId, userId, id);
  await seedNode(nodeId, userId);
  await pauseNodeAlarms(nodeId);
  const stub = projectStub(projectId);
  await stub.ensureProjectId(projectId);
  await runInDurableObject(stub, async (_instance, state) => {
    pauseAlarms(state.storage);
    await state.storage.deleteAlarm();
  });

  const chatSessionId = await stub.createSession(workspaceId, 'Task', taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    chatSessionId,
    status: 'in_progress',
    executionStep: 'running',
    taskMode,
  });
  await seedAgentSession(`a-${id}`, workspaceId, userId, { agentType });

  const profileId = `profile-${id}`;
  await env.DATABASE.prepare(
    `INSERT INTO agent_profiles(id,user_id,project_id,name,agent_type,model,runtime,task_mode) VALUES (?,?,?,'Retained fixture profile',?,'preserved-test-model','vm','task')`
  )
    .bind(profileId, userId, projectId, agentType)
    .run();
  await env.DATABASE.batch([
    env.DATABASE.prepare('UPDATE tasks SET agent_profile_hint=? WHERE id=?').bind(
      profileId,
      taskId
    ),
    env.DATABASE.prepare('UPDATE workspaces SET agent_profile_hint=? WHERE id=?').bind(
      profileId,
      workspaceId
    ),
    env.DATABASE.prepare('UPDATE agent_sessions SET agent_profile_id=? WHERE id=?').bind(
      profileId,
      `a-${id}`
    ),
  ]);
  // The wake's placement resolves through the user's own cloud credential.
  const { ciphertext, iv } = await encrypt('hetzner-token-eviction', env.ENCRYPTION_KEY);
  const now = new Date().toISOString();
  const agentKey = await encrypt('test-only-agent-token', env.ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT INTO credentials
    (id,user_id,provider,credential_type,agent_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at)
    VALUES (?,?,'agent','agent-api-key',?,'oauth-token',1,?,?,?,?)`
  )
    .bind(`agent-cred-${id}`, userId, agentType, agentKey.ciphertext, agentKey.iv, now, now)
    .run();
  const token = await signCallbackToken(workspaceId, testEnv);
  const injected = await SELF.fetch(
    `https://api.test.example.com/api/workspaces/${workspaceId}/agent-key`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType, agentSessionId: `a-${id}` }),
    }
  );
  expect(injected.status, await injected.clone().text()).toBe(200);
  const credentialReference = await getSelectedAgentCredentialReference(
    drizzle(env.DATABASE, { schema }),
    userId,
    agentType,
    env.ENCRYPTION_KEY,
    projectId
  );
  expect(credentialReference).not.toBeNull();
  await env.DATABASE.prepare(
    `UPDATE agent_sessions SET agent_credential_reference=?, agent_credential_generation=1,agent_credential_source='user',agent_credential_provider='agent',agent_provider_mode='direct' WHERE id=?`
  )
    .bind(credentialReference, `a-${id}`)
    .run();
  await stub.createAcpSession({
    chatSessionId,
    initialPrompt: null,
    agentType,
    id: `a-${id}`,
  });
  await stub.transitionAcpSession(`a-${id}`, 'assigned', {
    actorType: 'system',
    workspaceId,
    nodeId,
  });
  await stub.transitionAcpSession(`a-${id}`, 'running', { actorType: 'vm-agent', actorId: nodeId });
  await stub.reportActivity(`a-${id}`, 'idle', {
    runtimeWorkState: 'inactive',
    runtimeWorkCount: 0,
    runtimeWorkSource: 'test-provider-peer',
  });
  const contract = await resolveSessionRuntimeContract(drizzle(env.DATABASE, { schema }), testEnv, {
    userId,
    projectId,
    agentType,
    overrides: { model: 'preserved-test-model' },
    promptKind: 'task',
    taskContext: { taskId, taskMode },
  });
  await env.DATABASE.prepare('UPDATE agent_sessions SET runtime_contract_json=? WHERE id=?')
    .bind(JSON.stringify(contract), `a-${id}`)
    .run();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
    ).bind(`cred-${id}`, userId, ciphertext, iv, now, now),
    env.DATABASE.prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
          degradation, manifest_r2_key, runtime_contract_json, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'vm', 'available', 'none', 'manifest', ?,
               '2099-01-01T00:00:00Z', ?, ?)`
    ).bind(
      `snapshot-${id}`,
      projectId,
      workspaceId,
      nodeId,
      userId,
      chatSessionId,
      JSON.stringify(contract),
      now,
      now
    ),
  ]);
  const runnerWrites: StateWriteHook = { before: async () => undefined };
  await runInDurableObject(taskRunner(taskId), (instance) => {
    pauseAlarms(instance.ctx.storage, runnerWrites);
  });
  return {
    id,
    userId,
    projectId,
    nodeId,
    workspaceId,
    taskId,
    chatSessionId,
    stub,
    runnerWrites,
    credentialReference,
    agentType,
    contract,
    profileId,
  };
}

/** Claim one due prompt delivery and run it through the real delivery runner. */
export async function runDueDelivery(
  f: Fixture,
  now = Date.now()
): Promise<PromptDeliveryResult | null> {
  return runInDurableObject(f.stub, async (instance, state) => {
    const [claim] = claimDuePromptDeliveries(state.storage.sql, config, now);
    if (!claim) return null;
    // Bindings must come from the object's own context, as in its production alarm.
    const objectEnv = (instance as unknown as { env: Env }).env;
    return runPromptDeliveryClaim(
      state.storage.sql,
      objectEnv,
      config,
      claim,
      new DefaultVmPromptDeliveryAdapter(objectEnv),
      {
        projectId: f.projectId,
        recalculateAlarm: async () => undefined,
        broadcastEvent: () => undefined,
        armIdleCleanup: () => undefined,
        nudgeDeliveries: () => 0,
        scheduleSummarySync: () => undefined,
      }
    );
  });
}
export async function taskRow(taskId: string) {
  return env.DATABASE.prepare('SELECT status, execution_step FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ status: string; execution_step: string | null }>();
}

export async function waitForWakeReadiness(f: Fixture): Promise<void> {
  await vi.waitFor(
    async () => {
      const ready = await sqlRows(
        f.stub,
        'SELECT session_id FROM session_wake_readiness WHERE session_id = ?',
        f.chatSessionId
      );
      expect(ready).toHaveLength(1);
    },
    { timeout: 5_000 }
  );
}

export async function agentSessionOf(workspaceId: string): Promise<string> {
  const row = await env.DATABASE.prepare('SELECT id FROM agent_sessions WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ id: string }>();
  return row!.id;
}

export async function readyReplacementNode(f: Fixture) {
  const nodeId = `replacement-${f.id}`;
  const db = drizzle(env.DATABASE, { schema });
  const project = (await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, f.projectId))
    .get())!;
  const resolution = await resolveTaskStartPlacementCredentialAttribution(
    db,
    {
      entryPoint: 'trigger-submit',
      taskId: f.taskId,
      projectId: f.projectId,
      userId: f.userId,
      project,
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'workspace-profile',
      explicit: { vmSize: 'medium', vmLocation: 'fsn1' },
    },
    { env: testEnv }
  );
  if ('error' in resolution) throw new Error(resolution.error);
  const snapshot = resolution.capacityPlacementSnapshot!;
  const now = new Date().toISOString();
  await seedNode(nodeId, f.userId, { vmSize: 'medium', vmLocation: 'fsn1', lastHeartbeatAt: now });
  await pauseNodeAlarms(nodeId);
  await env.DATABASE.prepare(
    `UPDATE nodes SET agent_ready_at = ?, agent_version = ?, runtime = 'vm',
    node_role = 'workspace', cloud_provider = 'hetzner', provider_instance_id = ?, observed_hardware_source = 'observed',
    observed_provider_instance_vcpu_count = ?, observed_provider_instance_memory_mb = ?, observed_provider_instance_disk_gb = ?,
    ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS}, last_metrics = ? WHERE id = ?`
  )
    .bind(
      now,
      testEnv.VM_AGENT_REQUIRED_VERSION ?? '0123456789abcdef0123456789abcdef01234567',
      `provider-${nodeId}`,
      snapshot.providerInstanceVcpuCount,
      snapshot.providerInstanceMemoryMb,
      snapshot.providerInstanceDiskGb,
      ...capacityPlacementSnapshotSqlValues(snapshot),
      JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
      nodeId
    )
    .run();
  return nodeId;
}

export async function driveMove(f: Fixture) {
  for (let step = 0; step < 25; step++) {
    expect((await f.stub.getSession(f.chatSessionId))?.status).not.toBe('stopped');
    const status = await taskRunner(f.taskId).getStatus();
    if (status?.completed || (await taskRow(f.taskId))?.status === 'in_progress') return;
    await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
  }
  throw new Error('Move did not converge within 25 TaskRunner alarms');
}

/** Advance the real deletion queue to its own due timestamp and drain its external work. */
export async function deleteSleptWorkspace(nodeId: string, taskId: string): Promise<void> {
  const row = await env.DATABASE.prepare('SELECT workspace_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ workspace_id: string }>();
  const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(nodeId));
  await runInDurableObject(stub, async (instance, ctx) => {
    const entry = await ctx.storage.get<{ deleteAt: number }>(`ws-delete:${row!.workspace_id}`);
    expect(entry).toBeDefined();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(entry!.deleteAt + 1);
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.spyOn(ctx, 'waitUntil').mockImplementation((promise) => {
      pending.push(promise);
    });
    try {
      await instance.alarm();
      await Promise.all(pending);
    } finally {
      waitUntil.mockRestore();
      clock.mockRestore();
    }
  });
}
