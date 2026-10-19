import type { SessionAccessSummary } from '@simple-agent-manager/shared';
import { type Dispatch, type SetStateAction, useCallback } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { getSessionAccess } from '../../lib/api';

/**
 * Keep the viewer's shared-session access current. `applySessionAccess` takes a summary the
 * share dialog already has; `onSessionAccessChanged` handles the `session.access.changed`
 * socket event, so a revoked grantee's composer locks (and a new grantee's unlocks) without
 * a reload.
 */
export function useSessionAccessSync(
  projectId: string,
  sessionId: string,
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>
) {
  const applySessionAccess = useCallback(
    (access: SessionAccessSummary) => {
      setSession((prev) =>
        prev && prev.id === access.sessionId
          ? ({ ...prev, viewerAccess: access.viewerAccess, access } as ChatSessionResponse)
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

  return { applySessionAccess, onSessionAccessChanged };
}
