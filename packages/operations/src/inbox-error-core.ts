/**
 * System error items (inbox slice E, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 decision 3): the one case
 * where SAM files an inbox item itself. Each is an `asks` row of kind `error`, filed through the
 * shared create operation (`createAsk`) with a stable dedupe key per failing thing, so:
 * - a repeat failure updates the open item in place (`failure_count`, latest reason, `updated_at`);
 * - recovery closes it by itself (`done`, `answer_json.resolution = 'recovered'`) and releases the
 *   key, so a later, separate failure files a new item;
 * - an archived item stays archived while the thing keeps failing, until it recovers.
 *
 * An error item has no filing agent, so closing it never queues an agent notice: every close
 * sets `notified_at` (the notice sweep, `apps/api/src/services/inbox/sweep.ts`, skips it).
 *
 * Filing and closing never throw: a failure here is logged and must never mask or slow the
 * failure being reported.
 */
import {
  type InboxActionResponse,
  type InboxErrorAction,
  type InboxErrorActionOption,
  type InboxItem,
  type InboxLink,
} from '@simple-agent-manager/shared';

import { OperationError } from './errors';
import { createAsk } from './inbox-write-core';
import { updateSchedule } from './schedule-writes';
import type { OperationContext, OperationDeps } from './types';

/** What failed. The dedupe key is `error:<source>:<subjectId>`. */
export const SYSTEM_ERROR_SOURCES = ['task', 'wake', 'sleep', 'automation', 'delivery'] as const;
export type SystemErrorSource = (typeof SYSTEM_ERROR_SOURCES)[number];

const ACTION_LABELS: Record<InboxErrorAction, string> = {
  retry: 'Retry',
  wake: 'Wake the chat',
  resume: 'Resume',
  open_chat: 'Open chat',
};

/** Which fixes a source can run; anything else in an item's spec is refused. */
const SOURCE_ACTIONS: Record<SystemErrorSource, readonly InboxErrorAction[]> = {
  task: ['retry', 'open_chat'],
  wake: ['wake', 'open_chat'],
  sleep: ['open_chat'],
  automation: ['resume'],
  delivery: ['open_chat'],
};

export function systemErrorKey(source: SystemErrorSource, subjectId: string): string {
  return `error:${source}:${subjectId}`;
}

function parseSystemErrorKey(
  key: string | null
): { source: SystemErrorSource; subjectId: string } | null {
  const match = /^error:([a-z]+):(.+)$/.exec(key ?? '');
  if (!match) return null;
  const source = match[1] as SystemErrorSource;
  return SYSTEM_ERROR_SOURCES.includes(source) && match[2] ? { source, subjectId: match[2] } : null;
}

export function systemErrorActions(actions: readonly InboxErrorAction[]): InboxErrorActionOption[] {
  return actions.map((id) => ({ id, label: ACTION_LABELS[id] }));
}

/** Characters kept from a name (task title, chat topic, automation name) inside a title. */
const NAME_MAX_CHARS = 100;

/** A name quoted inside a title: one line, bounded. Never a source of error text. */
export function quotedName(name: string | null | undefined, fallback: string): string {
  const line = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return `“${line.length > NAME_MAX_CHARS ? `${line.slice(0, NAME_MAX_CHARS - 1)}…` : line}”`;
}

export interface SystemErrorInput {
  projectId: string;
  /** The person who owns the failing chat, task or automation. */
  assigneeUserId: string;
  source: SystemErrorSource;
  subjectId: string;
  /** One sentence: what failed and what it affected. Built by SAM, never from raw error text. */
  title: string;
  /** One plain sentence: what it means or what to do. Never raw error text. */
  body: string;
  /** Fixes to offer, in display order; filtered to what the source supports. */
  actions: readonly InboxErrorAction[];
  sourceTaskId?: string | null;
  sourceSessionId?: string | null;
  links?: InboxLink[];
  /** Items with one group key stack (for example the children of one parent task). */
  groupKey?: string | null;
  /**
   * The thing's own failure count (an automation's failed runs in a row). When given it is
   * stored as is, so re-reporting the same state is idempotent; otherwise a repeat adds one.
   */
  failureCount?: number;
}

