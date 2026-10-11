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
import type { StartTaskInput, TaskRunner } from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import type { McpTokenData } from '../../src/routes/mcp/_helpers';
import { handleDispatchTask } from '../../src/routes/mcp/dispatch-tool';
import * as projectHelpers from '../../src/routes/projects/_helpers';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { getOrchestratorStatus, startOrchestration } from '../../src/services/project-orchestrator';
import { seedReadyNode } from './helpers/ready-node';
import { seedInstallation, seedMission, seedProject, seedTask, seedUser } from './helpers/seed-d1';

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

async function runTaskRunnerAlarm(taskId: string): Promise<void> {
  await runInDurableObject(taskRunnerStub(taskId), async (instance) => {
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
  });
}

async function runOrchestratorCycle(projectId: string): Promise<void> {
  await runInDurableObject(orchestratorStub(projectId), async (instance) => {
    await instance.alarm();
    await instance.ctx.storage.deleteAlarm();
  });
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
  dispatchEnv: Env = envWithHeldRunnerAlarms()
): Promise<{ taskId: string; sessionId: string; runtime: string }> {
  const response = await handleDispatchTask(
    1,
    { description, missionId: fixture.missionId },
    fixture.token,
    dispatchEnv
  );
  expect(response.error).toBeUndefined();
  const content = (response.result as { content: Array<{ text: string }> }).content[0]!;
  return JSON.parse(content.text) as { taskId: string; sessionId: string; runtime: string };
}

describe('mission dispatch has exactly one starter', () => {
  it('an orchestrator cycle before the runner links its session neither re-starts nor steals the tasks', async () => {
    const fixture = await seedMissionFixture('mission-double-start');
    vi.spyOn(projectHelpers, 'requireRepositoryOwnerAccess').mockResolvedValue(undefined);

    // Two tasks, as in the production mission; both runners are held before node selection.
    const first = await dispatchMissionTask(fixture, 'Audit the mission scheduler');
    const second = await dispatchMissionTask(fixture, 'Audit the dispatch tool');
    expect(first.runtime).toBe('vm');
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

    const before = await getOrchestratorStatus(testEnv, fixture.projectId);
    await runOrchestratorCycle(fixture.projectId);
    const after = await getOrchestratorStatus(testEnv, fixture.projectId);

    // Liveness: the cycle ran over this mission and saw both tasks as schedulable.
    const missionBefore = before.activeMissions.find((m) => m.missionId === fixture.missionId);
    const missionAfter = after.activeMissions.find((m) => m.missionId === fixture.missionId);
    expect(missionAfter?.lastCheckedAt).toBeGreaterThan(missionBefore?.lastCheckedAt ?? Infinity);
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
});
