/**
 * Regression for idea 01M4E2Q4P9CFTW5RWAKHGEP0VC (item 5 of 01M4JVVG3K1BP55ANVKMGFHTHW).
 *
 * An OOM eviction kills a task-mode agent mid-work with nothing queued. Recovery restores the
 * saved harness session (LoadSession), and a restored session never receives the fresh-start
 * prompt, so the agent used to idle silently. Each case enters through the production trigger
 * (the eviction callback route, or a queued follow-up for the control that needs one), then runs
 * the real recovery, the real TaskRunner `agent_session` alarm and the real ProjectData delivery
 * runner. Only the VM agent is a fetch double; provisioning (node selection to workspace ready)
 * is fast-forwarded in the isolated prompt controls. The stitched workspace-linking cases below
 * instead drive snapshot completion, node selection, provisioning/readiness and TaskRunner linking.
 */
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  claimDuePromptDeliveries,
  type PromptDeliveryResult,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../src/durable-objects/project-data/prompt-delivery-runner';
import type { TaskRunner, TaskRunnerState } from '../../src/durable-objects/task-runner';
import { ensureSessionLinked } from '../../src/durable-objects/task-runner/session-linking';
import type { TaskRunnerContext } from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../src/services/capacity-placement-snapshot';
import { encrypt } from '../../src/services/encryption';
import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { resolveTaskStartPlacementCredentialAttribution } from '../../src/services/placement-resolver';
import { restoredSessionPromptDeliveryId } from '../../src/services/restored-session-prompt';
import { resolveSessionRuntimeContract } from '../../src/services/session-runtime-contract';
import {
  SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from '../../src/services/session-sleep-fallback-messages';
import { buildSessionSnapshotR2Key } from '../../src/services/session-snapshots';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { projectStub, sqlRows, testEnv } from './helpers/agent-message-channels';
import { pauseAlarms, pauseNodeAlarms, type StateWriteHook } from './helpers/durable-alarm-control';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const config = resolveDurableExecutionConfig({});
/** Captured before any test replaces it, so a second VM double cannot call into the first. */
const passthroughFetch = globalThis.fetch.bind(globalThis);
const RUNTIME_IDENTITY = 'replacement-runtime';
const EVICTION_GENERATION = 'generation-1';

afterEach(() => {
  // The test owns alarm delivery for each fixture's whole lifetime. Restoring
  // those spies here lets a late readiness signal arm a real alarm after its VM
  // double was removed, leaking requests into the following test.
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockRestore();
});

/**
 * Code inside a Durable Object must not resume test code, or the test's next stub call runs in
 * that object's I/O context. Each side therefore polls a plain flag on its own timers.
 */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the held TaskRunner step');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function taskRunner(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

/** Advance the real deletion queue to its own due timestamp and drain its external work. */
async function deleteFailedReplacement(nodeId: string, taskId: string): Promise<void> {
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

type TaskMode = 'task' | 'conversation';
type Fixture = Awaited<ReturnType<typeof agentOnVm>>;

/** One task agent running on a VM node, its chat, and the snapshot its runtime keeps saving. */
async function agentOnVm(taskMode: TaskMode) {
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
  const chatSessionId = await stub.createSession(workspaceId, 'Task', taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    chatSessionId,
    status: 'in_progress',
    executionStep: 'running',
    taskMode,
  });
  await seedAgentSession(`a-${id}`, workspaceId, userId, { agentType: 'claude-code' });

  // The wake's placement resolves through the user's own cloud credential.
  const { ciphertext, iv } = await encrypt('hetzner-token-eviction', env.ENCRYPTION_KEY);
  const now = new Date().toISOString();
  const contract = await resolveSessionRuntimeContract(drizzle(env.DATABASE, { schema }), testEnv, {
    userId,
    projectId,
    agentType: 'claude-code',
    promptKind: 'task',
    taskContext: { taskId, taskMode },
  });
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
    ).bind(`cred-${id}`, userId, ciphertext, iv, now, now),
    env.DATABASE.prepare('UPDATE workspaces SET eviction_generation = ? WHERE id = ?').bind(
      EVICTION_GENERATION,
      workspaceId
    ),
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
  await runInDurableObject(stub, async (_instance, state) => {
    pauseAlarms(state.storage);
    await state.storage.deleteAlarm();
  });
  const runnerWrites: StateWriteHook = { before: async () => undefined };
  await runInDurableObject(taskRunner(taskId), (instance) => {
    pauseAlarms(instance.ctx.storage, runnerWrites);
  });
  return { id, userId, projectId, nodeId, workspaceId, taskId, chatSessionId, stub, runnerWrites };
}

