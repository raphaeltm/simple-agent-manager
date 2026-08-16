import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS,
  generateSessionSnapshotDirectUploadUrl,
  sessionSnapshotDirectUploadAvailable,
} from '../../../src/services/session-snapshot-direct-upload';

describe('session snapshot direct uploads', () => {
  const env = {
    CF_ACCOUNT_ID: 'account-id',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key',
    R2_BUCKET_NAME: 'snapshot-bucket',
  } as Env;

  it('requires the complete R2 S3 credential set', () => {
    expect(sessionSnapshotDirectUploadAvailable(env)).toBe(true);
    expect(sessionSnapshotDirectUploadAvailable({ ...env, R2_BUCKET_NAME: undefined })).toBe(false);
  });

  it('keeps checksum query-hoisted by default for old direct-upload agents', async () => {
    const uploadUrl = await generateSessionSnapshotDirectUploadUrl(env, {
      key: 'session-snapshots/chat/generation/home.tar',
      sizeBytes: 140_000_000,
      sha256: '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942',
      contentType: 'application/x-tar',
    });
    const url = new URL(uploadUrl);

    expect(url.hostname).toBe('snapshot-bucket.account-id.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/session-snapshots/chat/generation/home.tar');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(
      String(DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS)
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('x-amz-checksum-sha256')).toBe(
      'TqFAWIFQdzzjqs54au739ASc4QD6ZJyU+73blg8dqUI='
    );
  });

  it('signs the checksum as an unhoisted header for agents that send the checksum header', async () => {
    const uploadUrl = await generateSessionSnapshotDirectUploadUrl(env, {
      key: 'session-snapshots/chat/generation/home.tar',
      sizeBytes: 140_000_000,
      sha256: '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942',
      contentType: 'application/x-tar',
      checksumHeader: true,
    });
    const url = new URL(uploadUrl);

    expect(url.searchParams.has('x-amz-checksum-sha256')).toBe(false);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-checksum-sha256');
  });
});
