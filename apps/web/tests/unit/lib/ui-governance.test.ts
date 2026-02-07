import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../../src/lib/api';
import {
  getActiveUiStandard,
  listComponentDefinitions,
  upsertUiStandard,
} from '../../../src/lib/ui-governance';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ui-governance api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the active UI standard with session credentials', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'std_01',
        version: 'v1.0',
        status: 'active',
        name: 'SAM Unified UI Standard',
        visualDirection: 'Green-forward',
        mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
        accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
        ownerRole: 'design-engineering-lead',
      })
    );

    const result = await getActiveUiStandard();

    expect(result.id).toBe('std_01');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/ui-governance/standards/active',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('adds query params when listing component definitions', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await listComponentDefinitions({ surface: 'agent-ui', status: 'ready' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/ui-governance/components?surface=agent-ui&status=ready',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('propagates API errors as ApiClientError', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'BAD_REQUEST',
          message: 'status is required',
        },
        400
      )
    );

    await expect(
      upsertUiStandard('v2.0', {
        status: 'review',
        name: 'SAM Unified UI Standard',
        visualDirection: 'Green-forward',
        mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
        accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
        ownerRole: 'design-engineering-lead',
      })
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('handles non-JSON failures with a safe fallback error', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response('server exploded', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    );

    await expect(getActiveUiStandard()).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'Request failed',
      status: 500,
    });
  });
});
