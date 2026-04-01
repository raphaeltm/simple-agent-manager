import { EmptyState, StatusBadge } from '@simple-agent-manager/ui';

import type { ChatSessionResponse } from '../lib/api';

interface ChatSessionListProps {
  sessions: ChatSessionResponse[];
  onSelect: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const diff = end - startedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
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
