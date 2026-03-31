import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { List, Settings, LayoutGrid, GitFork, Search, ChevronDown, ChevronRight, X, Lightbulb, Paperclip } from 'lucide-react';
import { ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX } from '@simple-agent-manager/shared';
import { formatFileSize } from '../lib/file-utils';
import { Spinner } from '@simple-agent-manager/ui';
import { VoiceButton, SlashCommandPalette } from '@simple-agent-manager/acp-client';
import type { SlashCommandPaletteHandle, SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentProfile, WorkspaceProfile, TaskMode, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
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
  listAgentProfiles,
  updateAgentProfile,
  listChatSessions,
  listCredentials,
  listProjectTasks,
  submitTask,
  linkSessionIdea,
  getProjectTask,
  getTranscribeApiUrl,
  closeConversationTask,
  requestAttachmentUpload,
  uploadAttachmentToR2,
  getWorkspace,
} from '../lib/api';
import type { ChatSessionResponse, TaskAttachmentRef } from '../lib/api';
import {
  getSessionState,
  isStaleSession,
  getLastActivity,
  formatRelativeTime,
  STATE_COLORS,
  STATE_LABELS,
} from '../lib/chat-session-utils';
import { useProjectContext } from './ProjectContext';
import { stripMarkdown } from '../lib/text-utils';
import { ForkDialog } from '../components/project/ForkDialog';
import { ProfileSelector } from '../components/agent-profiles/ProfileSelector';
import { ProfileFormDialog } from '../components/agent-profiles/ProfileFormDialog';
import { useProjectWebSocket } from '../hooks/useProjectWebSocket';
import { useAvailableCommands } from '../hooks/useAvailableCommands';
import { useBootLogStream } from '../hooks/useBootLogStream';
import { BootLogPanel } from '../components/chat/BootLogPanel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll task status during provisioning (ms). */
const TASK_STATUS_POLL_MS = 2000;
/** Max sessions to load in the sidebar. Override via VITE_CHAT_SESSION_LIST_LIMIT. */
const DEFAULT_CHAT_SESSION_LIST_LIMIT = 100;
const CHAT_SESSION_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_SESSION_LIST_LIMIT || String(DEFAULT_CHAT_SESSION_LIST_LIMIT),
);

/** Prompt template for executing an idea. Override via VITE_EXECUTE_IDEA_PROMPT_TEMPLATE. Use {ideaId} placeholder. */
const DEFAULT_EXECUTE_IDEA_PROMPT_TEMPLATE =
  'Read idea {ideaId} using the get_idea tool for full context, then execute it using the /do skill.';
const EXECUTE_IDEA_PROMPT_TEMPLATE =
  import.meta.env.VITE_EXECUTE_IDEA_PROMPT_TEMPLATE || DEFAULT_EXECUTE_IDEA_PROMPT_TEMPLATE;

/** Max tasks to load for idea tagging. Override via VITE_CHAT_TASK_LIST_LIMIT. */
const DEFAULT_CHAT_TASK_LIST_LIMIT = 200;
const CHAT_TASK_LIST_LIMIT = parseInt(
  import.meta.env.VITE_CHAT_TASK_LIST_LIMIT || String(DEFAULT_CHAT_TASK_LIST_LIMIT),
);

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
  workspaceId: string | null;
  workspaceUrl: string | null;
}

