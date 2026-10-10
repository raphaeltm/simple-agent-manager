/**
 * Real-ordering regression for the VM wake handoff (idea 01M4JMYRY5909JYND1XRXMM9DC).
 *
 * Production, 2026-10-09: an agent DM woke a sleeping VM conversation. Its queued
 * event-wake prompt reached the replacement runtime after the new agent session row read
 * `running` but before the TaskRunner committed the handoff. Acceptance flipped the event
 * batch to `delivered`, the runner's handoff re-check read that as revoked authority, and
 * the runtime was stopped with the prompt's turn inside it.
 *
 * Each case drives the real pieces in production order:
 * 1. An agent DM creates the event-wake batch and its `session_inbox` row.
 * 2. The prompt-delivery runner's first attempt claims the snapshot, reactivates the task
 *    and starts the TaskRunner (`ensureSessionRecovery`).
 * 3. The TaskRunner `agent_session` alarm runs with the VM restore held open, so the test
 *    owns the midpoint (rule 62: an ordering defect needs controlled ordering).
 * 4. The delivery runner runs again at that midpoint, then the restore is released.
 * Provisioning (node selection to workspace ready) is fast-forwarded with the rows those
 * steps write; it plays no part in the race. One case replaces step 4 with the woken agent
 * reading its own subscription through MCP, the consumer that no delivery hold covers.
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
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { validateProjectEventWakeRecoveryAuthority } from '../../src/services/project-data';
import { resolveSessionRuntimeContract } from '../../src/services/session-runtime-contract';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import {
  inboxRows,
  materializeWakes,
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
  withProjectDataEnv,
} from './helpers/agent-message-channels';
import { seedWorkspace } from './helpers/seed-d1';

const config = resolveDurableExecutionConfig({});
const RUNTIME_IDENTITY = 'replacement-runtime';
const EVENT_WAKE_FLAGS = {
  AGENT_MESSAGE_CHANNELS_ENABLED: 'true',
  PROJECT_EVENT_WAKE_ENABLED: 'true',
};
const wakeEnv = () => ({ ...testEnv, ...EVENT_WAKE_FLAGS }) as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Code inside a Durable Object must not resume test code, or the test's next stub call runs
 * in that object's I/O context. Each side therefore polls a plain flag on its own timers.
 */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the held VM restore');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function taskRunner(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

/** Capture alarms instead of arming them, so the test drives every step itself. */
function pauseAlarms(storage: DurableObjectStorage): void {
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
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      )
    )) as DurableObjectStorage['transaction']);
}

type Fixture = Awaited<ReturnType<typeof sleepingConversationWokenByAgentDm>>;

/**
 * Agent B's conversation slept the way the VM sleep path leaves it: a complete snapshot,
 * the runtime deleted with proof, the task `sleeping`. Then agent A messages B.
 */
async function sleepingConversationWokenByAgentDm() {
  const project = await twoAgentProject();
  const { a, b, stub, projectId, memberId } = project;
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  const node = await env.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id = ?')
    .bind(b.workspaceId)
    .first<{ node_id: string }>();
  const nodeId = node!.node_id;
  await runInDurableObject(stub, async (_instance, state) => {
    pauseAlarms(state.storage);
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(taskRunner(b.taskId), (instance) => {
    pauseAlarms(instance.ctx.storage);
  });

  // The wake's placement resolves through the member's own cloud credential.
  const { ciphertext, iv } = await encrypt('hetzner-token-wake-handoff', env.ENCRYPTION_KEY);
  const contract = await resolveSessionRuntimeContract(db, wakeEnv(), {
    userId: memberId,
    projectId,
    agentType: 'openai-codex',
    promptKind: 'task',
    taskContext: { taskId: b.taskId, taskMode: 'conversation' },
  });
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
    ).bind(`cred-${b.taskId}`, memberId, ciphertext, iv, now, now),
    env.DATABASE.prepare(
      `UPDATE tasks SET status = 'sleeping', task_mode = 'conversation', execution_step = NULL
        WHERE id = ?`
    ).bind(b.taskId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'deleted', runtime_deletion_confirmed_at = ? WHERE id = ?`
    ).bind(now, b.workspaceId),
    env.DATABASE.prepare(`UPDATE agent_sessions SET status = 'stopped' WHERE id = ?`).bind(
      b.agentSessionId
    ),
    env.DATABASE.prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
          manifest_r2_key, runtime_contract_json, expires_at, sleeping_at, sleep_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'vm', 'available', 'none', 'manifest', ?,
               '2099-01-01T00:00:00Z', ?, 'sleeping', ?, ?)`
    ).bind(
      `snapshot-${b.taskId}`,
      projectId,
      b.workspaceId,
      memberId,
      b.sessionId,
      JSON.stringify(contract),
      now,
      now,
      now
    ),
  ]);
  await sqlRows(stub, "UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?", b.sessionId);

  okBody(
    await a.tool('send_durable_message', {
      targetTaskId: b.taskId,
      message: 'CI finished; please check the failing job and report back.',
    })
  );
  await materializeWakes(stub, projectId);
  const wakes = await inboxRows(stub);
  expect(wakes).toHaveLength(1);
  const wake = wakes[0]!;
  expect(wake).toMatchObject({ target_session_id: b.sessionId, source_kind: 'project_event_wake' });
  const subscriptionId = (JSON.parse(wake.metadata ?? '{}') as { subscriptionId?: string })
    .subscriptionId;
  expect(subscriptionId).toEqual(expect.any(String));
  return { ...project, nodeId, deliveryId: wake.id, subscriptionId: subscriptionId! };
}

