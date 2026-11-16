/**
 * Agent questions held in D1 `asks` (inbox slice G, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9): filing one
 * for `request_human_input`, answering one, and reading one for the chat card. The row is the
 * record of truth for the question, its status and its answer; nothing else holds a copy.
 *
 * Answering is one compare-and-set on the row's status (`open` → `answered`), bound to the
 * project and the chat (rule 11), then the answer goes to the agent as a durable prompt
 * (`deliverInboxAskNotice`, the wake path for a sleeping chat) and `notified_at` is recorded. A
 * delivery that was not queued keeps `notified_at` NULL and the inbox sweep retries it.
 */
import {
  createAsk,
  getInboxLimits,
  inboxTitle,
  loadAskNoticeRow,
  notifyClosedAsk,
  questionSchedule,
} from '@simple-agent-manager/operations';
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import { HUMAN_INPUT_CATEGORIES } from '@simple-agent-manager/shared';
import { maybeJsonRecord, questionOptions } from '@simple-agent-manager/worker-core';

import type { Env } from '../../env';
import { agentWakeRecord } from '../../lib/agent-wake-policy';
import { log } from '../../lib/logger';
import { markRejectedBeforeEffects } from '../../lib/operation-effect-boundary';
import { errors } from '../../middleware/error';
import { createOperationPorts } from '../../operation-ports';
import type { authorizeAgentWake } from '../agent-wake-authorization';
import * as projectDataService from '../project-data';
import { recordSharedSessionAnswer } from '../session-access';

