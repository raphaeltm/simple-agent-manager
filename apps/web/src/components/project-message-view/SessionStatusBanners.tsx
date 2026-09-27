import { Spinner } from '@simple-agent-manager/ui';

import { ConnectionBanner } from './MessageBanners';
import { ElapsedTime } from './session-view-utils';
import type { UseSessionLifecycleResult } from './useSessionLifecycle.types';
import { WakeProgressBanner } from './WakeProgressBanner';

/** The status strips stacked above the conversation: connection, resume and wake. */
export function SessionStatusBanners({ lc }: Readonly<{ lc: UseSessionLifecycleResult }>) {
  return (
    <>
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
