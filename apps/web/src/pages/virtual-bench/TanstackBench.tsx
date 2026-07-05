import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type FC, useEffect, useRef } from 'react';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';

/**
 * TanStack bench — best-practice dynamic-height, bottom-anchored config:
 *   - dynamic measurement via `measureElement` (ResizeObserver) + `data-index`
 *   - stable `getItemKey` (persistent item id, not index)
 *   - `anchorTo: 'end'` for chat/reverse feeds — keeps the visible item stable
 *     and (via the default `shouldAdjustScrollPositionOnItemSizeChange`) SKIPS
 *     scroll correction during BACKWARD (upward) scroll, which is exactly when
 *     Virtuoso's estimate-then-correct model produces the jump.
 *   - generous `overscan` to reduce blank-fill churn during fast scroll.
 */
export const TanstackBench: FC<{ items: ConversationItem[] }> = ({ items }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 90,
    overscan: 12,
    getItemKey: (index) => items[index]!.id,
    anchorTo: 'end',
  });

  // Start pinned to the bottom (chat default).
  useEffect(() => {
    virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    // Second pass after initial measurement settles.
    const id = requestAnimationFrame(() => virtualizer.scrollToIndex(items.length - 1, { align: 'end' }));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      data-bench-scroller="tanstack"
      style={{ height: '100%', overflowY: 'auto', contain: 'strict' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualItems.map((vi) => {
          const item = items[vi.index]!;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              data-bench-row
              data-item-id={item.id}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <div className="sam-message-entry px-4 pb-3">
                <AcpConversationItemView item={item} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
