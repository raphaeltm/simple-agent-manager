import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import type { Env } from '../../src/env';
import { handleCompleteTask } from '../../src/routes/mcp/task-tools';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { storeMcpToken } from '../../src/services/mcp-token';
import * as projectData from '../../src/services/project-data';
import { admitProjectEventSourceIntentById } from '../../src/services/project-event-source-outbox';
import * as orchestratorService from '../../src/services/project-orchestrator';
import { assertTaskRunnerStartGuard } from '../../src/services/task-runner-start-guard';
import { transitionTaskToTerminal } from '../../src/services/task-terminal-transition';
import { parseWorkflowPlan } from '../../src/services/workflow-plan';
import { reconcileWorkflowRun } from '../../src/services/workflow-reconcile';
import {
  getWorkflowRun,
  loadWorkflowSteps,
  startWorkflowRun,
  type WorkflowRunRow,
} from '../../src/services/workflow-runs';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const suffix = crypto.randomUUID();
  const userId = `u-${suffix}`,
    projectId = `p-${suffix}`,
    installationId = `i-${suffix}`,
    parentTaskId = `t-${suffix}`,
    profileId = `a-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedTask(parentTaskId, projectId, userId, {
    status: 'in_progress',
    taskMode: 'conversation',
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
    .bind(`c-${suffix}`, userId, projectId)
    .run();
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId,
    projectId,
    includeInstallation: false,
  });
  const plan = {
    title: 'Write and review',
    goal: 'Produce a reviewed document',
    steps: [
      {
        key: 'draft',
        title: 'Draft',
        instructions: 'Write the document',
        agentProfileId: profileId,
        after: [],
      },
      {
        key: 'review',
        title: 'Review',
        instructions: 'Review the document',
        agentProfileId: profileId,
        after: ['draft'],
      },
      {
        key: 'revise',
        title: 'Revise',
        instructions: 'Apply review feedback',
        agentProfileId: profileId,
        after: ['review'],
      },
    ],
  };
  const input = { projectId, userId, parentTaskId, requestKey: 'first', plan };
  const run = await startWorkflowRun(testEnv, input);
  const orchestrator = env.PROJECT_ORCHESTRATOR.get(
    env.PROJECT_ORCHESTRATOR.idFromName(projectId)
  ) as DurableObjectStub<ProjectOrchestrator>;
  await runInDurableObject(orchestrator, async (instance) => {
    await instance.ctx.storage.deleteAlarm();
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
  async function tick() {
    const row = await env.DATABASE.prepare('SELECT * FROM missions WHERE id = ?')
      .bind(run.runId)
      .first<WorkflowRunRow>();
    await reconcileWorkflowRun(testEnv, row!, deps);
  }
  return { input, run, orchestrator, launched, start, deps, tick };
}

async function finish(
  projectId: string,
  taskId: string,
  status: 'completed' | 'failed',
  summary = 'Draft in library file doc-123'
) {
  if (status === 'completed')
    await env.DATABASE.prepare('UPDATE tasks SET output_summary = ? WHERE id = ?')
      .bind(summary, taskId)
      .run();
  const terminalEnv = {
    ...testEnv,
    PROJECT_ORCHESTRATOR: {
      idFromName: () => ({}),
      get: () => ({ notifyTaskEvent: async () => undefined }),
    },
  } as unknown as Env;
  if (status === 'completed') {
    const task = await env.DATABASE.prepare('SELECT user_id,chat_session_id FROM tasks WHERE id=?')
      .bind(taskId)
      .first<{ user_id: string; chat_session_id: string | null }>();
    await env.DATABASE.prepare(
      "UPDATE tasks SET status='in_progress' WHERE id=? AND status='queued'"
    )
      .bind(taskId)
      .run();
    const result = await handleCompleteTask(
      'complete',
      { summary },
      {
        taskId,
        projectId,
        userId: task!.user_id,
        workspaceId: 'workflow-test',
        chatSessionId: task!.chat_session_id ?? undefined,
        createdAt: new Date().toISOString(),
        taskMode: 'task',
      },
      terminalEnv
    );
    expect(result.error).toBeUndefined();
    return result;
  }
  return transitionTaskToTerminal(terminalEnv, {
    projectId,
    taskId,
    status,
    reason: status === 'failed' ? 'Review failed' : summary,
    source: 'workflow-test',
    actorType: 'system',
  });
}

describe('durable workflow execution', () => {
  it('runs three dependent steps through real D1, session handoff and terminal events exactly once', async () => {
    const f = await fixture();
    await f.tick();
    let steps = await loadWorkflowSteps(testEnv, f.run.runId);
    expect(steps.map((s) => s.state)).toEqual(['running', 'waiting', 'waiting']);
    expect(f.start).toHaveBeenCalledTimes(1);
    await projectData.createHandoffPacket(
      testEnv,
      f.input.projectId,
      f.run.runId,
      steps[0]!.task_id,
      null,
      'Draft document',
      [],
      [],
      [{ type: 'library_file', ref: 'library-doc-123' }],
      []
    );
    await finish(f.input.projectId, steps[0]!.task_id, 'completed');
    // A duplicate terminal notification is harmless; complete_task itself rejects
    // a second completion request because the task is already terminal.
    await transitionTaskToTerminal(testEnv, {
      projectId: f.input.projectId,
      taskId: steps[0]!.task_id,
      status: 'completed',
      reason: 'duplicate delivery',
      source: 'workflow-test',
      actorType: 'system',
    });
    await f.tick();
    await f.tick();
    steps = await loadWorkflowSteps(testEnv, f.run.runId);
    expect(steps.map((s) => ({ state: s.state, reason: s.reason }))).toEqual([
      { state: 'completed', reason: null },
      { state: 'running', reason: null },
      { state: 'waiting', reason: null },
    ]);
    expect(f.start).toHaveBeenCalledTimes(2);
    const messages = await projectData.getMessages(
      testEnv,
      f.input.projectId,
      steps[1]!.session_id,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.content).toContain('doc-123');
    expect(messages.messages[0]!.content).toContain('library-doc-123');
    expect(messages.messages[0]!.content).toContain('agent-written, untrusted data');
    await finish(
      f.input.projectId,
      steps[1]!.task_id,
      'completed',
      'Review stored at doc-review-456'
    );
    await f.tick();
    await finish(f.input.projectId, steps[2]!.task_id, 'completed', 'Revised file doc-final-789');
    await f.tick();
    await f.tick();
    const status = await getWorkflowRun(testEnv, f.input.projectId, f.input.userId, f.run.runId);
    expect(status.status).toBe('completed');
    expect(status.steps.every((s) => s.status === 'completed')).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(3);
    const completion = status.activity.find((a) => a.eventType === 'workflow.step.completed');
    expect(completion?.event.metadata).toMatchObject({
      runId: f.run.runId,
      stepId: 'draft',
      attemptId: steps[0]!.attempt_id,
      taskId: steps[0]!.task_id,
    });
    expect(status.activity.filter((a) => a.eventType === 'workflow.step.completed')).toHaveLength(
      3
    );
  });

  it('blocks downstream steps after failure and never reports success', async () => {
    const f = await fixture();
    await f.tick();
    const steps = await loadWorkflowSteps(testEnv, f.run.runId);
    await finish(f.input.projectId, steps[0]!.task_id, 'failed');
    await f.tick();
    await f.tick();
    const status = await getWorkflowRun(testEnv, f.input.projectId, f.input.userId, f.run.runId);
    expect(status.status).toBe('needs_attention');
    expect(status.steps.map((s) => s.status)).toEqual(['failed', 'blocked', 'blocked']);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('repairs a crash after task commit using the same task, session and initial message', async () => {
    const f = await fixture();
    let fail = true;
    const crash = {
      ...f.deps,
      submission: {
        ...f.deps.submission,
        afterD1Commit: () => {
          if (fail) {
            fail = false;
            throw new Error('worker restarted');
          }
        },
      },
    };
    const row = await env.DATABASE.prepare('SELECT * FROM missions WHERE id = ?')
      .bind(f.run.runId)
      .first<WorkflowRunRow>();
    await reconcileWorkflowRun(testEnv, row!, crash);
    await env.DATABASE.prepare('UPDATE mission_steps SET next_attempt_at = 0 WHERE mission_id = ?')
      .bind(f.run.runId)
      .run();
    await f.tick();
    await f.tick();
    const steps = await loadWorkflowSteps(testEnv, f.run.runId);
    expect(steps[0]!.state).toBe('running');
    expect(f.start).toHaveBeenCalledTimes(1);
    const counts = await env.DATABASE.prepare(
      'SELECT COUNT(*) AS n FROM tasks WHERE mission_id = ?'
    )
      .bind(f.run.runId)
      .first<{ n: number }>();
    expect(counts?.n).toBe(1);
    const messages = await projectData.getMessages(
      testEnv,
      f.input.projectId,
      steps[0]!.session_id,
      10,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(messages.messages).toHaveLength(1);
  });

  it('confirms a lost launch acknowledgement without creating another agent', async () => {
    const f = await fixture();
    f.start.mockImplementationOnce(async (_env, startInput) => {
      f.launched.add(startInput.taskId);
      throw new Error('ack lost');
    });
    await f.tick();
    await f.tick();
    expect((await loadWorkflowSteps(testEnv, f.run.runId))[0]!.state).toBe('running');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent request retries and rejects key reuse for another plan', async () => {
    const f = await fixture();
    const results = await Promise.all([
      startWorkflowRun(testEnv, f.input),
      startWorkflowRun(testEnv, f.input),
    ]);
    expect(results.every((r) => r.runId === f.run.runId && r.reused)).toBe(true);
    await expect(
      startWorkflowRun(testEnv, { ...f.input, plan: { ...f.input.plan, title: 'Different' } })
    ).rejects.toThrow('different workflow plan');
  });

  it('rejects another owner and blocks execution after membership revocation', async () => {
    const f = await fixture();
    await expect(
      getWorkflowRun(testEnv, f.input.projectId, 'other-user', f.run.runId)
    ).rejects.toThrow();
    await env.DATABASE.prepare(
      "UPDATE project_members SET status='removed' WHERE project_id = ? AND user_id = ?"
    )
      .bind(f.input.projectId, f.input.userId)
      .run();
    await f.tick();
    expect(f.start).not.toHaveBeenCalled();
    expect((await loadWorkflowSteps(testEnv, f.run.runId))[0]!.state).toBe('failed');
  });

  it('rejects changed profile configuration before starting a step', async () => {
    const f = await fixture();
    await env.DATABASE.prepare("UPDATE agent_profiles SET model='changed-model' WHERE id = ?")
      .bind(f.input.plan.steps[0]!.agentProfileId)
      .run();
    await f.tick();
    expect(f.start).not.toHaveBeenCalled();
    expect((await loadWorkflowSteps(testEnv, f.run.runId))[0]!.reason).toContain('profile changed');
  });

  it('keeps independent branches moving when one prerequisite fails', async () => {
    const f = await fixture();
    const second = await startWorkflowRun(testEnv, {
      ...f.input,
      requestKey: 'parallel',
      plan: {
        ...f.input.plan,
        steps: [
          f.input.plan.steps[0]!,
          { ...f.input.plan.steps[1]!, after: [] },
          f.input.plan.steps[2]!,
        ],
      },
    });
    const tick = async () => {
      const row = await env.DATABASE.prepare('SELECT * FROM missions WHERE id=?')
        .bind(second.runId)
        .first<WorkflowRunRow>();
      await reconcileWorkflowRun(testEnv, row!, f.deps);
    };
    await tick();
    const steps = await loadWorkflowSteps(testEnv, second.runId);
    await finish(f.input.projectId, steps[0]!.task_id, 'failed');
    await finish(f.input.projectId, steps[1]!.task_id, 'completed');
    await tick();
    expect((await loadWorkflowSteps(testEnv, second.runId)).map((s) => s.state)).toEqual([
      'failed',
      'completed',
      'running',
    ]);
  });

  it('expires a run even when handoff retrieval is unavailable', async () => {
    const f = await fixture();
    await f.tick();
    const steps = await loadWorkflowSteps(testEnv, f.run.runId);
    await finish(f.input.projectId, steps[0]!.task_id, 'completed');
    vi.spyOn(projectData, 'getHandoffPacketsForTask').mockRejectedValue(
      new Error('DO unavailable')
    );
    await env.DATABASE.prepare('UPDATE missions SET workflow_deadline_at=0 WHERE id=?')
      .bind(f.run.runId)
      .run();
    await f.tick();
    await f.tick();
    expect(
      (await getWorkflowRun(testEnv, f.input.projectId, f.input.userId, f.run.runId)).status
    ).toBe('needs_attention');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('preserves active-run history after delivery outbox retention', async () => {
    const f = await fixture();
    await f.tick();
    await env.DATABASE.prepare(
      "DELETE FROM project_event_source_outbox WHERE project_id=? AND source='sam.workflow'"
    )
      .bind(f.input.projectId)
      .run();
    const status = await getWorkflowRun(testEnv, f.input.projectId, f.input.userId, f.run.runId);
    expect(status.activity.map((e) => e.eventType)).toContain('workflow.step.running');
  });

  it('does not consume launch retry budget while task capacity is full', async () => {
    const f = await fixture();
    await env.DATABASE.prepare('UPDATE projects SET max_concurrent_tasks=1 WHERE id=?')
      .bind(f.input.projectId)
      .run();
    const other = `other-${crypto.randomUUID()}`;
    await seedTask(other, f.input.projectId, f.input.userId, { status: 'in_progress' });
    await env.DATABASE.prepare('UPDATE tasks SET dispatch_depth=1 WHERE id=?').bind(other).run();
    await f.tick();
    await f.tick();
    const step = (await loadWorkflowSteps(testEnv, f.run.runId))[0]!;
    expect(step.state).toBe('waiting');
    expect(step.launch_retries).toBe(0);
    expect(f.start).not.toHaveBeenCalled();
    await finish(f.input.projectId, other, 'completed');
    await f.tick();
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('exposes start and status through authenticated MCP routes', async () => {
    const f = await fixture();
    const token = `workflow-token-${crypto.randomUUID()}`;
    await storeMcpToken(testEnv.KV, token, {
      projectId: f.input.projectId,
      userId: f.input.userId,
      taskId: f.input.parentTaskId,
      workspaceId: 'test-workspace',
      taskMode: 'conversation',
      createdAt: new Date().toISOString(),
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const body = await response.json<{
        error?: unknown;
        result: { content: Array<{ text: string }> };
      }>();
      expect(response.status).toBe(200);
      expect(body.error).toBeUndefined();
      return JSON.parse(body.result.content[0]!.text);
    };
    const started = await call('start_workflow_run', {
      requestKey: 'http-route',
      plan: f.input.plan,
    });
    const status = await call('get_workflow_run', { runId: started.runId });
    expect(status.steps.map((s: { key: string }) => s.key)).toEqual(['draft', 'review', 'revise']);
    expect(status.status).toBe('active');
  });

  it('uses the real orchestrator alarm to stop a failed workflow and disarm', async () => {
    const f = await fixture();
    await f.tick();
    const steps = await loadWorkflowSteps(testEnv, f.run.runId);
    await finish(f.input.projectId, steps[0]!.task_id, 'failed');
    await runInDurableObject(f.orchestrator, async (instance) => {
      await instance.ctx.storage.deleteAlarm();
      await instance.alarm();
      await instance.alarm();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
      expect(
        instance.ctx.storage.sql
          .exec('SELECT * FROM orchestrator_missions WHERE mission_id=?', f.run.runId)
          .toArray()
      ).toHaveLength(0);
    });
    expect(
      (await getWorkflowRun(testEnv, f.input.projectId, f.input.userId, f.run.runId)).status
    ).toBe('needs_attention');
  });

  it('admits workflow identity events through the existing ProjectData event system', async () => {
    const f = await fixture();
    await f.tick();
    const outbox = await env.DATABASE.prepare(
      "SELECT id FROM project_event_source_outbox WHERE project_id=? AND source='sam.workflow' AND event_type='workflow.step.running'"
    )
      .bind(f.input.projectId)
      .first<{ id: string }>();
    const receipt = await admitProjectEventSourceIntentById(testEnv, outbox!.id);
    expect(receipt).toMatchObject({ state: 'admitted' });
    const replay = await admitProjectEventSourceIntentById(testEnv, outbox!.id);
    expect(replay).toMatchObject({ state: 'admitted' });
  });

  it('ignores incoming handoffs and fails malformed own output explicitly', async () => {
    const f = await fixture();
    await f.tick();
    const first = (await loadWorkflowSteps(testEnv, f.run.runId))[0]!;
    await projectData.createHandoffPacket(
      testEnv,
      f.input.projectId,
      f.run.runId,
      f.input.parentTaskId,
      first.task_id,
      'Unrelated message',
      [],
      [],
      [null],
      []
    );
    await finish(f.input.projectId, first.task_id, 'completed');
    await f.tick();
    let steps = await loadWorkflowSteps(testEnv, f.run.runId);
    expect(steps[0]!.state).toBe('completed');
    expect(JSON.parse(steps[0]!.result_json!).handoffs).toEqual([]);
    await projectData.createHandoffPacket(
      testEnv,
      f.input.projectId,
      f.run.runId,
      steps[1]!.task_id,
      null,
      'Malformed output',
      [],
      [],
      [null],
      []
    );
    await finish(f.input.projectId, steps[1]!.task_id, 'completed');
    await f.tick();
    steps = await loadWorkflowSteps(testEnv, f.run.runId);
    expect(steps[1]!.reason).toContain('malformed artifact');
    expect(steps[2]!.state).toBe('blocked');
  });

  it('rejects a late commit after its registration lease has expired', async () => {
    const f = await fixture();
    const actual = orchestratorService.startOrchestration;
    vi.spyOn(orchestratorService, 'startOrchestration').mockImplementation(async (...args) => {
      await actual(...args);
      // Simulate a delayed D1 submission without sleeping through the grace period.
      vi.spyOn(Date, 'now').mockRestore();
    });
    // The registration deadline is derived from this request clock, while D1's
    // database clock remains real. The INSERT must reject an expired lease.
    vi.spyOn(Date, 'now').mockReturnValue(1);
    await expect(
      startWorkflowRun(testEnv, { ...f.input, requestKey: 'expired-registration' })
    ).rejects.toThrow('Could not reserve');
    const count = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS n FROM missions WHERE workflow_request_key='expired-registration'"
    ).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('reserves only one run for concurrent initial submissions', async () => {
    const f = await fixture();
    const results = await Promise.all([
      startWorkflowRun(testEnv, { ...f.input, requestKey: 'concurrent' }),
      startWorkflowRun(testEnv, { ...f.input, requestKey: 'concurrent' }),
    ]);
    expect(results[0]!.runId).toBe(results[1]!.runId);
    expect(await loadWorkflowSteps(testEnv, results[0]!.runId)).toHaveLength(3);
  });

  it('revokes a physical runner start when the workflow is no longer active', async () => {
    const f = await fixture();
    await f.tick();
    const first = (await loadWorkflowSteps(testEnv, f.run.runId))[0]!;
    const checkpoint = await env.DATABASE.prepare(
      'SELECT intent_fingerprint FROM task_submission_checkpoints WHERE task_id=?'
    )
      .bind(first.task_id)
      .first<{ intent_fingerprint: string }>();
    const guard = {
      kind: 'reserved_submission',
      taskId: first.task_id,
      projectId: f.input.projectId,
      userId: f.input.userId,
      chatSessionId: first.session_id,
      intentFingerprint: checkpoint!.intent_fingerprint,
    };
    await expect(assertTaskRunnerStartGuard(testEnv, guard)).resolves.toBeUndefined();
    await env.DATABASE.prepare("UPDATE missions SET status='failed' WHERE id=?")
      .bind(f.run.runId)
      .run();
    await expect(assertTaskRunnerStartGuard(testEnv, guard)).rejects.toThrow();
  });

  it('rejects invalid graphs before creating work', () => {
    const step = {
      key: 'a',
      title: 'A',
      instructions: 'Do A',
      agentProfileId: 'profile',
      after: ['b'],
    };
    const plan = {
      title: 'Test',
      goal: 'Test',
      steps: [step, { ...step, key: 'b', after: ['a'] }],
    };
    expect(() => parseWorkflowPlan(plan, testEnv, 25)).toThrow('cycles');
    expect(() => parseWorkflowPlan({ ...plan, steps: [step] }, testEnv, 25)).toThrow(
      'Unknown prerequisite'
    );
    expect(() => parseWorkflowPlan({ ...plan, steps: [step, step] }, testEnv, 25)).toThrow(
      'unique'
    );
  });
});
