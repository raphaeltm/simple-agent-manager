import type { InboxActionResponse, InboxItem } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { answerInboxItem } from '../../lib/api';
import { ApiClientError } from '../../lib/api/client';
import { usePermissionDetail } from '../project-message-view/useAcpPermissionCard';

/**
 * Inbox answer logic shared by the Inbox page and the quick view. Kept apart from the controls so
 * the app shell (the inbox icon) never pulls the answer components into the main bundle.
 */

/** The item was answered or closed somewhere else (409), or is gone (404). */
export function isStaleInboxError(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 409);
}

export interface InboxAnswerHandlers {
  /** The answer was accepted: show `receipt` and move on. */
  onAnswered: (receipt: string) => void;
  /** Answered or closed elsewhere: close this item. */
  onStale: () => void;
}

/** Secure permission detail (title, description, options) for a live permission item. */
export function useInboxPermissionDetail(item: InboxItem) {
  const spec = item.answerSpec;
  const live =
    spec.type === 'interaction' &&
    spec.interactionKind === 'permission' &&
    Boolean(spec.interactionId && item.sessionId) &&
    item.status === 'open' &&
    item.canAct;
  return usePermissionDetail({
    projectId: item.projectId,
    sessionId: item.sessionId ?? '',
    interactionId: spec.type === 'interaction' ? (spec.interactionId ?? '') : '',
    mayReveal: live,
  });
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** " · the agent will be told shortly" when the notice was not queued yet (a sweep retries it). */
export function deliveryNote(response: InboxActionResponse): string {
  return response.agentNotified ? '' : ' · the agent will be told shortly';
}

/**
 * The receipt for "Looks good" on a review or "Got it" on a result. "Got it" deliberately tells
 * the agent nothing (`answerAsk`, `packages/operations`), so it must not get `deliveryNote`'s
 * "will be told shortly".
 */
export function acknowledgeReceipt(item: InboxItem, response: InboxActionResponse): string {
  if (item.kind === 'result') return 'Got it · the agent won’t be woken';
  return `Marked “Looks good”${deliveryNote(response)}`;
}

/** One answer request with stale handling; failures keep the item and show the error. */
export function useInboxSend(item: InboxItem, handlers: InboxAnswerHandlers) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (
    key: string,
    body: Parameters<typeof answerInboxItem>[2],
    receipt: (response: InboxActionResponse) => string
  ) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const response = await answerInboxItem(item.projectId, item.ref, body);
      handlers.onAnswered(receipt(response));
    } catch (cause) {
      if (isStaleInboxError(cause)) handlers.onStale();
      else setError(errorText(cause, 'Could not send this answer'));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, send };
}
