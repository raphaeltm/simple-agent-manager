import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, List, Search, Settings, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAppShell } from '../../components/AppShell';
import { BootLogPanel } from '../../components/chat/BootLogPanel';
import { ProjectMessageView } from '../../components/project-message-view';
import { HierarchyModal } from '../../components/task-hierarchy';
import { TriggerDropdown } from '../../components/triggers/TriggerDropdown';
import { ZenPeekRail } from '../../components/ZenPeekRail';
import { useIsMobile } from '../../hooks/useIsMobile';
import { sessionWidthForMode } from '../../lib/focus-mode';
import { ChatInput } from './ChatInput';
import { DerivedSessionBanner } from './DerivedSessionBanner';
import { FocusStrip } from './FocusStrip';
import { getSessionSourceContext } from './lineageUtils';
import { MobileSessionDrawer } from './MobileSessionDrawer';
import { ProvisioningIndicator } from './ProvisioningIndicator';
import { SessionList } from './SessionList';
import { isTerminal } from './types';
import { useProjectChatState } from './useProjectChatState';

export function ProjectChat() {
  const isMobile = useIsMobile();
  const { focusMode, setFocusMode } = useAppShell();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useProjectChatState();
  const [triggerDropdownOpen, setTriggerDropdownOpen] = useState(false);

  // Derive hierarchy modal state from URL hash (#hierarchy-<taskId>)
  const hierarchyTaskId = useMemo(() => {
    const hash = location.hash;
    if (hash.startsWith('#hierarchy-')) return hash.slice('#hierarchy-'.length);
    return null;
  }, [location.hash]);

  const handleShowHierarchy = useCallback(
    (taskId: string) => {
      navigate(location.pathname + location.search + `#hierarchy-${taskId}`);
    },
    [navigate, location.pathname, location.search]
  );

  const handleHierarchyClose = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleHierarchyNavigate = useCallback(
    (sessionId: string) => {
      navigate(`/projects/${state.projectId}/chat/${sessionId}`, { replace: true });
    },
    [navigate, state.projectId]
  );
  const activeSessionId = state.sessionId ?? '';
  const starterPrompts = useMemo(() => {
    const repoLabel = state.project?.repository || state.project?.name || 'this repo';
    return [
      `What's in ${repoLabel}?`,
      'Run the tests and summarize what fails.',
      'Find one small improvement I can ship today.',
      'Fix the most recent open issue.',
    ];
  }, [state.project?.name, state.project?.repository]);

  // Compute source context for the selected retry/fork session (for header display).
  const selectedSourceContext = useMemo(() => {
    if (!state.sessionId) return undefined;
    const session = state.sessions.find((s) => s.id === state.sessionId);
    if (!session?.taskId) return undefined;
    return getSessionSourceContext(session.taskId, state.taskInfoMap, state.sessions);
  }, [state.sessionId, state.sessions, state.taskInfoMap]);

  // Loading state
  if (state.loading && state.sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  // Full session-sidebar content. Reused verbatim by the default-mode panel
  // and the Zen peek panel so the two never drift.
  const sidebarInner = (
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

  return (
    <div className="flex flex-1 min-h-0">
      {/* ================================================================== */}
      {/* Desktop session sidebar — collapses with Focus Mode                */}
      {/* default: 288px full panel · focus: 64px status strip · zen: seam   */}
      {/* ================================================================== */}
      {!isMobile && focusMode === 'zen' && (
        <ZenPeekRail edge="sessions" label="Chats" onExpand={() => setFocusMode('default')}>
          {sidebarInner}
        </ZenPeekRail>
      )}
      {!isMobile && focusMode !== 'zen' && (
        <div
          style={{ width: sessionWidthForMode(focusMode) }}
          className="relative z-20 shrink-0 overflow-hidden glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none"
        >
          {focusMode === 'focus' ? (
            <FocusStrip
              sessions={state.filteredRecent}
              selectedSessionId={state.sessionId ?? null}
              onSelect={state.handleSelect}
              taskInfoMap={state.taskInfoMap}
              onShowHierarchy={handleShowHierarchy}
              onNewChat={state.handleNewChat}
            />
          ) : (
            sidebarInner
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* Main content area                                                  */}
      {/* ================================================================== */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile header bar */}
        {isMobile && (
          <div className="relative z-20 shrink-0 flex items-center gap-2 px-3 py-2 glass-chrome border-x-0 border-t-0">
            <button
              type="button"
              onClick={() => navigate(`/projects/${state.projectId}/settings`)}
              aria-label="Project settings"
              className="shrink-0 p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
            >
              <Settings size={16} />
            </button>
            <span className="text-sm font-semibold text-fg-primary truncate flex-1">
              {state.project?.name || 'Project'}
            </span>
            {state.hasSessions && (
              <button
                type="button"
                onClick={() => state.setSidebarOpen(true)}
                aria-label="Open chat list"
                className="p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
              >
                <List size={18} />
              </button>
            )}
          </div>
        )}

        {state.showNewChatInput ? (
          /* New chat / empty state */
          <div className="flex-1 flex flex-col min-h-0">
            <div
              className={`flex-1 flex flex-col items-center gap-3 ${isMobile ? 'p-4 justify-end pb-8' : 'p-8 justify-center'}`}
            >
              {state.provisioning ? (
                <ProvisioningIndicator
                  state={state.provisioning}
                  bootLogCount={state.bootLogs.length}
                  onViewLogs={() => state.setBootLogPanelOpen(true)}
                />
              ) : (
                <>
                  <span className="text-base font-semibold text-fg-primary">
                    What do you want to build?
                  </span>
                  <span className="sam-type-secondary text-fg-muted text-center max-w-[400px]">
                    Describe the task and an agent will start working on it automatically.
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-[560px] mt-2">
                    {starterPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => state.setMessage(prompt)}
                        className="min-h-[44px] rounded-md border border-border-default bg-surface px-3 py-2 text-left text-sm text-fg-primary hover:border-accent hover:bg-accent/5 transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {state.pendingDerived && (
              <DerivedSessionBanner
                derived={state.pendingDerived}
                onDismiss={() => state.setPendingDerived(null)}
              />
            )}
            <ChatInput
              value={state.message}
              onChange={state.setMessage}
              onSubmit={state.handleSubmit}
              submitting={state.submitting || (state.pendingDerived?.summaryLoading ?? false)}
              error={state.submitError}
              placeholder="Describe what you want the agent to do..."
              transcribeApiUrl={state.transcribeApiUrl}
              projectId={state.projectId}
              agents={state.configuredAgents}
              agentProfiles={state.agentProfiles}
              selectedProfileId={state.selectedProfileId}
              onProfileChange={state.setSelectedProfileId}
              skills={state.skills}
              selectedSkillId={state.selectedSkillId}
              onSkillChange={state.setSelectedSkillId}
              onUpdateProfile={state.handleUpdateProfile}
              providerCatalogs={state.providerCatalogs}
              projectDefaultProvider={state.project?.defaultProvider}
              projectDefaultLocation={state.project?.defaultLocation}
              hasUserCloudCredentials={state.hasUserCloudCredentials}
              profileWizard={state.profileWizard}
              onOpenProfileWizard={state.openProfileWizard}
              onCloseProfileWizard={state.closeProfileWizard}
              onUpdateProfileWizard={state.updateProfileWizard}
              onCreateProfileFromWizard={state.createProfileFromWizard}
              suggestProfileName={state.suggestProfileName}
              slashCommands={state.slashCommands}
              attachments={state.chatAttachments}
              onFilesSelected={state.handleChatFilesSelected}
              onRemoveAttachment={state.handleRemoveChatAttachment}
              fileInputRef={state.chatFileInputRef}
              uploading={state.chatUploading}
            />
          </div>
        ) : (
          /* Active session view */
          <div className="flex-1 flex flex-col min-h-0">
            {state.provisioning &&
              state.sessionId === state.provisioning.sessionId &&
              !isTerminal(state.provisioning.status) && (
                <ProvisioningIndicator
                  state={state.provisioning}
                  bootLogCount={state.bootLogs.length}
                  onViewLogs={() => state.setBootLogPanelOpen(true)}
                />
              )}
            <ProjectMessageView
              key={state.sessionId}
              projectId={state.projectId}
              sessionId={activeSessionId}
              isProvisioning={
                !!(
                  state.provisioning &&
                  state.sessionId === state.provisioning.sessionId &&
                  !isTerminal(state.provisioning.status)
                )
              }
              onSessionMutated={() => {
                void state.loadSessions();
              }}
              onRetry={() => {
                const s = state.sessions.find((sess) => sess.id === state.sessionId);
                if (s?.taskId) state.handleRetry(s);
              }}
              onFork={() => {
                const s = state.sessions.find((sess) => sess.id === state.sessionId);
                if (s) state.handleFork(s);
              }}
              sourceContext={selectedSourceContext}
              onCloseConversation={state.handleCloseConversation}
              closingConversation={state.closingConversation}
              closeError={state.closeError}
              agentProfiles={state.agentProfiles}
              slashCommands={state.slashCommands}
              onShowHierarchy={handleShowHierarchy}
              onNewChat={state.handleNewChat}
            />
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* Mobile session drawer                                              */}
      {/* ================================================================== */}
      {isMobile && state.sidebarOpen && state.hasSessions && (
        <MobileSessionDrawer
          sessions={state.sessions}
          selectedSessionId={state.sessionId ?? null}
          onSelect={state.handleSelect}
          onNewChat={() => {
            state.setSidebarOpen(false);
            state.handleNewChat();
          }}
          onClose={() => state.setSidebarOpen(false)}
          realtimeDegraded={state.realtimeDegraded}
          isRefreshing={state.isRefreshing}
          onRefresh={() => void state.loadSessions()}
          taskInfoMap={state.taskInfoMap}
          onShowHierarchy={handleShowHierarchy}
          sessionScope={state.sessionScope}
          onSessionScopeChange={state.setSessionScope}
          showOwnership={state.multiplayerActive}
        />
      )}

      {/* Boot log panel */}
      {state.bootLogPanelOpen && (
        <BootLogPanel logs={state.bootLogs} onClose={() => state.setBootLogPanelOpen(false)} />
      )}

      {/* Task hierarchy modal */}
      {hierarchyTaskId && (
        <HierarchyModal
          isOpen
          onClose={handleHierarchyClose}
          focusTaskId={hierarchyTaskId}
          taskInfoMap={state.taskInfoMap}
          sessions={state.sessions}
          onNavigate={handleHierarchyNavigate}
        />
      )}
    </div>
  );
}
