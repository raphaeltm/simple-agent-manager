import { IconButton, Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';

import type { MessageCommentAction } from '../../lib/api/comments';
import { CommentComposer } from '../project-message-view/comments/CommentComposer';
import { CommentThreadList } from '../project-message-view/comments/CommentThread';
import { useLibraryFileComments } from './useLibraryFileComments';

interface FileCommentPanelProps {
  projectId: string;
  fileId: string;
  /** Text the user selected in the preview, attached to the thread they are about to create. */
  pendingQuote?: string | null;
  onClearPendingQuote?: () => void;
  onClose: () => void;
}

export function FileCommentPanel({
  projectId,
  fileId,
  pendingQuote,
  onClearPendingQuote,
  onClose,
}: FileCommentPanelProps) {
  const { comments, loading, error, mutationError, createThread, reply, resolve, reopen } =
    useLibraryFileComments(projectId, fileId);

  // These reject on failure by design: CommentComposer catches, keeps the draft
  // text, and leaves the reason to be rendered from `mutationError` below.
  const handleCreateThread = async (body: string, _action: MessageCommentAction) => {
    await createThread(body, pendingQuote ?? undefined);
    onClearPendingQuote?.();
  };

  const handleReply = async (threadId: string, body: string, _action: MessageCommentAction) => {
    await reply(threadId, body);
  };

  const handleResolve = async (threadId: string) => {
    try {
      await resolve(threadId);
    } catch {
      /* surfaced via mutationError */
    }
  };

  const handleReopen = async (threadId: string) => {
    try {
      await reopen(threadId);
    } catch {
      /* surfaced via mutationError */
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--sam-hairline)] py-1 pl-4 pr-1">
        <h4 className="m-0 text-sm font-semibold text-fg-primary">Comments</h4>
        <IconButton
          label="Close comments"
          icon={<X size={18} aria-hidden="true" />}
          onClick={onClose}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="sm" />
          </div>
        )}

        {error && !loading && <p className="text-sm text-danger-fg">{error}</p>}

        {!loading && !error && (
          <CommentThreadList
            comments={comments}
            emptyMessage="No comments on this file yet."
            hideSendToAgent
            onReply={handleReply}
            onResolve={handleResolve}
            onReopen={handleReopen}
            onSendToAgent={undefined}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--sam-hairline)] p-3">
        {mutationError && (
          <p role="alert" className="mb-2 text-xs text-danger-fg">
            {mutationError}
          </p>
        )}
        <CommentComposer
          // Remounting on quote change resets the draft body to match the new
          // selection, and re-runs autoFocus so the user can type immediately.
          key={pendingQuote ?? 'no-quote'}
          quote={pendingQuote ?? undefined}
          placeholder={
            pendingQuote ? 'Comment on the selected text…' : 'Add a comment on this file…'
          }
          submitLabel="Comment"
          hideSendToAgent
          onSubmit={handleCreateThread}
          onCancel={() => {
            if (pendingQuote) {
              onClearPendingQuote?.();
              return;
            }
            onClose();
          }}
        />
      </div>
    </div>
  );
}