export interface QuestionAsk {
  id: string;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  title: string;
  reason: string | null;
  options: string[];
  category: HumanInputCategory | null;
  status: string;
  answer: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  notifiedAt: number | null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** The typed answer recorded on the row (`{text}`), or null (archived, expired, chat message). */
export function askAnswerText(answerJson: unknown): string | null {
  if (typeof answerJson !== 'string' || !answerJson) return null;
  try {
    return text(maybeJsonRecord(JSON.parse(answerJson) as unknown)?.text);
  } catch {
    return null;
  }
}

function parseQuestionAsk(row: Record<string, unknown>): QuestionAsk | null {
  const id = text(row.id);
  const projectId = text(row.project_id);
  const sessionId = text(row.source_session_id);
  const status = text(row.status);
  const createdAt = int(row.created_at);
  if (!id || !projectId || !sessionId || !status || createdAt === null) return null;
  const category = text(row.category);
  return {
    id,
    projectId,
    sessionId,
    taskId: text(row.source_task_id),
    title: text(row.title) ?? '',
    reason: text(row.body_md) ?? text(row.title),
    options: questionOptions(row.answer_spec_json),
    category: (HUMAN_INPUT_CATEGORIES as readonly unknown[]).includes(category)
      ? (category as HumanInputCategory)
      : null,
    status,
    answer: askAnswerText(row.answer_json),
    createdAt,
    expiresAt: int(row.expires_at),
    resolvedAt: int(row.resolved_at),
    notifiedAt: int(row.notified_at),
  };
}

/**
 * One question of one chat, or null. Project, chat and kind are all in the predicate, so an id
 * from another project or chat reads as missing (rule 11).
 */
export async function loadQuestionAsk(
  env: Env,
  projectId: string,
  sessionId: string,
  askId: string
): Promise<QuestionAsk | null> {
  const row = await env.DATABASE.prepare(
    `SELECT id, project_id, source_session_id, source_task_id, title, body_md, answer_spec_json,
            category, status, answer_json, created_at, expires_at, resolved_at, notified_at
       FROM asks
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND kind = 'question'`
  )
    .bind(askId, projectId, sessionId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const ask = parseQuestionAsk(row);
  if (!ask) {
    // A malformed row is a clean not-found, never an opaque 500 (rule 50).
    log.warn('question_ask.row_unreadable', { askId, projectId });
  }
  return ask;
}

export type QuestionAnswerResult =
  | { resolved: true; alreadyResolved: boolean; answer: string }
  | { resolved: false; alreadyResolved: false; inFlight: true; answer: string };

/** A question that is no longer open, answered the way an attention marker answered. */
function settledOutcome(ask: QuestionAsk, answer: string): QuestionAnswerResult {
  if (ask.status === 'answered' && ask.answer === answer) {
    return ask.notifiedAt === null
      ? { resolved: false, alreadyResolved: false, inFlight: true, answer }
      : { resolved: true, alreadyResolved: true, answer };
  }
  if (ask.status === 'answered' && ask.answer !== null && ask.notifiedAt === null) {
    throw markRejectedBeforeEffects(
      errors.conflict('A different answer is already being delivered')
    );
  }
  throw markRejectedBeforeEffects(errors.conflict('Attention request is already resolved'));
}

/**
 * Answer an open question. The caller has authorized the answer (`authorizeAgentWake`: a writer
 * of the chat whose wake policy allows it). Outcomes, as for a question marker:
 * accepted; already answered (same answer); a different answer already being delivered or the
 * question already resolved (409); an answer outside the options (400); still being delivered
 * (202 `inFlight`).
 */
export async function answerQuestionAsk(
  env: Env,
  input: {
    ask: QuestionAsk;
    answer: string;
    userId: string;
    authorization: Awaited<ReturnType<typeof authorizeAgentWake>>;
  }
): Promise<QuestionAnswerResult> {
  const { ask, answer, userId } = input;
  if (ask.status !== 'open') return settledOutcome(ask, answer);
  const now = Date.now();
  if (ask.expiresAt !== null && ask.expiresAt <= now) {
    throw markRejectedBeforeEffects(errors.conflict('This question expired'));
  }
  if (ask.options.length > 0 && !ask.options.includes(answer)) {
    throw markRejectedBeforeEffects(
      errors.badRequest('answer must match one of the requested options')
    );
  }
  const claimed = await env.DATABASE.prepare(
    `UPDATE asks
        SET status = 'answered', answer_json = ?, resolved_by_user_id = ?, resolved_at = ?,
            updated_at = ?
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND kind = 'question'
        AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(JSON.stringify({ text: answer }), userId, now, now, ask.id, ask.projectId, ask.sessionId, now)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    // Someone else settled it first: report what they did.
    const current = await loadQuestionAsk(env, ask.projectId, ask.sessionId, ask.id);
    if (!current) throw markRejectedBeforeEffects(errors.notFound('Attention request'));
    if (current.status === 'open') throw markRejectedBeforeEffects(errors.conflict('This question expired'));
    return settledOutcome(current, answer);
  }

  const deps = { env, ports: createOperationPorts(env) };
  const row = await loadAskNoticeRow(deps, ask.projectId, ask.id);
  const queued = row ? await notifyClosedAsk(deps, row, 'answered') : false;
  // A teammate's answer is recorded on the shared-answer audit event, as for a marker.
  await recordSharedSessionAnswer(env, input.authorization.writer, {
    markerId: ask.id,
    wake: agentWakeRecord(input.authorization.wake),
  });
  return queued
    ? { resolved: true, alreadyResolved: false, answer }
    : { resolved: false, alreadyResolved: false, inFlight: true, answer };
}

/** `request.resolvedAt` / `resolvedAnswer` as the chat card read them from a marker. */
export function questionAskRequestState(ask: QuestionAsk, now: number) {
  // An answer that has not reached the agent yet is in flight: a marker showed it as a staged
  // answer with no resolution time.
  const delivering = ask.status === 'answered' && ask.answer !== null && ask.notifiedAt === null;
  return {
    resolvedAt: ask.status === 'open' || delivering ? null : ask.resolvedAt,
    resolvedAnswer: ask.status === 'answered' ? ask.answer : null,
    expired: ask.status === 'expired' || (ask.expiresAt !== null && ask.expiresAt <= now),
  };
}

export interface FileQuestionInput {
  projectId: string;
  sessionId: string;
  taskId: string;
  workspaceId: string | null;
  userId: string;
  context: string;
  category: HumanInputCategory | null;
  options: string[] | null;
}

/**
 * File a `request_human_input` question as an `asks` row through the shared create operation
 * (`createAsk`): assignee, per-chat cap and lengths are its checks; the schedule is the
 * `inbox.question*` settings. The chat list shows it live (`recordQuestionAsked`).
 */
export async function fileQuestionAsk(
  env: Env,
  input: FileQuestionInput
): Promise<{ id: string; createdAt: number; expiresAt: number }> {
  const ports = createOperationPorts(env);
  const ctx = {
    env,
    ports,
    requestId: '',
    actor: {
      userId: input.userId,
      via: 'workspace-agent' as const,
      scopes: new Set(['sam.write'] as const),
      workspace: {
        workspaceId: input.workspaceId ?? '',
        taskId: input.taskId,
        projectId: input.projectId,
      },
    },
  };
  const limits = await getInboxLimits(ctx);
  const now = Date.now();
  const schedule = questionSchedule(limits, now);
  const created = await createAsk(ctx, {
    projectId: input.projectId,
    assigneeKind: 'user',
    assigneeUserId: input.userId,
    kind: 'question',
    blocking: true,
    title: inboxTitle(input.context, limits.titleMaxChars),
    body: input.context,
    answerSpec: input.options?.length
      ? { type: 'options', options: input.options, allowText: false }
      : { type: 'text' },
    sourceSessionId: input.sessionId,
    sourceTaskId: input.taskId,
    sourceWorkspaceId: input.workspaceId ?? undefined,
    category: input.category ?? undefined,
    expiresAt: schedule.expiresAt,
    nextEscalationAt: schedule.nextEscalationAt ?? undefined,
    maxExpiresAt: schedule.maxExpiresAt,
  });
  try {
    await projectDataService.recordQuestionAsked(env, input.projectId, {
      sessionId: input.sessionId,
      askId: created.id,
      createdAt: now,
      expiresAt: schedule.expiresAt,
      reason: input.context,
      options: input.options ?? [],
    });
  } catch (error) {
    // The question is filed; the chat list shows it on its next read.
    log.warn('question_ask.live_update_failed', {
      askId: created.id,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { id: created.id, createdAt: now, expiresAt: schedule.expiresAt };
}

/** Link the notification sent for a question, so reminders resend its push (`sweep.ts`). */
export async function linkQuestionNotification(
  env: Env,
  projectId: string,
  askId: string,
  notificationId: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE asks SET notification_id = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND kind = 'question' AND status = 'open'`
  )
    .bind(notificationId, Date.now(), askId, projectId)
    .run();
}
