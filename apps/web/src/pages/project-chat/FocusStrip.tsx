import { Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { ATTENTION_ICON, getAttentionState } from '../../lib/chat-session-utils';
import { SessionTreeItem } from './SessionTreeItem';
import type { TaskInfo } from './useTaskGroups';

/**
 * Focus Mode session strip — the 64px collapsed form of the project-chat
 * session sidebar.
 *
 * Each session is reduced to its attention-state status icon (shared
 * `ATTENTION_ICON` map). Hovering or focusing an icon peeks the real session
 * card (`SessionTreeItem`) in a tooltip.
 *
 * The tooltip is rendered through `createPortal(..., document.body)` with fixed
 * coordinates derived from the icon's `getBoundingClientRect()`. This is
 * REQUIRED: the sidebar's glass ancestors (`glass-panel-container` =>
 * `contain: paint`, `glass-composited` => `transform`) create paint/stacking
 * contexts that clip and mis-stack a normally-positioned absolute tooltip.
 * Parenting to `<body>` escapes both.
 *
 * A short close delay bridges the gap between the icon and the tooltip so
 * moving the pointer across it does not flicker the tooltip closed.
 */

const CLOSE_DELAY_MS = 140;

function enrichSession(
  session: ChatSessionListItem,
  taskInfoMap: Map<string, TaskInfo>,
): ChatSessionResponse {
  const taskInfo = session.taskId ? taskInfoMap.get(session.taskId) : undefined;
  if (!taskInfo) return session;
  return {
    ...session,
    task: { id: taskInfo.id, status: taskInfo.status, taskMode: taskInfo.taskMode },
  };
}

interface TooltipState {
  session: ChatSessionListItem;
  top: number;
  left: number;
}

export function FocusStrip({
  sessions,
  selectedSessionId,
  onSelect,
  onFork,
  taskInfoMap,
  onShowHierarchy,
  onNewChat,
}: {
  sessions: ChatSessionListItem[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  taskInfoMap: Map<string, TaskInfo>;
  onShowHierarchy?: (taskId: string) => void;
  onNewChat: () => void;
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setTooltip(null), CLOSE_DELAY_MS);
  }, [cancelClose]);

  const openTooltip = useCallback(
    (session: ChatSessionListItem, el: HTMLElement) => {
      cancelClose();
      const rect = el.getBoundingClientRect();
      setTooltip({ session, top: rect.top, left: rect.right + 6 });
    },
    [cancelClose],
  );

  return (
    <>
      <div className="flex flex-col items-center gap-1 py-2 h-full">
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="shrink-0 flex h-9 w-9 items-center justify-center rounded-md border border-[rgba(34,197,94,0.15)] bg-transparent text-fg-primary cursor-pointer hover:bg-[rgba(34,197,94,0.06)] hover:border-[rgba(34,197,94,0.25)] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)]"
        >
          <Plus size={16} />
        </button>

        <nav
          aria-label="Chat sessions"
          className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden flex flex-col items-center gap-0.5 pt-1"
        >
          {sessions.map((session) => {
            const enriched = enrichSession(session, taskInfoMap);
            const attention = getAttentionState(enriched);
            const config = ATTENTION_ICON[attention];
            const StatusIcon = config.icon;
            const isSelected = selectedSessionId === session.id;
            const label = session.topic
              ? session.topic
              : `Chat ${session.id.slice(0, 8)}`;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                onMouseEnter={(e) => openTooltip(session, e.currentTarget)}
                onMouseLeave={scheduleClose}
                onFocus={(e) => openTooltip(session, e.currentTarget)}
                onBlur={scheduleClose}
                aria-label={`${label} — ${config.label}`}
                aria-describedby="focus-strip-tooltip"
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-transparent cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)] ${
                  isSelected
                    ? 'border-[var(--sam-color-accent-primary)] bg-[rgba(22,163,74,0.08)]'
                    : 'border-transparent hover:bg-[rgba(34,197,94,0.06)]'
                }`}
                style={{ color: config.color }}
              >
                <StatusIcon
                  size={15}
                  className={attention === 'active' ? 'motion-safe:animate-spin' : ''}
                />
              </button>
            );
          })}
        </nav>
      </div>

      {tooltip &&
        createPortal(
          <div
            id="focus-strip-tooltip"
            data-testid="focus-tooltip"
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            className="fixed z-[60] w-72 max-h-[80vh] overflow-y-auto rounded-md glass-chrome glass-panel-container shadow-2xl"
            style={{ top: tooltip.top, left: tooltip.left }}
          >
            <SessionTreeItem
              session={tooltip.session}
              selectedSessionId={selectedSessionId}
              onSelect={onSelect}
              onFork={onFork}
              taskInfoMap={taskInfoMap}
              onShowHierarchy={onShowHierarchy}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
