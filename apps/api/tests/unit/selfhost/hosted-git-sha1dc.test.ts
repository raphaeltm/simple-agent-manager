import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Sha1Dc } from '../../../src/vendor/dgit/git/sha1';

/**
 * The vendored SHA-1DC detector that hosted-git push ingest screens every object with
 * (`collisionDetect: true` in hosted-git-repo.ts). The fixtures are the first 320 bytes of the
 * two SHAttered PDFs (shattered.io, also git's t/t0013): a shared prefix and the two
 * near-collision blocks, which hash to the same SHA-1. tests/hosted-git covers the push path.
 */
const SHATTERED_1 =
  'JVBERi0xLjMKJeLjz9MKCgoxIDAgb2JqCjw8L1dpZHRoIDIgMCBSL0hlaWdodCAzIDAgUi9UeXBlIDQgMCBSL1N1YnR5cGUgNSAwIFIvRmlsdGVyIDYgMCBSL0NvbG9yU3BhY2UgNyAwIFIvTGVuZ3RoIDggMCBSL0JpdHNQZXJDb21wb25lbnQgOD4+CnN0cmVhbQr/2P/+ACRTSEEtMSBpcyBkZWFkISEhISGFL+wJIzl1nDmxocY8TJfh//4Bc0bckWa2fhGPApq2IbJWD/nKZ8yox/hbqEx5AwwrPeIY+G2zqQkB1d9FwU8m/t+z3DjpasIv571yjw5FvOBG0jxXD+sUE5i7VS71oKgr4zH+pIA3uLXXHw4zLt+TrDUA603cDezBqGR5DHgsdiFWYN0wl5HQa9CvP5jNpLxGKbE=';
const SHATTERED_2 =
  'JVBERi0xLjMKJeLjz9MKCgoxIDAgb2JqCjw8L1dpZHRoIDIgMCBSL0hlaWdodCAzIDAgUi9UeXBlIDQgMCBSL1N1YnR5cGUgNSAwIFIvRmlsdGVyIDYgMCBSL0NvbG9yU3BhY2UgNyAwIFIvTGVuZ3RoIDggMCBSL0JpdHNQZXJDb21wb25lbnQgOD4+CnN0cmVhbQr/2P/+ACRTSEEtMSBpcyBkZWFkISEhISGFL+wJIzl1nDmxocY8TJfh//4Bf0bck6a2fgE7ApqqHbJWC0XKZ9aIx/hLjEx5H+ArPfYU+G2xaQkBxWtFwVMK/t+3YDjpcnIv561yjw5JBOBGwjBXD+nUE5ir4S71vJQr4zVCpIAtmLXXDyozLsN/rDUU503cDyzBqHTNDHgwWiFWZGEwl4lga9C/P5jNqARGKaE=';

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

function hash(data: Uint8Array): { oid: string; collision: boolean } {
  const h = new Sha1Dc().reset().update(data);
  const oid = Buffer.from(h.digest()).toString('hex');
  return { oid, collision: h.collision };
}

describe('SHA-1DC collision detection', () => {
  it('flags both halves of the SHAttered collision without changing the SHA-1', () => {
    const one = bytes(SHATTERED_1);
    const two = bytes(SHATTERED_2);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    const a = hash(one);
    const b = hash(two);
    expect(a.oid).toBe(b.oid);
    expect(a.oid).toBe(createHash('sha1').update(one).digest('hex'));
    expect(a.collision).toBe(true);
    expect(b.collision).toBe(true);
  });

  it('does not flag the same bytes with one bit changed in a collision block', () => {
    const data = bytes(SHATTERED_1);
    data[200]! ^= 1;
    const h = hash(data);
    expect(h.collision).toBe(false);
    expect(h.oid).toBe(createHash('sha1').update(data).digest('hex'));
  });

  it('resets the verdict between objects', () => {
    const h = new Sha1Dc().reset().update(bytes(SHATTERED_1));
    h.digest();
    expect(h.collision).toBe(true);
    h.reset().update(new TextEncoder().encode('blob 6\0hello\n'));
    h.digest();
    expect(h.collision).toBe(false);
  });
});
