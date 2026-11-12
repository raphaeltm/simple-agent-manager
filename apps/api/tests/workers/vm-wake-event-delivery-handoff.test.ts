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
import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { processPromptDeliveryAlarm } from '../../src/durable-objects/project-data/durability-foundation';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  claimDuePromptDeliveries,
  type PromptDeliveryResult,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../src/durable-objects/project-data/prompt-delivery-runner';
import type { TaskRunner, TaskRunnerState } from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import { runScheduledCapacityPoolReconciliation } from '../../src/scheduled/capacity-pool-reconciliation';
import { candidatePublicationCursorKey } from '../../src/services/default-capacity-pool-candidates-publication';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { clearCapacityCatalogCache } from '../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../src/services/encryption';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { validateProjectEventWakeRecoveryAuthority } from '../../src/services/project-data';
import { resolveSessionRuntimeContract } from '../../src/services/session-runtime-contract';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import { ensurePoolsWithStarterMachines } from '../helpers/capacity-pool-picks';
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
import { seedSignedInUser, seedWorkspace } from './helpers/seed-d1';

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
type DeliveryFixture = Omit<Fixture, 'subscriptionId'> & {
  subscriptionId?: string;
  humanContent?: string;
  originalMessageId?: string;
};

/**
 * Agent B's conversation slept the way the VM sleep path leaves it: a complete snapshot,
 * the runtime deleted with proof, the task `sleeping`. Then agent A messages B.
 */
async function sleepingConversation() {
  const project = await twoAgentProject();
  const { b, stub, projectId, memberId } = project;
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
  // The wake places onto the member's pool, and a new pool picks nothing by itself.
  await ensurePoolsWithStarterMachines(db as never, {
    userId: memberId,
    projectId,
    includeInstallation: false,
    owner: { userId: memberId, projectId },
  });
  await sqlRows(stub, "UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?", b.sessionId);
  return { ...project, nodeId };
}

async function sleepingConversationWokenByAgentDm() {
  const project = await sleepingConversation();
  const { a, b, stub, projectId } = project;
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
  return { ...project, deliveryId: wake.id, subscriptionId: subscriptionId! };
}

