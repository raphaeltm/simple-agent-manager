import type { SlashCommand } from '@simple-agent-manager/acp-client';
import { PlanModal } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { isExpiredTask } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { CompletionDock } from './CompletionDock';
import { FollowUpInput, ReadOnlyFollowUp } from './FollowUpInput';
import { currentPlanToPlanItem, ElapsedTime } from './session-view-utils';
import { StaleActivityNotice } from './StaleActivityNotice';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';

interface SessionFooterProps {
  lc: UseSessionLifecycleResult;
  canWriteSession: boolean;
  /** Mobile selected-text comment composer, overlaid above the chat input. */
  selectedTextComposer: ReactNode;
  onSleepConversation?: () => void;
  sleepingConversation?: boolean;
  sleepError?: string | null;
  onCloseConversation?: () => void;
  closingConversation?: boolean;
  closeError?: string | null;
  agentProfiles: AgentProfile[];
  slashCommands: SlashCommand[];
  onNewChat?: () => void;
  onFork?: () => void;
}

/**
 * Everything below the conversation: the lifecycle dock and its plan, the stale
 * activity notice, and the composer — or the reason there is none.
 */
export function SessionFooter({
  lc,
  canWriteSession,
  selectedTextComposer,
  onSleepConversation,
  sleepingConversation,
  sleepError,
  onCloseConversation,
  closingConversation,
  closeError,
  agentProfiles,
  slashCommands,
  onNewChat,
  onFork,
}: Readonly<SessionFooterProps>) {
  const [showPlanModal, setShowPlanModal] = useState(false);

  // Close plan modal when agent transitions to idle
  useEffect(() => {
    if (lc.agentActivity === 'idle') setShowPlanModal(false);
  }, [lc.agentActivity]);

  const planItem = useMemo(
    () =>
      lc.currentPlan && lc.currentPlan.length > 0 ? currentPlanToPlanItem(lc.currentPlan) : null,
    [lc.currentPlan]
  );
  const sessionOwnerLabel =
    lc.session?.createdBy?.name?.trim() ||
    lc.session?.createdBy?.email?.split('@')[0] ||
    'the creator';
  const isConversationLifecycleSession =
    lc.taskEmbed?.taskMode === 'conversation' ||
    (!lc.taskEmbed?.id && (lc.session?.status === 'active' || lc.session?.status === 'sleeping'));
  const canSleepSession = Boolean(
    onSleepConversation &&
    lc.session?.workspaceId &&
    lc.sessionState !== 'sleeping' &&
    isConversationLifecycleSession
  );
  const canArchiveSession = Boolean(
    onCloseConversation && lc.sessionState === 'sleeping' && isConversationLifecycleSession
  );
  const dockCenterAction =
    lc.agentActivity !== 'idle'
      ? 'interrupt'
      : lc.sessionState === 'sleeping'
        ? 'archive'
        : 'sleep';
  const isActive =
    lc.sessionState === 'active' || lc.sessionState === 'idle' || lc.sessionState === 'sleeping';

  return (
    <>
      {/* Lifecycle control — a single always-mounted dock while the session is
          active. Its center button morphs between Interrupt (working), Sleep
          (awake idle), and Archive (already sleeping), so irreversible archive
          is only the primary action after the reversible sleep boundary. */}
      {isActive &&
        canWriteSession &&
        (lc.completionDockWorking || canSleepSession || canArchiveSession) && (
          <CompletionDock
            working={lc.completionDockWorking}
            centerAction={dockCenterAction}
            hasPlan={!!planItem}
            onInterrupt={lc.handleCancelPrompt}
            onSleep={() => onSleepConversation?.()}
            onArchive={() => onCloseConversation?.()}
            onOpenPlan={() => setShowPlanModal(true)}
            sleeping={sleepingConversation}
            archiving={closingConversation}
            cancelling={lc.cancelling}
            sleepError={sleepError}
            archiveError={closeError}
            cancelError={lc.cancelError}
            elapsed={
              lc.promptStartedAt ? <ElapsedTime startedAt={lc.promptStartedAt} /> : undefined
            }
          />
        )}
      {planItem && (
        <PlanModal plan={planItem} isOpen={showPlanModal} onClose={() => setShowPlanModal(false)} />
      )}

      {/* Stale activity notice — shown once per verified-stale transition */}
      {lc.staleNotice && <StaleActivityNotice onDismiss={lc.dismissStaleNotice} />}
      {selectedTextComposer}

      {/* Input area */}
      {isActive && canWriteSession && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={() => {
            void lc.handleSendFollowUp();
          }}
          onUploadFiles={(files) => {
            void lc.handleUploadFiles(files);
          }}
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          placeholder={
            // A wake already in flight must not be advertised as "send a message
            // to wake" — that contradicts the banner directly above and is what
            // invites the duplicate wake this feature exists to prevent.
            lc.isWaking
              ? 'Waking the agent — your message will be delivered...'
              : lc.agentActivity === 'prompting' || lc.agentActivity === 'responding'
                ? 'Agent is working...'
                : lc.sessionState === 'idle'
                  ? 'Send a message to resume the agent...'
                  : lc.sessionState === 'sleeping'
                    ? 'Send a message to wake the agent...'
                    : 'Send a message...'
          }
          transcribeApiUrl={lc.transcribeApiUrl}
          agentProfiles={agentProfiles}
          slashCommands={slashCommands}
        />
      )}
      {isActive && !canWriteSession && (
        <ReadOnlyFollowUp ownerLabel={sessionOwnerLabel} onNewChat={onNewChat} />
      )}
      {lc.sessionState === 'terminated' && (
        <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface text-center">
          <p className="m-0 sam-type-secondary text-fg-muted">
            {isExpiredTask(lc.taskEmbed)
              ? 'The saved workspace has expired. Your transcript is still available. Choose Fork to continue in a new conversation.'
              : 'This session has ended.'}
          </p>
          {isExpiredTask(lc.taskEmbed) && onFork && (
            <Button onClick={onFork} size="lg" className="mt-2">
              Fork conversation
            </Button>
          )}
        </div>
      )}
    </>
  );
}
