import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * Query parameters of a comment deep link into a project chat:
 * `?commentThread=<threadId>&commentMessage=<messageId>[&commentAt=<ms>]`.
 *
 * The comment reader's "Open in chat" sets all three (`openInChatPath`), `commentAt` being the
 * commented message's own time. Comment notifications and the Comments page open the reader
 * instead (`buildCommentActionUrl`, `commentReaderPath`); notifications sent before that carry
 * `commentThread` + `commentMessage` only.
 */
const COMMENT_THREAD_PARAM = 'commentThread';
const COMMENT_MESSAGE_PARAM = 'commentMessage';
const COMMENT_AT_PARAM = 'commentAt';
const COMMENT_PARAMS = [COMMENT_THREAD_PARAM, COMMENT_MESSAGE_PARAM, COMMENT_AT_PARAM] as const;

export interface CommentDeepLink {
  /** Message to jump to, and the time used to page older history in to find it. */
  targetMessage: { messageId: string; timestamp: number | null } | null;
  /** Thread to open focused. */
  focusThreadId: string | null;
  /**
   * Drop the deep-link parameters (replace, no history entry) so a refresh does not jump
   * again. Called once the conversation has taken the jump; the comment UI latches the thread
   * id on mount, so it survives the parameter going away before its threads load.
   */
  consume: () => void;
}

export function useCommentDeepLink(): CommentDeepLink {
  const location = useLocation();
  const navigate = useNavigate();

  const parsed = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const messageId = params.get(COMMENT_MESSAGE_PARAM);
    const timestampRaw = params.get(COMMENT_AT_PARAM);
    const timestamp = timestampRaw ? Number(timestampRaw) : null;
    return {
      targetMessage: messageId
        ? { messageId, timestamp: Number.isFinite(timestamp) ? timestamp : null }
        : null,
      focusThreadId: params.get(COMMENT_THREAD_PARAM) || null,
    };
  }, [location.search]);

  const consume = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (!COMMENT_PARAMS.some((name) => params.has(name))) return;
    for (const name of COMMENT_PARAMS) params.delete(name);
    const nextSearch = params.toString();
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`, {
      replace: true,
    });
  }, [location.hash, location.pathname, location.search, navigate]);

  return { ...parsed, consume };
}
