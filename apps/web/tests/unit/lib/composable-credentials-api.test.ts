import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../../../src/lib/api/client', () => ({
  request: mocks.request,
}));

import {
  deleteCCAttachment,
  deleteCCConfiguration,
  deleteCCCredential,
  updateCCCredential,
} from '../../../src/lib/api/composable-credentials';

describe('composable credentials API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockResolvedValue({ success: true });
  });

  it('URL-encodes raw primitive IDs before placing them in path params', async () => {
    const migratedId = 'cred-user-cipher/with+path=chars:iv/part';

    await deleteCCCredential(migratedId);
    await updateCCCredential(migratedId, { isActive: false });
    await deleteCCConfiguration(migratedId);
    await deleteCCAttachment(migratedId);

    const encoded = encodeURIComponent(migratedId);
    expect(mocks.request).toHaveBeenNthCalledWith(1, `/api/cc/credentials/${encoded}`, {
      method: 'DELETE',
    });
    expect(mocks.request).toHaveBeenNthCalledWith(2, `/api/cc/credentials/${encoded}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(mocks.request).toHaveBeenNthCalledWith(3, `/api/cc/configurations/${encoded}`, {
      method: 'DELETE',
    });
    expect(mocks.request).toHaveBeenNthCalledWith(4, `/api/cc/attachments/${encoded}`, {
      method: 'DELETE',
    });
  });
});
