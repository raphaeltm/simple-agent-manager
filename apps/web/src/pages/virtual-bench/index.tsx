import { type FC, useEffect, useMemo } from 'react';

import { generateConversation } from './mock-data';
import { TanstackBench } from './TanstackBench';
import { VirtuosoBench } from './VirtuosoBench';

/**
 * Virtualization benchmark harness — PUBLIC, unauthed, throwaway spike route.
 *
 * Renders the REAL AcpConversationItemView inside either react-virtuoso (the
 * current production virtualizer) or @tanstack/react-virtual, with a seeded
 * stress dataset of collapsed tool cards + variable-height agent text. A
 * Playwright script drives scripted scrolling and measures involuntary content
 * displacement ("jumping") and FPS for each mode.
 *
 * NOT a product surface. Must be removed before any merge to main.
 *
 *   /__bench/virtual-scroll?mode=virtuoso|tanstack&count=1500
 */
const VirtualScrollBench: FC = () => {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') === 'tanstack' ? 'tanstack' : 'virtuoso';
  const count = Math.max(1, Math.min(6000, Number(params.get('count') ?? '1500') || 1500));

  const items = useMemo(() => generateConversation(count), [count]);

  useEffect(() => {
    // Signal to Playwright that content is mounted. The measurement script
    // additionally waits for rows + a settled scroll position.
    const id = window.setTimeout(() => {
      (window as unknown as Record<string, unknown>).__benchReady = true;
      (window as unknown as Record<string, unknown>).__benchInfo = { mode, count };
    }, 300);
    return () => window.clearTimeout(id);
  }, [mode, count]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flex: '0 0 auto',
          padding: '6px 12px',
          fontSize: 12,
          fontFamily: 'monospace',
          borderBottom: '1px solid var(--sam-color-border-default, #333)',
        }}
        data-bench-header
      >
        virtual-scroll bench · mode=<b>{mode}</b> · items={count}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {mode === 'tanstack' ? <TanstackBench items={items} /> : <VirtuosoBench items={items} />}
      </div>
    </div>
  );
};

export default VirtualScrollBench;
