import { useEffect, useRef, useState } from 'react';

import type { ChatMessageResponse } from '../../lib/api';

/** How long a freshly sent user message stays eligible for its fade-in (animation 1.5 s + buffer). */
const USER_MESSAGE_ANIMATION_WINDOW_MS = 2000;

/**
 * Ids of freshly submitted optimistic user messages that should fade in.
 *
 * Returned as a stable, mutable set: membership is read while rendering rows,
 * and each id leaves the set once its animation window has passed.
 */
export function useAnimatedUserMessages(messages: ChatMessageResponse[]): ReadonlySet<string> {
  const [animatedUserMsgIds] = useState(() => new Set<string>());
  const prevMsgCountRef = useRef(0);

  // Detect newly added optimistic user messages for fade animation
  useEffect(() => {
    const currentCount = messages.length;
    if (currentCount > prevMsgCountRef.current) {
      // Check for new optimistic messages in the delta
      for (let i = prevMsgCountRef.current; i < currentCount; i++) {
        const msg = messages[i];
        if (msg && msg.role === 'user' && msg.id.startsWith('optimistic-')) {
          animatedUserMsgIds.add(msg.id);
          setTimeout(() => {
            animatedUserMsgIds.delete(msg.id);
          }, USER_MESSAGE_ANIMATION_WINDOW_MS);
        }
      }
    }
    prevMsgCountRef.current = currentCount;
  }, [messages, animatedUserMsgIds]);

  return animatedUserMsgIds;
}
