import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { projectEventSourceOutboxInsertStatement } from './project-event-source-outbox';
import { workflowFingerprint } from './workflow-plan';
import type { WorkflowRunRow, WorkflowStepRow } from './workflow-runs';

/** Only the server publishes workflow lifecycle events. Payloads carry references, not agent text. */
export async function workflowEventStatements(
  env: Env,
  run: WorkflowRunRow,
  state: string,
  step?: WorkflowStepRow
) {
  const eventType = step ? `workflow.step.${state}` : `workflow.run.${state}`;
  const metadata = {
    runId: run.id,
    ownerUserId: run.user_id,
    ...(step
      ? {
          stepId: step.step_key,
          attemptId: step.attempt_id,
          taskId: step.task_id,
          sessionId: step.session_id,
        }
      : {}),
  };
  const input: AdmitProjectEventInput = {
    projectId: run.project_id,
    source: 'sam.workflow',
    eventType,
    subject: { type: 'workflow_run', id: run.id },
    severity: state === 'failed' || state === 'needs_attention' ? 'warning' : 'info',
    deliveryKey: `${run.id}:${step?.attempt_id ?? 'run'}:${state}`,
    payloadFingerprint: await workflowFingerprint({ eventType, metadata }),
    metadata,
    display: { title: step ? `${step.title}: ${state}` : `${run.title}: ${state}` },
  };
  return [
    projectEventSourceOutboxInsertStatement(env, input),
    env.DATABASE.prepare(
      'INSERT OR IGNORE INTO mission_workflow_events (id,mission_id,event_type,event_payload_json,created_at) VALUES (?,?,?,?,?)'
    ).bind(input.deliveryKey, run.id, eventType, JSON.stringify(input), new Date().toISOString()),
  ];
}
