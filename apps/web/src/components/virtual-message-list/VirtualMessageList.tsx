/**
 * VirtualMessageList — reusable bottom-anchored virtualized list built on
 * @tanstack/react-virtual, shaped as a real drop-in for chat surfaces
 * (ProjectMessageView, WorkspaceChatView).
 *
 * Why TanStack + `anchorTo: 'end'`: react-virtuoso corrects its height
 * estimate in BOTH scroll directions, so scrolling UP through a conversation
 * that mixes fixed-height tool cards with variable-height agent text lurches
 * constantly. TanStack's end-anchor keeps the visible item stable and (via the
 * default `shouldAdjustScrollPositionOnItemSizeChange`) skips scroll correction
 * during backward/upward scroll — which is exactly where the jump was worst.
 *
 * The list is generic over the item type; the consumer supplies `getItemKey`
 * and `renderItem`, so this component carries no chat-specific coupling.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

export interface VirtualMessageListHandle {
  /** Scroll to the newest (last) item. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Scroll a specific data-array index into view (e.g. timeline jump). */
  scrollToIndex: (index: number, opts?: { align?: 'start' | 'center' | 'end'; behavior?: ScrollBehavior }) => void;
  /** True when the viewport is pinned to the bottom. */
  isAtBottom: () => boolean;
}

export interface VirtualMessageListProps<T> {
  items: T[];
  /** Stable, persistent key per item (id — never the index). */
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Best-guess row height; measurement corrects it. Aim slightly high. */
  estimateSize?: number;
  overscan?: number;
  /**
   * Stick to the bottom when new items are appended AND the user is already at
   * the bottom. Maps to TanStack `followOnAppend`. Default 'smooth'.
   */
  followOnAppend?: boolean | ScrollBehavior;
  /** Notified when the at-bottom state changes (drive a scroll-to-bottom button). */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Distance in px from the end still considered "at bottom". */
  atBottomThreshold?: number;
  className?: string;
  style?: React.CSSProperties;
}

function VirtualMessageListInner<T>(
  {
    items,
    getItemKey,
    renderItem,
    estimateSize = 96,
    overscan = 12,
    followOnAppend = 'smooth',
    onAtBottomChange,
    atBottomThreshold = 50,
    className,
    style,
  }: VirtualMessageListProps<T>,
  ref: React.Ref<VirtualMessageListHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastAtBottomRef = useRef<boolean | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (index) => getItemKey(items[index]!, index),
    anchorTo: 'end',
    followOnAppend,
    onChange: (instance) => {
      if (!onAtBottomChange) return;
      const atBottom = instance.isAtEnd(atBottomThreshold);
      if (lastAtBottomRef.current !== atBottom) {
        lastAtBottomRef.current = atBottom;
        onAtBottomChange(atBottom);
      }
    },
  });

  // Pin to the bottom on first mount (chat default). A second pass after the
  // first measurement pass lands corrects for estimate error on tall rows.
  useEffect(() => {
    if (items.length === 0) return;
    virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    const id = requestAnimationFrame(() => virtualizer.scrollToIndex(items.length - 1, { align: 'end' }));
    return () => cancelAnimationFrame(id);
    // Only on mount; append-follow is handled by followOnAppend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior = 'smooth') => virtualizer.scrollToEnd({ behavior }),
      scrollToIndex: (index, opts) =>
        virtualizer.scrollToIndex(index, { align: opts?.align ?? 'center', behavior: opts?.behavior }),
      isAtBottom: () => virtualizer.isAtEnd(atBottomThreshold),
    }),
    [virtualizer, atBottomThreshold],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const measureElement = useCallback((el: HTMLElement | null) => virtualizer.measureElement(el), [virtualizer]);
  const totalSize = virtualizer.getTotalSize();

  const inner = useMemo(
    () => (
      <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map((vi) => {
          const item = items[vi.index]!;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderItem(item, vi.index)}
            </div>
          );
        })}
      </div>
    ),
    [virtualItems, items, totalSize, measureElement, renderItem],
  );

  return (
    <div
      ref={scrollRef}
      className={className}
      style={{ height: '100%', overflowY: 'auto', overflowAnchor: 'none', contain: 'strict', ...style }}
    >
      {inner}
    </div>
  );
}

// forwardRef with a generic requires this cast to preserve the type parameter.
export const VirtualMessageList = forwardRef(VirtualMessageListInner) as <T>(
  props: VirtualMessageListProps<T> & { ref?: React.Ref<VirtualMessageListHandle> },
) => ReturnType<typeof VirtualMessageListInner>;
