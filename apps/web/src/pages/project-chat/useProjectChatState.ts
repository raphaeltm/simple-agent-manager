import type { ProviderCatalog, Task } from '@simple-agent-manager/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useAvailableCommands } from '../../hooks/useAvailableCommands';
import { useBootLogStream } from '../../hooks/useBootLogStream';
import { type RawSessionEvent, useProjectWebSocket } from '../../hooks/useProjectWebSocket';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useVisibilityAwarePoll } from '../../hooks/useVisibilityAwarePoll';
import type { ChatSessionResponse } from '../../lib/api';
import { getProjectTask, listChatSessions, listProjectTasks } from '../../lib/api';
import { CHAT_SESSION_LIST_LIMIT } from '../../lib/chat-query-config';
import { getSessionState } from '../../lib/chat-session-utils';
import { readInitialSessionList } from '../../lib/project-route-prefetch';
import { applyMessageCommentRealtimeEventToQueryCache } from '../../lib/query-options';
import { stripMarkdown } from '../../lib/text-utils';
import { useProjectContext } from '../ProjectContext';
import { buildForkMessage } from './profileWizardHelpers';
import type { PendingDerived, ProvisioningState } from './types';
import {
  CHAT_TASK_LIST_LIMIT,
  SESSION_RECONCILE_INTERVAL_MS,
  SESSION_SYNC_INTERVAL_MS,
} from './types';
import { useComposerPrefill } from './useComposerPrefill';
import { useConversationActions } from './useConversationActions';
import { useNewChatComposer } from './useNewChatComposer';
import { useProvisioningTracker } from './useProvisioningTracker';
import { useSessionReducer } from './useSessionReducer';
import { rawToSessionEvent } from './useSessionReducer';
import { useSessionSections } from './useSessionSections';
import { useStableTaskInfoMap } from './useStableTaskInfoMap';

export type { PendingDerived } from './types';

export type SessionScope = 'my' | 'all';

const EMPTY_PROVIDER_CATALOGS: ProviderCatalog[] = [];

