/**
 * The library pass re-wraps a file's data key and writes the same body back. Two R2 preconditions
 * make that safe against a user replacing the file meanwhile (replaceFile writes the same key):
 *
 * - `get(key, { onlyIf: { etagMatches } })` returns no body when the object changed since the
 *   head, so the pass never pairs a new body with the old file's data key;
 * - `put(key, body, { onlyIf: { etagMatches } })` refuses to write over a newer object, so the
 *   user's replacement is never overwritten with the old body.
 *
 * On Cloudflare these are R2's documented semantics. On a self-hosted runtime the R2 binding is
 * the runtime's own implementation over an S3 store, so the pass checks them before it writes
 * anything and refuses to re-wrap when either is not honoured (review V1 M1 on #2705). The check
 * uses its own scratch object outside `library/` (a fresh name per check, so two overlapping pages
 * cannot interfere) and deletes it.
 *
 * Limit: it proves the store applies the preconditions, not that it applies them atomically with
 * the write. A store that checks the etag and then writes separately would pass and could still
 * lose a replace that lands in between. celld 0.6.3 is checked on the real runtime by
 * scripts/selfhost/live/key-rotation.live.test.ts.
 */

/** Outside `library/`, so no library listing ever returns a probe object. */
export const CONDITIONAL_PROBE_PREFIX = 'selfhost-key-rotation/conditional-write-probe-';

// Plain strings: every R2 implementation accepts them as a body.
const text = (value: string) => value;

/** Why conditional get/put cannot be relied on in this bucket, or null when both hold. */
export async function conditionalWriteProblem(bucket: R2Bucket): Promise<string | null> {
  const probeKey = `${CONDITIONAL_PROBE_PREFIX}${crypto.randomUUID()}`;
  try {
    const first = await bucket.put(probeKey, text('first'));
    const second = await bucket.put(probeKey, text('second'));
    if (!first || !second || first.etag === second.etag) {
      return 'an overwrite does not change the object etag';
    }
    const staleGet = await bucket.get(probeKey, {
      onlyIf: { etagMatches: first.etag },
    });
    if (staleGet && 'body' in staleGet) return 'get returned a body for a stale etagMatches';
    const stalePut = await bucket.put(probeKey, text('stale'), {
      onlyIf: { etagMatches: first.etag },
    });
    const kept = await bucket.get(probeKey);
    const body = kept && 'body' in kept ? await kept.text() : null;
    if (stalePut || body !== 'second') return 'put wrote over a newer object (stale etagMatches)';
    const matching = await bucket.put(probeKey, text('third'), {
      onlyIf: { etagMatches: second.etag },
    });
    if (!matching) return 'put refused a matching etagMatches';
    return null;
  } catch (error) {
    return `the check failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await bucket.delete(probeKey).catch(() => undefined);
  }
}
