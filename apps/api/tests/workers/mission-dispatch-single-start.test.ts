/**
 * A mission task has exactly one starter (idea 01M4KKNAZY6KSSCXR610T01E11).
 *
 * Production, 2026-10-10: dispatch_task created chat session S1 and started the
 * TaskRunner, but left tasks.chat_session_id NULL until the runner linked it,
 * after its workspace claim. A ProjectOrchestrator cycle in that window
 * auto-dispatched the "unclaimed" mission task: it created S2, rebound the task
 * to it, and the runner's claim then failed the task.
 *
 * Everything here runs the production code: handleDispatchTask against real D1
 * and the real ProjectData and TaskRunner DOs, one real orchestrator alarm, then
 * the real TaskRunner steps. The only control is ordering: each runner's alarm
 * is held right after its start, so the orchestrator cycle lands exactly in the
 * window between "runner started" and "runner linked the session".
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import { dispatchTask as samDispatchTask } from '../../src/durable-objects/sam-session/tools/dispatch-task';
import { retrySubtask as samRetrySubtask } from '../../src/durable-objects/sam-session/tools/retry-subtask';
import type { StartTaskInput, TaskRunner } from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import type { McpTokenData } from '../../src/routes/mcp/_helpers';
import { handleDispatchTask } from '../../src/routes/mcp/dispatch-tool';
import * as projectHelpers from '../../src/routes/projects/_helpers';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import * as projectDataService from '../../src/services/project-data';
import { getOrchestratorStatus, startOrchestration } from '../../src/services/project-orchestrator';
import * as vmAgentContainer from '../../src/services/vm-agent-container';
import * as workspaceBranch from '../../src/services/workspace-branch';
import { seedReadyNode } from './helpers/ready-node';
import { seedInstallation, seedMission, seedProject, seedTask, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as Env;
let counter = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function taskRunnerStub(taskId: string): DurableObjectStub<TaskRunner> {
  return env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(taskId)) as DurableObjectStub<TaskRunner>;
}

function orchestratorStub(projectId: string): DurableObjectStub<ProjectOrchestrator> {
  return env.PROJECT_ORCHESTRATOR.get(
    env.PROJECT_ORCHESTRATOR.idFromName(projectId)
  ) as DurableObjectStub<ProjectOrchestrator>;
}

/** The production env, except each TaskRunner's first alarm is held after its real start. */
function envWithHeldRunnerAlarms(): Env {
  return {
    ...testEnv,
    TASK_RUNNER: {
      idFromName: (name: string) => testEnv.TASK_RUNNER.idFromName(name),
      get: (id: DurableObjectId) => ({
        start: (input: StartTaskInput) =>
          runInDurableObject(
            testEnv.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>,
            async (instance) => {
              await instance.start(input);
              await instance.ctx.storage.deleteAlarm();
            }
          ),
      }),
    } as unknown as Env['TASK_RUNNER'],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function runTaskRunnerAlarm(taskId: string): Promise<void> {
  await runInDurableObject(taskRunnerStub(taskId), async (instance) => {
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
  });
}

/** Run one real orchestrator alarm and prove it processed `missionId` (liveness for absence checks). */
async function runOrchestratorCycleOver(projectId: string, missionId: string, terminal = false) {
  const lastCheckedAt = async () =>
    (await getOrchestratorStatus(testEnv, projectId)).activeMissions.find(
      (mission) => mission.missionId === missionId
    )?.lastCheckedAt;
  const before = await lastCheckedAt();
  expect(before).toEqual(expect.any(Number));

  await runInDurableObject(orchestratorStub(projectId), async (instance) => {
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
  });

  const status = await getOrchestratorStatus(testEnv, projectId);
  const after = status.activeMissions.find((mission) => mission.missionId === missionId);
  if (terminal) {
    expect(after).toBeUndefined();
    expect(
      await env.DATABASE.prepare('SELECT status FROM missions WHERE id = ?').bind(missionId).first()
    ).toEqual({ status: 'failed' });
  } else {
    expect(after?.lastCheckedAt).toBeGreaterThan(before!);
  }
  return status;
}

async function sessionIdsForTask(projectId: string, taskId: string): Promise<string[]> {
  const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(projectId));
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql
      .exec('SELECT id FROM chat_sessions WHERE task_id = ? ORDER BY created_at', taskId)
      .toArray()
      .map((row) => String(row.id))
  );
}