export interface SystemErrorFiled {
  ref: string;
  id: string;
  /** True when this failure opened a new item; false when it updated an existing one. */
  created: boolean;
}

function systemContext(deps: OperationDeps, userId: string): OperationContext {
  return {
    ...deps,
    actor: { userId, via: 'sam', scopes: new Set() },
    requestId: `system-error:${Date.now()}`,
  };
}

function logFailure(event: string, fields: Record<string, unknown>, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

/**
 * File a system error item, or update the open one for the same thing. Returns null when nothing
 * was filed (logged). D1 round trips: settings, member check, task check (when a task is named),
 * insert; a repeat adds the dedupe read and one update.
 */
export async function fileSystemError(
  deps: OperationDeps,
  input: SystemErrorInput
): Promise<SystemErrorFiled | null> {
  const dedupeKey = systemErrorKey(input.source, input.subjectId);
  const actions = input.actions.filter((action) => SOURCE_ACTIONS[input.source].includes(action));
  try {
    const filed = await createAsk(systemContext(deps, input.assigneeUserId), {
      projectId: input.projectId,
      assigneeKind: 'user',
      assigneeUserId: input.assigneeUserId,
      kind: 'error',
      blocking: false,
      title: input.title,
      body: input.body,
      answerSpec: actions.length
        ? { type: 'actions', actions: systemErrorActions(actions) }
        : { type: 'acknowledge' },
      links: input.links ?? [],
      ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
      ...(input.sourceTaskId && input.sourceSessionId
        ? { sourceSessionId: input.sourceSessionId }
        : {}),
      ...(input.groupKey ? { groupKey: input.groupKey } : {}),
      dedupeKey,
    });
    if (filed.created && input.failureCount === undefined) return { ...filed, created: true };
    // Same thing failed again (or reports its own count): update the open item in place. An
    // archived item stays archived (the person said they will not act) until the thing recovers
    // and releases the key.
    const now = Date.now();
    await deps.env.DATABASE.prepare(
      `UPDATE asks SET failure_count = COALESCE(?, failure_count + 1), title = ?, body_md = ?,
          updated_at = ?
        WHERE id = ? AND project_id = ? AND kind = 'error' AND status = 'open'`
    )
      .bind(input.failureCount ?? null, input.title, input.body, now, filed.id, input.projectId)
      .run();
    return { ref: filed.ref, id: filed.id, created: filed.created };
  } catch (error) {
    logFailure(
      'inbox.system_error_file_failed',
      { projectId: input.projectId, source: input.source, subjectId: input.subjectId },
      error
    );
    return null;
  }
}

export type SystemErrorResolution = 'recovered' | 'retried' | 'resumed' | 'cancelled';

/**
 * The thing recovered: close its open item (`done`) and release the dedupe key, on an open or an
 * archived row, so the next failure is a new item. Returns how many rows changed; never throws.
 */
export async function resolveSystemError(
  deps: Pick<OperationDeps, 'env'>,
  input: {
    projectId: string;
    source: SystemErrorSource;
    subjectId: string;
    resolution: SystemErrorResolution;
    /** The person whose action resolved it, when one did. */
    resolvedByUserId?: string | null;
  }
): Promise<number> {
  const now = Date.now();
  try {
    const result = await deps.env.DATABASE.prepare(
      `UPDATE asks
          SET status = CASE WHEN status = 'open' THEN 'done' ELSE status END,
              answer_json = CASE WHEN status = 'open' THEN ? ELSE answer_json END,
              resolved_by_user_id = CASE WHEN status = 'open' THEN ? ELSE resolved_by_user_id END,
              resolved_at = CASE WHEN status = 'open' THEN ? ELSE resolved_at END,
              notified_at = COALESCE(notified_at, ?),
              dedupe_key = NULL, updated_at = ?
        WHERE project_id = ? AND dedupe_key = ? AND kind = 'error'
          AND status IN ('open', 'archived')`
    )
      .bind(
        JSON.stringify({ resolution: input.resolution }),
        input.resolvedByUserId ?? null,
        now,
        now,
        now,
        input.projectId,
        systemErrorKey(input.source, input.subjectId)
      )
      .run();
    return result.meta?.changes ?? 0;
  } catch (error) {
    logFailure(
      'inbox.system_error_resolve_failed',
      { projectId: input.projectId, source: input.source, subjectId: input.subjectId },
      error
    );
    return 0;
  }
}

async function loadErrorTarget(
  ctx: OperationContext,
  projectId: string,
  askId: string
): Promise<{ source: SystemErrorSource; subjectId: string }> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT dedupe_key FROM asks WHERE id = ? AND project_id = ? AND kind = 'error'`
  )
    .bind(askId, projectId)
    .first<{ dedupe_key: string | null }>();
  const target = parseSystemErrorKey(row?.dedupe_key ?? null);
  if (!target) throw new OperationError('conflict', 'This item no longer has a fix to run');
  return target;
}

/** Run the fix an error item offers, with the answering person's authority. */
export async function answerErrorItem(
  ctx: OperationContext,
  item: InboxItem,
  askId: string,
  action: InboxErrorAction | undefined
): Promise<InboxActionResponse> {
  if (!action) throw new OperationError('invalid_input', 'action is required for this item');
  if (action === 'open_chat')
    throw new OperationError('invalid_input', 'Open the chat in the app; there is nothing to run');
  const offered =
    item.answerSpec.type === 'actions' && item.answerSpec.actions.some((a) => a.id === action);
  if (!offered) throw new OperationError('invalid_input', 'This item does not offer that action');
  const target = await loadErrorTarget(ctx, item.projectId, askId);
  if (!SOURCE_ACTIONS[target.source].includes(action))
    throw new OperationError('invalid_input', 'This item does not offer that action');
  const me = ctx.actor.userId;

  switch (action) {
    case 'retry': {
      await ctx.ports.inbox.retryTask(me, item.projectId, target.subjectId);
      await resolveSystemError(ctx, {
        projectId: item.projectId,
        source: target.source,
        subjectId: target.subjectId,
        resolution: 'retried',
        resolvedByUserId: me,
      });
      return { ref: item.ref, outcome: 'retried', agentNotified: false };
    }
    case 'wake': {
      // The item closes when the chat actually wakes (ProjectData), not when the wake starts.
      await ctx.ports.inbox.wakeChat(me, item.projectId, target.subjectId);
      return { ref: item.ref, outcome: 'wake_requested', agentNotified: false };
    }
    case 'resume': {
      await updateSchedule(ctx, {
        projectId: item.projectId,
        scheduleId: target.subjectId,
        paused: false,
      });
      await resolveSystemError(ctx, {
        projectId: item.projectId,
        source: target.source,
        subjectId: target.subjectId,
        resolution: 'resumed',
        resolvedByUserId: me,
      });
      return { ref: item.ref, outcome: 'resumed', agentNotified: false };
    }
  }
}

/**
 * Archive an error item: closed for the person, with no agent to tell (`notified_at` set). The
 * dedupe key stays, so repeats of the same failure stay quiet until the thing recovers.
 */
export async function archiveErrorItem(
  ctx: OperationContext,
  item: InboxItem,
  askId: string
): Promise<InboxActionResponse> {
  const now = Date.now();
  const me = ctx.actor.userId;
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks
        SET status = 'archived', resolved_by_user_id = ?, resolved_at = ?, updated_at = ?,
            notified_at = ?
      WHERE id = ? AND project_id = ? AND kind = 'error' AND status = 'open'
        AND assignee_kind = 'user' AND assignee_user_id = ?`
  )
    .bind(me, now, now, now, askId, item.projectId, me)
    .run();
  if ((result.meta?.changes ?? 0) !== 1)
    throw new OperationError('conflict', 'This inbox item was already closed');
  return { ref: item.ref, outcome: 'archived', agentNotified: false };
}
