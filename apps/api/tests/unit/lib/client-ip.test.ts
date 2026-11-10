import { describe, expect, it } from 'vitest';

import { clientIpFromHeaders } from '../../../src/lib/client-ip';

function read(headers: Record<string, string>) {
  const h = new Headers(headers);
  return clientIpFromHeaders((name) => h.get(name));
}

/**
 * What every call site read before the helper existed: the raw `CF-Connecting-IP` header. A
 * well-formed address from Cloudflare must produce exactly this string, or rate-limit keys and
 * stored addresses change on deploy.
 */
function preHelperValue(headers: Record<string, string>) {
  return new Headers(headers).get('CF-Connecting-IP');
}

/** IPv4 and IPv6 spellings an ingress can send, including non-canonical IPv6 forms. */
const WELL_FORMED_SAMPLES = [
  '203.0.113.7',
  '198.51.100.255',
  '0.0.0.0',
  '010.001.1.1',
  '::1',
  '2001:db8::7',
  '2a06:98c0:3600::103',
  '1:2:3:4:5:6:7:8',
  'fe80::1',
  '0:0:0:0:0:0:0:1',
  '2001:DB8:0:0:0:0:0:7',
  '::ffff:198.51.100.9',
];

describe('clientIpFromHeaders', () => {
  it.each(WELL_FORMED_SAMPLES)(
    'returns the trusted header %s byte-identical to the pre-helper value',
    (value) => {
      const headers = { 'CF-Connecting-IP': value, 'X-Forwarded-For': '6.6.6.6' };
      expect(read(headers)).toBe(value);
      expect(read(headers)).toBe(preHelperValue(headers));
    }
  );

  it('never reads X-Forwarded-For when the trusted header is missing', () => {
    expect(read({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' })).toBeNull();
    expect(read({ 'X-Forwarded-For': '198.51.100.1' })).toBeNull();
  });

  it.each([
    'spoof:ratelimit:key',
    'x'.repeat(100),
    '999.1.1.1',
    'not an ip',
    // Hex-and-colon strings that are not IPv6 addresses: each would mint a distinct rate-limit key.
    ':',
    'ab:cd',
    '::::',
    'dead:beef:::::',
    '1.2.3.4:80',
    '1:2:3:4:5:6:7:8:9',
    '[::1]',
    'fe80::1%eth0',
  ])('treats a malformed trusted header (%j) as absent, even beside X-Forwarded-For', (value) => {
    expect(read({ 'CF-Connecting-IP': value })).toBeNull();
    expect(read({ 'CF-Connecting-IP': value, 'X-Forwarded-For': '198.51.100.2' })).toBeNull();
  });

  it('is null when no ingress reported an address', () => {
    expect(read({})).toBeNull();
    expect(read({ 'CF-Connecting-IP': '' })).toBeNull();
  });
});
