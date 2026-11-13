import {
  CHECKPOINT_EPISODE_STATES,
  type CheckpointEpisode,
  type CheckpointProgressEnvelope,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { parseRow, safeParseJson } from './core';

const ProgressScalarSchema = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
]);

const CheckpointProgressEnvelopeSchema = v.object({
  messageSequence: v.nullable(v.number()),
  progressAt: v.nullable(v.number()),
  gitHead: v.nullable(v.string()),
  gitFingerprint: v.nullable(v.string()),
  taskStatus: v.nullable(v.string()),
  taskExecutionStep: v.nullable(v.string()),
  childStatuses: v.record(v.string(), v.string()),
  metadata: v.record(v.string(), ProgressScalarSchema),
});

const CheckpointEpisodeRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  task_id: v.nullable(v.string()),
  workspace_id: v.nullable(v.string()),
  acp_session_id: v.string(),
  prompt_epoch: v.number(),
  reason: v.string(),
  state: v.picklist(CHECKPOINT_EPISODE_STATES),
  progress_envelope_json: v.nullable(v.string()),
  mailbox_message_id: v.nullable(v.string()),
  prompt_delivery_id: v.nullable(v.string()),
  preempt_requested_at: v.nullable(v.number()),
  preempt_accepted_at: v.nullable(v.number()),
  ready_observed_at: v.nullable(v.number()),
  resume_accepted_at: v.nullable(v.number()),
  completed_at: v.nullable(v.number()),
  failed_at: v.nullable(v.number()),
  attempt_count: v.number(),
  last_error: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parseCheckpointProgressEnvelope(value: unknown): CheckpointProgressEnvelope {
  return v.parse(CheckpointProgressEnvelopeSchema, value);
}

export function parseCheckpointEpisodeRow(row: unknown): CheckpointEpisode {
  const parsed = parseRow(CheckpointEpisodeRowSchema, row, 'checkpoint_episode');
  const envelope = parsed.progress_envelope_json
    ? parseCheckpointProgressEnvelope(safeParseJson(parsed.progress_envelope_json))
    : null;
  return {
    id: parsed.id,
    sessionId: parsed.session_id,
    taskId: parsed.task_id,
    workspaceId: parsed.workspace_id,
    acpSessionId: parsed.acp_session_id,
    promptEpoch: parsed.prompt_epoch,
    reason: parsed.reason,
    state: parsed.state,
    progressEnvelope: envelope,
    mailboxMessageId: parsed.mailbox_message_id,
    promptDeliveryId: parsed.prompt_delivery_id,
    preemptRequestedAt: parsed.preempt_requested_at,
    preemptAcceptedAt: parsed.preempt_accepted_at,
    readyObservedAt: parsed.ready_observed_at,
    resumeAcceptedAt: parsed.resume_accepted_at,
    completedAt: parsed.completed_at,
    failedAt: parsed.failed_at,
    attemptCount: parsed.attempt_count,
    lastError: parsed.last_error,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}
