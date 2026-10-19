import type { SessionAccessSummary } from '@simple-agent-manager/shared';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { getSessionAccess } from '../../lib/api';
import { serverNow } from '../../lib/server-clock';

/** Ask the server this long after a grant's end time, so its clock has passed it too. */
export const ACCESS_EXPIRY_REFETCH_GRACE_MS = 2_000;

/**
 * Keep the viewer's shared-session access current. `applySessionAccess` takes a summary the
 * share dialog already has; `onSessionAccessChanged` handles the `session.access.changed`
 * socket event, so a revoked or expired grantee's composer locks (and a new grantee's unlocks)
 * without a reload.
 *
 * The server also says when a grant expires, but only to open sockets, and a sleeping chat's
 * socket is closed. So the hook refetches once the soonest grant in `access` has ended. That
 * only updates the display: the server already refuses an expired grant.
 */
export function useSessionAccessSync(
  projectId: string,
  sessionId: string,
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>,
  access: SessionAccessSummary | undefined
) {
  const applySessionAccess = useCallback(
    (summary: SessionAccessSummary) => {
      setSession((prev) =>
        prev && prev.id === summary.sessionId
          ? ({
              ...prev,
              viewerAccess: summary.viewerAccess,
              access: summary,
            } as ChatSessionResponse)
          : prev
      );
    },
    [setSession]
  );

  const onSessionAccessChanged = useCallback(() => {
    void getSessionAccess(projectId, sessionId)
      .then(applySessionAccess)
      .catch(() => {
        // The next session refresh carries viewerAccess too.
      });
  }, [applySessionAccess, projectId, sessionId]);

  const nextExpiresAt = useMemo(() => {
    // A summary cached before grants had end times has none; never schedule on NaN, which
    // `setTimeout` treats as 0 and would turn into a refetch loop.
    const ends = (access?.grants ?? [])
      .map((grant) => grant.expiresAt)
      .filter((expiresAt) => Number.isFinite(expiresAt));
    return ends.length > 0 ? Math.min(...ends) : null;
  }, [access]);
  const summaryTime = access?.serverTime;

  useEffect(() => {
    if (nextExpiresAt === null) return;
    // A fresh summary re-arms this, so a refetch that lands a moment early waits again rather
    // than looping: every wait is at least the grace period.
    const delay = Math.max(0, nextExpiresAt - serverNow()) + ACCESS_EXPIRY_REFETCH_GRACE_MS;
    const id = window.setTimeout(onSessionAccessChanged, delay);
    return () => window.clearTimeout(id);
  }, [nextExpiresAt, summaryTime, onSessionAccessChanged]);

  return { applySessionAccess, onSessionAccessChanged };
}
