import * as v from 'valibot';

import { interruptChat } from '../routes/chat-cancel';
import { snapshotInteractions } from '../services/acp-interaction-store';
import { connectorPendingInteractions } from '../services/connector-agent-answer';
import { executeConnectorWrite } from '../services/connector-execution';
import * as projectData from '../services/project-data';
import { requireSessionWriter } from '../services/session-access';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import { deliveryProjection, interactionProjection } from './operational-projections';
import { readOperation } from './operational-receipts';
import { chatStatus, operationalSession } from './operational-status';
import { defineOperation } from './types';

const id = v.pipe(v.string(), v.minLength(1));
const session = { projectId: id, sessionId: id };
const requestKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._:-]{1,128}$/));
export const samChatInterrupt = defineOperation({
  name: 'sam_chat_interrupt',
  title: 'Interrupt current prompt',
  kind: 'write',
  description:
    'Interrupt the current prompt only when the user explicitly asks. Preserves the chat and workspace; unlike sam_work_stop, does not cancel the task or tear down resources. Use status to select the runtime/turn. Reuse requestKey; never automatically retry with a new key after an uncertain result. Requires the runtime and promptStartedAt from status. Runtime atomically fences the turn; old runtimes return unsupported and are never cancelled through an unfenced fallback.',
  input: v.object({
    ...session,
    requestKey,
    expectedAgentSessionId: id,
    expectedPromptStartedAt: v.pipe(v.number(), v.minValue(1), v.integer()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId, 'task:write');
    // Check current writer authority even on a receipt replay.
    await requireSessionWriter(ctx.env, input.projectId, input.sessionId, ctx.actor.userId, {
      action: 'interrupt this session',
    });
    return executeConnectorWrite(
      { ...ctx, idempotencyKey: ctx.idempotencyKey ?? input.requestKey },
      'sam_chat_interrupt',
      input,
      () =>
        interruptChat(
          ctx.env,
          ctx.actor.userId,
          input.projectId,
          input.sessionId,
          input.expectedAgentSessionId,
          input.expectedPromptStartedAt
        )
    );
  },
});
export const samChatStatus = defineOperation({
  name: 'sam_chat_status',
  title: 'Inspect chat operational evidence',
  kind: 'read',
  description:
    'Read writer-only persisted runtime, task, wake, resource/cleanup and bounded diagnostic evidence without waking compute. Timestamps and unknown/not-live-verified states are authoritative about evidence, not a live runtime guarantee. Task completion, runtime idle, sleep and cleanup are distinct.',
  input: v.object(session),
  run: (ctx, input) => chatStatus(ctx, input.projectId, input.sessionId),
});
export const samChatDeliveryGet = defineOperation({
  name: 'sam_chat_delivery_get',
  title: 'Inspect message delivery',
  kind: 'read',
  description:
    'Look up the deliveryId from sam_chat_send. Returns queue/retry/receipt timestamps and safe error indicators, never prompt content. Delivered/accepted/acked do not prove semantic consumption. Does not retry, wake or interrupt.',
  input: v.object({ ...session, deliveryId: id }),
  async run(ctx, input) {
    await operationalSession(ctx, input.projectId, input.sessionId);
    const m = await projectData.getMailboxMessage(ctx.env, input.projectId, input.deliveryId);
    if (!m || m.targetSessionId !== input.sessionId)
      throw new OperationError('not_found', 'Delivery not found in this session');
    return deliveryProjection({ ...m });
  },
});
export const samChatInteractions = defineOperation({
  name: 'sam_chat_interactions',
  title: 'Read pending and settled agent requests',
  kind: 'read',
  description:
    'Read current writer-authorized permission options/form schemas and settled interaction summaries. Includes active shared-session writers. Use cursor for older settled history, not forward changes or transcript paging. This read never answers or approves anything; every sam_agent_answer still requires user confirmation. Answer acceptance is not proof of runtime delivery.',
  input: v.object({ ...session, cursor: v.optional(id) }),
  async run(ctx, input) {
    await operationalSession(ctx, input.projectId, input.sessionId);
    const [snapshot, pending] = await Promise.all([
      snapshotInteractions(ctx.env, input.projectId, input.sessionId, input.cursor ?? null),
      connectorPendingInteractions(ctx.env, input.projectId, input.sessionId),
    ]);
    return {
      pending,
      settled: snapshot.settled.map((row) => interactionProjection({ ...row })),
      cursor: snapshot.cursor,
      evidence: 'persisted_interaction_snapshot',
      attentionMarkers: 'use_sam_inbox_get_and_sam_chat_read',
    };
  },
});
async function fingerprint(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value))
  );
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export const samWorkChanges = defineOperation({
  name: 'sam_work_changes',
  title: 'Read incremental work changes',
  kind: 'read',
  description:
    'Bounded pull watch of current chat operational state and pending/settled request summaries. Reuse returned cursor. Coalesces intermediate transitions: NOT a lossless event stream or push subscription. Reconcile current snapshot after reconnect; reads never wake compute. changed=false means unchanged retained evidence, not a liveness guarantee.',
  input: v.object({ ...session, cursor: v.optional(id) }),
  async run(ctx, input) {
    const status = await chatStatus(ctx, input.projectId, input.sessionId);
    const interactions = await snapshotInteractions(ctx.env, input.projectId, input.sessionId);
    const summary = {
      ...status,
      observedAt: undefined,
      interactions: {
        pending: interactions.pending.map((row) => interactionProjection({ ...row })),
        settled: interactions.settled.map((row) => interactionProjection({ ...row })),
      },
    };
    const scope = await fingerprint([ctx.actor.userId, input.projectId, input.sessionId]);
    if (input.cursor && !new RegExp(`^v1:${scope}:[a-f0-9]{64}$`).test(input.cursor)) {
      throw new OperationError(
        'invalid_input',
        'Cursor does not match this actor/project/session; resync without cursor'
      );
    }
    const cursor = `v1:${scope}:${await fingerprint(summary)}`;
    return {
      changed: input.cursor !== cursor,
      cursor,
      snapshot: input.cursor === cursor ? null : summary,
      observedAt: status.observedAt,
      coverage: 'coalesced_current_snapshot_not_event_history',
    };
  },
});
export const samChatJobs = defineOperation({
  name: 'sam_chat_jobs_list',
  title: 'Read typed job observations',
  kind: 'read',
  description:
    'Read bounded persisted secret-execution job observations captured by internal start/status/cancel responses. No runtime calls, output or commands. Running observations can be stale; missing jobs/terminal outcomes are unknown. Native harness job history is unsupported. Child SAM tasks use sam_task_get; cleanup uses sam_chat_status.',
  input: v.object({
    ...session,
    jobId: v.optional(v.pipe(v.string(), v.regex(/^sx-[a-f0-9]{64}$/))),
    limit: v.optional(v.pipe(v.number(), v.minValue(1), v.integer())),
  }),
  async run(ctx, input) {
    const writer = await operationalSession(ctx, input.projectId, input.sessionId);
    const limit = clampOperationNumber(
      input.limit ?? getPlatformOperationLimits(ctx.env).messageListMax,
      1,
      getPlatformOperationLimits(ctx.env).messageListMax,
      'limit'
    );
    const result = await ctx.env.DATABASE.prepare(
      `SELECT job_id,workspace_id,agent_session_id,status,exit_code,observed_at
      FROM operational_job_observations WHERE project_id=? AND chat_session_id=? AND owner_user_id=?
      ${input.jobId ? 'AND job_id=?' : ''} ORDER BY observed_at DESC,job_id LIMIT ?`
    )
      .bind(
        input.projectId,
        input.sessionId,
        writer.ownerUserId,
        ...(input.jobId ? [input.jobId] : []),
        limit + 1
      )
      .all<{
        job_id: string;
        workspace_id: string;
        agent_session_id: string;
        status: string;
        exit_code: number | null;
        observed_at: number;
      }>();
    return {
      jobs: result.results.slice(0, limit).map((row) => ({
        source: 'secret_exec',
        jobId: row.job_id,
        workspaceId: row.workspace_id,
        agentSessionId: row.agent_session_id,
        status: row.status,
        exitCode: row.exit_code,
        observedAt: row.observed_at,
        evidence:
          row.status === 'running'
            ? 'last_observed_not_live_verified'
            : 'recorded_terminal_response',
      })),
      hasMore: result.results.length > limit,
      missingResult: 'unknown',
      harnessHistory: 'unsupported',
      coverage: 'observed_internal_responses_only_no_automatic_completion_tracking',
    };
  },
});
export const samOperationGet = defineOperation({
  name: 'sam_operation_get',
  title: 'Inspect uncertain keyed write',
  kind: 'read',
  description:
    'Inspect your own Connector write receipt by operation and requestKey without executing/replaying it. Pending is uncertain; completed means the handler result was saved, not that delivery or cleanup finished. No receipt can mean absent or unavailable historical coverage. Never automatically submit a new key to recover uncertainty.',
  input: v.object({ projectId: id, operation: id, requestKey }),
  run: readOperation,
});
export const operationalOperations = [
  samChatInterrupt,
  samChatStatus,
  samChatDeliveryGet,
  samChatInteractions,
  samWorkChanges,
  samChatJobs,
  samOperationGet,
] as const;
