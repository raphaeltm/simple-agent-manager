import { describe, expect, it } from 'vitest';

import {
  getInteractivePreviewHeaders,
  getPreviewHostname,
  interactivePreviewErrorResponse,
  mintPreviewPath,
  verifyPreviewPath,
} from '../../../src/services/interactive-preview';

const SECRET = 'test-preview-secret-with-enough-entropy';
const SCOPE = {
  projectId: 'project-a',
  fileId: 'file-a',
  version: '2026-08-04T12:00:00.000Z',
  expiresAt: 2_000_000_000,
};

describe('interactive preview signed paths', () => {
  it('accepts the exact signed project, file, version, and expiry scope', async () => {
    const path = await mintPreviewPath(SCOPE, SECRET);
    await expect(verifyPreviewPath(path, SECRET, SCOPE.expiresAt - 1)).resolves.toEqual(SCOPE);
  });

  it('rejects expired, tampered, and scope-mismatched paths', async () => {
    const path = await mintPreviewPath(SCOPE, SECRET);
    await expect(verifyPreviewPath(path, SECRET, SCOPE.expiresAt)).resolves.toBeNull();
    await expect(
      verifyPreviewPath(path.replace('index.html', 'other.html'), SECRET, 1)
    ).resolves.toBeNull();
    const otherScopePath = await mintPreviewPath({ ...SCOPE, projectId: 'project-b' }, SECRET);
    const stolenSignature = path.split('/').at(-2)!;
    const scopeMismatch = otherScopePath.replace(
      otherScopePath.split('/').at(-2)!,
      stolenSignature
    );
    await expect(verifyPreviewPath(scopeMismatch, SECRET, 1)).resolves.toBeNull();
  });

  it('derives a single-level hostname and honors the full hostname override', () => {
    expect(getPreviewHostname({ BASE_DOMAIN: 'example.com' })).toBe('preview.example.com');
    expect(
      getPreviewHostname({
        BASE_DOMAIN: 'example.com',
        PREVIEW_BASE_DOMAIN: 'usercontent.example.net',
      })
    ).toBe('usercontent.example.net');
  });
});

describe('interactive preview response policy', () => {
  it('sets the exact strict headers and never sets a cookie', () => {
    const headers = getInteractivePreviewHeaders({ BASE_DOMAIN: 'example.com' });
    expect(headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://app.example.com"
    );
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.has('set-cookie')).toBe(false);
    expect(headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });

  it('applies the CSP sandbox and all strict headers to friendly errors', async () => {
    const response = interactivePreviewErrorResponse({ BASE_DOMAIN: 'example.com' });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('Preview link expired');
  });
});
