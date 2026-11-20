/**
 * What an agent files in the inbox (slice D, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, spec section 5):
 * an `ask` (one question, one answer shape), a `review` ("please evaluate this") or a `result`
 * ("here is what you asked for"), and edits or cancels its own open item. `inbox_write` and `request_human_input` (an alias of a blocking ask)
 * are thin MCP adapters over these; nothing here knows about MCP.
 *
 * Every write binds `project_id`, and update/cancel also bind the filing chat and the kinds an
 * agent files, so an item of another project, another chat, or one SAM filed (an `error`) reads
 * as not found (rule 11).
 */
import {
  HUMAN_INPUT_CATEGORIES,
  INBOX_AGENT_LINK_KINDS,
  INBOX_AGENT_URL_LINK_KINDS,
  INBOX_ASK_ANSWER_SHAPES,
  INBOX_CONFIRM_OPTIONS,
  type InboxAgentLinkKind,
  type InboxLink,
  type InboxSimilarItem,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { OperationError } from './errors';
import {
  AGENT_ITEM_NOT_FOUND,
  agentAskId,
  type AgentInboxSource,
  findSimilarAsks,
} from './inbox-agent-reads';
import { createAsk } from './inbox-ask-create-core';
import { questionSchedule } from './inbox-question-schedule';
import { inboxReplyWatermark } from './inbox-reply-core';
import { inboxTitle } from './inbox-rows';
import { getInboxLimits, type InboxLimits } from './inbox-settings';
import { recordActivity } from './inbox-task-rows';
import { sanitizeUserInput } from './sanitize-user-input';
import type { OperationContext } from './types';

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

export const AgentLinkInputSchema = v.object({
  kind: v.picklist(INBOX_AGENT_LINK_KINDS),
  id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  url: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
  label: v.optional(text(200)),
});
export type AgentLinkInput = v.InferInput<typeof AgentLinkInputSchema>;

const LinksSchema = v.optional(v.array(AgentLinkInputSchema), []);
const GroupKeySchema = v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200)));
// Stored as `agent:<chatId>:<key>` within the 200-character `dedupe_key`.
const IdempotencyKeySchema = v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120)));

