/**
 * EXPERIMENTAL — TanStack Virtual message list adapter.
 *
 * Spike replacement for react-virtuoso in ProjectMessageView, evaluating
 * whether @tanstack/react-virtual's chat primitives (anchorTo: 'end',
 * followOnAppend, isAtEnd, scrollToEnd, key-stable measurement cache)
 * produce more stable scrolling with dynamic-height tool-call cards.
 *
 * Enabled via `?virtualizer=tanstack` or localStorage `sam:virtualizer`.
 * Not a production surface — see task sam/use-sam-mcp-tools-01kwpv.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { Button } from '@simple-agent-manager/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';

export interface MessageListHandle {
  /** Scroll to a 0-based data index (timeline jump). */
  scrollToItem: (index: number, opts?: { behavior?: ScrollBehavior; align?: 'start' | 'center' | 'end' }) => void;
  /** Scroll to the very bottom of the conversation. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

interface TanStackMessageListProps {
  items: ConversationItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onAtBottomChange: (atBottom: boolean) => void;
  renderItem: (item: ConversationItem, index: number) => ReactNode;
}

const AT_BOTTOM_THRESHOLD_PX = 50;
const ESTIMATED_ITEM_HEIGHT_PX = 96;

export const TanStackMessageList = forwardRef<MessageListHandle, TanStackMessageListProps>(
  function TanStackMessageList({ items, hasMore, loadingMore, onLoadMore, onAtBottomChange, renderItem }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    // Prepend anchor: first visible row's key + viewport top, captured at
    // load-more click time. TanStack's own end-anchor compensation is computed
    // against ESTIMATED sizes for the unmounted prepended items, leaving a
    // residual drift of hundreds of px. We correct it with real DOM rects.
    const pendingAnchor = useRef<{ key: string; top: number } | null>(null);

    const virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ESTIMATED_ITEM_HEIGHT_PX,
      overscan: 6,
      // Stable keys: measurement cache survives prepend (load-earlier) index shifts.
      getItemKey: (index) => items[index]?.id ?? index,
      // Chat mode: offsets anchor to the end of the list, so prepended history
      // and above-viewport resizes don't shift the visible window.
      anchorTo: 'end',
      // Follow new messages when pinned to the bottom.
      followOnAppend: 'smooth',
      scrollEndThreshold: AT_BOTTOM_THRESHOLD_PX,
      onChange: (instance) => {
        const atBottom = instance.isAtEnd(AT_BOTTOM_THRESHOLD_PX);
        if (atBottom !== atBottomRef.current) {
          atBottomRef.current = atBottom;
          onAtBottomChange(atBottom);
        }
      },
      // Header ("load earlier" + spacer) lives in normal flow above the items.
      scrollMargin: headerRef.current?.offsetHeight ?? 0,
    });

    // Start pinned to the bottom on first mount (initial conversation load).
    const didInitialScroll = useRef(false);
    useLayoutEffect(() => {
      if (didInitialScroll.current || items.length === 0) return;
      didInitialScroll.current = true;
      virtualizer.scrollToEnd();
    }, [items.length, virtualizer]);

    // Capture the anchor row before requesting earlier messages.
    const handleLoadMore = useCallback(() => {
      const el = scrollRef.current;
      if (el) {
        const rows = el.querySelectorAll<HTMLElement>('[data-key]');
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom > el.getBoundingClientRect().top && row.dataset.key) {
            pendingAnchor.current = { key: row.dataset.key, top: rect.top };
            break;
          }
        }
      }
      onLoadMore();
    }, [onLoadMore]);

    // After the prepend commits, re-measure the anchored row and correct the
    // residual scroll drift before paint. The library's own compensation uses
    // ESTIMATED sizes for unmounted prepended items; the real sizes arrive
    // post-paint via ResizeObserver and shift content again — so keep
    // correcting through a short settle window until the layout stabilizes.
    useLayoutEffect(() => {
      const pending = pendingAnchor.current;
      if (!pending) return;
      const el = scrollRef.current;
      if (!el) return;
      const correct = (): boolean => {
        const node = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(pending.key)}"]`);
        if (!node) return false;
        const shift = node.getBoundingClientRect().top - pending.top;
        if (shift !== 0) el.scrollTop += shift;
        return true;
      };
      // If the node isn't mounted yet (still loading), keep the anchor armed.
      if (!correct()) return;
      pendingAnchor.current = null;
      let frames = 0;
      let stable = 0;
      const settle = () => {
        const node = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(pending.key)}"]`);
        if (!node) return;
        const shift = node.getBoundingClientRect().top - pending.top;
        if (Math.abs(shift) > 0.5) {
          el.scrollTop += shift;
          stable = 0;
        } else {
          stable += 1;
        }
        // Stop once stable for a few frames, or after ~0.5s.
        if (stable < 5 && ++frames < 30) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    }, [items]);

    const scrollToItem = useCallback<MessageListHandle['scrollToItem']>((index, opts) => {
      virtualizer.scrollToIndex(index, { align: opts?.align ?? 'center', behavior: opts?.behavior ?? 'smooth' });
    }, [virtualizer]);

    const scrollToBottom = useCallback<MessageListHandle['scrollToBottom']>((behavior = 'smooth') => {
      virtualizer.scrollToEnd({ behavior });
    }, [virtualizer]);

    useImperativeHandle(ref, () => ({ scrollToItem, scrollToBottom }), [scrollToItem, scrollToBottom]);

    const virtualItems = virtualizer.getVirtualItems();

    return (
      <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }} data-virtualizer="tanstack">
        <div ref={headerRef}>
          {/* Spacer for absolutely-positioned FloatingHeader */}
          <div className="h-14" />
          {/* Constant-height slot: unmounting the button after load would
              shrink the header and leave `scrollMargin` stale for one render,
              corrupting the prepend scroll-anchor math. */}
          <div className="text-center py-3" style={{ visibility: hasMore ? 'visible' : 'hidden' }}>
            <Button variant="ghost" size="sm" onClick={handleLoadMore} loading={loadingMore}>
              Load earlier messages
            </Button>
          </div>
        </div>
        <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                data-key={String(vi.key)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                {renderItem(item, vi.index)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
