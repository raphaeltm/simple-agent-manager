/**
 * File one inbox ask (`asks` row): the internal create operation agent tools and SAM call
 * (`request_human_input` since slice G). Split out of `inbox-write-core.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import {
  ASK_ASSIGNEE_KINDS,
  ASK_KINDS,
  HUMAN_INPUT_CATEGORIES,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OperationError } from './errors';
import { AskAnswerSpecSchema, InboxLinksSchema } from './inbox-rows';
import { getInboxLimits } from './inbox-settings';
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
  steps: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(50)),
    []
  ),
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
  // Questions (`request_human_input`, slice G): reminders and the expiry outcome.
  sourceWorkspaceId: v.optional(id),
  category: v.optional(v.picklist(HUMAN_INPUT_CATEGORIES)),
  nextEscalationAt: v.optional(v.pipe(v.number(), v.safeInteger())),
  maxExpiresAt: v.optional(v.pipe(v.number(), v.safeInteger())),
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
  rawInput: CreateAskInput,
  /** Filing time; a caller that computed a schedule from it passes the same instant. */
  now: number = Date.now()
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
    // The chat must be the task's own (a task that handed its chat to a recovery successor has none).
    if (
      input.sourceSessionId &&
      task.chat_session_id &&
      task.chat_session_id !== input.sourceSessionId
    )
      throw new OperationError('invalid_input', 'sourceSessionId is not the chat of sourceTaskId');
  }

  const askId = ulid();
  // One statement: the per-chat cap and the insert cannot interleave with another filing.
  const inserted = await db
    .prepare(
      `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, blocking, title,
          body_md, answer_spec_json, steps_json, links_json, due_hint, due_at, source_session_id,
          source_task_id, source_message_id, agent_profile_id, group_key, dedupe_key, status,
          expires_at, source_workspace_id, category, next_escalation_at, max_expires_at,
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?
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
      input.sourceWorkspaceId ?? null,
      input.category ?? null,
      input.nextEscalationAt ?? null,
      input.maxExpiresAt ?? null,
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
