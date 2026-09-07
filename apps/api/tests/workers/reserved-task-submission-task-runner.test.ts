import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import { fetchNodeAgent } from '../../src/services/node-agent';
import * as projectDataService from '../../src/services/project-data';
import {
  reservedIdentitiesForTriggerExecution,
  submitReservedTask,
} from '../../src/services/reserved-task-submission';
import type {
  ReservedTaskSubmissionDependencies,
  ReservedTaskSubmissionInput,
} from '../../src/services/reserved-task-submission-contracts';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from '../../src/services/task-runner-do';
import {
  assertTaskRunnerStartGuard,
  type TaskRunnerReservedSubmissionGuard,
} from '../../src/services/task-runner-start-guard';
import { reserveWorkspacePlacement } from '../../src/services/workspace-placement';
import { seedInstallation, seedNode, seedProject, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
type TaskRunnerStartBoundaryInput = Parameters<typeof startTaskRunnerDO>[1];

let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function taskRunnerStub(taskId: string): DurableObjectStub<TaskRunner> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  return env.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>;
}

async function runTaskRunnerAlarm(taskId: string): Promise<void> {
  const stub = taskRunnerStub(taskId);
  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
  });
}

async function makeReadyNode(nodeId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await seedNode(nodeId, userId, {
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'running',
    healthStatus: 'healthy',
    lastHeartbeatAt: now,
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
        SET agent_ready_at = ?,
            agent_version = ?,
            runtime = 'vm',
            node_role = 'workspace',
            last_metrics = ?
      WHERE id = ?`
  )
    .bind(now, 'current-sha', JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 10 }), nodeId)
    .run();
}

async function seedReservedFixture(label: string): Promise<{
  userId: string;
  installationId: string;
  projectId: string;
  repository: string;
  triggerId: string;
  executionId: string;
  input: ReservedTaskSubmissionInput;
}> {
  const suffix = unique(label);
  const userId = `user-${suffix}`;
  const installationId = `installation-${suffix}`;
  const projectId = `project-${suffix}`;
  const repository = `acme/${suffix}`;
  const triggerId = `trigger-${suffix}`;
  const executionId = `exec-${suffix}`;
  const prompt = `Run reserved task from ${label} with a real ProjectData session and TaskRunner DO boundary.`;
  const timestamp = new Date().toISOString();

  await seedUser(userId, {
    githubId: `gh-${suffix}`,
    email: `${suffix}@example.com`,
    name: `User ${suffix}`,
  });
  await seedInstallation(installationId, userId, {
    installationIdValue: `external-${suffix}`,
    accountName: `acct-${suffix}`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `Project ${suffix}`,
    repository,
  });
  await env.DATABASE.prepare(
    `UPDATE projects
        SET default_provider = 'hetzner',
            default_location = 'nbg1',
            default_vm_size = 'small',
            default_branch = 'main',
            default_agent_type = 'opencode',
            max_workspaces_per_node = 2
      WHERE id = ?`
  )
    .bind(projectId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO credentials (
       id, user_id, project_id, provider, credential_type, credential_kind, is_active,
       encrypted_token, iv, created_at, updated_at
     ) VALUES (?, ?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
  )
    .bind(
      `credential-${suffix}`,
      userId,
      projectId,
      `encrypted-token-${suffix}`,
      `iv-${suffix}`,
      timestamp,
      timestamp
    )
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO triggers (
       id, project_id, user_id, name, status, source_type, prompt_template, task_mode,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'Reserved trigger', 'active', 'cron', ?, 'task', ?, ?)`
  )
    .bind(triggerId, projectId, userId, prompt, timestamp, timestamp)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO trigger_executions (
       id, trigger_id, project_id, status, rendered_prompt, scheduled_at, sequence_number,
       created_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, 1, ?)`
  )
    .bind(executionId, triggerId, projectId, prompt, timestamp, timestamp)
    .run();

  const input: ReservedTaskSubmissionInput = {
    identities: reservedIdentitiesForTriggerExecution(executionId),
    projectId,
    userId,
    prompt,
    branchNameSeed: 'Reserved Trigger',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    source: {
      kind: 'trigger',
      sourceId: triggerId,
      sourceExecutionId: executionId,
      triggeredBy: 'cron',
      displayName: 'Reserved Trigger',
      repositoryAccessFlow: 'trigger-cron',
      initialStatusReason: `Triggered by cron (trigger: ${triggerId})`,
      initialStatusActorType: 'system',
      initialStatusActorId: null,
      triggerId,
      triggerExecutionId: executionId,
    },
  };

  return { userId, installationId, projectId, repository, triggerId, executionId, input };
}

function submissionDeps(): ReservedTaskSubmissionDependencies {
  return {
    generateTitle: vi.fn(async () => 'Reserved task title'),
    requireRepositoryAccess: vi.fn(async () => undefined) as NonNullable<
      ReservedTaskSubmissionDependencies['requireRepositoryAccess']
    >,
    startTaskRunner: vi.fn(startPausedTaskRunner) as typeof startTaskRunnerDO,
  };
}

function capturedStartInput(deps: ReservedTaskSubmissionDependencies): TaskRunnerStartBoundaryInput {
  const startMock = deps.startTaskRunner as ReturnType<typeof vi.fn>;
  const call = startMock.mock.calls[0] as [Env, TaskRunnerStartBoundaryInput] | undefined;
  if (!call) throw new Error('TaskRunner start was not captured');
  return call[1];
}

function capturedStartGuard(deps: ReservedTaskSubmissionDependencies): TaskRunnerReservedSubmissionGuard {
  const guard = capturedStartInput(deps).startGuard;
  if (!guard || guard.kind !== 'reserved_submission') {
    throw new Error('Reserved TaskRunner start guard was not captured');
  }
  return guard;
}

function toTaskRunnerStartInput(input: TaskRunnerStartBoundaryInput): StartTaskInput {
  const initialCapacityCandidate = input.capacityPoolSelection?.candidates[0] ?? null;
  return {
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    config: {
      vmSize: input.vmSize,
      vmLocation: initialCapacityCandidate?.location ?? input.vmLocation,
      branch: input.branch,
      defaultBranch: input.defaultBranch ?? input.branch,
      preferredNodeId: input.preferredNodeId ?? null,
      userName: input.userName ?? null,
      userEmail: input.userEmail ?? null,
      githubId: input.githubId ?? null,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription ?? null,
      repository: input.repository,
      installationId: input.installationId,
      outputBranch: input.outputBranch ?? null,
      projectDefaultVmSize: input.projectDefaultVmSize ?? null,
      chatSessionId: input.chatSessionId ?? null,
      agentType: input.agentType ?? null,
      workspaceProfile: input.workspaceProfile ?? null,
      devcontainerConfigName: input.devcontainerConfigName ?? null,
      cloudProvider: initialCapacityCandidate?.provider ?? input.cloudProvider ?? null,
      providerInstanceType: initialCapacityCandidate?.providerInstanceType ?? null,
      credentialAttributionUserId: input.credentialAttributionUserId ?? input.userId,
      credentialAttributionProjectId:
        (input.credentialAttributionSource ??
          initialCapacityCandidate?.credentialAttributionSource) === 'project'
          ? (input.credentialAttributionProjectId ??
            initialCapacityCandidate?.capacityPoolProjectId ??
            input.projectId)
          : null,
      credentialAttributionSource:
        input.credentialAttributionSource ??
        initialCapacityCandidate?.credentialAttributionSource ??
        'user',
      taskMode: input.taskMode ?? 'task',
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? null,
      opencodeProvider: input.opencodeProvider ?? null,
      opencodeBaseUrl: input.opencodeBaseUrl ?? null,
      systemPromptAppend: input.systemPromptAppend ?? null,
      agentProfileHint: input.agentProfileHint ?? null,
      attachments: input.attachments ?? null,
      projectScaling: input.projectScaling ?? null,
      resourceRequirements: input.resourceRequirements ?? null,
      resolvedReservation: input.resolvedReservation ?? null,
      capacityPoolSelection: input.capacityPoolSelection ?? null,
      vmSizeSource: input.vmSizeSource ?? null,
      resumeSnapshotChatSessionId: input.resumeSnapshotChatSessionId ?? null,
      recoverySourceTaskId: input.recoverySourceTaskId ?? null,
      retrySourceTaskId: input.retrySourceTaskId ?? null,
      startGuard: input.startGuard ?? null,
    },
  };
}

async function startPausedTaskRunner(
  _env: Env,
  input: TaskRunnerStartBoundaryInput
): Promise<void> {
  const stub = taskRunnerStub(input.taskId);
  const startInput = toTaskRunnerStartInput(input);

  await runInDurableObject(stub, async (instance) => {
    await instance.start(startInput);
    await instance.ctx.storage.deleteAlarm();
  });
}

async function submitFixture(
  fixture: Awaited<ReturnType<typeof seedReservedFixture>>,
  deps = submissionDeps()
): Promise<void> {
  await expect(submitReservedTask(testEnv, fixture.input, deps)).resolves.toMatchObject({
    outcome: 'admitted',
    taskId: fixture.input.identities.taskId,
    sessionId: fixture.input.identities.chatSessionId,
  });
}

async function taskCounts(taskId: string): Promise<{
  tasks: number;
  checkpoints: number;
  statusEvents: number;
  initialStatusEvents: number;
  workspaces: number;
}> {
  const row = await env.DATABASE.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE id = ?) AS tasks,
       (SELECT COUNT(*) FROM task_submission_checkpoints WHERE task_id = ?) AS checkpoints,
       (SELECT COUNT(*) FROM task_status_events WHERE task_id = ?) AS statusEvents,
       (SELECT COUNT(*) FROM task_status_events
         WHERE task_id = ? AND id = (SELECT initial_status_event_id FROM task_submission_checkpoints WHERE task_id = ?)
       ) AS initialStatusEvents,
       (SELECT COUNT(*) FROM workspaces WHERE chat_session_id = (SELECT chat_session_id FROM tasks WHERE id = ?)) AS workspaces`
  )
    .bind(taskId, taskId, taskId, taskId, taskId, taskId)
    .first<{
      tasks: number;
      checkpoints: number;
      statusEvents: number;
      initialStatusEvents: number;
      workspaces: number;
    }>();
  if (!row) throw new Error(`Missing count row for ${taskId}`);
  return row;
}

