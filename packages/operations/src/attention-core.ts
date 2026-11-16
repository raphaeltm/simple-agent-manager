/**
 * Open attention markers for one chat, projected for apps.
 *
 * `request_human_input` records its question as a ProjectData attention marker, not as an ACP
 * interaction, so reads that only consult the InteractionStore (permission, form and URL
 * requests) never showed it. This is the one projection `sam_chat_read`, `sam_chat_interactions`
 * and `sam_work_changes` share, so the three agree.
 *
 * Markers mirrored from an ACP interaction (`source: 'acp_interaction'`) are reported as pointers:
 * their options and answers belong to the interaction (`interactionId`).
 */
import {
  HUMAN_INPUT_CATEGORIES,
  type HumanInputCategory,
  MAX_HUMAN_INPUT_CONTEXT_LENGTH,
  MAX_HUMAN_INPUT_OPTION_LENGTH,
  MAX_HUMAN_INPUT_OPTIONS_COUNT,
} from '@simple-agent-manager/shared';
import {
  log,
  maybeJsonRecord,
  QUESTION_ASK_SOURCE,
  questionOptions,
} from '@simple-agent-manager/worker-core';

import type { OperationProjectDataPort } from './ports';
import type { OperationDeps } from './types';
import { untrustedTextBlock } from './untrusted-text';

type Marker = Awaited<ReturnType<OperationProjectDataPort['listActiveAttentionMarkers']>>[number];

function iso(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

/**
 * A question's options and category from marker or notification metadata, bounded the way
 * request_human_input bounds them when it stores them.
 */
export function questionMetadata(record: Record<string, unknown> | null): {
  options: string[];
  category: HumanInputCategory | null;
} {
  const options = Array.isArray(record?.options)
    ? record.options
        .filter((option): option is string => typeof option === 'string')
        .slice(0, MAX_HUMAN_INPUT_OPTIONS_COUNT)
        .map((option) => option.slice(0, MAX_HUMAN_INPUT_OPTION_LENGTH))
    : [];
  // request_human_input accepts only these categories; anything else is not reported.
  const category = (HUMAN_INPUT_CATEGORIES as readonly unknown[]).includes(record?.category)
    ? (record?.category as HumanInputCategory)
    : null;
  return { options, category };
}

function markerMetadata(marker: Marker) {
  let record: Record<string, unknown> | null = null;
  if (marker.metadata) {
    try {
      record = maybeJsonRecord(JSON.parse(marker.metadata)) ?? null;
    } catch {
      record = null;
    }
  }
  return questionMetadata(record);
}

/** How a person acts on this marker, in the tool vocabulary apps use. */
function answerGuidance(marker: Marker, answerable: boolean): string {
  if (marker.source === 'acp_interaction') {
    return 'Answer the matching interaction from pendingInteractions (interactionId), not this marker.';
  }
  if (answerable) {
    return 'Ask the user, then call sam_agent_answer with markerId and answer (one of options when options are listed). Sending a chat message also answers it.';
  }
  return 'No answer is expected; send a chat message if the user wants the agent to act.';
}

export function projectAttentionMarker(marker: Marker) {
  const { options, category } = markerMetadata(marker);
  const answerable = marker.kind === 'needs_input' && marker.source !== 'acp_interaction';
  return {
    markerId: marker.id,
    kind: marker.kind,
    source: marker.source,
    category,
    answerable,
    urgency: marker.kind === 'needs_input' ? 'needs_person' : 'informational',
    question: untrustedTextBlock({
      kind: 'agent question',
      text: marker.reason,
      maxLength: MAX_HUMAN_INPUT_CONTEXT_LENGTH,
    }),
    options,
    taskId: marker.taskId,
    createdAt: iso(marker.createdAt),
    expiresAt: iso(marker.expiresAt),
    latestExpiresAt: iso(marker.maxExpiresAt),
    reminders: marker.escalationCount,
    nextReminderAt: iso(marker.nextEscalationAt),
    // The Notification DO links the notification it created for this marker; delivery to a
    // device is not recorded here.
    notification: {
      notificationId: marker.sourceNotificationId,
      deviceDelivery: 'not_recorded',
    },
    answerWith: answerGuidance(marker, answerable),
  };
}

export type PendingAttentionItem = ReturnType<typeof projectAttentionMarker>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The chat's open questions held in D1 `asks` (inbox slice G), as the marker records they replace,
 * so one projection serves both. Bound to the project and the chat (rule 11). Newest first.
 */
async function openQuestionMarkers(
  deps: OperationDeps,
  projectId: string,
  sessionId: string
): Promise<Marker[]> {
  const result = await deps.env.DATABASE.prepare(
    `SELECT id, source_task_id, source_workspace_id, title, body_md, answer_spec_json, category,
            created_at, expires_at, max_expires_at, escalation_count, next_escalation_at,
            notification_id, assignee_user_id
       FROM asks
      WHERE project_id = ? AND source_session_id = ? AND kind = 'question' AND status = 'open'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  )
    .bind(projectId, sessionId, MAX_OPEN_QUESTIONS_PER_READ)
    .all<Record<string, unknown>>();
  const markers: Marker[] = [];
  for (const row of result.results ?? []) {
    const id = str(row.id);
    const createdAt = num(row.created_at);
    if (!id || createdAt === null) continue;
    markers.push({
      id,
      sessionId,
      taskId: str(row.source_task_id),
      workspaceId: str(row.source_workspace_id),
      kind: 'needs_input',
      source: QUESTION_ASK_SOURCE,
      sourceEventId: null,
      sourceMessageId: null,
      sourceNotificationId: str(row.notification_id),
      reason: str(row.body_md) ?? str(row.title),
      metadata: JSON.stringify({
        category: str(row.category),
        options: questionOptions(row.answer_spec_json),
      }),
      createdAt,
      expiresAt: num(row.expires_at),
      resolvedAt: null,
      resolvedByMessageId: null,
      resolvedByActorType: null,
      resolvedReason: null,
      notificationUserId: str(row.assignee_user_id),
      nextEscalationAt: num(row.next_escalation_at),
      escalationCount: num(row.escalation_count) ?? 0,
      maxExpiresAt: num(row.max_expires_at),
      resolvedAnswer: null,
    });
  }
  return markers;
}

/** A chat holds at most `inbox.openItemsPerChat` open asks; this read is bounded on its own. */
const MAX_OPEN_QUESTIONS_PER_READ = 50;

/**
 * Open markers and open questions for one chat, newest first. A failed read degrades to
 * `unavailable` rather than failing the caller's whole read, and says so: an empty list must
 * mean "nothing open".
 */
export async function pendingAttention(
  deps: OperationDeps,
  projectId: string,
  sessionId: string
): Promise<{ items: PendingAttentionItem[]; available: boolean }> {
  try {
    const [markers, questions] = await Promise.all([
      deps.ports.projectData.listActiveAttentionMarkers(projectId, sessionId),
      openQuestionMarkers(deps, projectId, sessionId),
    ]);
    return {
      items: [...questions, ...markers]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(projectAttentionMarker),
      available: true,
    };
  } catch (error) {
    log.warn('connector.pending_attention_unavailable', {
      projectId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { items: [], available: false };
  }
}