export function useProjectChatState() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId, project } = useProjectContext();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();

  const { sessions, dispatchEvent, resetSessions, captureSnapshot } = useSessionReducer();
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);
  // A list read has succeeded: only then does an empty list mean "no chats".
  const [listLoaded, setListLoaded] = useState(false);
  // The read in flight when the page mounted, for handlers that need the selected session.
  const initialLoadRef = useRef<Promise<ChatSessionResponse[]>>(Promise.resolve([]));
  // The new-chat composer and its start path, shared with the Project Overview's task box.
  const composer = useNewChatComposer();
  const {
    message,
    setMessage,
    submitting,
    submitError,
    setSubmitError,
    configuredAgents,
    selectedAgentType,
    setSelectedAgentType,
    agentProfiles,
    selectedProfileId,
    profileChoice,
    skills,
    selectedSkillId,
    setSelectedSkillId,
    attachments,
    hasCloudCredentials,
    hasUserCloudCredentials,
    transcribeApiUrl,
  } = composer;
  const {
    taskResourceReqs,
    setTaskResourceReqs,
    taskResourceErrors,
    setTaskResourceErrors,
    agentOverrides,
    setAgentOverrides,
    resetComposerOverrides,
  } = composer.overrides;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar filtering
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionScope, setSessionScope] = useState<SessionScope>('all');
  const multiplayerActive = Boolean(project?.multiplayerActive);
  const subscriptionScope = `${queryScope}:${projectId}:${multiplayerActive ? sessionScope : 'all'}`;
  const currentSubscriptionScope = useRef(subscriptionScope);
  currentSubscriptionScope.current = subscriptionScope;

  // Track explicit "new chat" intent so auto-select doesn't override it
  const newChatIntentRef = useRef(false);

  // The catalog is only meaningful once the user can actually provision, matching the
  // previous behaviour where it was fetched inside the `hasCloud` branch.
  const { catalogs: allProviderCatalogs } = useProviderCatalog(
    hasCloudCredentials ? queryScope : ''
  );
  const providerCatalogs = hasCloudCredentials ? allProviderCatalogs : EMPTY_PROVIDER_CATALOGS;

  // Slash command cache for pre-session autocomplete
  // Pass sessionId as refreshKey so cached commands are re-fetched when switching sessions
  // (ensures commands persisted during session N are available in session N+1)
  const { commands: slashCommands } = useAvailableCommands(projectId, undefined, sessionId);

  // Provisioning tracking
  const [provisioning, setProvisioning] = useState<ProvisioningState | null>(null);

  // Boot log streaming during provisioning
  const bootLogStatus = provisioning?.executionStep === 'workspace_ready' ? 'creating' : undefined;
  const { logs: bootLogs } = useBootLogStream(
    provisioning?.workspaceId ?? undefined,
    provisioning?.workspaceUrl ?? undefined,
    bootLogStatus
  );
  const [bootLogPanelOpen, setBootLogPanelOpen] = useState(false);

  // Auto-close boot log panel when provisioning completes
  useEffect(() => {
    if (!provisioning) setBootLogPanelOpen(false);
  }, [provisioning]);

  // Fork & Retry — navigate to new chat screen with pre-filled state
  const [pendingDerived, setPendingDerived] = useState<PendingDerived | null>(null);
  // Read by Retry's async prompt load: a response for a retry the user has since dismissed,
  // replaced with a fork, or navigated away from must not touch the composer.
  const pendingDerivedRef = useRef<PendingDerived | null>(null);
  useEffect(() => {
    pendingDerivedRef.current = pendingDerived;
  }, [pendingDerived]);

  // Task/idea title map for session tagging + task info map for grouping
  const [taskTitleMap, setTaskTitleMap] = useState<Map<string, string>>(new Map());
  const { taskInfoMap, replaceAll: replaceTaskInfoMap } = useStableTaskInfoMap();

  const sessionList = useSessionSections(sessions, taskInfoMap, searchQuery);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!multiplayerActive) {
      setSessionScope('all');
    }
  }, [multiplayerActive]);

  // The Deployments page's "Ask an agent" link pre-fills the composer. The idea half of this
  // hook is gone: an idea is now started from its own page through Start work, which links it
  // on the server before the agent runs rather than from a query parameter afterwards.
  useComposerPrefill(sessionId, setMessage);

  const loadSessions = useCallback(
    async (options?: { fresh?: boolean }) => {
      if (hasLoadedRef.current) setIsRefreshing(true);
      const before = captureSnapshot();
      try {
        const scope = multiplayerActive ? sessionScope : 'all';
        let sessions: ChatSessionResponse[];
        if (!options?.fresh && !hasLoadedRef.current && scope === 'all') {
          const initial = await readInitialSessionList(queryClient, queryScope, projectId);
          sessions = initial.sessions;
        } else {
          sessions = (
            await listChatSessions(projectId, {
              limit: CHAT_SESSION_LIST_LIMIT,
              scope,
              includeLive: true,
              // The subscription catch-up must see sessions created while the socket was
              // closed; the D1 index can still be missing them.
              ...(options?.fresh ? { authoritative: true } : {}),
            })
          ).sessions;
        }
        if (currentSubscriptionScope.current !== subscriptionScope) return [];
        resetSessions(sessions, before);
        hasLoadedRef.current = true;
        setListLoaded(true);

        listProjectTasks(projectId, { limit: CHAT_TASK_LIST_LIMIT })
          .then((tasksResult) => {
            if (currentSubscriptionScope.current !== subscriptionScope) return;
            const titleMap = new Map<string, string>();
            for (const t of tasksResult.tasks) titleMap.set(t.id, t.title);
            setTaskTitleMap(titleMap);
            replaceTaskInfoMap(tasksResult.tasks as Task[]);
          })
          .catch(() => {
            /* task titles are cosmetic */
          });

        return sessions;
      } catch {
        return [];
      } finally {
        setIsRefreshing(false);
      }
    },
    [
      projectId,
      sessionScope,
      multiplayerActive,
      resetSessions,
      captureSnapshot,
      replaceTaskInfoMap,
      queryClient,
      queryScope,
      subscriptionScope,
    ]
  );

  const handleSessionEvent = useCallback(
    (raw: RawSessionEvent) => {
      // session.created deltas cannot be scope-filtered client-side (we don't
      // know isMine from the wire payload), so fall back to a full refetch when
      // the user is viewing "My sessions" to let the server apply the filter.
      if (raw.type === 'session.created' && multiplayerActive && sessionScope === 'my') {
        void loadSessions();
        return;
      }
      const event = rawToSessionEvent(raw);
      if (event) dispatchEvent(event);
    },
    [dispatchEvent, multiplayerActive, sessionScope, loadSessions]
  );

  const handleCommentEvent = useCallback(
    (event: Parameters<typeof applyMessageCommentRealtimeEventToQueryCache>[2]) => {
      if (!queryScope) return;
      applyMessageCommentRealtimeEventToQueryCache(queryClient, queryScope, event);
    },
    [queryClient, queryScope]
  );

  const refreshAfterSubscription = useCallback(async () => {
    // Finish the mount/prefetch read first so its stale result cannot overwrite catch-up.
    await initialLoadRef.current;
    if (currentSubscriptionScope.current !== subscriptionScope) return;
    await loadSessions({ fresh: true });
  }, [loadSessions, subscriptionScope]);

  const { connectionState } = useProjectWebSocket({
    projectId,
    onSessionEvent: handleSessionEvent,
    onCommentEvent: handleCommentEvent,
    onReconnected: refreshAfterSubscription,
  });

  const realtimeDegraded = connectionState === 'disconnected';

  useEffect(() => {
    setLoading(true);
    const load = loadSessions();
    initialLoadRef.current = load;
    void load.finally(() => setLoading(false));
  }, [loadSessions]);

  /**
   * The selected session, waiting for the page's first list read when it has not landed.
   * A deep link shows its conversation before the list arrives, so its actions must not
   * read "not in the list yet" as "no such session".
   */
  const findSession = useCallback(
    async (id: string) =>
      sessions.find((s) => s.id === id) ?? (await initialLoadRef.current).find((s) => s.id === id),
    [sessions]
  );

  // Session-list freshness has two modes, and exactly one is active at a time.
  //
  // 1. Degraded fallback (30s) while the ProjectData WebSocket is NOT connected.
  //    Each tick is a 100-session list + a 200-task list, so running it while
  //    the socket is delivering deltas in real time is pure duplicate I/O.
  // 2. Slow reconciliation (10min) while it IS connected. `connectionState`
  //    only tracks socket open/close — `useProjectWebSocket` silently drops
  //    malformed frames and there is no sequence/gap detector, so suppressing
  //    the poll entirely would let a dropped delta leave the sidebar stale for
  //    the whole connection lifetime. This preserves the original poll's
  //    self-healing role at ~1/20th the request rate.
  //
  // Both are deferred until the first load completes and both pause on hidden
  // tabs. Reconnect catch-up is handled by `onReconnected` above; disconnect and
  // tab-return catch-up come from the hook's elapsed-gated refresh.
  const wsConnected = connectionState === 'connected';
  useVisibilityAwarePoll(loadSessions, SESSION_SYNC_INTERVAL_MS, {
    enabled: !loading,
    paused: wsConnected,
  });
  useVisibilityAwarePoll(loadSessions, SESSION_RECONCILE_INTERVAL_MS, {
    enabled: !loading,
    paused: !wsConnected,
  });

  // Provisioning poll + restore (see useProvisioningTracker for the gates)
  useProvisioningTracker({
    projectId,
    sessionId,
    sessions,
    provisioning,
    setProvisioning,
    navigate,
    loadSessions,
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * Start a chat from the new-chat composer and open it. The start itself is shared with the
   * Overview's task box (`useNewChatComposer`); opening the chat and showing its provisioning
   * belong to this page.
   */
  const handleSubmit = async () => {
    const start = await composer.startNewChat(pendingDerived);
    if (!start) return;
    setPendingDerived(null);
    if (start.kind === 'task') {
      setProvisioning({
        taskId: start.taskId,
        sessionId: start.sessionId,
        branchName: start.branchName,
        status: 'queued',
        executionStep: null,
        errorMessage: null,
        startedAt: Date.now(),
        workspaceId: null,
        workspaceUrl: null,
        requestedVmSize: null,
        provisionedVmSize: null,
      });
    }
    newChatIntentRef.current = false;
    navigate(`/projects/${projectId}/chat/${start.sessionId}`, { replace: true });
    void loadSessions().catch(() => undefined);
  };

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true;
    setPendingDerived(null);
    navigate(`/projects/${projectId}/chat`, { replace: true });
    setMessage('');
    setSubmitError(null);
    setProvisioning(null);
    resetComposerOverrides();
  }, [navigate, projectId, resetComposerOverrides]);

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false;
      setPendingDerived(null);
      setProvisioning(null);
      setSidebarOpen(false);
      navigate(`/projects/${projectId}/chat/${id}`);
    },
    [navigate, projectId]
  );

  /**
   * Open the new-chat composer pre-filled with the IDs the agent needs to read this session.
   * Synchronous: the session already carries its task, which the submit records as lineage.
   */
  const handleFork = useCallback(
    (session: ChatSessionResponse) => {
      const sessionLabel = session.topic
        ? stripMarkdown(session.topic)
        : `Chat ${session.id.slice(0, 8)}`;
      const parentTaskId = session.task?.id ?? session.taskId ?? '';
      setPendingDerived({
        type: 'fork',
        parentSessionId: session.id,
        parentSessionLabel: sessionLabel,
        parentTaskId,
        parentBranch: session.task?.outputBranch ?? undefined,
        promptLoading: false,
      });
      setMessage(
        buildForkMessage({ sessionLabel, projectId, sessionId: session.id, taskId: parentTaskId })
      );
      newChatIntentRef.current = true;
      setSubmitError(null);
      setProvisioning(null);
      // A derived chat starts from its profile, not from an earlier draft's options.
      resetComposerOverrides();
      navigate(`/projects/${projectId}/chat`, { replace: true });
    },
    [navigate, projectId, resetComposerOverrides]
  );

  /** Open the new-chat composer with the original task prompt re-added. */
  const handleRetry = useCallback(
    (session: ChatSessionResponse) => {
      const taskId = session.task?.id ?? session.taskId;
      if (!taskId) return;
      const sessionLabel = session.topic
        ? stripMarkdown(session.topic)
        : `Chat ${session.id.slice(0, 8)}`;

      const derived: PendingDerived = {
        type: 'retry',
        parentSessionId: session.id,
        parentSessionLabel: sessionLabel,
        parentTaskId: taskId,
        parentBranch: session.task?.outputBranch ?? undefined,
        errorMessage: session.task?.errorMessage ?? undefined,
        promptLoading: true,
      };
      setPendingDerived(derived);
      newChatIntentRef.current = true;
      setSubmitError(null);
      setProvisioning(null);
      resetComposerOverrides();
      navigate(`/projects/${projectId}/chat`, { replace: true });

      const isCurrent = () => pendingDerivedRef.current === derived;
      void getProjectTask(projectId, taskId)
        .then((task) => {
          if (isCurrent()) setMessage(task.description ?? '');
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          const reason = err instanceof Error ? ` (${err.message})` : '';
          setSubmitError(`Could not load the original prompt${reason}. Type it below to retry.`);
        })
        .finally(() => {
          setPendingDerived((prev) =>
            prev === derived ? { ...prev, promptLoading: false } : prev
          );
        });
    },
    [navigate, projectId, resetComposerOverrides]
  );

  const conversationActions = useConversationActions({
    projectId,
    sessionId,
    findSession,
    loadSessions,
  });

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  // Until a list read succeeds an empty list means "not loaded", not "no chats", so a
  // deep-linked conversation stays on screen while it loads or after it fails.
  const showNewChatInput = !sessionId || (listLoaded && !loading && sessions.length === 0);
  const hasSessions = sessions.length > 0;

  return {
    projectId,
    project,
    sessionId,
    multiplayerActive,
    sessions,
    loading,
    isRefreshing,
    hasSessions,
    showNewChatInput,
    loadSessions,
    findSession,
    realtimeDegraded,
    sidebarOpen,
    setSidebarOpen,
    searchQuery,
    setSearchQuery,
    sessionScope,
    setSessionScope,
    sessionList,
    taskTitleMap,
    taskInfoMap,
    message,
    setMessage,
    submitting,
    submitError,
    handleSubmit,
    handleNewChat,
    handleSelect,
    configuredAgents,
    selectedAgentType,
    setSelectedAgentType,
    agentProfiles,
    profilesLoading: profileChoice.profilesLoading,
    selectedProfileId,
    setSelectedProfileId: profileChoice.setSelectedProfileId,
    profilePicker: profileChoice.profilePicker,
    profileSheet: profileChoice.profileSheet,
    openProfileSheet: profileChoice.openProfileSheet,
    closeProfileSheet: profileChoice.closeProfileSheet,
    skills,
    selectedSkillId,
    setSelectedSkillId,
    providerCatalogs,
    hasUserCloudCredentials,
    profileWizard: profileChoice.profileWizard,
    openProfileWizard: profileChoice.openProfileWizard,
    closeProfileWizard: profileChoice.closeProfileWizard,
    updateProfileWizard: profileChoice.updateProfileWizard,
    createProfileFromWizard: profileChoice.createProfileFromWizard,
    createDefaultChatProfile: profileChoice.createDefaultChatProfile,
    suggestProfileName: profileChoice.suggestProfileName,
    handleUpdateProfile: profileChoice.handleUpdateProfile,
    slashCommands,
    selectedWorkspaceProfile: composer.selectedWorkspaceProfile,
    setSelectedWorkspaceProfile: composer.setSelectedWorkspaceProfile,
    selectedDevcontainerConfigName: composer.selectedDevcontainerConfigName,
    setSelectedDevcontainerConfigName: composer.setSelectedDevcontainerConfigName,
    selectedTaskMode: composer.selectedTaskMode,
    handleTaskModeChange: composer.handleTaskModeChange,
    taskResourceReqs,
    setTaskResourceReqs,
    taskResourceErrors,
    setTaskResourceErrors,
    agentOverrides,
    setAgentOverrides,
    ...attachments,
    provisioning,
    bootLogs,
    bootLogPanelOpen,
    setBootLogPanelOpen,
    pendingDerived,
    setPendingDerived,
    handleFork,
    handleRetry,
    ...conversationActions,
    transcribeApiUrl,
    getSessionState,
  };
}
