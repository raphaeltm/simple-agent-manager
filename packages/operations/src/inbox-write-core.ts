/**
 * Inbox writes: answer and archive any item (filing an ask is `inbox-ask-create-core.ts`).
 *
 * `asks` rows are written here with compare-and-set on the previous status and `project_id` in
 * every predicate (rule 11). Every other store is answered and archived through the path it
 * already answers through (`OperationInboxPort`, `ports.chat`, `ports.connector`): there is no
 * second answer path for any of them.
 */
import {
  type AcpInteractionBrowserAnswer,
  type InboxActionResponse,
  type InboxErrorAction,
  type InboxItem,
  type ParsedInboxRef,
} from '@simple-agent-manager/shared';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { answerErrorItem, archiveErrorItem } from './inbox-error-core';
import { INBOX_NOT_FOUND, resolveInboxItem } from './inbox-item-core';
import { TERMINAL_TASK_STATUSES } from './inbox-rows';
import { getInboxLimits } from './inbox-settings';
import { archiveTask, completeTask } from './inbox-task-core';
import type { ArchiveCheckinHold, InboxAskNoticeOutcome, InboxAskNoticeRow } from './ports';
import type { OperationContext } from './types';

export interface InboxAnswerInput {
  projectId: string;
  ref: string;
  answer?: string;
  optionId?: string;
  decline?: true;
  formContent?: Record<string, unknown>;
  decision?: 'approve' | 'deny';
  note?: string;
  /** A system error item's fix (`retry`, `wake`, `resume`). */
  action?: InboxErrorAction;
  /** Browser (web actor) only; never logged or returned. */
  secret?: { value: string; replaceExisting?: boolean; expectedExistingVersion?: string };
}

async function requireActable(
  ctx: OperationContext,
  input: { projectId: string; ref: string }
): Promise<{ item: InboxItem; ref: ParsedInboxRef }> {
  await authorizeProjectOperation(ctx, input.projectId, 'task:write');
  const resolved = await resolveInboxItem(ctx, input, true);
  // A human task has its own rule for who may close it (`canWriteTask`); the task operation
  // checks it, so the inbox's assignee-only gate must not refuse the filer first.
  if (resolved.item.kind === 'task' && resolved.ref.store === 'ask') return resolved;
  if (resolved.item.status !== 'open')
    throw new OperationError('conflict', `This inbox item is already ${resolved.item.status}`);
  if (!resolved.item.canAct) throw new OperationError('forbidden', 'You cannot act on this item');
  return resolved;
}

export async function loadAskNoticeRow(
  ctx: Pick<OperationContext, 'env'>,
  projectId: string,
  askId: string
): Promise<InboxAskNoticeRow | null> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT id, project_id, kind, title, status, answer_json, source_session_id, source_task_id,
            source_workspace_id, resolved_by_user_id, assignee_user_id, created_at
       FROM asks WHERE id = ? AND project_id = ?`
  )
    .bind(askId, projectId)
    .first<Record<string, string | number | null>>();
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const id = text(row?.id);
  const rowProjectId = text(row?.project_id);
  const kind = text(row?.kind);
  const title = text(row?.title);
  const status = text(row?.status);
  if (!row || !id || !rowProjectId || !kind || !title || !status) return null;
  return {
    id,
    projectId: rowProjectId,
    kind,
    title,
    status,
    answerJson: text(row.answer_json),
    sourceSessionId: text(row.source_session_id),
    sourceTaskId: text(row.source_task_id),
    sourceWorkspaceId: text(row.source_workspace_id),
    createdAt: typeof row.created_at === 'number' ? row.created_at : null,
    resolvedByUserId: text(row.resolved_by_user_id),
    assigneeUserId: text(row.assignee_user_id),
  };
}

/** Queue the agent's notice for a closed ask and record it; the sweep retries a miss. */
export async function notifyClosedAsk(
  ctx: Pick<OperationContext, 'env' | 'ports'>,
  row: InboxAskNoticeRow,
  outcome: InboxAskNoticeOutcome
): Promise<boolean> {
  const queued = await ctx.ports.inbox.notifyAsk(row, outcome);
  if (!queued) return false;
  try {
    await ctx.env.DATABASE.prepare(
      'UPDATE asks SET notified_at = ? WHERE id = ? AND project_id = ? AND notified_at IS NULL'
    )
      .bind(Date.now(), row.id, row.projectId)
      .run();
  } catch (error) {
    // The notice is queued; a missed marker only means one idempotent retry (same delivery id).
    console.warn(
      JSON.stringify({
        event: 'inbox.ask_notified_mark_failed',
        askId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  return true;
}

/** Not `conflict`: clients read a 409 as "answered elsewhere" and would hide this message. */
function finishedAgentReply(): OperationError {
  return new OperationError(
    'invalid_input',
    'The agent that filed this has finished, so it would not see a reply. Continue in its chat.'
  );
}

/** Whether the task that filed an ask has reached a terminal status. */
async function sourceTaskFinished(
  ctx: OperationContext,
  projectId: string,
  askId: string
): Promise<boolean> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT t.status FROM asks a JOIN tasks t ON t.id = a.source_task_id AND t.project_id = a.project_id
      WHERE a.id = ? AND a.project_id = ?`
  )
    .bind(askId, projectId)
    .first<{ status: string }>();
  return Boolean(row && (TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status));
}

