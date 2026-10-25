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

import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import * as projectDataService from '../services/project-data';
import { untrustedTextBlock } from './untrusted-text';

type Marker = Awaited<ReturnType<typeof projectDataService.listActiveAttentionMarkers>>[number];

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

/**
 * Open markers for one chat. A failed read degrades to `unavailable` rather than failing the
 * caller's whole read, and says so: an empty list must mean "nothing open".
 */
export async function pendingAttention(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ items: PendingAttentionItem[]; available: boolean }> {
  try {
    const markers = await projectDataService.listActiveAttentionMarkers(env, projectId, sessionId);
    return { items: markers.map(projectAttentionMarker), available: true };
  } catch (error) {
    log.warn('connector.pending_attention_unavailable', {
      projectId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { items: [], available: false };
  }
}
