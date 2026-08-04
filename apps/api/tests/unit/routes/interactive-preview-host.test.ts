import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetFile = vi.hoisted(() => vi.fn());
const mockDownloadFile = vi.hoisted(() => vi.fn());
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/file-library', () => ({
  getFile: mockGetFile,
  downloadFile: mockDownloadFile,
  getDownloadTimeoutMs: () => 1000,
}));

import type { Env } from '../../../src/env';
import { handleInteractivePreviewRequest } from '../../../src/routes/interactive-preview-host';
import { mintPreviewPath } from '../../../src/services/interactive-preview';

const env = {
  BASE_DOMAIN: 'example.com',
  PREVIEW_SIGNING_KEY: 'test-preview-signing-secret',
  ENCRYPTION_KEY: 'test-encryption-key',
  DATABASE: {},
  R2: {},
} as Env;

describe('interactive preview host handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves scoped HTML with the strict sandbox headers and no cookie', async () => {
    const version = '2026-08-04T12:00:00.000Z';
    mockGetFile.mockResolvedValue({
      file: {
        id: 'file-a',
        projectId: 'project-a',
        filename: 'demo.html',
        mimeType: 'text/html',
        sizeBytes: 128,
        updatedAt: version,
      },
      tags: [],
    });
    mockDownloadFile.mockResolvedValue({
      data: new TextEncoder().encode('<button onclick="this.textContent=\'worked\'">Run</button>')
        .buffer,
    });
    const path = await mintPreviewPath(
      {
        projectId: 'project-a',
        fileId: 'file-a',
        version,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      env.PREVIEW_SIGNING_KEY!
    );
    const response = await handleInteractivePreviewRequest(
      new Request(`https://preview.example.com${path}`),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('onclick');
    expect(mockDownloadFile).toHaveBeenCalledWith(
      expect.anything(),
      env.R2,
      env.ENCRYPTION_KEY,
      'project-a',
      'file-a'
    );
  });

  it('fails closed when the signed version no longer matches the file', async () => {
    mockGetFile.mockResolvedValue({
      file: { filename: 'demo.html', mimeType: 'text/html', sizeBytes: 1, updatedAt: 'new' },
      tags: [],
    });
    const path = await mintPreviewPath(
      {
        projectId: 'project-a',
        fileId: 'file-a',
        version: 'old',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      env.PREVIEW_SIGNING_KEY!
    );
    const response = await handleInteractivePreviewRequest(
      new Request(`https://preview.example.com${path}`),
      env
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });
});
