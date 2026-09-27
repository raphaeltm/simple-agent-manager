import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Unsent composer text for each chat, kept while the user switches between chats.
 *
 * Every chat view remounts on a switch, so a draft held in the view's own state
 * would be lost the moment the user glanced at another chat. The store lives
 * above that per-session key, in memory only: it survives a switch, not a reload.
 * It also sits inside the signed-in subtree, which an account switch unmounts, so
 * one account's drafts never reach the next.
 *
 * A sent message's text leaves the saved draft when the send starts, so a chat
 * reopened while it is in flight does not offer it to send again; the view that
 * sent it keeps showing it until delivery, as before. Delivery clears the
 * composer only while it still holds that text, and a failed send keeps the text
 * to retry. Both can land after the user has left the chat, and neither may touch
 * newer text.
 */
const SessionDraftsContext = createContext<Map<string, string> | null>(null);

export function SessionDraftsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [drafts] = useState(() => new Map<string, string>());
  return <SessionDraftsContext.Provider value={drafts}>{children}</SessionDraftsContext.Provider>;
}

export interface SessionDraft {
  /** The composer text. */
  text: string;
  setText: (text: string) => void;
  /** `sent` is on its way: a chat reopened meanwhile must not offer it again. */
  sending: (sent: string) => void;
  /** `sent` was delivered: clear the composer, unless it holds newer text by now. */
  delivered: (sent: string) => void;
  /** `sent` failed: keep it to retry, unless newer text replaced it. */
  failed: (sent: string) => void;
}

/** One chat's composer text: starts from its saved draft and saves every edit. */
export function useSessionDraft(sessionId: string): SessionDraft {
  const drafts = useContext(SessionDraftsContext);
  const [text, setTextState] = useState(() => drafts?.get(sessionId) ?? '');

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      if (next) drafts?.set(sessionId, next);
      else drafts?.delete(sessionId);
    },
    [drafts, sessionId]
  );

  const sending = useCallback(
    (sent: string) => {
      if (drafts?.get(sessionId)?.trim() === sent) drafts.delete(sessionId);
    },
    [drafts, sessionId]
  );

  const delivered = useCallback(
    (sent: string) => {
      setTextState((current) => (current.trim() === sent ? '' : current));
      if (drafts?.get(sessionId)?.trim() === sent) drafts.delete(sessionId);
    },
    [drafts, sessionId]
  );

  const failed = useCallback(
    (sent: string) => {
      setTextState((current) => current || sent);
      if (drafts && !drafts.get(sessionId)) drafts.set(sessionId, sent);
    },
    [drafts, sessionId]
  );

  return useMemo(
    () => ({ text, setText, sending, delivered, failed }),
    [text, setText, sending, delivered, failed]
  );
}
