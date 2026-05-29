import { describe, expect, it } from 'vitest';

import { getCliDownloadUrl } from '../../../src/lib/api/cli';

describe('getCliDownloadUrl', () => {
  it('builds a download URL with os and arch params', () => {
    const url = getCliDownloadUrl('darwin', 'arm64');
    expect(url).toContain('/api/cli/download');
    expect(url).toContain('os=darwin');
    expect(url).toContain('arch=arm64');
  });

  it('encodes special characters in params', () => {
    const url = getCliDownloadUrl('linux', 'amd64');
    expect(url).toContain('os=linux');
    expect(url).toContain('arch=amd64');
  });

  it('uses the API_URL prefix', () => {
    const url = getCliDownloadUrl('linux', 'arm64');
    // In test env, API_URL defaults to http://localhost:8787
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('/api/cli/download?os=linux&arch=arm64');
  });
});
