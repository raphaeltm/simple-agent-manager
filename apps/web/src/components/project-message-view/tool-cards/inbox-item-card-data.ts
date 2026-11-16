import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { INBOX_WRITE_TOOL } from '@simple-agent-manager/shared';

import { isJsonRecord } from '../../../lib/runtime-validation';
import { normalizeToolName, parseResultPayload } from './document-card-data';

/** True when the tool call is an `inbox_write` call, under any agent's naming. */
export function isInboxItemCardTool(item: ToolCallItem): boolean {
  return normalizeToolName(item.toolName ?? item.title) === INBOX_WRITE_TOOL;
}

export interface InboxItemCardRef {
  /** `ask:<id>`. */
  ref: string;
  sessionId: string;
}

/**
 * The item an `inbox_write` ask or review filed (`{ inboxItem: { ref, sessionId }, … }`), or
 * undefined for an update or cancel, a failed call, or a call still running. Only the reference
 * is taken from the transcript: the card reads everything it shows from the inbox.
 */
export function extractInboxItemRef(item: ToolCallItem): InboxItemCardRef | undefined {
  const result = parseResultPayload(item.rawOutput ?? item.content);
  const filed = result && isJsonRecord(result.inboxItem) ? result.inboxItem : undefined;
  const ref = filed?.ref;
  const sessionId = filed?.sessionId;
  return typeof ref === 'string' &&
    /^ask:[A-Za-z0-9_-]{1,128}$/.test(ref) &&
    typeof sessionId === 'string' &&
    sessionId
    ? { ref, sessionId }
    : undefined;
}
