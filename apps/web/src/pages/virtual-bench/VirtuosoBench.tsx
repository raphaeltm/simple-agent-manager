import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { type ReactNode, type FC, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

/**
 * Virtuoso bench — mirrors the PRODUCTION ProjectMessageView config as closely
 * as possible (alignToBottom, followOutput, initialTopMostItemIndex,
 * firstItemIndex, overscan, a Header spacer). Shares `renderItem` with the
 * TanStack side so both render byte-identical content.
 *
 * `simulateLive` reproduces the production re-render churn that makes an
 * otherwise-static list jump: production passes a BRAND-NEW inline
 * `components={{ Header: () => (...) }}` component type on every render, so when
 * the parent re-renders (e.g. the 1 Hz idle-countdown timer) Virtuoso remounts
 * the header subtree and the list offset shifts. When simulateLive is off we
 * pass a STABLE components object (no remount) — toggle it to feel smooth ↔
 * jumpy with identical data.
 */
const VIRTUAL_START = 100_000;

const Header: FC = () => <div style={{ height: 56 }} data-sim-header />;

export const VirtuosoBench: FC<{
  items: ConversationItem[];
  renderItem: (item: ConversationItem, index: number) => ReactNode;
  simulateLive?: boolean;
}> = ({ items, renderItem, simulateLive }) => {
  const ref = useRef<VirtuosoHandle>(null);
  // Stable across renders — the idle/default path never remounts the header.
  const stableComponents = useRef({ Header }).current;

  // simulateLive → a NEW object + NEW component type each render, exactly like
  // production's inline `components={{ Header: () => (...) }}`.
  const components = simulateLive
    ? { Header: () => <div style={{ height: 56 }} data-sim-header /> }
    : stableComponents;

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
      components={components}
      scrollerRef={(el) => {
        if (el instanceof HTMLElement) el.setAttribute('data-bench-scroller', 'virtuoso');
      }}
      itemContent={(index, item) => renderItem(item, index)}
    />
  );
};