// Session helpers imported from '../lib/chat-session-utils'

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId, project, settingsOpen, setSettingsOpen, infoPanelOpen, setInfoPanelOpen } = useProjectContext();
  const isMobile = useIsMobile();

  // Execute-idea flow: pre-fill message and track ideaId for auto-linking
  const executeIdeaId = searchParams.get('executeIdea');
  const executeIdeaIdRef = useRef<string | null>(null);

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);
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

  // Agent profile selection
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Slash command cache for pre-session autocomplete
  const { commands: slashCommands } = useAvailableCommands(projectId);

  // File attachment state for task submission
  interface AttachmentUploadState {
    file: File;
    uploadId: string | null;
    progress: number;
    status: 'pending' | 'uploading' | 'complete' | 'error';
    error?: string;
    ref?: TaskAttachmentRef;
  }
  const [chatAttachments, setChatAttachments] = useState<AttachmentUploadState[]>([]);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const chatUploading = chatAttachments.some((a) => a.status === 'uploading' || a.status === 'pending');

  const handleChatFileUpload = useCallback(async (file: File, index: number) => {
    try {
      const presigned = await requestAttachmentUpload(
        projectId, file.name, file.size, file.type || 'application/octet-stream',
      );
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, uploadId: presigned.uploadId, status: 'uploading' as const } : a),
      );
      await uploadAttachmentToR2(presigned.uploadUrl, file, (loaded, total) => {
        const progress = Math.round((loaded / total) * 100);
        setChatAttachments((prev) => prev.map((a, i) => i === index ? { ...a, progress } : a));
      });
      const ref: TaskAttachmentRef = {
        uploadId: presigned.uploadId, filename: file.name,
        size: file.size, contentType: file.type || 'application/octet-stream',
      };
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, status: 'complete' as const, progress: 100, ref } : a),
      );
    } catch (err) {
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' } : a),
      );
    }
  }, [projectId]);

  const handleChatFilesSelected = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const maxFiles = ATTACHMENT_DEFAULTS.MAX_FILES;
    const maxBytes = ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES;
    const batchMax = ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES;
    const newFiles: AttachmentUploadState[] = [];
    const currentTotal = chatAttachments.reduce((sum, a) => sum + a.file.size, 0);
    let runningTotal = currentTotal;
    for (const file of Array.from(files)) {
      if (chatAttachments.length + newFiles.length >= maxFiles) {
        setSubmitError(`Maximum ${maxFiles} files allowed`);
        break;
      }
      if (file.size > maxBytes) {
        setSubmitError(`${file.name} exceeds ${formatFileSize(maxBytes)} limit`);
        continue;
      }
      if (!SAFE_FILENAME_REGEX.test(file.name)) {
        setSubmitError(`${file.name} has invalid characters`);
        continue;
      }
      if (runningTotal + file.size > batchMax) {
        setSubmitError(`Total size would exceed ${formatFileSize(batchMax)} limit`);
        break;
      }
      runningTotal += file.size;
      newFiles.push({ file, uploadId: null, progress: 0, status: 'pending' });
    }
    if (newFiles.length === 0) return;
    const startIndex = chatAttachments.length;
    setChatAttachments((prev) => [...prev, ...newFiles]);
    for (let i = 0; i < newFiles.length; i++) { void handleChatFileUpload(newFiles[i]!.file, startIndex + i); }
  }, [chatAttachments, handleChatFileUpload]);

  const handleRemoveChatAttachment = useCallback((index: number) => {
    setChatAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Workspace profile selection — defaults to project setting or platform default
  const [selectedWorkspaceProfile, setSelectedWorkspaceProfile] = useState<WorkspaceProfile>(
    (project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE,
  );

  // Task mode selection — defaults based on workspace profile
  const [selectedTaskMode, setSelectedTaskMode] = useState<TaskMode>(
    ((project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE) === 'lightweight'
      ? 'conversation'
      : 'task',
  );
  const userSetTaskModeRef = useRef(false);

  // Provisioning tracking
  const [provisioning, setProvisioning] = useState<ProvisioningState | null>(null);

  // Boot log streaming during provisioning
  const bootLogStatus = provisioning?.executionStep === 'workspace_ready' ? 'creating' : undefined;
  const { logs: bootLogs } = useBootLogStream(
    provisioning?.workspaceId ?? undefined,
    provisioning?.workspaceUrl ?? undefined,
    bootLogStatus,
  );
  const [bootLogPanelOpen, setBootLogPanelOpen] = useState(false);

  // Auto-close boot log panel when provisioning completes
  useEffect(() => {
    if (!provisioning) {
      setBootLogPanelOpen(false);
    }
  }, [provisioning]);

  // Fork dialog state
  const [forkSession, setForkSession] = useState<ChatSessionResponse | null>(null);

  // Task/idea title map for session tagging
  const [taskTitleMap, setTaskTitleMap] = useState<Map<string, string>>(new Map());

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

  // Sync task mode default when workspace profile changes (only if user hasn't explicitly set mode)
  useEffect(() => {
    if (!userSetTaskModeRef.current) {
      setSelectedTaskMode(selectedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');
    }
  }, [selectedWorkspaceProfile]);

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

  // Load agent profiles for the project
  const loadProfiles = useCallback(() => {
    void listAgentProfiles(projectId)
      .then((data) => setAgentProfiles(data))
      .catch(() => { /* best-effort */ });
  }, [projectId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleUpdateProfile = useCallback(async (profileId: string, data: UpdateAgentProfileRequest) => {
    await updateAgentProfile(projectId, profileId, data);
    loadProfiles();
  }, [projectId, loadProfiles]);

  // Pre-fill message when navigating from idea Execute button
  useEffect(() => {
    if (executeIdeaId && !sessionId) {
      executeIdeaIdRef.current = executeIdeaId;
      setMessage(EXECUTE_IDEA_PROMPT_TEMPLATE.replace('{ideaId}', executeIdeaId));
      // Clear the query param so it doesn't persist on refresh
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('executeIdea');
        return next;
      }, { replace: true });
    }
  }, [executeIdeaId, sessionId, setSearchParams]);

  const loadSessions = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      // Fetch sessions and tasks independently — task fetch failure must never
      // prevent sessions from loading (see Promise.all coupling bug).
      const sessionResult = await listChatSessions(projectId, { limit: CHAT_SESSION_LIST_LIMIT });
      setSessions(sessionResult.sessions);
      hasLoadedRef.current = true;

      // Best-effort task title fetch for idea tags — failures are silently ignored
      listProjectTasks(projectId, { limit: CHAT_TASK_LIST_LIMIT })
        .then((tasksResult) => {
          const titleMap = new Map<string, string>();
          for (const t of tasksResult.tasks) {
            titleMap.set(t.id, t.title);
          }
          setTaskTitleMap(titleMap);
        })
        .catch(() => { /* task titles are cosmetic — don't break sessions */ });

      return sessionResult.sessions;
    } catch {
      return [];
    } finally {
      setIsRefreshing(false);
    }
  }, [projectId]);

  // Project-wide WebSocket for realtime sidebar updates — receives session
  // lifecycle events (created, stopped, updated, agent_completed) and refreshes
  // the session list when any arrive.
  const { connectionState } = useProjectWebSocket({
    projectId,
    onSessionChange: loadSessions,
  });

  // True when realtime updates are permanently degraded (exhausted retries).
  const realtimeDegraded = connectionState === 'disconnected';

  // Initial load — load sessions but default to the new-chat view.
  // Users pick an existing session from the sidebar; visiting the project
  // without a sessionId always shows the new-chat input.
  useEffect(() => {
    setLoading(true);
    void loadSessions().finally(() => setLoading(false));
  }, [loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll task status during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) return;

    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, provisioning.taskId);
        setProvisioning((prev) => {
          if (!prev) return null;
          const next = { ...prev, status: task.status, executionStep: task.executionStep ?? null, errorMessage: task.errorMessage ?? null };
          // Capture workspaceId when it appears
          if (task.workspaceId && !prev.workspaceId) {
            next.workspaceId = task.workspaceId;
          }
          return next;
        });

        // Fetch workspace URL once workspaceId appears and we don't have URL yet
        if (task.workspaceId && !provisioning.workspaceUrl) {
          try {
            const ws = await getWorkspace(task.workspaceId);
            if (ws.url) {
              setProvisioning((prev) => prev ? { ...prev, workspaceUrl: ws.url ?? null } : null);
            }
          } catch {
            // Workspace may not be ready yet — will retry on next poll
          }
        }

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
            workspaceId: task.workspaceId ?? null,
            workspaceUrl: null,
          });
        }
      } catch {
        // Best-effort
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, sessions, projectId, provisioning]);

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

    if (chatUploading) {
      setSubmitError('Please wait for file uploads to complete');
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      // Collect completed attachment refs
      const attachmentRefs = chatAttachments
        .filter((a) => a.status === 'complete' && a.ref)
        .map((a) => a.ref!);

      const baseRequest = selectedProfileId
        ? { message: trimmed, agentProfileId: selectedProfileId }
        : {
            message: trimmed,
            ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
            workspaceProfile: selectedWorkspaceProfile,
            taskMode: selectedTaskMode,
          };

      const result = await submitTask(projectId, attachmentRefs.length > 0
        ? { ...baseRequest, attachments: attachmentRefs }
        : baseRequest,
      );
      setMessage('');
      setChatAttachments([]);
      if (chatFileInputRef.current) chatFileInputRef.current.value = '';
      setProvisioning({
        taskId: result.taskId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
        workspaceId: null,
        workspaceUrl: null,
      });

      // Auto-link idea to the new session if this submit came from an execute-idea flow
      if (executeIdeaIdRef.current) {
        const ideaId = executeIdeaIdRef.current;
        executeIdeaIdRef.current = null;
        void linkSessionIdea(projectId, result.sessionId, ideaId, 'Executed from idea detail page').catch((err) => {
          console.warn('Failed to auto-link idea to session:', err);
        });
      }

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
    executeIdeaIdRef.current = null;
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
      const result = await submitTask(projectId, selectedProfileId
        ? { message: forkMessage, parentTaskId, contextSummary, agentProfileId: selectedProfileId }
        : {
            message: forkMessage,
            parentTaskId,
            contextSummary,
            ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
            workspaceProfile: selectedWorkspaceProfile,
            taskMode: selectedTaskMode,
          },
      );
      setProvisioning({
        taskId: result.taskId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
        workspaceId: null,
        workspaceUrl: null,
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

  const [closingConversation, setClosingConversation] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const handleCloseConversation = useCallback(async () => {
    const selectedSession = sessions.find((s) => s.id === sessionId);
    if (!selectedSession?.taskId) return;
    setClosingConversation(true);
    setCloseError(null);
    try {
      await closeConversationTask(projectId, selectedSession.taskId);
      void loadSessions();
    } catch (err) {
      console.warn('Failed to close conversation:', err);
      setCloseError(err instanceof Error ? err.message : 'Failed to close conversation');
    } finally {
      setClosingConversation(false);
    }
  }, [projectId, sessionId, sessions, loadSessions]);

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
            {realtimeDegraded && (
              <button
                type="button"
                onClick={() => void loadSessions()}
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

          {/* Subtle refresh indicator */}
          {isRefreshing && (
            <div className="h-0.5 bg-accent animate-pulse" role="status" aria-label="Refreshing sessions" />
          )}

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
                  ideaTitle={session.taskId ? taskTitleMap.get(session.taskId) : undefined}
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
            <div className={`flex-1 flex flex-col items-center gap-3 ${isMobile ? 'p-4 justify-end pb-8' : 'p-8 justify-center'}`}>
              {provisioning ? (
                <ProvisioningIndicator state={provisioning} bootLogCount={bootLogs.length} onViewLogs={() => setBootLogPanelOpen(true)} />
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
              agentProfiles={agentProfiles}
              selectedProfileId={selectedProfileId}
              onProfileChange={setSelectedProfileId}
              onUpdateProfile={handleUpdateProfile}
              selectedWorkspaceProfile={selectedWorkspaceProfile}
              onWorkspaceProfileChange={setSelectedWorkspaceProfile}
              selectedTaskMode={selectedTaskMode}
              onTaskModeChange={(mode: TaskMode) => { userSetTaskModeRef.current = true; setSelectedTaskMode(mode); }}
              slashCommands={slashCommands}
              attachments={chatAttachments}
              onFilesSelected={handleChatFilesSelected}
              onRemoveAttachment={handleRemoveChatAttachment}
              fileInputRef={chatFileInputRef}
              uploading={chatUploading}
            />
          </div>
        ) : (
          /* Active session view */
          <div className="flex-1 flex flex-col min-h-0">
            {provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status) && (
              <ProvisioningIndicator state={provisioning} bootLogCount={bootLogs.length} onViewLogs={() => setBootLogPanelOpen(true)} />
            )}
            <ProjectMessageView
              key={sessionId}
              projectId={projectId}
              sessionId={sessionId!}
              isProvisioning={!!(provisioning && sessionId === provisioning.sessionId && !isTerminal(provisioning.status))}
              onSessionMutated={() => { void loadSessions(); }}
            />
            {/* Close conversation button — shown for idle sessions with a task */}
            {(() => {
              const selectedSession = sessions.find((s) => s.id === sessionId);
              if (!selectedSession?.taskId) return null;
              const state = getSessionState(selectedSession);
              if (state !== 'idle') return null;
              return (
                <div className="shrink-0 border-t border-border-default px-4 py-2 bg-surface flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={handleCloseConversation}
                    disabled={closingConversation}
                    className="px-4 py-2.5 min-h-[44px] text-xs rounded-md border border-border-default bg-page text-fg-muted hover:text-fg-primary hover:border-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {closingConversation ? 'Closing...' : 'Close conversation'}
                  </button>
                  {closeError && <p className="text-xs text-red-500">{closeError}</p>}
                </div>
              );
            })()}
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
          realtimeDegraded={realtimeDegraded}
          isRefreshing={isRefreshing}
          onRefresh={() => void loadSessions()}
          taskTitleMap={taskTitleMap}
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

      {/* Boot log panel */}
      {bootLogPanelOpen && (
        <BootLogPanel
          logs={bootLogs}
          onClose={() => setBootLogPanelOpen(false)}
        />
      )}
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
  ideaTitle,
}: {
  session: ChatSessionResponse;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  ideaTitle?: string;
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
        {/* Idea tag */}
        {ideaTitle && (
          <div className="flex items-center gap-1 mb-1 pl-[calc(6px+8px)]">
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
              style={{
                color: 'var(--sam-color-accent-primary)',
                background: 'color-mix(in srgb, var(--sam-color-accent-primary) 12%, transparent)',
              }}
              title={`Idea: ${ideaTitle}`}
            >
              <Lightbulb size={10} /> {ideaTitle}
            </span>
          </div>
        )}
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
  realtimeDegraded = false,
  isRefreshing = false,
  onRefresh,
  taskTitleMap = new Map(),
}: {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork: (session: ChatSessionResponse) => void;
  onNewChat: () => void;
  onClose: () => void;
  realtimeDegraded?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  taskTitleMap?: Map<string, string>;
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
        <div className="shrink-0 p-3 border-b border-border-default flex items-center gap-2">
          <span className="text-sm font-semibold text-fg-primary flex-1">Chats</span>
          {realtimeDegraded && onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              title="Realtime updates paused. Tap to refresh."
              aria-label="Realtime updates paused. Tap to refresh session list."
              className="flex items-center gap-1 bg-transparent border-none cursor-pointer text-xs px-1.5 py-0.5 rounded-sm"
              style={{ color: 'var(--sam-color-warning, #f59e0b)' }}
            >
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: 'var(--sam-color-warning, #f59e0b)' }}
              />
              <span>Refresh</span>
            </button>
          )}
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

        {/* Subtle refresh indicator */}
        {isRefreshing && (
          <div className="h-0.5 bg-accent animate-pulse" role="status" aria-label="Refreshing sessions" />
        )}

        {/* Session list */}
        <nav className="flex-1 overflow-y-auto min-h-0">
          {filteredR.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onSelect={onSelect}
              onFork={onFork}
              ideaTitle={session.taskId ? taskTitleMap.get(session.taskId) : undefined}
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
                  ideaTitle={session.taskId ? taskTitleMap.get(session.taskId) : undefined}
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

function ProvisioningIndicator({ state, bootLogCount, onViewLogs }: { state: ProvisioningState; bootLogCount: number; onViewLogs: () => void }) {
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
        {bootLogCount > 0 && (
          <button
            type="button"
            onClick={onViewLogs}
            className="sam-type-caption text-accent-primary hover:underline bg-transparent border-none cursor-pointer px-2 min-h-[44px] flex items-center shrink-0"
          >
            View Logs
          </button>
        )}
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

interface ChatAttachmentDisplay {
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

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
  agentProfiles,
  selectedProfileId,
  onProfileChange,
  onUpdateProfile,
  selectedWorkspaceProfile,
  onWorkspaceProfileChange,
  selectedTaskMode,
  onTaskModeChange,
  slashCommands,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  fileInputRef,
  uploading,
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
  agentProfiles: AgentProfile[];
  selectedProfileId: string | null;
  onProfileChange: (profileId: string | null) => void;
  onUpdateProfile: (profileId: string, data: UpdateAgentProfileRequest) => Promise<void>;
  selectedWorkspaceProfile: WorkspaceProfile;
  onWorkspaceProfileChange: (profile: WorkspaceProfile) => void;
  selectedTaskMode: TaskMode;
  onTaskModeChange: (mode: TaskMode) => void;
  slashCommands?: SlashCommand[];
  attachments?: ChatAttachmentDisplay[];
  onFilesSelected?: (files: FileList | null) => void;
  onRemoveAttachment?: (index: number) => void;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
  uploading?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paletteRef = useRef<SlashCommandPaletteHandle>(null);
  const isMobile = useIsMobile();
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const hasProfile = !!selectedProfileId;
  const selectedProfile = hasProfile
    ? agentProfiles.find((p) => p.id === selectedProfileId) ?? null
    : null;

  // Slash command palette state.
  // dismissedFilterRef tracks the exact filter string at the time the user pressed
  // Escape — the palette stays closed until the filter changes (user types more).
  const dismissedFilterRef = useRef<string | null>(null);
  const slashMatch = value.match(/^\/(\S*)$/);
  const slashFilter = slashMatch?.[1] ?? '';
  // Clear the dismissed state whenever the input exits slash-command mode entirely
  // (e.g., user cleared the field) so the next "/" still opens the palette.
  if (!slashMatch && dismissedFilterRef.current !== null) {
    dismissedFilterRef.current = null;
  }
  const showPalette =
    !!slashMatch &&
    (slashCommands?.length ?? 0) > 0 &&
    dismissedFilterRef.current !== slashFilter;

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

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      onChange(`/${cmd.name} `);
      inputRef.current?.focus();
    },
    [onChange],
  );

  const handleDismissPalette = useCallback(() => {
    // Record the current filter as dismissed so the palette stays closed until
    // the user changes the input further. Does NOT clear the typed text.
    dismissedFilterRef.current = slashFilter;
    inputRef.current?.focus();
  }, [slashFilter]);

  return (
    <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface">
      {error && (
        <div className="p-2 px-3 mb-2 rounded-sm bg-danger-tint text-danger text-xs">
          {error}
        </div>
      )}
      {slashCommands && slashCommands.length > 0 && (
        <SlashCommandPalette
          ref={paletteRef}
          commands={slashCommands}
          filter={slashFilter}
          onSelect={handleCommandSelect}
          onDismiss={handleDismissPalette}
          visible={showPalette}
        />
      )}
      {isMobile ? (
        /* Mobile: compact pill bar — no labels, single row */
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {agentProfiles.length > 0 && (
            <>
              <ProfileSelector
                profiles={agentProfiles}
                selectedProfileId={selectedProfileId}
                onChange={onProfileChange}
                disabled={submitting}
                compact
                className="min-w-0 flex-1 min-h-[44px]"
              />
              {hasProfile && (
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(true)}
                  disabled={submitting}
                  aria-label="Edit profile settings"
                  className="shrink-0 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center border border-border-default rounded-md bg-page text-fg-muted hover:text-fg-primary cursor-pointer disabled:opacity-50"
                >
                  <Settings size={16} />
                </button>
              )}
            </>
          )}
          {!hasProfile && (
            <>
              {agents.length > 1 && (
                <select
                  value={selectedAgentType ?? ''}
                  onChange={(e) => onAgentTypeChange(e.target.value)}
                  disabled={submitting}
                  aria-label="Agent"
                  className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={selectedWorkspaceProfile}
                onChange={(e) => onWorkspaceProfileChange(e.target.value as WorkspaceProfile)}
                disabled={submitting}
                aria-label="Workspace profile"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                <option value="full">Full</option>
                <option value="lightweight">Lightweight</option>
              </select>
              <select
                value={selectedTaskMode}
                onChange={(e) => onTaskModeChange(e.target.value as TaskMode)}
                disabled={submitting}
                aria-label="Run mode"
                aria-describedby="mobile-task-mode-desc"
                className="min-w-0 flex-1 px-2 py-1.5 min-h-[44px] border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
              >
                <option value="task">Task</option>
                <option value="conversation">Conversation</option>
              </select>
              <span id="mobile-task-mode-desc" className="sr-only">
                {selectedTaskMode === 'task'
                  ? 'Agent will do the work, push changes, and create a PR'
                  : 'Chat with an agent. You decide when it\'s done.'}
              </span>
            </>
          )}
        </div>
      ) : (
        /* Desktop: labeled selects with wrapping */
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          {agentProfiles.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="profile-select" className="text-xs text-fg-muted whitespace-nowrap">Profile:</label>
              <ProfileSelector
                id="profile-select"
                profiles={agentProfiles}
                selectedProfileId={selectedProfileId}
                onChange={onProfileChange}
                disabled={submitting}
                compact
              />
              {hasProfile && (
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(true)}
                  disabled={submitting}
                  aria-label="Edit profile settings"
                  className="shrink-0 p-1 border border-border-default rounded-md bg-page text-fg-muted hover:text-fg-primary cursor-pointer disabled:opacity-50"
                >
                  <Settings size={14} />
                </button>
              )}
            </div>
          )}
          {!hasProfile && (
            <>
              {agents.length > 1 && (
                <div className="flex items-center gap-2">
                  <label htmlFor="agent-type-select" className="text-xs text-fg-muted whitespace-nowrap">Agent:</label>
                  <select
                    id="agent-type-select"
                    value={selectedAgentType ?? ''}
                    onChange={(e) => onAgentTypeChange(e.target.value)}
                    disabled={submitting}
                    className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
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
                  className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                >
                  <option value="full">Full</option>
                  <option value="lightweight">Lightweight</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="task-mode-select" className="text-xs text-fg-muted whitespace-nowrap">Run mode:</label>
                <select
                  id="task-mode-select"
                  value={selectedTaskMode}
                  onChange={(e) => onTaskModeChange(e.target.value as TaskMode)}
                  disabled={submitting}
                  className="px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs outline-none cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
                  aria-describedby="task-mode-desc"
                >
                  <option value="task">Task</option>
                  <option value="conversation">Conversation</option>
                </select>
                <span id="task-mode-desc" className="sr-only">
                  {selectedTaskMode === 'task'
                    ? 'Agent will do the work, push changes, and create a PR'
                    : 'Chat with an agent. You decide when it\'s done.'}
                </span>
              </div>
            </>
          )}
        </div>
      )}
      {/* Attachment chips */}
      {attachments && attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((att, index) => (
            <div
              key={`${att.file.name}-${index}`}
              className="relative flex items-center gap-1.5 py-1 px-2 rounded-sm bg-page border border-border-default text-xs max-w-[220px] overflow-hidden"
            >
              <span className="truncate text-fg-primary" title={att.file.name}>{att.file.name}</span>
              <span className="text-fg-muted shrink-0">
                {att.status === 'uploading' ? `${att.progress}%` : formatFileSize(att.file.size)}
              </span>
              {att.status === 'error' && <span className="text-danger shrink-0" title={att.error}>!</span>}
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  className="shrink-0 p-0.5 bg-transparent border-none text-fg-muted hover:text-fg-primary cursor-pointer"
                  aria-label={`Remove ${att.file.name}`}
                >
                  <X size={12} />
                </button>
              )}
              {att.status === 'uploading' && (
                <div className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis rounded-full transition-all" style={{ width: `${att.progress}%` }} />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        {/* Attachment button */}
        {onFilesSelected && (
          <>
            <input
              ref={fileInputRef as React.RefObject<HTMLInputElement>}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => onFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => (fileInputRef as React.RefObject<HTMLInputElement>)?.current?.click()}
              disabled={submitting || uploading}
              className="shrink-0 p-2 bg-transparent border border-border-default rounded-md text-fg-muted hover:text-fg-primary hover:border-fg-muted cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Attach files"
              title="Attach files to this task"
            >
              <Paperclip size={18} />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Delegate to slash command palette first
            if (paletteRef.current?.handleKeyDown(e as unknown as React.KeyboardEvent)) return;
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={submitting}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPalette}
          aria-controls={showPalette ? 'slash-palette-listbox' : undefined}
          aria-activedescendant={showPalette ? paletteRef.current?.activeDescendantId : undefined}
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
          disabled={submitting || !value.trim() || uploading}
          className="px-3 py-2 border-none rounded-md text-base font-medium whitespace-nowrap"
          style={{
            backgroundColor: submitting || !value.trim() || uploading ? 'var(--sam-color-bg-inset)' : 'var(--sam-color-accent-primary)',
            color: submitting || !value.trim() || uploading ? 'var(--sam-color-fg-muted)' : 'white',
            cursor: submitting || !value.trim() || uploading ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'Sending...' : 'Send'}
        </button>
      </div>
      {!isMobile && (
        <div className="sam-type-caption text-fg-muted mt-1">
          Press Ctrl+Enter to send, Enter for new line
        </div>
      )}
      {selectedProfile && (
        <ProfileFormDialog
          isOpen={editProfileOpen}
          onClose={() => setEditProfileOpen(false)}
          profile={selectedProfile}
          onSave={async (data) => {
            await onUpdateProfile(selectedProfile.id, data as UpdateAgentProfileRequest);
          }}
        />
      )}
    </div>
  );
}
