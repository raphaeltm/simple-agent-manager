import { Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';

import type { MessageCommentAction } from '../../lib/api/comments';
import { CommentComposer } from '../project-message-view/comments/CommentComposer';
import { CommentThreadList } from '../project-message-view/comments/CommentThread';
import { useLibraryFileComments } from './useLibraryFileComments';
import { FOCUS_RING } from './types';

interface FileCommentPanelProps {
  projectId: string;
  fileId: string;
  onClose: () => void;
}

export function FileCommentPanel({ projectId, fileId, onClose }: FileCommentPanelProps) {
  const { comments, loading, error, createThread, reply, resolve, reopen } =
    useLibraryFileComments(projectId, fileId);

  const handleCreateThread = async (body: string, _action: MessageCommentAction) => {
    await createThread(body);
  };

  const handleReply = async (threadId: string, body: string, _action: MessageCommentAction) => {
    await reply(threadId, body);
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
            onResolve={resolve}
            onReopen={reopen}
            onSendToAgent={undefined}
          />
        )}
      </div>

      <div className="shrink-0 border-t border-border-default p-3">
        <CommentComposer
          placeholder="Add a comment on this file…"
          submitLabel="Comment"
          autoFocus={false}
          hideSendToAgent
          onSubmit={handleCreateThread}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
