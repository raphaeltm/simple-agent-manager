import { useState, useEffect } from 'react';
import { StatusBadge } from '@simple-agent-manager/ui';

interface StatusBarProps {
  connected: boolean;
  nodeId?: string;
}

export function StatusBar({ connected, nodeId }: StatusBarProps) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) =>
    date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <StatusBadge status={connected ? 'connected' : 'disconnected'} />
        </div>

        {nodeId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ opacity: 0.7 }}>Node:</span>
            <span style={{ fontFamily: 'monospace' }}>{nodeId}</span>
          </div>
        )}
      </div>

      <div style={{ fontFamily: 'monospace' }}>{formatTime(currentTime)}</div>
    </div>
  );
}
