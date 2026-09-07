import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildComposeImageArtifactKey,
  buildLocalImageRef,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '../../../src/services/compose-image-artifacts';

const VALID_DESCRIPTOR = {
  serviceName: 'web',
  sourceRef: 'workspace-web',
  localImageRef: 'workspace-web',
  r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
  sizeBytes: 42,
  archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  archiveType: 'docker-save',
  mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
};

describe('compose image artifacts', () => {
  it('builds server-derived R2 keys and local image refs', () => {
    expect(buildComposeImageArtifactKey('proj-1', 'ws-1', 'env-1', 'upload-1', 'web/API')).toBe(
      'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web_API.docker-save.tar'
    );
    expect(buildLocalImageRef('env-1', 'rel-1', 'web/API')).toBe('sam-env-1-web-api:rel-1');
  });

  it('accepts descriptors only within the expected project/environment/workspace scope', () => {
    expect(validateComposeImageArtifactDescriptor(VALID_DESCRIPTOR, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      environmentId: 'env-1',
      maxBytes: 100,
    })).toMatchObject(VALID_DESCRIPTOR);

    expect(() => validateComposeImageArtifactDescriptor({
      ...VALID_DESCRIPTOR,
      r2Key: 'compose-image-artifacts/proj-1/env-1/ws-other/upload-1/web.docker-save.tar',
    }, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      environmentId: 'env-1',
      maxBytes: 100,
    })).toThrow(/workspace scope/);
  });

  it('rejects oversized artifacts before upload completion', () => {
    expect(() => validateComposeImageArtifactDescriptor({
      ...VALID_DESCRIPTOR,
      sizeBytes: 101,
    }, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      environmentId: 'env-1',
      maxBytes: 100,
    })).toThrow(/exceeds maximum/);
  });

  it('checks completed artifact object sizes in R2', async () => {
    const r2 = {
      head: vi.fn(async () => ({ size: 42 })),
    };
    await expect(validateCompletedComposeImageArtifacts(
      { R2: r2 } as unknown as Env,
      [VALID_DESCRIPTOR]
    )).resolves.toBeUndefined();
    expect(r2.head).toHaveBeenCalledWith(VALID_DESCRIPTOR.r2Key);

    r2.head.mockResolvedValueOnce({ size: 41 });
    await expect(validateCompletedComposeImageArtifacts(
      { R2: r2 } as unknown as Env,
      [VALID_DESCRIPTOR]
    )).rejects.toThrow(/size mismatch/);
  });
});
