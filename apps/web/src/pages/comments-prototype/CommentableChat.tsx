/**
 * The chat surface: production `MessageBubble` wrapped with a comment affordance.
 *
 * The wrapper deliberately adds NOTHING to MessageBubble itself. It sits in the
 * per-row container — the same place `ProjectMessageView.renderConversationItem`
 * already wraps each row in `.sam-message-entry` and where `item.id` is in scope.
 * That is the intended integration point if this ships.
 */

import { MessageBubble } from '@simple-agent-manager/acp-client';
import { Button } from '@simple-agent-manager/ui';

import type { Comment, PrototypeMessage } from './comment-types';
import { commentsForMessage } from './comment-types';
import { CommentCountMarker, CommentGlyph } from './CommentPrimitives';
import { CommentThreadList } from './CommentThread';

export interface CommentableChatProps {
  messages: PrototypeMessage[];
  comments: Comment[];
  now: number;
  /** Inline threads are used on mobile; desktop routes them to the rail. */
  inlineThreads: boolean;
  openAnchorId: string | null;
  onOpenAnchor: (anchorId: string | null) => void;
  onStartComment: (anchorId: string, quote?: string) => void;
  onReply: (commentId: string, body: string, sendToAgent: boolean) => void;
  onToggleResolved: (commentId: string) => void;
  /** Renders the new-comment composer directly beneath its anchor message. */
  renderComposer: (anchorId: string) => React.ReactNode;
}

export function CommentableChat({
  messages,
  comments,
  now,
  inlineThreads,
  openAnchorId,
  onOpenAnchor,
  onStartComment,
  onReply,
  onToggleResolved,
  renderComposer,
}: CommentableChatProps) {
  return (
    <div className="flex flex-col">
      {messages.map((m) => {
        const mine = commentsForMessage(comments, m.id);
        const unresolved = mine.filter((c) => c.status !== 'resolved');
        const isOpen = openAnchorId === m.id;

        return (
          <div
            key={m.id}
            className="sam-message-entry group relative px-1 pb-1"
            data-comment-anchor={m.id}
            data-testid={`message-${m.id}`}
          >
            {/* A left rule marks a commented message without touching the bubble's
                own styling — works for both left- and right-aligned bubbles. */}
            {mine.length > 0 && (
              <span
                aria-hidden="true"
                className="absolute top-0 bottom-4 left-0 w-0.5 rounded-full"
                style={{
                  backgroundColor:
                    unresolved.length > 0
                      ? 'var(--sam-color-warning-fg, #fbbf24)'
                      : 'var(--sam-color-border-default, #29423b)',
                }}
              />
            )}

            <MessageBubble
              text={m.text}
              role={m.role}
              timestamp={m.timestamp}
              bubbleClassName={m.role === 'user' ? 'glass-msg-user' : 'glass-msg-assistant'}
            />

            {/* Action row. Always visible on touch (no hover), revealed on hover
                for pointer devices so the transcript stays clean. */}
            <div
              className={`-mt-2 mb-3 flex flex-wrap items-center gap-2 ${
                m.role === 'user' ? 'justify-end' : 'justify-start'
              } opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 ${
                mine.length > 0 ? 'md:opacity-100' : ''
              }`}
            >
              {mine.length > 0 && (
                <CommentCountMarker
                  count={mine.length}
                  hasUnresolved={unresolved.length > 0}
                  onClick={() => onOpenAnchor(isOpen ? null : m.id)}
                  label={`${mine.length} comment${mine.length === 1 ? '' : 's'} on this message`}
                />
              )}
              <button
                type="button"
                onClick={() => onStartComment(m.id)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[0.6875rem] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{
                  color: 'var(--sam-color-fg-muted, #9fb7ae)',
                  outlineColor: 'var(--sam-color-focus-ring, #34d399)',
                }}
              >
                <CommentGlyph />
                Comment
              </button>
            </div>

            {/* On mobile the thread expands in place — a right rail does not fit
                at 375px, and a modal would hide the message being discussed. */}
            {inlineThreads && isOpen && mine.length > 0 && (
              <div className="mb-4 flex flex-col gap-3 pl-3">
                <CommentThreadList
                  comments={mine}
                  now={now}
                  onReply={onReply}
                  onToggleResolved={onToggleResolved}
                />
                <div>
                  <Button size="sm" variant="ghost" onClick={() => onOpenAnchor(null)}>
                    Close thread
                  </Button>
                </div>
              </div>
            )}

            {/* New-comment composer renders directly under its anchor, so the
                message being discussed stays on screen while you type. */}
            {renderComposer(m.id)}
          </div>
        );
      })}
    </div>
  );
}
