import { describe, expect, it } from 'vitest';

import { clientIpFromHeaders } from '../../../src/lib/client-ip';

function read(headers: Record<string, string>) {
  const h = new Headers(headers);
  return clientIpFromHeaders((name) => h.get(name));
}

describe('clientIpFromHeaders', () => {
  it('prefers the ingress-set CF-Connecting-IP (Cloudflare behaviour)', () => {
    expect(read({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '6.6.6.6' })).toBe(
      '203.0.113.7'
    );
    expect(read({ 'CF-Connecting-IP': '2001:db8::7' })).toBe('2001:db8::7');
  });

  it('falls back to the first X-Forwarded-For entry, not the whole list', () => {
    expect(read({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' })).toBe('198.51.100.1');
  });

  it.each([
    'spoof:ratelimit:key',
    'x'.repeat(100),
    '999.1.1.1',
    'not an ip',
    '',
    // Hex-and-colon strings that are not IPv6 addresses: each would mint a distinct rate-limit key.
    ':',
    'ab:cd',
    '::::',
    'dead:beef:::::',
    '1.2.3.4:80',
    '1:2:3:4:5:6:7:8:9',
  ])(
    'treats a value that is not an IP literal (%j) as absent',
    (value) => {
      expect(read({ 'CF-Connecting-IP': value })).toBeNull();
      expect(read({ 'CF-Connecting-IP': value, 'X-Forwarded-For': '198.51.100.2' })).toBe(
        '198.51.100.2'
      );
    }
  );

  it.each(['::1', '2001:db8::1', '::ffff:198.51.100.9', '1:2:3:4:5:6:7:8', 'fe80::1'])(
    'accepts the IPv6 literal %s',
    (value) => {
      expect(read({ 'CF-Connecting-IP': value })).toBe(value);
    }
  );

  it('is null when no ingress reported an address', () => {
    expect(read({})).toBeNull();
  });
});
