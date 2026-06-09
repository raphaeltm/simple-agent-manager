import type { Task } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { Clock, Lightbulb, MessageSquare, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../hooks/useIsMobile';
import type { ChatSessionListItem } from '../lib/api';
import { listChatSessions, listProjectTasks } from '../lib/api';
import { useProjectContext } from './ProjectContext';

/** Max ideas to load per page. Override via VITE_IDEAS_FETCH_LIMIT. */
const DEFAULT_IDEAS_FETCH_LIMIT = 200;
const IDEAS_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_IDEAS_FETCH_LIMIT || String(DEFAULT_IDEAS_FETCH_LIMIT)
);

/** Max task-list pages to traverse when loading draft ideas. Override via VITE_IDEAS_FETCH_MAX_PAGES. */
const DEFAULT_IDEAS_FETCH_MAX_PAGES = 50;
const IDEAS_FETCH_MAX_PAGES = parseInt(
  import.meta.env.VITE_IDEAS_FETCH_MAX_PAGES || String(DEFAULT_IDEAS_FETCH_MAX_PAGES)
);

/** Max sessions to load for idea session counts. Override via VITE_IDEAS_SESSION_FETCH_LIMIT. */
const DEFAULT_IDEAS_SESSION_FETCH_LIMIT = 200;
const IDEAS_SESSION_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_IDEAS_SESSION_FETCH_LIMIT || String(DEFAULT_IDEAS_SESSION_FETCH_LIMIT)
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function listAllDraftIdeas(
  projectId: string
): Promise<{ tasks: Task[]; truncated: boolean }> {
  const tasks: Task[] = [];
  let cursor: string | undefined;
  let pagesLoaded = 0;

  do {
    const result = await listProjectTasks(projectId, {
      status: 'draft',
      limit: IDEAS_FETCH_LIMIT,
      cursor,
    });
    tasks.push(...result.tasks);
    cursor = result.nextCursor ?? undefined;
    pagesLoaded += 1;
  } while (cursor && pagesLoaded < IDEAS_FETCH_MAX_PAGES);

  return { tasks, truncated: Boolean(cursor) };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface IdeaCardProps {
  idea: Task;
  sessionCount: number;
  onClick: () => void;
}

function IdeaCard({ idea, sessionCount, onClick }: IdeaCardProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 px-3 py-2.5 min-h-[56px] rounded-lg border border-[var(--sam-form-border)] bg-[var(--sam-glass-nested-bg)] hover:border-accent/40 transition-colors cursor-pointer text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={`View idea: ${idea.title}`}
    >
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium text-fg-primary m-0 line-clamp-1 flex-1 min-w-0 break-all sm:break-words">
            {idea.title}
          </h3>
          {idea.triggeredBy && idea.triggeredBy !== 'user' && (
            <span
              className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0 rounded-full whitespace-nowrap shrink-0"
              style={{
                color: 'var(--sam-color-info)',
                background: 'color-mix(in srgb, var(--sam-color-info) 12%, transparent)',
              }}
              title="Created by automation trigger"
            >
              <Clock size={8} /> AUTO
            </span>
          )}
        </div>
        {idea.description && (
          <p className="text-xs text-fg-muted m-0 mt-0.5 line-clamp-1 break-all sm:break-words">
            {idea.description}
          </p>
        )}
      </div>

      {/* Meta: session count + age */}
      <div className="flex items-center gap-3 shrink-0 text-xs text-fg-muted pt-0.5">
        {sessionCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={11} />
            {sessionCount}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Clock size={11} />
          {timeAgo(idea.createdAt)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IdeasPage() {
  const navigate = useNavigate();
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();

  const [ideas, setIdeas] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<ChatSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [tasksResult, sessionsResult] = await Promise.all([
        listAllDraftIdeas(projectId),
        listChatSessions(projectId, { limit: IDEAS_SESSION_FETCH_LIMIT }),
      ]);
      setIdeas(tasksResult.tasks.filter((task) => task.status === 'draft'));
      setTruncated(tasksResult.truncated);
      setSessions(sessionsResult.sessions);
    } catch (err) {
      console.error('Failed to load ideas data:', err);
      setError('Failed to load ideas. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---------------------------------------------------------------------------
  // Computed: session counts per idea, filtered ideas
  // ---------------------------------------------------------------------------

  const sessionCountByTaskId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (s.taskId) {
        counts.set(s.taskId, (counts.get(s.taskId) || 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

  const filteredIdeas = useMemo(() => {
    let result = ideas;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (idea) =>
          idea.title.toLowerCase().includes(q) ||
          (idea.description && idea.description.toLowerCase().includes(q))
      );
    }

    return result;
  }, [ideas, searchQuery]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleIdeaClick = useCallback(
    (idea: Task) => {
      navigate(`/projects/${projectId}/ideas/${idea.id}`);
    },
    [projectId, navigate]
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

  return (
    <div
      className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}
    >
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg-primary m-0">Ideas</h1>
        <p className="text-sm text-fg-muted m-0">
          {ideas.length === 1 ? '1 idea being refined' : `${ideas.length} ideas being refined`}
          {truncated ? ` (showing first ${ideas.length})` : ''}
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative flex-1 min-w-0">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ideas..."
            className="w-full min-h-[44px] pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--sam-form-border)] bg-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Lightbulb size={40} className="text-fg-muted opacity-30" aria-hidden="true" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">{error}</p>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[44px] rounded-lg border border-border-default bg-surface text-sm text-fg-primary hover:border-accent/40 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : filteredIdeas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Lightbulb size={40} className="text-fg-muted mb-3 opacity-30" aria-hidden="true" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {searchQuery
              ? 'No ideas match your search.'
              : 'Ideas emerge from your conversations. Start chatting to explore new ideas.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5" role="list" aria-label="Ideas being refined">
          {filteredIdeas.map((idea) => (
            <div key={idea.id} role="listitem">
              <IdeaCard
                idea={idea}
                sessionCount={sessionCountByTaskId.get(idea.id) || 0}
                onClick={() => handleIdeaClick(idea)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
