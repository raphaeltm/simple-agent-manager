import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { MultiTerminalHandle, MultiTerminalSessionSnapshot } from '@simple-agent-manager/terminal';
import { useFeatureFlags } from '../config/features';
import { Button, Spinner } from '@simple-agent-manager/ui';
import type { ChatSessionHandle } from '../components/ChatSession';
import { CommandPalette } from '../components/CommandPalette';
import { KeyboardShortcutsHelp } from '../components/KeyboardShortcutsHelp';
import { useIsMobile } from '../hooks/useIsMobile';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useTabOrder } from '../hooks/useTabOrder';
import { useTokenRefresh } from '../hooks/useTokenRefresh';
import { useBootLogStream } from '../hooks/useBootLogStream';
import { useWorkspacePorts } from '../hooks/useWorkspacePorts';
import { useWorkspaceNavigation } from '../hooks/useWorkspaceNavigation';
import { useTerminalConnection } from '../hooks/useTerminalConnection';
import { useGitStatusPolling } from '../hooks/useGitStatusPolling';
import { useWorkspaceSessions } from '../hooks/useWorkspaceSessions';
import { useWorkspaceTabs, type WorkspaceTab } from '../hooks/useWorkspaceTabs';
import { useWorkspaceWorktrees } from '../hooks/useWorkspaceWorktrees';
import { WorkspaceTabStrip, type WorkspaceTabItem } from '../components/WorkspaceTabStrip';
import { X } from 'lucide-react';
import { GitChangesPanel } from '../components/GitChangesPanel';
import { GitDiffView } from '../components/GitDiffView';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { FileViewerPanel } from '../components/FileViewerPanel';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import type { SidebarTab, SessionTokenUsage } from '../components/WorkspaceSidebar';
import { WorkspaceHeader } from '../components/workspace/WorkspaceHeader';
import { WorkspaceTerminal } from '../components/workspace/WorkspaceTerminal';
import { WorkspaceStatusContent, Toolbar, CenteredStatus } from '../components/workspace/WorkspaceControls';
import { WorkspaceAgentPanel } from '../components/workspace/WorkspaceAgentPanel';
import { WorkspaceCreateMenu } from '../components/workspace/WorkspaceCreateMenu';
import {
  getFileIndex, getTerminalToken, getWorkspace,
  listAgentSessions, listAgentSessionsLive, listWorkspaceEvents,
  rebuildWorkspace, renameAgentSession, restartWorkspace, stopWorkspace, updateWorkspace,
} from '../lib/api';
import { isSessionActive } from '../lib/session-utils';
import { OrphanedSessionsBanner } from '../components/OrphanedSessionsBanner';
import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentSession, Event, WorkspaceResponse } from '@simple-agent-manager/shared';
import '../styles/acp-chat.css';

type ViewMode = 'terminal' | 'conversation';

