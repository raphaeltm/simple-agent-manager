import { EmptyState, StatusBadge } from '@simple-agent-manager/ui';

import type { ChatSessionResponse } from '../lib/api';
import { formatDuration, formatRelativeTime } from '../lib/time-utils';

interface ChatSessionListProps {
  sessions: ChatSessionResponse[];
  onSelect: (sessionId: string) => void;
}

export function ChatSessionList({ sessions, onSelect }: ChatSessionListProps) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        heading="No sessions yet"
        description="Chat sessions appear here when workspaces connect to this project."
      />
    );
  }

  return (
    <ul className="m-0 p-0 list-none grid gap-px">
      {sessions.map((session) => (
        <li
          key={session.id}
          onClick={() => onSelect(session.id)}
          className="flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-border-default transition-colors duration-100 hover:bg-inset"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-[2px]">
              <span className="text-sm font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap">
                {session.topic || `Session ${session.id.slice(0, 8)}`}
              </span>
              <StatusBadge
                status={session.status === 'active' ? 'running' : session.status === 'error' ? 'error' : 'stopped'}
                label={session.status}
              />
            </div>
            <div className="flex gap-3 text-xs text-fg-muted">
              <span>{session.messageCount} message{session.messageCount !== 1 ? 's' : ''}</span>
              <span>{formatDuration(session.startedAt, session.endedAt)}</span>
            </div>
          </div>
          <span className="text-xs text-fg-muted whitespace-nowrap shrink-0">
            {formatRelativeTime(session.startedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
