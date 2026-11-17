import { type Dispatch, type SetStateAction, useCallback } from 'react';

import type {
  ChatMessageResponse,
  ChatSessionDetailResponse,
  ChatSessionResponse,
  SessionStateSnapshot,
} from '../../lib/api';
import type { ToolSnapshotChanges } from '../../lib/api/session-transcript-types';

/** Preserve the mutation journal when the socket reconnects behind the newest window. */
export function useSessionCatchUp(
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>,
  mergeRecentWindow: (recent: ChatSessionDetailResponse) => Promise<void>,
  hydrateState: (state: SessionStateSnapshot | null | undefined) => void
) {
  return useCallback(
    (
      messages: ChatMessageResponse[],
      session: ChatSessionResponse,
      state?: SessionStateSnapshot | null,
      toolChanges?: ToolSnapshotChanges
    ) => {
      setSession(session);
      const merged = mergeRecentWindow({
        session,
        messages,
        hasMore: true,
        state: state ?? null,
        toolChanges,
      }).catch(() => {
        /* The next poll/reconnect retries; keep the current transcript. */
      });
      hydrateState(state);
      return merged;
    },
    [setSession, mergeRecentWindow, hydrateState]
  );
}
