import { Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';

import type { MessageCommentAction } from '../../lib/api/comments';
import { CommentComposer } from '../project-message-view/comments/CommentComposer';
import { CommentThreadList } from '../project-message-view/comments/CommentThread';
import { FOCUS_RING } from './types';
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
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-border-default bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-border-default px-3 py-2">
        <h4 className="text-sm font-semibold text-fg-primary">Comments</h4>
        <button
          type="button"
          onClick={onClose}
          className={`rounded p-1 text-fg-muted hover:text-fg-primary ${FOCUS_RING}`}
          aria-label="Close comments"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="sm" />
          </div>
        )}

        {error && !loading && (
          <p className="text-sm text-danger-fg">{error}</p>
        )}

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

      <div className="shrink-0 border-t border-border-default p-3">
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
