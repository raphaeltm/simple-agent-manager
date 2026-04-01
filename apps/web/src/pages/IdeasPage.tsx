import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Lightbulb,
  MessageSquare,
  Play,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../hooks/useIsMobile';
import type { ChatSessionResponse } from '../lib/api';
import { listChatSessions,listProjectTasks } from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Status mapping: internal task statuses -> user-facing idea statuses
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
  exploring: { label: 'Exploring', color: 'var(--sam-color-accent-primary)', icon: <Lightbulb size={14} aria-hidden="true" /> },
  ready: { label: 'Ready', color: 'var(--sam-color-warning)', icon: <Play size={14} aria-hidden="true" /> },
  executing: { label: 'Executing', color: 'var(--sam-color-info)', icon: <span aria-hidden="true"><Spinner size="sm" /></span> },
  done: { label: 'Done', color: 'var(--sam-color-success)', icon: <Check size={14} aria-hidden="true" /> },
  parked: { label: 'Parked', color: 'var(--sam-color-fg-muted)', icon: <Archive size={14} aria-hidden="true" /> },
};

const STATUS_ORDER: IdeaStatus[] = ['exploring', 'ready', 'executing', 'done', 'parked'];

/** Max ideas to load per page. Override via VITE_IDEAS_FETCH_LIMIT. */
const DEFAULT_IDEAS_FETCH_LIMIT = 200;
const IDEAS_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_IDEAS_FETCH_LIMIT || String(DEFAULT_IDEAS_FETCH_LIMIT),
);

/** Max sessions to load for idea session counts. Override via VITE_IDEAS_SESSION_FETCH_LIMIT. */
const DEFAULT_IDEAS_SESSION_FETCH_LIMIT = 200;
const IDEAS_SESSION_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_IDEAS_SESSION_FETCH_LIMIT || String(DEFAULT_IDEAS_SESSION_FETCH_LIMIT),
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
      className="flex items-start gap-3 px-3 py-2.5 min-h-[56px] rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors cursor-pointer text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={`View idea: ${idea.title}`}
    >
      {/* Content */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-fg-primary m-0 line-clamp-1">
          {idea.title}
        </h3>
        {idea.description && (
          <p className="text-xs text-fg-muted m-0 mt-0.5 line-clamp-1">
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
  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<IdeaStatus | 'all'>('all');

  // Collapsible groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<IdeaStatus>>(new Set(['done', 'parked']));

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    try {
      const [tasksResult, sessionsResult] = await Promise.all([
        listProjectTasks(projectId, { limit: IDEAS_FETCH_LIMIT }),
        listChatSessions(projectId, { limit: IDEAS_SESSION_FETCH_LIMIT }),
      ]);
      setIdeas(tasksResult.tasks);
      setSessions(sessionsResult.sessions);
    } catch (err) {
      console.error('Failed to load ideas data:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---------------------------------------------------------------------------
  // Computed: session counts per idea, filtered/grouped ideas
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
          (idea.description && idea.description.toLowerCase().includes(q)),
      );
    }

    if (statusFilter !== 'all') {
      result = result.filter((idea) => STATUS_FROM_TASK[idea.status] === statusFilter);
    }

    return result;
  }, [ideas, searchQuery, statusFilter]);

  const groupedIdeas = useMemo(() => {
    const groups = new Map<IdeaStatus, Task[]>();
    for (const status of STATUS_ORDER) {
      groups.set(status, []);
    }
    for (const idea of filteredIdeas) {
      const ideaStatus = STATUS_FROM_TASK[idea.status];
      groups.get(ideaStatus)?.push(idea);
    }
    return groups;
  }, [filteredIdeas]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleIdeaClick = useCallback(
    (idea: Task) => {
      navigate(`/projects/${projectId}/ideas/${idea.id}`);
    },
    [projectId, navigate],
  );

  const toggleGroup = useCallback((status: IdeaStatus) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

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
    <div className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Header */}
      <h1 className="text-xl font-semibold text-fg-primary m-0">Ideas</h1>

      {/* Search + Filter bar — always single row */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative flex-1 min-w-0">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ideas..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as IdeaStatus | 'all')}
          aria-label="Filter by status"
          className="w-[140px] px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary focus:outline-none focus:border-accent cursor-pointer shrink-0"
        >
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {STATUS_CONFIG[status].label}
            </option>
          ))}
        </select>
      </div>

      {/* Ideas grouped by status — timeline feel */}
      {filteredIdeas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Lightbulb size={40} className="text-fg-muted mb-3 opacity-30" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {searchQuery || statusFilter !== 'all'
              ? 'No ideas match your search.'
              : 'Ideas emerge from your conversations. Start chatting to explore new ideas.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {STATUS_ORDER.map((status) => {
            const items = groupedIdeas.get(status) || [];
            if (items.length === 0) return null;

            const collapsed = collapsedGroups.has(status);
            const config = STATUS_CONFIG[status];

            return (
              <section key={status} aria-labelledby={`group-header-${status}`} className="flex flex-col gap-1.5">
                {/* Group header with timeline accent */}
                <button
                  onClick={() => toggleGroup(status)}
                  aria-expanded={!collapsed}
                  aria-controls={`group-list-${status}`}
                  className="flex items-center gap-2 px-1 py-1.5 min-h-[44px] bg-transparent border-none cursor-pointer text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded"
                >
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0"
                    style={{ background: `color-mix(in srgb, ${config.color} 20%, transparent)`, color: config.color }}
                  >
                    {config.icon}
                  </span>
                  <span
                    id={`group-header-${status}`}
                    className="text-xs font-semibold uppercase tracking-wider"
                    style={{ color: config.color }}
                  >
                    {config.label}
                  </span>
                  <span className="text-xs text-fg-muted">({items.length})</span>
                  <span className="ml-auto">
                    {collapsed ? (
                      <ChevronRight size={14} className="text-fg-muted" aria-hidden="true" />
                    ) : (
                      <ChevronDown size={14} className="text-fg-muted" aria-hidden="true" />
                    )}
                  </span>
                </button>

                {/* Timeline items — vertical list with left accent */}
                {!collapsed && (
                  <div
                    id={`group-list-${status}`}
                    className="flex flex-col gap-1.5 ml-2.5 pl-4 border-l-2"
                    style={{ borderColor: `color-mix(in srgb, ${config.color} 30%, transparent)` }}
                  >
                    {items.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        idea={idea}
                        sessionCount={sessionCountByTaskId.get(idea.id) || 0}
                        onClick={() => handleIdeaClick(idea)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
