import { Button, buttonClassName } from '@simple-agent-manager/ui';
import { CloudOff, KeyRound, Link2Off, RotateCw } from 'lucide-react';

import { NOTICE_ACTION_CLASS, NoticeSlab, NoticeTextButton } from '../chat-notices/NoticeSlab';
import { StatusCapsule, StatusCapsuleSlot } from '../chat-notices/StatusCapsule';
import { ProviderLimitResume } from '../ProviderLimitResume';
import { ConnectionBanner } from './MessageBanners';
import { ElapsedTime } from './session-view-utils';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';
import { WakeProgressBanner } from './WakeProgressBanner';

export function hasActiveLoopbackGuidance(
  messages: UseSessionLifecycleResult['messages']
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'system') break;
    if (
      message.content !==
      'This sign-in flow requires a local callback that this session cannot complete.'
    )
      continue;
    const promptMessageId = message.toolMetadata?.promptMessageId;
    if (typeof promptMessageId !== 'string' || promptMessageId.length === 0) continue;
    const promptIndex = messages.findIndex(
      (row) => row.id === promptMessageId && row.role === 'user'
    );
    // The reporter can persist after a retry, and its timestamp may tie or
    // differ from the Worker clock. Resolve the original user row instead.
    if (
      promptIndex >= 0 &&
      !messages
        .slice(promptIndex + 1)
        .some((row) => row.role === 'user' || row.role === 'assistant')
    )
      return true;
  }
  return false;
}

/**
 * The notice slabs stacked above the session header (SAM Glass): states that stay up or need
 * the reader to act. Transient connection and wake states float over the conversation instead
 * (`SessionStatusCapsules`).
 */
export function SessionStatusBanners({
  lc,
  projectId,
}: Readonly<{ lc: UseSessionLifecycleResult; projectId: string }>) {
  let missingAgentConnection = false;
  const unsupportedLoopbackAuth = hasActiveLoopbackGuidance(lc.messages);
  // The selection failure also sets the task error, so that error must not
  // suppress its persisted transcript guidance. Only the VM's fixed system
  // message has this provenance; assistant/tool prose cannot trigger the CTA.
  for (let i = lc.messages.length - 1; i >= 0; i--) {
    const message = lc.messages[i];
    if (!message || message.role !== 'system') break;
    if (message.content === 'Agent startup failed because its provider connection is missing.') {
      missingAgentConnection = true;
    }
  }
  const isMine = lc.session?.isMine === true;
  const providerReason = lc.taskEmbed?.providerLimitReason;
  const providerBlocked = providerReason?.startsWith('Blocked:');
  const canStartAnyway =
    !providerBlocked && isMine && lc.taskEmbed?.providerLimitCanStartAnyway === true;
  const canResumeAnyway =
    !providerBlocked && isMine && lc.taskEmbed?.providerLimitCanResumeAnyway === true;
  return (
    <>
      {(providerBlocked || providerReason) && (
        <NoticeSlab
          role="status"
          data-testid="provider-limit-notice"
          tone={providerBlocked ? 'warning' : 'info'}
          icon={<CloudOff size={15} />}
          title={providerBlocked ? 'Needs you' : 'Waiting for provider limit reset'}
          detail={
            canResumeAnyway
              ? `${providerReason} If you reset this account’s limit or enabled extra usage, resume now with the same account. The run may use extra credits.`
              : canStartAnyway
                ? `${providerReason} If this account has extra credits, you can start now; the run may use them.`
                : (providerReason ?? 'The provider wait needs your approval to resume.')
          }
          actions={
            (providerBlocked || canStartAnyway || canResumeAnyway) &&
            isMine &&
            lc.taskEmbed &&
            lc.session ? (
              <ProviderLimitResume
                key={`${lc.taskEmbed.id}:${lc.taskEmbed.providerLimitVersion ?? ''}`}
                projectId={projectId}
                taskId={lc.taskEmbed.id}
                action={
                  providerBlocked ? 'resume' : canResumeAnyway ? 'resume-anyway' : 'start-anyway'
                }
              />
            ) : undefined
          }
        />
      )}
      {missingAgentConnection && (
        <NoticeSlab
          role="alert"
          data-testid="agent-connection-guidance"
          tone="danger"
          icon={<KeyRound size={15} />}
          title="Agent connection missing"
          detail={
            isMine
              ? 'Connect an account for this agent in Settings → Agents to continue.'
              : 'Ask the session creator to connect the agent.'
          }
          actions={
            isMine ? (
              <a
                href="/settings/agents"
                className={`${buttonClassName({ variant: 'accent', size: 'sm' })} ${NOTICE_ACTION_CLASS}`}
              >
                Open agent accounts
              </a>
            ) : undefined
          }
        />
      )}
      {unsupportedLoopbackAuth && (
        <NoticeSlab
          role="alert"
          data-testid="loopback-auth-guidance"
          tone="warning"
          icon={<Link2Off size={15} />}
          title="This sign-in flow needs a local callback that this session cannot complete."
          detail={
            isMine
              ? 'Review your MCP connection for a supported sign-in method.'
              : 'Ask the session creator to review the MCP connection.'
          }
          actions={
            isMine ? (
              <a
                href="/settings/mcp-servers"
                className={`${buttonClassName({ variant: 'raised', size: 'sm' })} ${NOTICE_ACTION_CLASS}`}
              >
                Review MCP connections
              </a>
            ) : undefined
          }
        />
      )}

      {/* Resume / delivery error with retry */}
      {lc.resumeError && !providerBlocked && (
        <NoticeSlab
          role="alert"
          data-testid="resume-error-notice"
          compact
          tone="danger"
          icon={<CloudOff size={15} />}
          title={lc.resumeError}
          actions={
            <>
              <NoticeTextButton onClick={lc.clearResumeError}>Dismiss</NoticeTextButton>
              {lc.followUp.trim() && (
                <Button
                  variant="raised"
                  size="sm"
                  className={NOTICE_ACTION_CLASS}
                  onClick={() => {
                    lc.clearResumeError();
                    void lc.handleSendFollowUp();
                  }}
                >
                  <RotateCw size={14} aria-hidden="true" />
                  Retry
                </Button>
              )}
            </>
          }
        />
      )}
    </>
  );
}

