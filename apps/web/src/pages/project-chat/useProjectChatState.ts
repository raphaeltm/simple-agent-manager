import type { AgentInfo, AgentProfile, Task, TaskMode, UpdateAgentProfileRequest, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useAvailableCommands } from '../../hooks/useAvailableCommands';
import { useBootLogStream } from '../../hooks/useBootLogStream';
import { useProjectWebSocket } from '../../hooks/useProjectWebSocket';
import type { ChatSessionResponse } from '../../lib/api';
import {
  closeConversationTask,
  getProjectTask,
  getTranscribeApiUrl,
  getTrialStatus,
  getWorkspace,
  linkSessionIdea,
  listAgentProfiles,
  listAgents,
  listChatSessions,
  listCredentials,
  listProjectTasks,
  submitTask,
  updateAgentProfile,
} from '../../lib/api';
import {
  getSessionState,
  isStaleSession,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';
import { useProjectContext } from '../ProjectContext';
import type { ProvisioningState } from './types';
import {
  CHAT_SESSION_LIST_LIMIT,
  CHAT_TASK_LIST_LIMIT,
  EXECUTE_IDEA_PROMPT_TEMPLATE,
  isTerminal,
  TASK_STATUS_POLL_MS,
} from './types';
import { useAttachments } from './useAttachments';
import { buildTaskInfoMap, type TaskInfo } from './useTaskGroups';

export function useProjectChatState() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId, project, settingsOpen, setSettingsOpen, infoPanelOpen, setInfoPanelOpen } = useProjectContext();

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
  // Pass sessionId as refreshKey so cached commands are re-fetched when switching sessions
  // (ensures commands persisted during session N are available in session N+1)
  const { commands: slashCommands } = useAvailableCommands(projectId, undefined, sessionId);

  // File attachments (extracted hook)
  const attachments = useAttachments(projectId, setSubmitError);

  // Workspace profile selection — defaults to project setting or platform default
  const [selectedWorkspaceProfile, setSelectedWorkspaceProfile] = useState<WorkspaceProfile>(
    (project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE,
  );

  // Devcontainer config name — empty string means auto-detect
  const [selectedDevcontainerConfigName, setSelectedDevcontainerConfigName] = useState(
    project?.defaultDevcontainerConfigName ?? '',
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
    if (!provisioning) setBootLogPanelOpen(false);
  }, [provisioning]);

  // Fork & Retry dialog state
  const [forkSession, setForkSession] = useState<ChatSessionResponse | null>(null);
  const [retrySession, setRetrySession] = useState<ChatSessionResponse | null>(null);

  // Task/idea title map for session tagging + task info map for grouping
  const [taskTitleMap, setTaskTitleMap] = useState<Map<string, string>>(new Map());
  const [taskInfoMap, setTaskInfoMap] = useState<Map<string, TaskInfo>>(new Map());

  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // Close conversation state
  const [closingConversation, setClosingConversation] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Session filtering
  // ---------------------------------------------------------------------------

  const { recentSessions, staleSessions } = useMemo(() => {
    const recent: ChatSessionResponse[] = [];
    const stale: ChatSessionResponse[] = [];
    for (const s of sessions) {
      if (isStaleSession(s)) stale.push(s);
      else recent.push(s);
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

  const effectiveShowStale = showStale || !!searchQuery.trim();

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!userSetTaskModeRef.current) {
      setSelectedTaskMode(selectedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');
    }
  }, [selectedWorkspaceProfile]);

  useEffect(() => {
    void Promise.all([
      listCredentials().catch(() => []),
      getTrialStatus().catch(() => null),
    ]).then(([creds, trial]) => {
      const hasUserCreds = creds.some((c: { provider: string }) => c.provider === 'hetzner' || c.provider === 'scaleway');
      const trialAvailable = trial?.available ?? false;
      setHasCloudCredentials(hasUserCreds || trialAvailable);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listAgents()
      .then((data) => {
        if (cancelled) return;
        const acpAgents = (data.agents || []).filter((a) => a.configured && a.supportsAcp);
        setConfiguredAgents(acpAgents);
        if (!selectedAgentType && acpAgents.length > 0) {
          setSelectedAgentType(acpAgents[0]!.id);
        }
      })
      .catch((err: unknown) => { console.error('Failed to load agents', err); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadProfiles = useCallback(() => {
    void listAgentProfiles(projectId)
      .then((data) => setAgentProfiles(data))
      .catch((err: unknown) => { console.error('Failed to load agent profiles', err); });
  }, [projectId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const handleUpdateProfile = useCallback(async (profileId: string, data: UpdateAgentProfileRequest) => {
    await updateAgentProfile(projectId, profileId, data);
    loadProfiles();
  }, [projectId, loadProfiles]);

  useEffect(() => {
    if (executeIdeaId && !sessionId) {
      executeIdeaIdRef.current = executeIdeaId;
      setMessage(EXECUTE_IDEA_PROMPT_TEMPLATE.replace('{ideaId}', executeIdeaId));
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('executeIdea');
        return next;
      }, { replace: true });
    }
  }, [executeIdeaId, sessionId, setSearchParams]);

  const loadSessions = useCallback(async () => {
    if (hasLoadedRef.current) setIsRefreshing(true);
    try {
      const sessionResult = await listChatSessions(projectId, { limit: CHAT_SESSION_LIST_LIMIT });
      setSessions(sessionResult.sessions);
      hasLoadedRef.current = true;

      listProjectTasks(projectId, { limit: CHAT_TASK_LIST_LIMIT })
        .then((tasksResult) => {
          const titleMap = new Map<string, string>();
          for (const t of tasksResult.tasks) titleMap.set(t.id, t.title);
          setTaskTitleMap(titleMap);
          setTaskInfoMap(buildTaskInfoMap(tasksResult.tasks as Task[]));
        })
        .catch(() => { /* task titles are cosmetic */ });

      return sessionResult.sessions;
    } catch {
      return [];
    } finally {
      setIsRefreshing(false);
    }
  }, [projectId]);

  const { connectionState } = useProjectWebSocket({
    projectId,
    onSessionChange: loadSessions,
  });

  const realtimeDegraded = connectionState === 'disconnected';

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
          if (task.workspaceId && !prev.workspaceId) next.workspaceId = task.workspaceId;
          return next;
        });
        if (task.workspaceId && !provisioning.workspaceUrl) {
          try {
            const ws = await getWorkspace(task.workspaceId);
            if (ws.url) setProvisioning((prev) => prev ? { ...prev, workspaceUrl: ws.url ?? null } : null);
          } catch { /* Workspace may not be ready yet */ }
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
      } catch { /* Continue polling on transient errors */ }
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
            taskId: task.id, sessionId,
            branchName: task.outputBranch ?? '',
            status: task.status, executionStep: task.executionStep ?? null,
            errorMessage: task.errorMessage ?? null,
            startedAt: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
            workspaceId: task.workspaceId ?? null, workspaceUrl: null,
          });
        }
      } catch { /* Best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [sessionId, sessions, projectId, provisioning]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (!hasCloudCredentials) {
      setSubmitError('Cloud credentials required. Go to Settings to connect your Hetzner account.');
      return;
    }
    if (attachments.chatUploading) {
      setSubmitError('Please wait for file uploads to complete');
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const attachmentRefs = attachments.chatAttachments
        .filter((a) => a.status === 'complete' && a.ref)
        .map((a) => a.ref!);
      const baseRequest = selectedProfileId
        ? { message: trimmed, agentProfileId: selectedProfileId }
        : {
            message: trimmed,
            ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
            workspaceProfile: selectedWorkspaceProfile,
            ...(selectedWorkspaceProfile !== 'lightweight' && selectedDevcontainerConfigName.trim()
              ? { devcontainerConfigName: selectedDevcontainerConfigName.trim() }
              : {}),
            taskMode: selectedTaskMode,
          };
      const result = await submitTask(projectId, attachmentRefs.length > 0
        ? { ...baseRequest, attachments: attachmentRefs }
        : baseRequest,
      );
      setMessage('');
      attachments.clearAttachments();
      setProvisioning({
        taskId: result.taskId, sessionId: result.sessionId,
        branchName: result.branchName, status: 'queued',
        executionStep: null, errorMessage: null,
        startedAt: Date.now(), workspaceId: null, workspaceUrl: null,
      });
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

  /** Submit a new task derived from an existing session (used by both fork and retry). */
  const submitDerivedTask = async (derivedMessage: string, contextSummary: string, parentTaskId: string, errorLabel: string) => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitTask(projectId, selectedProfileId
        ? { message: derivedMessage, parentTaskId, contextSummary, agentProfileId: selectedProfileId }
        : {
            message: derivedMessage, parentTaskId, contextSummary,
            ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
            workspaceProfile: selectedWorkspaceProfile,
            taskMode: selectedTaskMode,
          },
      );
      setProvisioning({
        taskId: result.taskId, sessionId: result.sessionId,
        branchName: result.branchName, status: 'queued',
        executionStep: null, errorMessage: null,
        startedAt: Date.now(), workspaceId: null, workspaceUrl: null,
      });
      navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
      void loadSessions();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : errorLabel);
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  const handleFork = async (forkMessage: string, contextSummary: string, parentTaskId: string) => {
    return submitDerivedTask(forkMessage, contextSummary, parentTaskId, 'Failed to fork session');
  };

  const handleRetry = async (retryMessage: string, contextSummary: string, parentTaskId: string) => {
    return submitDerivedTask(retryMessage, contextSummary, parentTaskId, 'Failed to retry task');
  };

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

  const handleTaskModeChange = useCallback((mode: TaskMode) => {
    userSetTaskModeRef.current = true;
    setSelectedTaskMode(mode);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;

  return {
    projectId, project, sessionId,
    settingsOpen, setSettingsOpen, infoPanelOpen, setInfoPanelOpen,
    sessions, loading, isRefreshing, hasSessions, showNewChatInput,
    loadSessions, realtimeDegraded,
    sidebarOpen, setSidebarOpen,
    searchQuery, setSearchQuery, showStale, setShowStale,
    filteredRecent, filteredStale, effectiveShowStale, taskTitleMap, taskInfoMap,
    message, setMessage, submitting, submitError,
    handleSubmit, handleNewChat, handleSelect,
    configuredAgents, selectedAgentType, setSelectedAgentType,
    agentProfiles, selectedProfileId, setSelectedProfileId,
    handleUpdateProfile, slashCommands,
    selectedWorkspaceProfile, setSelectedWorkspaceProfile,
    selectedDevcontainerConfigName, setSelectedDevcontainerConfigName,
    selectedTaskMode, handleTaskModeChange,
    ...attachments,
    provisioning, bootLogs, bootLogPanelOpen, setBootLogPanelOpen,
    forkSession, setForkSession, handleFork,
    retrySession, setRetrySession, handleRetry,
    closingConversation, closeError, handleCloseConversation,
    transcribeApiUrl, getSessionState,
  };
}
