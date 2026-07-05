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
  const [simLive, setSimLive] = useState(params.get('live') === '1');
  const [simChurn, setSimChurn] = useState(params.get('churn') === '1');
  const [simAppend, setSimAppend] = useState(params.get('append') === '1');
  const [, forceTick] = useState(0);
  const [churnVersion, setChurnVersion] = useState(0);
  const [appendCount, setAppendCount] = useState(0);
  const tanstackRef = useRef<VirtualMessageListHandle>(null);

  const baseItems = useMemo(() => generateConversation(count), [count]);
  // Reproduce production's data plumbing: `chatMessagesToConversationItems`
  // rebuilds ALL conversation-item objects (new identities) whenever `messages`
  // changes (WebSocket append, poll/catch-up mergeReplace). When simChurn is on
  // we hand the virtualizer a NEW array of NEW objects (same content) every
  // 1.5s — mimicking that rebuild while the user scrolls.
  //
  // simAppend reproduces a LIVE session: new messages are appended over time,
  // which is what triggers virtuoso `followOutput` / tanstack `followOnAppend`
  // to auto-scroll toward the bottom (the "yank" while you scroll up to read).
  const items = useMemo(() => {
    let out = simChurn ? baseItems.map((it) => ({ ...it })) : baseItems;
    if (simAppend && appendCount > 0) {
      const extra = generateConversation(appendCount, 9001).map((it, i) => ({
        ...it,
        id: `appended-${i}`,
      }));
      out = [...out, ...extra];
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseItems, simChurn, churnVersion, simAppend, appendCount]);

  // Reproduce production's 1 Hz re-render (the idle-countdown timer in
  // useConnectionRecovery ticks setIdleCountdownMs every second, re-rendering
  // the whole message view even when NO data changed).
  useEffect(() => {
    if (!simLive) return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [simLive]);

  useEffect(() => {
    if (!simChurn) return;
    const id = window.setInterval(() => setChurnVersion((v) => v + 1), 1500);
    return () => window.clearInterval(id);
  }, [simChurn]);

  useEffect(() => {
    if (!simAppend) return;
    const id = window.setInterval(() => setAppendCount((c) => c + 1), 1000);
    return () => window.clearInterval(id);
  }, [simAppend]);

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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginLeft: 12 }}
          title="Reproduce production: re-render once per second + inline Header (like the idle-countdown timer)"
        >
          <input type="checkbox" checked={simLive} onChange={(e) => setSimLive(e.target.checked)} data-bench-live />
          re-render (1 Hz)
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
          title="Reproduce data plumbing: rebuild the items array with new object identities every 1.5s (like conversationItems rebuilding on each message update)"
        >
          <input type="checkbox" checked={simChurn} onChange={(e) => setSimChurn(e.target.checked)} data-bench-churn />
          data churn (1.5s)
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
          title="Reproduce a live session: append a new message every 1s (triggers followOutput/followOnAppend auto-scroll)"
        >
          <input type="checkbox" checked={simAppend} onChange={(e) => setSimAppend(e.target.checked)} data-bench-append />
          append msgs (1s)
        </label>
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
          <VirtuosoBench items={items} renderItem={renderItem} simulateLive={simLive} />
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
