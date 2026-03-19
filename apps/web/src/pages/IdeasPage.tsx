import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Lightbulb,
  MessageSquare,
  Play,
  Check,
  Archive,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import {
  listProjectTasks,
  createProjectTask,
  updateProjectTaskStatus,
  deleteProjectTask,
  runProjectTask,
  listChatSessions,
} from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { Spinner } from '@simple-agent-manager/ui';

// ---------------------------------------------------------------------------
// Status mapping: internal task statuses → user-facing idea statuses
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
  exploring: { label: 'Exploring', color: 'var(--sam-color-accent)', icon: <Lightbulb size={14} /> },
  ready: { label: 'Ready', color: 'var(--sam-color-warning)', icon: <Play size={14} /> },
  executing: { label: 'Executing', color: 'var(--sam-color-info)', icon: <Spinner size="sm" /> },
  done: { label: 'Done', color: 'var(--sam-color-success)', icon: <Check size={14} /> },
  parked: { label: 'Parked', color: 'var(--sam-color-fg-muted)', icon: <Archive size={14} /> },
};

// Which groups to show and in what order
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
// Sub-components
// ---------------------------------------------------------------------------

function IdeaStatusBadge({ status }: { status: IdeaStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ color: config.color, background: `color-mix(in srgb, ${config.color} 15%, transparent)` }}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

interface IdeaCardProps {
  idea: Task;
  sessionCount: number;
  onBrainstorm: () => void;
  onExecute: () => void;
  onClick: () => void;
  onDelete: () => void;
}

