import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { List, Settings, LayoutGrid, GitFork, Search, ChevronDown, ChevronRight, X } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { VoiceButton } from '@simple-agent-manager/acp-client';
import type { AgentInfo, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import { ProjectMessageView } from '../components/chat/ProjectMessageView';
import { useIsMobile } from '../hooks/useIsMobile';
import type { TaskStatus, TaskExecutionStep } from '@simple-agent-manager/shared';
import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  TASK_EXECUTION_STEPS,
} from '@simple-agent-manager/shared';
import {
  listAgents,
  listChatSessions,
  listCredentials,
  submitTask,
  getProjectTask,
  getTranscribeApiUrl,
} from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';
import { stripMarkdown } from '../lib/text-utils';
import { ForkDialog } from '../components/project/ForkDialog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-poll sessions when a task is actively executing (ms). */
const ACTIVE_SESSION_POLL_MS = 3000;
/** How often to poll task status during provisioning (ms). */
const TASK_STATUS_POLL_MS = 2000;
/** Sessions with no activity in this window are considered stale and hidden by default (ms). */
const STALE_SESSION_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisioningState {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  startedAt: number;
}

type SessionState = 'active' | 'idle' | 'terminated';

// ---------------------------------------------------------------------------
// Session helpers (moved from SessionSidebar.tsx)
// ---------------------------------------------------------------------------

function getSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

const STATE_COLORS: Record<SessionState, string> = {
  active: 'var(--sam-color-success)',
  idle: 'var(--sam-color-warning, #f59e0b)',
  terminated: 'var(--sam-color-fg-muted)',
};

const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  terminated: 'Stopped',
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Returns the most relevant activity timestamp for a session. */
function getLastActivity(session: ChatSessionResponse): number {
  return session.lastMessageAt ?? session.startedAt;
}

