/**
 * Faithful stand-in for the mobile project chat, so each variant's panel opens
 * over something realistic.
 *
 * The tool rail is the REAL `SessionToolRail`, fed by the REAL
 * `buildSessionToolActions`, so the rail's widths, grouping, pinned footer and
 * mode cycling behave exactly as they do in production.
 */
import { ArrowUp } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  buildSessionToolActions,
  DEFAULT_TOOL_STRIP_MODE,
  type SessionToolId,
  type ToolStripMode,
} from '../../components/project-message-view/session-tool-actions';
import { SessionToolRail } from '../../components/project-message-view/SessionToolRail';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { ChatSessionResponse } from '../../lib/api/sessions';
import { MOCK_MESSAGES, MOCK_SESSION_TITLE } from './mock-data';

const MOCK_SESSION: ChatSessionResponse = {
  id: 'proto-session',
  workspaceId: 'proto-workspace',
  taskId: 'proto-task',
  isMine: true,
  topic: MOCK_SESSION_TITLE,
  status: 'active',
  messageCount: MOCK_MESSAGES.length,
  startedAt: Date.now() - 3_600_000,
  endedAt: null,
  createdAt: Date.now() - 3_600_000,
  isIdle: false,
  task: { id: 'proto-task', status: 'in_progress', taskMode: 'conversation' },
};

function MessageBubble({ role, body }: Readonly<{ role: 'user' | 'assistant'; body: string }>) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words ${
          mine
            ? 'bg-accent/15 text-fg-primary rounded-br-md'
            : 'bg-surface text-fg-primary rounded-bl-md border border-border-default'
        }`}
      >
        {body}
      </div>
    </div>
  );
}

export function ChatBackdrop({ onOpenResources }: Readonly<{ onOpenResources: () => void }>) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<ToolStripMode>(DEFAULT_TOOL_STRIP_MODE);

  const actions = useMemo(
    () =>
      buildSessionToolActions({
        session: MOCK_SESSION,
        sessionState: 'active',
        taskEmbed: MOCK_SESSION.task ?? null,
        reportEnabled: true,
        unresolvedCommentCount: 3,
        needsAttentionCommentCount: 1,
        hasFilesHandler: true,
        hasGitHandler: true,
        hasTimelineHandler: true,
        hasResourcesHandler: true,
        hasEventsHandler: true,
        hasCommentsHandler: true,
        hasRetryHandler: true,
        hasForkHandler: true,
      }),
    []
  );

  const handleSelect = (id: SessionToolId) => {
    // Only Resources is wired: the rest exist so the rail looks like production.
    if (id === 'resources') onOpenResources();
  };

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="glass-chrome absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg-primary">
            {MOCK_SESSION_TITLE}
          </h1>
          <span className="shrink-0 rounded-full bg-success-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success-fg">
            Active
          </span>
        </header>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-24 pt-14">
          {MOCK_MESSAGES.map((message) => (
            <MessageBubble key={message.id} role={message.role} body={message.body} />
          ))}
        </div>

        <div
          className="glass-chrome absolute inset-x-0 bottom-0 z-10 flex items-end gap-2 px-3 pt-2"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
        >
          <div className="min-h-11 flex-1 rounded-xl border border-border-default bg-surface px-3 py-2.5 text-sm text-fg-muted">
            Message the agent…
          </div>
          <button
            type="button"
            aria-label="Send message"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border-none bg-accent text-fg-on-accent"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <SessionToolRail
        actions={actions}
        mode={mode}
        onModeChange={setMode}
        onSelect={handleSelect}
        isMobile={isMobile}
      />
    </div>
  );
}
