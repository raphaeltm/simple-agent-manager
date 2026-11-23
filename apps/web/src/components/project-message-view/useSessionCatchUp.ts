import { type Dispatch, type SetStateAction, useCallback } from 'react';

import type { SnapshotCurrent } from '../../hooks/chat-websocket-types';
import type { ChatMessageResponse, ChatSessionResponse, SessionStateSnapshot } from '../../lib/api';
import type { ToolSnapshotChanges } from '../../lib/api/session-transcript-types';
import type { SessionTranscript } from './useSessionTranscript';

/** Preserve the mutation journal when the socket reconnects behind the newest window. */
export function useSessionCatchUp(
  setSession: Dispatch<SetStateAction<ChatSessionResponse | null>>,
  mergeRecentWindow: SessionTranscript['mergeRecentWindow'],
  hydrateState: (
    state: SessionStateSnapshot | null | undefined,
    isCurrent?: SnapshotCurrent
  ) => void
) {
  return useCallback(
    (
      messages: ChatMessageResponse[],
      session: ChatSessionResponse,
      state?: SessionStateSnapshot | null,
      toolChanges?: ToolSnapshotChanges,
      isSnapshotCurrent: SnapshotCurrent = () => true
    ) => {
      setSession((latest) => ({
        ...session,
        ...Object.fromEntries(
          Object.entries(latest ?? {}).filter(([field]) => !isSnapshotCurrent(field))
        ),
      }));
      const merged = mergeRecentWindow(
        {
          session,
          messages,
          hasMore: true,
          state: state ?? null,
          toolChanges,
        },
        undefined,
        isSnapshotCurrent
      ).catch(() => {
        /* The next poll/reconnect retries; keep the current transcript. */
      });
      hydrateState(state, isSnapshotCurrent);
      return merged;
    },
    [setSession, mergeRecentWindow, hydrateState]
  );
}
