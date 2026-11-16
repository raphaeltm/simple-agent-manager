/**
 * Inbox writes: file an `asks` row (internal; no agent tool yet), answer and archive any item.
 *
 * `asks` rows are written here with compare-and-set on the previous status and `project_id` in
 * every predicate (rule 11). Every other store is answered and archived through the path it
 * already answers through (`OperationInboxPort`, `ports.chat`, `ports.connector`): there is no
 * second answer path for any of them.
 */
import {
  ASK_ASSIGNEE_KINDS,
  ASK_KINDS,
  type InboxActionResponse,
  type InboxItem,
  type ParsedInboxRef,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { INBOX_NOT_FOUND, resolveInboxItem } from './inbox-item-core';
import { AskAnswerSpecSchema, InboxLinksSchema } from './inbox-rows';
import { getInboxLimits } from './inbox-settings';
import type { InboxAskNoticeOutcome, InboxAskNoticeRow } from './ports';
import type { OperationContext } from './types';

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const CreateAskInputSchema = v.object({
  projectId: id,
  assigneeKind: v.optional(v.picklist(ASK_ASSIGNEE_KINDS), 'user'),
  assigneeUserId: v.optional(id),
  kind: v.picklist(ASK_KINDS),
  blocking: v.optional(v.boolean(), false),
  title: v.pipe(v.string(), v.trim(), v.minLength(1)),
  body: v.optional(v.string()),
  answerSpec: v.optional(AskAnswerSpecSchema),
  steps: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), []),
  links: v.optional(InboxLinksSchema, []),
  dueHint: v.optional(v.pipe(v.string(), v.maxLength(200))),
  dueAt: v.optional(v.pipe(v.number(), v.safeInteger())),
  expiresAt: v.optional(v.pipe(v.number(), v.safeInteger())),
  sourceSessionId: v.optional(id),
  sourceTaskId: v.optional(id),
  sourceMessageId: v.optional(id),
  agentProfileId: v.optional(id),
  groupKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  dedupeKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
});
export type CreateAskInput = v.InferInput<typeof CreateAskInputSchema>;

/**
 * File one ask. Internal: later slices call it (agent tools, system errors); no surface exposes
 * it yet. The assignee must be an active member, a source task must belong to the project, and
 * a chat may hold at most `inbox.openItemsPerChat` open items. A repeated `dedupeKey` returns the
 * existing row instead of filing a second one.
 */
