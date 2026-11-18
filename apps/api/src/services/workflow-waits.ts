import type {
  ProjectEventFilterV1,
  ProjectEventSubscriptionEventSummary,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { resolveProjectEventLimits } from '../durable-objects/project-data/project-events-limits';
import type { Env } from '../env';
import {
  cancelProjectEventSubscription,
  createProjectEventSubscription,
  listProjectEventSubscriptionEvents,
} from './project-data';
import type { WorkflowRunRow, WorkflowStepRow } from './workflow-runs';

const waitDefinition = v.object({
  description: v.string(),
  source: v.string(),
  eventTypes: v.array(v.string()),
  subject: v.nullable(v.object({ type: v.string(), id: v.string() })),
  timeoutMs: v.number(),
});
type WorkflowWaitDefinition = v.InferOutput<typeof waitDefinition>;

function identity(run: WorkflowRunRow, step: WorkflowStepRow) {
  return {
    owner: { type: 'system' as const, id: `workflow:${run.id}:${step.step_key}` },
    target: { taskId: run.root_task_id },
  };
}

function filter(wait: WorkflowWaitDefinition): ProjectEventFilterV1 {
  return {
    version: 1,
    source: wait.source,
    eventType: wait.eventTypes,
    ...(wait.subject ? { subjectType: wait.subject.type, subjectId: wait.subject.id } : {}),
  };
}

/** Registration uses a stable key. A crash between the ProjectData RPC and D1 update replays it. */
export async function registerWorkflowWait(
  env: Env,
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  now: number
): Promise<boolean> {
  if (!step.wait_json) throw new Error('Wait definition is missing');
  const wait = v.parse(waitDefinition, JSON.parse(step.wait_json));
  if (step.wait_registration_at === null) {
    await env.DATABASE.prepare(
      "UPDATE mission_steps SET wait_registration_at = ?,updated_at = ? WHERE mission_id = ? AND step_key = ? AND state = 'waiting' AND wait_registration_at IS NULL"
    )
      .bind(now, new Date(now).toISOString(), run.id, step.step_key)
      .run();
    step.wait_registration_at = now;
  }
  const { owner, target } = identity(run, step);
  const created = await createProjectEventSubscription(env, run.project_id, {
    owner,
    idempotencyKey: `workflow-wait:${run.id}:${step.step_key}`,
    filter: filter(wait),
    deliveryPreference: { requested: 'record_only', resolved: 'record_only', target },
    reason: `Workflow ${run.id} step ${step.step_key}`,
    // Keep pre-deadline matches readable after a delayed orchestrator alarm.
    // ProjectData retains the event for this same finite window.
    expiresAt: run.workflow_deadline_at + resolveProjectEventLimits(env).retentionDays * 86_400_000,
  });
  await env.DATABASE.prepare(
    "UPDATE mission_steps SET wait_subscription_id = ?,wait_listening_at = ?,wait_timeout_at = ?,updated_at = ? WHERE mission_id = ? AND step_key = ? AND state = 'waiting'"
  )
    .bind(
      created.subscription.id,
      created.subscription.createdAt,
      Math.min(created.subscription.createdAt + wait.timeoutMs, run.workflow_deadline_at),
      new Date(now).toISOString(),
      run.id,
      step.step_key
    )
    .run();
  step.wait_subscription_id = created.subscription.id;
  step.wait_listening_at = created.subscription.createdAt;
  step.wait_timeout_at = Math.min(
    created.subscription.createdAt + wait.timeoutMs,
    run.workflow_deadline_at
  );
  return true;
}

/** The first canonical ProjectData match received by the deadline wins. Payload text is never forwarded. */
export async function findWorkflowWaitMatch(
  env: Env,
  run: WorkflowRunRow,
  step: WorkflowStepRow
): Promise<ProjectEventSubscriptionEventSummary | null> {
  if (!step.wait_subscription_id) return null;
  const { owner, target } = identity(run, step);
  let cursor: string | null = null;
  do {
    const page = await listProjectEventSubscriptionEvents(env, run.project_id, {
      subscriptionId: step.wait_subscription_id,
      visibility: { owner, target, userId: run.user_id },
      limit: resolveProjectEventLimits(env).listLimitMax,
      cursor,
    });
    if (!page) return null;
    for (const event of page.events) {
      if (event.source === 'sam.agent_channel' || event.matchedAt > (step.wait_timeout_at ?? 0))
        continue;
      return event;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

export async function cancelWorkflowWait(
  env: Env,
  run: WorkflowRunRow,
  step: WorkflowStepRow
): Promise<void> {
  if (!step.wait_subscription_id) return;
  const { owner } = identity(run, step);
  await cancelProjectEventSubscription(env, run.project_id, {
    subscriptionId: step.wait_subscription_id,
    cancelledBy: owner,
    reason: 'Workflow wait resolved',
  });
}
