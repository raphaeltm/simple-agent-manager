/** Socket capability and append offsets are protocol constants, not runtime settings. */
export const CHAT_MESSAGE_APPEND_CAPABILITY = 'message-append-v1';

/** UTF-16 offsets match JavaScript string slicing on both Worker and browser. */
export interface ChatMessageAppend {
  id: string;
  sessionId: string;
  content: string;
  offset: number;
  revision: number;
}
