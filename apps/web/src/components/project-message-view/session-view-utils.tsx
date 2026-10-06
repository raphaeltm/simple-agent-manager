import type { PlanItem } from '@simple-agent-manager/acp-client';
import { type FC, useEffect, useState } from 'react';

/** Convert session state plan array to PlanItem for the CompletionDock plan pill / PlanModal. */
export function currentPlanToPlanItem(plan: Array<{ content: string; status: string }>): PlanItem {
  return {
    kind: 'plan',
    id: 'session-plan',
    entries: plan.map((entry) => ({
      content: entry.content,
      priority: 'medium' as const,
      status: (entry.status === 'completed'
        ? 'completed'
        : entry.status === 'in_progress'
          ? 'in_progress'
          : 'pending') as 'pending' | 'in_progress' | 'completed',
    })),
    timestamp: Date.now(),
  };
}

/** Live elapsed-time display since prompt started. */
export const ElapsedTime: FC<{ startedAt: number }> = ({ startedAt }) => {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const update = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      setElapsed(minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <span className="text-xs text-fg-muted tabular-nums" aria-hidden="true">
      ({elapsed})
    </span>
  );
};
