import type { TaskDetailResponse, TaskStatus } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  Archive,
  ArrowLeft,
  Check,
  Clock,
  Lightbulb,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { RenderedMarkdown } from '../components/MarkdownRenderer';
import { useIsMobile } from '../hooks/useIsMobile';
import type { TaskSessionLink } from '../lib/api';
import { getProjectTask, getTaskSessions } from '../lib/api';
import { useProjectContext } from './ProjectContext';

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

const STATUS_CONFIG: Record<IdeaStatus, { label: string; color: string; icon: React.ReactNode }> = {
  exploring: { label: 'Exploring', color: 'var(--sam-color-accent-primary)', icon: <Lightbulb size={12} aria-hidden="true" /> },
  ready: { label: 'Ready', color: 'var(--sam-color-warning)', icon: <Play size={12} aria-hidden="true" /> },
  executing: { label: 'Executing', color: 'var(--sam-color-info)', icon: <span aria-hidden="true"><Spinner size="sm" /></span> },
  done: { label: 'Done', color: 'var(--sam-color-success)', icon: <Check size={12} aria-hidden="true" /> },
  parked: { label: 'Parked', color: 'var(--sam-color-fg-muted)', icon: <Archive size={12} aria-hidden="true" /> },
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
          <p className="text-xs text-fg-muted m-0 mt-0.5 line-clamp-2 break-words">
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
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Clock size={11} />
          {timeAgo(session.linkedAt)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Conversations panel (shared between desktop sidebar and mobile modal)
// ---------------------------------------------------------------------------

interface ConversationsPanelProps {
  sessions: TaskSessionLink[];
  onSessionClick: (sessionId: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

function ConversationsPanel({ sessions, onSessionClick, searchQuery, onSearchChange }: ConversationsPanelProps) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.topic || '').toLowerCase().includes(q) ||
        (s.context || '').toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
        <input
          type="text"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-8 pr-3 py-2 text-sm bg-page border border-border-default rounded-lg text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent/60 min-h-[44px]"
          aria-label="Search conversations"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Session list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Lightbulb size={28} className="text-fg-muted mb-2 opacity-30" aria-hidden="true" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {sessions.length === 0
              ? 'No conversations linked yet. Start chatting to discuss this idea.'
              : 'No conversations match your search.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 overflow-y-auto flex-1 min-h-0" role="list" aria-label="Linked conversations">
          {filtered.map((session) => (
            <div key={session.sessionId} role="listitem">
              <SessionRow
                session={session}
                onClick={() => onSessionClick(session.sessionId)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile conversations modal
// ---------------------------------------------------------------------------

interface MobileConversationsModalProps {
  open: boolean;
  onClose: () => void;
  sessions: TaskSessionLink[];
  onSessionClick: (sessionId: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

function MobileConversationsModal({
  open,
  onClose,
  sessions,
  onSessionClick,
  searchQuery,
  onSearchChange,
}: MobileConversationsModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      // Move focus into modal on open for accessibility
      closeButtonRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        className="fixed inset-x-0 bottom-0 max-h-[80vh] bg-surface border-t border-border-default rounded-t-2xl z-drawer flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Linked conversations"
        tabIndex={-1}
      >
        {/* Header + close */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default shrink-0">
          <h2 className="text-sm font-semibold text-fg-primary m-0">
            Conversations {sessions.length > 0 && `(${sessions.length})`}
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="p-2 text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close conversations panel"
          >
            <X size={18} />
          </button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
          <ConversationsPanel
            sessions={sessions}
            onSessionClick={onSessionClick}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
          />
        </div>
      </div>
    </>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [showMobileConversations, setShowMobileConversations] = useState(false);

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
      setShowMobileConversations(false);
      navigate(`/projects/${projectId}/chat/${sessionId}`);
    },
    [projectId, navigate],
  );

  const handleExecute = useCallback(() => {
    if (!taskId) return;
    navigate(`/projects/${projectId}/chat?executeIdea=${encodeURIComponent(taskId)}`);
  }, [projectId, taskId, navigate]);

  // ---------------------------------------------------------------------------
  // Render: Loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" aria-label="Loading idea details" role="status">
        <Spinner size="lg" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Error / Not Found
  // ---------------------------------------------------------------------------

  if (error || !idea) {
    return (
      <div className={`flex flex-col gap-4 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
        <button
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer py-3 pr-3 pl-0 -ml-1 self-start min-h-[44px]"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back to Ideas
        </button>
        <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <p className="text-sm text-fg-muted m-0">
            {error || 'Idea not found.'}
          </p>
          {error && (
            <button
              onClick={loadData}
              className="inline-flex items-center gap-1.5 text-sm text-fg-primary border border-border-default rounded-lg px-3 py-2 min-h-[44px] bg-surface hover:border-accent/40 transition-colors cursor-pointer"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const ideaStatus = STATUS_FROM_TASK[idea.status];
  const statusConfig = STATUS_CONFIG[ideaStatus];

  // ---------------------------------------------------------------------------
  // Render: Idea detail
  // ---------------------------------------------------------------------------

  const headerContent = (
    <>
      {/* Back link */}
      <button
        onClick={handleBack}
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary transition-colors bg-transparent border-none cursor-pointer py-3 pr-3 pl-0 -ml-1 self-start min-h-[44px]"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back to Ideas
      </button>

      {/* Title + Execute button */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold text-fg-primary m-0 leading-tight min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>
          {idea.title}
        </h1>
        {ideaStatus !== 'done' && ideaStatus !== 'parked' && (
          <button
            onClick={handleExecute}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border-none cursor-pointer shrink-0 min-h-[44px] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            style={{
              backgroundColor: 'var(--sam-color-accent-primary)',
              color: 'white',
            }}
            aria-label="Execute this idea"
          >
            <Rocket size={14} aria-hidden="true" />
            Execute
          </button>
        )}
      </div>

      {/* Status pill + date */}
      <div className="flex items-center gap-3 text-xs text-fg-muted flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider"
          style={{
            background: `color-mix(in srgb, ${statusConfig.color} 15%, transparent)`,
            color: statusConfig.color,
          }}
        >
          {statusConfig.icon}
          {statusConfig.label}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock size={12} />
          Created {formatDate(idea.createdAt)}
        </span>
      </div>
    </>
  );

  // Desktop: two-column layout
  if (!isMobile) {
    return (
      <div className="flex gap-6 overflow-x-hidden w-full max-w-full min-w-0 px-6 py-4 h-full">
        {/* Left column: header + markdown body */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
          {headerContent}

          {/* Markdown body */}
          {idea.description && (
            <div className="mt-2 border-t border-border-default pt-4">
              <RenderedMarkdown content={idea.description} inline />
            </div>
          )}
        </div>

        {/* Right column: conversations panel */}
        <aside className="w-80 shrink-0 flex flex-col gap-3 border-l border-border-default pl-6 overflow-hidden">
          <h2 className="text-sm font-semibold text-fg-secondary m-0 uppercase tracking-wider shrink-0">
            {sessions.length > 0 ? `Conversations (${sessions.length})` : 'Conversations'}
          </h2>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ConversationsPanel
              sessions={sessions}
              onSessionClick={handleSessionClick}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
            />
          </div>
        </aside>
      </div>
    );
  }

  // Mobile: single column + FAB
  return (
    <div className="flex flex-col gap-3 overflow-x-hidden w-full max-w-full min-w-0 px-4 py-3 pb-20">
      {headerContent}

      {/* Markdown body */}
      {idea.description && (
        <div className="mt-2 border-t border-border-default pt-4">
          <RenderedMarkdown content={idea.description} inline />
        </div>
      )}

      {/* FAB for conversations — z-[5] keeps it below main nav (z-sticky = 10) */}
      <button
        onClick={() => setShowMobileConversations(true)}
        className="fixed bottom-5 right-5 z-[5] flex items-center justify-center w-14 h-14 rounded-full shadow-lg hover:opacity-90 transition-opacity cursor-pointer border-none"
        style={{ backgroundColor: 'var(--sam-color-accent-primary)', color: 'white' }}
        aria-label={`Show conversations${sessions.length > 0 ? ` (${sessions.length})` : ''}`}
      >
        <MessageSquare size={22} />
        {sessions.length > 0 && (
          <span
            className="absolute -top-1 -right-1 flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] font-bold"
            style={{ backgroundColor: 'white', color: 'var(--sam-color-accent-primary)' }}
          >
            {sessions.length}
          </span>
        )}
      </button>

      {/* Mobile conversations modal */}
      <MobileConversationsModal
        open={showMobileConversations}
        onClose={() => setShowMobileConversations(false)}
        sessions={sessions}
        onSessionClick={handleSessionClick}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
    </div>
  );
}
