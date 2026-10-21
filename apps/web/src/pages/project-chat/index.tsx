import { Alert, Spinner } from '@simple-agent-manager/ui';
import { List, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAppShell } from '../../components/AppShell';
import { BootLogPanel } from '../../components/chat/BootLogPanel';
import { NewChatProfileCards, visibleProfiles } from '../../components/project-chat/profile-picker';
import { ProjectMessageView } from '../../components/project-message-view';
import { useCommentDeepLink } from '../../components/project-message-view/comments/useCommentDeepLink';
import { HierarchyModal } from '../../components/task-hierarchy';
import { ZenPeekRail } from '../../components/ZenPeekRail';
import { useIsMobile } from '../../hooks/useIsMobile';
import { resolveAttentionAnswer } from '../../lib/api';
import { sessionWidthForMode } from '../../lib/focus-mode';
import { ChatInput } from './ChatInput';
import { DerivedSessionBanner } from './DerivedSessionBanner';
import { FocusStrip } from './FocusStrip';
import { getSessionSourceContext } from './lineageUtils';
import { MobileSessionDrawer } from './MobileSessionDrawer';
import { ProjectChatSidebar } from './ProjectChatSidebar';
import { ProvisioningIndicator } from './ProvisioningIndicator';
import { isTerminal } from './types';
import { useProjectChatState } from './useProjectChatState';

/** With fewer visible profiles there is nothing to choose between, so keep the starter prompts. */
const MIN_PROFILES_FOR_CARDS = 2;

