import { describe, expect, it } from 'vitest';

import { isPinnedAt } from '../src/lib/blog-utils';

const until = new Date('2026-12-09T00:00:00Z');

describe('isPinnedAt', () => {
  it('is not pinned without the flag, even with a future end date', () => {
    expect(isPinnedAt({}, new Date('2026-12-01T00:00:00Z'))).toBe(false);
    expect(isPinnedAt({ pinned: false, pinnedUntil: until }, new Date('2026-12-01T00:00:00Z'))).toBe(false);
  });

  it('stays pinned with no end date', () => {
    expect(isPinnedAt({ pinned: true }, new Date('2099-01-01T00:00:00Z'))).toBe(true);
  });

  it('is pinned before the end date and not from it on', () => {
    expect(isPinnedAt({ pinned: true, pinnedUntil: until }, new Date('2026-12-08T23:59:59Z'))).toBe(true);
    expect(isPinnedAt({ pinned: true, pinnedUntil: until }, until)).toBe(false);
    expect(isPinnedAt({ pinned: true, pinnedUntil: until }, new Date('2026-12-20T00:00:00Z'))).toBe(false);
  });
});
