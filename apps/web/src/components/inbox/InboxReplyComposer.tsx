import type { InboxItem, InboxReplyResponse } from '@simple-agent-manager/shared';
import { Info } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { useAvailableCommands } from '../../hooks/useAvailableCommands';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getTranscribeApiUrl, replyToInboxItem } from '../../lib/api';
import { ApiClientError } from '../../lib/api/client';
import {
  DEFAULT_ATTACHMENT_MESSAGE,
  useAttachments,
} from '../../pages/project-chat/useAttachments';
import { ProjectChatComposer } from '../project-chat/ProjectChatComposer';
import { errorText } from './inbox-actions';

/** Replying to a pending permission declines it first (decision 1, 20 November). */
export function replyDeclinesPermission(item: InboxItem): boolean {
  return item.kind === 'permission' && item.status === 'open';
}

/**
 * The project chat's own composer (attachments, voice, paste-to-file, slash commands), pinned
 * under an inbox item. Sending posts a reply: the message lands in the agent's chat with a
 * pointer to this item, and the item leaves the inbox until the agent responds on it.
 */
export function InboxReplyComposer({
  item,
  onSent,
  onGone,
}: {
  item: InboxItem;
  onSent: (response: InboxReplyResponse) => void;
  /** The item no longer exists (404): close it. */
  onGone: () => void;
}) {
  const isMobile = useIsMobile();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments(item.projectId, setError, item.ref);
  const { commands: slashCommands } = useAvailableCommands(item.projectId);
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);
  const declines = replyDeclinesPermission(item);
  const { chatAttachments, clearAttachments } = attachments;

  const send = useCallback(async () => {
    const files = chatAttachments.flatMap((file) => (file.ref ? [file.ref] : []));
    const content = text.trim() || (files.length > 0 ? DEFAULT_ATTACHMENT_MESSAGE : '');
    if (!content || sending || chatAttachments.some((file) => file.status !== 'complete')) return;
    setSending(true);
    setError(null);
    try {
      const response = await replyToInboxItem(item.projectId, item.ref, {
        content,
        ...(files.length > 0 ? { attachments: files } : {}),
      });
      setText('');
      clearAttachments();
      onSent(response);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 404) onGone();
      // A 409 explains itself ("may have reached the agent; inspect its chat"): keep the draft.
      else setError(errorText(cause, 'Could not send your reply'));
    } finally {
      setSending(false);
    }
  }, [chatAttachments, clearAttachments, item.projectId, item.ref, onGone, onSent, sending, text]);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="inbox-reply-composer">
      {declines && (
        <p
          className="m-0 flex min-w-0 items-start gap-1.5 text-[13px] text-warning-fg"
          data-testid="inbox-reply-declines"
        >
          <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            Sending declines this request. Your message goes to the agent as the reason.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <ProjectChatComposer
        value={text}
        onChange={setText}
        onSend={() => void send()}
        sending={sending}
        placeholder={declines ? 'Why decline? Tell the agent…' : 'Reply to the agent about this…'}
        inputLabel="Reply to the agent"
        transcribeApiUrl={transcribeApiUrl}
        slashCommands={slashCommands}
        attachments={chatAttachments}
        onFilesSelected={attachments.handleChatFilesSelected}
        onRemoveAttachment={attachments.handleRemoveChatAttachment}
        fileInputRef={attachments.chatFileInputRef}
        uploading={attachments.chatUploading}
        showShortcutHint={!isMobile}
        focusOnMount={false}
      />
    </div>
  );
}
