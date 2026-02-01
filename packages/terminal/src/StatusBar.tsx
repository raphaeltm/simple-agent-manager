import type { StatusBarProps } from './types';
import { useIdleDeadline, formatDeadlineDisplay } from './useIdleDeadline';

/**
 * Status bar showing connection state and shutdown deadline.
 * Displays at the bottom of the terminal.
 */
export function StatusBar({
  connectionState,
  shutdownDeadline,
  reconnectAttempts = 0,
}: StatusBarProps) {
  const { deadlineDate, remainingSeconds, isWarning, isExpired } = useIdleDeadline({
    deadline: shutdownDeadline,
  });

  // Connection status text and color
  const getConnectionStatus = () => {
    switch (connectionState) {
      case 'connecting':
        return { text: 'Connecting...', color: 'text-yellow-500' };
      case 'connected':
        return { text: 'Connected', color: 'text-green-500' };
      case 'reconnecting':
        return {
          text: `Reconnecting... (attempt ${reconnectAttempts})`,
          color: 'text-yellow-500',
        };
      case 'failed':
        return { text: 'Connection failed', color: 'text-red-500' };
      default:
        return { text: 'Unknown', color: 'text-gray-500' };
    }
  };

  const { text: statusText, color: statusColor } = getConnectionStatus();

  // Deadline display
  const deadlineDisplay = formatDeadlineDisplay(deadlineDate, remainingSeconds, isWarning);
  const deadlineColor = isExpired
    ? 'text-red-500'
    : isWarning
      ? 'text-yellow-500'
      : 'text-gray-400';

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-gray-900 border-t border-gray-700 text-xs font-mono">
      {/* Connection status */}
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            connectionState === 'connected'
              ? 'bg-green-500'
              : connectionState === 'failed'
                ? 'bg-red-500'
                : 'bg-yellow-500 animate-pulse'
          }`}
        />
        <span className={statusColor}>{statusText}</span>
      </div>

      {/* Shutdown deadline */}
      {deadlineDisplay && (
        <div className={deadlineColor}>
          {deadlineDisplay}
        </div>
      )}
    </div>
  );
}
