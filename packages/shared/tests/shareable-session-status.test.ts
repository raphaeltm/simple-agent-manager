import { describe, expect, it } from 'vitest';

import { type ChatSessionStatus, isShareableChatSessionStatus } from '../src';

/**
 * Every chat status is placed on one side on purpose. A new `ChatSessionStatus` fails to compile
 * here until someone decides whether a chat in that state can still be shared (.claude/rules/79).
 */
const SHAREABLE: Record<ChatSessionStatus, boolean> = {
  active: true,
  // Asleep is still a live conversation: the next message wakes it.
  sleeping: true,
  stopped: false,
  error: false,
};

describe('isShareableChatSessionStatus', () => {
  it.each(Object.entries(SHAREABLE))('%s → %s', (status, expected) => {
    expect(isShareableChatSessionStatus(status)).toBe(expected);
  });

  it('refuses a missing or unknown status', () => {
    expect(isShareableChatSessionStatus(null)).toBe(false);
    expect(isShareableChatSessionStatus(undefined)).toBe(false);
    expect(isShareableChatSessionStatus('archived')).toBe(false);
  });
});