export function ProjectChat() {
  const isMobile = useIsMobile();
  const { focusMode, setFocusMode } = useAppShell();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useProjectChatState();
  const [attentionAnswerStatus, setAttentionAnswerStatus] = useState<{
    variant: 'success' | 'error';
    message: string;
  } | null>(null);
  const [pendingAttentionAnswer, setPendingAttentionAnswer] = useState<{
    markerId: string;
    answer: string;
  } | null>(null);
  const processedAttentionAction = useRef<string | null>(null);
  const { loadSessions, projectId, sessionId } = state;

  const submitAttentionAnswer = useCallback(
    async (markerId: string, answer: string) => {
      if (!sessionId) return;
      setAttentionAnswerStatus(null);
      try {
        const result = await resolveAttentionAnswer(projectId, sessionId, markerId, answer);
        setPendingAttentionAnswer(null);
        setAttentionAnswerStatus({
          variant: 'success',
          message: result.resolved ? `Answered: ${answer}` : `Answer is being sent: ${answer}`,
        });
        void loadSessions();
      } catch (cause) {
        setPendingAttentionAnswer({ markerId, answer });
        setAttentionAnswerStatus({
          variant: 'error',
          message: cause instanceof Error ? cause.message : 'Could not send this answer',
        });
      }
    },
    [loadSessions, projectId, sessionId]
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const attentionHash = location.hash.startsWith('#attentionMarker=')
      ? new URLSearchParams(location.hash.slice(1))
      : null;
    const markerId = attentionHash?.get('attentionMarker') ?? params.get('attentionMarker');
    const answer = attentionHash?.get('attentionAnswer') ?? params.get('attentionAnswer');
    if (!markerId || !answer || !sessionId) return;
    const key = `${sessionId}:${markerId}:${answer}`;
    if (processedAttentionAction.current === key) return;
    processedAttentionAction.current = key;

    params.delete('attentionMarker');
    params.delete('attentionAnswer');
    const nextSearch = params.toString();
    const nextHash = attentionHash ? '' : location.hash;
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash}`, {
      replace: true,
    });
    void submitAttentionAnswer(markerId, answer).finally(() => {
      processedAttentionAction.current = null;
    });
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    sessionId,
    submitAttentionAnswer,
  ]);

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
  const commentDeepLink = useCommentDeepLink();
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

  /**
   * Stable identities for the session-tool handlers.
   *
   * These feed `useSessionTools`' memoized action array. As inline arrows they were
   * rebuilt on every `ProjectChat` render — and this page re-renders on the session-sync
   * poll plus the faster provisioning poll — so the memo they gate never actually held
   * and `buildSessionToolActions` re-ran on every tick (rule 64).
   */
  // Destructured so the dependency arrays name the exact values used. Depending on the
  // whole `state` object would invalidate these on every render and defeat the point.
  // `loadSessions`/`sessionId` are already destructured above.
  const { sessions: chatSessions, handleRetry, handleFork } = state;
  const permissionRefreshSignal = useMemo(() => {
    const attention = chatSessions.find((session) => session.id === sessionId)?.attention;
    if (!attention) return null;
    return `${attention.markerId}:${attention.reason ?? ''}`;
  }, [chatSessions, sessionId]);

  const handleRetryActiveSession = useCallback(() => {
    const session = chatSessions.find((sess) => sess.id === sessionId);
    if (session?.taskId) handleRetry(session);
  }, [chatSessions, sessionId, handleRetry]);

  const handleForkActiveSession = useCallback(() => {
    const session = chatSessions.find((sess) => sess.id === sessionId);
    if (session) handleFork(session);
  }, [chatSessions, sessionId, handleFork]);

  const handleSessionMutated = useCallback(() => {
    void loadSessions();
  }, [loadSessions]);

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

  // Two or more visible profiles make choosing one worth a step of its own: show the
  // person's recent profiles as cards instead of the generic starter prompts.
  const showProfileCards =
    visibleProfiles(state.agentProfiles, state.profilePicker.state).length >=
    MIN_PROFILES_FOR_CARDS;

  // Full session-sidebar content, shared by the default-mode panel and the Zen peek panel.
  const sidebarInner = <ProjectChatSidebar state={state} onShowHierarchy={handleShowHierarchy} />;

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
              className={`flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-3 ${isMobile ? 'p-4 justify-start pb-8' : 'p-8 justify-center'}`}
            >
              {state.provisioning ? (
                <ProvisioningIndicator
                  state={state.provisioning}
                  bootLogCount={state.bootLogs.length}
                  onViewLogs={() => state.setBootLogPanelOpen(true)}
                />
              ) : showProfileCards ? (
                <NewChatProfileCards
                  profiles={state.agentProfiles}
                  pickerState={state.profilePicker.state}
                  loading={state.profilePicker.picker.status === 'loading'}
                  selectedProfileId={state.selectedProfileId}
                  onSelect={state.setSelectedProfileId}
                  onShowAll={() => state.openProfileSheet(null)}
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
              submitting={state.submitting || (state.pendingDerived?.promptLoading ?? false)}
              error={state.submitError}
              placeholder="Describe what you want the agent to do..."
              transcribeApiUrl={state.transcribeApiUrl}
              projectId={state.projectId}
              agents={state.configuredAgents}
              agentProfiles={state.agentProfiles}
              selectedProfileId={state.selectedProfileId}
              onProfileChange={state.setSelectedProfileId}
              profilePicker={state.profilePicker}
              profileSheet={state.profileSheet}
              onOpenProfileSheet={state.openProfileSheet}
              onCloseProfileSheet={state.closeProfileSheet}
              skills={state.skills}
              selectedSkillId={state.selectedSkillId}
              onSkillChange={state.setSelectedSkillId}
              onUpdateProfile={state.handleUpdateProfile}
              taskResourceReqs={state.taskResourceReqs}
              onTaskResourceReqsChange={state.setTaskResourceReqs}
              taskResourceErrors={state.taskResourceErrors}
              onTaskResourceErrorsClear={() => state.setTaskResourceErrors({})}
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
            {attentionAnswerStatus && (
              <Alert
                variant={attentionAnswerStatus.variant}
                onDismiss={() => setAttentionAnswerStatus(null)}
                className="m-3 mb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{attentionAnswerStatus.message}</span>
                  {attentionAnswerStatus.variant === 'error' && pendingAttentionAnswer && (
                    <button
                      type="button"
                      className="min-h-11 rounded-md border border-current px-3 py-2 text-sm font-medium"
                      onClick={() =>
                        void submitAttentionAnswer(
                          pendingAttentionAnswer.markerId,
                          pendingAttentionAnswer.answer
                        )
                      }
                    >
                      Retry answer
                    </button>
                  )}
                </div>
              </Alert>
            )}
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
              projectId={state.projectId}
              sessionId={activeSessionId}
              isProvisioning={
                !!(
                  state.provisioning &&
                  state.sessionId === state.provisioning.sessionId &&
                  !isTerminal(state.provisioning.status)
                )
              }
              onSessionMutated={handleSessionMutated}
              onRetry={handleRetryActiveSession}
              onFork={handleForkActiveSession}
              sourceContext={selectedSourceContext}
              onSleepConversation={state.handleSleepConversation}
              sleepingConversation={state.sleepingConversation}
              sleepError={state.sleepError}
              onCloseConversation={state.handleCloseConversation}
              closingConversation={state.closingConversation}
              closeError={state.closeError}
              agentProfiles={state.agentProfiles}
              slashCommands={state.slashCommands}
              onShowHierarchy={handleShowHierarchy}
              onNewChat={state.handleNewChat}
              targetMessageId={commentDeepLink.targetMessage?.messageId ?? null}
              targetMessageTimestamp={commentDeepLink.targetMessage?.timestamp ?? null}
              onTargetMessageConsumed={commentDeepLink.consume}
              focusCommentThreadId={commentDeepLink.focusThreadId}
              permissionRefreshSignal={permissionRefreshSignal}
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
