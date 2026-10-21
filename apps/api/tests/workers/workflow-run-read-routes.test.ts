/**
 * Workflow run reads for project members, end to end on real D1: runs are accepted and
 * advanced by the real engine, and every read goes through the production worker
 * (`SELF.fetch` → index.ts mount → session auth → `task:read` → read model → onError).
 */
import type {
  WorkflowRunDetailResponse,
  WorkflowRunListResponse,
} from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import * as projectData from '../../src/services/project-data';
import { getWorkflowRun, loadWorkflowSteps } from '../../src/services/workflow-runs';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';
import { finishStepTask, workflowRunFixture } from './helpers/workflow-run-fixture';

const testEnv = env as unknown as Env;
const API = `https://api.${testEnv.BASE_DOMAIN}`;

afterEach(() => vi.restoreAllMocks());

async function read<T>(cookie: string, path: string): Promise<{ status: number; body: T }> {
  const response = await SELF.fetch(`${API}${path}`, { headers: { Cookie: cookie } });
  return { status: response.status, body: (await response.json()) as T };
}

async function addMember(projectId: string, userId: string, role: string, status = 'active') {
  await seedUser(userId);
  await env.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now'))`
  )
    .bind(projectId, userId, role, status)
    .run();
  return seedSignedInUser(userId);
}

