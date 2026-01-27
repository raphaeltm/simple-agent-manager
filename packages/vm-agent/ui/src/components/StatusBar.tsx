import { useState, useEffect } from 'react';

interface StatusBarProps {
  connected: boolean;
  workspaceId?: string;
  idleWarning?: number; // Seconds until shutdown, 0 if no warning
}

export function StatusBar({ connected, workspaceId, idleWarning }: StatusBarProps) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatIdleWarning = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 12px',
        backgroundColor: '#007acc',
        color: 'white',
        fontSize: '12px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Connection status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: connected ? '#4caf50' : '#f44336',
            }}
          />
          <span>{connected ? 'Connected' : 'Disconnected'}</span>
        </div>

        {/* Workspace ID */}
        {workspaceId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ opacity: 0.7 }}>Workspace:</span>
            <span style={{ fontFamily: 'monospace' }}>{workspaceId}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Idle warning */}
        {idleWarning && idleWarning > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: idleWarning < 60 ? '#f44336' : '#ff9800',
              padding: '2px 8px',
              borderRadius: '4px',
              animation: idleWarning < 60 ? 'pulse 1s infinite' : 'none',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
            </svg>
            <span>Idle shutdown in {formatIdleWarning(idleWarning)}</span>
          </div>
        )}

        {/* Current time */}
        <div style={{ fontFamily: 'monospace' }}>{formatTime(currentTime)}</div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
