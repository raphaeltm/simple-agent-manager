import type { AcpSessionHandle } from '@simple-agent-manager/acp-client';
import { getErrorMeta } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';

/** WebSocket connection status banner (TDF-8). */
export function ConnectionBanner({ state, onRetry }: { state: ChatConnectionState; onRetry: () => void }) {
  const label = state === 'connecting' ? 'Connecting...'
    : state === 'reconnecting' ? 'Reconnecting...'
    : 'Disconnected';

  const isRecoverable = state === 'disconnected';

  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-4 py-1 border-b border-border-default text-xs"
      style={{
        backgroundColor: isRecoverable ? 'var(--sam-color-danger-tint)' : 'var(--sam-color-warning-tint, var(--sam-color-info-tint))',
      }}
    >
      {!isRecoverable && <Spinner size="sm" />}
      <span style={{ color: isRecoverable ? 'var(--sam-color-danger)' : 'var(--sam-color-fg-muted)' }}>
        {label}
      </span>
      {isRecoverable && (
        <button
          type="button"
          onClick={onRetry}
          className="bg-transparent border-none cursor-pointer text-xs font-medium underline p-0"
          style={{ color: 'var(--sam-color-accent-primary)' }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** Agent connection error / offline banner for project chat.
 *  Shows structured error details (matching workspace chat's ErrorBanner)
 *  when the ACP session is in error state, or a generic "Agent offline"
 *  message when the agent is simply unreachable. */
export function AgentErrorBanner({ session }: { session: AcpSessionHandle }) {
  const isError = session.state === 'error';

  if (!isError) {
    // Not an error state — show offline warning with reconnect option
    return (
      <div role="alert" className="flex items-center justify-center gap-2 px-4 py-1.5 border-b border-border-default bg-warning-tint text-warning text-xs">
        <span>Agent offline — messages will be saved but not processed until the agent reconnects.</span>
        <button
          type="button"
          onClick={() => session.reconnect()}
          className="px-3 py-1 min-h-[44px] bg-warning text-white text-xs rounded hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)] shrink-0"
          aria-label="Reconnect to agent"
        >
          Reconnect
        </button>
      </div>
    );
  }

  // Error state — show structured error details
  const meta = session.errorCode ? getErrorMeta(session.errorCode) : null;
  const userMessage = meta?.userMessage ?? session.error ?? 'Connection lost';
  const suggestedAction = meta?.suggestedAction;
  const severity = meta?.severity ?? 'recoverable';

  const detailedError = session.error && session.error !== userMessage && session.error !== meta?.userMessage
    ? session.error
    : null;

  const isFatal = severity === 'fatal';
  const isTransient = severity === 'transient';
  const showReconnect = !isFatal && !isTransient && session.errorCode !== 'NETWORK_OFFLINE';

  return (
    <div
      role="alert"
      className={`border-b border-border-default px-4 py-1.5 text-xs text-center ${
        isTransient ? 'bg-warning-tint text-warning' : 'bg-danger-tint text-danger'
      }`}
    >
      <div className="flex items-center justify-center gap-2">
        <span className="font-medium">{userMessage}</span>
        {showReconnect && (
          <button
            type="button"
            onClick={() => session.reconnect()}
            className="px-3 py-1 min-h-[44px] bg-danger text-white text-xs rounded hover:opacity-80"
            aria-label="Reconnect to agent"
          >
            Reconnect
          </button>
        )}
      </div>
      {detailedError && (
        <p className="text-xs mt-0.5 opacity-80 truncate max-w-lg mx-auto" title={detailedError}>{detailedError}</p>
      )}
      {suggestedAction && (
        <p className="text-xs mt-0.5 opacity-70">{suggestedAction}</p>
      )}
    </div>
  );
}
