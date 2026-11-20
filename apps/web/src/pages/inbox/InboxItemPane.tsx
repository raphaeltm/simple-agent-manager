import type { InboxItem, InboxReplyResponse } from '@simple-agent-manager/shared';
import { IconButton } from '@simple-agent-manager/ui';
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';

import { useInboxPermissionDetail } from '../../components/inbox/inbox-actions';
import { hasAnswerControls, stackPosition } from '../../components/inbox/inbox-model';
import {
  InboxAnswerControls,
  InboxPermissionSummary,
} from '../../components/inbox/InboxAnswerControls';
import { InboxConversationThread } from '../../components/inbox/InboxConversation';
import { InboxReceiptRegion } from '../../components/inbox/InboxItemView';
import {
  InboxReplyComposer,
  replyDeclinesPermission,
} from '../../components/inbox/InboxReplyComposer';
import type { useInboxWalk } from '../../components/inbox/useInboxWalk';
import { useQueryScope } from '../../hooks/useQueryScope';
import { projectChatPath } from '../../lib/project-routes';

export type InboxWalk = ReturnType<typeof useInboxWalk>;

/** Focus the list row that holds `ref` (the row of its stack), after Back on a phone. */
function focusRow(ref: string) {
  requestAnimationFrame(() => {
    const rows = document.querySelectorAll<HTMLElement>('[data-inbox-refs]');
    for (const row of rows) {
      if ((row.dataset.inboxRefs ?? '').split(' ').includes(ref)) {
        row.focus();
        return;
      }
    }
  });
}

/** What the receipt says once a reply is accepted. */
export function replyReceipt(item: InboxItem): string {
  return replyDeclinesPermission(item)
    ? 'Declined and sent to the agent’s chat. This comes back if it responds.'
    : 'Sent to the agent’s chat. This comes back if it responds.';
}

/**
 * The open item: top bar, receipt, the item as a conversation (the ask, replies, responses, with
 * the answer controls on the agent's newest turn) and the chat composer pinned at the bottom.
 */
export function InboxItemPane({
  walk,
  item,
  now,
  focusOnMount,
  onBackToOverview,
}: {
  walk: InboxWalk;
  item: InboxItem;
  now: number;
  /** An item opened by the person (not desktop's default first item) takes focus at once. */
  focusOnMount: boolean;
  /** Set when the item was opened from the Overview: Back returns there, on both sizes. */
  onBackToOverview: (() => void) | null;
}) {
  const navigate = useNavigate();
  const viewerId = useQueryScope();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  // Opening, stepping and the advance after an answer all land focus on the new item's title,
  // so a keyboard or screen reader user is never left on a button that just unmounted.
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (first && !focusOnMount) return;
    headingRef.current?.focus();
  }, [item.ref, focusOnMount]);
  const permission = useInboxPermissionDetail(item);
  const index = walk.order.findIndex((candidate) => candidate.ref === item.ref);
  const position = stackPosition(walk.order, item);
  const prev = index > 0 ? walk.order[index - 1] : undefined;
  const next = index >= 0 ? walk.order[index + 1] : undefined;
  const { onAnswered, onReplied, onStale } = walk;
  const handlers = useMemo(
    () => ({
      onAnswered: (text: string) => onAnswered(item.ref, text),
      onStale: () => onStale(item.ref),
    }),
    [item.ref, onAnswered, onStale]
  );
  const handleReplied = useCallback(
    (_response: InboxReplyResponse) => onReplied(item.ref, replyReceipt(item)),
    [item, onReplied]
  );
  const handleGone = useCallback(() => onStale(item.ref), [item.ref, onStale]);
  const detail = walk.detail.data?.item.ref === item.ref ? walk.detail.data : null;
  const canArchive = item.status === 'open' && item.canAct;
  // The freshest read wins: a reply sent from the list's copy must not wait for the list.
  const canReply = (detail?.item.canReply ?? item.canReply) === true;
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--sam-hairline)] px-1 py-1">
        {onBackToOverview ? (
          // Desktop has the header's "Back to Overview" beside the list; one control per screen.
          <IconButton
            label="Back to Overview"
            icon={<ArrowLeft size={20} />}
            onClick={onBackToOverview}
            showTooltip={false}
            className="md:hidden"
          />
        ) : (
          <IconButton
            label="Back to inbox"
            icon={<ArrowLeft size={20} />}
            onClick={() => {
              walk.close();
              focusRow(item.ref);
            }}
            showTooltip={false}
            className="md:hidden"
          />
        )}
        <span className="flex flex-1 items-center justify-center md:justify-start">
          <IconButton
            label="Previous item"
            icon={<ChevronLeft size={20} />}
            disabled={!prev}
            onClick={() => prev && walk.step(prev)}
            showTooltip={false}
          />
          {!position && index >= 0 && (
            <span
              className="font-mono text-xs text-fg-muted"
              aria-label={`Item ${index + 1} of ${walk.order.length}`}
            >
              {index + 1}/{walk.order.length}
            </span>
          )}
          <IconButton
            label="Next item"
            icon={<ChevronRight size={20} />}
            disabled={!next}
            onClick={() => next && walk.step(next)}
            showTooltip={false}
          />
        </span>
        {canArchive && (
          <IconButton
            label="Archive: close it"
            icon={<Archive size={18} />}
            onClick={() => walk.archiveItem(item)}
            showTooltip={false}
          />
        )}
        {item.sessionId && (
          <IconButton
            label="Open chat"
            icon={<MessageSquare size={18} />}
            onClick={() =>
              item.sessionId && navigate(projectChatPath(item.projectId, item.sessionId))
            }
            showTooltip={false}
          />
        )}
      </div>
      <InboxReceiptRegion receipt={walk.receipt} />
      <div className="relative min-h-0 flex-1 overflow-y-auto" data-testid="inbox-item-scroll">
        <h1 className="sr-only md:hidden">Inbox</h1>
        <div className="mx-auto flex w-full max-w-[680px] min-w-0 flex-col px-4 py-4">
          <InboxConversationThread
            // Per item: "show more" and its pages belong to one conversation.
            key={item.ref}
            item={item}
            context={detail?.context ?? null}
            conversation={detail?.conversation ?? null}
            now={now}
            viewerId={viewerId}
            stackPosition={position}
            headingRef={headingRef}
            detail={
              item.answerSpec.type === 'interaction' ? (
                <InboxPermissionSummary detail={permission.detail} />
              ) : undefined
            }
            controls={
              hasAnswerControls(item) ? (
                <InboxAnswerControls item={item} permission={permission} handlers={handlers} />
              ) : null
            }
          />
        </div>
      </div>
      {canReply && (
        <div
          className="shrink-0 border-t border-[var(--sam-hairline)] px-3 py-3 md:px-4"
          data-testid="inbox-reply-area"
        >
          <div className="mx-auto w-full max-w-[680px] min-w-0">
            <InboxReplyComposer
              // A half-written reply belongs to its item; stepping starts a fresh one.
              key={item.ref}
              item={item}
              onSent={handleReplied}
              onGone={handleGone}
            />
          </div>
        </div>
      )}
    </>
  );
}
