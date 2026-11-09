import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { createBuildContextUpload } from '../../../src/services/build-context-upload';
describe('real SDK context presigner', () => {
  it('signs nonempty upload without inventing empty-body checksums', async () => {
    const env = {
      CF_ACCOUNT_ID: 'fake-account',
      R2_ACCESS_KEY_ID: 'fake-access',
      R2_SECRET_ACCESS_KEY: 'fake-secret',
      R2_BUCKET_NAME: 'fake-bucket',
    } as Env;
    const slot = await createBuildContextUpload(
      env,
      {
        id: 'job',
        projectId: 'project',
        environmentId: 'env',
        workspaceId: 'ws',
        requestedBy: 'user',
        attempt: 3,
      },
      { sizeBytes: 123456, sha256: 'a'.repeat(64) },
      300
    );
    const url = new URL(slot.uploadUrl);
    expect(url.pathname).toContain('/compose-build-contexts/project/env/job/3.tar.zst');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    expect(url.searchParams.get('x-amz-meta-sha256')).toBe('a'.repeat(64));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  });
});
