import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateUpCloudCredentialWithProvider } from '../../../src/services/validation';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('UpCloud credential validation', () => {
  it('encodes UTF-8 Basic credentials without exposing them in the result', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ account: {} }), { status: 200 })
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await validateUpCloudCredentialWithProvider('api-user', 'sëcret', {
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ valid: true, message: 'UpCloud credential validated.' });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const expectedBytes = new TextEncoder().encode('api-user:sëcret');
    let expectedBinary = '';
    for (const byte of expectedBytes) expectedBinary += String.fromCharCode(byte);
    expect(headers.Authorization).toBe('Basic ' + btoa(expectedBinary));
    expect(JSON.stringify(result)).not.toContain('sëcret');
  });
});
