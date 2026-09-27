import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

/**
 * Unsent composer text for each chat, kept while the user switches between chats.
 *
 * Every chat view remounts on a switch, so a draft held in the view's own state
 * would be lost the moment the user glanced at another chat. The store lives
 * above that per-session key, in memory only: it survives a switch, not a reload.
 */
const SessionDraftsContext = createContext<Map<string, string> | null>(null);

export function SessionDraftsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [drafts] = useState(() => new Map<string, string>());
  return <SessionDraftsContext.Provider value={drafts}>{children}</SessionDraftsContext.Provider>;
}

/** One chat's composer text: starts from its saved draft and saves every edit. */
export function useSessionDraft(sessionId: string): [string, (text: string) => void] {
  const drafts = useContext(SessionDraftsContext);
  const [draft, setDraftState] = useState(() => drafts?.get(sessionId) ?? '');

  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      if (text) drafts?.set(sessionId, text);
      else drafts?.delete(sessionId);
    },
    [drafts, sessionId]
  );

  return [draft, setDraft];
}
