/**
 * Regression for idea 01M4E2Q4P9CFTW5RWAKHGEP0VC (item 5 of 01M4JVVG3K1BP55ANVKMGFHTHW).
 *
 * An OOM eviction kills a task-mode agent mid-work with nothing queued. Recovery restores the
 * saved harness session (LoadSession), and a restored session never receives the fresh-start
 * prompt, so the agent used to idle silently. Each case enters through the production trigger
 * (the eviction callback route, or a queued follow-up for the control that needs one), then runs
 * the real recovery, the real TaskRunner `agent_session` alarm and the real ProjectData delivery
 * runner. Only the VM agent is a fetch double; provisioning (node selection to workspace ready)
 * is fast-forwarded with the rows those steps write, because it plays no part in the prompt.
 */
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
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
import type { Env } from '../../src/env';
import { encrypt } from '../../src/services/encryption';
import { signNodeCallbackToken } from '../../src/services/jwt';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { restoredSessionPromptDeliveryId } from '../../src/services/restored-session-prompt';
import { resolveSessionRuntimeContract } from '../../src/services/session-runtime-contract';
import {
  SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from '../../src/services/session-sleep-fallback-messages';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { projectStub, sqlRows, testEnv } from './helpers/agent-message-channels';
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
  vi.restoreAllMocks();
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

/** Runs inside the Durable Object before each transactional `state` write. */
type StateWriteHook = { before: (state: TaskRunnerState) => Promise<void> };

/**
 * Capture alarms instead of arming them, so the test drives every step itself. The TaskRunner
 * fences each state write in a storage transaction (`putTaskRunnerState`), so `writes.before`
 * sees every write of `state` there.
 */
function pauseAlarms(storage: DurableObjectStorage, writes?: StateWriteHook): void {
  const transaction = storage.transaction.bind(storage);
  vi.spyOn(storage, 'setAlarm').mockImplementation(async () => undefined);
  vi.spyOn(storage, 'transaction').mockImplementation(((
    callback: (txn: DurableObjectTransaction) => unknown
  ) =>
    transaction((txn) =>
      callback(
        new Proxy(txn, {
          get(target, property) {
            if (property === 'setAlarm') return async () => undefined;
            if (property === 'put' && writes) {
              return async (key: string, value: unknown) => {
                if (key === 'state') await writes.before(value as TaskRunnerState);
                return target.put(key, value);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      )
    )) as DurableObjectStorage['transaction']);
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
async function evict(f: Fixture): Promise<void> {
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

describe('a task-mode agent recovered after an eviction', () => {
  it('receives the continue prompt once its restored session is handed off, exactly once', async () => {
    const f = await agentOnVm('task');
    await evict(f);
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
  });

  it('gets the continue prompt once as its initial prompt when the restore starts it fresh', async () => {
    const f = await agentOnVm('task');
    await evict(f);
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
  });

  it('leaves a conversation-mode agent waiting for its user after the restore', async () => {
    const f = await agentOnVm('conversation');
    await evict(f);
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
  });
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