describe('workflow run detail for project members', () => {
  it('shows each step with its inputs, outputs, evidence, linked chats and timing', async () => {
    const f = await workflowRunFixture();
    const runId = await f.startRun('detail');
    await f.tick(runId);
    let steps = await loadWorkflowSteps(testEnv, runId);
    await projectData.createHandoffPacket(
      testEnv,
      f.projectId,
      runId,
      steps[0]!.task_id,
      null,
      'Draft is in the Library',
      [],
      [],
      [{ type: 'library_file', ref: 'library-doc-123' }],
      []
    );
    await finishStepTask(f.projectId, steps[0]!.task_id, {
      status: 'completed',
      summary: 'Draft saved as Library file library-doc-123',
      evidence: { testsRun: [{ command: 'pnpm lint docs', passed: true }], notes: 'Checked links' },
    });
    await f.tick(runId);
    steps = await loadWorkflowSteps(testEnv, runId);

    const cookie = await seedSignedInUser(f.userId);
    const { status, body } = await read<WorkflowRunDetailResponse>(
      cookie,
      `/api/projects/${f.projectId}/workflows/${runId}`
    );
    expect(status).toBe(200);
    const { run } = body;
    expect(run).toMatchObject({
      id: runId,
      title: 'Write and review the release notes',
      goal: 'Produce reviewed release notes in the project Library',
      status: 'active',
      startedByUserId: f.userId,
      startedFrom: {
        taskId: f.parentTaskId,
        sessionId: `chat-${f.parentTaskId}`,
        title: 'Plan the release notes',
      },
      maxParallelSteps: 2,
    });
    expect(Date.parse(run.deadlineAt!)).toBeGreaterThan(Date.now());
    expect(run.steps.map((step) => [step.key, step.status, step.after])).toEqual([
      ['draft', 'completed', []],
      ['review', 'running', ['draft']],
      ['revise', 'waiting', ['review']],
    ]);

    const [draft, review, revise] = run.steps;
    expect(draft).toMatchObject({
      kind: 'agent',
      instructions: 'Do the draft work',
      agent: {
        profileId: f.profileId,
        profileName: 'Writer',
        agentType: 'opencode',
        model: 'test-model',
      },
      taskId: steps[0]!.task_id,
      taskStatus: 'completed',
      launchAttempts: 1,
      wait: null,
      output: {
        summary: 'Draft saved as Library file library-doc-123',
        evidence: {
          testsRun: [{ command: 'pnpm lint docs', passed: true }],
          notes: 'Checked links',
        },
        handoffs: [{ artifactRefs: [{ type: 'library_file', ref: 'library-doc-123' }] }],
      },
    });
    // The chat link is the task's own chat, and timing comes from the lifecycle events.
    expect(draft!.sessionId).toBe(steps[0]!.session_id);
    expect(draft!.startedAt).not.toBeNull();
    expect(Date.parse(draft!.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(draft!.startedAt!));
    expect(review).toMatchObject({
      taskId: steps[1]!.task_id,
      sessionId: steps[1]!.session_id,
      finishedAt: null,
    });
    // Identities are reserved up front, but a step that never started links nowhere.
    expect(revise).toMatchObject({
      taskId: null,
      sessionId: null,
      taskStatus: null,
      output: null,
      startedAt: null,
    });

    expect(run.activity.map((entry) => [entry.stepKey, entry.state])).toEqual([
      ['draft', 'starting'],
      ['draft', 'running'],
      ['draft', 'completed'],
      ['review', 'starting'],
      ['review', 'running'],
    ]);
  });

  it('reads a failed run honestly: the failure reason, blocked dependents, needs attention', async () => {
    const f = await workflowRunFixture();
    const runId = await f.startRun('failure');
    await f.tick(runId);
    const steps = await loadWorkflowSteps(testEnv, runId);
    await finishStepTask(f.projectId, steps[0]!.task_id, {
      status: 'failed',
      reason: 'Agent could not reach the Library',
    });
    await f.tick(runId);
    await f.tick(runId);

    const cookie = await seedSignedInUser(f.userId);
    const { body } = await read<WorkflowRunDetailResponse>(
      cookie,
      `/api/projects/${f.projectId}/workflows/${runId}`
    );
    expect(body.run.status).toBe('needs_attention');
    expect(body.run.steps.map((step) => [step.status, step.reason])).toEqual([
      ['failed', expect.stringContaining('Agent could not reach the Library')],
      ['blocked', 'Blocked: draft did not succeed'],
      ['blocked', 'Blocked: review did not succeed'],
    ]);
    expect(body.run.steps[0]!.taskStatus).toBe('failed');
    expect(body.run.activity.at(-1)).toMatchObject({ stepKey: null, state: 'needs_attention' });
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('lets a viewer read, and answers non-members and removed members with 404', async () => {
    const f = await workflowRunFixture();
    const runId = await f.startRun('access');
    const suffix = crypto.randomUUID();
    const viewer = await addMember(f.projectId, `wf-viewer-${suffix}`, 'viewer');
    const removed = await addMember(f.projectId, `wf-removed-${suffix}`, 'maintainer', 'removed');
    await seedUser(`wf-outsider-${suffix}`);
    const outsider = await seedSignedInUser(`wf-outsider-${suffix}`);

    const path = `/api/projects/${f.projectId}/workflows`;
    expect((await read(viewer, path)).status).toBe(200);
    expect((await read(viewer, `${path}/${runId}`)).status).toBe(200);
    for (const cookie of [removed, outsider]) {
      expect((await read(cookie, path)).status).toBe(404);
      expect((await read(cookie, `${path}/${runId}`)).status).toBe(404);
    }
    const anonymous = await SELF.fetch(`${API}${path}`);
    expect(anonymous.status).toBe(401);
  });

  it("never serves another project's run through a project the caller can read", async () => {
    const victim = await workflowRunFixture();
    const victimRun = await victim.startRun('victim', 'Victim run');
    // The attacker owns a different project and asks for the victim's run through it.
    const suffix = crypto.randomUUID();
    const attackerId = `wf-attacker-${suffix}`;
    const attackerProject = `wf-attacker-project-${suffix}`;
    await seedUser(attackerId);
    await seedInstallation(`wf-attacker-i-${suffix}`, attackerId);
    await seedProject(attackerProject, attackerId, `wf-attacker-i-${suffix}`);
    const attacker = await seedSignedInUser(attackerId);

    const attack = await read<{ error: string }>(
      attacker,
      `/api/projects/${attackerProject}/workflows/${victimRun}`
    );
    expect(attack.status).toBe(404);
    const list = await read<WorkflowRunListResponse>(
      attacker,
      `/api/projects/${attackerProject}/workflows`
    );
    expect(list.body.runs).toEqual([]);

    // Owner-path control: the same run is readable through its own project.
    const owner = await seedSignedInUser(victim.userId);
    const control = await read<WorkflowRunDetailResponse>(
      owner,
      `/api/projects/${victim.projectId}/workflows/${victimRun}`
    );
    expect(control.status).toBe(200);
    expect(control.body.run.title).toBe('Victim run');
  });

  it('degrades one malformed column to an empty field instead of failing the read', async () => {
    const f = await workflowRunFixture();
    const runId = await f.startRun('malformed');
    await f.tick(runId);
    await env.DATABASE.prepare(
      `UPDATE mission_steps SET after_json = 'not json', profile_snapshot_json = '{', result_json = '{"summary":'
       WHERE mission_id = ? AND step_key = 'review'`
    )
      .bind(runId)
      .run();
    await env.DATABASE.prepare(
      `UPDATE mission_workflow_events SET event_payload_json = 'nope' WHERE mission_id = ? AND event_type = 'workflow.step.starting'`
    )
      .bind(runId)
      .run();
    const warn = vi.spyOn(console, 'warn');

    const cookie = await seedSignedInUser(f.userId);
    const { status, body } = await read<WorkflowRunDetailResponse>(
      cookie,
      `/api/projects/${f.projectId}/workflows/${runId}`
    );
    expect(status).toBe(200);
    const review = body.run.steps.find((step) => step.key === 'review')!;
    expect(review).toMatchObject({
      after: [],
      output: null,
      agent: { profileId: f.profileId, profileName: null },
    });
    // Neighbours are intact, and the corrupted event is the only one missing.
    expect(body.run.steps.find((step) => step.key === 'revise')!.after).toEqual(['review']);
    expect(body.run.activity.map((entry) => entry.state)).toEqual(['running']);
    expect(JSON.stringify(warn.mock.calls)).toContain('workflow_read.field_skipped');

    // The owner's MCP read survives the same rows.
    const mcp = await getWorkflowRun(testEnv, f.projectId, f.userId, runId);
    expect(mcp.steps.find((step) => step.key === 'review')).toMatchObject({
      after: [],
      result: null,
    });
  });
});

describe('workflow run list for project members', () => {
  it('pages newest first with a cursor and filters by status', async () => {
    const f = await workflowRunFixture([{ key: 'only', title: 'Only step' }]);
    const first = await f.startRun('first', 'First run');
    const second = await f.startRun('second', 'Second run');
    const third = await f.startRun('third', 'Third run');
    // Fail the second run so the status filter has something to separate.
    await f.tick(second);
    const [step] = await loadWorkflowSteps(testEnv, second);
    await finishStepTask(f.projectId, step!.task_id, { status: 'failed', reason: 'Tests failed' });
    await f.tick(second);

    const cookie = await seedSignedInUser(f.userId);
    const base = `/api/projects/${f.projectId}/workflows`;
    const page1 = await read<WorkflowRunListResponse>(cookie, `${base}?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.runs.map((run) => run.id)).toEqual([third, second]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    expect(page1.body.runs[1]).toMatchObject({
      title: 'Second run',
      status: 'needs_attention',
      startedByUserId: f.userId,
      steps: [
        {
          key: 'only',
          title: 'Only step',
          kind: 'agent',
          status: 'failed',
          reason: expect.stringContaining('Tests failed'),
        },
      ],
    });

    const page2 = await read<WorkflowRunListResponse>(
      cookie,
      `${base}?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor!)}`
    );
    expect(page2.body.runs.map((run) => run.id)).toEqual([first]);
    expect(page2.body.nextCursor).toBeNull();

    const attention = await read<WorkflowRunListResponse>(cookie, `${base}?status=needs_attention`);
    expect(attention.body.runs.map((run) => run.id)).toEqual([second]);
    const active = await read<WorkflowRunListResponse>(cookie, `${base}?status=active`);
    expect(active.body.runs.map((run) => run.id)).toEqual([third, first]);
  });

  it('rejects an unknown status or a forged cursor', async () => {
    const f = await workflowRunFixture();
    const cookie = await seedSignedInUser(f.userId);
    const base = `/api/projects/${f.projectId}/workflows`;
    expect((await read(cookie, `${base}?status=failed`)).status).toBe(400);
    expect((await read(cookie, `${base}?cursor=not-a-cursor`)).status).toBe(400);
  });

  it('caps a step reason in list rows; the run page has the full text', async () => {
    const f = await workflowRunFixture([{ key: 'only', title: 'Only step' }]);
    const runId = await f.startRun('long-reason');
    await env.DATABASE.prepare(
      "UPDATE mission_steps SET state = 'failed', reason = ? WHERE mission_id = ?"
    )
      .bind('x'.repeat(5000), runId)
      .run();
    const cookie = await seedSignedInUser(f.userId);
    const list = await read<WorkflowRunListResponse>(
      cookie,
      `/api/projects/${f.projectId}/workflows`
    );
    expect(list.body.runs[0]!.steps[0]!.reason).toHaveLength(300);
    const detail = await read<WorkflowRunDetailResponse>(
      cookie,
      `/api/projects/${f.projectId}/workflows/${runId}`
    );
    expect(detail.body.run.steps[0]!.reason).toHaveLength(5000);
  });
});

describe('MCP get_workflow_run after the shared read', () => {
  it('keeps its original shape', async () => {
    const f = await workflowRunFixture();
    const runId = await f.startRun('mcp-shape');
    await f.tick(runId);
    const status = await getWorkflowRun(testEnv, f.projectId, f.userId, runId);
    expect(Object.keys(status)).toEqual([
      'runId',
      'title',
      'goal',
      'status',
      'deadlineAt',
      'steps',
      'activity',
    ]);
    expect(typeof status.deadlineAt).toBe('number');
    expect(Object.keys(status.steps[0]!)).toEqual([
      'key',
      'title',
      'after',
      'status',
      'attemptId',
      'taskId',
      'sessionId',
      'reason',
      'launchRetries',
      'result',
    ]);
    const steps = await loadWorkflowSteps(testEnv, runId);
    expect(status.steps[0]).toMatchObject({
      taskId: steps[0]!.task_id,
      sessionId: steps[0]!.session_id,
    });
    expect(status.steps[1]).toMatchObject({ taskId: null, sessionId: null });
    expect(status.activity[0]).toMatchObject({
      eventType: 'workflow.step.starting',
      event: { metadata: { runId, stepId: 'draft' } },
    });
    await expect(getWorkflowRun(testEnv, f.projectId, `someone-else`, runId)).rejects.toThrow();
  });
});