async function taskRow(taskId: string) {
  return env.DATABASE.prepare(
    `SELECT status, chat_session_id, workspace_id, scheduler_state, error_message
       FROM tasks WHERE id = ?`
  )
    .bind(taskId)
    .first<{
      status: string;
      chat_session_id: string | null;
      workspace_id: string | null;
      scheduler_state: string | null;
      error_message: string | null;
    }>();
}

async function seedMissionFixture(label: string) {
  const suffix = unique(label);
  const userId = `user-${suffix}`;
  const installationId = `installation-${suffix}`;
  const projectId = `project-${suffix}`;
  const missionId = `mission-${suffix}`;
  const parentTaskId = `parent-${suffix}`;
  const now = new Date().toISOString();

  await seedUser(userId, { githubId: `gh-${suffix}`, email: `${suffix}@example.com` });
  await seedInstallation(installationId, userId, { installationIdValue: `external-${suffix}` });
  await seedProject(projectId, userId, installationId, { repository: `acme/${suffix}` });
  await env.DATABASE.prepare(
    `UPDATE projects
        SET default_provider = 'hetzner', default_location = 'nbg1', default_vm_size = 'small',
            default_branch = 'main', default_agent_type = 'opencode'
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
    .bind(`credential-${suffix}`, userId, projectId, `token-${suffix}`, `iv-${suffix}`, now, now)
    .run();
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId,
    projectId,
    includeInstallation: false,
  });
  // The coordinator that dispatches mission work (a Connector-started chat in production).
  await seedTask(parentTaskId, projectId, userId, { status: 'in_progress' });
  await seedMission(missionId, projectId, userId, { status: 'active' });
  await startOrchestration(testEnv, projectId, missionId);

  const token: McpTokenData = {
    taskId: parentTaskId,
    projectId,
    userId,
    workspaceId: `workspace-${parentTaskId}`,
    createdAt: now,
  };
  return { userId, projectId, missionId, token };
}

async function dispatchMissionTask(
  fixture: Awaited<ReturnType<typeof seedMissionFixture>>,
  description: string,
  dispatchEnv: Env = envWithHeldRunnerAlarms(),
  extra: {
    params?: Record<string, unknown>;
    execCtx?: { waitUntil(p: Promise<unknown>): void };
  } = {}
): Promise<{ taskId: string; sessionId: string; runtime: string }> {
  const response = await handleDispatchTask(
    1,
    { description, missionId: fixture.missionId, ...extra.params },
    fixture.token,
    dispatchEnv,
    extra.execCtx
  );
  expect(response.error).toBeUndefined();
  const content = (response.result as { content: Array<{ text: string }> }).content[0]!;
  return JSON.parse(content.text) as { taskId: string; sessionId: string; runtime: string };
}

describe('mission dispatch has exactly one starter', () => {
  it('session creation rejection after INSERT fails the claimed task without an orchestrator takeover', async () => {
    const fixture = await seedMissionFixture('session-rejection');
    const entered = deferred<{ taskId: string; sessionId: string }>();
    const release = deferred<void>();
    vi.spyOn(projectDataService, 'createSession').mockImplementation(async (...args) => {
      entered.resolve({ taskId: args[4]!, sessionId: args[6]! });
      await release.promise;
      throw new Error('injected session creation failure');
    });
    const dispatch = handleDispatchTask(
      1,
      { description: 'Fail session creation', missionId: fixture.missionId },
      fixture.token,
      envWithHeldRunnerAlarms()
    );
    const claim = await entered.promise;
    expect(await taskRow(claim.taskId)).toMatchObject({
      status: 'queued',
      chat_session_id: claim.sessionId,
    });
    release.resolve();
    expect((await dispatch).error).toMatchObject({
      message: expect.stringContaining('injected session creation failure'),
    });
    expect(await taskRow(claim.taskId)).toMatchObject({
      status: 'failed',
      chat_session_id: claim.sessionId,
      error_message: expect.stringContaining('Session creation failed'),
    });
    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId, true);
    expect(status.recentDecisions.filter((d) => d.taskId === claim.taskId)).toEqual([]);
    expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([]);
    expect(await taskRunnerStub(claim.taskId).getStatus()).toBeNull();
  });

  it('a real orchestrator cycle during session creation preserves the INSERT-time identity', async () => {
    const fixture = await seedMissionFixture('session-midpoint');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);
    const entered = deferred<{ taskId: string; sessionId: string }>();
    const release = deferred<void>();
    const createSession = projectDataService.createSession;
    let firstCreation = true;
    vi.spyOn(projectDataService, 'createSession').mockImplementation(async (...args) => {
      if (!firstCreation) return createSession(...args);
      firstCreation = false;
      entered.resolve({ taskId: args[4]!, sessionId: args[6]! });
      await release.promise;
      return createSession(...args);
    });
    const dispatch = dispatchMissionTask(fixture, 'Pause before session creation');
    const claim = await entered.promise;
    try {
      expect(await taskRow(claim.taskId)).toMatchObject({
        status: 'queued',
        chat_session_id: claim.sessionId,
      });
      expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([]);
      const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
      expect(status.recentDecisions.filter((d) => d.taskId === claim.taskId)).toEqual([]);
      expect(await taskRunnerStub(claim.taskId).getStatus()).toBeNull();
      expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([]);
      expect((await taskRow(claim.taskId))?.chat_session_id).toBe(claim.sessionId);
    } finally {
      release.resolve();
      // Drain the creator even when a midpoint assertion fails (mutation probes).
      await dispatch;
    }
    expect(await dispatch).toMatchObject(claim);
    expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([claim.sessionId]);
    expect(await taskRunnerStub(claim.taskId).getStatus()).toMatchObject({
      currentStep: 'node_selection',
      stepResults: { chatSessionId: claim.sessionId },
    });
  });

  it('initial-message rejection terminalizes the task and real reconciliation fails its created session', async () => {
    const fixture = await seedMissionFixture('message-rejection');
    const entered = deferred<{ taskId: string; sessionId: string }>();
    const release = deferred<void>();
    vi.spyOn(projectDataService, 'persistMessage').mockImplementation(async (...args) => {
      const row = await env.DATABASE.prepare('SELECT id FROM tasks WHERE chat_session_id = ?')
        .bind(args[2])
        .first<{ id: string }>();
      entered.resolve({ taskId: row!.id, sessionId: args[2] });
      await release.promise;
      throw new Error('injected initial message failure');
    });
    const dispatch = handleDispatchTask(
      1,
      { description: 'Fail initial message', missionId: fixture.missionId },
      fixture.token,
      envWithHeldRunnerAlarms()
    );
    const claim = await entered.promise;
    expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([claim.sessionId]);
    expect(
      await projectDataService.getSession(testEnv, fixture.projectId, claim.sessionId)
    ).toMatchObject({ status: 'active' });
    release.resolve();
    expect((await dispatch).error).toMatchObject({
      message: expect.stringContaining('injected initial message failure'),
    });
    expect(await taskRow(claim.taskId)).toMatchObject({
      status: 'failed',
      chat_session_id: claim.sessionId,
    });
    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId, true);
    expect(status.recentDecisions.filter((d) => d.taskId === claim.taskId)).toEqual([]);
    expect(await taskRunnerStub(claim.taskId).getStatus()).toBeNull();
    const reconciled = await projectDataService.reconcileTerminalTaskSessions(
      testEnv,
      fixture.projectId,
      { nowIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
    );
    expect(reconciled).toMatchObject({ selected: 1, failed: 1, errors: 0 });
    expect(
      await projectDataService.getSession(testEnv, fixture.projectId, claim.sessionId)
    ).toMatchObject({ status: 'failed' });
    expect(await sessionIdsForTask(fixture.projectId, claim.taskId)).toEqual([claim.sessionId]);
  });

  it('a real ProjectData session INSERT rejection leaves a terminal claim that supported SAM retry replaces', async () => {
    const fixture = await seedMissionFixture('real-session-insert-rejection');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(fixture.projectId));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER reject_session_insert BEFORE INSERT ON chat_sessions BEGIN SELECT RAISE(ABORT, 'injected ProjectData INSERT failure'); END"
      );
    });
    // Catch the real SQL rejection inside the existing test DO adapter so the
    // Workers pool does not report the expected rejected RPC as unhandled.
    const createSession = vi
      .spyOn(projectDataService, 'createSession')
      .mockImplementation(async (...args) => {
        const result = await captureProjectDataExpectedError(
          stub as DurableObjectStub<ProjectDataTestDouble>,
          { operation: 'createSession', args: [args[2], args[3], args[4], args[5], args[6]] }
        );
        expect(result.threw).toBe(true);
        throw new Error(result.message);
      });
    try {
      const response = await handleDispatchTask(
        1,
        { description: 'Reject the real session insert', missionId: fixture.missionId },
        fixture.token,
        envWithHeldRunnerAlarms()
      );
      expect(response.error).toMatchObject({
        message: expect.stringContaining('injected ProjectData INSERT failure'),
      });
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec('DROP TRIGGER reject_session_insert');
      });
      createSession.mockRestore();
    }
    const failed = await env.DATABASE.prepare(
      'SELECT id, status, chat_session_id FROM tasks WHERE parent_task_id = ?'
    )
      .bind(fixture.token.taskId)
      .first<{ id: string; status: string; chat_session_id: string }>();
    expect(failed).toMatchObject({ status: 'failed', chat_session_id: expect.any(String) });
    expect(await sessionIdsForTask(fixture.projectId, failed!.id)).toEqual([]);
    expect(await taskRunnerStub(failed!.id).getStatus()).toBeNull();
    const retried = (await samRetrySubtask(
      { taskId: failed!.id },
      {
        env: envWithHeldRunnerAlarms() as unknown as Record<string, unknown>,
        userId: fixture.userId,
      }
    )) as { newTaskId: string; sessionId: string };
    expect(retried.newTaskId).not.toBe(failed!.id);
    expect(retried.sessionId).not.toBe(failed!.chat_session_id);
    expect(await taskRow(retried.newTaskId)).toMatchObject({
      status: 'queued',
      chat_session_id: retried.sessionId,
    });
    expect(await sessionIdsForTask(fixture.projectId, retried.newTaskId)).toEqual([
      retried.sessionId,
    ]);
    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
    expect(status.recentDecisions.filter((d) => d.taskId === retried.newTaskId)).toEqual([]);
    expect(await sessionIdsForTask(fixture.projectId, failed!.id)).toEqual([]);
    expect(await sessionIdsForTask(fixture.projectId, retried.newTaskId)).toEqual([
      retried.sessionId,
    ]);
    expect(await taskRunnerStub(retried.newTaskId).getStatus()).toMatchObject({
      currentStep: 'node_selection',
      stepResults: { chatSessionId: retried.sessionId },
    });
  });

  it('a committed session whose creation response is lost remains claimed until real terminal reconciliation', async () => {
    const fixture = await seedMissionFixture('session-response-loss');
    const createSession = projectDataService.createSession;
    let committed!: { taskId: string; sessionId: string };
    vi.spyOn(projectDataService, 'createSession').mockImplementation(async (...args) => {
      const sessionId = await createSession(...args);
      committed = { taskId: args[4]!, sessionId };
      throw new Error('injected response loss after committed session');
    });
    // An unavailable authoritative reader must not turn an uncertain RPC response
    // into a cleared claim or prevent the creator from terminalizing its task.
    const readSession = vi
      .spyOn(projectDataService, 'getSession')
      .mockRejectedValue(new Error('injected authoritative read outage'));
    const response = await handleDispatchTask(
      1,
      { description: 'Lose session response', missionId: fixture.missionId },
      fixture.token,
      envWithHeldRunnerAlarms()
    );
    expect(response.error).toMatchObject({
      message: expect.stringContaining('injected response loss'),
    });
    expect(readSession).not.toHaveBeenCalled();
    readSession.mockRestore();
    expect(await taskRow(committed.taskId)).toMatchObject({
      status: 'failed',
      chat_session_id: committed.sessionId,
    });
    expect(await sessionIdsForTask(fixture.projectId, committed.taskId)).toEqual([
      committed.sessionId,
    ]);
    expect(
      await projectDataService.getSession(testEnv, fixture.projectId, committed.sessionId)
    ).toMatchObject({ status: 'active' });
    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId, true);
    expect(status.recentDecisions.filter((d) => d.taskId === committed.taskId)).toEqual([]);
    expect(await taskRunnerStub(committed.taskId).getStatus()).toBeNull();
    const reconciled = await projectDataService.reconcileTerminalTaskSessions(
      testEnv,
      fixture.projectId,
      { nowIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
    );
    expect(reconciled).toMatchObject({ selected: 1, failed: 1, errors: 0 });
    expect(
      await projectDataService.getSession(testEnv, fixture.projectId, committed.sessionId)
    ).toMatchObject({ status: 'failed' });
    expect((await taskRow(committed.taskId))?.chat_session_id).toBe(committed.sessionId);
  });

  it('recovery terminalizes crash-leftover claims whose sessions were never created and continues the sweep', async () => {
    const fixture = await seedMissionFixture('crash-leftover');
    // A process crash between INSERT and ProjectData RPC leaves precisely these rows.
    const taskIds = [unique('crashed-claim'), unique('next-crashed-claim')];
    for (const taskId of taskIds) {
      await seedTask(taskId, fixture.projectId, fixture.userId, { status: 'queued' });
      await env.DATABASE.prepare(
        "UPDATE tasks SET mission_id = ?, chat_session_id = ?, execution_step = 'node_selection', scheduler_state = 'schedulable', updated_at = ? WHERE id = ?"
      )
        .bind(
          fixture.missionId,
          `missing-${taskId}`,
          new Date(Date.now() - 10 * 60_000).toISOString(),
          taskId
        )
        .run();
      expect(await sessionIdsForTask(fixture.projectId, taskId)).toEqual([]);
    }
    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
    expect(status.recentDecisions.filter((d) => taskIds.includes(d.taskId ?? ''))).toEqual([]);
    const result = await recoverStuckTasks({ ...testEnv, TASK_STUCK_QUEUED_TIMEOUT_MS: '60000' });
    expect(result.failedQueued).toBeGreaterThanOrEqual(taskIds.length);
    expect(result.errors).toBe(0);
    for (const taskId of taskIds) {
      expect(await taskRow(taskId)).toMatchObject({
        status: 'failed',
        chat_session_id: `missing-${taskId}`,
        error_message: expect.stringContaining("Task stuck in 'queued'"),
      });
      expect(await sessionIdsForTask(fixture.projectId, taskId)).toEqual([]);
      expect(await taskRunnerStub(taskId).getStatus()).toBeNull();
    }
  });

  it('a rejected task INSERT creates neither a session nor a dangling task reservation', async () => {
    const fixture = await seedMissionFixture('insert-rejection');
    const createSession = vi.spyOn(projectDataService, 'createSession');
    // D1 rejects only this creator's INSERT; all fixture reads and other writes remain real.
    await env.DATABASE.exec(
      `CREATE TRIGGER reject_dispatch_insert BEFORE INSERT ON tasks WHEN NEW.parent_task_id = '${fixture.token.taskId}' BEGIN SELECT RAISE(ABORT, 'injected task INSERT failure'); END`
    );
    try {
      await expect(
        handleDispatchTask(
          1,
          { description: 'Reject task insertion', missionId: fixture.missionId },
          fixture.token,
          envWithHeldRunnerAlarms()
        )
      ).rejects.toThrow('injected task INSERT failure');
      expect(createSession).not.toHaveBeenCalled();
      expect(
        (
          await env.DATABASE.prepare('SELECT id FROM tasks WHERE parent_task_id = ?')
            .bind(fixture.token.taskId)
            .all()
        ).results
      ).toEqual([]);
      const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(fixture.projectId));
      expect(
        await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql.exec('SELECT id FROM chat_sessions').toArray()
        )
      ).toEqual([]);
      await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
    } finally {
      await env.DATABASE.exec('DROP TRIGGER reject_dispatch_insert');
    }
  });

  it('an orchestrator cycle before the runner links its session neither re-starts nor steals the tasks', async () => {
    const fixture = await seedMissionFixture('mission-double-start');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);

    // Two tasks, as in the production mission; both runners are held before node selection.
    const first = await dispatchMissionTask(fixture, 'Audit the mission scheduler');
    const second = await dispatchMissionTask(fixture, 'Audit the dispatch tool');
    expect([first.runtime, second.runtime]).toEqual(['vm', 'vm']);
    for (const dispatched of [first, second]) {
      expect(await taskRunnerStub(dispatched.taskId).getStatus()).toMatchObject({
        currentStep: 'node_selection',
        stepResults: { chatSessionId: dispatched.sessionId, workspaceId: null },
      });
      expect(await taskRow(dispatched.taskId)).toMatchObject({
        status: 'queued',
        workspace_id: null,
        scheduler_state: 'schedulable',
      });
    }

    // The cycle runs over this mission while both tasks are queued and schedulable.
    const after = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
    expect(
      after.recentDecisions.filter(
        (decision) => decision.missionId === fixture.missionId && decision.taskId !== null
      )
    ).toEqual([]);

    for (const dispatched of [first, second]) {
      expect(await sessionIdsForTask(fixture.projectId, dispatched.taskId)).toEqual([
        dispatched.sessionId,
      ]);
      expect((await taskRow(dispatched.taskId))?.chat_session_id).toBe(dispatched.sessionId);
    }

    // The dispatcher's runner still owns the task and reaches workspace assignment.
    const runner = await taskRunnerStub(first.taskId).getStatus();
    const snapshot = runner?.stepResults.capacityPlacementSnapshot;
    if (!snapshot) throw new Error('Dispatched runner has no placement snapshot');
    await seedReadyNode(`node-${first.taskId}`, fixture.userId, snapshot);
    await runTaskRunnerAlarm(first.taskId);
    await runTaskRunnerAlarm(first.taskId);

    const assigned = await taskRow(first.taskId);
    expect(assigned).toMatchObject({
      status: 'delegated',
      chat_session_id: first.sessionId,
      error_message: null,
    });
    expect(assigned?.workspace_id).toEqual(expect.any(String));
    expect(
      await env.DATABASE.prepare('SELECT status, chat_session_id FROM workspaces WHERE id = ?')
        .bind(assigned?.workspace_id)
        .first()
    ).toEqual({ status: 'creating', chat_session_id: first.sessionId });
    expect(await taskRunnerStub(first.taskId).getStatus()).toMatchObject({
      currentStep: 'workspace_dispatch',
      stepResults: { workspaceId: assigned?.workspace_id },
    });
    expect(await sessionIdsForTask(fixture.projectId, first.taskId)).toEqual([first.sessionId]);
  });

  it('an orchestrator cycle while an Instant launch is still setting up does not start the task', async () => {
    const fixture = await seedMissionFixture('mission-instant-start');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);
    // Hold the background launch at its first await: no node, workspace or session exists yet.
    const branchCheck =
      deferred<Awaited<ReturnType<typeof workspaceBranch.ensureWorkspaceBranchOnRemote>>>();
    vi.spyOn(workspaceBranch, 'ensureWorkspaceBranchOnRemote').mockReturnValue(branchCheck.promise);
    // Workers tests have no container service; end the launch once its session exists.
    vi.spyOn(vmAgentContainer, 'launchVmAgentContainer').mockRejectedValue(
      new Error('container launch is out of scope for this test')
    );
    const launches: Promise<unknown>[] = [];

    const dispatched = await dispatchMissionTask(
      fixture,
      'Audit the Instant dispatch path',
      { ...testEnv, CF_CONTAINER_ENABLED: 'true' },
      { params: { runtime: 'cf-container' }, execCtx: { waitUntil: (p) => launches.push(p) } }
    );
    expect(dispatched.runtime).toBe('cf-container');
    expect(launches).toHaveLength(1);
    const claimedSessionId = (await taskRow(dispatched.taskId))?.chat_session_id;
    expect(claimedSessionId).toEqual(expect.any(String));
    expect(await sessionIdsForTask(fixture.projectId, dispatched.taskId)).toEqual([]);

    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);

    // No VM runner, no second session, no rebind for the Instant task.
    expect(await taskRunnerStub(dispatched.taskId).getStatus()).toBeNull();
    expect(await sessionIdsForTask(fixture.projectId, dispatched.taskId)).toEqual([]);
    expect(await taskRow(dispatched.taskId)).toMatchObject({
      status: 'queued',
      chat_session_id: claimedSessionId,
      scheduler_state: 'schedulable',
    });
    expect(status.recentDecisions.filter((d) => d.taskId === dispatched.taskId)).toEqual([]);

    // Released, the launch creates its session under the identity the task row already carries.
    branchCheck.resolve({ status: 'skipped', reason: 'held for test' });
    await Promise.allSettled(launches);
    expect(await sessionIdsForTask(fixture.projectId, dispatched.taskId)).toEqual([
      claimedSessionId,
    ]);
    expect((await taskRow(dispatched.taskId))?.chat_session_id).toBe(claimedSessionId);
  });

  it('the /sam dispatch_task and retry_subtask creators own their mission tasks from the insert', async () => {
    const fixture = await seedMissionFixture('mission-sam-creators');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);
    const ctx = {
      env: envWithHeldRunnerAlarms() as unknown as Record<string, unknown>,
      userId: fixture.userId,
    };
    const failedOriginal = `failed-${fixture.missionId}`;
    await seedTask(failedOriginal, fixture.projectId, fixture.userId, { status: 'failed' });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id = ?, description = ? WHERE id = ?')
      .bind(fixture.missionId, 'Retry the flaky audit', failedOriginal)
      .run();

    const dispatched = (await samDispatchTask(
      { projectId: fixture.projectId, description: 'Audit via SAM', missionId: fixture.missionId },
      ctx
    )) as { taskId: string; sessionId: string };
    const retried = (await samRetrySubtask({ taskId: failedOriginal }, ctx)) as {
      newTaskId: string;
      sessionId: string;
    };
    const started = [
      { taskId: dispatched.taskId, sessionId: dispatched.sessionId },
      { taskId: retried.newTaskId, sessionId: retried.sessionId },
    ];
    for (const task of started) {
      expect(task.sessionId).toEqual(expect.any(String));
      expect(await taskRow(task.taskId)).toMatchObject({
        status: 'queued',
        chat_session_id: task.sessionId,
      });
    }

    const status = await runOrchestratorCycleOver(fixture.projectId, fixture.missionId);
    for (const task of started) {
      expect(await sessionIdsForTask(fixture.projectId, task.taskId)).toEqual([task.sessionId]);
      expect((await taskRow(task.taskId))?.chat_session_id).toBe(task.sessionId);
      expect(status.recentDecisions.filter((d) => d.taskId === task.taskId)).toEqual([]);
    }
  });
});