function IdeaCard({ idea, sessionCount, onBrainstorm, onExecute, onClick, onDelete }: IdeaCardProps) {
  const ideaStatus = STATUS_FROM_TASK[idea.status];

  return (
    <div
      className="group relative flex flex-col gap-2 p-4 rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      {/* Header: title + status */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-primary m-0 line-clamp-2 flex-1">
          {idea.title}
        </h3>
        <IdeaStatusBadge status={ideaStatus} />
      </div>

      {/* Description snippet */}
      {idea.description && (
        <p className="text-xs text-fg-muted m-0 line-clamp-2">
          {idea.description}
        </p>
      )}

      {/* Footer: session count + actions */}
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-1 text-xs text-fg-muted">
          <MessageSquare size={12} />
          <span>{sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}</span>
        </div>

        {/* Actions — stop propagation so card click doesn't fire */}
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {(ideaStatus === 'exploring' || ideaStatus === 'ready') && (
            <button
              onClick={onBrainstorm}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-transparent border border-border-default text-fg-muted hover:text-fg-primary hover:border-accent cursor-pointer transition-colors"
              title="Start brainstorming session"
            >
              <MessageSquare size={12} />
              Brainstorm
            </button>
          )}
          {(ideaStatus === 'exploring' || ideaStatus === 'ready') && (
            <button
              onClick={onExecute}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-accent text-fg-on-accent border-none cursor-pointer hover:opacity-90 transition-opacity"
              title="Execute this idea"
            >
              <Play size={12} />
              Execute
            </button>
          )}
          {ideaStatus === 'exploring' && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 px-1.5 py-1 text-xs rounded bg-transparent border-none text-fg-muted hover:text-danger-fg cursor-pointer transition-colors"
              title="Delete idea"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface NewIdeaDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (title: string, description: string) => void;
  submitting: boolean;
}

function NewIdeaDialog({ open, onClose, onSubmit, submitting }: NewIdeaDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit(title.trim(), description.trim());
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-overlay z-drawer-backdrop" onClick={onClose} />
      {/* Dialog */}
      <div className="fixed inset-0 z-drawer flex items-center justify-center p-4">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-md bg-surface rounded-lg border border-border-default shadow-lg p-6 flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-fg-primary m-0">New Idea</h2>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="idea-title" className="text-sm font-medium text-fg-secondary">
              Title
            </label>
            <input
              id="idea-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What do you want to explore?"
              className="w-full px-3 py-2 text-sm rounded border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
              autoFocus
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="idea-description" className="text-sm font-medium text-fg-secondary">
              Description <span className="text-fg-muted font-normal">(optional)</span>
            </label>
            <textarea
              id="idea-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief context or goals..."
              rows={3}
              className="w-full px-3 py-2 text-sm rounded border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent resize-y"
              disabled={submitting}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded border border-border-default bg-transparent text-fg-muted hover:text-fg-primary cursor-pointer transition-colors"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium rounded bg-accent text-fg-on-accent border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50"
              disabled={!title.trim() || submitting}
            >
              {submitting ? 'Creating...' : 'Create Idea'}
            </button>
          </div>
        </form>
      </div>
    </>
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

  // New idea dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

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

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (idea) =>
          idea.title.toLowerCase().includes(q) ||
          (idea.description && idea.description.toLowerCase().includes(q)),
      );
    }

    // Status filter
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

  const handleCreateIdea = useCallback(
    async (title: string, description: string) => {
      setCreating(true);
      try {
        await createProjectTask(projectId, {
          title,
          description: description || undefined,
        });
        setDialogOpen(false);
        await loadData();
      } catch (err) {
        console.error('Failed to create idea:', err);
      } finally {
        setCreating(false);
      }
    },
    [projectId, loadData],
  );

  const handleBrainstorm = useCallback(
    async (idea: Task) => {
      // Navigate to project chat and submit a conversation-mode task referencing this idea
      // For now, navigate to chat with a pre-filled context
      navigate(`/projects/${projectId}/chat`, {
        state: {
          brainstormIdea: {
            taskId: idea.id,
            title: idea.title,
            description: idea.description,
          },
        },
      });
    },
    [projectId, navigate],
  );

  const handleExecute = useCallback(
    async (idea: Task) => {
      try {
        // If still draft, transition to ready first
        if (idea.status === 'draft') {
          await updateProjectTaskStatus(projectId, idea.id, { toStatus: 'ready' });
        }
        // Run the task
        await runProjectTask(projectId, idea.id);
        // Navigate to chat — the task runner will create a session
        navigate(`/projects/${projectId}/chat`);
      } catch (err) {
        console.error('Failed to execute idea:', err);
      }
    },
    [projectId, navigate],
  );

  const handleDelete = useCallback(
    async (ideaId: string) => {
      try {
        await deleteProjectTask(projectId, ideaId);
        await loadData();
      } catch (err) {
        console.error('Failed to delete idea:', err);
      }
    },
    [projectId, loadData],
  );

  const handleIdeaClick = useCallback(
    (idea: Task) => {
      // Navigate to task detail page (reused as idea detail)
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
    <div className={`flex flex-col gap-4 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-fg-primary m-0">Ideas</h1>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent text-fg-on-accent border-none cursor-pointer hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          {!isMobile && 'New Idea'}
        </button>
      </div>

      {/* Search + Filter bar */}
      <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'items-center'}`}>
        <div className="relative flex-1">
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
          className="px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary focus:outline-none focus:border-accent cursor-pointer"
        >
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {STATUS_CONFIG[status].label}
            </option>
          ))}
        </select>
      </div>

      {/* Ideas grouped by status */}
      {filteredIdeas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Lightbulb size={48} className="text-fg-muted mb-3 opacity-40" />
          <p className="text-sm text-fg-muted m-0">
            {searchQuery || statusFilter !== 'all'
              ? 'No ideas match your search.'
              : 'No ideas yet. Create one to start exploring!'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {STATUS_ORDER.map((status) => {
            const items = groupedIdeas.get(status) || [];
            if (items.length === 0) return null;

            const collapsed = collapsedGroups.has(status);
            const config = STATUS_CONFIG[status];

            return (
              <div key={status} className="flex flex-col gap-2">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(status)}
                  className="flex items-center gap-2 px-1 py-1 bg-transparent border-none cursor-pointer text-left"
                >
                  {collapsed ? (
                    <ChevronRight size={14} className="text-fg-muted" />
                  ) : (
                    <ChevronDown size={14} className="text-fg-muted" />
                  )}
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: config.color }}>
                    {config.label}
                  </span>
                  <span className="text-xs text-fg-muted">({items.length})</span>
                </button>

                {/* Cards grid */}
                {!collapsed && (
                  <div
                    className={`grid gap-3 ${
                      isMobile
                        ? 'grid-cols-1'
                        : 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]'
                    }`}
                  >
                    {items.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        idea={idea}
                        sessionCount={sessionCountByTaskId.get(idea.id) || 0}
                        onBrainstorm={() => handleBrainstorm(idea)}
                        onExecute={() => handleExecute(idea)}
                        onClick={() => handleIdeaClick(idea)}
                        onDelete={() => handleDelete(idea.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Idea Dialog */}
      <NewIdeaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleCreateIdea}
        submitting={creating}
      />
    </div>
  );
}