/** One pass of the production delivery claim runner for whatever is due at `now`. */
async function runDueDelivery(f: Fixture, now = Date.now()): Promise<PromptDeliveryResult | null> {
  return runInDurableObject(f.stub, async (instance, state) => {
    const [claim] = claimDuePromptDeliveries(state.storage.sql, config, now);
    if (!claim) return null;
    // Bindings must come from the object's own context, as in its production alarm.
    const objectEnv = {
      ...(instance as unknown as { env: Env }).env,
      ...EVENT_WAKE_FLAGS,
    } as Env;
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
 * replacement workspace bound to the chat (`ensureSessionLinked`), the task delegated to it,
 * the snapshot's recovery workspace (`recordSessionSnapshotRecoveryWorkspace`), and the
 * runner parked at `agent_session`.
 */
async function provisionReplacementWorkspace(f: Fixture): Promise<string> {
  const workspaceId = `w2-${f.b.taskId}`;
  await seedWorkspace(workspaceId, f.nodeId, f.memberId, {
    projectId: f.projectId,
    chatSessionId: f.b.sessionId,
    status: 'running',
  });
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE tasks SET status = 'delegated', workspace_id = ?, execution_step = 'workspace_ready'
        WHERE id = ?`
    ).bind(workspaceId, f.b.taskId),
    env.DATABASE.prepare(
      'UPDATE session_snapshots SET recovery_workspace_id = ? WHERE chat_session_id = ?'
    ).bind(workspaceId, f.b.sessionId),
  ]);
  await runInDurableObject(taskRunner(f.b.taskId), async (instance) => {
    const state = (await instance.ctx.storage.get<TaskRunnerState>('state'))!;
    state.currentStep = 'agent_session';
    state.stepResults.nodeId = f.nodeId;
    state.stepResults.workspaceId = workspaceId;
    state.workspaceReadyReceived = true;
    state.workspaceReadyStatus = 'running';
    await instance.ctx.storage.put('state', state);
  });
  return workspaceId;
}

type NodeCall = { method: string; path: string; body: Record<string, unknown> | null };

/** VM agent double for the replacement workspace; the snapshot restore waits for release. */
function installReplacementVm(f: Fixture, workspaceId: string) {
  const calls: NodeCall[] = [];
  const restore = { started: false, released: false };
  const base = getNodeBackendBaseUrl(f.nodeId, wakeEnv());
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthrough(input, init);
    const url = new URL(request.url);
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    calls.push({ method: request.method, path: url.pathname, body });
    // One capabilities document serves the restore pre-check and prompt delivery.
    if (url.pathname === buildVmPromptDeliveryCapabilitiesPath(workspaceId)) {
      return Response.json({
        ...versionedPromptCapabilities(RUNTIME_IDENTITY),
        sessionRuntimeContract: { supported: true, version: 1 },
      });
    }
    if (/\/agent-sessions\/[^/]+\/restore$/.test(url.pathname)) {
      restore.started = true;
      await until(() => restore.released);
      return Response.json({ status: 'restored' });
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
    restoreStarted: () => until(() => restore.started),
    releaseRestore: () => {
      restore.released = true;
    },
    prompts: () => calls.filter((call) => /\/agent-sessions\/[^/]+\/prompt$/.test(call.path)),
    stops: () => calls.filter((call) => call.path === `/workspaces/${workspaceId}/stop`),
  };
}

async function taskRow(taskId: string) {
  return env.DATABASE.prepare('SELECT status, execution_step FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ status: string; execution_step: string | null }>();
}

async function snapshotClaim(chatSessionId: string) {
  return env.DATABASE.prepare(
    `SELECT recovery_status, recovery_task_id, recovery_attempt_id, recovery_workspace_id
       FROM session_snapshots WHERE chat_session_id = ?`
  )
    .bind(chatSessionId)
    .first<{
      recovery_status: string | null;
      recovery_task_id: string | null;
      recovery_attempt_id: string | null;
      recovery_workspace_id: string | null;
    }>();
}

async function batchState(f: Fixture): Promise<string | undefined> {
  const [row] = await sqlRows<{ state: string }>(
    f.stub,
    'SELECT state FROM project_event_delivery_batches WHERE id = ?',
    f.deliveryId
  );
  return row?.state;
}

async function inboxRow(f: Fixture) {
  const [row] = await sqlRows<{
    delivery_state: string;
    delivery_attempts: number;
    last_error: string | null;
  }>(
    f.stub,
    'SELECT delivery_state, delivery_attempts, last_error FROM session_inbox WHERE id = ?',
    f.deliveryId
  );
  return row;
}

async function runnerState(taskId: string): Promise<TaskRunnerState | null> {
  return taskRunner(taskId).getStatus();
}

/** Call an MCP tool the way the replacement runtime's agent does, with its own token. */
async function callMcpTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  return response.json<{ result?: { content?: Array<{ text?: string }> }; error?: unknown }>();
}

function authorityRevocations(warn: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return warn.mock.calls
    .map(([line]: unknown[]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter(
      (entry: Record<string, unknown>) => entry.event === 'session_recovery.authority_revoked'
    );
}

/**
 * Wake B through the real runner, fast-forward provisioning, start the real
 * `agent_session` alarm and stop it inside the VM restore. Returns the in-flight alarm.
 */
async function wakeToHeldRestore(f: Fixture) {
  const claimed = await runDueDelivery(f);
  expect(claimed).toMatchObject({
    kind: 'retry',
    reason: 'not_ready',
    error: expect.stringContaining(`Session is waking (${f.b.taskId})`),
  });
  expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'queued' });
  const claim = await snapshotClaim(f.b.sessionId);
  expect(claim).toMatchObject({ recovery_status: 'waking', recovery_task_id: f.b.taskId });
  expect(await runnerState(f.b.taskId)).toMatchObject({
    currentStep: 'node_selection',
    config: {
      resumeSnapshotChatSessionId: f.b.sessionId,
      recoverySourceTaskId: f.b.taskId,
      recoveryAttemptId: claim?.recovery_attempt_id,
      projectEventWakeGuard: { batchId: f.deliveryId, subscriptionId: f.subscriptionId },
    },
  });

  const workspaceId = await provisionReplacementWorkspace(f);
  const vm = installReplacementVm(f, workspaceId);
  const alarm = runInDurableObject(taskRunner(f.b.taskId), (instance) => instance.alarm());
  await vm.restoreStarted();
  // The midpoint production hit: the replacement agent session already reads running.
  const agentSession = await env.DATABASE.prepare(
    'SELECT status FROM agent_sessions WHERE workspace_id = ?'
  )
    .bind(workspaceId)
    .first<{ status: string }>();
  expect(agentSession).toEqual({ status: 'running' });
  return { alarm, vm, workspaceId };
}

async function withEventWakes(run: (f: Fixture) => Promise<void>): Promise<void> {
  await withAgentMessageChannels(async () => {
    const f = await sleepingConversationWokenByAgentDm();
    await withProjectDataEnv(f.stub, EVENT_WAKE_FLAGS, () => run(f));
  });
}

describe('VM wake handoff with its own queued event delivery', () => {
  it('holds the wake prompt until the handoff commits, then delivers it into the live runtime', async () => {
    await withEventWakes(async (f) => {
      const { alarm, vm } = await wakeToHeldRestore(f);

      // The parked delivery comes due again mid-handoff, as production's retry did at
      // 15:45:01.830, and reaches the uncommitted runtime. It must wait. Production's
      // delivery had retried at saturated backoff for minutes, so keep it coming due until
      // it has been claimed more times than the attempt budget allows: the hold must not
      // exhaust that budget and fail the prompt before the handoff commits.
      for (let retry = 1; retry <= config.maxAttempts; retry++) {
        const midpoint = await runDueDelivery(f, Date.now() + retry * config.retryMaxMs);
        expect(midpoint).toMatchObject({
          kind: 'retry',
          reason: 'not_ready',
          error: expect.stringContaining('agent handoff not committed'),
        });
      }
      expect(await inboxRow(f)).toMatchObject({
        delivery_state: 'retry_wait',
        delivery_attempts: config.maxAttempts - 1,
        last_error: expect.stringContaining('agent handoff not committed'),
      });
      expect(vm.prompts()).toEqual([]);
      expect(await batchState(f)).toBe('pending');

      vm.releaseRestore();
      await alarm;
      expect(await taskRow(f.b.taskId)).toEqual({
        status: 'in_progress',
        execution_step: 'running',
      });
      expect(await snapshotClaim(f.b.sessionId)).toMatchObject({ recovery_status: 'restored' });
      expect(await runnerState(f.b.taskId)).toMatchObject({
        currentStep: 'running',
        completed: true,
      });
      expect(vm.stops()).toEqual([]);

      // The committed wake signals readiness, which makes the parked prompt due now.
      await vi.waitFor(
        async () => {
          const ready = await sqlRows(
            f.stub,
            'SELECT session_id FROM session_wake_readiness WHERE session_id = ?',
            f.b.sessionId
          );
          expect(ready).toHaveLength(1);
        },
        { timeout: 5_000 }
      );
      const delivered = await runDueDelivery(f);
      expect(delivered).toMatchObject({ kind: 'accepted' });
      expect(vm.prompts()).toEqual([
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ deliveryId: f.deliveryId }),
        }),
      ]);
      expect(await batchState(f)).toBe('delivered');
      // The accepted prompt's turn keeps its runtime.
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'in_progress' });
      expect(vm.stops()).toEqual([]);
    });
  });

  it('lets the woken agent read its own event mid-handoff without revoking the wake', async () => {
    await withEventWakes(async (f) => {
      const warn = vi.spyOn(console, 'warn');
      const { alarm, vm } = await wakeToHeldRestore(f);
      // A degraded restore starts a fresh agent turn before the handoff commits
      // (`startSamAwareAgentSession`), and that agent may read its own subscription. The
      // read consumes the batch (`markBatchObservedForPull`), which no delivery hold covers.
      // The runtime's own MCP token; getStatus() redacts it, so read the runner's storage.
      const token = await runInDurableObject(
        taskRunner(f.b.taskId),
        async (instance) =>
          (await instance.ctx.storage.get<TaskRunnerState>('state'))?.stepResults.mcpToken
      );
      expect(token).toEqual(expect.any(String));
      const read = await callMcpTool(token!, 'list_subscription_events', {
        subscriptionId: f.subscriptionId,
      });
      expect(read.error).toBeUndefined();
      expect(read.result?.content?.[0]?.text).toContain(f.deliveryId);
      expect(await batchState(f)).toBe('delivered');
      expect(await inboxRow(f)).toMatchObject({ delivery_state: 'failed' });

      vm.releaseRestore();
      await alarm;
      expect(await taskRow(f.b.taskId)).toEqual({
        status: 'in_progress',
        execution_step: 'running',
      });
      expect(await snapshotClaim(f.b.sessionId)).toMatchObject({ recovery_status: 'restored' });
      expect(authorityRevocations(warn)).toEqual([]);
      expect(vm.stops()).toEqual([]);
      // The agent already read the event, so its wake prompt was withdrawn.
      expect(vm.prompts()).toEqual([]);
    });
  });

  it('still aborts the handoff when a newer wake attempt supersedes the runner', async () => {
    await withEventWakes(async (f) => {
      const warn = vi.spyOn(console, 'warn');
      const { alarm, vm } = await wakeToHeldRestore(f);
      // A newer wake claim replaces this runner's attempt while its restore is in flight.
      await env.DATABASE.prepare(
        "UPDATE session_snapshots SET recovery_attempt_id = 'newer-wake-attempt' WHERE chat_session_id = ?"
      )
        .bind(f.b.sessionId)
        .run();

      vm.releaseRestore();
      await alarm;
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'delegated' });
      expect(await snapshotClaim(f.b.sessionId)).toMatchObject({
        recovery_status: 'waking',
        recovery_attempt_id: 'newer-wake-attempt',
      });
      // This log assertion, not the task status, is what fails if the runner's own authority
      // check stops refusing: `transitionToInProgress` re-checks the attempt in its guarded
      // UPDATE and would leave the task `delegated` on its own.
      expect(authorityRevocations(warn)).toContainEqual(
        expect.objectContaining({
          check: 'recovery_attempt_not_current',
          site: 'task_runner.assert_recovery_authority',
          taskId: f.b.taskId,
          snapshotRecoveryAttemptId: 'newer-wake-attempt',
          snapshotRecoveryStatus: 'waking',
        })
      );
      // A superseded runner leaves the runtime to the newer attempt.
      expect(vm.stops()).toEqual([]);
      expect(vm.prompts()).toEqual([]);
    });
  });

  it('still aborts the handoff when the task is cancelled mid-wake', async () => {
    await withEventWakes(async (f) => {
      const warn = vi.spyOn(console, 'warn');
      const { alarm, vm } = await wakeToHeldRestore(f);
      await env.DATABASE.prepare(
        "UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?"
      )
        .bind(new Date().toISOString(), f.b.taskId)
        .run();

      vm.releaseRestore();
      await alarm;
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'cancelled' });
      // As above, the log assertion is the discriminating one: `transitionToInProgress` also
      // refuses a terminal source task in its guarded UPDATE.
      expect(authorityRevocations(warn)).toContainEqual(
        expect.objectContaining({
          check: 'recovery_task_authority',
          site: 'task_runner.assert_recovery_authority',
          taskId: f.b.taskId,
          snapshotRecoveryStatus: 'waking',
          snapshotSleepStatus: 'sleeping',
        })
      );
      expect(await runnerState(f.b.taskId)).toMatchObject({ completed: true });
      expect(vm.stops()).toHaveLength(1);
      expect(vm.prompts()).toEqual([]);
    });
  });

  it('still aborts the handoff when the event subscription is genuinely revoked', async () => {
    await withEventWakes(async (f) => {
      const warn = vi.spyOn(console, 'warn');
      const { alarm, vm } = await wakeToHeldRestore(f);
      await sqlRows(
        f.stub,
        "UPDATE project_event_subscriptions SET lifecycle_state = 'cancelled' WHERE id = ?",
        f.subscriptionId
      );

      vm.releaseRestore();
      await alarm;
      expect(authorityRevocations(warn)).toContainEqual(
        expect.objectContaining({
          check: 'project_event_wake_authority',
          site: 'task_runner.assert_recovery_authority',
          taskId: f.b.taskId,
          projectEventBatchId: f.deliveryId,
          projectEventSubscriptionId: f.subscriptionId,
        })
      );
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'sleeping' });
      const failure = await env.DATABASE.prepare(
        `SELECT reason FROM task_status_events
          WHERE task_id = ? AND to_status = 'sleeping' ORDER BY created_at DESC LIMIT 1`
      )
        .bind(f.b.taskId)
        .first<{ reason: string }>();
      expect(failure?.reason).toBe(
        'Wake attempt failed; saved conversation retained: Session recovery authority was revoked'
      );
      expect(vm.stops()).toHaveLength(1);
      expect(vm.prompts()).toEqual([]);
    });
  });
});

describe('event wake authority while a VM wake is live', () => {
  // Real ProjectData SQL (rule 28). The TaskRunner sets acceptConsumedByTarget; the Instant
  // container's per-request guard does not.
  it.each([
    { state: 'pending', strict: true, liveWake: true },
    { state: 'delivered', strict: false, liveWake: true },
    { state: 'acked', strict: false, liveWake: true },
    { state: 'cancelled', strict: false, liveWake: false },
    { state: 'expired', strict: false, liveWake: false },
  ])('$state batch: strict=$strict, live wake=$liveWake', async ({ state, strict, liveWake }) => {
    await withEventWakes(async (f) => {
      await sqlRows(
        f.stub,
        'UPDATE project_event_delivery_batches SET state = ? WHERE id = ?',
        state,
        f.deliveryId
      );
      const input = {
        chatSessionId: f.b.sessionId,
        sourceTaskId: f.b.taskId,
        batchId: f.deliveryId,
        subscriptionId: f.subscriptionId,
      };
      await expect(
        validateProjectEventWakeRecoveryAuthority(wakeEnv(), f.projectId, input)
      ).resolves.toBe(strict);
      await expect(
        validateProjectEventWakeRecoveryAuthority(wakeEnv(), f.projectId, {
          ...input,
          acceptConsumedByTarget: true,
        })
      ).resolves.toBe(liveWake);
    });
  });

  it('still refuses a consumed batch once its subscription is cancelled', async () => {
    await withEventWakes(async (f) => {
      await sqlRows(
        f.stub,
        "UPDATE project_event_delivery_batches SET state = 'delivered' WHERE id = ?",
        f.deliveryId
      );
      await sqlRows(
        f.stub,
        "UPDATE project_event_subscriptions SET lifecycle_state = 'cancelled' WHERE id = ?",
        f.subscriptionId
      );
      await expect(
        validateProjectEventWakeRecoveryAuthority(wakeEnv(), f.projectId, {
          chatSessionId: f.b.sessionId,
          sourceTaskId: f.b.taskId,
          batchId: f.deliveryId,
          subscriptionId: f.subscriptionId,
          acceptConsumedByTarget: true,
        })
      ).resolves.toBe(false);
    });
  });
});
