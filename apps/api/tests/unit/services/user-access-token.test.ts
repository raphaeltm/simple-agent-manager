import { describe, expect, it, vi } from 'vitest';

import {
  availableUserAccessToken,
  userAccessTokenExpiryIso,
} from '../../../src/services/user-access-token';

describe('user access-token expiry handling', () => {
  it.each([undefined, null])('keeps a token with %s expiry metadata', (accessTokenExpiresAt) => {
    const onExpired = vi.fn();

    expect(
      availableUserAccessToken({ accessToken: 'access', accessTokenExpiresAt }, onExpired)
    ).toBe('access');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('short-circuits a missing token without evaluating expiry metadata', () => {
    const onExpired = vi.fn();

    expect(
      availableUserAccessToken({ accessToken: null, accessTokenExpiresAt: 'not-a-date' }, onExpired)
    ).toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it.each([new Date('2020-01-02T03:04:05.000Z'), '2020-02-03T04:05:06.000Z'])(
    'rejects an expired token and reports its normalized expiry',
    (accessTokenExpiresAt) => {
      const onExpired = vi.fn();

      expect(
        availableUserAccessToken({ accessToken: 'stale', accessTokenExpiresAt }, onExpired)
      ).toBeNull();
      expect(onExpired).toHaveBeenCalledWith(new Date(accessTokenExpiresAt).toISOString());
    }
  );

  it('leaves malformed expiry policy to the provider wrapper', () => {
    const onExpired = vi.fn();

    expect(
      availableUserAccessToken(
        { accessToken: 'access', accessTokenExpiresAt: 'not-a-date' },
        onExpired
      )
    ).toBe('access');
    expect(onExpired).not.toHaveBeenCalled();
    expect(() => userAccessTokenExpiryIso('not-a-date')).toThrow(RangeError);
  });
});