async function taskRow(taskId: string): Promise<{
  status: string;
  execution_step: string | null;
  workspace_id: string | null;
  error_message: string | null;
}> {
  const row = await env.DATABASE.prepare(
    `SELECT status, execution_step, workspace_id, error_message FROM tasks WHERE id = ?`
  )
    .bind(taskId)
    .first<{
      status: string;
      execution_step: string | null;
      workspace_id: string | null;
      error_message: string | null;
    }>();
  if (!row) throw new Error(`Missing task row ${taskId}`);
  return row;
}

async function cancelTask(taskId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `UPDATE tasks
        SET status = 'cancelled', completed_at = ?, error_message = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(now, reason, now, taskId)
    .run();
}

async function workspaceRowsForFixture(
  fixture: Awaited<ReturnType<typeof seedReservedFixture>>
): Promise<Array<{ id: string; status: string; chat_session_id: string | null }>> {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, status, chat_session_id
       FROM workspaces
      WHERE project_id = ?
        AND user_id = ?
        AND chat_session_id = ?
      ORDER BY created_at, id`
  )
    .bind(fixture.projectId, fixture.userId, fixture.input.identities.chatSessionId)
    .all<{ id: string; status: string; chat_session_id: string | null }>();
  return results ?? [];
}

async function allWorkspaceRowsForFixture(
  fixture: Awaited<ReturnType<typeof seedReservedFixture>>
): Promise<Array<{ id: string; status: string; chat_session_id: string | null }>> {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, status, chat_session_id
       FROM workspaces
      WHERE project_id = ?
        AND user_id = ?
        AND repository = ?
      ORDER BY created_at, id`
  )
    .bind(fixture.projectId, fixture.userId, fixture.repository)
    .all<{ id: string; status: string; chat_session_id: string | null }>();
  return results ?? [];
}

async function reservedRevocationRowsForFixture(
  fixture: Awaited<ReturnType<typeof seedReservedFixture>>
): Promise<
  Array<{ task_id: string; reason: string; source: string; chat_session_id: string }>
> {
  const { results } = await env.DATABASE.prepare(
    `SELECT task_id, reason, source, chat_session_id
       FROM reserved_task_session_revocations
      WHERE project_id = ?
        AND chat_session_id = ?
      ORDER BY revoked_at, task_id`
  )
    .bind(fixture.projectId, fixture.input.identities.chatSessionId)
    .all<{ task_id: string; reason: string; source: string; chat_session_id: string }>();
  return results ?? [];
}

function installNodeAgentFetchRecorder(): Array<{
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
}> {
  const calls: Array<{ method: string; pathname: string; body: Record<string, unknown> | null }> =
    [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init);
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : '';
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
    const url = new URL(request.url);
    calls.push({ method: request.method, pathname: url.pathname, body });

    if (url.pathname === '/workspaces') {
      return new Response(JSON.stringify({ workspaceId: body?.workspaceId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

async function reserveOrphanWorkspaceAllocation(
  fixture: Awaited<ReturnType<typeof seedReservedFixture>>,
  nodeId: string,
  workspaceId: string
): Promise<void> {
  const checkpoint = await env.DATABASE.prepare(
    `SELECT intent_fingerprint FROM task_submission_checkpoints WHERE task_id = ?`
  )
    .bind(fixture.input.identities.taskId)
    .first<{ intent_fingerprint: string }>();
  if (!checkpoint) throw new Error('Missing reserved checkpoint');

  await expect(
    reserveWorkspacePlacement(
      env.DATABASE,
      {
        id: workspaceId,
        nodeId,
        projectId: fixture.projectId,
        userId: fixture.userId,
        installationId: fixture.installationId,
        name: 'Recovered orphan workspace',
        displayName: 'Recovered orphan workspace',
        normalizedDisplayName: `recovered-${fixture.executionId}`,
        repository: fixture.repository,
        branch: 'main',
        chatSessionId: fixture.input.identities.chatSessionId,
        vmSize: 'small',
        vmLocation: 'nbg1',
        workspaceProfile: 'full',
        devcontainerConfigName: null,
        agentProfileHint: null,
        capacityPlacementSnapshot: null,
        taskLifecycleGuard: {
          taskId: fixture.input.identities.taskId,
          projectId: fixture.projectId,
          userId: fixture.userId,
          chatSessionId: fixture.input.identities.chatSessionId,
          requireChatSessionMatch: true,
          reservedIntentFingerprint: checkpoint.intent_fingerprint,
        },
        createdAt: new Date().toISOString(),
      },
      2
    )
  ).resolves.toBe(true);
}

describe('reserved submission adapter and TaskRunner durable fencing', () => {
  it('converges concurrent same-intent submissions to one physical allocation and one initial prompt', async () => {
    const fixture = await seedReservedFixture('same-intent-taskrunner');
    await makeReadyNode(`node-${fixture.executionId}`, fixture.userId);
    const deps = submissionDeps();

    const [first, second] = await Promise.all([
      submitReservedTask(testEnv, fixture.input, deps),
      submitReservedTask(testEnv, fixture.input, deps),
    ]);

    expect([first.outcome, second.outcome]).toEqual(['admitted', 'admitted']);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    const counts = await taskCounts(fixture.input.identities.taskId);
    expect(counts).toEqual({
      tasks: 1,
      checkpoints: 1,
      statusEvents: 2,
      initialStatusEvents: 1,
      workspaces: 1,
    });
    const messages = await projectDataService.getMessages(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      id: fixture.input.identities.initialMessageId,
      role: 'user',
      content: fixture.input.prompt,
    });
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'delegated',
      execution_step: 'workspace_creation',
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_dispatch',
      stepResults: { workspaceId: expect.any(String) },
    });
    expect(await workspaceRowsForFixture(fixture)).toEqual([
      {
        id: expect.any(String),
        status: 'creating',
        chat_session_id: fixture.input.identities.chatSessionId,
      },
    ]);
  });

  it('deduplicates overlapping real TaskRunner first-start calls before allocation', async () => {
    const fixture = await seedReservedFixture('overlapping-starts');
    const capturedStarts: TaskRunnerStartBoundaryInput[] = [];
    const deps = {
      ...submissionDeps(),
      startTaskRunner: vi.fn(async (_env: Env, input: TaskRunnerStartBoundaryInput) => {
        capturedStarts.push(input);
        throw new Error('lost before TaskRunner durable start');
      }) as typeof startTaskRunnerDO,
    } satisfies ReservedTaskSubmissionDependencies;

    await expect(submitReservedTask(testEnv, fixture.input, deps)).resolves.toMatchObject({
      outcome: 'pending',
      pendingAt: 'task_runner_start',
    });
    expect(capturedStarts).toHaveLength(1);

    const taskStart = toTaskRunnerStartInput(capturedStarts[0]!);
    const stub = taskRunnerStub(fixture.input.identities.taskId);
    await runInDurableObject(stub, async (instance) => {
      await Promise.all([instance.start(taskStart), instance.start(taskStart)]);
      await instance.ctx.storage.deleteAlarm();
    });
    expect(await stub.getStatus()).toMatchObject({
      taskId: fixture.input.identities.taskId,
      currentStep: 'node_selection',
    });

    expect(await workspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({ status: 'queued' });
  });

  it('converges a lost production TaskRunner acknowledgement on retry without duplicate effects', async () => {
    const fixture = await seedReservedFixture('real-lost-ack-retry');
    const deps = {
      ...submissionDeps(),
      startTaskRunner: vi.fn(async (workerEnv: Env, input: TaskRunnerStartBoundaryInput) => {
        await startTaskRunnerDO(workerEnv, input);
        await runInDurableObject(taskRunnerStub(input.taskId), async (instance) => {
          await instance.ctx.storage.deleteAlarm();
        });
        throw new Error('lost acknowledgement after durable TaskRunner start');
      }) as typeof startTaskRunnerDO,
      ensureTaskRunnerStarted: vi
        .fn()
        .mockRejectedValueOnce(new Error('TaskRunner status temporarily unavailable'))
        .mockImplementation(async (workerEnv: Env, taskId: string) =>
          ensureTaskRunnerStarted(workerEnv, taskId)
        ),
    } satisfies ReservedTaskSubmissionDependencies;

    const first = await submitReservedTask(testEnv, fixture.input, deps);
    const retry = await submitReservedTask(testEnv, fixture.input, deps);

    await runInDurableObject(taskRunnerStub(fixture.input.identities.taskId), async (instance) => {
      await instance.ctx.storage.deleteAlarm();
    });

    expect(first).toMatchObject({ outcome: 'pending', pendingAt: 'task_runner_start' });
    expect(retry).toMatchObject({
      outcome: 'admitted',
      startState: 'confirmed_after_lost_ack',
    });
    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    expect(deps.ensureTaskRunnerStarted).toHaveBeenCalledTimes(2);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskCounts(fixture.input.identities.taskId)).toMatchObject({
      tasks: 1,
      checkpoints: 1,
      initialStatusEvents: 1,
      workspaces: 0,
    });
    const messages = await projectDataService.getMessages(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      id: fixture.input.identities.initialMessageId,
      content: fixture.input.prompt,
    });
  });

  it('does not allocate physical resources when the task is cancelled after TaskRunner start', async () => {
    const fixture = await seedReservedFixture('cancel-after-start');
    await makeReadyNode(`node-${fixture.executionId}`, fixture.userId);
    await submitFixture(fixture);

    await cancelTask(fixture.input.identities.taskId, 'cancelled after TaskRunner start');
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'cancelled',
      workspace_id: null,
    });
    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'node_selection',
    });
  });

  it('fences task cancellation after D1 admission before TaskRunner start', async () => {
    const fixture = await seedReservedFixture('cancel-after-d1');
    const deps = {
      ...submissionDeps(),
      afterD1Commit: async () => {
        await cancelTask(fixture.input.identities.taskId, 'cancelled after D1 admission');
      },
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'authority_unavailable',
      message: expect.stringContaining('cancelled'),
    });
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'cancelled',
      workspace_id: null,
    });
    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('fences task cancellation after ProjectData commit before TaskRunner start', async () => {
    const fixture = await seedReservedFixture('cancel-after-projectdata');
    const deps = {
      ...submissionDeps(),
      afterProjectDataCommit: async () => {
        await cancelTask(fixture.input.identities.taskId, 'cancelled after ProjectData commit');
      },
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'authority_unavailable',
      message: expect.stringContaining('cancelled'),
    });
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'cancelled',
      workspace_id: null,
    });
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('fences task cancellation after adapter revalidation through the production start bridge', async () => {
    const fixture = await seedReservedFixture('cancel-during-production-start');
    const deps = {
      ...submissionDeps(),
      startTaskRunner: vi.fn(async (workerEnv: Env, input: TaskRunnerStartBoundaryInput) => {
        await cancelTask(fixture.input.identities.taskId, 'cancelled during production start');
        await startTaskRunnerDO(workerEnv, input);
      }) as typeof startTaskRunnerDO,
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'terminal',
      status: 'cancelled',
      reason: 'cancelled during production start',
    });
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('fences session archive after adapter revalidation through the production start bridge', async () => {
    const fixture = await seedReservedFixture('archive-during-production-start');
    const deps = {
      ...submissionDeps(),
      startTaskRunner: vi.fn(async (workerEnv: Env, input: TaskRunnerStartBoundaryInput) => {
        await projectDataService.stopSession(
          testEnv,
          fixture.projectId,
          fixture.input.identities.chatSessionId
        );
        await startTaskRunnerDO(workerEnv, input);
      }) as typeof startTaskRunnerDO,
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(deps.startTaskRunner).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'authority_unavailable',
      message: expect.stringContaining('session_stopped'),
    });
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('rejects unsupported or mismatched reserved start guards before initialization', async () => {
    const fixture = await seedReservedFixture('invalid-start-guard');
    const deps = submissionDeps();
    await submitFixture(fixture, deps);
    const startInput = toTaskRunnerStartInput(capturedStartInput(deps));
    const unsupportedInput: StartTaskInput = {
      ...startInput,
      taskId: `${startInput.taskId}-unsupported`,
      config: {
        ...startInput.config,
        startGuard: { kind: 'other_guard' } as unknown as TaskRunnerReservedSubmissionGuard,
      },
    };
    await expect(
      runInDurableObject(taskRunnerStub(unsupportedInput.taskId), (instance) =>
        instance.start(unsupportedInput)
      )
    ).rejects.toThrow('Unsupported TaskRunner start guard kind');
    await expect(taskRunnerStub(unsupportedInput.taskId).getStatus()).resolves.toBeNull();

    const mismatchedInput: StartTaskInput = {
      ...startInput,
      taskId: `${startInput.taskId}-mismatch`,
    };
    await expect(
      runInDurableObject(taskRunnerStub(mismatchedInput.taskId), (instance) =>
        instance.start(mismatchedInput)
      )
    ).rejects.toThrow('does not match TaskRunner');
    await expect(taskRunnerStub(mismatchedInput.taskId).getStatus()).resolves.toBeNull();
  });

  it('rereads D1 authority after the final ProjectData session await before VM fetch', async () => {
    const fixture = await seedReservedFixture('cancel-during-final-session-read');
    const nodeId = `node-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    const deps = submissionDeps();
    await submitFixture(fixture, deps);
    const guard = capturedStartGuard(deps);
    const sessionLookupStarted = deferred<void>();
    const releaseSessionLookup = deferred<void>();
    vi.spyOn(projectDataService, 'getSession').mockImplementationOnce(async () => {
      sessionLookupStarted.resolve();
      await releaseSessionLookup.promise;
      return {
        id: fixture.input.identities.chatSessionId,
        status: 'active',
        taskId: fixture.input.identities.taskId,
        createdByUserId: fixture.userId,
      };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = fetchNodeAgent(
      nodeId,
      testEnv,
      `https://${nodeId}.vm.example.test/health`,
      { method: 'GET' },
      1_000,
      {
        beforeExternalMutation: () => assertTaskRunnerStartGuard(testEnv, guard),
      }
    );

    await sessionLookupStarted.promise;
    await cancelTask(fixture.input.identities.taskId, 'cancelled during final session read');
    releaseSessionLookup.resolve();

    await expect(request).rejects.toThrow('cancelled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rereads D1 archive revocation after the final ProjectData session await before VM fetch', async () => {
    const fixture = await seedReservedFixture('archive-during-final-session-read');
    const nodeId = `node-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    const deps = submissionDeps();
    await submitFixture(fixture, deps);
    const guard = capturedStartGuard(deps);
    const sessionLookupStarted = deferred<void>();
    const releaseSessionLookup = deferred<void>();
    vi.spyOn(projectDataService, 'getSession').mockImplementationOnce(async () => {
      sessionLookupStarted.resolve();
      await releaseSessionLookup.promise;
      return {
        id: fixture.input.identities.chatSessionId,
        status: 'active',
        taskId: fixture.input.identities.taskId,
        createdByUserId: fixture.userId,
      };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = fetchNodeAgent(
      nodeId,
      testEnv,
      `https://${nodeId}.vm.example.test/health`,
      { method: 'GET' },
      1_000,
      {
        beforeExternalMutation: () => assertTaskRunnerStartGuard(testEnv, guard),
      }
    );

    await sessionLookupStarted.promise;
    await projectDataService.stopSession(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId
    );
    releaseSessionLookup.resolve();

    await expect(request).rejects.toThrow('session_stopped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies the same start guard before cf-container transport dispatch', async () => {
    const fixture = await seedReservedFixture('container-transport-final-guard');
    const nodeId = `node-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(nodeId)
      .run();
    const deps = submissionDeps();
    await submitFixture(fixture, deps);
    const guard = capturedStartGuard(deps);
    await cancelTask(fixture.input.identities.taskId, 'cancelled before container fetch');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const containerEnv = {
      ...testEnv,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: vi.fn(),
        get: vi.fn(),
      },
    } as unknown as Env;

    await expect(
      fetchNodeAgent(
        nodeId,
        containerEnv,
        `https://${nodeId}.vm.example.test/workspaces`,
        { method: 'POST' },
        1_000,
        {
          beforeExternalMutation: () => assertTaskRunnerStartGuard(containerEnv, guard),
        }
      )
    ).rejects.toThrow('cancelled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not record reserved revocation when guarded ProjectData fail is rejected', async () => {
    const fixture = await seedReservedFixture('stale-fail-session-cleanup');
    const deps = submissionDeps();
    await submitFixture(fixture, deps);
    const guard = capturedStartGuard(deps);

    await expect(
      projectDataService.failSession(testEnv, fixture.projectId, guard.chatSessionId, 'stale cleanup', {
        taskId: `old-${guard.taskId}`,
        createdByUserId: fixture.userId,
        workspaceId: null,
      })
    ).resolves.toBe(false);

    expect(await reservedRevocationRowsForFixture(fixture)).toEqual([]);
    await expect(assertTaskRunnerStartGuard(testEnv, guard)).resolves.toBeUndefined();

    await expect(
      projectDataService.failSession(testEnv, fixture.projectId, guard.chatSessionId, 'real cleanup', {
        taskId: guard.taskId,
        createdByUserId: fixture.userId,
        workspaceId: null,
      })
    ).resolves.toBe(true);
    expect(await reservedRevocationRowsForFixture(fixture)).toEqual([
      {
        task_id: guard.taskId,
        reason: 'session_failed',
        source: 'project_data.fail_session',
        chat_session_id: guard.chatSessionId,
      },
    ]);
  });

  it('classifies a delayed successful start as the persisted winner after queued-only guard loss', async () => {
    const fixture = await seedReservedFixture('delayed-successful-start');
    const sessionLookupStarted = deferred<void>();
    const releaseSessionLookup = deferred<void>();
    const getSession = projectDataService.getSession;
    vi.spyOn(projectDataService, 'getSession')
      .mockImplementationOnce((...args) => getSession(...args))
      .mockImplementationOnce(async () => {
        sessionLookupStarted.resolve();
        await releaseSessionLookup.promise;
        return {
          id: fixture.input.identities.chatSessionId,
          status: 'active',
          taskId: fixture.input.identities.taskId,
          createdByUserId: fixture.userId,
        };
      });
    const deps = {
      ...submissionDeps(),
      startTaskRunner: vi.fn(async () => {
        throw new Error('lost TaskRunner acknowledgement before durable status');
      }) as typeof startTaskRunnerDO,
      ensureTaskRunnerStarted: vi.fn(async () => false),
    } satisfies ReservedTaskSubmissionDependencies;

    const submission = submitReservedTask(testEnv, fixture.input, deps);
    await sessionLookupStarted.promise;
    await env.DATABASE.prepare(
      `UPDATE tasks
          SET status = 'delegated', updated_at = ?
        WHERE id = ?
          AND status = 'queued'`
    )
      .bind(new Date().toISOString(), fixture.input.identities.taskId)
      .run();
    releaseSessionLookup.resolve();

    await expect(submission).resolves.toMatchObject({
      outcome: 'admitted',
      startState: 'already_started',
    });
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'delegated',
      workspace_id: null,
    });
    expect(deps.ensureTaskRunnerStarted).toHaveBeenCalledOnce();
  });

  it('fences a stopped ProjectData session after ProjectData commit before TaskRunner start', async () => {
    const fixture = await seedReservedFixture('archive-after-projectdata');
    const deps = {
      ...submissionDeps(),
      afterProjectDataCommit: async () => {
        await projectDataService.stopSession(
          testEnv,
          fixture.projectId,
          fixture.input.identities.chatSessionId
        );
      },
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'authority_unavailable',
      message: expect.stringContaining('stopped'),
    });
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'queued',
      workspace_id: null,
    });
    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('does not allocate physical resources when the ProjectData session is stopped after node selection', async () => {
    const fixture = await seedReservedFixture('archive-after-node-selection');
    await makeReadyNode(`node-${fixture.executionId}`, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_creation',
      stepResults: { nodeId: expect.any(String) },
    });

    await projectDataService.stopSession(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId
    );
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'failed',
      workspace_id: null,
      error_message: expect.stringContaining('session'),
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'workspace_creation',
    });
  });

  it('does not allocate physical resources when the ProjectData session owner changes', async () => {
    const fixture = await seedReservedFixture('projectdata-owner-change');
    await makeReadyNode(`node-${fixture.executionId}`, fixture.userId);
    await submitFixture(fixture);

    const projectDataStub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(fixture.projectId));
    await runInDurableObject(projectDataStub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET created_by_user_id = ?, updated_at = ? WHERE id = ?',
        `other-${fixture.userId}`,
        Date.now(),
        fixture.input.identities.chatSessionId
      );
    });
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'failed',
      workspace_id: null,
      error_message: expect.stringContaining('owner changed'),
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'node_selection',
    });
    const guardedLink = await runInDurableObject(projectDataStub, async (instance) => {
      try {
        await instance.linkSessionToWorkspace(
          fixture.input.identities.chatSessionId,
          'workspace-guard-rejected',
          {
            taskId: fixture.input.identities.taskId,
            createdByUserId: fixture.userId,
            workspaceId: 'workspace-guard-rejected',
          }
        );
        return 'linked';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(guardedLink).toContain('expected created_by_user_id');
    const session = await projectDataService.getSession(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId
    );
    expect(session).toMatchObject({
      status: 'active',
      createdByUserId: `other-${fixture.userId}`,
      workspaceId: null,
    });
    const messages = await projectDataService.getMessages(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({ content: fixture.input.prompt });
  });

  it('does not allocate physical resources when the task is cancelled after node selection', async () => {
    const fixture = await seedReservedFixture('cancel-after-node-selection');
    await makeReadyNode(`node-${fixture.executionId}`, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_creation',
      stepResults: { nodeId: expect.any(String) },
    });

    await cancelTask(fixture.input.identities.taskId, 'cancelled after node selection');
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'cancelled',
      workspace_id: null,
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'workspace_creation',
    });
  });

  it('rejects physical placement in the production SQL statement after task cancellation', async () => {
    const fixture = await seedReservedFixture('placement-sql-cancel');
    const nodeId = `node-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    await cancelTask(fixture.input.identities.taskId, 'cancelled before placement SQL');
    const checkpoint = await env.DATABASE.prepare(
      `SELECT intent_fingerprint FROM task_submission_checkpoints WHERE task_id = ?`
    )
      .bind(fixture.input.identities.taskId)
      .first<{ intent_fingerprint: string }>();
    if (!checkpoint) throw new Error('Missing reserved checkpoint');

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          id: `workspace-${fixture.executionId}`,
          nodeId,
          projectId: fixture.projectId,
          userId: fixture.userId,
          installationId: fixture.installationId,
          name: 'Workspace after cancellation',
          displayName: 'Workspace after cancellation',
          normalizedDisplayName: `workspace-${fixture.executionId}`,
          repository: fixture.repository,
          branch: 'main',
          chatSessionId: fixture.input.identities.chatSessionId,
          vmSize: 'small',
          vmLocation: 'nbg1',
          workspaceProfile: 'full',
          devcontainerConfigName: null,
          agentProfileHint: null,
          capacityPlacementSnapshot: null,
          taskLifecycleGuard: {
            taskId: fixture.input.identities.taskId,
            projectId: fixture.projectId,
            userId: fixture.userId,
            chatSessionId: fixture.input.identities.chatSessionId,
            requireChatSessionMatch: true,
            reservedIntentFingerprint: checkpoint.intent_fingerprint,
          },
          createdAt: new Date().toISOString(),
        },
        2
      )
    ).resolves.toBe(false);

    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([]);
  });

  it('recovers a workspace allocation that committed before task linkage', async () => {
    const fixture = await seedReservedFixture('recover-orphan-allocation');
    const nodeId = `node-${fixture.executionId}`;
    const workspaceId = `workspace-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    await reserveOrphanWorkspaceAllocation(fixture, nodeId, workspaceId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await workspaceRowsForFixture(fixture)).toEqual([
      {
        id: workspaceId,
        status: 'creating',
        chat_session_id: fixture.input.identities.chatSessionId,
      },
    ]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'delegated',
      workspace_id: workspaceId,
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_dispatch',
      stepResults: { workspaceId },
    });
  });

  it('dispatches exactly one physical workspace and first harness prompt through TaskRunner', async () => {
    const fixture = await seedReservedFixture('physical-first-harness-prompt');
    const nodeId = `node-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    const nodeAgentCalls = installNodeAgentFetchRecorder();

    await runTaskRunnerAlarm(fixture.input.identities.taskId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    const afterDispatch = await taskRunnerStub(fixture.input.identities.taskId).getStatus();
    const workspaceId = afterDispatch?.stepResults.workspaceId;
    expect(afterDispatch).toMatchObject({
      currentStep: 'workspace_ready',
      stepResults: { workspaceId: expect.any(String) },
    });
    if (!workspaceId) throw new Error('Missing workspace after dispatch');

    await env.DATABASE.prepare(
      `UPDATE workspaces
          SET status = 'running', updated_at = ?
        WHERE id = ?`
    )
      .bind(new Date().toISOString(), workspaceId)
      .run();
    await runTaskRunnerAlarm(fixture.input.identities.taskId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    const workspaceDispatches = nodeAgentCalls.filter(
      (call) => call.method === 'POST' && call.pathname === '/workspaces'
    );
    const agentSessionCreates = nodeAgentCalls.filter((call) =>
      /\/workspaces\/[^/]+\/agent-sessions$/.test(call.pathname)
    );
    const firstHarnessPrompts = nodeAgentCalls.filter((call) =>
      /\/workspaces\/[^/]+\/agent-sessions\/[^/]+\/start$/.test(call.pathname)
    );
    expect(workspaceDispatches).toHaveLength(1);
    expect(agentSessionCreates).toHaveLength(1);
    expect(firstHarnessPrompts).toHaveLength(1);
    expect(workspaceDispatches[0]?.body).toMatchObject({
      workspaceId,
      projectId: fixture.projectId,
      taskId: fixture.input.identities.taskId,
    });
    expect(firstHarnessPrompts[0]?.body).toMatchObject({
      agentType: 'opencode',
      initialPrompt: fixture.input.prompt,
      projectId: fixture.projectId,
      taskId: fixture.input.identities.taskId,
      taskMode: 'task',
    });
    expect(firstHarnessPrompts[0]?.body?.injectedInstructions).toEqual(
      expect.stringContaining('get_instructions')
    );
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'in_progress',
      workspace_id: workspaceId,
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'running',
      stepResults: {
        workspaceId,
        agentStarted: true,
        agentSessionId: expect.any(String),
      },
    });
  });

  it('claims a recovered workspace allocation that was already stored in DO state', async () => {
    const fixture = await seedReservedFixture('recover-state-before-task-link');
    const nodeId = `node-${fixture.executionId}`;
    const workspaceId = `workspace-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    await reserveOrphanWorkspaceAllocation(fixture, nodeId, workspaceId);
    await runInDurableObject(taskRunnerStub(fixture.input.identities.taskId), async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('Missing TaskRunner state');
      state.stepResults.workspaceId = workspaceId;
      state.stepResults.nodeId = nodeId;
      await instance.ctx.storage.put('state', state);
      await instance.ctx.storage.deleteAlarm();
    });
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await workspaceRowsForFixture(fixture)).toEqual([
      {
        id: workspaceId,
        status: 'creating',
        chat_session_id: fixture.input.identities.chatSessionId,
      },
    ]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'delegated',
      workspace_id: workspaceId,
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_dispatch',
      stepResults: { workspaceId },
    });
  });

  it('tombstones a workspace allocation when cancellation lands before task linkage', async () => {
    const fixture = await seedReservedFixture('cancel-orphan-allocation');
    const nodeId = `node-${fixture.executionId}`;
    const workspaceId = `workspace-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    await reserveOrphanWorkspaceAllocation(fixture, nodeId, workspaceId);
    await cancelTask(fixture.input.identities.taskId, 'cancelled after workspace insert');
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await workspaceRowsForFixture(fixture)).toEqual([
      {
        id: workspaceId,
        status: 'stopped',
        chat_session_id: fixture.input.identities.chatSessionId,
      },
    ]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'cancelled',
      workspace_id: null,
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'workspace_creation',
    });
  });

  it('tombstones a workspace allocation when session archive lands before task linkage', async () => {
    const fixture = await seedReservedFixture('archive-orphan-allocation');
    const nodeId = `node-${fixture.executionId}`;
    const workspaceId = `workspace-${fixture.executionId}`;
    await makeReadyNode(nodeId, fixture.userId);
    await submitFixture(fixture);
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    await reserveOrphanWorkspaceAllocation(fixture, nodeId, workspaceId);
    await projectDataService.stopSession(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId
    );
    await runTaskRunnerAlarm(fixture.input.identities.taskId);

    expect(await allWorkspaceRowsForFixture(fixture)).toEqual([
      {
        id: workspaceId,
        status: 'stopped',
        chat_session_id: fixture.input.identities.chatSessionId,
      },
    ]);
    expect(await taskRow(fixture.input.identities.taskId)).toMatchObject({
      status: 'failed',
      workspace_id: null,
      error_message: expect.stringContaining('session'),
    });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      completed: true,
      currentStep: 'workspace_creation',
    });
  });

  it('preserves accepted configuration when project defaults change before physical start', async () => {
    const fixture = await seedReservedFixture('accepted-config-change');
    const deps = {
      ...submissionDeps(),
      afterProjectDataCommit: async () => {
        await env.DATABASE.prepare(
          `UPDATE projects SET default_vm_size = 'medium', updated_at = ? WHERE id = ?`
        )
          .bind(new Date().toISOString(), fixture.projectId)
          .run();
      },
    } satisfies ReservedTaskSubmissionDependencies;

    const result = await submitReservedTask(testEnv, fixture.input, deps);

    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'accepted_configuration_changed',
    });
    const persisted = await env.DATABASE.prepare(
      `SELECT requested_vm_size, requested_vm_size_source, accepted_snapshot_json
         FROM tasks
         INNER JOIN task_submission_checkpoints ON task_submission_checkpoints.task_id = tasks.id
        WHERE tasks.id = ?`
    )
      .bind(fixture.input.identities.taskId)
      .first<{
        requested_vm_size: string | null;
        requested_vm_size_source: string | null;
        accepted_snapshot_json: string;
      }>();
    expect(persisted).toMatchObject({
      requested_vm_size: 'small',
      requested_vm_size_source: 'project',
    });
    const acceptedSnapshot = JSON.parse(persisted?.accepted_snapshot_json ?? '{}') as {
      task?: { requestedVmSize?: string; requestedVmSizeSource?: string };
      runner?: { vmSize?: string };
    };
    expect(acceptedSnapshot.task).toMatchObject({
      requestedVmSize: 'small',
      requestedVmSizeSource: 'project',
    });
    expect(acceptedSnapshot.runner).toMatchObject({ vmSize: 'small' });
    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toBeNull();
  });

  it('preserves the accepted prompt and rejects a conflicting reserved identity before extra starts', async () => {
    const fixture = await seedReservedFixture('conflicting-identity-real');
    await submitFixture(fixture);
    const conflictingInput: ReservedTaskSubmissionInput = {
      ...fixture.input,
      prompt: `${fixture.input.prompt} Changed after the reserved identity was accepted.`,
    };

    const result = await submitReservedTask(testEnv, conflictingInput, submissionDeps());

    expect(result).toMatchObject({
      outcome: 'conflict',
      reason: 'intent_fingerprint_mismatch',
    });
    const messages = await projectDataService.getMessages(
      testEnv,
      fixture.projectId,
      fixture.input.identities.chatSessionId,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({ content: fixture.input.prompt });
    expect(await taskRunnerStub(fixture.input.identities.taskId).getStatus()).toMatchObject({
      taskId: fixture.input.identities.taskId,
    });
    expect((await taskCounts(fixture.input.identities.taskId)).workspaces).toBe(0);
  });
});
