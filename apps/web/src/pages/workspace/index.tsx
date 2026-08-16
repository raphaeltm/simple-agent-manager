import '../../styles/acp-chat.css';
import '../../styles/workspace-chrome.css';

import type {
  MultiTerminalHandle,
  MultiTerminalSessionSnapshot,
} from '@simple-agent-manager/terminal';
import { MultiTerminal, Terminal } from '@simple-agent-manager/terminal';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import type { ChatSessionHandle } from '../../components/ChatSession';
import { CommandPalette } from '../../components/CommandPalette';
import { KeyboardShortcutsHelp } from '../../components/KeyboardShortcutsHelp';
import { OrphanedSessionsBanner } from '../../components/OrphanedSessionsBanner';
import type { SidebarTab } from '../../components/WorkspaceSidebar';
import { WorkspaceSidebar } from '../../components/WorkspaceSidebar';
import type { WorkspaceTabItem } from '../../components/WorkspaceTabStrip';
import { WorkspaceTabStrip } from '../../components/WorkspaceTabStrip';
import { useFeatureFlags } from '../../config/features';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useTabOrder } from '../../hooks/useTabOrder';
import { getFileIndex } from '../../lib/api';
import { isSessionActive } from '../../lib/session-utils';
import { isAuthRevoked, TERMINAL_SESSION_STORAGE_PREFIX } from '../../lib/terminal-cleanup';
import { LegacyChatSessionsView } from './LegacyChatSessionsView';
import { MobileErrorBanner } from './MobileErrorBanner';
import type { ViewMode, WorkspaceTab } from './types';
import { ACTIVITY_THROTTLE_MS } from './types';
import { useSessionState } from './useSessionState';
import { useWorkspaceCore } from './useWorkspaceCore';
import { useWorkspaceNavigation } from './useWorkspaceNavigation';
import { useWorkspaceShortcuts } from './useWorkspaceShortcuts';
import { useWorkspaceTabs } from './useWorkspaceTabs';
import { WorkspaceChatView } from './WorkspaceChatView';
import { WorkspaceCreateMenu } from './WorkspaceCreateMenu';
import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceOverlayPanels } from './WorkspaceOverlayPanels';
import { BootProgress, CenteredStatus, MinimalToolbar } from './WorkspaceStatus';

/**
 * Workspace detail page — unified layout for desktop and mobile.
 * Tab strip at top, terminal/chat content below, sidebar on desktop only.
 */
