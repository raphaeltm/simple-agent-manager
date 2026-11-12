import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { rateLimitSubject, takeRateLimit } from '../../../src/services/webhook-ingress-http';
import { createMemoryKv } from '../../helpers/sqlite-d1';

describe('rateLimitSubject', () => {
  it('counts IPv6 callers per /64, whatever form the address is written in', () => {
    const subject = '2001:db8:aa:1::/64';
    expect(rateLimitSubject('2001:db8:aa:1::1')).toBe(subject);
    expect(rateLimitSubject('2001:0db8:00aa:0001:ffff:ffff:ffff:fffe')).toBe(subject);
    expect(rateLimitSubject('2001:DB8:AA:1:0:0:0:9')).toBe(subject);
    // A different /64 is a different caller.
    expect(rateLimitSubject('2001:db8:aa:2::1')).not.toBe(subject);
  });

  it('expands a leading or middle "::" before taking the prefix', () => {
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('leaves IPv4 and anything it cannot parse as it is', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('unknown')).toBe('unknown');
    expect(rateLimitSubject('2001:db8::zz')).toBe('2001:db8::zz');
  });
});

describe('takeRateLimit', () => {
  it('counts calls and limits past the budget', async () => {
    const env = { KV: createMemoryKv() } as unknown as Env;
    const results = [];
    for (let n = 0; n < 3; n++) results.push((await takeRateLimit(env, 'p', 'id', 2, 60)).limited);
    expect(results).toEqual([false, false, true]);
  });

  it('lets the call through when the counter cannot be written', async () => {
    const put = vi.fn(async () => {
      throw new Error('KV PUT failed: 429 Too Many Requests');
    });
    const env = { KV: { get: async () => null, put } } as unknown as Env;
    expect((await takeRateLimit(env, 'p', 'id', 2, 60)).limited).toBe(false);
    expect(put).toHaveBeenCalled();
  });
});
