import { useEffect, useRef, useState } from 'react';

import type { AgentActivityState } from './types';

export const COMPLETION_DOCK_IDLE_STABILIZE_MS = 1_000;

export function useCompletionDockWorking(agentActivity: AgentActivityState): boolean {
  const activityWorking = agentActivity !== 'idle';
  const [completionDockWorking, setCompletionDockWorking] = useState(activityWorking);
  const completionDockWorkingRef = useRef(activityWorking);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (activityWorking) {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (!completionDockWorkingRef.current) {
        completionDockWorkingRef.current = true;
        setCompletionDockWorking(true);
      }
      return;
    }

    if (!completionDockWorkingRef.current || idleTimerRef.current) return;

    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      completionDockWorkingRef.current = false;
      setCompletionDockWorking(false);
    }, COMPLETION_DOCK_IDLE_STABILIZE_MS);

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [activityWorking]);

  return activityWorking || completionDockWorking;
}
