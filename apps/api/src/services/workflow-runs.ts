import type { CredentialSource } from '@simple-agent-manager/shared';
import { resolveOrchestratorConfig } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getMcpLimits } from '../routes/mcp/_helpers';
import { startOrchestration } from './project-orchestrator';
import { resolveSkillProfile } from './skills';
import { assertReservedTaskCreatorAuthority } from './task-runner-start-guard';
import { getWorkflowConfig } from './workflow-config';
import { parseWorkflowPlan, workflowFingerprint, type WorkflowPlan } from './workflow-plan';
import { loadWorkflowRun, toMcpWorkflowRun } from './workflow-run-read';
import { workflowProjectSnapshot } from './workflow-snapshot';

export interface WorkflowRunRow {
  id: string;
  project_id: string;
  user_id: string;
  title: string;
  description: string;
  root_task_id: string;
  status: string;
  workflow_plan_json: string;
  workflow_plan_fingerprint: string;
  workflow_deadline_at: number;
  created_at: string;
  updated_at: string;
}
export interface WorkflowStepRow {
  mission_id: string;
  step_key: string;
  ordinal: number;
  title: string;
  instructions: string;
  after_json: string;
  profile_id: string;
  profile_snapshot_json: string;
  state: 'waiting' | 'starting' | 'running' | 'completed' | 'failed' | 'blocked';
  attempt_id: string;
  task_id: string;
  session_id: string;
  submission_json: string | null;
  launch_retries: number;
  next_attempt_at: number;
  result_json: string | null;
  reason: string | null;
  updated_at: string;
}
export interface WorkflowSnapshot {
  plan: WorkflowPlan;
  dispatchDepth: number;
  projectSnapshotJson: string;
  credentialAttribution: { userId: string; projectId: string | null; source: CredentialSource };
}

export async function loadWorkflowSteps(env: Env, runId: string): Promise<WorkflowStepRow[]> {
  return (
    await env.DATABASE.prepare('SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY ordinal')
      .bind(runId)
      .all<WorkflowStepRow>()
  ).results;
}

