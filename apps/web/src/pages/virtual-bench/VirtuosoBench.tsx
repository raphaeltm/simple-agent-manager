import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { type ReactNode, type FC, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

/**
 * Virtuoso bench — mirrors the PRODUCTION ProjectMessageView config as closely
 * as possible (alignToBottom, followOutput, initialTopMostItemIndex,
 * firstItemIndex, overscan) so the comparison measures the real component's
 * behavior, not a strawman. Shares `renderItem` with the TanStack side so both
 * render byte-identical content.
 */
const VIRTUAL_START = 100_000;

export const VirtuosoBench: FC<{
  items: ConversationItem[];
  renderItem: (item: ConversationItem, index: number) => ReactNode;
}> = ({ items, renderItem }) => {
  const ref = useRef<VirtuosoHandle>(null);

  return (
    <Virtuoso
      ref={ref}
      style={{ height: '100%' }}
      data={items}
      firstItemIndex={VIRTUAL_START}
      initialTopMostItemIndex={items.length - 1}
      followOutput={(isAtBottom: boolean) => (isAtBottom ? 'smooth' : false)}
      alignToBottom
      atBottomThreshold={50}
      overscan={200}
      scrollerRef={(el) => {
        if (el instanceof HTMLElement) el.setAttribute('data-bench-scroller', 'virtuoso');
      }}
      itemContent={(index, item) => renderItem(item, index)}
    />
  );
};