/** Whether a session is "stale" — no activity within the threshold window. */
function isStaleSession(session: ChatSessionResponse): boolean {
  return Date.now() - getLastActivity(session) > STALE_SESSION_THRESHOLD_MS;
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId, project, settingsOpen, setSettingsOpen, infoPanelOpen, setInfoPanelOpen } = useProjectContext();
  const isMobile = useIsMobile();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar filtering
  const [searchQuery, setSearchQuery] = useState('');
  const [showStale, setShowStale] = useState(false);

  // Track explicit "new chat" intent so auto-select doesn't override it
  const newChatIntentRef = useRef(false);

  // New chat input state
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Agent type selection
  const [configuredAgents, setConfiguredAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentType, setSelectedAgentType] = useState<string | null>(null);

  // Workspace profile selection — defaults to project setting or platform default
  const [selectedWorkspaceProfile, setSelectedWorkspaceProfile] = useState<WorkspaceProfile>(
    (project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE,
  );

  // Provisioning tracking
  const [provisioning, setProvisioning] = useState<ProvisioningState | null>(null);
  const sessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fork dialog state
  const [forkSession, setForkSession] = useState<ChatSessionResponse | null>(null);

  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // ---------------------------------------------------------------------------
  // Session filtering: recent vs stale, with search
  // ---------------------------------------------------------------------------

  const { recentSessions, staleSessions } = useMemo(() => {
    const recent: ChatSessionResponse[] = [];
    const stale: ChatSessionResponse[] = [];
    for (const s of sessions) {
      if (isStaleSession(s)) {
        stale.push(s);
      } else {
        recent.push(s);
      }
    }
    return { recentSessions: recent, staleSessions: stale };
  }, [sessions]);

  const filteredRecent = useMemo(() => {
    if (!searchQuery.trim()) return recentSessions;
    const q = searchQuery.toLowerCase();
    return recentSessions.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [recentSessions, searchQuery]);

  const filteredStale = useMemo(() => {
    if (!searchQuery.trim()) return staleSessions;
    const q = searchQuery.toLowerCase();
    return staleSessions.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [staleSessions, searchQuery]);

  // When searching, always show stale results too
  const effectiveShowStale = showStale || !!searchQuery.trim();

  // ---------------------------------------------------------------------------
  // Effects (all preserved from original)
  // ---------------------------------------------------------------------------

  // Check for cloud provider credentials
  useEffect(() => {
    void listCredentials()
      .then((creds) => setHasCloudCredentials(creds.some((c) => c.provider === 'hetzner' || c.provider === 'scaleway')))
      .catch(() => setHasCloudCredentials(false));
  }, []);

  // Load configured agents
  useEffect(() => {
    let cancelled = false;
    void listAgents()
      .then((data) => {
        if (cancelled) return;
        const acpAgents = (data.agents || []).filter((a) => a.configured && a.supportsAcp);
        setConfiguredAgents(acpAgents);
        // Default to first agent if none selected
        if (!selectedAgentType && acpAgents.length > 0) {
          setSelectedAgentType(acpAgents[0]!.id);
        }
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSessions = useCallback(async () => {
    try {
      const result = await listChatSessions(projectId, { limit: 100 });
      setSessions(result.sessions);
      return result.sessions;
    } catch {
      return [];
    }
  }, [projectId]);

  // Initial load — auto-select the most recent session when navigating to the
  // project without a specific sessionId (e.g., from the dashboard). This
  // prevents users from accidentally creating a new session when they intended
  // to continue an existing conversation. The "+ New Chat" button sets
  // newChatIntentRef to bypass this behavior.
  useEffect(() => {
    setLoading(true);
    void loadSessions().then((loaded) => {
      if (!sessionId && !newChatIntentRef.current && loaded.length > 0) {
        navigate(`/projects/${projectId}/chat/${loaded[0]!.id}`, { replace: true });
      }
    }).finally(() => setLoading(false));
  }, [loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll task status during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) return;

    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, provisioning.taskId);
        setProvisioning((prev) => prev ? { ...prev, status: task.status, executionStep: task.executionStep ?? null, errorMessage: task.errorMessage ?? null } : null);

        if (task.status === 'in_progress' && (task.workspaceId || task.executionStep === 'running')) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
        }

        if (isTerminal(task.status)) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
          void loadSessions();
        }
      } catch {
        // Continue polling on transient errors
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), TASK_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [provisioning?.taskId, provisioning?.status, projectId, navigate, loadSessions, provisioning?.sessionId]);

  // Aggressive session polling during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) {
      if (sessionPollRef.current) {
        clearInterval(sessionPollRef.current);
        sessionPollRef.current = null;
      }
      return;
    }

    sessionPollRef.current = setInterval(() => void loadSessions(), ACTIVE_SESSION_POLL_MS);
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, [provisioning?.taskId, provisioning?.status, loadSessions]);

  // Restore provisioning state when navigating to a session with an active task
  useEffect(() => {
    if (!sessionId || provisioning) return;

    const selectedSession = sessions.find((s) => s.id === sessionId);
    if (!selectedSession?.taskId) return;

    let cancelled = false;
    void (async () => {
      try {
        const task = await getProjectTask(projectId, selectedSession.taskId!);
        if (cancelled) return;
        if (!isTerminal(task.status) && task.status !== 'in_progress') {
          setProvisioning({
            taskId: task.id,
            sessionId,
            branchName: task.outputBranch ?? '',
            status: task.status,
            executionStep: task.executionStep ?? null,
            errorMessage: task.errorMessage ?? null,
            startedAt: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
          });
        }
      } catch {
        // Best-effort
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, sessions, projectId, provisioning]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Handlers (all preserved from original)
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;

    if (!hasCloudCredentials) {
      setSubmitError('Cloud credentials required. Go to Settings to connect your Hetzner account.');
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitTask(projectId, {
        message: trimmed,
        ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
        workspaceProfile: selectedWorkspaceProfile,
      });
      setMessage('');
      setProvisioning({
        taskId: result.taskId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
      });
      newChatIntentRef.current = false;
      navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
      void loadSessions();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true;
    navigate(`/projects/${projectId}/chat`, { replace: true });
    setMessage('');
    setSubmitError(null);
    setProvisioning(null);
  }, [navigate, projectId]);

  const handleSelect = (id: string) => {
    newChatIntentRef.current = false;
    setProvisioning(null);
    setSidebarOpen(false);
    navigate(`/projects/${projectId}/chat/${id}`);
  };

  const handleFork = async (forkMessage: string, contextSummary: string, parentTaskId: string) => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitTask(projectId, {
        message: forkMessage,
        parentTaskId,
        contextSummary,
        ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
        workspaceProfile: selectedWorkspaceProfile,
      });
      setProvisioning({
        taskId: result.taskId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
      });
      navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
      void loadSessions();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to fork session');
      throw err; // Re-throw so ForkDialog knows it failed
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (loading && sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
              {project?.name || 'Project'}
            </span>
            <button
              type="button"
              onClick={() => setInfoPanelOpen(!infoPanelOpen)}
              title="Project status"
              aria-label="Project status"
              className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
            >
              <LayoutGrid size={15} />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(!settingsOpen)}
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
              onClick={handleNewChat}
              className="w-full py-1.5 px-3 rounded-md border border-border-default bg-transparent cursor-pointer text-fg-primary text-xs font-medium hover:bg-surface-hover transition-colors"
            >
              + New Chat
            </button>
          </div>

          {/* Search */}
          {hasSessions && (
            <div className="shrink-0 px-2 py-1.5 border-b border-border-default">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search chats..."
                  className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-border-default bg-transparent text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent-primary"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
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
          {hasSessions ? (
            <nav className="flex-1 overflow-y-auto min-h-0">
              {filteredRecent.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={session.id === sessionId}
                  onSelect={handleSelect}
                  onFork={setForkSession}
                />
              ))}
              {filteredStale.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowStale(!effectiveShowStale)}
                    className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted bg-transparent border-none border-b border-border-default cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    {effectiveShowStale ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>Older ({filteredStale.length})</span>
                  </button>
                  {effectiveShowStale && filteredStale.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isSelected={session.id === sessionId}
                      onSelect={handleSelect}
                      onFork={setForkSession}
                    />
                  ))}
                </>
              )}
              {filteredRecent.length === 0 && !effectiveShowStale && (
                <div className="flex items-center justify-center p-4">
                  <span className="text-xs text-fg-muted text-center">
                    {searchQuery ? 'No matching chats' : 'No recent chats'}
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
            {hasSessions && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open chat list"
                className="p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
              >
                <List size={18} />
              </button>
            )}
            <span className="text-sm font-semibold text-fg-primary truncate flex-1">
              {project?.name || 'Project'}
            </span>
            <button
              type="button"
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-label="Project settings"
              className="shrink-0 p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
            >
              <Settings size={16} />
            </button>
          </div>
        )}

        {showNewChatInput ? (
          /* New chat / empty state */
          <div className="flex-1 flex flex-col min-h-0">
            <div className={`flex-1 flex flex-col items-center justify-center gap-3 ${isMobile ? 'p-4' : 'p-8'}`}>
              {provisioning ? (
                <ProvisioningIndicator state={provisioning} />
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
              value={message}
              onChange={setMessage}
              onSubmit={handleSubmit}
              submitting={submitting}
              error={submitError}
              placeholder="Describe what you want the agent to do..."
              transcribeApiUrl={transcribeApiUrl}
              agents={configuredAgents}
              selectedAgentType={selectedAgentType}
              onAgentTypeChange={setSelectedAgentType}
              selectedWorkspaceProfile={selectedWorkspaceProfile}
              onWorkspaceProfileChange={setSelectedWorkspaceProfile}
            />
          </div>
        ) : (
          /* Active session view */
          <div className="flex-1 flex flex-col min-h-0">
            {provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status) && (
              <ProvisioningIndicator state={provisioning} />
            )}
            <ProjectMessageView
              key={sessionId}
              projectId={projectId}
              sessionId={sessionId!}
              isProvisioning={!!(provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status))}
            />
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* Mobile session drawer                                              */}
      {/* ================================================================== */}
      {isMobile && sidebarOpen && hasSessions && (
        <MobileSessionDrawer
          sessions={sessions}
          selectedSessionId={sessionId ?? null}
          onSelect={handleSelect}
          onFork={(session) => { setSidebarOpen(false); setForkSession(session); }}
          onNewChat={() => { setSidebarOpen(false); handleNewChat(); }}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Fork dialog */}
      <ForkDialog
        open={!!forkSession}
        session={forkSession}
        projectId={projectId}
        onClose={() => setForkSession(null)}
        onFork={handleFork}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session item (inline — replaces SessionSidebar.tsx)
// ---------------------------------------------------------------------------

function SessionItem({
  session,
  isSelected,
  onSelect,
  onFork,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
}) {
  const state = getSessionState(session);
  const dotColor = STATE_COLORS[state];
  const canFork = state === 'terminated' && !!session.task?.id;

  return (
    <div
      className={`block w-full text-left px-3 py-2.5 border-b border-border-default transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`}
      style={{
        borderLeft: isSelected
          ? '3px solid var(--sam-color-accent-primary)'
          : '3px solid transparent',
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="block w-full text-left bg-transparent border-none cursor-pointer p-0"
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dotColor }}
          />
          <span className={`text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 ${isSelected ? 'font-semibold text-fg-primary' : 'font-medium text-fg-primary'}`}>
            {session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted pl-[calc(6px+8px)]">
          <span style={{ color: dotColor }} className="font-medium">
            {STATE_LABELS[state]}
          </span>
          <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
          <span className="ml-auto">{formatRelativeTime(getLastActivity(session))}</span>
        </div>
      </button>
      {canFork && onFork && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFork(session); }}
          className="mt-1 ml-[calc(6px+8px)] flex items-center gap-1 text-xs text-accent-primary bg-transparent border border-transparent rounded-sm cursor-pointer py-1 px-1.5 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary transition-colors"
          title="Continue from this session"
        >
          <GitFork size={12} />
          Continue
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile session drawer
// ---------------------------------------------------------------------------

function MobileSessionDrawer({
  sessions,
  selectedSessionId,
  onSelect,
  onFork,
  onNewChat,
  onClose,
}: {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork: (session: ChatSessionResponse) => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  const [mobileSearch, setMobileSearch] = useState('');
  const [mobileShowStale, setMobileShowStale] = useState(false);

  const { recent, stale } = useMemo(() => {
    const r: ChatSessionResponse[] = [];
    const s: ChatSessionResponse[] = [];
    for (const sess of sessions) {
      if (isStaleSession(sess)) s.push(sess);
      else r.push(sess);
    }
    return { recent: r, stale: s };
  }, [sessions]);

  const filteredR = useMemo(() => {
    if (!mobileSearch.trim()) return recent;
    const q = mobileSearch.toLowerCase();
    return recent.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [recent, mobileSearch]);

  const filteredS = useMemo(() => {
    if (!mobileSearch.trim()) return stale;
    const q = mobileSearch.toLowerCase();
    return stale.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [stale, mobileSearch]);

  const showOlder = mobileShowStale || !!mobileSearch.trim();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        style={{ animation: 'sam-session-drawer-fade-in 0.15s ease-out' }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        className="fixed top-0 left-0 bottom-0 bg-surface border-r border-border-default z-drawer flex flex-col"
        style={{
          width: '85vw',
          maxWidth: 320,
          animation: 'sam-session-drawer-slide-in 0.2s ease-out',
        }}
      >
        {/* Drawer header */}
        <div className="shrink-0 p-3 border-b border-border-default flex items-center justify-between">
          <span className="text-sm font-semibold text-fg-primary">Chats</span>
          <button
            type="button"
            onClick={onNewChat}
            className="bg-transparent border border-border-default rounded-sm px-2 py-0.5 cursor-pointer text-fg-primary text-xs font-medium"
          >
            + New
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-2 py-1.5 border-b border-border-default">
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
            <input
              type="text"
              value={mobileSearch}
              onChange={(e) => setMobileSearch(e.target.value)}
              placeholder="Search chats..."
              className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-border-default bg-transparent text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent-primary"
            />
            {mobileSearch && (
              <button
                type="button"
                onClick={() => setMobileSearch('')}
                className="absolute right-1.5 p-0.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Session list */}
        <nav className="flex-1 overflow-y-auto min-h-0">
          {filteredR.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onSelect={onSelect}
              onFork={onFork}
            />
          ))}
          {filteredS.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setMobileShowStale(!showOlder)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted bg-transparent border-none border-b border-border-default cursor-pointer hover:bg-surface-hover transition-colors"
              >
                {showOlder ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Older ({filteredS.length})</span>
              </button>
              {showOlder && filteredS.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={session.id === selectedSessionId}
                  onSelect={onSelect}
                  onFork={onFork}
                />
              ))}
            </>
          )}
        </nav>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Provisioning indicator (preserved)
// ---------------------------------------------------------------------------

const PROVISIONING_STEPS: TaskExecutionStep[] = TASK_EXECUTION_STEPS.filter(
  (s) => s !== 'running' && s !== 'awaiting_followup'
);

function ProvisioningIndicator({ state }: { state: ProvisioningState }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const seconds = Math.floor(elapsed / 1000);
  const elapsedDisplay = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  const statusLabel = state.status === 'failed' ? 'Setup failed'
    : state.status === 'cancelled' ? 'Cancelled'
    : state.executionStep ? EXECUTION_STEP_LABELS[state.executionStep]
    : 'Starting...';

  const currentStepOrder = state.executionStep ? EXECUTION_STEP_ORDER[state.executionStep] : -1;
  const isFailed = state.status === 'failed';

  return (
    <div className={`shrink-0 px-4 py-3 border-b border-border-default ${isFailed ? 'bg-danger-tint' : 'bg-info-tint'}`}>
      <div className="flex items-center gap-2 mb-2">
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span className={`sam-type-secondary font-medium ${isFailed ? 'text-danger' : 'text-fg-primary'}`}>
          {statusLabel}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption text-fg-muted">{state.branchName}</span>
        )}
        <span className="sam-type-caption text-fg-muted ml-auto">{elapsedDisplay}</span>
      </div>

      {!isTerminal(state.status) && (
        <div className="flex gap-[2px] h-[3px] rounded-sm overflow-hidden">
          {PROVISIONING_STEPS.map((step) => {
            const stepOrder = EXECUTION_STEP_ORDER[step];
            const isComplete = stepOrder < currentStepOrder;
            const isCurrent = stepOrder === currentStepOrder;
            return (
              <div
                key={step}
                title={EXECUTION_STEP_LABELS[step]}
                className="flex-1 transition-colors duration-300"
                style={{
                  backgroundColor: isComplete
                    ? 'var(--sam-color-success)'
                    : isCurrent
                    ? 'var(--sam-color-accent-primary)'
                    : 'var(--sam-color-border-default)',
                }}
              />
            );
          })}
        </div>
      )}

      {state.errorMessage && (
        <div className="sam-type-caption text-danger mt-2 p-2 px-3 bg-surface rounded-sm border border-danger-tint break-words">
          {state.errorMessage}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat input (preserved)
// ---------------------------------------------------------------------------

function ChatInput({
  value,
  onChange,
  onSubmit,
  submitting,
  error,
  placeholder,
  transcribeApiUrl,
  agents,
  selectedAgentType,
  onAgentTypeChange,
  selectedWorkspaceProfile,
  onWorkspaceProfileChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  placeholder: string;
  transcribeApiUrl: string;
  agents: AgentInfo[];
  selectedAgentType: string | null;
  onAgentTypeChange: (agentType: string) => void;
  selectedWorkspaceProfile: WorkspaceProfile;
  onWorkspaceProfileChange: (profile: WorkspaceProfile) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-grow: resize textarea to fit content up to max-height
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  const handleTranscription = useCallback(
    (text: string) => {
      const separator = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
      onChange(value + separator + text);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}
      <div className="flex items-center gap-4 mb-2 flex-wrap">
        {agents.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="agent-type-select" className="text-xs text-fg-muted whitespace-nowrap">Agent:</label>
            <select
              id="agent-type-select"
              value={selectedAgentType ?? ''}
              onChange={(e) => onAgentTypeChange(e.target.value)}
              disabled={submitting}
              className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs outline-none cursor-pointer"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="workspace-profile-select" className="text-xs text-fg-muted whitespace-nowrap">Workspace:</label>
          <select
            id="workspace-profile-select"
            value={selectedWorkspaceProfile}
            onChange={(e) => onWorkspaceProfileChange(e.target.value as WorkspaceProfile)}
            disabled={submitting}
            className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs outline-none cursor-pointer"
          >
            <option value="full">Full</option>
            <option value="lightweight">Lightweight</option>
          </select>
        </div>
      </div>
      <div className="flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={submitting}
          rows={1}
          className="flex-1 p-2 px-3 bg-page border border-border-default rounded-md text-fg-primary text-base outline-none resize-none font-[inherit] leading-[1.5] min-h-[38px] max-h-[120px] overflow-y-auto"
        />
        <VoiceButton
          onTranscription={handleTranscription}
          disabled={submitting}
          apiUrl={transcribeApiUrl}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !value.trim()}
          className="px-3 py-2 border-none rounded-md text-base font-medium whitespace-nowrap"
          style={{
            backgroundColor: submitting || !value.trim() ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: submitting || !value.trim() ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: submitting || !value.trim() ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>
      <div className="sam-type-caption text-fg-muted mt-1">
        Press Shift+Enter to send, Enter for new line
      </div>
    </div>
  );
}
