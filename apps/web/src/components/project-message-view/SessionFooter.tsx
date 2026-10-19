import type { SlashCommand } from '@simple-agent-manager/acp-client';
import { PlanModal } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';
import { isExpiredTask } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { ArchivedForkComposer } from './ArchivedForkComposer';
import { CompletionDock } from './CompletionDock';
import { FollowUpInput, ReadOnlyFollowUp } from './FollowUpInput';
import { accessClockTime, accessTimeLeft, useServerNow } from './session-access-time';
import { currentPlanToPlanItem, ElapsedTime } from './session-view-utils';
import {
  sessionOwnerLabel as ownerLabelFor,
  type SessionViewerCapabilities,
} from './session-viewer-access';
import { StaleActivityNotice } from './StaleActivityNotice';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';

interface SessionFooterProps {
  projectId: string;
  lc: UseSessionLifecycleResult;
  /** What this viewer may do here; mirrors the server's session-writer check. */
  viewer: SessionViewerCapabilities;
  /** The signed-in user, to find their own shared-access grant. */
  viewerId: string | null;
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
  projectId,
  lc,
  viewer,
  viewerId,
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
  const sessionOwnerLabel = ownerLabelFor(lc.session);
  const viewerGrant = viewer.isGrantee
    ? lc.session?.access?.grants.find((grant) => grant.grantee.id === viewerId)
    : undefined;
  const now = useServerNow(viewerGrant !== undefined, viewerGrant?.expiresAt ?? null);
  // The viewer's grant has run out by the server's clock. The server already refuses them; lock
  // the composer now rather than when the access refetch lands (display only).
  const grantEndedHere =
    viewerGrant !== undefined && accessTimeLeft(viewerGrant.expiresAt, now) === null;
  const canWriteSession = viewer.canDriveSession && !grantEndedHere;
  // Remember that this viewer had shared access to this chat while it was open, so once the
  // server takes it away (expiry or revoke) the read-only footer says so instead of reading as
  // if they never had it.
  const sessionId = lc.session?.id ?? null;
  const [sharedAccessSessionId, setSharedAccessSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (viewer.isGrantee && sessionId) setSharedAccessSessionId(sessionId);
  }, [viewer.isGrantee, sessionId]);
  const accessEnded =
    grantEndedHere ||
    (!viewer.canDriveSession && sessionId !== null && sharedAccessSessionId === sessionId);
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
      {isActive && viewer.isGrantee && !grantEndedHere && (
        <SharedSessionNotice
          ownerLabel={sessionOwnerLabel}
          expiresAt={viewerGrant?.expiresAt ?? null}
          now={now}
        />
      )}
      {isActive && canWriteSession && (
        <FollowUpInput
          value={lc.followUp}
          onChange={lc.setFollowUp}
          onSend={() => {
            void lc.handleSendFollowUp();
          }}
          // Attachments are stored under the uploader and only delivered into the
          // uploader's own workspace, so a shared session cannot take them yet.
          onUploadFiles={
            viewer.isGrantee
              ? undefined
              : (files) => {
                  void lc.handleUploadFiles(files);
                }
          }
          sending={lc.sendingFollowUp}
          uploading={lc.uploading}
          attachments={lc.attachments}
          onRemoveAttachment={lc.removeAttachment}
          uploadError={lc.uploadError}
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
        <ReadOnlyFollowUp
          ownerLabel={sessionOwnerLabel}
          onNewChat={onNewChat}
          accessEnded={accessEnded}
        />
      )}
      {lc.sessionState === 'terminated' && lc.session?.status === 'stopped' && viewer.canFork && (
        <ArchivedForkComposer
          key={lc.session.id}
          workspaceExpired={isExpiredTask(lc.taskEmbed)}
          projectId={projectId}
          sessionId={lc.session.id}
          transcribeApiUrl={lc.transcribeApiUrl}
          agentProfiles={agentProfiles}
        />
      )}
      {lc.sessionState === 'terminated' && !viewer.canFork && (
        <ReadOnlyFollowUp ownerLabel={sessionOwnerLabel} onNewChat={onNewChat} ended />
      )}
      {lc.sessionState === 'terminated' && lc.session?.status !== 'stopped' && (
        <div className="shrink-0 border-t border-border-default px-4 py-3 bg-surface text-center">
          <p className="m-0 sam-type-secondary text-fg-muted">
            {isExpiredTask(lc.taskEmbed)
              ? 'The saved workspace has expired. Your transcript is still available.'
              : 'This session has ended.'}
          </p>
          {viewer.canFork && isExpiredTask(lc.taskEmbed) && onFork && (
            <Button onClick={onFork} size="lg" className="mt-2">
              Fork conversation
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Above a grantee's composer: whose session this is, whose accounts it runs on, and when their
 * access ends (by the server's clock). Once it has ended the footer shows the read-only state
 * instead, so this only ever counts down.
 */
function SharedSessionNotice({
  ownerLabel,
  expiresAt,
  now,
}: Readonly<{ ownerLabel: string; expiresAt: number | null; now: number }>) {
  const timeLeft = expiresAt === null ? null : accessTimeLeft(expiresAt, now);
  return (
    <div
      className="shrink-0 border-t border-border-default bg-surface px-4 py-2 text-xs text-fg-muted"
      data-testid="shared-session-notice"
    >
      <span className="font-medium text-fg-primary">
        You&apos;re chatting in {ownerLabel}&apos;s session.
      </span>{' '}
      It runs on {ownerLabel}&apos;s accounts.
      {expiresAt !== null && timeLeft !== null && (
        <>
          {' '}
          <span data-testid="shared-session-time-left">
            Your access ends in {timeLeft} ({accessClockTime(expiresAt)}).
          </span>
        </>
      )}
    </div>
  );
}
