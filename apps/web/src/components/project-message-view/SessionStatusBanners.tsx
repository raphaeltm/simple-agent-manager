import { Spinner } from '@simple-agent-manager/ui';

import { ConnectionBanner } from './MessageBanners';
import { ElapsedTime } from './session-view-utils';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';
import { WakeProgressBanner } from './WakeProgressBanner';

export function hasActiveLoopbackGuidance(messages: UseSessionLifecycleResult['messages']): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'system') break;
    if (message.content !== 'This sign-in flow requires a local callback that this session cannot complete.') continue;
    const promptMessageId = message.toolMetadata?.promptMessageId;
    if (typeof promptMessageId !== 'string' || promptMessageId.length === 0) continue;
    const promptIndex = messages.findIndex((row) => row.id === promptMessageId && row.role === 'user');
    // The reporter can persist after a retry, and its timestamp may tie or
    // differ from the Worker clock. Resolve the original user row instead.
    if (promptIndex >= 0 && !messages.slice(promptIndex + 1)
      .some((row) => row.role === 'user' || row.role === 'assistant')) return true;
  }
  return false;
}

/** The status strips stacked above the conversation: connection, resume and wake. */
export function SessionStatusBanners({ lc }: Readonly<{ lc: UseSessionLifecycleResult }>) {
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
  return (
    <>
      {missingAgentConnection && (
        <div role="alert" data-testid="agent-connection-guidance"
          className="flex flex-wrap items-center gap-2 border-b border-border-default bg-danger-tint px-4 py-2 text-xs text-danger-fg">
          <span className="min-w-0 flex-1">Agent connection missing. {lc.session?.isMine === true
            ? 'Connect the agent in Settings to continue.'
            : 'Ask the session creator to connect the agent.'}</span>
          {lc.session?.isMine === true && (
            <a href="/settings/connections"
              className="inline-flex items-center rounded-md border border-border-default px-3 py-2 font-medium text-accent no-underline hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
              Open agent connections
            </a>
          )}
        </div>
      )}
      {unsupportedLoopbackAuth && (
        <div role="alert" data-testid="loopback-auth-guidance"
          className="flex flex-col items-start gap-2 border-b border-border-default bg-danger-tint px-4 py-2 text-xs text-danger-fg sm:flex-row sm:items-center">
          <span className="min-w-0 flex-1">This sign-in flow needs a local callback that this session cannot complete. {lc.session?.isMine === true
            ? 'Review your MCP connection for a supported sign-in method.'
            : 'Ask the session creator to review the MCP connection.'}</span>
          {lc.session?.isMine === true && (
            <a href="/settings/mcp-servers"
              className="inline-flex items-center rounded-md border border-border-default px-3 py-2 font-medium text-accent no-underline hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
              Review MCP connections
            </a>
          )}
        </div>
      )}
      {/* Connection indicator (DO WebSocket) */}
      {lc.sessionState === 'active' &&
        lc.connectionState !== 'connected' &&
        lc.showConnectionBanner && (
          <ConnectionBanner state={lc.connectionState} onRetry={lc.retryWs} />
        )}

      {/* Resuming agent banner */}
      {lc.isResuming && (
        <div
          role="status"
          aria-label="Agent resume status"
          className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted"
        >
          <Spinner size="sm" />
          <span>Waking and restoring Instant session...</span>
          {lc.resumeStartedAt != null && <ElapsedTime startedAt={lc.resumeStartedAt} />}
        </div>
      )}

      {/*
        Wake progress. `isWaking` is the server-derived signal (D1 hydrate + socket
        push). `agentActivity !== 'idle'` is retained as the pre-existing local
        fallback so a wake still shows a banner when no phase signal is available —
        e.g. an API that predates `wakePhase`, or a wake claimed before the
        replacement runner has written its first execution step.
      */}
      {lc.sessionState === 'sleeping' && (lc.isWaking || lc.agentActivity !== 'idle') && (
        <WakeProgressBanner
          wakePhase={lc.wakePhase}
          elapsed={
            lc.promptStartedAt != null ? <ElapsedTime startedAt={lc.promptStartedAt} /> : null
          }
        />
      )}

      {/* Resume / delivery error banner with retry */}
      {lc.resumeError && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs"
        >
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {lc.resumeError}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {lc.followUp.trim() && (
              <button
                type="button"
                className="px-2 py-1 text-xs font-medium rounded border border-danger/30 bg-transparent cursor-pointer hover:bg-danger-tint text-danger-fg transition-colors"
                onClick={() => {
                  lc.clearResumeError();
                  void lc.handleSendFollowUp();
                }}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="px-2 py-1 text-xs font-medium rounded border border-border-default bg-transparent cursor-pointer hover:bg-surface-raised"
              onClick={lc.clearResumeError}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