/** The VM agent's OOM eviction callback, through the real route and callback auth. */
async function evict(f: Fixture, interruptedWork?: boolean): Promise<void> {
  const token = await signNodeCallbackToken(f.nodeId, testEnv);
  const response = await SELF.fetch(
    `https://api.test.example.com/api/projects/${f.projectId}/workspaces/${f.workspaceId}/eviction`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: f.nodeId,
        workspaceId: f.workspaceId,
        reason: 'oom_kill',
        snapshotCaptured: true,
        interruptedWork,
        containerStopped: true,
        evictionGeneration: EVICTION_GENERATION,
      }),
    }
  );
  expect(response.status, await response.text()).toBe(204);
}

/** One pass of the production delivery claim runner for whatever is due at `now`. */
async function runDueDelivery(f: Fixture, now = Date.now()): Promise<PromptDeliveryResult | null> {
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

/**
 * Write what node selection through workspace_ready leave behind for this wake: a running
 * replacement workspace on another node bound to the chat, the task delegated to it, the
 * snapshot's recovery workspace, and the runner parked at `agent_session`.
 */
async function provisionReplacementWorkspace(f: Fixture, generation = 2) {
  const nodeId = `n${generation}-${f.id}`;
  const workspaceId = `w${generation}-${f.id}`;
  await seedNode(nodeId, f.userId);
  await pauseNodeAlarms(nodeId);
  await seedWorkspace(workspaceId, nodeId, f.userId, {
    projectId: f.projectId,
    chatSessionId: f.chatSessionId,
  });
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE tasks SET status = 'delegated', workspace_id = ?, execution_step = 'workspace_ready'
        WHERE id = ?`
    ).bind(workspaceId, f.taskId),
    env.DATABASE.prepare(
      'UPDATE session_snapshots SET recovery_workspace_id = ? WHERE chat_session_id = ?'
    ).bind(workspaceId, f.chatSessionId),
  ]);
  await runInDurableObject(taskRunner(f.taskId), async (instance) => {
    const state = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
    state.currentStep = 'agent_session';
    state.stepResults.nodeId = nodeId;
    state.stepResults.workspaceId = workspaceId;
    state.workspaceReadyReceived = true;
    state.workspaceReadyStatus = 'running';
    await instance.ctx.storage.put('state', state);
  });
  return { nodeId, workspaceId };
}

type NodeCall = { path: string; body: Record<string, unknown> | null };

/** VM agent double for the replacement workspace; the restore reports `restoreStatus`. */
function installReplacementVm(nodeId: string, workspaceId: string, restoreStatus: string) {
  const calls: NodeCall[] = [];
  const base = getNodeBackendBaseUrl(nodeId, testEnv);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthroughFetch(input, init);
    const url = new URL(request.url);
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, body });
    // One capabilities document serves the restore pre-check and prompt delivery.
    if (url.pathname === buildVmPromptDeliveryCapabilitiesPath(workspaceId)) {
      return Response.json({
        ...versionedPromptCapabilities(RUNTIME_IDENTITY),
        sessionRuntimeContract: { supported: true, version: 1 },
      });
    }
    if (/\/agent-sessions\/[^/]+\/restore$/.test(url.pathname)) {
      return Response.json({ status: restoreStatus });
    }
    const prompt = /\/agent-sessions\/([^/]+)\/prompt$/.exec(url.pathname);
    if (prompt) {
      return Response.json(
        acceptedPromptResponse(prompt[1]!, String(body?.deliveryId), RUNTIME_IDENTITY, Date.now())
      );
    }
    return Response.json({ ok: true });
  });
  return {
    starts: () => calls.filter((call) => /\/agent-sessions\/[^/]+\/start$/.test(call.path)),
    prompts: () => calls.filter((call) => /\/agent-sessions\/[^/]+\/prompt$/.test(call.path)),
  };
}

/**
 * Hold the runner's first write of `agentStarted`: by then the restored session's prompt is
 * queued, and the handoff (`transitionToInProgress`) has not committed.
 */
function holdAgentStartedWrite(f: Fixture) {
  const hold = { reached: false, released: false };
  f.runnerWrites.before = async (state) => {
    if (state.currentStep !== 'agent_session' || !state.stepResults.agentStarted) return;
    if (hold.released) return;
    hold.reached = true;
    await until(() => hold.released);
  };
  return {
    reached: () => until(() => hold.reached),
    release: () => {
      hold.released = true;
    },
  };
}

async function taskRow(taskId: string) {
  return env.DATABASE.prepare('SELECT status, execution_step FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ status: string; execution_step: string | null }>();
}

async function runnerConfig(taskId: string) {
  return (await taskRunner(taskId).getStatus())?.config;
}

async function continuationRows(f: Fixture) {
  return sqlRows<{ id: string; delivery_state: string; content: string; source_task_id: string }>(
    f.stub,
    `SELECT id, delivery_state, content, source_task_id FROM session_inbox
      WHERE target_session_id = ? AND source_kind = 'checkpoint_continuation'`,
    f.chatSessionId
  );
}

async function waitForWakeReadiness(f: Fixture): Promise<void> {
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

async function agentSessionOf(workspaceId: string): Promise<string> {
  const row = await env.DATABASE.prepare('SELECT id FROM agent_sessions WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ id: string }>();
  return row!.id;
}

describe('an agent recovered after an eviction', () => {
  it.each(['task', 'conversation'] as const)(
    'delivers the interrupted %s continuation exactly once after restore',
    async (mode) => {
      const f = await agentOnVm(mode);
      await evict(f, true);
      expect(await taskRow(f.taskId)).toMatchObject({ status: 'queued' });
      expect(await runnerConfig(f.taskId)).toMatchObject({
        taskDescription: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
        restoredSessionPrompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
        resumeSnapshotChatSessionId: f.chatSessionId,
      });

      const replacement = await provisionReplacementWorkspace(f);
      const vm = installReplacementVm(replacement.nodeId, replacement.workspaceId, 'restored');
      const hold = holdAgentStartedWrite(f);
      const alarm = runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
      await hold.reached();

      // The midpoint: the prompt is queued for the restored session, the handoff is not committed.
      const agentSessionId = await agentSessionOf(replacement.workspaceId);
      expect(await continuationRows(f)).toEqual([
        {
          id: restoredSessionPromptDeliveryId(agentSessionId),
          delivery_state: 'queued',
          content: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
          source_task_id: f.taskId,
        },
      ]);
      expect(await taskRow(f.taskId)).toMatchObject({ status: 'delegated' });
      // Queued after the wake re-pointed the chat: the prompt's message activity belongs to the
      // replacement, and no idle tracking was re-created for the evicted workspace.
      expect(
        await sqlRows(
          f.stub,
          'SELECT workspace_id FROM workspace_activity WHERE session_id = ?',
          f.chatSessionId
        )
      ).toEqual([{ workspace_id: replacement.workspaceId }]);
      const midpoint = await runDueDelivery(f);
      expect(midpoint).toMatchObject({
        kind: 'retry',
        reason: 'not_ready',
        error: expect.stringContaining('agent handoff not committed'),
      });
      expect(vm.prompts()).toEqual([]);

      hold.release();
      await alarm;
      expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
      await waitForWakeReadiness(f);
      expect(await runDueDelivery(f)).toMatchObject({ kind: 'accepted' });

      expect(vm.starts()).toEqual([]);
      expect(vm.prompts()).toEqual([
        expect.objectContaining({
          path: expect.stringContaining(`/agent-sessions/${agentSessionId}/prompt`),
          body: expect.objectContaining({
            prompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
            deliveryId: restoredSessionPromptDeliveryId(agentSessionId),
          }),
        }),
      ]);
      expect(await continuationRows(f)).toEqual([
        expect.objectContaining({ delivery_state: 'acked' }),
      ]);
      // Nothing else is due: the prompt went out once.
      expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toBeNull();
    }
  );

  it.each(['task', 'conversation'] as const)(
    'continues interrupted %s work when restore starts fresh',
    async (mode) => {
      const f = await agentOnVm(mode);
      await evict(f, true);
      const replacement = await provisionReplacementWorkspace(f);
      const vm = installReplacementVm(replacement.nodeId, replacement.workspaceId, 'degraded');

      await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
      expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
      await waitForWakeReadiness(f);

      expect(vm.starts()).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ initialPrompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT }),
        }),
      ]);
      expect(await continuationRows(f)).toEqual([]);
      expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toBeNull();
      expect(vm.prompts()).toEqual([]);
    }
  );

  it.each(['task', 'conversation'] as const)(
    'leaves an idle %s agent waiting after restore',
    async (mode) => {
      const f = await agentOnVm(mode);
      await evict(f, false);
      expect(await runnerConfig(f.taskId)).toMatchObject({
        taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
        restoredSessionPrompt: null,
      });
      const replacement = await provisionReplacementWorkspace(f);
      const vm = installReplacementVm(replacement.nodeId, replacement.workspaceId, 'restored');

      await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
      expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
      await waitForWakeReadiness(f);

      // Liveness: the wake did complete and resumed the saved session.
      expect(
        await sqlRows(f.stub, 'SELECT status FROM chat_sessions WHERE id = ?', f.chatSessionId)
      ).toEqual([{ status: 'active' }]);
      expect(await continuationRows(f)).toEqual([]);
      expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toBeNull();
      expect(vm.starts()).toEqual([]);
      expect(vm.prompts()).toEqual([]);
    }
  );
});

describe('a continuation that outlives its wake', () => {
  /** Evict, restore and stop the wake after it queued the continuation, before the commit. */
  async function evictToHeldHandoff(f: Fixture) {
    await evict(f);
    const replacement = await provisionReplacementWorkspace(f);
    const vm = installReplacementVm(replacement.nodeId, replacement.workspaceId, 'restored');
    const hold = holdAgentStartedWrite(f);
    const alarm = runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
    await hold.reached();
    const agentSessionId = await agentSessionOf(replacement.workspaceId);
    expect(await continuationRows(f)).toEqual([
      expect.objectContaining({
        id: restoredSessionPromptDeliveryId(agentSessionId),
        delivery_state: 'queued',
      }),
    ]);
    return { replacement, vm, hold, alarm, agentSessionId };
  }

  async function wakeFailures(f: Fixture) {
    return sqlRows(
      f.stub,
      "SELECT id FROM session_attention_markers WHERE session_id = ? AND kind = 'wake_failed'",
      f.chatSessionId
    );
  }

  it('is dropped without waking the chat when the user cancels the task mid-handoff', async () => {
    const f = await agentOnVm('task');
    const wake = await evictToHeldHandoff(f);
    await env.DATABASE.prepare(
      "UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), f.taskId)
      .run();

    wake.hold.release();
    await wake.alarm;
    expect(await taskRow(f.taskId)).toMatchObject({ status: 'cancelled' });

    expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Checkpoint continuation task is no longer live for this chat',
    });
    expect(await continuationRows(f)).toEqual([
      expect.objectContaining({ delivery_state: 'failed' }),
    ]);
    expect(wake.vm.prompts()).toEqual([]);
    expect(await wakeFailures(f)).toEqual([]);
    expect(await taskRow(f.taskId)).toMatchObject({ status: 'cancelled' });
  });

  it('is dropped when the eviction fence refuses the handoff after it was queued', async () => {
    const f = await agentOnVm('task');
    const wake = await evictToHeldHandoff(f);
    // An explicit Restart of the evicted workspace moves its generation on before the handoff
    // commits. Recovery has already completed the snapshot claim, so the eviction fence
    // (`assertRecoveryAuthority`) fails the task rather than putting the chat back to sleep.
    await env.DATABASE.prepare('UPDATE workspaces SET eviction_generation = ? WHERE id = ?')
      .bind('generation-2', f.workspaceId)
      .run();

    wake.hold.release();
    await wake.alarm;
    expect(await taskRow(f.taskId)).toMatchObject({ status: 'failed' });

    expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
    });
    expect(await continuationRows(f)).toEqual([
      expect.objectContaining({ delivery_state: 'failed' }),
    ]);
    expect(wake.vm.prompts()).toEqual([]);
    expect(await wakeFailures(f)).toEqual([]);
    expect(await taskRow(f.taskId)).toMatchObject({ status: 'failed' });
  });
});

describe('a restored task woken by a queued message', () => {
  it('gets the queued message and no extra prompt', async () => {
    const f = await agentOnVm('task');
    // The task slept the way the VM sleep path leaves it, then its user replied.
    const now = new Date().toISOString();
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        "UPDATE tasks SET status = 'sleeping', execution_step = NULL WHERE id = ?"
      ).bind(f.taskId),
      env.DATABASE.prepare(
        `UPDATE workspaces SET status = 'deleted', runtime_deletion_confirmed_at = ? WHERE id = ?`
      ).bind(now, f.workspaceId),
      env.DATABASE.prepare(
        "UPDATE agent_sessions SET status = 'stopped' WHERE workspace_id = ?"
      ).bind(f.workspaceId),
      env.DATABASE.prepare(
        "UPDATE session_snapshots SET sleeping_at = ?, sleep_status = 'sleeping' WHERE chat_session_id = ?"
      ).bind(now, f.chatSessionId),
    ]);
    await sqlRows(
      f.stub,
      "UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?",
      f.chatSessionId
    );
    const followUp = 'Did CI pass? Fix it if not.';
    await f.stub.acceptPromptDelivery({
      deliveryId: `follow-up-${f.id}`,
      targetSessionId: f.chatSessionId,
      displayContent: followUp,
      senderType: 'human',
      senderId: f.userId,
      messageClass: 'deliver',
      sourceKind: 'user_followup',
      ttlMs: config.ttlMs,
    });

    expect(await runDueDelivery(f)).toMatchObject({
      kind: 'retry',
      error: expect.stringContaining(`Session is waking (${f.taskId})`),
    });
    expect(await runnerConfig(f.taskId)).toMatchObject({
      taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
      restoredSessionPrompt: null,
    });
    const replacement = await provisionReplacementWorkspace(f);
    const vm = installReplacementVm(replacement.nodeId, replacement.workspaceId, 'restored');

    await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
    expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
    await waitForWakeReadiness(f);
    expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
      kind: 'accepted',
    });

    expect(vm.prompts()).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ prompt: followUp }) }),
    ]);
    expect(await continuationRows(f)).toEqual([]);
    expect(await runDueDelivery(f, Date.now() + 2 * config.retryMaxMs)).toBeNull();
  });
});

/** Capture through the production complete route rather than handing recovery an asleep row. */
async function completeEvictionSnapshot(f: Fixture) {
  const generation = `capture-${f.id}`;
  const home = new TextEncoder().encode('saved harness state');
  const digest = await crypto.subtle.digest('SHA-256', home);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  await env.DATABASE.prepare(
    "UPDATE session_snapshots SET status = 'pending', capture_generation = ?, sleep_status = 'preparing', sleep_claimed_at = ? WHERE chat_session_id = ?"
  )
    .bind(generation, new Date().toISOString(), f.chatSessionId)
    .run();
  await env.R2.put(buildSessionSnapshotR2Key(testEnv, f.chatSessionId, generation, 'home'), home, {
    sha256: digest,
  });
  const token = await signCallbackToken(f.workspaceId, testEnv);
  const response = await SELF.fetch(
    `https://api.test.example.com/api/workspaces/${f.workspaceId}/session-snapshot/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatSessionId: f.chatSessionId,
        generation,
        runtime: 'vm',
        status: 'available',
        degradation: 'none',
        manifest: {
          version: 1,
          chatSessionId: f.chatSessionId,
          workspaceId: f.workspaceId,
          acpSessionId: 'saved-harness',
          agentType: 'claude-code',
          status: 'available',
          degradation: 'none',
          skipped: [],
          artifacts: { home: { sizeBytes: home.byteLength, sha256 } },
          createdAt: new Date().toISOString(),
        },
      }),
    }
  );
  expect(response.status, await response.text()).toBe(200);
}

