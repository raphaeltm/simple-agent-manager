import '../../styles/acp-chat.css';

import type { AgentSession } from '@simple-agent-manager/shared';
import type { MultiTerminalHandle, MultiTerminalSessionSnapshot } from '@simple-agent-manager/terminal';
import { MultiTerminal, Terminal } from '@simple-agent-manager/terminal';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import type { ChatSessionHandle } from '../../components/ChatSession';
import { ChatSession } from '../../components/ChatSession';
import { CommandPalette } from '../../components/CommandPalette';
import { FileBrowserPanel } from '../../components/FileBrowserPanel';
import { FileViewerPanel } from '../../components/FileViewerPanel';
import { GitChangesPanel } from '../../components/GitChangesPanel';
import { GitDiffView } from '../../components/GitDiffView';
import { KeyboardShortcutsHelp } from '../../components/KeyboardShortcutsHelp';
import { OrphanedSessionsBanner } from '../../components/OrphanedSessionsBanner';
import type { SidebarTab } from '../../components/WorkspaceSidebar';
import { WorkspaceSidebar } from '../../components/WorkspaceSidebar';
import type { WorkspaceTabItem } from '../../components/WorkspaceTabStrip';
import { WorkspaceTabStrip } from '../../components/WorkspaceTabStrip';
import { useFeatureFlags } from '../../config/features';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTabOrder } from '../../hooks/useTabOrder';
import { getFileIndex, listAgentSessions, renameAgentSession } from '../../lib/api';
import { isSessionActive } from '../../lib/session-utils';

