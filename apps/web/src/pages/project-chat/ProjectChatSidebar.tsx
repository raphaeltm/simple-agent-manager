import { SearchField, SegmentedControl } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';

import { sessionScopeOptions } from './session-scope-options';
import { SessionList } from './SessionList';
import type { useProjectChatState } from './useProjectChatState';

/**
 * Full session-sidebar content. Reused verbatim by the default-mode pane and the Zen
 * peek panel so the two never drift.
 */
export function ProjectChatSidebar({
  state,
  onShowHierarchy,
}: Readonly<{
  state: ReturnType<typeof useProjectChatState>;
  onShowHierarchy: (taskId: string) => void;
}>) {
  const handleShowHierarchy = onShowHierarchy;

  return (
    <>
      {/* Header: the project name. Automation and project settings live in the project nav. */}
      <div className="flex min-h-14 shrink-0 items-center gap-1 pt-2.5 pr-2 pb-1 pl-4">
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-fg-primary">
          {state.project?.name || 'Project'}
        </span>
        {state.realtimeDegraded && (
          <button
            type="button"
            onClick={() => void state.loadSessions()}
            title="Realtime updates paused. Click to refresh."
            aria-label="Realtime updates paused. Click to refresh session list."
            className="inline-grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[var(--sam-radius-control)] border-none bg-transparent"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full bg-[var(--sam-color-warning)] shadow-[0_0_8px_var(--sam-color-warning)]"
            />
          </button>
        )}
      </div>

      {/* New chat */}
      <div className="shrink-0 px-3 pt-1 pb-2">
        <button
          type="button"
          onClick={state.handleNewChat}
          className="sam-raised flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[14px] border-0 text-[15px] font-medium text-[var(--sam-status-success-fg)] shadow-[inset_0_1px_0_var(--sam-glass-v2-raised-edge),inset_0_0_0_1px_var(--sam-success-edge),var(--sam-shadow-glow-active)] transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
          New Chat
        </button>
      </div>

      {/* Subtle refresh indicator */}
      {state.isRefreshing && (
        <div
          className="mx-4 h-0.5 animate-pulse rounded-full bg-accent"
          role="status"
          aria-label="Refreshing sessions"
        />
      )}

      {/* Search and the ownership filter */}
      {state.hasSessions && (
        <div className="shrink-0 space-y-2 px-3 pb-2">
          <SearchField
            value={state.searchQuery}
            onValueChange={state.setSearchQuery}
            placeholder="Search chats..."
          />
          {state.multiplayerActive && (
            <SegmentedControl
              label="Session ownership filter"
              value={state.sessionScope}
              onChange={state.setSessionScope}
              options={sessionScopeOptions(state.sessions, state.sessionScope)}
            />
          )}
        </div>
      )}

      {/* Session list — scrollable */}
      {state.hasSessions ? (
        <nav aria-label="Chat sessions" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
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
                className="mt-1 flex min-h-10 w-full cursor-pointer items-center gap-1.5 rounded-[11px] border-none bg-transparent px-3 text-[13px] text-fg-muted transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary"
              >
                {state.effectiveShowStale ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
              <span className="text-center text-[13px] text-fg-muted">
                {state.searchQuery ? 'No matching chats' : 'No recent chats'}
              </span>
            </div>
          )}
        </nav>
      ) : state.loading ? (
        // Not a status region: the conversation column's spinner already announces loading.
        <div className="flex flex-1 items-center justify-center p-4">
          <span className="text-center text-[13px] text-fg-muted">Loading chats…</span>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4">
          <span className="text-center text-[13px] text-fg-muted">
            No chats yet. Start a new one above.
          </span>
        </div>
      )}
    </>
  );
}