/** Existing healthy second VM, selected and allocated by the real placement code. */
async function readyReplacementNode(f: Fixture) {
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

function installMovingVm(
  f: Fixture,
  nodeId: string,
  failProvisioning = false,
  promptCalls: NodeCall[] = []
) {
  const base = getNodeBackendBaseUrl(nodeId, testEnv);
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthroughFetch(input, init);
    const path = new URL(request.url).pathname;
    calls.push(path);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === '/workspaces' && request.method === 'POST') {
      const workspaceId = String(body.workspaceId);
      // The fake VM sends its real readiness callback, including failure.
      const response = await SELF.fetch(
        `https://api.test.example.com/api/workspaces/${workspaceId}/${failProvisioning ? 'provisioning-failed' : 'ready'}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${body.callbackToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: failProvisioning ? 'error' : 'running',
            errorMessage: failProvisioning ? 'VM provisioning failed' : undefined,
          }),
        }
      );
      expect(response.status, await response.text()).toBe(200);
      return Response.json({ workspaceId }, { status: 202 });
    }
    if (path.endsWith('/agent-capabilities'))
      return Response.json({
        ...versionedPromptCapabilities(RUNTIME_IDENTITY),
        sessionRuntimeContract: { supported: true, version: 1 },
      });
    if (path.endsWith('/restore')) return Response.json({ status: 'restored' });
    const prompt = /\/agent-sessions\/([^/]+)\/prompt$/.exec(path);
    if (prompt && request.method === 'POST') {
      promptCalls.push({ path, body });
      return Response.json(
        acceptedPromptResponse(prompt[1]!, String(body.deliveryId), RUNTIME_IDENTITY, Date.now())
      );
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ ok: true });
  });
  return calls;
}

async function driveMove(f: Fixture) {
  for (let step = 0; step < 25; step++) {
    expect((await f.stub.getSession(f.chatSessionId))?.status).not.toBe('stopped');
    const status = await taskRunner(f.taskId).getStatus();
    if (status?.completed || (await taskRow(f.taskId))?.status === 'in_progress') return;
    await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
  }
  throw new Error('Move did not converge within 25 TaskRunner alarms');
}

describe('eviction snapshot -> real TaskRunner workspace linking', () => {
  it('never stops the chat and reaches in_progress on another VM', async () => {
    const f = await agentOnVm('task');
    await completeEvictionSnapshot(f);
    const nodeId = await readyReplacementNode(f);
    installMovingVm(f, nodeId);
    await evict(f);
    expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('sleeping');
    await driveMove(f);
    expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
    const session = await f.stub.getSession(f.chatSessionId);
    expect(session?.status).toBe('active');
    expect(session?.workspaceId).not.toBe(f.workspaceId);
    expect(
      await env.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id = ?')
        .bind(session!.workspaceId)
        .first()
    ).toEqual({ node_id: nodeId });
  });

  it('delivers one task continuation after eviction through real workspace linking', async () => {
    const f = await agentOnVm('task');
    await completeEvictionSnapshot(f);
    const nodeId = await readyReplacementNode(f);
    const prompts: NodeCall[] = [];
    installMovingVm(f, nodeId, false, prompts);
    await evict(f);
    expect(await runnerConfig(f.taskId)).toMatchObject({
      restoredSessionPrompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
    });
    await driveMove(f);
    expect(await taskRow(f.taskId)).toEqual({ status: 'in_progress', execution_step: 'running' });
    const session = await f.stub.getSession(f.chatSessionId);
    expect(session?.status).toBe('active');
    expect(session?.workspaceId).not.toBe(f.workspaceId);
    const agentSessionId = await agentSessionOf(session!.workspaceId!);
    const deliveryId = restoredSessionPromptDeliveryId(agentSessionId);
    expect(await continuationRows(f)).toEqual([
      expect.objectContaining({
        id: deliveryId,
        content: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
        source_task_id: f.taskId,
      }),
    ]);
    await waitForWakeReadiness(f);
    expect(await runDueDelivery(f)).toMatchObject({ kind: 'accepted' });
    expect(prompts).toEqual([
      {
        path: `/workspaces/${session!.workspaceId}/agent-sessions/${agentSessionId}/prompt`,
        body: expect.objectContaining({
          prompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
          deliveryId,
        }),
      },
    ]);
    expect(await continuationRows(f)).toEqual([
      expect.objectContaining({ id: deliveryId, delivery_state: 'acked' }),
    ]);
    expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  it.each([false, true])(
    'returns a failed replacement to sleep and releases claim/binding (stopped mirror=%s)',
    async (stopMirror) => {
      const f = await agentOnVm('task');
      await completeEvictionSnapshot(f);
      const nodeId = await readyReplacementNode(f);
      installMovingVm(f, nodeId, true);
      await evict(f);
      if (stopMirror) {
        // Inject an explicitly eviction-attributed stopped mirror under the live wake claim.
        let injected = false;
        for (let step = 0; step < 25; step++) {
          const status = await taskRunner(f.taskId).getStatus();
          if (status?.completed) break;
          if (status?.currentStep === 'workspace_dispatch' && !injected) {
            await f.stub.stopSession(f.chatSessionId, {
              source: 'workspace_eviction_finalization',
            });
            injected = true;
          }
          await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
        }
      } else await driveMove(f);
      expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('sleeping');
      expect((await taskRow(f.taskId))?.status).toBe('sleeping');
      // This failed-move path publishes progress/error state, not a failure attention marker.
      expect(
        await sqlRows(
          f.stub,
          "SELECT kind FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL AND kind IN ('wake_failed', 'idle_cleanup_failed')",
          f.chatSessionId
        )
      ).toEqual([]);
      await deleteFailedReplacement(nodeId, f.taskId);
      const failedWorkspace = await env.DATABASE.prepare(
        'SELECT status, chat_session_id FROM workspaces WHERE id = (SELECT workspace_id FROM tasks WHERE id = ?)'
      )
        .bind(f.taskId)
        .first();
      expect(failedWorkspace).toEqual({ status: 'deleted', chat_session_id: null });

      expect(
        await env.DATABASE.prepare(
          'SELECT recovery_status FROM session_snapshots WHERE chat_session_id = ?'
        )
          .bind(f.chatSessionId)
          .first()
      ).toEqual({ recovery_status: 'failed' });
      expect(
        await env.DATABASE.prepare(
          "SELECT id FROM workspaces WHERE chat_session_id = ? AND status = 'deleted'"
        )
          .bind(f.chatSessionId)
          .all()
      ).toMatchObject({ results: [] });
    }
  );

  it('keeps pre-binding stopped cleanup retryable until real linking establishes the exact claim', async () => {
    const f = await agentOnVm('task');
    await completeEvictionSnapshot(f);
    const nodeId = await readyReplacementNode(f);
    installMovingVm(f, nodeId);
    await evict(f);
    for (let step = 0; step < 8; step++) {
      if ((await taskRunner(f.taskId).getStatus())?.currentStep === 'workspace_dispatch') break;
      await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
    }
    const workspace = await env.DATABASE.prepare('SELECT workspace_id FROM tasks WHERE id = ?')
      .bind(f.taskId)
      .first<{ workspace_id: string }>();
    expect(workspace?.workspace_id).toBeTruthy();
    await f.stub.stopSession(f.chatSessionId, { source: 'workspace_eviction_finalization' });
    // Reconstruct the persisted allocation-before-bookkeeping boundary. Only
    // VM/provider traffic is doubled; cleanup and later linking stay real.
    await env.DATABASE.prepare('UPDATE workspaces SET chat_session_id = NULL WHERE id = ?')
      .bind(workspace!.workspace_id)
      .run();
    const snapshotBefore = await env.DATABASE.prepare(
      'SELECT * FROM session_snapshots WHERE chat_session_id = ?'
    )
      .bind(f.chatSessionId)
      .first();
    const stoppedBefore = await f.stub.getSession(f.chatSessionId);
    const rejected = await runInDurableObject(taskRunner(f.taskId), async (instance) => {
      const state = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
      state.wakeFailureMessage = 'Failure before workspace bookkeeping';
      await instance.ctx.storage.put('state', state);
      try {
        await instance.alarm();
        return false;
      } catch (error) {
        return String(error).includes('no authorized snapshot wake claim');
      }
    });
    expect(rejected).toBe(true);
    expect(await f.stub.getSession(f.chatSessionId)).toEqual(stoppedBefore);
    expect(
      await sqlRows(
        f.stub,
        'SELECT value FROM do_meta WHERE key = ?',
        `snapshot-recovery-eviction-stop:${f.chatSessionId}`
      )
    ).toHaveLength(1);
    expect(
      await env.DATABASE.prepare('SELECT * FROM session_snapshots WHERE chat_session_id = ?')
        .bind(f.chatSessionId)
        .first()
    ).toEqual(snapshotBefore);
    expect(
      await env.DATABASE.prepare('SELECT status, chat_session_id FROM workspaces WHERE id = ?')
        .bind(workspace!.workspace_id)
        .first()
    ).toEqual({ status: 'creating', chat_session_id: null });
    await runInDurableObject(taskRunner(f.taskId), async (instance) => {
      const state = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
      expect(state.wakeFailureMessage).toBe('Failure before workspace bookkeeping');
      const rc = (
        instance as unknown as {
          buildContext(state: TaskRunnerState): TaskRunnerContext;
        }
      ).buildContext(state);
      // Real bookkeeping writes the D1 binding first. Its subsequent live-task
      // link is correctly refused because cleanup already returned the task to
      // sleeping; that refusal must not bypass the cleanup alarm's claim fence.
      await expect(ensureSessionLinked(state, workspace!.workspace_id, rc)).rejects.toThrow(
        'Task is missing, no longer executable, or belongs to another owner'
      );
      await instance.alarm();
    });
    expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('sleeping');
    expect((await taskRow(f.taskId))?.status).toBe('sleeping');
    // This boundary precedes VM dispatch: cleanup stops the unused allocation
    // without scheduling deletion of a runtime that was never provisioned.
    expect(
      await env.DATABASE.prepare('SELECT status, chat_session_id FROM workspaces WHERE id = ?')
        .bind(workspace!.workspace_id)
        .first()
    ).toEqual({ status: 'stopped', chat_session_id: null });
    expect(
      await env.DATABASE.prepare(
        'SELECT recovery_status FROM session_snapshots WHERE chat_session_id = ?'
      )
        .bind(f.chatSessionId)
        .first()
    ).toEqual({ recovery_status: 'failed' });
  });

  it('does not repair a legacy stopped chat through a deleted replacement cleanup alarm', async () => {
    const f = await agentOnVm('task');
    await completeEvictionSnapshot(f);
    const nodeId = await readyReplacementNode(f);
    const calls = installMovingVm(f, nodeId);
    await evict(f);
    // Reach the real link boundary, then reconstruct the historical failed cleanup state.
    for (let step = 0; step < 8; step++) {
      if ((await taskRunner(f.taskId).getStatus())?.currentStep === 'workspace_dispatch') break;
      await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
    }
    const workspace = await env.DATABASE.prepare('SELECT workspace_id FROM tasks WHERE id = ?')
      .bind(f.taskId)
      .first<{ workspace_id: string }>();
    expect(workspace?.workspace_id).toBeTruthy();
    await runInDurableObject(f.stub, (_instance, ctx) => {
      ctx.storage.sql.exec(
        "UPDATE chat_sessions SET status = 'stopped' WHERE id = ?",
        f.chatSessionId
      );
    });
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        "UPDATE workspaces SET status = 'deleted', runtime_deletion_confirmed_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), workspace!.workspace_id),
      env.DATABASE.prepare("UPDATE tasks SET status = 'sleeping' WHERE id = ?").bind(f.taskId),
    ]);
    const snapshotBefore = await env.DATABASE.prepare(
      'SELECT * FROM session_snapshots WHERE chat_session_id = ?'
    )
      .bind(f.chatSessionId)
      .first();
    const result = await runInDurableObject(taskRunner(f.taskId), async (instance) => {
      const state = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
      state.wakeFailureMessage = 'Legacy session link refused';
      await instance.ctx.storage.put('state', state);
      try {
        await instance.alarm();
        return { refused: false };
      } catch (error) {
        return { refused: true, message: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(result).toMatchObject({
      refused: true,
      message: 'Stopped recovery conversation has no authorized snapshot wake claim',
    });
    expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('stopped');
    expect(
      await env.DATABASE.prepare('SELECT * FROM session_snapshots WHERE chat_session_id = ?')
        .bind(f.chatSessionId)
        .first()
    ).toEqual(snapshotBefore);
    expect(
      await env.DATABASE.prepare('SELECT chat_session_id FROM workspaces WHERE id = ?')
        .bind(workspace!.workspace_id)
        .first()
    ).toEqual({ chat_session_id: f.chatSessionId });
    expect(calls).toEqual([]);
  });

  it('rejects an uncaptured eviction without changing the chat or snapshot', async () => {
    const f = await agentOnVm('task');
    const before = await env.DATABASE.prepare(
      'SELECT * FROM session_snapshots WHERE chat_session_id = ?'
    )
      .bind(f.chatSessionId)
      .first();
    const token = await signNodeCallbackToken(f.nodeId, testEnv);
    const response = await SELF.fetch(
      `https://api.test.example.com/api/projects/${f.projectId}/workspaces/${f.workspaceId}/eviction`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: f.nodeId,
          workspaceId: f.workspaceId,
          reason: 'oom_kill',
          snapshotCaptured: false,
          containerStopped: true,
          evictionGeneration: EVICTION_GENERATION,
        }),
      }
    );
    expect(response.status, await response.text()).toBe(409);
    expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('active');
    expect(
      await env.DATABASE.prepare('SELECT * FROM session_snapshots WHERE chat_session_id = ?')
        .bind(f.chatSessionId)
        .first()
    ).toEqual(before);
    expect(
      await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id = ?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ status: 'running' });
  });
});

