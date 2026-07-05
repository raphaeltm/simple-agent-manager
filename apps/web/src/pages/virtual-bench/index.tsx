import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import {
  VirtualMessageList,
  type VirtualMessageListHandle,
} from '../../components/virtual-message-list/VirtualMessageList';
import { generateConversation } from './mock-data';
import { VirtuosoBench } from './VirtuosoBench';

/**
 * Virtualization comparison prototype — PUBLIC, unauthed, throwaway spike route.
 *
 * Renders the SAME conversation (real AcpConversationItemView) through either
 * the current production virtualizer (react-virtuoso) or the candidate reusable
 * TanStack component (VirtualMessageList, anchorTo:'end'). Flip between them
 * with the toggle and scroll each by hand to feel which one jumps.
 *
 * NOT a product surface. Remove this folder + the /__bench route before merge.
 *
 *   /__bench/virtual-scroll            → interactive toggle
 *   /__bench/virtual-scroll?mode=tanstack&count=1500  → forced mode (used by the
 *                                          automated Playwright benchmark)
 */
type Mode = 'virtuoso' | 'tanstack';

const VirtualScrollBench: FC = () => {
  const params = new URLSearchParams(window.location.search);
  const initialMode: Mode = params.get('mode') === 'tanstack' ? 'tanstack' : 'virtuoso';
  const count = Math.max(1, Math.min(8000, Number(params.get('count') ?? '1500') || 1500));

  const [mode, setMode] = useState<Mode>(initialMode);
  const [atBottom, setAtBottom] = useState(true);
  const tanstackRef = useRef<VirtualMessageListHandle>(null);

  const items = useMemo(() => generateConversation(count), [count]);

  // Shared renderer → both virtualizers render byte-identical content. The
  // data-bench-* attributes let the Playwright measurement locate rows.
  const renderItem = useCallback(
    (item: ConversationItem) => (
      <div className="sam-message-entry px-4 pb-3" data-bench-row data-item-id={item.id}>
        <AcpConversationItemView item={item} />
      </div>
    ),
    [],
  );

  useEffect(() => {
    const id = window.setTimeout(() => {
      (window as unknown as Record<string, unknown>).__benchReady = true;
      (window as unknown as Record<string, unknown>).__benchInfo = { mode, count };
    }, 300);
    return () => window.clearTimeout(id);
  }, [mode, count]);

  const btn = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      style={{
        padding: '6px 14px',
        fontSize: 13,
        fontWeight: 600,
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--sam-color-border-default, #444)',
        background: mode === m ? 'var(--sam-color-accent, #6366f1)' : 'transparent',
        color: mode === m ? '#fff' : 'var(--sam-color-fg-primary, #ddd)',
      }}
      data-bench-toggle={m}
    >
      {label}
    </button>
  );

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--sam-color-border-default, #333)',
        }}
        data-bench-header
      >
        {btn('virtuoso', 'Current (Virtuoso)')}
        {btn('tanstack', 'TanStack')}
        <span style={{ fontSize: 12, fontFamily: 'monospace', opacity: 0.7, marginLeft: 'auto' }}>
          {count} msgs · scroll up to compare jump
        </span>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        {mode === 'tanstack' ? (
          <VirtualMessageList<ConversationItem>
            ref={tanstackRef}
            items={items}
            getItemKey={(item) => item.id}
            renderItem={renderItem}
            estimateSize={96}
            onAtBottomChange={setAtBottom}
          />
        ) : (
          <VirtuosoBench items={items} renderItem={renderItem} />
        )}

        {/* Scroll-to-bottom button — demonstrates the reusable at-bottom callback. */}
        {mode === 'tanstack' && !atBottom && (
          <button
            type="button"
            onClick={() => tanstackRef.current?.scrollToBottom()}
            style={{
              position: 'absolute',
              right: 16,
              bottom: 16,
              width: 44,
              height: 44,
              borderRadius: '50%',
              cursor: 'pointer',
              border: '1px solid var(--sam-color-border-default, #444)',
              background: 'var(--sam-color-surface-raised, #222)',
              color: 'var(--sam-color-fg-primary, #ddd)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        )}
      </div>
    </div>
  );
};

export default VirtualScrollBench;
