/**
 * Which user messages fade in: only one the user just sent. Messages already on
 * screen when a chat opens, and older history paged in at the front, are not new.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAnimatedUserMessages } from '../../../src/components/project-message-view/useAnimatedUserMessages';
import type { ChatMessageResponse } from '../../../src/lib/api';

function message(id: string, createdAt: number): ChatMessageResponse {
  return { id, sessionId: 'sess-1', role: 'user', content: id, toolMetadata: null, createdAt };
}

describe('useAnimatedUserMessages', () => {
  it('fades in a message the user just sent', () => {
    const { result, rerender } = renderHook(({ messages }) => useAnimatedUserMessages(messages), {
      initialProps: { messages: [message('m1', 1)] },
    });

    rerender({ messages: [message('m1', 1), message('optimistic-sent', 2)] });

    expect(result.current.has('optimistic-sent')).toBe(true);
  });

  it('does not fade in a message still sending when its chat is opened again', () => {
    const { result } = renderHook(() =>
      useAnimatedUserMessages([message('m1', 1), message('optimistic-sending', 2)])
    );

    expect(result.current.has('optimistic-sending')).toBe(false);
  });

  it('does not treat older history paged in at the front as new', () => {
    const loaded = [message('m3', 3), message('optimistic-sending', 4)];
    const { result, rerender } = renderHook(({ messages }) => useAnimatedUserMessages(messages), {
      initialProps: { messages: loaded },
    });

    rerender({ messages: [message('m1', 1), message('m2', 2), ...loaded] });

    expect(result.current.size).toBe(0);
  });
});
