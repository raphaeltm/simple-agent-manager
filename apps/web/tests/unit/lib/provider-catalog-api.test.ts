import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../../../src/lib/api/client', () => ({
  request: mocks.request,
}));

import { getProviderCatalog } from '../../../src/lib/api/providers';

describe('provider catalog API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockResolvedValue({ catalogs: [] });
  });

  it('requests the unscoped catalog by default', async () => {
    await getProviderCatalog();

    expect(mocks.request).toHaveBeenCalledWith('/api/providers/catalog');
  });

  it('passes user, installation, and project scopes as query parameters', async () => {
    await getProviderCatalog({ scope: 'user' });
    await getProviderCatalog({ scope: 'installation' });
    await getProviderCatalog({ scope: 'project', projectId: 'project 1/with/slash' });

    expect(mocks.request).toHaveBeenNthCalledWith(1, '/api/providers/catalog?scope=user');
    expect(mocks.request).toHaveBeenNthCalledWith(
      2,
      '/api/providers/catalog?scope=installation'
    );
    expect(mocks.request).toHaveBeenNthCalledWith(
      3,
      '/api/providers/catalog?scope=project&projectId=project+1%2Fwith%2Fslash'
    );
  });
});
