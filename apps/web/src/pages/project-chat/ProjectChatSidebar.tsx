import { ChevronDown, ChevronRight, Search, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { TriggerDropdown } from '../../components/triggers/TriggerDropdown';
import { SessionList } from './SessionList';
import type { useProjectChatState } from './useProjectChatState';

/**
 * Full session-sidebar content. Reused verbatim by the default-mode panel and the Zen
 * peek panel so the two never drift.
 */
export function ProjectChatSidebar({
  state,
  onShowHierarchy,
}: Readonly<{
  state: ReturnType<typeof useProjectChatState>;
  onShowHierarchy: (taskId: string) => void;
}>) {
  const navigate = useNavigate();
  const [triggerDropdownOpen, setTriggerDropdownOpen] = useState(false);
  const handleShowHierarchy = onShowHierarchy;

  return (
    <>
      {/* Sidebar header: project name + action buttons */}
      <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(34,197,94,0.08)] flex items-center gap-2">
        <span className="text-sm font-semibold text-fg-primary truncate flex-1">
          {state.project?.name || 'Project'}
        </span>
        {state.realtimeDegraded && (
          <button
            type="button"
            onClick={() => void state.loadSessions()}
            title="Realtime updates paused. Click to refresh."
            aria-label="Realtime updates paused. Click to refresh session list."
            className="shrink-0 p-1 bg-transparent border-none cursor-pointer rounded-sm transition-colors"
            style={{ color: 'var(--sam-color-warning, #f59e0b)' }}
          >
            <span
              aria-hidden="true"
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: 'var(--sam-color-warning, #f59e0b)' }}
            />
          </button>
        )}
        <TriggerDropdown
          projectId={state.projectId}
          open={triggerDropdownOpen}
          onToggle={() => setTriggerDropdownOpen((prev) => !prev)}
        />
        <button
          type="button"
          onClick={() => navigate(`/projects/${state.projectId}/settings`)}
          title="Project settings"
          aria-label="Project settings"
          className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
        >
          <Settings size={15} />
        </button>
      </div>

      {/* New chat button */}
      <div className="shrink-0 p-2 border-b border-[rgba(34,197,94,0.08)]">
        <button
          type="button"
          onClick={state.handleNewChat}
          className="w-full py-1.5 px-3 rounded-md border border-[rgba(34,197,94,0.15)] bg-transparent cursor-pointer text-fg-primary text-xs font-medium hover:bg-[rgba(34,197,94,0.06)] hover:border-[rgba(34,197,94,0.25)] hover:shadow-[0_0_12px_rgba(22,163,74,0.08)] transition-all"
        >
          + New Chat
        </button>
      </div>

      {/* Subtle refresh indicator */}
      {state.isRefreshing && (
        <div
          className="h-0.5 bg-accent animate-pulse"
          role="status"
          aria-label="Refreshing sessions"
        />
      )}

      {/* Search */}
      {state.hasSessions && (
        <div className="shrink-0 px-2 py-1.5 border-b border-[rgba(34,197,94,0.08)] space-y-1.5">
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
            <input
              type="text"
              value={state.searchQuery}
              onChange={(e) => state.setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-[rgba(34,197,94,0.1)] bg-[var(--sam-form-bg)] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-[rgba(34,197,94,0.3)] focus:shadow-[0_0_12px_rgba(22,163,74,0.06)] transition-all"
            />
            {state.searchQuery && (
              <button
                type="button"
                onClick={() => state.setSearchQuery('')}
                className="absolute right-1.5 p-0.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
          {state.multiplayerActive && (
            <div
              className="grid grid-cols-2 gap-1 rounded-md border border-border-default bg-surface/40 p-0.5"
              aria-label="Session ownership filter"
            >
              {(['my', 'all'] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => state.setSessionScope(scope)}
                  aria-pressed={state.sessionScope === scope}
                  className={`rounded-sm px-2 py-1 text-[11px] font-medium transition-colors ${
                    state.sessionScope === scope
                      ? 'bg-accent/15 text-accent'
                      : 'bg-transparent text-fg-muted hover:text-fg-primary'
                  }`}
                >
                  {scope === 'my' ? 'My sessions' : 'All sessions'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session list — scrollable */}
      {state.hasSessions ? (
        <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
          <SessionList
            sessions={state.filteredRecent}
            selectedSessionId={state.sessionId ?? null}
            onSelect={state.handleSelect}
            taskInfoMap={state.taskInfoMap}
            onShowHierarchy={handleShowHierarchy}
            showOwnership={state.multiplayerActive}
          />
          {state.filteredStale.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => state.setShowStale(!state.effectiveShowStale)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted bg-transparent border-none border-b border-[rgba(34,197,94,0.06)] cursor-pointer hover:bg-[rgba(34,197,94,0.04)] transition-colors"
              >
                {state.effectiveShowStale ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Older ({state.filteredStale.length})</span>
              </button>
              {state.effectiveShowStale && (
                <SessionList
                  sessions={state.filteredStale}
                  selectedSessionId={state.sessionId ?? null}
                  onSelect={state.handleSelect}
                  taskInfoMap={state.taskInfoMap}
                  onShowHierarchy={handleShowHierarchy}
                  showOwnership={state.multiplayerActive}
                />
              )}
            </>
          )}
          {state.filteredRecent.length === 0 && !state.effectiveShowStale && (
            <div className="flex items-center justify-center p-4">
              <span className="text-xs text-fg-muted text-center">
                {state.searchQuery ? 'No matching chats' : 'No recent chats'}
              </span>
            </div>
          )}
        </nav>
      ) : (
        <div className="flex-1 flex items-center justify-center p-4">
          <span className="text-xs text-fg-muted text-center">
            No chats yet. Start a new one above.
          </span>
        </div>
      )}
    </>
  );
}
