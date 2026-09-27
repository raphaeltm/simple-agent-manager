import { useEffect, useRef, useState } from 'react';

import type { ChatMessageResponse } from '../../lib/api';

/** How long a freshly sent user message stays eligible for its fade-in (animation 1.5 s + buffer). */
const USER_MESSAGE_ANIMATION_WINDOW_MS = 2000;

function isOptimisticUserMessage(message: ChatMessageResponse): boolean {
  return message.role === 'user' && message.id.startsWith('optimistic-');
}

/**
 * Ids of freshly submitted optimistic user messages that should fade in.
 *
 * Returned as a stable, mutable set: membership is read while rendering rows,
 * and each id leaves the set once its animation window has passed.
 *
 * New messages are told apart by id, not by position: older history pages in at
 * the front, and a chat reopened while its message is still sending already
 * shows that message, which must not fade in a second time.
 */
export function useAnimatedUserMessages(messages: ChatMessageResponse[]): ReadonlySet<string> {
  const [animatedUserMsgIds] = useState(() => new Set<string>());
  const [seenIds] = useState(
    () => new Set(messages.filter(isOptimisticUserMessage).map((message) => message.id))
  );
  const prevMsgCountRef = useRef(messages.length);

  useEffect(() => {
    // A sent message is the newest row, so only the rows this change added at
    // the end need a look.
    const added = messages.length - prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - added); i--) {
      const msg = messages[i];
      if (!msg || !isOptimisticUserMessage(msg) || seenIds.has(msg.id)) continue;
      seenIds.add(msg.id);
      animatedUserMsgIds.add(msg.id);
      setTimeout(() => {
        animatedUserMsgIds.delete(msg.id);
      }, USER_MESSAGE_ANIMATION_WINDOW_MS);
    }
  }, [messages, animatedUserMsgIds, seenIds]);

  return animatedUserMsgIds;
}