import type { ViewMode, WorkspaceTab } from './types';
import { ACTIVITY_THROTTLE_MS, deriveWorktreeBadge, workspaceTabStatusColor } from './types';
import { useSessionState } from './useSessionState';
import { useWorkspaceCore } from './useWorkspaceCore';
import { useWorkspaceNavigation } from './useWorkspaceNavigation';
import { WorkspaceCreateMenu } from './WorkspaceCreateMenu';
import { WorkspaceHeader } from './WorkspaceHeader';
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
    id, navigate, searchParams, core.workspace?.url, core.terminalToken, core.isRunning
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
    id, navigate, searchParams, viewMode, setViewMode,
    core.isRunning, core.agentSessions, core.setAgentSessions, core.setError,
    core.loadWorkspaceState, nav.activeWorktree, chatSessionRefs, tabOrder.assignOrder
  );

  // ── View mode auto-selection ──
  useEffect(() => {
    if (sessionIdParam && viewMode !== 'conversation') setViewMode('conversation');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const initialViewResolvedRef = useRef(false);
  useEffect(() => {
    if (initialViewResolvedRef.current) return;
    if (viewOverride) { initialViewResolvedRef.current = true; return; }
    if (sessionIdParam) { initialViewResolvedRef.current = true; return; }
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
  }, [core.agentSessions, viewOverride, sessionIdParam, id, navigate, searchParams, sessions.recentlyStopped]);

  // ── Activity throttle ──
  const activityThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTerminalActivity = useCallback(() => {
    if (!id || activityThrottleRef.current) return;
    activityThrottleRef.current = setTimeout(() => { activityThrottleRef.current = null; }, ACTIVITY_THROTTLE_MS);
    void core.loadWorkspaceState();
  }, [id, core.loadWorkspaceState]);
  useEffect(() => () => { if (activityThrottleRef.current) clearTimeout(activityThrottleRef.current); }, []);

  // ── Tab management ──
  const visibleTerminalTabs = useMemo<MultiTerminalSessionSnapshot[]>(
    () => (!core.isRunning || !featureFlags.multiTerminal) ? [] : terminalTabs,
    [featureFlags.multiTerminal, core.isRunning, terminalTabs]
  );

  const workspaceTabs = useMemo<WorkspaceTab[]>(() => {
    const termTabs: WorkspaceTab[] = visibleTerminalTabs.map((s) => ({
      id: `terminal:${s.id}`, kind: 'terminal', sessionId: s.id, title: s.name,
      status: s.status, badge: deriveWorktreeBadge(s.workingDirectory, nav.worktrees),
    }));
    const chatTabs: WorkspaceTab[] = core.agentSessions
      .filter((s) => (isSessionActive(s) || s.status === 'suspended') && !sessions.recentlyStopped.has(s.id))
      .map((s) => {
        const pref = sessions.preferredAgentsBySession[s.id];
        const prefName = pref ? sessions.agentNameById.get(pref) : undefined;
        const title = s.label?.trim() || (prefName ? `${prefName} Chat` : `Chat ${s.id.slice(-4)}`);
        return {
          id: `chat:${s.id}`, kind: 'chat' as const, sessionId: s.id, title,
          status: s.status, hostStatus: s.hostStatus, viewerCount: s.viewerCount,
          badge: deriveWorktreeBadge(s.worktreePath ?? undefined, nav.worktrees),
        };
      });
    return tabOrder.getSortedTabs([...termTabs, ...chatTabs]);
  }, [sessions.agentNameById, core.agentSessions, sessions.preferredAgentsBySession, sessions.recentlyStopped, tabOrder, visibleTerminalTabs, nav.worktrees]);

  const handleCreateTerminalTab = () => {
    setViewMode('terminal');
    const params = new URLSearchParams(searchParams);
    params.set('view', 'terminal'); params.delete('sessionId');
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    const sid = multiTerminalRef.current?.createSession();
    if (sid) { tabOrder.assignOrder(`terminal:${sid}`); setActiveTerminalSessionId(sid); multiTerminalRef.current?.activateSession(sid); }
    setCreateMenuOpen(false);
  };

  const handleSelectWorkspaceTab = (tab: WorkspaceTab) => {
    if (tab.kind === 'terminal') {
      setViewMode('terminal');
      const params = new URLSearchParams(searchParams);
      params.set('view', 'terminal'); params.delete('sessionId');
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      multiTerminalRef.current?.activateSession(tab.sessionId);
      return;
    }
    if (tab.status === 'suspended') { void sessions.handleResumeSession(tab.sessionId); return; }
    sessions.handleAttachSession(tab.sessionId);
  };

  const activeTabId = useMemo(() => {
    if (viewMode === 'terminal') {
      return activeTerminalSessionId ? `terminal:${activeTerminalSessionId}`
        : visibleTerminalTabs.length > 0 ? `terminal:${visibleTerminalTabs[0]!.id}` : null;
    }
    return sessions.activeChatSessionId ? `chat:${sessions.activeChatSessionId}` : null;
  }, [sessions.activeChatSessionId, activeTerminalSessionId, viewMode, visibleTerminalTabs]);

  const handleCloseWorkspaceTab = (tab: WorkspaceTab) => {
    if (activeTabId === tab.id) {
      const ci = workspaceTabs.findIndex((c) => c.id === tab.id);
      const remaining = workspaceTabs.filter((c) => c.id !== tab.id);
      if (remaining.length > 0) handleSelectWorkspaceTab(remaining[Math.min(ci, remaining.length - 1)]!);
      else {
        setViewMode('terminal'); setActiveTerminalSessionId(null);
        const params = new URLSearchParams(searchParams);
        params.set('view', 'terminal'); params.delete('sessionId');
        navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      }
    }
    tabOrder.removeTab(tab.id);
    if (tab.kind === 'terminal') { multiTerminalRef.current?.closeSession(tab.sessionId); return; }
    void sessions.handleStopSession(tab.sessionId);
  };

  const handleRenameWorkspaceTab = useCallback(
    (tabItem: WorkspaceTabItem, newName: string) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (!tab) return;
      if (tab.kind === 'terminal') multiTerminalRef.current?.renameSession(tab.sessionId, newName);
      else if (tab.kind === 'chat' && id) {
        core.setAgentSessions((prev) => prev.map((s) => (s.id === tab.sessionId ? { ...s, label: newName } : s)));
        void renameAgentSession(id, tab.sessionId, newName).catch(() => { void listAgentSessions(id).then(core.setAgentSessions); });
      }
    },
    [id, workspaceTabs, core.setAgentSessions]
  );

  const handleSelectTabItem = useCallback(
    (ti: WorkspaceTabItem) => { const t = workspaceTabs.find((w) => w.id === ti.id); if (t) handleSelectWorkspaceTab(t); },
    [workspaceTabs] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const handleCloseTabItem = useCallback(
    (ti: WorkspaceTabItem) => { const t = workspaceTabs.find((w) => w.id === ti.id); if (t) handleCloseWorkspaceTab(t); },
    [workspaceTabs] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const tabStripItems = useMemo<WorkspaceTabItem[]>(
    () => workspaceTabs.map((t) => ({
      id: t.id, kind: t.kind, sessionId: t.sessionId, title: t.title,
      statusColor: workspaceTabStatusColor(t), badge: t.badge,
      dimmed: t.kind === 'chat' && t.status === 'suspended',
    })),
    [workspaceTabs]
  );

  // ── Keyboard shortcuts & menus ──
  useEffect(() => {
    if (!createMenuOpen) return;
    const h = (e: MouseEvent) => { if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) setCreateMenuOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [createMenuOpen]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileMenuOpen(false); };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, [mobileMenuOpen]);

  const shortcutHandlers = {
    'toggle-file-browser': () => { if (core.isRunning && core.terminalToken) { filesParam ? nav.handleCloseFileBrowser() : nav.handleOpenFileBrowser(); } },
    'toggle-git-changes': () => { if (core.isRunning && core.terminalToken) { gitParam ? nav.handleCloseGitPanel() : nav.handleOpenGitChanges(); } },
    'focus-chat': () => { if (sessions.activeChatSessionId) { if (viewMode !== 'conversation') sessions.handleAttachSession(sessions.activeChatSessionId); requestAnimationFrame(() => chatSessionRefs.current.get(sessions.activeChatSessionId!)?.focusInput()); } },
    'focus-terminal': () => { if (viewMode !== 'terminal') { const ft = workspaceTabs.find((t) => t.kind === 'terminal'); if (ft) handleSelectWorkspaceTab(ft); } requestAnimationFrame(() => multiTerminalRef.current?.focus()); },
    'switch-worktree': () => { if (core.isRunning && nav.worktrees.length > 0) document.getElementById('worktree-selector-trigger')?.click(); },
    'next-tab': () => { if (workspaceTabs.length > 1) { const ci = workspaceTabs.findIndex((t) => t.id === activeTabId); handleSelectWorkspaceTab(workspaceTabs[(ci + 1) % workspaceTabs.length]!); } },
    'prev-tab': () => { if (workspaceTabs.length > 1) { const ci = workspaceTabs.findIndex((t) => t.id === activeTabId); handleSelectWorkspaceTab(workspaceTabs[ci <= 0 ? workspaceTabs.length - 1 : ci - 1]!); } },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab-${i + 1}`, () => { if (i < workspaceTabs.length) handleSelectWorkspaceTab(workspaceTabs[i]!); }])),
    'new-chat': () => { if (core.isRunning) void sessions.handleCreateSession(sessions.defaultAgentId ?? undefined); },
    'new-terminal': () => { if (core.isRunning) handleCreateTerminalTab(); },
    'command-palette': () => { setShowCommandPalette((p) => !p); setShowShortcutsHelp(false); },
    'show-shortcuts': () => setShowShortcutsHelp((p) => !p),
  };
  useKeyboardShortcuts(shortcutHandlers, core.isRunning);

  useEffect(() => {
    if (!showCommandPalette || paletteFileIndexLoaded.current) return;
    if (!core.workspace?.url || !core.terminalToken || !id || !core.isRunning) return;
    paletteFileIndexLoaded.current = true;
    setPaletteFileIndexLoading(true);
    getFileIndex(core.workspace.url, id, core.terminalToken, nav.activeWorktree ?? undefined)
      .then((f) => setPaletteFileIndex(f)).catch((e) => console.warn('[palette] Failed:', e))
      .finally(() => setPaletteFileIndexLoading(false));
  }, [showCommandPalette, core.workspace?.url, core.terminalToken, id, core.isRunning, nav.activeWorktree]);

  const handlePaletteSelectTab = useCallback(
    (tab: WorkspaceTabItem) => { const wt = workspaceTabs.find((t) => t.id === tab.id); if (wt) { handleSelectWorkspaceTab(wt); if (wt.kind === 'terminal') multiTerminalRef.current?.focus?.(); else chatSessionRefs.current.get(wt.sessionId)?.focusInput?.(); } },
    [workspaceTabs] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Early returns ──
  if (core.loading && !core.workspace) return <div className="flex items-center justify-center bg-tn-bg" style={{ height: 'var(--sam-app-height)' }}><Spinner size="lg" /></div>;
  if (core.error && !core.workspace) return (
    <div className="flex flex-col bg-tn-bg" style={{ height: 'var(--sam-app-height)' }}>
      <MinimalToolbar onBack={() => navigate('/dashboard')} />
      <CenteredStatus color="var(--sam-color-danger-fg)" title="Failed to Load Workspace" subtitle={core.error} action={<Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>Back to Dashboard</Button>} />
    </div>
  );

  return (
    <div className="flex flex-col bg-tn-bg overflow-hidden" style={{ height: 'var(--sam-app-height)' }}>
      <WorkspaceHeader workspace={core.workspace} isMobile={isMobile} isRunning={core.isRunning} terminalToken={core.terminalToken}
        error={core.error} gitChangeCount={nav.gitChangeCount} gitStatusStale={nav.gitStatusStale}
        worktrees={nav.worktrees} activeWorktree={nav.activeWorktree} worktreeLoading={nav.worktreeLoading}
        remoteBranches={nav.remoteBranches} remoteBranchesLoading={nav.remoteBranchesLoading}
        onBack={() => core.workspace?.projectId ? navigate(`/projects/${core.workspace.projectId}`) : navigate('/dashboard')}
        onClearError={() => core.setError(null)} onOpenFileBrowser={nav.handleOpenFileBrowser}
        onOpenGitChanges={nav.handleOpenGitChanges} onOpenCommandPalette={() => setShowCommandPalette(true)}
        onOpenMobileMenu={() => setMobileMenuOpen(true)} onSelectWorktree={nav.handleSelectWorktree}
        onCreateWorktree={nav.handleCreateWorktree} onRemoveWorktree={nav.handleRemoveWorktree} onRequestBranches={nav.fetchRemoteBranches} />

      {isMobile && core.error && (
        <div style={{ padding: '6px 12px', backgroundColor: 'var(--sam-color-danger-tint)', borderBottom: '1px solid rgba(248, 113, 113, 0.3)', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-danger-fg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{core.error}</span>
          <button onClick={() => core.setError(null)} style={{ background: 'none', border: 'none', color: 'var(--sam-color-danger-fg)', cursor: 'pointer', padding: '4px 8px', fontSize: 'var(--sam-type-secondary-size)', flexShrink: 0 }}>×</button>
        </div>
      )}

      {core.isRunning && sessions.orphanedSessions.length > 0 && !sessions.dismissedOrphans && (
        <OrphanedSessionsBanner orphanedSessions={sessions.orphanedSessions} onStopAll={sessions.handleStopAllOrphans} onDismiss={() => sessions.setDismissedOrphans(true)} />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {core.isRunning && (
            <WorkspaceTabStrip tabs={tabStripItems} activeTabId={activeTabId} isMobile={isMobile}
              onSelect={handleSelectTabItem} onClose={handleCloseTabItem} onRename={handleRenameWorkspaceTab} onReorder={tabOrder.reorderTab}
              createMenuSlot={<WorkspaceCreateMenu createMenuRef={createMenuRef} createMenuOpen={createMenuOpen} setCreateMenuOpen={setCreateMenuOpen} sessionsLoading={sessions.sessionsLoading} isMobile={isMobile} configuredAgents={sessions.configuredAgents} defaultAgentId={sessions.defaultAgentId} defaultAgentName={sessions.defaultAgentName} onCreateTerminalTab={handleCreateTerminalTab} onCreateSession={(agentId) => void sessions.handleCreateSession(agentId)} />} />
          )}
          <div className="flex flex-col flex-1 min-h-0 relative">
            {core.isRunning ? (
              <>
                <div className="h-full" style={{ display: viewMode === 'terminal' ? 'block' : 'none' }}>
                  {core.wsUrl ? (
                    featureFlags.multiTerminal ? (
                      <MultiTerminal ref={multiTerminalRef} wsUrl={core.wsUrl} resolveWsUrl={core.resolveTerminalWsUrl} defaultWorkDir={nav.activeWorktree ?? undefined} onActivity={handleTerminalActivity} className="h-full" persistenceKey={id ? `sam-terminal-sessions-${id}` : undefined} hideTabBar
                        onSessionsChange={(s: MultiTerminalSessionSnapshot[], a: string | null) => { setTerminalTabs(s); setActiveTerminalSessionId(a); }} />
                    ) : <Terminal wsUrl={core.wsUrl} resolveWsUrl={core.resolveTerminalWsUrl} onActivity={handleTerminalActivity} className="h-full" />
                  ) : core.terminalLoading ? (
                    <CenteredStatus color="var(--sam-color-info)" title="Connecting to Terminal..." subtitle="Establishing secure connection" loading />
                  ) : (
                    <CenteredStatus color="var(--sam-color-danger-fg)" title="Connection Failed" subtitle={core.terminalError || 'Unable to connect to terminal'}
                      action={<Button variant="secondary" size="sm" onClick={() => { core.terminalWsUrlCacheRef.current = null; void core.refreshTerminalToken(); }} disabled={core.terminalLoading}>Retry Connection</Button>} />
                  )}
                </div>
                {id && core.workspace?.url && sessions.runningChatSessions.map((session: AgentSession) => (
                  <ChatSession key={session.id} ref={(h) => { if (h) chatSessionRefs.current.set(session.id, h); else chatSessionRefs.current.delete(session.id); }}
                    workspaceId={id} workspaceUrl={core.workspace!.url!} sessionId={session.id} worktreePath={session.worktreePath}
                    preferredAgentId={session.agentType || sessions.preferredAgentsBySession[session.id] || (sessions.configuredAgents.length > 0 ? sessions.configuredAgents[0]!.id : undefined)}
                    configuredAgents={sessions.configuredAgents} active={viewMode === 'conversation' && sessions.activeChatSessionId === session.id}
                    onActivity={handleTerminalActivity} onUsageChange={sessions.handleUsageChange} />
                ))}
              </>
            ) : (
              core.workspace?.status === 'creating' ? <BootProgress logs={core.streamedBootLogs.length > 0 ? core.streamedBootLogs : core.workspace.bootLogs} />
              : core.workspace?.status === 'stopping' ? <CenteredStatus color="var(--sam-color-warning-fg)" title="Stopping Workspace" loading />
              : core.workspace?.status === 'stopped' ? <CenteredStatus color="var(--sam-color-fg-muted)" title="Workspace Stopped" subtitle="Restart to access the terminal." action={<Button variant="primary" size="sm" onClick={core.handleRestart} disabled={core.actionLoading} loading={core.actionLoading}>Restart Workspace</Button>} />
              : core.workspace?.status === 'error' ? <CenteredStatus color="var(--sam-color-danger-fg)" title="Workspace Error" subtitle={core.workspace?.errorMessage || 'An unexpected error occurred.'} action={<div className="flex gap-2 flex-wrap justify-center"><Button variant="primary" size="sm" onClick={core.handleRebuild} disabled={core.actionLoading} loading={core.actionLoading}>Rebuild Container</Button><Button variant="secondary" size="sm" onClick={core.handleRestart} disabled={core.actionLoading} loading={core.actionLoading}>Restart Workspace</Button></div>} />
              : null
            )}
          </div>
        </div>
        {!isMobile && <aside className="flex flex-col w-80 min-w-80 border-l border-border-default bg-surface">
          <WorkspaceSidebar workspace={core.workspace} isRunning={core.isRunning} isMobile={isMobile} actionLoading={core.actionLoading}
            onStop={core.handleStop} onRestart={core.handleRestart} onRebuild={core.handleRebuild}
            displayNameInput={core.displayNameInput} onDisplayNameChange={core.setDisplayNameInput} onRename={core.handleRename} renaming={core.renaming}
            workspaceTabs={workspaceTabs} activeTabId={activeTabId}
            onSelectTab={(tab: SidebarTab) => { const f = workspaceTabs.find((t) => t.id === tab.id); if (f) handleSelectWorkspaceTab(f); }}
            onStopSession={sessions.handleStopSession} historySessions={sessions.historySessions}
            onResumeSession={sessions.handleResumeSession} onDeleteSession={sessions.handleDeleteHistorySession}
            gitStatus={nav.gitStatus} onOpenGitChanges={nav.handleOpenGitChanges}
            sessionTokenUsages={sessions.sessionTokenUsages} detectedPorts={core.detectedPorts} workspaceEvents={core.workspaceEvents} />
        </aside>}
      </div>

      {isMobile && mobileMenuOpen && (
        <>
          <div data-testid="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)} className="fixed inset-0 bg-overlay z-drawer-backdrop" />
          <div role="dialog" aria-label="Workspace menu" data-testid="mobile-menu-panel" className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-[360px] bg-surface border-l border-border-default z-drawer flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-border-default shrink-0" style={{ padding: 'var(--sam-space-3) var(--sam-space-4)' }}>
              <span className="font-semibold text-fg-primary" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Workspace</span>
              <button onClick={() => setMobileMenuOpen(false)} aria-label="Close workspace menu" className="bg-transparent border-none cursor-pointer text-fg-muted p-2 flex items-center justify-center min-w-[44px] min-h-[44px]"><X size={18} /></button>
            </div>
            <div className="flex flex-col flex-1 overflow-auto">
              <WorkspaceSidebar workspace={core.workspace} isRunning={core.isRunning} isMobile={isMobile} actionLoading={core.actionLoading}
                onStop={core.handleStop} onRestart={core.handleRestart} onRebuild={core.handleRebuild}
                displayNameInput={core.displayNameInput} onDisplayNameChange={core.setDisplayNameInput} onRename={core.handleRename} renaming={core.renaming}
                workspaceTabs={workspaceTabs} activeTabId={activeTabId}
                onSelectTab={(tab: SidebarTab) => { const f = workspaceTabs.find((t) => t.id === tab.id); if (f) handleSelectWorkspaceTab(f); }}
                onStopSession={sessions.handleStopSession} historySessions={sessions.historySessions}
                onResumeSession={sessions.handleResumeSession} onDeleteSession={sessions.handleDeleteHistorySession}
                gitStatus={nav.gitStatus} onOpenGitChanges={nav.handleOpenGitChanges}
                sessionTokenUsages={sessions.sessionTokenUsages} detectedPorts={core.detectedPorts} workspaceEvents={core.workspaceEvents} />
            </div>
          </div>
        </>
      )}

      {gitParam === 'changes' && core.terminalToken && core.workspace?.url && id && <GitChangesPanel workspaceUrl={core.workspace.url} workspaceId={id} token={core.terminalToken} worktree={nav.activeWorktree} isMobile={isMobile} onClose={nav.handleCloseGitPanel} onSelectFile={nav.handleNavigateToGitDiff} onStatusChange={nav.applyGitStatus} onStatusFetchError={nav.markGitStatusStale} />}
      {gitParam === 'diff' && gitFileParam && core.terminalToken && core.workspace?.url && id && <GitDiffView workspaceUrl={core.workspace.url} workspaceId={id} token={core.terminalToken} worktree={nav.activeWorktree} filePath={gitFileParam} staged={gitStagedParam === 'true'} isMobile={isMobile} onBack={nav.handleBackFromGitDiff} onClose={nav.handleCloseGitPanel} onViewInFileBrowser={nav.handleGitDiffToFileBrowser} />}
      {filesParam === 'browse' && core.terminalToken && core.workspace?.url && id && <FileBrowserPanel workspaceUrl={core.workspace.url} workspaceId={id} token={core.terminalToken} worktree={nav.activeWorktree} initialPath={filesPathParam ?? '.'} isMobile={isMobile} onClose={nav.handleCloseFileBrowser} onSelectFile={nav.handleFileViewerOpen} onNavigate={nav.handleFileBrowserNavigate} />}
      {filesParam === 'view' && filesPathParam && core.terminalToken && core.workspace?.url && id && <FileViewerPanel workspaceUrl={core.workspace.url} workspaceId={id} token={core.terminalToken} worktree={nav.activeWorktree} filePath={filesPathParam} isMobile={isMobile} onBack={nav.handleFileViewerBack} onClose={nav.handleCloseFileBrowser} onViewDiff={nav.handleFileViewerToDiff} />}
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />}
      {showCommandPalette && <CommandPalette onClose={() => setShowCommandPalette(false)} handlers={shortcutHandlers} tabs={tabStripItems} fileIndex={paletteFileIndex} fileIndexLoading={paletteFileIndexLoading} onSelectTab={handlePaletteSelectTab} onSelectFile={(fp: string) => nav.handleFileViewerOpen(fp)} />}
    </div>
  );
}
