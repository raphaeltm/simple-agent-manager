import { describe, expect, it } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';
import { applyMessageAppend, mergeMessages } from '../../../src/lib/merge-messages';

const original: ChatMessageResponse = {
  id: 'canonical',
  sessionId: 'session',
  role: 'assistant',
  content: 'Hello',
  toolMetadata: null,
  createdAt: 1,
  sequence: 1,
};
const append = {
  id: original.id,
  sessionId: original.sessionId,
  content: ' world',
  offset: 5,
  revision: 11,
};

describe('canonical streamed message appends', () => {
  it('appends a delta once under the stable ID and immutable position', () => {
    const first = applyMessageAppend([original], append);
    expect(first.needsCatchUp).toBe(false);
    expect(first.messages).toEqual([{ ...original, content: 'Hello world' }]);
    expect(applyMessageAppend(first.messages, append)).toEqual(first);
  });

  it('requests catch-up without showing a suffix when its base is missing', () => {
    expect(applyMessageAppend([], append)).toEqual({ messages: [], needsCatchUp: true });
    expect(applyMessageAppend([original], { ...append, offset: 20, revision: 26 })).toEqual({
      messages: [original],
      needsCatchUp: true,
    });
  });

  it('rejects a conflicting duplicate and malformed revisions', () => {
    const complete = { ...original, content: 'Hello world' };
    expect(applyMessageAppend([complete], { ...append, content: ' WORLD' }).needsCatchUp).toBe(
      true
    );
    for (const bad of [
      { ...append, offset: -1 },
      { ...append, revision: 12 },
      { ...append, offset: 1.5 },
      { ...append, sessionId: 'foreign' },
    ])
      expect(applyMessageAppend([original], bad).messages).toEqual([original]);
  });

  it('uses UTF-16 offsets consistently for emoji and multibyte characters', () => {
    const row = { ...original, content: '🙂' };
    expect(
      applyMessageAppend([row], { ...append, content: ' é', offset: 2, revision: 4 }).messages
    ).toEqual([{ ...row, content: '🙂 é' }]);
  });

  it('does not erase live growth when an older REST window or history page arrives', () => {
    const grown = { ...original, content: 'Hello world' };
    for (const strategy of ['replace', 'append', 'prepend'] as const) {
      expect(mergeMessages([grown], [original], strategy)).toEqual([grown]);
      expect(mergeMessages([original], [grown], strategy)).toEqual([grown]);
    }
  });

  it('keeps ordinary duplicate-ID semantics for non-prefix conflicts and user rows', () => {
    expect(mergeMessages([original], [{ ...original, content: 'other' }], 'append')).toEqual([
      original,
    ]);
    const user = { ...original, role: 'user' };
    expect(mergeMessages([user], [{ ...user, content: 'Hello world' }], 'append')).toEqual([user]);
  });
});