/**
 * Transient states as capsules floating over the top of the conversation: the chat socket's
 * connection, an Instant session resuming, and a slept session waking. Renders nothing when
 * none applies.
 */
export function SessionStatusCapsules({ lc }: Readonly<{ lc: UseSessionLifecycleResult }>) {
  const showConnection =
    lc.sessionState === 'active' && lc.connectionState !== 'connected' && lc.showConnectionBanner;
  /*
    Wake progress. `isWaking` is the server-derived signal (D1 hydrate + socket
    push). `agentActivity !== 'idle'` is retained as the pre-existing local
    fallback so a wake still shows progress when no phase signal is available —
    e.g. an API that predates `wakePhase`, or a wake claimed before the
    replacement runner has written its first execution step.
  */
  const providerHeld = Boolean(lc.taskEmbed?.providerLimitReason);
  const showWake =
    !providerHeld && lc.sessionState === 'sleeping' && (lc.isWaking || lc.agentActivity !== 'idle');
  if (!showConnection && !lc.isResuming && !showWake) return null;

  return (
    <StatusCapsuleSlot>
      {showConnection && <ConnectionBanner state={lc.connectionState} onRetry={lc.retryWs} />}
      {lc.isResuming && (
        <StatusCapsule
          tone="progress"
          trailing={
            lc.resumeStartedAt != null ? <ElapsedTime startedAt={lc.resumeStartedAt} /> : undefined
          }
        >
          <span role="status" aria-label="Agent resume status">
            Waking and restoring Instant session...
          </span>
        </StatusCapsule>
      )}
      {showWake && (
        <WakeProgressBanner
          wakePhase={lc.wakePhase}
          wakeWait={lc.wakeWait}
          elapsed={
            lc.promptStartedAt != null ? <ElapsedTime startedAt={lc.promptStartedAt} /> : null
          }
        />
      )}
    </StatusCapsuleSlot>
  );
}
