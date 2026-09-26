import { describe, expect, it } from 'vitest';

import {
  compareMessagePositions,
  formatMessageCursor,
  type MessagePosition,
  parseMessageCursor,
} from '../src/message-cursor';

const position: MessagePosition = { createdAt: 1_700_000_000_000, sequence: 42, id: 'msg-b' };

describe('message cursor encoding', () => {
  it('round-trips an exact position through its query value', () => {
    const encoded = formatMessageCursor(position);
    expect(encoded).toBe('[1700000000000,42,"msg-b"]');
    expect(parseMessageCursor(encoded)).toEqual(position);
  });

  it('survives URL query encoding', () => {
    const query = new URLSearchParams({ after: formatMessageCursor(position) }).toString();
    expect(parseMessageCursor(new URLSearchParams(query).get('after') ?? '')).toEqual(position);
  });

  it('still accepts a legacy integer timestamp', () => {
    expect(parseMessageCursor('1700000000000')).toBe(1_700_000_000_000);
    expect(parseMessageCursor('-5')).toBe(-5);
  });

  it.each([
    ['empty', ''],
    ['non-numeric text', 'yesterday'],
    ['a timestamp with trailing garbage', '1700000000000abc'],
    ['a fractional timestamp', '1700000000000.5'],
    ['an unsafe integer', '9007199254740993'],
    ['malformed JSON', '[1,2,'],
    ['a two-element tuple', '[1,2]'],
    ['a four-element tuple', '[1,2,"id",4]'],
    ['a fractional sequence', '[1,2.5,"id"]'],
    ['a string timestamp', '["1",2,"id"]'],
    ['an empty id', '[1,2,""]'],
    ['an object', '{"createdAt":1,"sequence":2,"id":"id"}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseMessageCursor(raw)).toBeNull();
  });
});

describe('compareMessagePositions', () => {
  it('orders by createdAt, then sequence, then id', () => {
    const tiedAtOneMillisecond = [
      { createdAt: 2, sequence: 1, id: 'z' },
      { createdAt: 1, sequence: 9, id: 'a' },
      { createdAt: 2, sequence: 1, id: 'a' },
      { createdAt: 2, sequence: 0, id: 'm' },
    ];
    expect([...tiedAtOneMillisecond].sort(compareMessagePositions)).toEqual([
      { createdAt: 1, sequence: 9, id: 'a' },
      { createdAt: 2, sequence: 0, id: 'm' },
      { createdAt: 2, sequence: 1, id: 'a' },
      { createdAt: 2, sequence: 1, id: 'z' },
    ]);
  });

  it('reports an identical position as equal', () => {
    expect(compareMessagePositions(position, { ...position })).toBe(0);
  });
});
