import { Button } from '@simple-agent-manager/ui';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Data the virtualized list's Header needs, threaded through Virtuoso's `context`
 * prop rather than captured in a closure.
 *
 * This exists so `ChatListHeader` can be a module-scope component with a STABLE
 * identity. `components={{ Header: () => ... }}` written inline creates a brand
 * new component *type* on every parent render, and React unmounts + remounts a
 * subtree whose type changed — so the spacer and the "Load earlier messages"
 * button were being torn down and rebuilt on every render, which during
 * streaming means every single token. Passing the varying values through
 * `context` keeps the type constant and turns those remounts into plain prop
 * updates.
 */
export interface ChatListContext {
  headerSpacerHeight: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  footer: ReactNode;
}

function ChatListFooter({ context }: { context?: ChatListContext }) {
  return context?.footer ?? null;
}

function ChatListHeader({ context }: { context?: ChatListContext }) {
  if (!context) return null;
  return (
    <>
      <div style={{ height: context.headerSpacerHeight }} />
      {context.hasMore && (
        <div className="text-center py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={context.onLoadMore}
            loading={context.loadingMore}
          >
            Load earlier messages
          </Button>
        </div>
      )}
    </>
  );
}

const ChatListScroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  (props, ref) => <div {...props} ref={ref} data-sam-conversation-scroller="true" />
);
ChatListScroller.displayName = 'ChatListScroller';

/** Stable `components` object — see `ChatListHeader` for why this must not be inline. */
export const CHAT_LIST_COMPONENTS = {
  Header: ChatListHeader,
  Footer: ChatListFooter,
  Scroller: ChatListScroller,
};
