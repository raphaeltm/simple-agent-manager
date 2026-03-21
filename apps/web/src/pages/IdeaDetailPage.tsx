import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  MessageSquare,
  Clock,
  Lightbulb,
} from 'lucide-react';
import type { TaskDetailResponse, TaskStatus } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { getProjectTask, getTaskSessions } from '../lib/api';
import type { TaskSessionLink } from '../lib/api';
import { useProjectContext } from './ProjectContext';
import { useIsMobile } from '../hooks/useIsMobile';

// ---------------------------------------------------------------------------
// Status mapping (mirrors IdeasPage)
// ---------------------------------------------------------------------------

type IdeaStatus = 'exploring' | 'ready' | 'executing' | 'done' | 'parked';

const STATUS_FROM_TASK: Record<TaskStatus, IdeaStatus> = {
  draft: 'exploring',
  ready: 'ready',
  queued: 'executing',
  delegated: 'executing',
  in_progress: 'executing',
  completed: 'done',
  failed: 'parked',
  cancelled: 'parked',
};

const STATUS_CONFIG: Record<IdeaStatus, { label: string; color: string }> = {
  exploring: { label: 'Exploring', color: 'var(--sam-color-accent-primary)' },
  ready: { label: 'Ready', color: 'var(--sam-color-warning)' },
  executing: { label: 'Executing', color: 'var(--sam-color-info)' },
  done: { label: 'Done', color: 'var(--sam-color-success)' },
  parked: { label: 'Parked', color: 'var(--sam-color-fg-muted)' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(timestamp: number | string): string {
  const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diffMs = Date.now() - ms;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: TaskSessionLink;
  onClick: () => void;
}

function SessionRow({ session, onClick }: SessionRowProps) {
  const isActive = session.status === 'active';

  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 px-3 py-3 rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors cursor-pointer text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={`Open conversation: ${session.topic || 'Untitled conversation'}`}
    >
      <MessageSquare
        size={16}
        className="shrink-0 mt-0.5"
        style={{ color: isActive ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fg-primary m-0 line-clamp-1">
          {session.topic || 'Untitled conversation'}
        </p>
        {session.context && (
          <p className="text-xs text-fg-muted m-0 mt-0.5 line-clamp-2">
            {session.context}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 text-xs text-fg-muted pt-0.5">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium"
          style={{
            background: isActive
              ? 'color-mix(in srgb, var(--sam-color-success) 15%, transparent)'
              : 'color-mix(in srgb, var(--sam-color-fg-muted) 15%, transparent)',
            color: isActive ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)',
          }}
        >
          {isActive ? 'Active' : 'Stopped'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock size={11} />
          {timeAgo(session.linkedAt)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IdeaDetailPage() {
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();

  const [idea, setIdea] = useState<TaskDetailResponse | null>(null);
  const [sessions, setSessions] = useState<TaskSessionLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!taskId) return;
    try {
      setLoading(true);
      setError(null);
      const [taskResult, sessionsResult] = await Promise.all([
        getProjectTask(projectId, taskId),
        getTaskSessions(projectId, taskId),
      ]);
      setIdea(taskResult);
      setSessions(sessionsResult.sessions);
    } catch (err) {
      console.error('Failed to load idea details:', err);
      setError('Failed to load idea details. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/ideas`);
  }, [projectId, navigate]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigate(`/projects/${projectId}/chat/${sessionId}`);
    },
    [projectId, navigate],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !idea) {
    return (
      <div className={`flex flex-col gap-4 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
        <button
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer p-0"
        >
          <ArrowLeft size={16} />
          Back to Ideas
        </button>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-fg-muted m-0">
            {error || 'Idea not found.'}
          </p>
        </div>
      </div>
    );
  }

  const ideaStatus = STATUS_FROM_TASK[idea.status];
  const statusConfig = STATUS_CONFIG[ideaStatus];

  return (
    <div className={`flex flex-col gap-5 overflow-x-hidden ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Back link */}
      <button
        onClick={handleBack}
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer p-0 self-start"
      >
        <ArrowLeft size={16} />
        Back to Ideas
      </button>

      {/* Idea header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-fg-primary m-0 leading-tight">
              {idea.title}
            </h1>
            {idea.description && (
              <p className="text-sm text-fg-muted m-0 mt-1.5 line-clamp-3">
                {idea.description}
              </p>
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          <span
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider"
            style={{
              background: `color-mix(in srgb, ${statusConfig.color} 15%, transparent)`,
              color: statusConfig.color,
            }}
          >
            {statusConfig.label}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} />
            Created {formatDate(idea.createdAt)}
          </span>
        </div>
      </div>

      {/* Conversations section */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg-secondary m-0 uppercase tracking-wider">
          Conversations ({sessions.length})
        </h2>

        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Lightbulb size={32} className="text-fg-muted mb-3 opacity-30" />
            <p className="text-sm text-fg-muted m-0 max-w-xs">
              No conversations linked yet. Start chatting to discuss this idea.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                onClick={() => handleSessionClick(session.sessionId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
