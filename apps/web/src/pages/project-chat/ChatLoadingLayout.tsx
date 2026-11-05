import { Pane } from '@simple-agent-manager/ui';

import { useAppShell } from '../../components/AppShell';
import { LoadingPane } from '../../components/LoadingPane';
import { useIsMobile } from '../../hooks/useIsMobile';
import { sessionWidthForMode } from '../../lib/focus-mode';

/**
 * The project chat's loading state before its page can render: the project detail, the
 * chat route chunk, or (on the bare chat route) the session list is still on its way.
 *
 * It lays out the same two columns `ProjectChat` does — an empty chats pane at the
 * sidebar's width for the current focus mode, then the conversation column — so the
 * spinner sits where the conversation's own loading spinner will be, and where the
 * conversation itself will appear. Keep the geometry in step with `ProjectChat`.
 */
export function ChatLoadingLayout({ testId }: Readonly<{ testId: string }>) {
  const isMobile = useIsMobile();
  const { focusMode } = useAppShell();
  return (
    <div className="flex min-h-0 flex-1 gap-[var(--sam-space-gutter)]">
      {!isMobile &&
        (focusMode === 'zen' ? (
          // Zen collapses the chats sidebar to a zero-width seam, as `ZenPeekRail` does.
          <div style={{ width: 0 }} />
        ) : (
          <Pane
            as="aside"
            aria-hidden="true"
            style={{ width: sessionWidthForMode(focusMode) }}
            className="shrink-0"
          />
        ))}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <LoadingPane testId={testId} />
      </div>
    </div>
  );
}