/** Compare-and-set an open ask to a closed status. Returns false when someone else won. */
async function closeAsk(
  ctx: OperationContext,
  projectId: string,
  askId: string,
  status: 'answered' | 'done' | 'archived',
  answerJson: string | null,
  options: {
    /** No agent notice will be sent, so record it as settled in the same write. */
    silent?: boolean;
    /** Close only while the filing task is live, so a reply cannot land after it finished. */
    requireLiveTask?: boolean;
  } = {}
): Promise<boolean> {
  const now = Date.now();
  const me = ctx.actor.userId;
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks
        SET status = ?, answer_json = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = ?,
            notified_at = CASE WHEN ? THEN ? ELSE notified_at END
      WHERE id = ? AND project_id = ? AND status = 'open'
        AND (expires_at IS NULL OR expires_at > ?)
        AND ((assignee_kind = 'user' AND assignee_user_id = ?)
          OR (assignee_kind = 'team' AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)))
        AND (? = 0 OR source_task_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM tasks t WHERE t.id = asks.source_task_id AND t.project_id = asks.project_id
            AND t.status IN (${TERMINAL_TASK_STATUSES.map((value) => `'${value}'`).join(', ')})))`
  )
    .bind(
      status,
      answerJson,
      me,
      now,
      now,
      options.silent ? 1 : 0,
      now,
      askId,
      projectId,
      now,
      me,
      me,
      options.requireLiveTask ? 1 : 0
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

async function answerAsk(
  ctx: OperationContext,
  item: InboxItem,
  askId: string,
  input: InboxAnswerInput
): Promise<InboxActionResponse> {
  // Length was checked against `inbox.answerMaxChars` by `answerInboxItem`.
  const answer = input.answer?.trim();
  if (item.kind === 'task') {
    // A human task closes through its own path: the `sam.inbox` event is the agent's notice.
    const result = await completeTask(ctx, {
      projectId: item.projectId,
      askId,
      note: answer || undefined,
    });
    return { ref: item.ref, outcome: result.status, agentNotified: result.agentNotified };
  }
  if (item.kind === 'question' && item.sessionId) {
    // A question is answered through the one path a chat card, a notification and the Connector
    // also use (`answerAttention`, `apps/api/src/routes/chat-attention.ts`), so concurrent answers
    // from any of them meet at the same compare-and-set and get the same outcomes.
    if (!answer) throw new OperationError('invalid_input', 'answer is required');
    const result = await ctx.ports.chat.answerAttention(
      ctx.actor.userId,
      item.projectId,
      item.sessionId,
      askId,
      answer
    );
    return {
      ref: item.ref,
      outcome: result.inFlight ? 'in_flight' : 'answered',
      agentNotified: !result.inFlight,
    };
  }
  const spec = item.answerSpec;
  if (spec.type === 'options' && !(answer && (spec.options.includes(answer) || spec.allowText)))
    throw new OperationError('invalid_input', 'answer must match one of the requested options');
  if (spec.type === 'text' && !answer)
    throw new OperationError('invalid_input', 'answer is required');
  const status = 'answered';
  // A reply reaches the agent only while its task is live (`sourceTaskGuardForClaim`,
  // `inbox_ask`); after that it would be stored and silently never delivered. Checked here for
  // the message, and again in the closing write in case the task finishes in between.
  const replyNeedsLiveTask = (item.kind === 'result' || item.kind === 'review') && Boolean(answer);
  if (replyNeedsLiveTask && item.agentState === 'finished') throw finishedAgentReply();
  if (item.kind === 'result' && !answer) {
    // "Got it": the person read the result and needs nothing more, so the agent is not woken.
    // `notified_at` is set in the closing write, so the ask-notice sweep never sends one later.
    if (!(await closeAsk(ctx, item.projectId, askId, status, null, { silent: true })))
      throw new OperationError('conflict', 'This inbox item was already answered or closed');
    return { ref: item.ref, outcome: status, agentNotified: false };
  }
  // An answer reaches the agent as a prompt, so the agent-wake policy decides first.
  if (item.sessionId)
    await ctx.ports.inbox.authorizeAnswerWake(item.projectId, item.sessionId, ctx.actor.userId);
  const answerJson = answer ? JSON.stringify({ text: answer }) : null;
  const closed = await closeAsk(ctx, item.projectId, askId, status, answerJson, {
    requireLiveTask: replyNeedsLiveTask,
  });
  if (!closed) {
    if (replyNeedsLiveTask && (await sourceTaskFinished(ctx, item.projectId, askId)))
      throw finishedAgentReply();
    throw new OperationError('conflict', 'This inbox item was already answered or closed');
  }
  const row = await loadAskNoticeRow(ctx, item.projectId, askId);
  const agentNotified = row ? await notifyClosedAsk(ctx, row, status) : false;
  return { ref: item.ref, outcome: status, agentNotified };
}

/**
 * An Operations approval exists so an agent cannot obtain one from text it wrote; an app reading
 * that text (the Connector) must not decide it either. Decisions come from the SAM app only, like
 * the admin approvals route.
 */
function requireWebApprovalDecision(ctx: OperationContext): void {
  if (ctx.actor.via !== 'web')
    throw new OperationError('forbidden', 'Decide Operations approvals in the SAM app');
}

/**
 * Validation the Connector runs before it reserves a write receipt (`executeWrite` preflight), so
 * a rejected interaction answer cannot leave a `requestKey` stuck: resolves the item and prepares
 * an interaction answer. Returns the prepared answer for `answerInboxItem`, or undefined.
 */
export async function prepareInboxAnswer(
  ctx: OperationContext,
  input: InboxAnswerInput
): Promise<AcpInteractionBrowserAnswer | undefined> {
  await checkAnswerLengths(ctx, input);
  const { item, ref } = await requireActable(ctx, input);
  if (ref.store === 'approval') requireWebApprovalDecision(ctx);
  if (ref.store !== 'attention' || item.answerSpec.type !== 'interaction') return undefined;
  return prepareInteraction(ctx, item, ref.sessionId, input);
}

/** The Connector preflight for an archive: refusals happen before a receipt is reserved. */
export async function prepareInboxArchive(
  ctx: OperationContext,
  input: { projectId: string; ref: string }
): Promise<void> {
  const { ref } = await requireActable(ctx, input);
  if (ref.store === 'approval') requireWebApprovalDecision(ctx);
}

async function checkAnswerLengths(
  ctx: OperationContext,
  input: Pick<InboxAnswerInput, 'answer' | 'note'>
): Promise<void> {
  const { answerMaxChars } = await getInboxLimits(ctx);
  for (const [field, value] of [
    ['answer', input.answer],
    ['note', input.note],
  ] as const) {
    if (value && value.length > answerMaxChars)
      throw new OperationError('invalid_input', `${field} exceeds ${answerMaxChars} characters`);
  }
}

async function prepareInteraction(
  ctx: OperationContext,
  item: InboxItem,
  sessionId: string,
  input: Pick<InboxAnswerInput, 'optionId' | 'decline' | 'formContent'>
): Promise<AcpInteractionBrowserAnswer> {
  if (item.answerSpec.type !== 'interaction' || !item.answerSpec.interactionId)
    throw new OperationError('conflict', 'Answer this request in its chat');
  await ctx.ports.access.requireSessionWriter(item.projectId, sessionId, ctx.actor.userId, {
    action: 'answer the agent in this session',
  });
  return ctx.ports.connector.prepareAgentAnswer(
    item.projectId,
    sessionId,
    item.answerSpec.interactionId,
    { optionId: input.optionId, decline: input.decline, formContent: input.formContent }
  );
}

/** Answer one item through the path its store answers through today. */
export async function answerInboxItem(
  ctx: OperationContext,
  input: InboxAnswerInput,
  /** An interaction answer prepared by `prepareInboxAnswer` (the Connector preflight). */
  preparedInteraction?: AcpInteractionBrowserAnswer
): Promise<InboxActionResponse> {
  await checkAnswerLengths(ctx, input);
  const { item, ref } = await requireActable(ctx, input);
  const me = ctx.actor.userId;
  switch (ref.store) {
    case 'ask':
      // A system error has no filing agent: answering it runs its fix (inbox-error-core.ts).
      if (item.kind === 'error') return answerErrorItem(ctx, item, ref.id, input.action);
      return answerAsk(ctx, item, ref.id, input);
    case 'attention': {
      if (item.answerSpec.type === 'interaction') {
        const prepared =
          preparedInteraction ?? (await prepareInteraction(ctx, item, ref.sessionId, input));
        await ctx.ports.chat.answerAgentInteraction(
          me,
          item.projectId,
          ref.sessionId,
          item.answerSpec.interactionId ?? '',
          prepared
        );
        return {
          ref: item.ref,
          outcome: input.decline ? 'declined' : 'answered',
          agentNotified: true,
        };
      }
      if (!input.answer) throw new OperationError('invalid_input', 'answer is required');
      const result = await ctx.ports.chat.answerAttention(
        me,
        item.projectId,
        ref.sessionId,
        ref.markerId,
        input.answer
      );
      return {
        ref: item.ref,
        outcome: result.inFlight ? 'in_flight' : 'answered',
        agentNotified: true,
      };
    }
    case 'secret': {
      if (input.decline) {
        const result = await ctx.ports.inbox.declineSecret(me, item.projectId, ref.id);
        return { ref: item.ref, outcome: 'declined', agentNotified: result.agentNotified };
      }
      if (!input.secret)
        throw new OperationError('invalid_input', 'A secret value or decline is required');
      // The value may only come from the app's own pages, never through an app or agent.
      if (ctx.actor.via !== 'web')
        throw new OperationError('forbidden', 'Supply secret values in the SAM app');
      const result = await ctx.ports.inbox.fulfilSecret(me, item.projectId, ref.id, {
        value: input.secret.value,
        replaceExisting: input.secret.replaceExisting === true,
        expectedExistingVersion: input.secret.expectedExistingVersion ?? null,
      });
      return { ref: item.ref, outcome: 'fulfilled', agentNotified: result.agentNotified };
    }
    case 'approval': {
      requireWebApprovalDecision(ctx);
      if (!input.decision) throw new OperationError('invalid_input', 'decision is required');
      const result = await ctx.ports.inbox.decideApproval(
        me,
        ref.id,
        input.decision,
        input.note ?? null
      );
      return { ref: item.ref, outcome: result.outcome, agentNotified: result.agentNotified };
    }
  }
}

/**
 * SAM's check-in hold for a question being archived (`inbox.archiveCheckinHoldHours`). Call it
 * before the closing write: `archivedAt` must precede any chat message that ends the hold.
 */
async function archiveCheckinHold(ctx: OperationContext): Promise<ArchiveCheckinHold> {
  const holdHours = (await getInboxLimits(ctx)).archiveCheckinHoldHours;
  const archivedAt = Date.now();
  return { archivedAt, holdCheckinsUntil: archivedAt + holdHours * 3_600_000 };
}

/**
 * Archive means closed. A question or review closes without telling the agent; a permission,
 * approval or secret request is denied or declined through its own answer path.
 */
export async function archiveInboxItem(
  ctx: OperationContext,
  input: { projectId: string; ref: string }
): Promise<InboxActionResponse> {
  const { item, ref } = await requireActable(ctx, input);
  const me = ctx.actor.userId;
  switch (ref.store) {
    case 'ask': {
      if (item.kind === 'task') {
        const result = await archiveTask(ctx, { projectId: item.projectId, askId: ref.id });
        return { ref: item.ref, outcome: result.status, agentNotified: result.agentNotified };
      }
      if (item.kind === 'error') return archiveErrorItem(ctx, item, ref.id);
      // Archive tells no one: the agent is left where it is, and a person who wants it to act
      // answers or writes in the chat (Raphaël, 2026-11-17, revising spec decision 4 of idea
      // 01M7G03ZCQ6TM6CMEYDRKQ8ST9). `notified_at` is set in the closing write, so the
      // ask-notice sweep never sends one later.
      const hold = await archiveCheckinHold(ctx);
      if (!(await closeAsk(ctx, item.projectId, ref.id, 'archived', null, { silent: true })))
        throw new OperationError('conflict', 'This inbox item was already answered or closed');
      if (item.kind === 'question' && item.sessionId)
        await ctx.ports.inbox.questionArchived({
          projectId: item.projectId,
          sessionId: item.sessionId,
          askId: ref.id,
          ...hold,
        });
      return { ref: item.ref, outcome: 'archived', agentNotified: false };
    }
    case 'attention': {
      if (item.answerSpec.type === 'interaction') {
        // A permission is archived by denying it through its own answer path.
        return answerInboxItem(ctx, { projectId: input.projectId, ref: input.ref, decline: true });
      }
      const result = await ctx.ports.inbox.archiveAttention(
        me,
        item.projectId,
        ref.sessionId,
        ref.markerId,
        await archiveCheckinHold(ctx)
      );
      return { ref: item.ref, outcome: 'archived', agentNotified: result.agentNotified };
    }
    case 'secret': {
      const result = await ctx.ports.inbox.declineSecret(me, item.projectId, ref.id);
      return { ref: item.ref, outcome: 'declined', agentNotified: result.agentNotified };
    }
    case 'approval': {
      requireWebApprovalDecision(ctx);
      const result = await ctx.ports.inbox.decideApproval(me, ref.id, 'deny', null);
      return { ref: item.ref, outcome: result.outcome, agentNotified: result.agentNotified };
    }
  }
}

export { INBOX_NOT_FOUND };