export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();
  const isMobile = useIsMobile();
  const sessionIdParam = searchParams.get('sessionId');
  const viewOverride: ViewMode | null = (() => {
    const v = searchParams.get('view');
    return v === 'terminal' || v === 'conversation' ? v : null;
  })();

  const nav = useWorkspaceNavigation(id);

  // ── Core state ──
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [sessionTokenUsages, setSessionTokenUsages] = useState<SessionTokenUsage[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');
  const [workspaceEvents, setWorkspaceEvents] = useState<Event[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [terminalTabs, setTerminalTabs] = useState<MultiTerminalSessionSnapshot[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [paletteFileIndex, setPaletteFileIndex] = useState<string[]>([]);
  const [paletteFileIndexLoading, setPaletteFileIndexLoading] = useState(false);
  const paletteFileIndexLoaded = useRef(false);
  const multiTerminalRef = useRef<MultiTerminalHandle | null>(null);
  const chatSessionRefs = useRef<Map<string, ChatSessionHandle>>(new Map());

  const tabOrder = useTabOrder<WorkspaceTab>(id);
  const isRunning = workspace?.status === 'running' || workspace?.status === 'recovery';

  // ── Token refresh ──
  const tokenFetch = useCallback(async () => {
    if (!id) throw new Error('No workspace ID');
    return getTerminalToken(id);
  }, [id]);
  const { token: terminalToken, loading: terminalLoading, error: tokenRefreshError, refresh: refreshTerminalToken } =
    useTokenRefresh({ fetchToken: tokenFetch, enabled: isRunning && !!id });

  // ── Terminal connection ──
  const { wsUrl, terminalError, setTerminalError, resolveTerminalWsUrl, clearWsUrlCache } =
    useTerminalConnection({ workspaceId: id, workspaceUrl: workspace?.url, isRunning, multiTerminal: featureFlags.multiTerminal, terminalToken, terminalLoading });
  useEffect(() => { if (tokenRefreshError) setTerminalError(tokenRefreshError); }, [tokenRefreshError, setTerminalError]);

  // ── Git status ──
  const { gitStatus, gitChangeCount, gitStatusStale, applyGitStatus, markGitStatusStale } =
    useGitStatusPolling({ workspaceUrl: workspace?.url, workspaceId: id, terminalToken, isRunning, activeWorktree: nav.activeWorktree });

  const { logs: streamedBootLogs } = useBootLogStream(id, workspace?.url, workspace?.status);
  const { ports: detectedPorts } = useWorkspacePorts(workspace?.url ?? undefined, id, terminalToken ?? undefined, isRunning);

  // ── Worktrees ──
  const wt = useWorkspaceWorktrees({
    workspaceId: id, workspaceUrl: workspace?.url, terminalToken, isRunning,
    activeWorktree: nav.activeWorktree, searchParams: nav.searchParams, navigate: nav.navigate,
    handleSelectWorktree: nav.handleSelectWorktree,
  });

  // ── Load workspace state ──
  const loadWorkspaceState = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const ws = await getWorkspace(id);
      setWorkspace(ws);
      setDisplayNameInput(ws.displayName || ws.name);
      const wsRunning = ws.status === 'running' || ws.status === 'recovery';
      let sessionsData: AgentSession[] = [];
      if (wsRunning && ws.url && terminalToken) {
        try {
          const [live, cp] = await Promise.all([
            listAgentSessionsLive(ws.url, id, terminalToken),
            listAgentSessions(id).catch(() => [] as AgentSession[]),
          ]);
          const cpMap = new Map(cp.map((s) => [s.id, s]));
          sessionsData = live.map((s) => ({ ...s, agentType: s.agentType ?? cpMap.get(s.id)?.agentType ?? null }));
        } catch { sessionsData = await listAgentSessions(id); }
      } else { sessionsData = await listAgentSessions(id); }
      setAgentSessions(sessionsData || []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load workspace'); }
    finally { setLoading(false); }
  }, [id, terminalToken]);

  // ── Sessions ──
  const sessions = useWorkspaceSessions({
    workspaceId: id, isRunning, activeWorktree: nav.activeWorktree,
    searchParams: nav.searchParams, navigate: nav.navigate, sessionIdParam,
    tabOrderAssign: tabOrder.assignOrder, agentSessions, setAgentSessions, loadWorkspaceState,
  });

  // ── Polling ──
  useEffect(() => {
    if (!id) return;
    void loadWorkspaceState();
    const interval = setInterval(() => {
      if (['creating', 'stopping', 'running', 'recovery'].includes(workspace?.status ?? '')) void loadWorkspaceState();
    }, 5000);
    return () => clearInterval(interval);
  }, [id, workspace?.status, loadWorkspaceState]);

  // ── Workspace events ──
  useEffect(() => {
    if (!id || !workspace?.url || !terminalToken || !isRunning) return;
    const fetch = async () => { try { const d = await listWorkspaceEvents(workspace.url!, id, terminalToken, 50); setWorkspaceEvents(d.events || []); } catch { /* ignore polling errors */ } };
    void fetch();
    const interval = setInterval(() => void fetch(), 10000);
    return () => clearInterval(interval);
  }, [id, workspace?.url, isRunning, terminalToken]);

  // ── Close mobile menu on Escape ──
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileMenuOpen(false); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [mobileMenuOpen]);

  // ── Auto-select session ──
  useEffect(() => { if (sessionIdParam && viewMode !== 'conversation') setViewMode('conversation'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialViewResolvedRef = useRef(false);
  useEffect(() => {
    if (initialViewResolvedRef.current) return;
    if (viewOverride || sessionIdParam) { initialViewResolvedRef.current = true; return; }
    if (agentSessions.length === 0) return;
    const first = agentSessions.find((s) => isSessionActive(s) && !sessions.recentlyStopped.has(s.id));
    initialViewResolvedRef.current = true;
    if (first) {
      const p = new URLSearchParams(nav.searchParams);
      p.set('view', 'conversation'); p.set('sessionId', first.id);
      nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true });
      setViewMode('conversation');
    }
  }, [agentSessions, viewOverride, sessionIdParam, id, nav, sessions.recentlyStopped]);

  // ── Activity throttle ──
  const activityRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTerminalActivity = useCallback(() => {
    if (!id || activityRef.current) return;
    activityRef.current = setTimeout(() => { activityRef.current = null; }, 10_000);
    void loadWorkspaceState();
  }, [id, loadWorkspaceState]);
  useEffect(() => () => { if (activityRef.current) clearTimeout(activityRef.current); }, []);

  const handleUsageChange = useCallback((sessionId: string, usage: TokenUsage) => {
    setSessionTokenUsages((prev) => {
      const idx = prev.findIndex((s) => s.sessionId === sessionId);
      const session = agentSessions.find((s) => s.id === sessionId);
      const entry: SessionTokenUsage = { sessionId, label: session?.label ?? `Chat ${sessionId.slice(-4)}`, usage };
      if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
      return [...prev, entry];
    });
  }, [agentSessions]);

  // ── Workspace actions ──
  const handleStop = async () => {
    if (!id) return;
    try { setActionLoading(true); await stopWorkspace(id); setWorkspace((p) => p ? { ...p, status: 'stopping' } : null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to stop'); } finally { setActionLoading(false); }
  };
  const handleRestart = async () => {
    if (!id) return;
    try { setActionLoading(true); await restartWorkspace(id); setWorkspace((p) => p ? { ...p, status: 'creating', errorMessage: null, bootLogs: [] } : null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to restart'); } finally { setActionLoading(false); }
  };
  const handleRebuild = async () => {
    if (!id) return;
    if (!window.confirm('This will rebuild the devcontainer from scratch. Any unsaved terminal state will be lost. Continue?')) return;
    try { setActionLoading(true); await rebuildWorkspace(id); setWorkspace((p) => p ? { ...p, status: 'creating', errorMessage: null, bootLogs: [] } : null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to rebuild'); } finally { setActionLoading(false); }
  };
  const handleRename = async () => {
    if (!id || !displayNameInput.trim()) return;
    try { setRenaming(true); const u = await updateWorkspace(id, { displayName: displayNameInput.trim() }); setWorkspace(u); setDisplayNameInput(u.displayName || u.name); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to rename'); } finally { setRenaming(false); }
  };

  // ── Session wrappers ──
  const activeChatSessionId = viewMode === 'conversation'
    ? sessionIdParam || agentSessions.find((s) => isSessionActive(s) && !sessions.recentlyStopped.has(s.id))?.id || null
    : null;

  const handleAttachSession = (sid: string) => {
    if (!id) return;
    const p = new URLSearchParams(nav.searchParams); p.set('view', 'conversation'); p.set('sessionId', sid);
    nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true }); setViewMode('conversation');
  };
  const handleStopSession = async (sid: string) => {
    try {
      const r = await sessions.handleStopSession(sid);
      chatSessionRefs.current.delete(sid);
      setSessionTokenUsages((prev) => prev.filter((s) => s.sessionId !== sid));
      if (r?.wasActive) { const p = new URLSearchParams(nav.searchParams); p.set('view', 'terminal'); p.delete('sessionId'); nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true }); setViewMode('terminal'); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to stop session'); }
  };
  const handleResumeSession = async (sid: string) => {
    try { await sessions.handleResumeSession(sid); handleAttachSession(sid); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to resume session'); }
  };
  const handleDeleteHistorySession = async (sid: string) => {
    try { await sessions.handleDeleteHistorySession(sid); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to delete session'); }
  };
  const handleCreateTerminalTab = () => {
    setViewMode('terminal');
    const p = new URLSearchParams(nav.searchParams); p.set('view', 'terminal'); p.delete('sessionId');
    nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true });
    const sid = multiTerminalRef.current?.createSession();
    if (sid) { tabOrder.assignOrder(`terminal:${sid}`); setActiveTerminalSessionId(sid); multiTerminalRef.current?.activateSession(sid); }
  };
  const handleCreateSession = async (agentId?: AgentInfo['id']) => {
    try { await sessions.handleCreateSession(agentId, setViewMode as (m: 'conversation') => void); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to create session'); }
  };

  // ── Tabs ──
  const tabs = useWorkspaceTabs({
    isRunning, multiTerminal: featureFlags.multiTerminal, terminalTabs,
    agentSessions, agentNameById: sessions.agentNameById, preferredAgentsBySession: sessions.preferredAgentsBySession,
    recentlyStopped: sessions.recentlyStopped, worktrees: wt.worktrees, tabOrder, viewMode, activeTerminalSessionId, activeChatSessionId,
  });
  const handleSelectWorkspaceTab = (tab: WorkspaceTab) => {
    if (tab.kind === 'terminal') {
      setViewMode('terminal'); const p = new URLSearchParams(nav.searchParams); p.set('view', 'terminal'); p.delete('sessionId');
      nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true }); multiTerminalRef.current?.activateSession(tab.sessionId); return;
    }
    if (tab.status === 'suspended') { void handleResumeSession(tab.sessionId); return; }
    handleAttachSession(tab.sessionId);
  };
  const handleCloseWorkspaceTab = (tab: WorkspaceTab) => {
    if (tabs.activeTabId === tab.id) {
      const ci = tabs.workspaceTabs.findIndex((c) => c.id === tab.id);
      const rem = tabs.workspaceTabs.filter((c) => c.id !== tab.id);
      if (rem.length > 0) handleSelectWorkspaceTab(rem[Math.min(ci, rem.length - 1)]!);
      else { setViewMode('terminal'); setActiveTerminalSessionId(null); const p = new URLSearchParams(nav.searchParams); p.set('view', 'terminal'); p.delete('sessionId'); nav.navigate(`/workspaces/${id}?${p.toString()}`, { replace: true }); }
    }
    tabOrder.removeTab(tab.id);
    if (tab.kind === 'terminal') { multiTerminalRef.current?.closeSession(tab.sessionId); return; }
    void handleStopSession(tab.sessionId);
  };
  const handleRenameWorkspaceTab = useCallback((ti: WorkspaceTabItem, name: string) => {
    const tab = tabs.workspaceTabs.find((t) => t.id === ti.id);
    if (!tab) return;
    if (tab.kind === 'terminal') multiTerminalRef.current?.renameSession(tab.sessionId, name);
    else if (tab.kind === 'chat' && id) {
      setAgentSessions((prev) => prev.map((s) => s.id === tab.sessionId ? { ...s, label: name } : s));
      void renameAgentSession(id, tab.sessionId, name).catch(() => { void listAgentSessions(id).then(setAgentSessions); });
    }
  }, [id, tabs.workspaceTabs]);

  // ── Keyboard shortcuts ──
  const shortcutHandlers = {
    'toggle-file-browser': () => { if (isRunning && terminalToken) nav.filesParam ? nav.handleCloseFileBrowser() : nav.handleOpenFileBrowser(); },
    'toggle-git-changes': () => { if (isRunning && terminalToken) nav.gitParam ? nav.handleCloseGitPanel() : nav.handleOpenGitChanges(); },
    'focus-chat': () => { if (activeChatSessionId) { if (viewMode !== 'conversation') handleAttachSession(activeChatSessionId); requestAnimationFrame(() => chatSessionRefs.current.get(activeChatSessionId)?.focusInput()); } },
    'focus-terminal': () => { if (viewMode !== 'terminal') { const t = tabs.workspaceTabs.find((t) => t.kind === 'terminal'); if (t) handleSelectWorkspaceTab(t); } requestAnimationFrame(() => multiTerminalRef.current?.focus()); },
    'switch-worktree': () => { if (isRunning && wt.worktrees.length > 0) document.getElementById('worktree-selector-trigger')?.click(); },
    'next-tab': () => { if (tabs.workspaceTabs.length > 1) { const i = tabs.workspaceTabs.findIndex((t) => t.id === tabs.activeTabId); handleSelectWorkspaceTab(tabs.workspaceTabs[(i < 0 ? 0 : i + 1) % tabs.workspaceTabs.length]!); } },
    'prev-tab': () => { if (tabs.workspaceTabs.length > 1) { const i = tabs.workspaceTabs.findIndex((t) => t.id === tabs.activeTabId); handleSelectWorkspaceTab(tabs.workspaceTabs[i <= 0 ? tabs.workspaceTabs.length - 1 : i - 1]!); } },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab-${i + 1}`, () => { if (i < tabs.workspaceTabs.length) handleSelectWorkspaceTab(tabs.workspaceTabs[i]!); }])),
    'new-chat': () => { if (isRunning) void handleCreateSession(sessions.defaultAgentId ?? undefined); },
    'new-terminal': () => { if (isRunning) handleCreateTerminalTab(); },
    'command-palette': () => { setShowCommandPalette((p) => !p); setShowShortcutsHelp(false); },
    'show-shortcuts': () => setShowShortcutsHelp((p) => !p),
  };
  useKeyboardShortcuts(shortcutHandlers, isRunning);

  // ── Command palette file index ──
  useEffect(() => {
    if (!showCommandPalette || paletteFileIndexLoaded.current || !workspace?.url || !terminalToken || !id || !isRunning) return;
    paletteFileIndexLoaded.current = true;
    setPaletteFileIndexLoading(true);
    getFileIndex(workspace.url, id, terminalToken, nav.activeWorktree ?? undefined)
      .then((f) => setPaletteFileIndex(f)).catch((e) => console.warn('[palette] file index:', e)).finally(() => setPaletteFileIndexLoading(false));
  }, [showCommandPalette, workspace?.url, terminalToken, id, isRunning, nav.activeWorktree]);

  const handlePaletteSelectTab = useCallback((tab: WorkspaceTabItem) => {
    const t = tabs.workspaceTabs.find((w) => w.id === tab.id);
    if (t) { handleSelectWorkspaceTab(t); if (t.kind === 'terminal') multiTerminalRef.current?.focus?.(); else if (t.kind === 'chat') chatSessionRefs.current.get(t.sessionId)?.focusInput?.(); }
  }, [tabs.workspaceTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ══ RENDER ══
  if (loading && !workspace) return <div className="flex items-center justify-center bg-tn-bg" style={{ height: 'var(--sam-app-height)' }}><Spinner size="lg" /></div>;
  if (error && !workspace) return (
    <div className="flex flex-col bg-tn-bg" style={{ height: 'var(--sam-app-height)' }}>
      <Toolbar onBack={() => nav.navigate('/dashboard')} />
      <CenteredStatus color="var(--sam-color-danger-fg)" title="Failed to Load Workspace" subtitle={error}
        action={<Button variant="ghost" size="sm" onClick={() => nav.navigate('/dashboard')}>Back to Dashboard</Button>} />
    </div>
  );

  const sidebarContent = (
    <WorkspaceSidebar workspace={workspace} isRunning={isRunning} isMobile={isMobile} actionLoading={actionLoading}
      onStop={handleStop} onRestart={handleRestart} onRebuild={handleRebuild}
      displayNameInput={displayNameInput} onDisplayNameChange={setDisplayNameInput} onRename={handleRename} renaming={renaming}
      workspaceTabs={tabs.workspaceTabs} activeTabId={tabs.activeTabId}
      onSelectTab={(t: SidebarTab) => { const f = tabs.workspaceTabs.find((w) => w.id === t.id); if (f) handleSelectWorkspaceTab(f); }}
      onStopSession={handleStopSession} historySessions={sessions.historySessions}
      onResumeSession={handleResumeSession} onDeleteSession={handleDeleteHistorySession}
      gitStatus={gitStatus} onOpenGitChanges={nav.handleOpenGitChanges}
      sessionTokenUsages={sessionTokenUsages} detectedPorts={detectedPorts} workspaceEvents={workspaceEvents} />
  );

  return (
    <div className="flex flex-col bg-tn-bg overflow-hidden" style={{ height: 'var(--sam-app-height)' }}>
      <WorkspaceHeader workspace={workspace} isRunning={isRunning} isMobile={isMobile} error={error} terminalToken={terminalToken} workspaceId={id}
        worktrees={wt.worktrees} activeWorktree={nav.activeWorktree} worktreeLoading={wt.worktreeLoading}
        remoteBranches={wt.remoteBranches} remoteBranchesLoading={wt.remoteBranchesLoading}
        gitChangeCount={gitChangeCount} gitStatusStale={gitStatusStale}
        onBack={() => workspace?.projectId ? nav.navigate(`/projects/${workspace.projectId}`) : nav.navigate('/dashboard')}
        onClearError={() => setError(null)} onOpenFileBrowser={nav.handleOpenFileBrowser} onOpenGitChanges={nav.handleOpenGitChanges}
        onOpenCommandPalette={() => setShowCommandPalette(true)} onOpenMobileMenu={() => setMobileMenuOpen(true)}
        onSelectWorktree={nav.handleSelectWorktree} onCreateWorktree={wt.handleCreateWorktree}
        onRemoveWorktree={wt.handleRemoveWorktree} onRequestBranches={wt.fetchRemoteBranches} />

      {isMobile && error && (
        <div style={{ padding: '6px 12px', backgroundColor: 'var(--sam-color-danger-tint)', borderBottom: '1px solid rgba(248, 113, 113, 0.3)', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-danger-fg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: 'var(--sam-color-danger-fg)', cursor: 'pointer', padding: '4px 8px', fontSize: 'var(--sam-type-secondary-size)', flexShrink: 0 }}>×</button>
        </div>
      )}
      {isRunning && sessions.orphanedSessions.length > 0 && !sessions.dismissedOrphans && (
        <OrphanedSessionsBanner orphanedSessions={sessions.orphanedSessions} onStopAll={sessions.handleStopAllOrphans} onDismiss={() => sessions.setDismissedOrphans(true)} />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {isRunning && (
            <WorkspaceTabStrip tabs={tabs.tabStripItems} activeTabId={tabs.activeTabId} isMobile={isMobile}
              onSelect={(i) => tabs.handleSelectTabItem(i, handleSelectWorkspaceTab)}
              onClose={(i) => tabs.handleCloseTabItem(i, handleCloseWorkspaceTab)}
              onRename={handleRenameWorkspaceTab} onReorder={tabOrder.reorderTab}
              createMenuSlot={
                <WorkspaceCreateMenu isMobile={isMobile} sessionsLoading={sessions.sessionsLoading}
                  configuredAgents={sessions.configuredAgents} defaultAgentId={sessions.defaultAgentId} defaultAgentName={sessions.defaultAgentName}
                  onCreateTerminalTab={handleCreateTerminalTab} onCreateSession={(a) => void handleCreateSession(a)} />
              } />
          )}
          <div className="flex flex-col flex-1 min-h-0 relative">
            {isRunning ? (
              <>
                <WorkspaceTerminal wsUrl={wsUrl} resolveWsUrl={resolveTerminalWsUrl} multiTerminal={featureFlags.multiTerminal} viewMode={viewMode}
                  activeWorktree={nav.activeWorktree} workspaceId={id} terminalLoading={terminalLoading} terminalError={terminalError}
                  multiTerminalRef={multiTerminalRef} onActivity={handleTerminalActivity}
                  onSessionsChange={(s, a) => { setTerminalTabs(s); setActiveTerminalSessionId(a); }}
                  onRetryConnection={() => { clearWsUrlCache(); void refreshTerminalToken(); }} />
                {id && workspace?.url && (
                  <WorkspaceAgentPanel workspaceId={id} workspaceUrl={workspace.url} sessions={sessions.runningChatSessions} viewMode={viewMode}
                    activeChatSessionId={activeChatSessionId} configuredAgents={sessions.configuredAgents}
                    preferredAgentsBySession={sessions.preferredAgentsBySession} chatSessionRefs={chatSessionRefs}
                    onActivity={handleTerminalActivity} onUsageChange={handleUsageChange} />
                )}
              </>
            ) : (
              <WorkspaceStatusContent workspace={workspace} bootLogs={streamedBootLogs} actionLoading={actionLoading} onRestart={handleRestart} onRebuild={handleRebuild} />
            )}
          </div>
        </div>
        {!isMobile && <aside className="flex flex-col w-80 min-w-80 border-l border-border-default bg-surface">{sidebarContent}</aside>}
      </div>

      {isMobile && mobileMenuOpen && (
        <>
          <div data-testid="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)} className="fixed inset-0 bg-overlay z-drawer-backdrop" />
          <div role="dialog" aria-label="Workspace menu" data-testid="mobile-menu-panel" className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-[360px] bg-surface border-l border-border-default z-drawer flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-border-default shrink-0" style={{ padding: 'var(--sam-space-3) var(--sam-space-4)' }}>
              <span className="font-semibold text-fg-primary" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>Workspace</span>
              <button onClick={() => setMobileMenuOpen(false)} aria-label="Close workspace menu" className="bg-transparent border-none cursor-pointer text-fg-muted p-2 flex items-center justify-center min-w-[44px] min-h-[44px]"><X size={18} /></button>
            </div>
            <div className="flex flex-col flex-1 overflow-auto">{sidebarContent}</div>
          </div>
        </>
      )}

      {nav.gitParam === 'changes' && terminalToken && workspace?.url && id && (
        <GitChangesPanel workspaceUrl={workspace.url} workspaceId={id} token={terminalToken} worktree={nav.activeWorktree} isMobile={isMobile} onClose={nav.handleCloseGitPanel} onSelectFile={nav.handleNavigateToGitDiff} onStatusChange={applyGitStatus} onStatusFetchError={markGitStatusStale} />
      )}
      {nav.gitParam === 'diff' && nav.gitFileParam && terminalToken && workspace?.url && id && (
        <GitDiffView workspaceUrl={workspace.url} workspaceId={id} token={terminalToken} worktree={nav.activeWorktree} filePath={nav.gitFileParam} staged={nav.gitStagedParam === 'true'} isMobile={isMobile} onBack={nav.handleBackFromGitDiff} onClose={nav.handleCloseGitPanel} onViewInFileBrowser={nav.handleGitDiffToFileBrowser} />
      )}
      {nav.filesParam === 'browse' && terminalToken && workspace?.url && id && (
        <FileBrowserPanel workspaceUrl={workspace.url} workspaceId={id} token={terminalToken} worktree={nav.activeWorktree} initialPath={nav.filesPathParam ?? '.'} isMobile={isMobile} onClose={nav.handleCloseFileBrowser} onSelectFile={nav.handleFileViewerOpen} onNavigate={nav.handleFileBrowserNavigate} />
      )}
      {nav.filesParam === 'view' && nav.filesPathParam && terminalToken && workspace?.url && id && (
        <FileViewerPanel workspaceUrl={workspace.url} workspaceId={id} token={terminalToken} worktree={nav.activeWorktree} filePath={nav.filesPathParam} isMobile={isMobile} onBack={nav.handleFileViewerBack} onClose={nav.handleCloseFileBrowser} onViewDiff={nav.handleFileViewerToDiff} />
      )}
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />}
      {showCommandPalette && <CommandPalette onClose={() => setShowCommandPalette(false)} handlers={shortcutHandlers} tabs={tabs.tabStripItems} fileIndex={paletteFileIndex} fileIndexLoading={paletteFileIndexLoading} onSelectTab={handlePaletteSelectTab} onSelectFile={(f) => nav.handleFileViewerOpen(f)} />}
    </div>
  );
}
