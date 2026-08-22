import { Button } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

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

/** Stable `components` object — see `ChatListHeader` for why this must not be inline. */
export const CHAT_LIST_COMPONENTS = { Header: ChatListHeader };

/**
 * Measures the floating header's rendered height so the message list can pad
 * itself by the real value. The header stack (title wrapping to two lines,
 * status badges, error banner, output summary) varies from ~56px to several
 * hundred px — a fixed spacer leaves messages hidden behind the glass.
 */
export function useFloatingHeaderHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(56);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setHeight((prev) => {
        const next = Math.ceil(el.getBoundingClientRect().height);
        return next > 0 && next !== prev ? next : prev;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, height];
}
