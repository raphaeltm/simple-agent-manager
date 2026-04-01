import type { AgentSession } from '@simple-agent-manager/shared';
import { useEffect, useRef } from 'react';

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
      className="flex items-center justify-between px-3 py-1 bg-warning-surface text-tn-yellow text-xs shrink-0 gap-2"
      style={{ borderBottom: '1px solid rgba(224, 175, 104, 0.3)' }}
    >
      <span>Recovered {label} still running on VM</span>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onStopAll}
          className="bg-transparent rounded-sm text-tn-yellow cursor-pointer px-2 py-0.5"
          style={{
            border: '1px solid rgba(224, 175, 104, 0.4)',
            fontSize: '0.6875rem',
          }}
        >
          Stop All
        </button>
        <button
          onClick={onDismiss}
          aria-label="Dismiss orphaned sessions banner"
          className="bg-transparent border-none text-tn-yellow cursor-pointer text-sm px-1 py-0 leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
