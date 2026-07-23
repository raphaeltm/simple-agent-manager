// FILE SIZE EXCEPTION: Pre-existing project chat state hook exceeds the 800-line gate on main; split as follow-up outside shared runtime fix scope.
import type { AgentInfo, AgentProfile, AgentProfileRuntime, CreateAgentProfileRequest, ProviderCatalog, Task, TaskMode, UpdateAgentProfileRequest, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE, DEFAULT_WORKSPACE_PROFILE, hasByocComputeCredential } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useAvailableCommands } from '../../hooks/useAvailableCommands';
import { useBootLogStream } from '../../hooks/useBootLogStream';
import { type RawSessionEvent, useProjectWebSocket } from '../../hooks/useProjectWebSocket';
import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import {
  closeConversationTask,
  createAgentProfile,
  getProjectTask,
  getProviderCatalog,
  getTranscribeApiUrl,
  getTrialStatus,
  getWorkspace,
  linkSessionIdea,
  listAgentProfiles,
  listAgents,
  listChatSessions,
  listCredentials,
  listProjectTasks,
  prepareForkSession,
  startInstantChatSession,
  stopChatSession,
  submitTask,
  summarizeSession,
  updateAgentProfile,
} from '../../lib/api';
import {
  getSessionState,
  isStaleSession,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';
import { useProjectContext } from '../ProjectContext';
import { isRetryOrFork } from './lineageUtils';
import {
  FORK_MESSAGE_TEMPLATE,
  resolveInitialVmSize,
  resolveWizardRuntime,
  resolveWizardTaskMode,
  resolveWizardWorkspaceProfile,
  selectProfileId,
} from './profileWizardHelpers';
import { buildBaseSubmitRequest, getCompletedAttachmentRefs, withAttachmentRefs } from './submitRequest';
import type { ProvisioningState } from './types';
import {
  CHAT_SESSION_LIST_LIMIT,
  CHAT_TASK_LIST_LIMIT,
  EXECUTE_IDEA_PROMPT_TEMPLATE,
  isTerminal,
  SESSION_SYNC_INTERVAL_MS,
  TASK_STATUS_POLL_MS,
} from './types';
import { useAttachments } from './useAttachments';
import { useProjectSkills } from './useProjectSkills';
import { useSessionReducer } from './useSessionReducer';
import { rawToSessionEvent } from './useSessionReducer';
import { useStableTaskInfoMap } from './useStableTaskInfoMap';

/** Pre-filled fork/retry context shown on the new chat screen. */
export interface PendingDerived {
  type: 'fork' | 'retry';
  parentSessionId: string;
  parentSessionLabel: string;
  parentTaskId: string;
  parentBranch?: string;
  errorMessage?: string;
  contextSummary: string;
  summaryLoading: boolean;
}

export type ProfileWizardStep = 'agent' | 'work-type' | 'runtime' | 'vm-size' | 'name';
export type SessionScope = 'my' | 'all';

export interface ProfileWizardState {
  open: boolean;
  step: ProfileWizardStep;
  selectedAgentType: string | null;
  workType: TaskMode | null;
  runtime: AgentProfileRuntime | null;
  vmSize: VMSize | null;
  profileName: string;
  saving: boolean;
  error: string | null;
}


export function useProjectChatState() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projectId, project } = useProjectContext();

  // Execute-idea flow: pre-fill message and track ideaId for auto-linking
  const executeIdeaId = searchParams.get('executeIdea');
  const executeIdeaIdRef = useRef<string | null>(null);

  const { sessions, dispatchEvent, resetSessions } = useSessionReducer();
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);
  const [hasUserCloudCredentials, setHasUserCloudCredentials] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar filtering
  const [searchQuery, setSearchQuery] = useState('');
  const [showStale, setShowStale] = useState(false);
  const [sessionScope, setSessionScope] = useState<SessionScope>('all');
  const multiplayerActive = Boolean(project?.multiplayerActive);

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
  const { skills, selectedSkillId, setSelectedSkillId } = useProjectSkills(projectId);
  const [providerCatalogs, setProviderCatalogs] = useState<ProviderCatalog[]>([]);
  const [profileWizard, setProfileWizard] = useState<ProfileWizardState>({
    open: false,
    step: 'agent',
    selectedAgentType: null,
    workType: null,
    runtime: null,
    vmSize: null,
    profileName: '',
    saving: false,
    error: null,
  });

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
  const [selectedVmSizeOverride, setSelectedVmSizeOverride] = useState<VMSize | null>(null);
  const selectedVmSize = selectedVmSizeOverride ?? resolveInitialVmSize(project?.defaultVmSize);

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

  // Fork & Retry — navigate to new chat screen with pre-filled state
  const [pendingDerived, setPendingDerived] = useState<PendingDerived | null>(null);

  // Task/idea title map for session tagging + task info map for grouping
  const [taskTitleMap, setTaskTitleMap] = useState<Map<string, string>>(new Map());
  const { taskInfoMap, replaceAll: replaceTaskInfoMap } = useStableTaskInfoMap();

  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // Close conversation state
  const [closingConversation, setClosingConversation] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Session filtering
  // ---------------------------------------------------------------------------

  const { recentSessions, staleSessions } = useMemo(() => {
    const recent: ChatSessionListItem[] = [];
    const stale: ChatSessionListItem[] = [];
    for (const s of sessions) {
      // Stopped retries/forks auto-collapse into the Older bucket.
      // A stopped retry/fork is a terminated session whose task has a
      // parentTaskId and was user-triggered (not agent-dispatched).
      const isStoppedRetryOrFork = (() => {
        if (s.status !== 'stopped' || !s.taskId) return false;
        const info = taskInfoMap.get(s.taskId);
        if (!info?.parentTaskId) return false;
        return isRetryOrFork(info);
      })();

      if (isStaleSession(s) || isStoppedRetryOrFork) stale.push(s);
      else recent.push(s);
    }
    return { recentSessions: recent, staleSessions: stale };
  }, [sessions, taskInfoMap]);

  const filteredRecent = useMemo(() => {
    if (!searchQuery.trim()) return recentSessions;
    const q = searchQuery.toLowerCase();
    return recentSessions.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q))
        || s.id.includes(q)
        || (s.createdBy?.name?.toLowerCase().includes(q) ?? false)
        || (s.createdBy?.email?.toLowerCase().includes(q) ?? false),
    );
  }, [recentSessions, searchQuery]);

  const filteredStale = useMemo(() => {
    if (!searchQuery.trim()) return staleSessions;
    const q = searchQuery.toLowerCase();
    return staleSessions.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q))
        || s.id.includes(q)
        || (s.createdBy?.name?.toLowerCase().includes(q) ?? false)
        || (s.createdBy?.email?.toLowerCase().includes(q) ?? false),
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
    if (!multiplayerActive) {
      setSessionScope('all');
    }
  }, [multiplayerActive]);


  useEffect(() => {
    void Promise.all([
      listCredentials().catch(() => []),
      getTrialStatus().catch(() => null),
    ]).then(([creds, trial]) => {
      const hasUserCreds = hasByocComputeCredential(creds);
      const trialAvailable = trial?.available ?? false;
      const hasCloud = hasUserCreds || trialAvailable;
      setHasUserCloudCredentials(hasUserCreds);
      setHasCloudCredentials(hasCloud);
      if (hasCloud) {
        void getProviderCatalog()
          .then((response) => setProviderCatalogs(response.catalogs ?? []))
          .catch(() => setProviderCatalogs([]));
      } else {
        setProviderCatalogs([]);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listAgents()
      .then((data) => {
        if (cancelled) return;
        const acpAgents = (data.agents || []).filter((a) => a.configured && a.supportsAcp);
        setConfiguredAgents(acpAgents);
        const firstAgent = acpAgents[0];
        if (!selectedAgentType && firstAgent) {
          setSelectedAgentType(firstAgent.id);
        }
      })
      .catch((err: unknown) => { console.error('Failed to load agents', err); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadProfiles = useCallback(() => {
    void listAgentProfiles(projectId)
      .then((data) => {
        setAgentProfiles(data);
        setSelectedProfileId((current) => selectProfileId(current, data));
      })
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
      const scope = multiplayerActive ? sessionScope : 'all';
      const sessionResult = await listChatSessions(projectId, { limit: CHAT_SESSION_LIST_LIMIT, scope });
      resetSessions(sessionResult.sessions);
      hasLoadedRef.current = true;

      listProjectTasks(projectId, { limit: CHAT_TASK_LIST_LIMIT })
        .then((tasksResult) => {
          const titleMap = new Map<string, string>();
          for (const t of tasksResult.tasks) titleMap.set(t.id, t.title);
          setTaskTitleMap(titleMap);
          replaceTaskInfoMap(tasksResult.tasks as Task[]);
        })
        .catch(() => { /* task titles are cosmetic */ });

      return sessionResult.sessions;
    } catch {
      return [];
    } finally {
      setIsRefreshing(false);
    }
  }, [projectId, sessionScope, multiplayerActive, resetSessions, replaceTaskInfoMap]);

  const handleSessionEvent = useCallback((raw: RawSessionEvent) => {
    // session.created deltas cannot be scope-filtered client-side (we don't
    // know isMine from the wire payload), so fall back to a full refetch when
    // the user is viewing "My sessions" to let the server apply the filter.
    if (raw.type === 'session.created' && multiplayerActive && sessionScope === 'my') {
      void loadSessions();
      return;
    }
    const event = rawToSessionEvent(raw);
    if (event) dispatchEvent(event);
  }, [dispatchEvent, multiplayerActive, sessionScope, loadSessions]);

  const { connectionState } = useProjectWebSocket({
    projectId,
    onSessionEvent: handleSessionEvent,
    onReconnected: loadSessions,
  });

  const realtimeDegraded = connectionState === 'disconnected';

  useEffect(() => {
    setLoading(true);
    void loadSessions().finally(() => setLoading(false));
  }, [loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic background sync — self-heals if a WebSocket delta was silently dropped.
  // Depends on `loading` to defer until the first load completes.
  useEffect(() => {
    if (loading) return;
    const interval = setInterval(() => void loadSessions(), SESSION_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading, loadSessions]);

  // Poll task status during provisioning
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) return;
    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, provisioning.taskId);
        setProvisioning((prev) => {
          if (!prev) return null;
          const next = { ...prev, status: task.status, executionStep: task.executionStep ?? null, errorMessage: task.errorMessage ?? null, requestedVmSize: task.requestedVmSize ?? prev.requestedVmSize, provisionedVmSize: task.provisionedVmSize ?? prev.provisionedVmSize };
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
    const selectedTaskId = selectedSession.taskId;
    let cancelled = false;
    void (async () => {
      try {
        const task = await getProjectTask(projectId, selectedTaskId);
        if (cancelled) return;
        if (!isTerminal(task.status) && task.status !== 'in_progress') {
          setProvisioning({
            taskId: task.id, sessionId,
            branchName: task.outputBranch ?? '',
            status: task.status, executionStep: task.executionStep ?? null,
            errorMessage: task.errorMessage ?? null,
            startedAt: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
            workspaceId: task.workspaceId ?? null, workspaceUrl: null,
            requestedVmSize: task.requestedVmSize ?? null,
            provisionedVmSize: task.provisionedVmSize ?? null,
          });
        }
      } catch { /* Best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [sessionId, sessions, projectId, provisioning]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const suggestProfileName = useCallback((agentType: string | null, workType: TaskMode | null) => {
    const agent = configuredAgents.find((candidate) => candidate.id === agentType);
    const agentName = agent?.name ?? 'Agent';
    return workType === 'task' ? `${agentName} Tasks` : `${agentName} Chat`;
  }, [configuredAgents]);

  const openProfileWizard = useCallback(() => {
    const soleAgent = configuredAgents.length === 1 ? configuredAgents[0] : null;
    const initialAgentType = soleAgent?.id ?? selectedAgentType ?? configuredAgents[0]?.id ?? null;
    setProfileWizard({
      open: true,
      step: soleAgent ? 'work-type' : 'agent',
      selectedAgentType: initialAgentType,
      workType: null,
      runtime: null,
      vmSize: null,
      profileName: '',
      saving: false,
      error: null,
    });
  }, [configuredAgents, selectedAgentType]);

  const closeProfileWizard = useCallback(() => {
    setProfileWizard((current) => ({ ...current, open: false, saving: false, error: null }));
  }, []);

  const updateProfileWizard = useCallback((patch: Partial<ProfileWizardState>) => {
    setProfileWizard((current) => ({ ...current, ...patch, error: null }));
  }, []);

  const createProfile = useCallback(async (data: CreateAgentProfileRequest) => {
    const profile = await createAgentProfile(projectId, data);
    setAgentProfiles((current) => {
      const withoutDuplicate = current.filter((candidate) => candidate.id !== profile.id);
      return [...withoutDuplicate, profile];
    });
    setSelectedProfileId(profile.id);
    return profile;
  }, [projectId]);

  const createProfileFromWizard = useCallback(async () => {
    const name = profileWizard.profileName.trim();
    if (!name) {
      setProfileWizard((current) => ({ ...current, error: 'Profile name is required' }));
      return null;
    }
    if (agentProfiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      setProfileWizard((current) => ({ ...current, error: `Profile "${name}" already exists` }));
      return null;
    }
    const agentType = profileWizard.selectedAgentType ?? configuredAgents[0]?.id;
    if (!agentType) {
      setProfileWizard((current) => ({ ...current, error: 'Choose an agent before creating a profile' }));
      return null;
    }
    const workType = profileWizard.workType ?? 'conversation';
    const runtime = resolveWizardRuntime(workType, profileWizard.runtime);
    const vmSize = profileWizard.vmSize ?? DEFAULT_VM_SIZE;
    setProfileWizard((current) => ({ ...current, saving: true, error: null }));
    try {
      const profile = await createProfile({
        name,
        description: workType === 'task' ? 'Write code and open pull requests' : 'Chat and explore with a lightweight workspace',
        agentType,
        runtime,
        vmSizeOverride: runtime === 'cf-container' ? null : vmSize,
        workspaceProfile: resolveWizardWorkspaceProfile(runtime, workType),
        taskMode: resolveWizardTaskMode(runtime, workType),
      });
      setProfileWizard((current) => ({ ...current, open: false, saving: false, error: null }));
      return profile;
    } catch (err) {
      setProfileWizard((current) => ({
        ...current,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to create profile',
      }));
      return null;
    }
  }, [agentProfiles, configuredAgents, createProfile, profileWizard.profileName, profileWizard.runtime, profileWizard.selectedAgentType, profileWizard.vmSize, profileWizard.workType]);

  const resolveProfileIdForSubmit = useCallback(async () => {
    if (selectedProfileId) return selectedProfileId;
    if (configuredAgents.length === 0) {
      setSubmitError('Add an agent in Settings before starting a chat.');
      return null;
    }
    if (agentProfiles.length > 0) return agentProfiles[0]?.id ?? null;

    openProfileWizard();
    setSubmitError('Create a profile before sending your first message.');
    return null;
  }, [agentProfiles, configuredAgents.length, openProfileWizard, selectedProfileId]);

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (attachments.chatUploading) {
      setSubmitError('Please wait for file uploads to complete');
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const submitProfileId = await resolveProfileIdForSubmit();
      if (!submitProfileId) return;

      const selectedProfile = agentProfiles.find((profile) => profile.id === submitProfileId) ?? null;
      const selectedSkill = selectedSkillId
        ? skills.find((skill) => skill.id === selectedSkillId) ?? null
        : null;
      const attachmentRefs = getCompletedAttachmentRefs(attachments.chatAttachments);
      const selectedRuntime = selectedSkill?.runtime ?? selectedProfile?.runtime ?? null;
      const requiresTaskSubmission = attachmentRefs.length > 0 || executeIdeaIdRef.current !== null;
      const useInstantSession = selectedRuntime === 'cf-container' && !requiresTaskSubmission;

      if (useInstantSession) {
        const result = await startInstantChatSession(projectId, {
          message: trimmed,
          agentProfileId: submitProfileId,
          skillId: selectedSkillId ?? undefined,
          parentTaskId: pendingDerived?.parentTaskId || undefined,
          contextSummary: pendingDerived?.contextSummary || undefined,
        });
        setMessage('');
        setPendingDerived(null);
        attachments.clearAttachments();
        newChatIntentRef.current = false;
        navigate(`/projects/${projectId}/chat/${result.sessionId}`, { replace: true });
        loadSessions().catch(() => undefined);
        return;
      }

      if (!hasCloudCredentials) {
        setSubmitError('Cloud credentials required. Connect a cloud provider in Settings, or ask your admin to enable platform trial.');
        return;
      }

      const baseRequest = buildBaseSubmitRequest({
        message: trimmed,
        agentProfileId: submitProfileId,
        skillId: selectedSkillId,
        selectedAgentType,
        selectedVmSize,
        selectedWorkspaceProfile,
        selectedDevcontainerConfigName,
        selectedTaskMode,
        pendingDerived,
      });
      const result = await submitTask(projectId, withAttachmentRefs(baseRequest, attachmentRefs));
      setMessage('');
      setPendingDerived(null);
      attachments.clearAttachments();
      setProvisioning({
        taskId: result.taskId, sessionId: result.sessionId,
        branchName: result.branchName, status: 'queued',
        executionStep: null, errorMessage: null,
        startedAt: Date.now(), workspaceId: null, workspaceUrl: null,
        requestedVmSize: null, provisionedVmSize: null,
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
    setPendingDerived(null);
    navigate(`/projects/${projectId}/chat`, { replace: true });
    setMessage('');
    setSubmitError(null);
    setProvisioning(null);
  }, [navigate, projectId]);

  const handleSelect = useCallback((id: string) => {
    newChatIntentRef.current = false;
    setPendingDerived(null);
    setProvisioning(null);
    setSidebarOpen(false);
    navigate(`/projects/${projectId}/chat/${id}`);
  }, [navigate, projectId]);

  /** Prepare canonical fork lineage on the server, then open the new-chat composer. */
  const handleFork = useCallback((session: ChatSessionResponse) => {
    setSubmitError(null);
    const provisionalLabel = session.topic ? stripMarkdown(session.topic) : "Chat " + session.id.slice(0, 8);
    newChatIntentRef.current = true;
    setPendingDerived({
      type: "fork", parentSessionId: session.id, parentSessionLabel: provisionalLabel,
      parentTaskId: session.task?.id ?? session.taskId ?? "",
      parentBranch: session.task?.outputBranch ?? undefined,
      contextSummary: "", summaryLoading: true,
    });
    setMessage(FORK_MESSAGE_TEMPLATE);
    setProvisioning(null);
    navigate("/projects/" + projectId + "/chat", { replace: true });
    void prepareForkSession(projectId, session.id)
      .then((result) => {
        const sessionLabel = stripMarkdown(result.sessionLabel);
        const forkContext = [
          `Previous session: "${sessionLabel}"`,
          `Parent project ID: ${projectId}`,
          `Parent session ID: ${result.parentSessionId}`,
          `Parent task ID: ${result.parentTaskId}`,
        ].join("\n");
        newChatIntentRef.current = true;
        setPendingDerived({
          type: "fork",
          parentSessionId: result.parentSessionId,
          parentSessionLabel: sessionLabel,
          parentTaskId: result.parentTaskId,
          parentBranch: result.parentBranch ?? undefined,
          contextSummary: [
            "## Fork Context", forkContext, "",
            result.summary ? `## Previous Session Summary\n${result.summary}` : "",
          ].filter(Boolean).join("\n"),
          summaryLoading: false,
        });
        executeIdeaIdRef.current = null;
        setMessage(`${FORK_MESSAGE_TEMPLATE}${forkContext}\n\n`);
        setProvisioning(null);
        navigate(`/projects/${projectId}/chat`, { replace: true });
      })
      .catch((err: unknown) => {
        setSubmitError(err instanceof Error ? err.message : "Unable to prepare fork");
      });
  }, [navigate, projectId]);

  /** Navigate to new chat screen with retry context pre-filled. */
  const handleRetry = useCallback((session: ChatSessionResponse) => {
    const taskId = session.task?.id ?? session.taskId;
    if (!taskId) return;
    const sessionLabel = session.topic ? stripMarkdown(session.topic) : `Chat ${session.id.slice(0, 8)}`;

    const derived: PendingDerived = {
      type: 'retry',
      parentSessionId: session.id,
      parentSessionLabel: sessionLabel,
      parentTaskId: taskId,
      parentBranch: session.task?.outputBranch ?? undefined,
      errorMessage: session.task?.errorMessage ?? undefined,
      contextSummary: '',
      summaryLoading: true,
    };
    setPendingDerived(derived);
    newChatIntentRef.current = true;
    executeIdeaIdRef.current = null;
    setSubmitError(null);
    setProvisioning(null);
    navigate(`/projects/${projectId}/chat`, { replace: true });

    void Promise.all([
      getProjectTask(projectId, taskId).then((task) => task.description ?? '').catch(() => ''),
      summarizeSession(projectId, session.id).then((r) => r.summary).catch(() => ''),
    ]).then(([taskDescription, summary]) => {
      setMessage(taskDescription);
      const retryContext = [
        `## Retry Context`,
        `This is a retry of a previous task that may have failed or produced unsatisfactory results.`,
        `Previous session: ${sessionLabel}`,
        `Previous session ID: ${session.id}`,
        `Previous task ID: ${taskId}`,
        '',
        summary ? `## Previous Session Summary\n${summary}` : '',
      ].filter(Boolean).join('\n');
      setPendingDerived((prev) => prev?.parentSessionId === session.id
        ? { ...prev, contextSummary: retryContext, summaryLoading: false }
        : prev);
    });
  }, [navigate, projectId]);

  const handleCloseConversation = useCallback(async () => {
    const selectedSession = sessions.find((s) => s.id === sessionId);
    if (!selectedSession) return;
    setClosingConversation(true);
    setCloseError(null);
    try {
      if (selectedSession.taskId) {
        await closeConversationTask(projectId, selectedSession.taskId);
      } else {
        await stopChatSession(projectId, selectedSession.id);
      }
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

  const handleVmSizeChange = useCallback((size: VMSize) => {
    setSelectedVmSizeOverride(size);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const showNewChatInput = !sessionId || sessions.length === 0;
  const hasSessions = sessions.length > 0;

  return {
    projectId, project, sessionId, multiplayerActive,
    sessions, loading, isRefreshing, hasSessions, showNewChatInput,
    loadSessions, realtimeDegraded,
    sidebarOpen, setSidebarOpen,
    searchQuery, setSearchQuery, showStale, setShowStale, sessionScope, setSessionScope,
    filteredRecent, filteredStale, effectiveShowStale, taskTitleMap, taskInfoMap,
    message, setMessage, submitting, submitError,
    handleSubmit, handleNewChat, handleSelect,
    configuredAgents, selectedAgentType, setSelectedAgentType,
    agentProfiles, selectedProfileId, setSelectedProfileId,
    skills, selectedSkillId, setSelectedSkillId,
    providerCatalogs, hasUserCloudCredentials,
    profileWizard, openProfileWizard, closeProfileWizard, updateProfileWizard, createProfileFromWizard, suggestProfileName,
    handleUpdateProfile, slashCommands,
    selectedVmSize, handleVmSizeChange,
    selectedWorkspaceProfile, setSelectedWorkspaceProfile,
    selectedDevcontainerConfigName, setSelectedDevcontainerConfigName,
    selectedTaskMode, handleTaskModeChange,
    ...attachments,
    provisioning, bootLogs, bootLogPanelOpen, setBootLogPanelOpen,
    pendingDerived, setPendingDerived, handleFork, handleRetry,
    closingConversation, closeError, handleCloseConversation,
    transcribeApiUrl, getSessionState,
  };
}
