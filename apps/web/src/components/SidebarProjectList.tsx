import type { ProjectSummary } from '@simple-agent-manager/shared';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { type ChangeEvent, useCallback, useMemo, useState } from 'react';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** Maximum projects visible before scrolling kicks in */
const DEFAULT_MAX_VISIBLE = 8;
const MAX_VISIBLE = parseInt(
  import.meta.env.VITE_SIDEBAR_PROJECT_LIST_MAX_VISIBLE || String(DEFAULT_MAX_VISIBLE),
  10,
);

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return '';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

interface SidebarProjectListProps {
  projects: ProjectSummary[];
  loading: boolean;
  currentProjectId?: string;
  onNavigate: (path: string) => void;
  /** Render variant: 'mobile' uses larger touch targets, 'desktop' uses compact sizing */
  variant?: 'mobile' | 'desktop';
}

export function SidebarProjectList({
  projects,
  loading,
  currentProjectId,
  onNavigate,
  variant = 'mobile',
}: SidebarProjectListProps) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!filter) return projects;
    const q = filter.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.repository.toLowerCase().includes(q),
    );
  }, [projects, filter]);

  const handleFilterChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value);
  }, []);

  const clearFilter = useCallback(() => {
    setFilter('');
  }, []);

  const isMobile = variant === 'mobile';
  const sectionId = 'sidebar-projects-panel';

  return (
    <div className="mt-2">
      {/* Section header */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 w-full ${
          isMobile ? 'px-5 py-2.5 min-h-11' : 'px-3 py-2'
        } bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-[120ms] ${FOCUS_RING}`}
        aria-expanded={open}
        aria-controls={sectionId}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Recent Projects
      </button>

      {open && (
        <div id={sectionId} role="region" aria-label="Recent Projects">
          {/* Filter input */}
          <div className={`${isMobile ? 'px-4' : 'px-2'} py-1`}>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={filter}
                onChange={handleFilterChange}
                placeholder="Filter projects..."
                aria-label="Filter projects"
                className={`w-full ${
                  isMobile ? 'min-h-11 py-2.5' : 'min-h-8 py-1.5'
                } pl-8 pr-8 bg-inset border border-border-default rounded-sm text-fg-primary text-sm outline-none transition-colors duration-150 focus:border-focus-ring placeholder:text-fg-muted`}
              />
              {filter && (
                <button
                  onClick={clearFilter}
                  aria-label="Clear filter"
                  className={`absolute right-0.5 top-1/2 -translate-y-1/2 flex items-center justify-center ${
                    isMobile ? 'w-10 h-10' : 'w-7 h-7'
                  } bg-transparent border-none text-fg-muted cursor-pointer rounded-sm hover:text-fg-primary hover:bg-surface-hover transition-colors ${FOCUS_RING}`}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Project list */}
          <div
            className="overflow-y-auto"
            style={{ maxHeight: `${MAX_VISIBLE * (isMobile ? 44 : 36)}px` }}
          >
            {loading && projects.length === 0 ? (
              <div className={`${isMobile ? 'px-5' : 'px-3'} py-3 text-sm text-fg-muted`}>
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className={`${isMobile ? 'px-5' : 'px-3'} py-3 text-sm text-fg-muted`} role="status" aria-live="polite">
                {filter ? `No projects match "${filter}"` : 'No projects yet'}
              </div>
            ) : (
              filtered.map((project) => {
                const isActive = project.id === currentProjectId;
                const hasActiveSessions = (project.activeSessionCount ?? 0) > 0;

                return (
                  <button
                    key={project.id}
                    onClick={() => onNavigate(`/projects/${project.id}/chat`)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-2.5 w-full ${
                      isMobile
                        ? 'min-h-11 px-5 py-2'
                        : 'min-h-9 px-3 py-1.5'
                    } bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${FOCUS_RING} ${
                      isActive
                        ? 'text-accent border-l-accent bg-accent-tint'
                        : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                    }`}
                  >
                    {/* Project icon */}
                    <span
                      className="flex items-center justify-center w-6 h-6 rounded-sm bg-inset border border-border-default text-xs font-bold text-fg-muted shrink-0"
                      aria-hidden="true"
                    >
                      {[...project.name][0]?.toUpperCase() ?? '?'}
                    </span>

                    {/* Project name */}
                    <span className="flex-1 min-w-0 text-sm font-semibold truncate">
                      {project.name}
                    </span>

                    {/* Relative time */}
                    {project.lastActivityAt && (
                      <span className="text-[11px] text-fg-muted shrink-0 tabular-nums">
                        {relativeTime(project.lastActivityAt)}
                      </span>
                    )}

                    {/* Activity dot — size differential for non-color accessibility */}
                    <span
                      className={`rounded-full shrink-0 ${
                        hasActiveSessions
                          ? 'w-2 h-2 bg-accent'
                          : 'w-1.5 h-1.5 bg-fg-muted opacity-30'
                      }`}
                      role="img"
                      aria-label={hasActiveSessions ? 'Active sessions' : 'No active sessions'}
                    />
                  </button>
                );
              })
            )}
          </div>

          {/* Show count if filtered */}
          {filter && filtered.length > 0 && (
            <div className={`${isMobile ? 'px-5' : 'px-3'} py-1 text-[11px] text-fg-muted`} role="status" aria-live="polite">
              {filtered.length} of {projects.length} projects
            </div>
          )}
        </div>
      )}
    </div>
  );
}