export async function createAsk(
  ctx: OperationContext,
  rawInput: CreateAskInput
): Promise<{ ref: string; id: string; created: boolean }> {
  const input = v.parse(CreateAskInputSchema, rawInput);
  const limits = await getInboxLimits(ctx);
  if (input.title.length > limits.titleMaxChars)
    throw new OperationError('invalid_input', `title exceeds ${limits.titleMaxChars} characters`);
  if (input.body && input.body.length > limits.bodyMaxChars)
    throw new OperationError('invalid_input', `body exceeds ${limits.bodyMaxChars} characters`);
  if (input.links.length > limits.linksMax)
    throw new OperationError('invalid_input', `at most ${limits.linksMax} links`);
  if (input.assigneeKind === 'user' && !input.assigneeUserId)
    throw new OperationError('invalid_input', 'assigneeUserId is required for a user assignee');
  if (input.assigneeKind === 'team' && input.assigneeUserId)
    throw new OperationError('invalid_input', 'A team item has no assigneeUserId');
  if (input.sourceSessionId && !input.sourceTaskId)
    throw new OperationError('invalid_input', 'sourceTaskId is required with sourceSessionId');

  const db = ctx.env.DATABASE;
  if (input.assigneeUserId) {
    const member = await db
      .prepare(
        `SELECT 1 AS ok FROM project_members
          WHERE project_id = ? AND user_id = ? AND status = 'active'`
      )
      .bind(input.projectId, input.assigneeUserId)
      .first();
    if (!member)
      throw new OperationError('invalid_input', 'The assignee is not an active project member');
  }
  if (input.sourceTaskId) {
    const task = await db
      .prepare('SELECT chat_session_id FROM tasks WHERE id = ? AND project_id = ?')
      .bind(input.sourceTaskId, input.projectId)
      .first<{ chat_session_id: string | null }>();
    if (!task)
      throw new OperationError('invalid_input', 'sourceTaskId is not a task of this project');
  }

  const now = Date.now();
  const askId = ulid();
  // One statement: the per-chat cap and the insert cannot interleave with another filing.
  const inserted = await db
    .prepare(
      `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
          body_md, answer_spec_json, steps_json, links_json, due_hint, due_at, source_session_id,
          source_task_id, source_message_id, agent_profile_id, group_key, dedupe_key, status,
          expires_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?
        WHERE ? IS NULL
           OR (SELECT COUNT(*) FROM asks WHERE source_session_id = ? AND project_id = ? AND status = 'open') < ?
       ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
    )
    .bind(
      askId,
      input.projectId,
      input.assigneeKind,
      input.assigneeUserId ?? null,
      input.kind,
      input.blocking ? 1 : 0,
      input.title,
      input.body ?? null,
      input.answerSpec ? JSON.stringify(input.answerSpec) : null,
      input.steps.length ? JSON.stringify(input.steps) : null,
      input.links.length ? JSON.stringify(input.links) : null,
      input.dueHint ?? null,
      input.dueAt ?? null,
      input.sourceSessionId ?? null,
      input.sourceTaskId ?? null,
      input.sourceMessageId ?? null,
      input.agentProfileId ?? null,
      input.groupKey ?? null,
      input.dedupeKey ?? null,
      input.expiresAt ?? null,
      now,
      now,
      input.sourceSessionId ?? null,
      input.sourceSessionId ?? null,
      input.projectId,
      limits.openItemsPerChat
    )
    .run();
  if ((inserted.meta?.changes ?? 0) === 1) return { ref: `ask:${askId}`, id: askId, created: true };
  if (input.dedupeKey) {
    const existing = await db
      .prepare('SELECT id FROM asks WHERE project_id = ? AND dedupe_key = ?')
      .bind(input.projectId, input.dedupeKey)
      .first<{ id: string }>();
    if (existing) return { ref: `ask:${existing.id}`, id: existing.id, created: false };
  }
  throw new OperationError(
    'rate_limited',
    `This chat already has ${limits.openItemsPerChat} open inbox items`
  );
}

export interface InboxAnswerInput {
  projectId: string;
  ref: string;
  answer?: string;
  optionId?: string;
  decline?: true;
  formContent?: Record<string, unknown>;
  decision?: 'approve' | 'deny';
  note?: string;
  /** Browser (web actor) only; never logged or returned. */
  secret?: { value: string; replaceExisting?: boolean; expectedExistingVersion?: string };
}

async function requireActable(
  ctx: OperationContext,
  input: { projectId: string; ref: string }
): Promise<{ item: InboxItem; ref: ParsedInboxRef }> {
  await authorizeProjectOperation(ctx, input.projectId, 'task:write');
  const resolved = await resolveInboxItem(ctx, input);
  if (resolved.item.status !== 'open')
    throw new OperationError('conflict', `This inbox item is already ${resolved.item.status}`);
  if (!resolved.item.canAct) throw new OperationError('forbidden', 'You cannot act on this item');
  return resolved;
}

async function loadNoticeRow(
  ctx: OperationContext,
  projectId: string,
  askId: string
): Promise<InboxAskNoticeRow | null> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT id, project_id, kind, title, status, answer_json, source_session_id, source_task_id,
            resolved_by_user_id, assignee_user_id
       FROM asks WHERE id = ? AND project_id = ?`
  )
    .bind(askId, projectId)
    .first<Record<string, string | null>>();
  if (!row?.id || !row.project_id || !row.kind || !row.title || !row.status) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    answerJson: row.answer_json ?? null,
    sourceSessionId: row.source_session_id ?? null,
    sourceTaskId: row.source_task_id ?? null,
    resolvedByUserId: row.resolved_by_user_id ?? null,
    assigneeUserId: row.assignee_user_id ?? null,
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

/** Compare-and-set an open ask to a closed status. Returns false when someone else won. */
async function closeAsk(
  ctx: OperationContext,
  projectId: string,
  askId: string,
  status: 'answered' | 'done' | 'archived',
  answerJson: string | null
): Promise<boolean> {
  const now = Date.now();
  const me = ctx.actor.userId;
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks
        SET status = ?, answer_json = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'open'
        AND (expires_at IS NULL OR expires_at > ?)
        AND ((assignee_kind = 'user' AND assignee_user_id = ?)
          OR (assignee_kind = 'team' AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?)))`
  )
    .bind(status, answerJson, me, now, now, askId, projectId, now, me, me)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

async function answerAsk(
  ctx: OperationContext,
  item: InboxItem,
  askId: string,
  input: InboxAnswerInput
): Promise<InboxActionResponse> {
  const limits = await getInboxLimits(ctx);
  const answer = input.answer?.trim();
  if (answer && answer.length > limits.answerMaxChars)
    throw new OperationError('invalid_input', `answer exceeds ${limits.answerMaxChars} characters`);
  const spec = item.answerSpec;
  if (spec.type === 'options' && !(answer && (spec.options.includes(answer) || spec.allowText)))
    throw new OperationError('invalid_input', 'answer must match one of the requested options');
  if (spec.type === 'text' && !answer)
    throw new OperationError('invalid_input', 'answer is required');
  // An answer reaches the agent as a prompt, so the agent-wake policy decides first.
  if (item.sessionId)
    await ctx.ports.inbox.authorizeAnswerWake(item.projectId, item.sessionId, ctx.actor.userId);
  const status = item.kind === 'task' ? 'done' : 'answered';
  const answerJson = answer ? JSON.stringify({ text: answer }) : null;
  if (!(await closeAsk(ctx, item.projectId, askId, status, answerJson)))
    throw new OperationError('conflict', 'This inbox item was already answered or closed');
  const row = await loadNoticeRow(ctx, item.projectId, askId);
  const agentNotified = row ? await notifyClosedAsk(ctx, row, status) : false;
  return { ref: item.ref, outcome: status, agentNotified };
}

/** Answer one item through the path its store answers through today. */
export async function answerInboxItem(
  ctx: OperationContext,
  input: InboxAnswerInput
): Promise<InboxActionResponse> {
  const { item, ref } = await requireActable(ctx, input);
  const me = ctx.actor.userId;
  switch (ref.store) {
    case 'ask':
      return answerAsk(ctx, item, ref.id, input);
    case 'attention': {
      if (item.answerSpec.type === 'interaction') {
        const interactionId = item.answerSpec.interactionId;
        if (!interactionId) throw new OperationError('conflict', 'Answer this request in its chat');
        await ctx.ports.access.requireSessionWriter(item.projectId, ref.sessionId, me, {
          action: 'answer the agent in this session',
        });
        const prepared = await ctx.ports.connector.prepareAgentAnswer(
          item.projectId,
          ref.sessionId,
          interactionId,
          { optionId: input.optionId, decline: input.decline, formContent: input.formContent }
        );
        await ctx.ports.chat.answerAgentInteraction(
          me,
          item.projectId,
          ref.sessionId,
          interactionId,
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

/** Archive means closed: the agent is told the person will not act (spec section 3.3). */
export async function archiveInboxItem(
  ctx: OperationContext,
  input: { projectId: string; ref: string }
): Promise<InboxActionResponse> {
  const { item, ref } = await requireActable(ctx, input);
  const me = ctx.actor.userId;
  switch (ref.store) {
    case 'ask': {
      if (!(await closeAsk(ctx, item.projectId, ref.id, 'archived', null)))
        throw new OperationError('conflict', 'This inbox item was already answered or closed');
      const row = await loadNoticeRow(ctx, item.projectId, ref.id);
      const agentNotified = row ? await notifyClosedAsk(ctx, row, 'archived') : false;
      return { ref: item.ref, outcome: 'archived', agentNotified };
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
        ref.markerId
      );
      return { ref: item.ref, outcome: 'archived', agentNotified: result.agentNotified };
    }
    case 'secret': {
      const result = await ctx.ports.inbox.declineSecret(me, item.projectId, ref.id);
      return { ref: item.ref, outcome: 'declined', agentNotified: result.agentNotified };
    }
    case 'approval': {
      const result = await ctx.ports.inbox.decideApproval(me, ref.id, 'deny', null);
      return { ref: item.ref, outcome: result.outcome, agentNotified: result.agentNotified };
    }
  }
}

export { INBOX_NOT_FOUND };
