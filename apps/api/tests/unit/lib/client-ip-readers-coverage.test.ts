/**
 * Enumeration test for the one client-IP rule (`lib/client-ip.ts`, PR #2622 follow-up item 7).
 *
 * Every reader of the client address must go through `clientIpFromHeaders`: a raw
 * `CF-Connecting-IP` read skips its validation, and any `X-Forwarded-For` read trusts a value
 * the client wrote. Behaviour is covered by client-ip.test.ts and the call-site tests; this is a
 * structural scan (rule 02 allows those for static structure) so a NEW raw read turns CI red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

/** A header read by name, in any case: `.header('cf-connecting-ip')`, `.get("X-Forwarded-For")`. */
const RAW_READ = /\.(?:header|get)\(\s*['"`](?:cf-connecting-ip|x-forwarded-for)['"`]\s*\)/i;

/** Files allowed to name the headers, each with the reason. */
const ALLOWLIST: Record<string, string> = {
  'lib/client-ip.ts': 'The helper itself: the one place the trusted header is read.',
};

describe('client IP readers', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('scans the real source tree', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('read the client address only through clientIpFromHeaders', () => {
    const offenders = files
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'))
      .filter((relative) => !(relative in ALLOWLIST))
      .filter((relative) => RAW_READ.test(readFileSync(path.join(SRC_ROOT, relative), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scan pattern catches a raw read (control)', () => {
    expect(RAW_READ.test(`const ip = c.req.header('CF-Connecting-IP');`)).toBe(true);
    expect(RAW_READ.test(`headers.get("x-forwarded-for")`)).toBe(true);
    // Setting the outbound header on the VM hop is not a read.
    expect(RAW_READ.test(`headers.set('X-Forwarded-For', ip)`)).toBe(false);
  });
});
