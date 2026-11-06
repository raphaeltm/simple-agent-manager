import type { ConversationItem } from '@simple-agent-manager/acp-client';
import {
  buildSamNotice,
  parseSamNotice,
  SAM_NOTICE_METADATA_KEY,
  type SamNotice,
} from '@simple-agent-manager/shared';

import type { ChatMessageResponse } from '../../../lib/api';
import { maybeJsonRecord } from '../../../lib/runtime-validation';

/**
 * The server-written notice on a transcript row, or null. A notice is trusted only on rows
 * only SAM writes: durable deliveries and orchestrator check-ins (role `user`) and display
 * rows (role `system`). The server also strips notices from agent-supplied metadata, so this
 * is the second of two checks. Message text is never parsed.
 */
export function samNoticeForMessage(
  message: Pick<ChatMessageResponse, 'role' | 'toolMetadata'>
): SamNotice | null {
  const meta = maybeJsonRecord(message.toolMetadata);
  if (!meta || !(SAM_NOTICE_METADATA_KEY in meta)) return null;
  const fromSam =
    message.role === 'system' ||
    (message.role === 'user' &&
      (meta.kind === 'durable_prompt_delivery' || meta.source === 'sam_orchestrator'));
  return fromSam ? parseSamNotice(meta[SAM_NOTICE_METADATA_KEY]) : null;
}

/**
 * Conversation items are acp-client types, which know nothing about notices. The web layer
 * carries the notice on the item it already builds and reads it back with `noticeOf`.
 */
export type WithSamNotice<T extends ConversationItem> = T & { samNotice: SamNotice };

export function withSamNotice<T extends ConversationItem>(
  item: T,
  notice: SamNotice
): WithSamNotice<T> {
  return { ...item, samNotice: notice };
}

export function noticeOf(item: ConversationItem | { kind: string }): SamNotice | null {
  const notice = (item as { samNotice?: unknown }).samNotice;
  return notice && typeof notice === 'object' ? (notice as SamNotice) : null;
}

/**
 * A display-only system row (sleep notices, failure reports) that carries no notice gets the
 * same compact row: its first line is the headline and the full text is one tap away. The
 * row's role is server-written, so no text is read for meaning.
 */
export function systemRowNotice(text: string): SamNotice {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? 'Message from SAM';
  return buildSamNotice({
    type: 'system.message',
    headline: firstLine,
    severity: 'info',
    refs: [],
  });
}
