/** Signed preview entry point must retain whole-file memory through HTTP consumption. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const download = vi.hoisted(() => vi.fn());
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/services/file-library', () => ({
  getFile: async () => ({
    file: { filename: 'demo.html', mimeType: 'text/html', sizeBytes: 12, updatedAt: 'version' },
  }),
  downloadFile: download,
  getDownloadTimeoutMs: () => 1000,
}));

import type { Env } from '../../../src/env';
import { handleInteractivePreviewRequest } from '../../../src/routes/interactive-preview-host';
import { mintPreviewPath } from '../../../src/services/interactive-preview';
import { acquireLibraryMemory } from '../../../src/services/library-memory';

const env = {
  DATABASE: {},
  R2: {},
  BASE_DOMAIN: 'example.test',
  ENCRYPTION_KEY: 'test-only',
  PREVIEW_SIGNING_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

async function preview(method = 'GET') {
  const path = await mintPreviewPath(
    {
      projectId: 'project',
      fileId: 'file',
      version: 'version',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    },
    env.PREVIEW_SIGNING_KEY!
  );
  return handleInteractivePreviewRequest(
    new Request(`https://preview.example.test${path}`, { method }),
    env
  );
}

describe('signed Library preview memory ownership', () => {
  it.each(['consume', 'cancel', 'HEAD'])('releases only at the %s boundary', async (boundary) => {
    const data = new TextEncoder().encode('<p>hello</p>').buffer;
    download.mockResolvedValueOnce({ data });
    const response = await preview(boundary === 'HEAD' ? 'HEAD' : 'GET');
    expect(response.status).toBe(200);
    expect(download).toHaveBeenCalledOnce();
    if (boundary === 'HEAD') {
      expect(response.body).toBeNull();
    } else {
      try {
        expect(data.byteLength).toBeGreaterThan(0);
        expect(() => acquireLibraryMemory()).toThrow();
        if (boundary === 'consume') expect(await response.text()).toBe('<p>hello</p>');
      } finally {
        if (!response.bodyUsed) await response.body?.cancel();
      }
    }
    expect(data.byteLength).toBe(0);
    acquireLibraryMemory()();
  });

  it('refuses an overlapping signed request before decrypting', async () => {
    const release = acquireLibraryMemory();
    try {
      expect((await preview()).status).toBe(403);
      expect(download).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
