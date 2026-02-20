import { useEffect, useRef } from 'react';
import type { AgentSession } from '@simple-agent-manager/shared';

interface OrphanedSessionsBannerProps {
  orphanedSessions: AgentSession[];
  onStopAll: () => void;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 15_000;

export function OrphanedSessionsBanner({
  orphanedSessions,
  onStopAll,
  onDismiss,
}: OrphanedSessionsBannerProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onDismiss]);

  if (orphanedSessions.length === 0) return null;

  const count = orphanedSessions.length;
  const label = count === 1 ? '1 hidden session' : `${count} hidden sessions`;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 12px',
        backgroundColor: '#2e2a1f',
        borderBottom: '1px solid rgba(224, 175, 104, 0.3)',
        fontSize: '0.75rem',
        color: '#e0af68',
        flexShrink: 0,
        gap: '8px',
      }}
    >
      <span>Recovered {label} still running on VM</span>
      <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
        <button
          onClick={onStopAll}
          style={{
            background: 'none',
            border: '1px solid rgba(224, 175, 104, 0.4)',
            borderRadius: '4px',
            color: '#e0af68',
            cursor: 'pointer',
            fontSize: '0.6875rem',
            padding: '2px 8px',
          }}
        >
          Stop All
        </button>
        <button
          onClick={onDismiss}
          aria-label="Dismiss orphaned sessions banner"
          style={{
            background: 'none',
            border: 'none',
            color: '#e0af68',
            cursor: 'pointer',
            fontSize: '0.875rem',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
