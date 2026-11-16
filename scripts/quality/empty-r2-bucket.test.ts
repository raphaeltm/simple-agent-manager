import { describe, expect, it } from 'vitest';

import { emptyR2Bucket } from '../deploy/empty-r2-bucket.mjs';

/** A fake R2 bucket behind the Cloudflare REST API: list returns up to per_page keys. */
function fakeBucket(count: number, options: { failDeleteOf?: string; missing?: string } = {}) {
  const keys = new Set(Array.from({ length: count }, (_, i) => `agents/obj-${i}`));
  let requests = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    requests++;
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'GET') {
      const perPage = Number(u.searchParams.get('per_page'));
      const result = [...keys].slice(0, perPage).map((key) => ({ key }));
      return Response.json({ success: true, result });
    }
    const key = decodeURIComponent(u.pathname.split('/objects/')[1]);
    if (key === options.failDeleteOf) {
      return Response.json({ success: false, errors: [{ message: 'nope' }] }, { status: 500 });
    }
    if (key === options.missing) {
      keys.delete(key);
      return new Response('', { status: 404 });
    }
    keys.delete(key);
    return Response.json({ success: true, result: null });
  }) as unknown as typeof fetch;
  return { keys, fetchImpl, requests: () => requests };
}

const base = { accountId: 'acct', bucket: 'sam2-staging2-assets', token: 't' };

describe('emptyR2Bucket', () => {
  it('empties a bucket larger than one listing page in a single run', async () => {
    const bucket = fakeBucket(2 * 100 + 37);
    const result = await emptyR2Bucket({
      ...base,
      deadlineMs: Date.now() + 60_000,
      fetchImpl: bucket.fetchImpl,
    });
    expect(result).toEqual({ deleted: 237, empty: true });
    expect(bucket.keys.size).toBe(0);
  });

  it('treats an object deleted meanwhile (404) as gone', async () => {
    const bucket = fakeBucket(3, { missing: 'agents/obj-1' });
    expect(
      await emptyR2Bucket({ ...base, deadlineMs: Date.now() + 60_000, fetchImpl: bucket.fetchImpl })
    ).toMatchObject({ empty: true });
  });

  it('stops at the deadline and reports a partial result', async () => {
    const bucket = fakeBucket(50);
    let t = 0;
    const result = await emptyR2Bucket({
      ...base,
      deadlineMs: 3,
      fetchImpl: bucket.fetchImpl,
      now: () => t++,
    });
    expect(result.empty).toBe(false);
    expect(bucket.keys.size).toBeGreaterThan(0);
  });

  it('fails on an API error rather than looping', async () => {
    const bucket = fakeBucket(3, { failDeleteOf: 'agents/obj-0' });
    await expect(
      emptyR2Bucket({ ...base, deadlineMs: Date.now() + 60_000, fetchImpl: bucket.fetchImpl })
    ).rejects.toThrow(/nope/);
  });

  it.each(['', 'Bad_Name', '../x', 'a'])('rejects bucket name %j', async (bucket) => {
    await expect(
      emptyR2Bucket({
        ...base,
        bucket,
        deadlineMs: Date.now() + 1000,
        fetchImpl: fakeBucket(0).fetchImpl,
      })
    ).rejects.toThrow();
  });
});
