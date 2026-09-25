import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createAdminProjectDataStorageApp } from './helpers/admin-project-data-storage-route';

const base = '/api/admin/project-data/storage/message-upload-quarantine/project-1';

function makeEnv() {
  const stub = {
    ensureProjectId: vi.fn(async () => undefined),
    listMessageUploadQuarantine: vi.fn(async (_limit: number, _after: unknown) => ({
      uploads: [{ sessionId: 'session-1', messageId: 'message-1', status: 'abandoned' }],
      nextCursor: null,
    })),
    readMessageUploadQuarantine: vi.fn(async () => ({
      status: 'abandoned',
      fields: [{ field: 'content', part: 0, data: 'original bytes', sha256: 'digest' }],
    })),
  };
  const env = {
    PROJECT_DATA: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => stub) },
  } as unknown as Env;
  return { env, stub };
}

describe('admin message-upload quarantine', () => {
  it('rejects a non-superadmin before touching the root object', async () => {
    const { env, stub } = makeEnv();
    const response = await createAdminProjectDataStorageApp().request(base, {
      headers: { 'x-test-role': 'user' },
    }, env);
    expect(response.status).toBe(403);
    expect(stub.listMessageUploadQuarantine).not.toHaveBeenCalled();
  });

  it('provides bounded inventory and exact no-store readback to a superadmin', async () => {
    const { env, stub } = makeEnv();
    const app = createAdminProjectDataStorageApp();
    const cursor = JSON.stringify({ createdAt: 1234, sessionId: 's', messageId: 'm' });
    const list = await app.request(`${base}?limit=1&after=${encodeURIComponent(cursor)}`, {
      headers: { 'x-test-role': 'superadmin' },
    }, env);
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect(stub.listMessageUploadQuarantine).toHaveBeenCalledWith(1, JSON.parse(cursor));
    expect(await list.json()).toMatchObject({ uploads: [{ messageId: 'message-1' }] });

    const read = await app.request(`${base}/session-1/message-1`, {
      headers: { 'x-test-role': 'superadmin' },
    }, env);
    expect(read.status).toBe(200);
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(stub.readMessageUploadQuarantine).toHaveBeenCalledWith('session-1', 'message-1');
    expect(await read.json()).toMatchObject({ fields: [{ data: 'original bytes' }] });
  });
});
