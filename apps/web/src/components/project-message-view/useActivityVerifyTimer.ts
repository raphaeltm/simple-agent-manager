import { useCallback, useEffect, useRef } from 'react';

import { getChatSession } from '../../lib/api';
import { isWorkingActivity } from './types';

interface ActivityVerifyTimerOptions {
  projectId: string;
  sessionId: string;
  delayMs: number;
  logMessage: string;
  onVerifiedIdle: () => void;
}

export function useActivityVerifyTimer({
  projectId,
  sessionId,
  delayMs,
  logMessage,
  onVerifiedIdle,
}: ActivityVerifyTimerOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const verifyAbortRef = useRef<AbortController | null>(null);
  const nullStateVerifyCountRef = useRef(0);

  const stopVerifyDecayTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    verifyAbortRef.current?.abort();
    verifyAbortRef.current = null;
  }, []);

  const startVerifyDecayTimer = useCallback(() => {
    stopVerifyDecayTimer();
    const abortController = new AbortController();
    verifyAbortRef.current = abortController;

    const armVerifyTimer = () => {
      timerRef.current = setTimeout(async () => {
        if (abortController.signal.aborted) return;
        try {
          const data = await getChatSession(projectId, sessionId, {
            limit: 0,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) return;
          const activity = data.state?.activity;
          if (isWorkingActivity(activity)) {
            nullStateVerifyCountRef.current = 0;
            armVerifyTimer();
          } else if (activity == null && nullStateVerifyCountRef.current < 3) {
            nullStateVerifyCountRef.current += 1;
            armVerifyTimer();
          } else {
            nullStateVerifyCountRef.current = 0;
            onVerifiedIdle();
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            console.warn(logMessage, err);
            armVerifyTimer();
          }
        }
      }, delayMs);
    };

    armVerifyTimer();
  }, [delayMs, logMessage, onVerifiedIdle, projectId, sessionId, stopVerifyDecayTimer]);

  useEffect(() => stopVerifyDecayTimer, [stopVerifyDecayTimer]);

  return { startVerifyDecayTimer, stopVerifyDecayTimer };
}
