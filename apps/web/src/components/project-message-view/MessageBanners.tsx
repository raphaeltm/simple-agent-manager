import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import { StatusCapsule } from '../chat-notices/StatusCapsule';

/** WebSocket connection status (TDF-8), as a capsule floating over the conversation. */
export function ConnectionBanner({
  state,
  onRetry,
}: {
  state: ChatConnectionState;
  onRetry: () => void;
}) {
  const label =
    state === 'connecting'
      ? 'Connecting...'
      : state === 'reconnecting'
        ? 'Reconnecting...'
        : 'Disconnected';

  const isRecoverable = state === 'disconnected';

  return (
    <StatusCapsule
      role="alert"
      data-testid="connection-banner"
      tone={isRecoverable ? 'danger' : state === 'reconnecting' ? 'warning' : 'info'}
      indicator={isRecoverable ? 'dot' : 'spinner'}
      action={
        isRecoverable ? (
          <button
            type="button"
            onClick={onRetry}
            className="sam-raised ml-1 min-h-11 shrink-0 sm:min-h-8 cursor-pointer rounded-full border-0 px-3 text-[12.5px] font-semibold text-fg-primary hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {label}
    </StatusCapsule>
  );
}