/** One pass of the production delivery claim runner for whatever is due at `now`. */
async function runDueDelivery(
  f: DeliveryFixture,
  now = Date.now()
): Promise<PromptDeliveryResult | null> {
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
async function provisionReplacementWorkspace(f: DeliveryFixture): Promise<string> {
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
function installReplacementVm(f: DeliveryFixture, workspaceId: string) {
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

async function batchState(f: DeliveryFixture): Promise<string | undefined> {
  const [row] = await sqlRows<{ state: string }>(
    f.stub,
    'SELECT state FROM project_event_delivery_batches WHERE id = ?',
    f.deliveryId
  );
  return row?.state;
}

async function inboxRow(f: DeliveryFixture) {
  const [row] = await sqlRows<{
    delivery_state: string;
    delivery_attempts: number;
    last_error: string | null;
    delivery_intent: string;
  }>(
    f.stub,
    'SELECT delivery_state, delivery_attempts, last_error, delivery_intent FROM session_inbox WHERE id = ?',
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
async function wakeToHeldRestore(f: DeliveryFixture, alreadyQueued = false) {
  // Agent-message notices steer by default. A steer never wakes a runtime, so the sleeping
  // chat hands it straight to the queue, whose next claim starts the wake.
  if (!alreadyQueued) {
    const steered = await runDueDelivery(f);
    expect(steered).toMatchObject({ kind: 'steer_fallback', reason: 'session_not_awake' });
    expect(await inboxRow(f)).toMatchObject({ delivery_intent: 'queue' });
  }
  const claimed = await runDueDelivery(f, Date.now() + config.retryMaxMs);
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
      recoverySourceTaskId: f.subscriptionId ? f.b.taskId : null,
      recoveryAttemptId: claim?.recovery_attempt_id,
      projectEventWakeGuard: f.subscriptionId
        ? { batchId: f.deliveryId, subscriptionId: f.subscriptionId }
        : null,
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

async function withHumanFollowup(run: (f: DeliveryFixture) => Promise<void>): Promise<void> {
  await withAgentMessageChannels(
    async () => {
      const f = await sleepingConversation();
      await withProjectDataEnv(
        f.stub,
        { ...EVENT_WAKE_FLAGS, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' },
        async () => {
          const cookie = await seedSignedInUser(f.memberId);
          const humanContent = 'Continue the original work and report the next result.';
          const response = await SELF.fetch(
            `https://api.test.example.com/api/projects/${f.projectId}/sessions/${f.b.sessionId}/prompt`,
            {
              method: 'POST',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: humanContent }),
            }
          );
          expect(response.status).toBe(202);
          const accepted = await response.json<{
            accepted: boolean;
            deliveryId: string;
            messageId: string;
          }>();
          expect(accepted.accepted).toBe(true);
          const wakes = await inboxRows(f.stub);
          expect(wakes).toHaveLength(1);
          expect(wakes[0]).toMatchObject({
            id: accepted.deliveryId,
            source_kind: 'user_followup',
            sender_type: 'human',
          });
          expect(
            await sqlRows(
              f.stub,
              'SELECT sender_id, delivery_intent FROM session_inbox WHERE id = ?',
              accepted.deliveryId
            )
          ).toEqual([{ sender_id: f.memberId, delivery_intent: 'queue' }]);
          await run({
            ...f,
            deliveryId: accepted.deliveryId,
            originalMessageId: accepted.messageId,
            humanContent,
          });
        }
      );
    },
    { DURABLE_PROMPT_DELIVERY_ENABLED: 'true' }
  );
}

/** The persisted identity accepted before placement runs; retries must not recreate it. */
async function acceptedIdentity(f: DeliveryFixture) {
  const rows = await sqlRows(
    f.stub,
    `SELECT id, prompt_message_id, target_session_id, source_task_id, content, expires_at,
            source_kind, sender_type, sender_id
       FROM session_inbox WHERE id = ?`,
    f.deliveryId
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** A live provider inventory, read through the real provider/catalog HTTP boundary. */
function installCatalogProvider() {
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith('https://api.hetzner.cloud/v1/server_types')) {
      return passthrough(input, init);
    }
    return Response.json({
      server_types: [
        { id: 1, name: 'cx23', description: 'CX23', cores: 2, memory: 4, disk: 40 },
        { id: 2, name: 'cx33', description: 'CX33', cores: 4, memory: 8, disk: 80 },
        { id: 3, name: 'cx43', description: 'CX43', cores: 8, memory: 16, disk: 160 },
      ].map((type) => ({
        ...type,
        architecture: 'x86',
        cpu_type: 'shared',
        deprecated: false,
        prices: ['nbg1', 'fsn1'].map((location) => ({
          location,
          price_hourly: { net: '0.0099', gross: '0.0099' },
          price_monthly: { net: '6.99', gross: '6.99' },
        })),
      })),
      meta: { pagination: { next_page: null } },
    });
  });
  clearCapacityCatalogCache();
}

async function blockWakeCatalog(f: DeliveryFixture, kind: 'bootstrap' | 'catalog-unavailable') {
  if (kind === 'bootstrap') {
    // The initial publication has not certified any catalog yet. Rows may already have
    // staged/materialized an initial prefix, but none is authority to place a VM.
    await env.DATABASE.prepare(
      `UPDATE capacity_pools SET configuration_state = 'migration-pending',
         migration_state = 'pending', catalog_published_at = NULL,
         selection_digest = NULL, last_reconciled_at = NULL
       WHERE scope = 'user' AND owner_user_id = ? AND is_default = 1`
    )
      .bind(f.memberId)
      .run();
  } else {
    await env.DATABASE.prepare(
      `UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'
       WHERE pool_id IN (SELECT id FROM capacity_pools
         WHERE scope = 'user' AND owner_user_id = ? AND is_default = 1)`
    )
      .bind(f.memberId)
      .run();
  }
  installCatalogProvider();
  const interrupted = await ensureDefaultCapacityPoolsForExistingCredentials(
    drizzle(env.DATABASE, { schema }) as never,
    {
      userId: f.memberId,
      projectId: f.projectId,
      includeInstallation: false,
      env: wakeEnv(),
      candidatePublishBatchSize: 1,
      candidatePublishBudgetMs: 0,
    }
  );
  expect(interrupted.user?.pool.migrationState).toBe('pending');
  const progress = await env.DATABASE.prepare(
    'SELECT state, next_attempt_at, deadline_at FROM capacity_pool_refreshes WHERE pool_id = ?'
  )
    .bind(interrupted.user!.pool.id)
    .first<{ state: string; next_attempt_at: number; deadline_at: number }>();
  expect(progress?.state).toBe('pending');
  expect(progress!.next_attempt_at).toBeLessThan(progress!.deadline_at);
  const cursorRow = await env.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
    .bind(
      candidatePublicationCursorKey(interrupted.user!.pool.id, interrupted.user!.sources[0]!.id)
    )
    .first<{ value: string }>();
  const cursor = JSON.parse(cursorRow!.value) as {
    digest: string;
    published: number;
    complete: boolean;
  };
  expect(cursor).toMatchObject({ published: 1, complete: false });
  // Completed publications retain staged proofs. Only this interrupted digest is the prefix
  // under test; older trustworthy catalogs must not be mistaken for exposed replacement rows.
  const staged = await env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM capacity_pool_candidate_staging WHERE pool_id = ? AND digest = ?'
  )
    .bind(interrupted.user!.pool.id, cursor.digest)
    .first<{ count: number }>();
  expect(staged?.count).toBe(1);
  if (f.subscriptionId) {
    expect(await runDueDelivery(f)).toMatchObject({
      kind: 'steer_fallback',
      reason: 'session_not_awake',
    });
  }
  const waiting = await runDueDelivery(f);
  expect(waiting).toMatchObject({
    kind: 'retry',
    reason: 'not_ready',
    error: expect.stringContaining('session_recovery_placement_transient'),
  });
  expect(await inboxRow(f)).toMatchObject({ delivery_state: 'retry_wait' });
  if (f.subscriptionId) expect(await batchState(f)).toBe('pending');
  expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'sleeping' });
  expect(await snapshotClaim(f.b.sessionId)).toMatchObject({
    recovery_status: null,
    recovery_task_id: null,
    recovery_attempt_id: null,
  });
}

async function publishRecoveredCatalog(f: DeliveryFixture) {
  const job = await env.DATABASE.prepare(
    `SELECT next_attempt_at FROM capacity_pool_refreshes
     WHERE scope = 'user' AND owner_user_id = ?`
  )
    .bind(f.memberId)
    .first<{ next_attempt_at: number }>();
  expect(job).not.toBeNull();
  const dueAt = job!.next_attempt_at + 1;
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ('capacityPools.scheduledReconciliation.lastRun.v1', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(new Date(dueAt).toISOString(), new Date(dueAt).toISOString())
    .run();
  // Simulate a fresh process: neither the provider cache nor an in-memory continuation survives.
  clearCapacityCatalogCache();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(dueAt);
  try {
    const scheduled = await runScheduledCapacityPoolReconciliation(wakeEnv());
    expect(scheduled).toMatchObject({
      skipped: false,
      skipReason: null,
      usersEnsured: 0,
      nextEligibleAt: new Date(dueAt + 24 * 60 * 60 * 1000).toISOString(),
    });
  } finally {
    clock.mockRestore();
  }
  const recovered = await env.DATABASE.prepare(
    `SELECT pool.migration_state, pool.catalog_published_at, refresh.state
     FROM capacity_pools pool JOIN capacity_pool_refreshes refresh ON refresh.pool_id = pool.id
     WHERE pool.scope = 'user' AND pool.owner_user_id = ?`
  )
    .bind(f.memberId)
    .first();
  expect(recovered).toMatchObject({
    migration_state: 'complete',
    catalog_published_at: expect.any(String),
    state: 'complete',
  });
}

describe('catalog blockers preserve the accepted VM wake', () => {
  it('keeps a previously published pool usable while a replacement publication is pending', async () => {
    await withEventWakes(async (f) => {
      const identity = await acceptedIdentity(f);
      await env.DATABASE.prepare(
        `UPDATE capacity_pools SET migration_state = 'pending'
         WHERE scope = 'user' AND owner_user_id = ? AND is_default = 1`
      )
        .bind(f.memberId)
        .run();

      const { alarm, vm } = await wakeToHeldRestore(f);
      expect(await acceptedIdentity(f)).toEqual(identity);
      vm.releaseRestore();
      await alarm;
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'in_progress' });
      expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
        kind: 'accepted',
      });
      expect(vm.prompts()).toHaveLength(1);
      expect(vm.prompts()[0]?.body?.deliveryId).toBe(identity.id);
      expect(await batchState(f)).toBe('delivered');
      expect(vm.stops()).toEqual([]);
    });
  });

  it.each(['bootstrap', 'catalog-unavailable', 'human-user_followup'] as const)(
    'retries %s across ProjectData eviction, then delivers the original accepted prompt once after publication',
    async (kind) => {
      const withAcceptedWake = kind === 'human-user_followup' ? withHumanFollowup : withEventWakes;
      await withAcceptedWake(async (f) => {
        const identity = await acceptedIdentity(f);
        if (f.humanContent) {
          expect(identity).toMatchObject({
            source_kind: 'user_followup',
            sender_type: 'human',
            sender_id: f.memberId,
            source_task_id: null,
            content: f.humanContent,
            prompt_message_id: f.originalMessageId,
          });
        }
        // The production incident's persisted reservation fits ordinary offerings easily.
        await env.DATABASE.prepare('UPDATE tasks SET resolved_reservation_json = ? WHERE id = ?')
          .bind(
            JSON.stringify({
              version: 3,
              cpuMillis: 400,
              memoryMb: 820,
              diskMb: 2048,
              exclusiveNode: false,
              source: 'task',
              sourceId: f.b.taskId,
            }),
            f.b.taskId
          )
          .run();
        await blockWakeCatalog(f, kind === 'human-user_followup' ? 'catalog-unavailable' : kind);

        // Each pass reconstructs the production adapter and reads durable D1 + SQLite,
        // including more waits than the submission attempt cap. No human sends Continue.
        for (let retry = 1; retry <= config.maxAttempts + 1; retry++) {
          expect(await runDueDelivery(f, Date.now() + retry * config.retryMaxMs)).toMatchObject({
            kind: 'retry',
            reason: 'not_ready',
          });
        }
        expect(await acceptedIdentity(f)).toEqual(identity);
        expect(await inboxRow(f)).toMatchObject({
          delivery_state: 'retry_wait',
          delivery_attempts: config.maxAttempts - 1,
        });
        await evictDurableObject(f.stub);
        await runInDurableObject(f.stub, async (instance, state) => {
          pauseAlarms(state.storage);
          await state.storage.deleteAlarm();
          Object.assign((instance as unknown as { env: Env }).env, EVENT_WAKE_FLAGS);
        });
        expect(await acceptedIdentity(f)).toEqual(identity);
        if (f.subscriptionId) expect(await batchState(f)).toBe('pending');
        expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
          kind: 'retry',
          reason: 'not_ready',
        });

        await publishRecoveredCatalog(f);
        const { alarm, vm } = await wakeToHeldRestore(f, true);
        try {
          // A second claim while the first runtime restores joins that same snapshot attempt.
          const claim = await snapshotClaim(f.b.sessionId);
          expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
            kind: 'retry',
            reason: 'not_ready',
          });
          expect(await snapshotClaim(f.b.sessionId)).toEqual(claim);
          const claimedAttempts = await env.DATABASE.prepare(
            'SELECT recovery_attempts FROM session_snapshots WHERE chat_session_id = ?'
          )
            .bind(f.b.sessionId)
            .first<{ recovery_attempts: number }>();
          expect(claimedAttempts?.recovery_attempts).toBe(1);
          expect(vm.prompts()).toEqual([]);
          expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'delegated' });
          expect(
            await sqlRows(f.stub, 'SELECT status FROM chat_sessions WHERE id = ?', f.b.sessionId)
          ).toEqual([{ status: 'sleeping' }]);
        } finally {
          // A failed midpoint invariant must still release the controlled VM request, or
          // the outstanding runner alarm can mask the assertion during Workers teardown.
          vm.releaseRestore();
          await alarm;
        }
        expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'in_progress' });
        expect(
          await sqlRows(f.stub, 'SELECT status FROM chat_sessions WHERE id = ?', f.b.sessionId)
        ).toEqual([{ status: 'active' }]);
        expect(await runDueDelivery(f, Date.now() + config.retryMaxMs)).toMatchObject({
          kind: 'accepted',
        });
        expect(await acceptedIdentity(f)).toEqual(identity);
        expect(vm.prompts()).toHaveLength(1);
        expect(vm.prompts()[0]?.body?.deliveryId).toBe(identity.id);
        expect(await runDueDelivery(f, Date.now() + config.retryMaxMs * 2)).toBeNull();
        if (f.subscriptionId) expect(await batchState(f)).toBe('delivered');
        if (f.humanContent) expect(vm.prompts()[0]?.body?.prompt).toBe(f.humanContent);
        expect(vm.stops()).toEqual([]);
        const rows = await sqlRows(
          f.stub,
          'SELECT id FROM chat_messages WHERE id = ?',
          identity.prompt_message_id
        );
        expect(rows).toHaveLength(1);
        const attempts = await env.DATABASE.prepare(
          'SELECT recovery_attempts FROM session_snapshots WHERE chat_session_id = ?'
        )
          .bind(f.b.sessionId)
          .first<{ recovery_attempts: number }>();
        // A committed successful restore resets the failed-attempt budget.
        expect(attempts?.recovery_attempts).toBe(0);
      });
    }
  );

  it.each(['cancelled', 'expired', 'archived', 'membership-revoked'] as const)(
    'does not resurrect a %s accepted wake when publication recovers',
    async (terminal) => {
      await withEventWakes(async (f) => {
        const identity = await acceptedIdentity(f);
        await blockWakeCatalog(f, 'bootstrap');
        if (terminal === 'cancelled') {
          await env.DATABASE.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?")
            .bind(f.b.taskId)
            .run();
        } else if (terminal === 'expired') {
          await sqlRows(
            f.stub,
            'UPDATE session_inbox SET expires_at = ? WHERE id = ?',
            Date.now() - 1,
            f.deliveryId
          );
          await runInDurableObject(f.stub, async (instance, state) => {
            const pending: Promise<unknown>[] = [];
            processPromptDeliveryAlarm(
              state.storage.sql,
              {
                ...(instance as unknown as { env: Env }).env,
                DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
              },
              {
                getProjectId: () => f.projectId,
                transactionSync: (callback) => state.storage.transactionSync(callback),
                waitUntil: (promise) => pending.push(promise),
                recalculateAlarm: async () => undefined,
                scheduleSummarySync: () => undefined,
                broadcastEvent: () => undefined,
                armIdleCleanup: () => undefined,
                nudgeDeliveries: () => 0,
              }
            );
            await Promise.all(pending);
          });
          const markers = await sqlRows(
            f.stub,
            `SELECT reason, metadata FROM session_attention_markers
             WHERE session_id = ? AND kind = 'wake_failed'`,
            f.b.sessionId
          );
          expect(markers).toHaveLength(1);
          expect(markers[0]?.reason).toBe('ttl_expired');
          expect(JSON.parse(String(markers[0]?.metadata))).toMatchObject({
            deliveryId: f.deliveryId,
          });
        } else if (terminal === 'archived') {
          await sqlRows(
            f.stub,
            "UPDATE chat_sessions SET status = 'archived' WHERE id = ?",
            f.b.sessionId
          );
        } else {
          await env.DATABASE.prepare(
            'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
          )
            .bind(f.projectId, f.memberId)
            .run();
        }
        await publishRecoveredCatalog(f);
        const result = await runDueDelivery(f, Date.now() + config.retryMaxMs);
        if (terminal !== 'expired') {
          expect(result).toMatchObject({ kind: 'failed', reason: 'terminal_target' });
          expect(await inboxRow(f)).toMatchObject({ delivery_state: 'failed' });
          expect(await taskRow(f.b.taskId)).toMatchObject({
            status: terminal === 'cancelled' ? 'cancelled' : 'sleeping',
          });
        } else {
          expect(result).toBeNull();
          expect(await inboxRow(f)).toMatchObject({ delivery_state: 'expired' });
          expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'sleeping' });
        }
        expect(await snapshotClaim(f.b.sessionId)).toMatchObject({
          recovery_task_id: null,
          recovery_attempt_id: null,
        });
        expect((await acceptedIdentity(f)).id).toBe(identity.id);
      });
    }
  );

  it.each([
    { change: 'source-disabled', reason: 'placement_sources_disabled' },
    { change: 'credential-revoked', reason: 'placement_credentials_missing' },
    { change: 'offerings-removed', reason: 'placement_pool_empty' },
  ])(
    'immediately respects $change while keeping a published catalog',
    async ({ change, reason }) => {
      await withEventWakes(async (f) => {
        await env.DATABASE.prepare(
          `UPDATE capacity_pools SET migration_state = 'pending'
         WHERE scope = 'user' AND owner_user_id = ? AND is_default = 1`
        )
          .bind(f.memberId)
          .run();
        if (change === 'source-disabled') {
          await env.DATABASE.prepare(
            "UPDATE capacity_sources SET status = 'disabled' WHERE owner_user_id = ?"
          )
            .bind(f.memberId)
            .run();
        } else if (change === 'credential-revoked') {
          await env.DATABASE.prepare('UPDATE credentials SET is_active = 0 WHERE user_id = ?')
            .bind(f.memberId)
            .run();
        } else {
          await env.DATABASE.prepare(
            `UPDATE capacity_pool_candidates SET status = 'deleted'
           WHERE pool_id IN (SELECT id FROM capacity_pools WHERE owner_user_id = ?)`
          )
            .bind(f.memberId)
            .run();
        }
        expect(await runDueDelivery(f)).toMatchObject({ kind: 'steer_fallback' });
        expect(await runDueDelivery(f)).toMatchObject({
          kind: 'failed',
          reason: 'wake_refused',
          error: expect.stringContaining(reason),
        });
        expect(await inboxRow(f)).toMatchObject({ delivery_state: 'failed' });
        expect(await snapshotClaim(f.b.sessionId)).toMatchObject({ recovery_task_id: null });
      });
    }
  );

  it('reports requirements no published offering can satisfy as a terminal actionable failure', async () => {
    await withEventWakes(async (f) => {
      await env.DATABASE.prepare(
        `UPDATE tasks SET resource_requirements_json = ?, resource_requirements_source = 'task',
           requested_vm_size_source = 'session-recovery'
         WHERE id = ?`
      )
        .bind(JSON.stringify({ minVcpu: 9999, minMemoryGb: 9999 }), f.b.taskId)
        .run();
      expect(await runDueDelivery(f)).toMatchObject({ kind: 'steer_fallback' });
      expect(await runDueDelivery(f)).toMatchObject({
        kind: 'failed',
        reason: 'wake_refused',
        error: expect.stringContaining('placement_unsatisfiable'),
      });
      expect(await inboxRow(f)).toMatchObject({ delivery_state: 'failed' });
      expect(await taskRow(f.b.taskId)).toMatchObject({ status: 'sleeping' });
      expect(await snapshotClaim(f.b.sessionId)).toMatchObject({ recovery_task_id: null });
    });
  });
});

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
  // container's per-request guard does not. A batch the wake prompt delivered
  // (`prompt_queue`) is accepted as well as one the agent read (`pull`): revoking a live wake
  // whose prompt is already running would kill that turn, which is the incident itself.
  it.each([
    { state: 'pending', via: null, strict: true, liveWake: true },
    { state: 'delivered', via: 'pull', strict: false, liveWake: true },
    { state: 'delivered', via: 'prompt_queue', strict: false, liveWake: true },
    { state: 'acked', via: 'pull', strict: false, liveWake: true },
    { state: 'cancelled', via: null, strict: false, liveWake: false },
    { state: 'expired', via: null, strict: false, liveWake: false },
    { state: 'failed', via: 'prompt_queue', strict: false, liveWake: false },
    { state: 'ambiguous', via: 'prompt_queue', strict: false, liveWake: false },
  ])(
    '$state batch (via $via): strict=$strict, live wake=$liveWake',
    async ({ state, via, strict, liveWake }) => {
      await withEventWakes(async (f) => {
        await sqlRows(
          f.stub,
          'UPDATE project_event_delivery_batches SET state = ?, delivered_via = ? WHERE id = ?',
          state,
          via,
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
    }
  );

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
