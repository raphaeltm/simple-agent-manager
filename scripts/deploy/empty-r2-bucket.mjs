#!/usr/bin/env node
/**
 * Delete every object in one R2 bucket through the Cloudflare REST API, so a full teardown can
 * delete the bucket (R2 refuses to delete a non-empty bucket with HTTP 409).
 *
 * Bounded by a deadline, not a count (rule 81): it lists a page, deletes that page with limited
 * concurrency, and repeats until the bucket is empty or the deadline passes. At the API's
 * request rate (roughly 4 requests a second per token) the default 600 s empties about 2,000
 * objects; a larger bucket is reported and its deletion fails as before, and re-running the
 * teardown continues where this stopped.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_R2_EMPTY_DEADLINE_SECONDS = 600;
const PAGE_SIZE = 100;
const CONCURRENCY = 4;

async function cloudflare(fetchImpl, token, method, path) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (method === 'DELETE' && response.status === 404) return { success: true };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`${method} ${path.split('?')[0]} failed: ${message}`);
  }
  return body;
}

export async function emptyR2Bucket({
  accountId,
  bucket,
  token,
  deadlineMs,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!accountId || !bucket || !token) {
    throw new Error('CF_ACCOUNT_ID, BUCKET_NAME and CF_API_TOKEN are required.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error('BUCKET_NAME is not a valid R2 bucket name.');
  }
  const base = `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${bucket}/objects`;
  let deleted = 0;
  for (;;) {
    if (now() >= deadlineMs) return { deleted, empty: false };
    // Always read the first page: deleted keys drop out, so no cursor is needed.
    const page = await cloudflare(fetchImpl, token, 'GET', `${base}?per_page=${PAGE_SIZE}`);
    const keys = (page.result ?? []).map((object) => object.key).filter(Boolean);
    if (keys.length === 0) return { deleted, empty: true };
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      if (now() >= deadlineMs) return { deleted, empty: false };
      await Promise.all(
        keys
          .slice(i, i + CONCURRENCY)
          .map((key) =>
            cloudflare(fetchImpl, token, 'DELETE', `${base}/${encodeURIComponent(key)}`)
          )
      );
      deleted += Math.min(CONCURRENCY, keys.length - i);
    }
  }
}

async function main() {
  const seconds = Number.parseInt(process.env.R2_EMPTY_DEADLINE_SECONDS ?? '', 10);
  const budget =
    Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_R2_EMPTY_DEADLINE_SECONDS;
  const result = await emptyR2Bucket({
    accountId: process.env.CF_ACCOUNT_ID?.trim(),
    bucket: process.env.BUCKET_NAME?.trim(),
    token: process.env.CF_API_TOKEN?.trim(),
    deadlineMs: Date.now() + budget * 1000,
  });
  const status = result.empty ? 'emptied' : 'partial';
  console.log(`Bucket ${process.env.BUCKET_NAME}: ${result.deleted} object(s) deleted, ${status}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  if (!result.empty) {
    console.log(`::warning::Bucket not empty after ${budget}s; re-run the teardown to continue.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
