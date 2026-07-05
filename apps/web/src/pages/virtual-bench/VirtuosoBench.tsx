import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { type FC, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';

/**
 * Virtuoso bench — mirrors the PRODUCTION ProjectMessageView config as closely
 * as possible (alignToBottom, followOutput, initialTopMostItemIndex,
 * firstItemIndex, overscan) so the benchmark measures the real component's
 * behavior, not a strawman.
 */
const VIRTUAL_START = 100_000;

export const VirtuosoBench: FC<{ items: ConversationItem[] }> = ({ items }) => {
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
      itemContent={(_index, item) => (
        <div className="sam-message-entry px-4 pb-3" data-bench-row data-item-id={item.id}>
          <AcpConversationItemView item={item} />
        </div>
      )}
    />
  );
};