export async function startWorkflowRun(
  env: Env,
  input: {
    projectId: string;
    userId: string;
    parentTaskId: string;
    requestKey: string;
    plan: unknown;
  }
) {
  await assertReservedTaskCreatorAuthority(env, 'workflow', input.projectId, input.userId);
  const config = await getWorkflowConfig(env);
  const plan = parseWorkflowPlan(input.plan, env, config.maxSteps);
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.requestKey))
    throw new Error(
      'requestKey must be 1–160 letters, digits, dots, colons, underscores or hyphens'
    );
  const fingerprint = await workflowFingerprint({ parentTaskId: input.parentTaskId, plan });
  const existing = await env.DATABASE.prepare(
    `SELECT * FROM missions WHERE project_id = ? AND user_id = ? AND workflow_request_key = ?`
  )
    .bind(input.projectId, input.userId, input.requestKey)
    .first<WorkflowRunRow>();
  if (existing) {
    if (existing.workflow_plan_fingerprint !== fingerprint)
      throw new Error('requestKey already belongs to a different workflow plan');
    if (existing.status === 'active') await startOrchestration(env, input.projectId, existing.id);
    return {
      runId: existing.id,
      status: existing.status === 'failed' ? 'needs_attention' : existing.status,
      reused: true,
    };
  }
  const parent = await env.DATABASE.prepare(
    `SELECT t.dispatch_depth, t.status,
    t.credential_attribution_user_id, t.credential_attribution_project_id, t.credential_attribution_source,
    p.max_dispatch_depth FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = ? AND t.project_id = ? AND t.user_id = ?`
  )
    .bind(input.parentTaskId, input.projectId, input.userId)
    .first<{
      dispatch_depth: number;
      status: string;
      max_dispatch_depth: number | null;
      credential_attribution_user_id: string | null;
      credential_attribution_project_id: string | null;
      credential_attribution_source: CredentialSource | null;
    }>();
  if (
    !parent ||
    !['queued', 'in_progress', 'delegated', 'awaiting_followup'].includes(parent.status)
  )
    throw new Error('An active task owned by the workflow owner is required');
  const depth = parent.dispatch_depth + 1;
  if (depth > (parent.max_dispatch_depth ?? getMcpLimits(env).dispatchMaxDepth))
    throw new Error('Workflow exceeds project dispatch depth limit');
  const source = parent.credential_attribution_source ?? 'user';
  const db = drizzle(env.DATABASE, { schema });
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .limit(1);
  if (!project) throw new Error('Project not found');
  const snapshot: WorkflowSnapshot = {
    plan,
    dispatchDepth: depth,
    projectSnapshotJson: workflowProjectSnapshot(project),
    credentialAttribution: {
      userId: parent.credential_attribution_user_id ?? input.userId,
      projectId:
        source === 'project' ? (parent.credential_attribution_project_id ?? input.projectId) : null,
      source,
    },
  };
  const profiles: NonNullable<Awaited<ReturnType<typeof resolveSkillProfile>>>[] = [];
  for (const step of plan.steps) {
    const profile = await resolveSkillProfile(
      db,
      input.projectId,
      step.agentProfileId,
      null,
      input.userId,
      env
    );
    if (!profile) throw new Error(`Profile unavailable for ${step.key}`);
    if (profile.runtime === 'cf-container')
      throw new Error('Workflow steps currently require a VM profile');
    profiles.push(profile);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const deadline = Date.now() + config.lifetimeMs;
  // Register first: an RPC failure never leaves an accepted run without an alarm.
  // The existing empty-mission grace gives the atomic D1 batch time to commit.
  const registrationDeadline = Date.now() + resolveOrchestratorConfig(env).zeroTaskGraceMs;
  await startOrchestration(env, input.projectId, id, registrationDeadline);
  const insert = env.DATABASE.prepare(
    `INSERT INTO missions
    (id,project_id,user_id,title,description,status,root_task_id,workflow_plan_json,workflow_request_key,workflow_plan_fingerprint,workflow_deadline_at,created_at,updated_at)
    SELECT ?,?,?,?,?,'active',?,?,?,?,?,?,?
    WHERE (julianday('now') - 2440587.5) * 86400000 < ? AND (SELECT COUNT(*) FROM missions WHERE project_id = ? AND workflow_plan_json IS NOT NULL AND status IN ('active','paused')) < ?`
  ).bind(
    id,
    input.projectId,
    input.userId,
    plan.title,
    plan.goal,
    input.parentTaskId,
    JSON.stringify(snapshot),
    input.requestKey,
    fingerprint,
    deadline,
    now,
    now,
    registrationDeadline,
    input.projectId,
    config.maxActiveRuns
  );
  const statements = plan.steps.map((step, i) => {
    const taskId = ulid();
    const profile = profiles[i];
    if (!profile) throw new Error(`Missing profile for ${step.key}`);
    return env.DATABASE.prepare(
      `INSERT INTO mission_steps
      (mission_id,step_key,ordinal,title,instructions,after_json,profile_id,profile_snapshot_json,attempt_id,task_id,session_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      step.key,
      i,
      step.title,
      step.instructions,
      JSON.stringify(step.after),
      profile.profileId,
      JSON.stringify(profile),
      taskId,
      taskId,
      `chat_${taskId}`,
      now
    );
  });
  try {
    await env.DATABASE.batch([insert, ...statements]);
  } catch (error) {
    const winner = await env.DATABASE.prepare(
      `SELECT id,status,workflow_plan_fingerprint FROM missions WHERE project_id = ? AND user_id = ? AND workflow_request_key = ?`
    )
      .bind(input.projectId, input.userId, input.requestKey)
      .first<WorkflowRunRow>();
    if (winner?.workflow_plan_fingerprint === fingerprint)
      return {
        runId: winner.id,
        status: winner.status === 'failed' ? 'needs_attention' : winner.status,
        reused: true,
      };
    if (winner) throw new Error('requestKey already belongs to a different workflow plan');
    throw new Error('Could not reserve workflow; check the active-run limit', { cause: error });
  }
  return { runId: id, status: 'active', reused: false };
}

/** The owner's read (MCP). Project members read through `routes/workflows.ts`. */
export async function getWorkflowRun(env: Env, projectId: string, userId: string, runId: string) {
  await assertReservedTaskCreatorAuthority(env, 'workflow', projectId, userId);
  const loaded = await loadWorkflowRun(env, { projectId, runId, ownerUserId: userId });
  if (!loaded) throw new Error('Workflow run not found');
  return toMcpWorkflowRun(loaded);
}