describe('eviction stop provenance', () => {
  it('records eviction provenance when a lost runtime has no restorable artifact', async () => {
    const f = await agentOnVm('task');
    await completeEvictionSnapshot(f);
    await env.DATABASE.prepare('DELETE FROM session_snapshots WHERE chat_session_id = ?')
      .bind(f.chatSessionId)
      .run();
    await evict(f);
    expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('stopped');
    const activity = await sqlRows<{ payload: string; workspace_id: string }>(
      f.stub,
      "SELECT payload, workspace_id FROM activity_events WHERE event_type = 'session.stopped' AND session_id = ?",
      f.chatSessionId
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]?.workspace_id).toBe(f.workspaceId);
    expect(JSON.parse(activity[0]!.payload)).toMatchObject({
      stop_source: 'workspace_eviction_finalization',
    });
    const lifecycle = await sqlRows<{ metadata_json: string }>(
      f.stub,
      "SELECT metadata_json FROM project_events WHERE event_type = 'session.archived' AND subject_id = ?",
      f.chatSessionId
    );
    expect(lifecycle).toHaveLength(1);
    expect(JSON.parse(lifecycle[0]!.metadata_json)).toMatchObject({
      transitionSource: 'workspace_eviction_finalization',
    });
  });

  it.each(['ordinary-service', 'manual-do'])(
    'keeps %s stops distinct; absent provenance stays unknown',
    async (caller) => {
      const f = await agentOnVm('task');
      if (caller === 'ordinary-service') {
        const { stopSession } = await import('../../src/services/project-data');
        await stopSession(testEnv, f.projectId, f.chatSessionId);
      } else await f.stub.stopSession(f.chatSessionId);
      const activity = await sqlRows<{ payload: string }>(
        f.stub,
        "SELECT payload FROM activity_events WHERE event_type = 'session.stopped' AND session_id = ?",
        f.chatSessionId
      );
      expect(activity).toHaveLength(1);
      // Absence is unknown provenance, never evidence of eviction.
      expect(JSON.parse(activity[0]!.payload)).not.toHaveProperty('stop_source');
      if (caller === 'ordinary-service') {
        const lifecycle = await sqlRows<{ metadata_json: string }>(
          f.stub,
          "SELECT metadata_json FROM project_events WHERE event_type = 'session.archived' AND subject_id = ?",
          f.chatSessionId
        );
        expect(lifecycle).toHaveLength(1);
        expect(JSON.parse(lifecycle[0]!.metadata_json)).toMatchObject({
          transitionSource: 'project_data.stop_session',
        });
      }
    }
  );
});
