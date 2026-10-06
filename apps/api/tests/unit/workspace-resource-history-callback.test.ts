import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { workspaceResourceHistoryCallbackRoute } from '../../src/routes/projects/workspace-resource-history-callback';
import { verifyCallbackToken } from '../../src/services/jwt';
import { storeWorkspaceResourceChunk } from '../../src/services/workspace-resource-history';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../src/services/workspace-resource-history', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/workspace-resource-history')>();
  return {
    ...actual,
    getWorkspaceResourceUploadMaxBytes: vi.fn(() => 1024),
    storeWorkspaceResourceChunk: vi.fn().mockResolvedValue({
      summaryId: 'summary-1',
      chunkId: 'chunk-1',
      r2Key: 'resource-history/v1/key',
      idempotent: false,
    }),
  };
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    sourceVersion: 1,
    chunkSequence: 0,
    startedAt: 1,
    endedAt: 2,
    sampleCount: 1,
    gapCount: 0,
    toolSpanCount: 0,
    compressedBase64: 'H4sI',
    compressedBytes: 3,
    uncompressedBytes: 12,
    sha256: 'a'.repeat(64),
    completeness: {},
    summary: {},
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects', workspaceResourceHistoryCallbackRoute);
  return app;
}

describe('workspace resource history callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
  });

  it('accepts a node-scoped callback token bound to body.nodeId', async () => {
    const response = await makeApp().request('/api/projects/proj-1/workspace-resource-history', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(200);
    expect(storeWorkspaceResourceChunk).toHaveBeenCalledWith(
      undefined,
      'proj-1',
      expect.objectContaining({ workspaceId: 'ws-1', nodeId: 'node-1' }),
      'node-1'
    );
  });

  it('rejects node-scoped tokens for a different node before storage', async () => {
    vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
      workspace: 'other-node',
      type: 'callback',
      scope: 'node',
    });

    const response = await makeApp().request('/api/projects/proj-1/workspace-resource-history', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(403);
    expect(storeWorkspaceResourceChunk).not.toHaveBeenCalled();
  });

  it('rejects workspace-scoped tokens for a different workspace before storage', async () => {
    vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
      workspace: 'other-workspace',
      type: 'callback',
      scope: 'workspace',
    });

    const response = await makeApp().request('/api/projects/proj-1/workspace-resource-history', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody({ nodeId: null })),
    });

    expect(response.status).toBe(403);
    expect(storeWorkspaceResourceChunk).not.toHaveBeenCalled();
  });

  it('rejects invalid upload shape before storage', async () => {
    const response = await makeApp().request('/api/projects/proj-1/workspace-resource-history', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody({ sha256: 'not-a-sha' })),
    });

    expect(response.status).toBe(400);
    expect(storeWorkspaceResourceChunk).not.toHaveBeenCalled();
  });
});
