import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, LayoutGrid, List, Search, Settings, X } from 'lucide-react';
import { useState } from 'react';

import { BootLogPanel } from '../../components/chat/BootLogPanel';
import { ForkDialog } from '../../components/project/ForkDialog';
import { TriggerDropdown } from '../../components/triggers/TriggerDropdown';
import { ProjectMessageView } from '../../components/project-message-view';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ChatInput } from './ChatInput';
import { MobileSessionDrawer } from './MobileSessionDrawer';
import { ProvisioningIndicator } from './ProvisioningIndicator';
import { SessionList } from './SessionList';
import { isTerminal } from './types';
import { useProjectChatState } from './useProjectChatState';

export function ProjectChat() {
  const isMobile = useIsMobile();
  const state = useProjectChatState();
  const [triggerDropdownOpen, setTriggerDropdownOpen] = useState(false);

  // Loading state
  if (state.loading && state.sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ================================================================== */}
      {/* Desktop sidebar                                                    */}
      {/* ================================================================== */}
      {!isMobile && (
        <div className="w-72 shrink-0 border-r border-border-default flex flex-col bg-surface">
          {/* Sidebar header: project name + action buttons */}
          <div className="shrink-0 px-3 py-2.5 border-b border-border-default flex items-center gap-2">
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
            <button
              type="button"
              onClick={() => state.setInfoPanelOpen(!state.infoPanelOpen)}
              title="Project status"
              aria-label="Project status"
              className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
            >
              <LayoutGrid size={15} />
            </button>
            <TriggerDropdown
              projectId={state.projectId}
              open={triggerDropdownOpen}
              onToggle={() => setTriggerDropdownOpen((prev) => !prev)}
            />
            <button
              type="button"
              onClick={() => state.setSettingsOpen(!state.settingsOpen)}
              title="Project settings"
              aria-label="Project settings"
              className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
            >
              <Settings size={15} />
            </button>
          </div>

          {/* New chat button */}
          <div className="shrink-0 p-2 border-b border-border-default">
            <button
              type="button"
              onClick={state.handleNewChat}
              className="w-full py-1.5 px-3 rounded-md border border-border-default bg-transparent cursor-pointer text-fg-primary text-xs font-medium hover:bg-surface-hover transition-colors"
            >
              + New Chat
            </button>
          </div>

          {/* Subtle refresh indicator */}
          {state.isRefreshing && (
            <div className="h-0.5 bg-accent animate-pulse" role="status" aria-label="Refreshing sessions" />
          )}

          {/* Search */}
          {state.hasSessions && (
            <div className="shrink-0 px-2 py-1.5 border-b border-border-default">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
                <input
                  type="text"
                  value={state.searchQuery}
                  onChange={(e) => state.setSearchQuery(e.target.value)}
                  placeholder="Search chats..."
                  className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-border-default bg-transparent text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent-primary"
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
            </div>
          )}

          {/* Session list — scrollable */}
          {state.hasSessions ? (
            <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
              <SessionList
                sessions={state.filteredRecent}
                selectedSessionId={state.sessionId ?? null}
                onSelect={state.handleSelect}
                onFork={state.setForkSession}
                taskTitleMap={state.taskTitleMap}
                taskInfoMap={state.taskInfoMap}
                searchQuery={state.searchQuery}
              />
              {state.filteredStale.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => state.setShowStale(!state.effectiveShowStale)}
                    className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted bg-transparent border-none border-b border-border-default cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    {state.effectiveShowStale ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>Older ({state.filteredStale.length})</span>
                  </button>
                  {state.effectiveShowStale && (
                    <SessionList
                      sessions={state.filteredStale}
                      selectedSessionId={state.sessionId ?? null}
                      onSelect={state.handleSelect}
                      onFork={state.setForkSession}
                      taskTitleMap={state.taskTitleMap}
                      taskInfoMap={state.taskInfoMap}
                      searchQuery={state.searchQuery}
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
              <span className="text-xs text-fg-muted text-center">No chats yet. Start a new one above.</span>
            </div>
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* Main content area                                                  */}
      {/* ================================================================== */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile header bar */}
        {isMobile && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-default bg-surface">
            <button
              type="button"
              onClick={() => state.setSettingsOpen(!state.settingsOpen)}
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
            <div className={`flex-1 flex flex-col items-center gap-3 ${isMobile ? 'p-4 justify-end pb-8' : 'p-8 justify-center'}`}>
              {state.provisioning ? (
                <ProvisioningIndicator state={state.provisioning} bootLogCount={state.bootLogs.length} onViewLogs={() => state.setBootLogPanelOpen(true)} />
              ) : (
                <>
                  <span className="text-base font-semibold text-fg-primary">
                    What do you want to build?
                  </span>
                  <span className="sam-type-secondary text-fg-muted text-center max-w-[400px]">
                    Describe the task and an agent will start working on it automatically.
                  </span>
                </>
              )}
            </div>
            <ChatInput
              value={state.message}
              onChange={state.setMessage}
              onSubmit={state.handleSubmit}
              submitting={state.submitting}
              error={state.submitError}
              placeholder="Describe what you want the agent to do..."
              transcribeApiUrl={state.transcribeApiUrl}
              agents={state.configuredAgents}
              selectedAgentType={state.selectedAgentType}
              onAgentTypeChange={state.setSelectedAgentType}
              agentProfiles={state.agentProfiles}
              selectedProfileId={state.selectedProfileId}
              onProfileChange={state.setSelectedProfileId}
              onUpdateProfile={state.handleUpdateProfile}
              selectedWorkspaceProfile={state.selectedWorkspaceProfile}
              onWorkspaceProfileChange={state.setSelectedWorkspaceProfile}
              selectedTaskMode={state.selectedTaskMode}
              onTaskModeChange={state.handleTaskModeChange}
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
            {state.provisioning && state.sessionId === state.provisioning.sessionId && !isTerminal(state.provisioning.status) && (
              <ProvisioningIndicator state={state.provisioning} bootLogCount={state.bootLogs.length} onViewLogs={() => state.setBootLogPanelOpen(true)} />
            )}
            <ProjectMessageView
              key={state.sessionId}
              projectId={state.projectId}
              sessionId={state.sessionId!}
              isProvisioning={!!(state.provisioning && state.sessionId === state.provisioning.sessionId && !isTerminal(state.provisioning.status))}
              onSessionMutated={() => { void state.loadSessions(); }}
            />
            {/* Close conversation button — shown for idle sessions with a task */}
            {(() => {
              const selectedSession = state.sessions.find((s) => s.id === state.sessionId);
              if (!selectedSession?.taskId) return null;
              const sessionState = state.getSessionState(selectedSession);
              if (sessionState !== 'idle') return null;
              return (
                <div className="shrink-0 border-t border-border-default px-4 py-2 bg-surface flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={state.handleCloseConversation}
                    disabled={state.closingConversation}
                    className="px-4 py-2.5 min-h-[44px] text-xs rounded-md border border-border-default bg-page text-fg-muted hover:text-fg-primary hover:border-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {state.closingConversation ? 'Closing...' : 'Close conversation'}
                  </button>
                  {state.closeError && <p className="text-xs text-red-500">{state.closeError}</p>}
                </div>
              );
            })()}
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
          onFork={(session) => { state.setSidebarOpen(false); state.setForkSession(session); }}
          onNewChat={() => { state.setSidebarOpen(false); state.handleNewChat(); }}
          onClose={() => state.setSidebarOpen(false)}
          realtimeDegraded={state.realtimeDegraded}
          isRefreshing={state.isRefreshing}
          onRefresh={() => void state.loadSessions()}
          taskTitleMap={state.taskTitleMap}
          taskInfoMap={state.taskInfoMap}
        />
      )}

      {/* Fork dialog */}
      <ForkDialog
        open={!!state.forkSession}
        session={state.forkSession}
        projectId={state.projectId}
        onClose={() => state.setForkSession(null)}
        onFork={state.handleFork}
      />

      {/* Boot log panel */}
      {state.bootLogPanelOpen && (
        <BootLogPanel
          logs={state.bootLogs}
          onClose={() => state.setBootLogPanelOpen(false)}
        />
      )}
    </div>
  );
}
