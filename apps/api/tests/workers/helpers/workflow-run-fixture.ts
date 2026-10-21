/**
 * A project with one VM agent profile and an accepted workflow run, advanced by the real
 * engine (`reconcileWorkflowRun`) on real D1. Only the TaskRunner start is stubbed, the same
 * seam the engine's own tests use (`workflow-runs.test.ts`).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { ProjectOrchestrator } from '../../../src/durable-objects/project-orchestrator';
import type { Env } from '../../../src/env';
import { handleCompleteTask } from '../../../src/routes/mcp/task-tools';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { transitionTaskToTerminal } from '../../../src/services/task-terminal-transition';
import { reconcileWorkflowRun } from '../../../src/services/workflow-reconcile';
import { startWorkflowRun, type WorkflowRunRow } from '../../../src/services/workflow-runs';
import { seedInstallation, seedProject, seedTask, seedUser } from './seed-d1';

const testEnv = env as unknown as Env;

export interface WorkflowFixtureStep {
  key: string;
  title: string;
  after?: string[];
}

/** Seed an owner, project, VM profile and credential; start a run of `steps`. */
export async function workflowRunFixture(
  steps: WorkflowFixtureStep[] = [
    { key: 'draft', title: 'Draft' },
    { key: 'review', title: 'Review', after: ['draft'] },
    { key: 'revise', title: 'Revise', after: ['review'] },
  ]
) {
  const suffix = crypto.randomUUID();
  const userId = `wf-u-${suffix}`;
  const projectId = `wf-p-${suffix}`;
  const parentTaskId = `wf-t-${suffix}`;
  const profileId = `wf-a-${suffix}`;
  await seedUser(userId);
  await seedInstallation(`wf-i-${suffix}`, userId);
  await seedProject(projectId, userId, `wf-i-${suffix}`);
  await seedTask(parentTaskId, projectId, userId, {
    status: 'in_progress',
    taskMode: 'conversation',
    title: 'Plan the release notes',
    chatSessionId: `chat-${parentTaskId}`,
  });
  await env.DATABASE.prepare(
    "UPDATE projects SET default_provider='hetzner',default_location='nbg1',default_vm_size='small',default_branch='main',default_agent_type='opencode' WHERE id = ?"
  )
    .bind(projectId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO agent_profiles(id,project_id,user_id,name,agent_type,runtime,model,created_at,updated_at)
    VALUES(?,?,?,'Writer','opencode','vm','test-model',datetime('now'),datetime('now'))`
  )
    .bind(profileId, projectId, userId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO credentials(id,user_id,project_id,provider,credential_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at)
    VALUES(?,?,?,'hetzner','cloud-provider','api-key',1,'encrypted-test','test-iv',datetime('now'),datetime('now'))`
  )
    .bind(`wf-c-${suffix}`, userId, projectId)
    .run();
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId,
    projectId,
    includeInstallation: false,
  });

  const launched = new Set<string>();
  const start = vi.fn(async (_env: Env, startInput: { taskId: string }) => {
    launched.add(startInput.taskId);
  });
  const deps = {
    submission: {
      requireRepositoryAccess: vi.fn(async () => undefined),
      startTaskRunner: start,
      ensureTaskRunnerStarted: vi.fn(async (_env: Env, taskId: string) => launched.has(taskId)),
    },
  };

  async function startRun(requestKey: string, title = 'Write and review the release notes') {
    const run = await startWorkflowRun(testEnv, {
      projectId,
      userId,
      parentTaskId,
      requestKey,
      plan: {
        title,
        goal: 'Produce reviewed release notes in the project Library',
        steps: steps.map((step) => ({
          key: step.key,
          title: step.title,
          instructions: `Do the ${step.title.toLowerCase()} work`,
          agentProfileId: profileId,
          after: step.after ?? [],
        })),
      },
    });
    // The test drives reconciliation itself; the orchestrator alarm must not race it.
    const orchestrator = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(projectId)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(orchestrator, async (instance) => {
      await instance.ctx.storage.deleteAlarm();
    });
    return run.runId;
  }

  async function tick(runId: string) {
    const row = await env.DATABASE.prepare('SELECT * FROM missions WHERE id = ?')
      .bind(runId)
      .first<WorkflowRunRow>();
    await reconcileWorkflowRun(testEnv, row!, deps);
  }

  return { userId, projectId, parentTaskId, profileId, start, deps, startRun, tick };
}

/** Finish a step's task the way production does: `complete_task`, or a terminal failure. */
export async function finishStepTask(
  projectId: string,
  taskId: string,
  outcome:
    | { status: 'completed'; summary: string; evidence?: Record<string, unknown> }
    | { status: 'failed'; reason: string }
) {
  const terminalEnv = {
    ...testEnv,
    PROJECT_ORCHESTRATOR: {
      idFromName: () => ({}),
      get: () => ({ notifyTaskEvent: async () => undefined }),
    },
  } as unknown as Env;
  if (outcome.status === 'failed') {
    await transitionTaskToTerminal(terminalEnv, {
      projectId,
      taskId,
      status: 'failed',
      reason: outcome.reason,
      source: 'workflow-read-test',
      actorType: 'system',
    });
    return;
  }
  const task = await env.DATABASE.prepare('SELECT user_id, chat_session_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ user_id: string; chat_session_id: string | null }>();
  await env.DATABASE.prepare("UPDATE tasks SET status='in_progress' WHERE id=? AND status='queued'")
    .bind(taskId)
    .run();
  const result = await handleCompleteTask(
    'complete',
    { summary: outcome.summary, ...(outcome.evidence ? { evidence: outcome.evidence } : {}) },
    {
      taskId,
      projectId,
      userId: task!.user_id,
      workspaceId: 'workflow-read-test',
      chatSessionId: task!.chat_session_id ?? undefined,
      createdAt: new Date().toISOString(),
      taskMode: 'task',
    },
    terminalEnv
  );
  if (result.error) throw new Error(`complete_task failed: ${JSON.stringify(result.error)}`);
}