export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();
  const isMobile = useIsMobile();
  const viewParam = searchParams.get('view');
  const sessionIdParam = searchParams.get('sessionId');
  const viewOverride: ViewMode | null =
    viewParam === 'terminal' || viewParam === 'conversation' ? viewParam : null;
  const gitParam = searchParams.get('git');
  const gitFileParam = searchParams.get('file');
  const gitStagedParam = searchParams.get('staged');
  const filesParam = searchParams.get('files');
  const filesPathParam = searchParams.get('path');

  // ── Core workspace state ──
  const core = useWorkspaceCore(id, featureFlags.multiTerminal);

  // ── Navigation (git, files, worktrees) ──
  const nav = useWorkspaceNavigation(
    id,
    navigate,
    searchParams,
    core.workspace?.url,
    core.terminalToken,
    core.isRunning
  );

  // ── UI state ──
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<MultiTerminalSessionSnapshot[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [paletteFileIndex, setPaletteFileIndex] = useState<string[]>([]);
  const [paletteFileIndexLoading, setPaletteFileIndexLoading] = useState(false);

  const multiTerminalRef = useRef<MultiTerminalHandle | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const chatSessionRefs = useRef<Map<string, ChatSessionHandle>>(new Map());
  const paletteFileIndexLoaded = useRef(false);

  const tabOrder = useTabOrder<WorkspaceTab>(id);

  // ── Session state ──
  const sessions = useSessionState(
    id,
    navigate,
    searchParams,
    viewMode,
    setViewMode,
    core.isRunning,
    core.agentSessions,
    core.setAgentSessions,
    core.setError,
    core.loadWorkspaceState,
    nav.activeWorktree,
    chatSessionRefs,
    tabOrder.assignOrder
  );

  // ── View mode auto-selection ──
  useEffect(() => {
    if (sessionIdParam && viewMode !== 'conversation') setViewMode('conversation');
    // Mount-only: applies the initial URL intent once. Re-running on every
    // sessionIdParam/viewMode change would fight deliberate user tab switches
    // (see the ref-guarded effect below for the async-data equivalent of this
    // one-time-apply pattern).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only effect; sessionIdParam/viewMode are read only for their initial-mount values
  }, []);

  const initialViewResolvedRef = useRef(false);
  useEffect(() => {
    if (initialViewResolvedRef.current) return;
    if (viewOverride) {
      initialViewResolvedRef.current = true;
      return;
    }
    if (sessionIdParam) {
      initialViewResolvedRef.current = true;
      return;
    }
    // If workspace has a linked project chat session, auto-select conversation view
    if (core.workspace?.chatSessionId) {
      initialViewResolvedRef.current = true;
      const params = new URLSearchParams(searchParams);
      params.set('view', 'conversation');
      params.set('sessionId', core.workspace.chatSessionId);
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      setViewMode('conversation');
      return;
    }
    if (core.agentSessions.length === 0) return;
    const firstActive = core.agentSessions.find(
      (s) => isSessionActive(s) && !sessions.recentlyStopped.has(s.id)
    );
    if (firstActive) {
      initialViewResolvedRef.current = true;
      const params = new URLSearchParams(searchParams);
      params.set('view', 'conversation');
      params.set('sessionId', firstActive.id);
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      setViewMode('conversation');
    } else {
      initialViewResolvedRef.current = true;
    }
  }, [
    core.agentSessions,
    core.workspace?.chatSessionId,
    viewOverride,
    sessionIdParam,
    id,
    navigate,
    searchParams,
    sessions.recentlyStopped,
  ]);

  // ── Activity throttle ──
  const activityThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTerminalActivity = useCallback(() => {
    if (!id || activityThrottleRef.current) return;
    activityThrottleRef.current = setTimeout(() => {
      activityThrottleRef.current = null;
    }, ACTIVITY_THROTTLE_MS);
    void core.loadWorkspaceState();
  }, [id, core.loadWorkspaceState]);
  useEffect(
    () => () => {
      if (activityThrottleRef.current) clearTimeout(activityThrottleRef.current);
    },
    []
  );

  // ── Tab management ──
  const tabState = useWorkspaceTabs({
    id,
    navigate,
    searchParams,
    viewMode,
    setViewMode,
    isRunning: core.isRunning,
    multiTerminalEnabled: featureFlags.multiTerminal,
    terminalTabs,
    activeTerminalSessionId,
    setActiveTerminalSessionId,
    worktrees: nav.worktrees,
    chatSessionId: core.workspace?.chatSessionId,
    agentSessions: core.agentSessions,
    setAgentSessions: core.setAgentSessions,
    recentlyStopped: sessions.recentlyStopped,
    preferredAgentsBySession: sessions.preferredAgentsBySession,
    agentNameById: sessions.agentNameById,
    activeChatSessionId: sessions.activeChatSessionId,
    handleResumeSession: sessions.handleResumeSession,
    handleAttachSession: sessions.handleAttachSession,
    handleStopSession: sessions.handleStopSession,
    tabOrder,
    multiTerminalRef,
    setCreateMenuOpen,
  });

  // ── Keyboard shortcuts & menus ──
  useEffect(() => {
    if (!createMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node))
        setCreateMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [createMenuOpen]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [mobileMenuOpen]);

  const shortcutHandlers = useWorkspaceShortcuts({
    isRunning: core.isRunning,
    terminalToken: core.terminalToken,
    filesParam,
    gitParam,
    handleCloseFileBrowser: nav.handleCloseFileBrowser,
    handleOpenFileBrowser: nav.handleOpenFileBrowser,
    handleCloseGitPanel: nav.handleCloseGitPanel,
    handleOpenGitChanges: nav.handleOpenGitChanges,
    worktrees: nav.worktrees,
    activeChatSessionId: sessions.activeChatSessionId,
    handleAttachSession: sessions.handleAttachSession,
    handleCreateSession: sessions.handleCreateSession,
    defaultAgentId: sessions.defaultAgentId,
    viewMode,
    chatSessionRefs,
    workspaceTabs: tabState.workspaceTabs,
    activeTabId: tabState.activeTabId,
    handleSelectWorkspaceTab: tabState.handleSelectWorkspaceTab,
    multiTerminalRef,
    handleCreateTerminalTab: tabState.handleCreateTerminalTab,
    setShowCommandPalette,
    setShowShortcutsHelp,
  });

  useEffect(() => {
    if (!showCommandPalette || paletteFileIndexLoaded.current) return;
    if (!core.workspace?.url || !core.terminalToken || !id || !core.isRunning) return;
    paletteFileIndexLoaded.current = true;
    setPaletteFileIndexLoading(true);
    getFileIndex(core.workspace.url, id, core.terminalToken, nav.activeWorktree ?? undefined)
      .then((f) => setPaletteFileIndex(f))
      .catch((e) => console.warn('[palette] Failed:', e))
      .finally(() => setPaletteFileIndexLoading(false));
  }, [
    showCommandPalette,
    core.workspace?.url,
    core.terminalToken,
    id,
    core.isRunning,
    nav.activeWorktree,
  ]);

  const handlePaletteSelectTab = useCallback(
    (tab: WorkspaceTabItem) => {
      const wt = tabState.workspaceTabs.find((t) => t.id === tab.id);
      if (wt) {
        tabState.handleSelectWorkspaceTabRef.current(wt);
        if (wt.kind === 'terminal') multiTerminalRef.current?.focus?.();
        else chatSessionRefs.current.get(wt.sessionId)?.focusInput?.();
      }
    },
    [tabState.workspaceTabs, tabState.handleSelectWorkspaceTabRef]
  );

  // Shared by the desktop aside and mobile overlay WorkspaceSidebar — the two
  // are mutually exclusive on `isMobile`, so a single closure is safe here.
  const handleSidebarSelectTab = (tab: SidebarTab) => {
    const f = tabState.workspaceTabs.find((t) => t.id === tab.id);
    if (f) tabState.handleSelectWorkspaceTab(f);
  };

  // ── Early returns ──
  if (core.loading && !core.workspace)
    return (
      <div
        className="flex items-center justify-center"
        style={{
          height: 'var(--sam-app-height)',
          backgroundColor: 'var(--sam-workspace-chrome-bg)',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  if (core.error && !core.workspace)
    return (
      <div
        className="flex flex-col"
        style={{
          height: 'var(--sam-app-height)',
          backgroundColor: 'var(--sam-workspace-chrome-bg)',
        }}
      >
        <MinimalToolbar onBack={() => navigate('/dashboard')} />
        <CenteredStatus
          color="var(--sam-color-danger-fg)"
          title="Failed to Load Workspace"
          subtitle={core.error}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
              Back to Dashboard
            </Button>
          }
        />
      </div>
    );

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: 'var(--sam-app-height)', backgroundColor: 'var(--sam-workspace-chrome-bg)' }}
    >
      <WorkspaceHeader
        workspace={core.workspace}
        isMobile={isMobile}
        isRunning={core.isRunning}
        terminalToken={core.terminalToken}
        error={core.error}
        gitChangeCount={nav.gitChangeCount}
        gitStatusStale={nav.gitStatusStale}
        worktrees={nav.worktrees}
        activeWorktree={nav.activeWorktree}
        worktreeLoading={nav.worktreeLoading}
        remoteBranches={nav.remoteBranches}
        remoteBranchesLoading={nav.remoteBranchesLoading}
        onBack={() =>
          core.workspace?.projectId
            ? navigate(`/projects/${core.workspace.projectId}`)
            : navigate('/dashboard')
        }
        onClearError={() => core.setError(null)}
        onOpenFileBrowser={nav.handleOpenFileBrowser}
        onOpenGitChanges={nav.handleOpenGitChanges}
        onOpenCommandPalette={() => setShowCommandPalette(true)}
        onOpenMobileMenu={() => setMobileMenuOpen(true)}
        onSelectWorktree={nav.handleSelectWorktree}
        onCreateWorktree={nav.handleCreateWorktree}
        onRemoveWorktree={nav.handleRemoveWorktree}
        onRequestBranches={nav.fetchRemoteBranches}
      />

      {isMobile && core.error && (
        <MobileErrorBanner error={core.error} onClear={() => core.setError(null)} />
      )}

      {core.isRunning && sessions.orphanedSessions.length > 0 && !sessions.dismissedOrphans && (
        <OrphanedSessionsBanner
          orphanedSessions={sessions.orphanedSessions}
          onStopAll={sessions.handleStopAllOrphans}
          onDismiss={() => sessions.setDismissedOrphans(true)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {core.isRunning && (
            <WorkspaceTabStrip
              tabs={tabState.tabStripItems}
              activeTabId={tabState.activeTabId}
              isMobile={isMobile}
              onSelect={tabState.handleSelectTabItem}
              onClose={tabState.handleCloseTabItem}
              onRename={tabState.handleRenameWorkspaceTab}
              onReorder={tabOrder.reorderTab}
              createMenuSlot={
                <WorkspaceCreateMenu
                  createMenuRef={createMenuRef}
                  createMenuOpen={createMenuOpen}
                  setCreateMenuOpen={setCreateMenuOpen}
                  sessionsLoading={sessions.sessionsLoading}
                  isMobile={isMobile}
                  configuredAgents={sessions.configuredAgents}
                  defaultAgentId={sessions.defaultAgentId}
                  defaultAgentName={sessions.defaultAgentName}
                  onCreateTerminalTab={tabState.handleCreateTerminalTab}
                  onCreateSession={(agentId) => void sessions.handleCreateSession(agentId)}
                />
              }
            />
          )}
          <div className="flex flex-col flex-1 min-h-0 relative">
            {core.isRunning ? (
              <>
                <div
                  className="h-full"
                  style={{ display: viewMode === 'terminal' ? 'block' : 'none' }}
                >
                  {core.wsUrl ? (
                    featureFlags.multiTerminal ? (
                      <MultiTerminal
                        ref={multiTerminalRef}
                        wsUrl={core.wsUrl}
                        resolveWsUrl={core.resolveTerminalWsUrl}
                        defaultWorkDir={nav.activeWorktree ?? undefined}
                        onActivity={handleTerminalActivity}
                        className="h-full"
                        persistenceKey={id ? `${TERMINAL_SESSION_STORAGE_PREFIX}${id}` : undefined}
                        hideTabBar
                        onSessionsChange={(s: MultiTerminalSessionSnapshot[], a: string | null) => {
                          setTerminalTabs(s);
                          setActiveTerminalSessionId(a);
                        }}
                        shouldSuppressReconnect={isAuthRevoked}
                      />
                    ) : (
                      <Terminal
                        wsUrl={core.wsUrl}
                        resolveWsUrl={core.resolveTerminalWsUrl}
                        onActivity={handleTerminalActivity}
                        className="h-full"
                        shouldSuppressReconnect={isAuthRevoked}
                      />
                    )
                  ) : core.terminalLoading ? (
                    <CenteredStatus
                      color="var(--sam-color-info)"
                      title="Connecting to Terminal..."
                      subtitle="Establishing secure connection"
                      loading
                    />
                  ) : (
                    <CenteredStatus
                      color="var(--sam-color-danger-fg)"
                      title="Connection Failed"
                      subtitle={core.terminalError || 'Unable to connect to terminal'}
                      action={
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            core.terminalWsUrlCacheRef.current = null;
                            void core.refreshTerminalToken();
                          }}
                          disabled={core.terminalLoading}
                        >
                          Retry Connection
                        </Button>
                      }
                    />
                  )}
                </div>
                {/* Chat view — use ProjectMessageView when workspace is linked to a project chat session.
                    This reuses the stable project chat component, avoiding the render-loop crashes
                    that plagued the workspace-specific ChatSession component. */}
                {viewMode === 'conversation' &&
                core.workspace?.projectId &&
                core.workspace?.chatSessionId ? (
                  <div className="flex flex-col flex-1 min-h-0">
                    <WorkspaceChatView
                      projectId={core.workspace.projectId}
                      sessionId={core.workspace.chatSessionId}
                    />
                  </div>
                ) : viewMode === 'conversation' && id && core.workspace?.url ? (
                  /* Fallback: workspace without a linked project session — use legacy ChatSession */
                  <LegacyChatSessionsView
                    workspaceId={id}
                    workspaceUrl={core.workspace.url}
                    runningChatSessions={sessions.runningChatSessions}
                    preferredAgentsBySession={sessions.preferredAgentsBySession}
                    configuredAgents={sessions.configuredAgents}
                    activeChatSessionId={sessions.activeChatSessionId}
                    onActivity={handleTerminalActivity}
                    onUsageChange={sessions.handleUsageChange}
                    chatSessionRefs={chatSessionRefs}
                  />
                ) : null}
              </>
            ) : core.workspace?.status === 'creating' ? (
              <BootProgress
                logs={
                  core.streamedBootLogs.length > 0 ? core.streamedBootLogs : core.workspace.bootLogs
                }
              />
            ) : core.workspace?.status === 'stopping' ? (
              <CenteredStatus
                color="var(--sam-color-warning-fg)"
                title="Stopping Workspace"
                loading
              />
            ) : core.workspace?.status === 'stopped' ? (
              <CenteredStatus
                color="var(--sam-color-fg-muted)"
                title="Workspace Stopped"
                subtitle="Restart to access the terminal."
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={core.handleRestart}
                    disabled={core.actionLoading}
                    loading={core.actionLoading}
                  >
                    Restart Workspace
                  </Button>
                }
              />
            ) : core.workspace?.status === 'error' ? (
              <CenteredStatus
                color="var(--sam-color-danger-fg)"
                title="Workspace Error"
                subtitle={core.workspace?.errorMessage || 'An unexpected error occurred.'}
                action={
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={core.handleRebuild}
                      disabled={core.actionLoading}
                      loading={core.actionLoading}
                    >
                      Rebuild Container
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={core.handleRestart}
                      disabled={core.actionLoading}
                      loading={core.actionLoading}
                    >
                      Restart Workspace
                    </Button>
                  </div>
                }
              />
            ) : null}
          </div>
        </div>
        {!isMobile && (
          <aside className="flex flex-col w-80 min-w-80 border-l border-border-default bg-surface">
            <WorkspaceSidebar
              workspace={core.workspace}
              isRunning={core.isRunning}
              isMobile={isMobile}
              actionLoading={core.actionLoading}
              onStop={core.handleStop}
              onRestart={core.handleRestart}
              onRebuild={core.handleRebuild}
              displayNameInput={core.displayNameInput}
              onDisplayNameChange={core.setDisplayNameInput}
              onRename={core.handleRename}
              renaming={core.renaming}
              workspaceTabs={tabState.workspaceTabs}
              activeTabId={tabState.activeTabId}
              onSelectTab={handleSidebarSelectTab}
              onStopSession={sessions.handleStopSession}
              historySessions={sessions.historySessions}
              onResumeSession={sessions.handleResumeSession}
              onDeleteSession={sessions.handleDeleteHistorySession}
              gitStatus={nav.gitStatus}
              onOpenGitChanges={nav.handleOpenGitChanges}
              sessionTokenUsages={sessions.sessionTokenUsages}
              detectedPorts={core.detectedPorts}
              workspaceEvents={core.workspaceEvents}
            />
          </aside>
        )}
      </div>

      {isMobile && mobileMenuOpen && (
        <>
          <div
            data-testid="mobile-menu-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 glass-backdrop-dim z-drawer-backdrop"
          />
          <div
            role="dialog"
            aria-label="Workspace menu"
            data-testid="mobile-menu-panel"
            className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-[360px] glass-modal glass-panel-container glass-composited border-l border-border-default z-drawer flex flex-col overflow-hidden"
          >
            <div
              className="flex items-center justify-between border-b border-border-default shrink-0"
              style={{ padding: 'var(--sam-space-3) var(--sam-space-4)' }}
            >
              <span
                className="font-semibold text-fg-primary"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Workspace
              </span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close workspace menu"
                className="bg-transparent border-none cursor-pointer text-fg-muted p-2 flex items-center justify-center min-w-[44px] min-h-[44px]"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex flex-col flex-1 overflow-auto">
              <WorkspaceSidebar
                workspace={core.workspace}
                isRunning={core.isRunning}
                isMobile={isMobile}
                actionLoading={core.actionLoading}
                onStop={core.handleStop}
                onRestart={core.handleRestart}
                onRebuild={core.handleRebuild}
                displayNameInput={core.displayNameInput}
                onDisplayNameChange={core.setDisplayNameInput}
                onRename={core.handleRename}
                renaming={core.renaming}
                workspaceTabs={tabState.workspaceTabs}
                activeTabId={tabState.activeTabId}
                onSelectTab={handleSidebarSelectTab}
                onStopSession={sessions.handleStopSession}
                historySessions={sessions.historySessions}
                onResumeSession={sessions.handleResumeSession}
                onDeleteSession={sessions.handleDeleteHistorySession}
                gitStatus={nav.gitStatus}
                onOpenGitChanges={nav.handleOpenGitChanges}
                sessionTokenUsages={sessions.sessionTokenUsages}
                detectedPorts={core.detectedPorts}
                workspaceEvents={core.workspaceEvents}
              />
            </div>
          </div>
        </>
      )}

      <WorkspaceOverlayPanels
        gitParam={gitParam}
        gitFileParam={gitFileParam}
        gitStagedParam={gitStagedParam}
        filesParam={filesParam}
        filesPathParam={filesPathParam}
        terminalToken={core.terminalToken}
        workspaceUrl={core.workspace?.url}
        workspaceId={id}
        activeWorktree={nav.activeWorktree}
        isMobile={isMobile}
        onCloseGitPanel={nav.handleCloseGitPanel}
        onNavigateToGitDiff={nav.handleNavigateToGitDiff}
        onApplyGitStatus={nav.applyGitStatus}
        onMarkGitStatusStale={nav.markGitStatusStale}
        onBackFromGitDiff={nav.handleBackFromGitDiff}
        onGitDiffToFileBrowser={nav.handleGitDiffToFileBrowser}
        onCloseFileBrowser={nav.handleCloseFileBrowser}
        onFileViewerOpen={nav.handleFileViewerOpen}
        onFileBrowserNavigate={nav.handleFileBrowserNavigate}
        onFileViewerBack={nav.handleFileViewerBack}
        onFileViewerToDiff={nav.handleFileViewerToDiff}
      />
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          handlers={shortcutHandlers}
          tabs={tabState.tabStripItems}
          fileIndex={paletteFileIndex}
          fileIndexLoading={paletteFileIndexLoading}
          onSelectTab={handlePaletteSelectTab}
          onSelectFile={(fp: string) => nav.handleFileViewerOpen(fp)}
        />
      )}
    </div>
  );
}