export const AgentAskInputSchema = v.object({
  title: v.optional(v.string()),
  why: v.optional(v.string()),
  options: v.optional(v.pipe(v.array(text(200)), v.maxLength(20))),
  answer: v.optional(v.picklist(INBOX_ASK_ANSWER_SHAPES)),
  blocking: v.optional(v.boolean(), true),
  category: v.optional(v.picklist(HUMAN_INPUT_CATEGORIES)),
  links: LinksSchema,
  groupKey: GroupKeySchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type AgentAskInput = v.InferInput<typeof AgentAskInputSchema>;

export const AgentReviewInputSchema = v.object({
  title: v.string(),
  why: v.optional(v.string()),
  links: LinksSchema,
  groupKey: GroupKeySchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type AgentReviewInput = v.InferInput<typeof AgentReviewInputSchema>;

/** A result takes the same fields as a review: the outcome in `title`, the details in `why`. */
export type AgentResultInput = AgentReviewInput;

/** Kinds an agent files through `file`; a human task is filed by `assignAgentTask`. */
type AgentFiledKind = 'question' | 'review' | 'result';

export interface AgentFileResult {
  ref: string;
  id: string;
  sessionId: string;
  kind: AgentFiledKind;
  blocking: boolean;
  /** False when the idempotency key named an item filed before: nothing new was filed. */
  created: boolean;
  /** Whether the person was notified now (false for a repeated call). */
  notificationScheduled: boolean;
  /** When this call filed it (epoch ms), and when a blocking question expires. */
  filedAt: number;
  expiresAt: number | null;
  similar: InboxSimilarItem[];
}

function clean(value: string | undefined): string {
  return value === undefined ? '' : sanitizeUserInput(value).trim();
}

/** A one-sentence title: one line, within `inbox.titleMaxChars`. */
function checkedTitle(raw: string, limits: InboxLimits): string {
  const title = clean(raw);
  if (!title) throw new OperationError('invalid_input', 'title is required');
  if (/[\r\n]/.test(title))
    throw new OperationError('invalid_input', 'title must be one sentence on one line');
  if (title.length > limits.titleMaxChars)
    throw new OperationError('invalid_input', `title exceeds ${limits.titleMaxChars} characters`);
  return title;
}

const isUrlKind = (kind: InboxAgentLinkKind) => INBOX_AGENT_URL_LINK_KINDS.includes(kind);

/**
 * Links as stored references, each checked as this project's. A URL kind keeps its URL in `id`,
 * which is what the inbox's link chips read (`linkTarget`, `apps/web`).
 */
export async function checkedLinks(
  ctx: OperationContext,
  projectId: string,
  raw: AgentLinkInput[],
  limits: InboxLimits
): Promise<InboxLink[]> {
  if (raw.length > limits.linksMax)
    throw new OperationError('invalid_input', `at most ${limits.linksMax} links`);
  const links = raw.map((link, index): InboxLink => {
    const value = isUrlKind(link.kind) ? (link.url ?? link.id) : link.id;
    if (!value)
      throw new OperationError(
        'invalid_input',
        `links[${index}]: a ${link.kind} link needs ${isUrlKind(link.kind) ? 'url' : 'id'}`
      );
    if (isUrlKind(link.kind) && !/^https:\/\//i.test(value))
      throw new OperationError('invalid_input', `links[${index}]: url must start with https://`);
    const label = clean(link.label);
    return { kind: link.kind, id: value.trim(), label: label || null };
  });
  if (links.length === 0) return links;
  const problems = await ctx.ports.inbox.checkLinkTargets(projectId, links);
  const refused = problems
    .map((problem, index) =>
      problem ? `links[${index}] (${links[index]?.kind}): ${problem}` : null
    )
    .filter((problem): problem is string => problem !== null);
  if (refused.length > 0) throw new OperationError('invalid_input', refused.join('; '));
  return links;
}

/** The ask's one answer shape: options, free text, or Yes/No. */
function askAnswerSpec(input: v.InferOutput<typeof AgentAskInputSchema>) {
  const options = [
    ...new Set((input.options ?? []).map((option) => clean(option)).filter(Boolean)),
  ];
  if (input.options !== undefined && input.answer !== undefined)
    throw new OperationError(
      'invalid_input',
      'Give options or answer, not both: one answer shape per ask'
    );
  if (input.options !== undefined && options.length === 0)
    throw new OperationError('invalid_input', 'options must hold at least one choice');
  if (options.length > 0) return { type: 'options' as const, options, allowText: false };
  if (input.answer === 'confirm')
    return { type: 'options' as const, options: [...INBOX_CONFIRM_OPTIONS], allowText: false };
  return { type: 'text' as const };
}

async function file(
  ctx: OperationContext,
  source: AgentInboxSource,
  limits: InboxLimits,
  item: {
    kind: AgentFiledKind;
    blocking: boolean;
    title: string;
    why: string;
    answerSpec:
      | { type: 'options'; options: string[]; allowText: boolean }
      | { type: 'text' }
      | { type: 'acknowledge' };
    category: string | null;
    links: InboxLink[];
    groupKey?: string;
    idempotencyKey?: string;
  }
): Promise<AgentFileResult> {
  const now = Date.now();
  // A blocking question keeps today's window, reminders and expiry; anything else never expires.
  const schedule = item.kind === 'question' && item.blocking ? questionSchedule(limits, now) : null;
  const created = await createAsk(
    ctx,
    {
      projectId: source.projectId,
      assigneeKind: 'user',
      assigneeUserId: source.userId,
      kind: item.kind,
      blocking: item.blocking,
      title: item.title,
      body: item.why || undefined,
      answerSpec: item.answerSpec,
      links: item.links,
      sourceSessionId: source.sessionId,
      sourceTaskId: source.taskId,
      sourceWorkspaceId: source.workspaceId ?? undefined,
      category: (item.category ?? undefined) as v.InferInput<
        typeof AgentAskInputSchema
      >['category'],
      groupKey: item.groupKey,
      // Scoped to the chat, so two chats cannot collide on one key.
      dedupeKey: item.idempotencyKey
        ? `agent:${source.sessionId}:${item.idempotencyKey}`
        : undefined,
      expiresAt: schedule?.expiresAt,
      nextEscalationAt: schedule?.nextEscalationAt ?? undefined,
      maxExpiresAt: schedule?.maxExpiresAt,
    },
    now
  );
  let notificationScheduled = false;
  if (created.created) {
    ({ notificationScheduled } = await ctx.ports.inbox.announceAsk({
      projectId: source.projectId,
      sessionId: source.sessionId,
      taskId: source.taskId,
      askId: created.id,
      kind: item.kind,
      blocking: item.blocking,
      title: item.title,
      body: item.why || item.title,
      options: item.answerSpec.type === 'options' ? item.answerSpec.options : [],
      category: item.category,
      createdAt: now,
      expiresAt: schedule?.expiresAt ?? null,
      userId: source.userId,
    }));
  }
  const similar = await findSimilarAsks(ctx, limits, {
    projectId: source.projectId,
    sessionId: source.sessionId,
    userId: source.userId,
    title: item.title,
    groupKey: item.groupKey,
    excludeId: created.id,
  });
  return {
    ref: created.ref,
    id: created.id,
    sessionId: source.sessionId,
    kind: item.kind,
    blocking: item.blocking,
    created: created.created,
    notificationScheduled,
    filedAt: now,
    expiresAt: schedule?.expiresAt ?? null,
    similar,
  };
}

/**
 * File one question. The title is the one sentence the person sees in their inbox; when only
 * `why` is given (the `request_human_input` alias) the title is its first sentence.
 */
export async function fileAgentAsk(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: AgentAskInput
): Promise<AgentFileResult> {
  const input = v.parse(AgentAskInputSchema, rawInput);
  const limits = await getInboxLimits(ctx);
  const why = clean(input.why);
  const rawTitle =
    input.title !== undefined ? input.title : why ? inboxTitle(why, limits.titleMaxChars) : '';
  const title = checkedTitle(rawTitle, limits);
  const answerSpec = askAnswerSpec(input);
  const links = await checkedLinks(ctx, source.projectId, input.links, limits);
  return file(ctx, source, limits, {
    kind: 'question',
    blocking: input.blocking,
    title,
    why,
    answerSpec,
    category: input.category ?? null,
    links,
    groupKey: input.groupKey,
    idempotencyKey: input.idempotencyKey,
  });
}

/** An item the person acknowledges ("Looks good" / "Got it") or replies to; never blocking. */
async function fileAcknowledged(
  ctx: OperationContext,
  source: AgentInboxSource,
  kind: 'review' | 'result',
  rawInput: AgentReviewInput
): Promise<AgentFileResult> {
  const input = v.parse(AgentReviewInputSchema, rawInput);
  const limits = await getInboxLimits(ctx);
  const title = checkedTitle(input.title, limits);
  const links = await checkedLinks(ctx, source.projectId, input.links, limits);
  return file(ctx, source, limits, {
    kind,
    blocking: false,
    title,
    why: clean(input.why),
    answerSpec: { type: 'acknowledge' },
    category: null,
    links,
    groupKey: input.groupKey,
    idempotencyKey: input.idempotencyKey,
  });
}

/** File a request to evaluate something: non-blocking, answered "Looks good" or with a reply. */
export function fileAgentReview(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: AgentReviewInput
): Promise<AgentFileResult> {
  return fileAcknowledged(ctx, source, 'review', rawInput);
}

/**
 * File what the person asked for (an answer, a finding, a finished piece of work): non-blocking,
 * never expires. "Got it" closes it without waking the agent; a reply wakes it with the reply.
 */
export function fileAgentResult(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: AgentResultInput
): Promise<AgentFileResult> {
  return fileAcknowledged(ctx, source, 'result', rawInput);
}

/** The kinds an agent files; it may only edit or cancel these (never a SAM `error` item). */
const AGENT_KINDS_SQL = `kind IN ('question', 'review', 'result', 'task')`;

/** Report why an update or cancel matched nothing: missing (or not this chat's) vs. closed. */
async function explainNoMatch(
  ctx: OperationContext,
  source: AgentInboxSource,
  askId: string
): Promise<never> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT status FROM asks
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND ${AGENT_KINDS_SQL}`
  )
    .bind(askId, source.projectId, source.sessionId)
    .first<{ status: string }>();
  if (!row) throw new OperationError('not_found', AGENT_ITEM_NOT_FOUND);
  throw new OperationError('conflict', `This inbox item is already ${row.status}`);
}

export const AgentUpdateInputSchema = v.object({
  ref: v.string(),
  title: v.optional(v.string()),
  why: v.optional(v.string()),
  links: v.optional(v.array(AgentLinkInputSchema)),
});

/** Edit the wording or links of an open item this chat filed. */
export async function updateAgentAsk(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: v.InferInput<typeof AgentUpdateInputSchema>
): Promise<{ ref: string; status: 'open' }> {
  const input = v.parse(AgentUpdateInputSchema, rawInput);
  const askId = agentAskId(input.ref);
  if (input.title === undefined && input.why === undefined && input.links === undefined)
    throw new OperationError('invalid_input', 'Give title, why or links to change');
  const limits = await getInboxLimits(ctx);
  const title = input.title === undefined ? null : checkedTitle(input.title, limits);
  const why = input.why === undefined ? undefined : clean(input.why);
  if (why && why.length > limits.bodyMaxChars)
    throw new OperationError('invalid_input', `why exceeds ${limits.bodyMaxChars} characters`);
  const links =
    input.links === undefined
      ? undefined
      : await checkedLinks(ctx, source.projectId, input.links, limits);
  const watermark = await inboxReplyWatermark(ctx, source.projectId, input.ref);
  const actedAt = Date.now();
  const update = ctx.env.DATABASE.prepare(
    `UPDATE asks
        SET title = COALESCE(?, title),
            body_md = CASE WHEN ? THEN ? ELSE body_md END,
            links_json = CASE WHEN ? THEN ? ELSE links_json END,
            updated_at = ?
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND ${AGENT_KINDS_SQL}
        AND status = 'open'`
  ).bind(
    title,
    why === undefined ? 0 : 1,
    why || null,
    links === undefined ? 0 : 1,
    links && links.length > 0 ? JSON.stringify(links) : null,
    actedAt,
    askId,
    source.projectId,
    source.sessionId
  );
  // Wording and resurfacing are one mutation: a failed acknowledgement must not leave
  // changed wording hidden in Archived. A newer reply remains outside this watermark.
  const results = await ctx.env.DATABASE.batch([
    update,
    ctx.env.DATABASE.prepare(
      `UPDATE inbox_replies SET agent_acted_at = ?
       WHERE project_id = ? AND item_ref = ? AND id <= ?
         AND EXISTS (SELECT 1 FROM asks WHERE id = ? AND project_id = ?
           AND source_session_id = ? AND ${AGENT_KINDS_SQL} AND status = 'open')`
    ).bind(
      actedAt,
      source.projectId,
      input.ref,
      watermark,
      askId,
      source.projectId,
      source.sessionId
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) await explainNoMatch(ctx, source, askId);
  return { ref: input.ref, status: 'open' };
}

export const AgentCancelInputSchema = v.object({
  ref: v.string(),
  reason: v.pipe(v.string(), v.maxLength(500)),
});

/**
 * Close an open item this chat filed because it became moot. The reason is recorded on the item;
 * no notice is queued (the agent did it), and a blocking question stops pausing the chat.
 */
export async function cancelAgentAsk(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: v.InferInput<typeof AgentCancelInputSchema>
): Promise<{ ref: string; status: 'cancelled' }> {
  const input = v.parse(AgentCancelInputSchema, rawInput);
  const askId = agentAskId(input.ref);
  const reason = clean(input.reason);
  if (!reason) throw new OperationError('invalid_input', 'reason is required');
  const now = Date.now();
  const closed = await ctx.env.DATABASE.prepare(
    `UPDATE asks
        SET status = 'cancelled', answer_json = ?, resolved_at = ?, updated_at = ?, notified_at = ?
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND ${AGENT_KINDS_SQL}
        AND status = 'open'
      RETURNING kind, blocking`
  )
    .bind(
      JSON.stringify({ cancelReason: reason }),
      now,
      now,
      now,
      askId,
      source.projectId,
      source.sessionId
    )
    .first<{ kind: string; blocking: number }>();
  if (!closed) return explainNoMatch(ctx, source, askId);
  if (closed.kind === 'task') {
    // A moot human task leaves the person's list; its history says why, and its watches wind
    // down like a closed task's.
    await ctx.ports.inboxTasks.closeWatches(
      source.projectId,
      askId,
      (await getInboxLimits(ctx)).closedTaskWatchHours
    );
    await recordActivity(ctx, {
      projectId: source.projectId,
      askId,
      kind: 'cancelled',
      actorKind: 'agent',
      actorId: source.sessionId,
      at: now,
    });
  }
  if (closed.kind === 'question' && closed.blocking === 1) {
    await ctx.ports.inbox.withdrawQuestion({
      projectId: source.projectId,
      sessionId: source.sessionId,
      askId,
    });
  }
  return { ref: input.ref, status: 'cancelled' };
}
