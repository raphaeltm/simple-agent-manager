import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { createRouteTestApp } from './route-test-app';

const mocks = vi.hoisted(() => ({
  completeSessionSnapshot: vi.fn(),
  getRestorableSessionSnapshot: vi.fn(),
  prepareSessionSnapshot: vi.fn(),
  recordSessionSnapshotRestoreResult: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({ user: { id: 'user-1', name: 'User', email: 'user@example.com' } }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.verifyCallbackToken,
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/session-snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/session-snapshots')>();
  return {
    ...actual,
    completeSessionSnapshot: mocks.completeSessionSnapshot,
    getRestorableSessionSnapshot: mocks.getRestorableSessionSnapshot,
    prepareSessionSnapshot: mocks.prepareSessionSnapshot,
    recordSessionSnapshotRestoreResult: mocks.recordSessionSnapshotRestoreResult,
  };
});

function makeDb(workspace: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [workspace]),
        })),
      })),
    })),
  };
}

describe('workspaces session snapshot callback routes', () => {
  let app: Hono<{ Bindings: Env }>;
  const r2 = {
    put: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
  };
  const runtimeBindings = {
    DATABASE: {} as any,
    R2: r2,
    ENCRYPTION_KEY: 'enc-key',
    SESSION_SNAPSHOT_R2_PREFIX: 'test-snapshots',
    SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES: '1024',
  } as unknown as Env;
  const workspace = {
    id: 'WS_1',
    nodeId: 'node-1',
    projectId: 'project-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (drizzle as any).mockReturnValue(makeDb(workspace));
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'WS_1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.prepareSessionSnapshot.mockResolvedValue({
      snapshotId: 'snapshot-1',
      expiresAt: '2026-07-18T00:00:00.000Z',
      config: {
        ttlDays: 7,
        totalBudgetBytes: 1024,
        entryThresholdBytes: 512,
        transferIdleTimeoutMs: 30000,
        jsonBodyMaxBytes: 262144,
        r2Prefix: 'test-snapshots',
      },
      keys: {
        home: 'test-snapshots/chat-1/home.tar',
        wip: 'test-snapshots/chat-1/wip.bundle',
        manifest: 'test-snapshots/chat-1/manifest.json',
      },
    });

    app = createRouteTestApp('/api/workspaces', workspacesRoutes);
  });

  it('prepares deterministic upload URLs for the workspace chat session', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/prepare',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          agentSessionId: 'agent-session-1',
          runtime: 'cf-container',
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      snapshotId: 'snapshot-1',
      upload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1',
        wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip?chatSessionId=chat-1',
      },
    });
    expect(mocks.prepareSessionSnapshot).toHaveBeenCalledWith(expect.anything(), runtimeBindings, {
      workspaceId: 'WS_1',
      nodeId: 'node-1',
      projectId: 'project-1',
      userId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      runtime: 'cf-container',
    });
  });

  it('uploads artifacts to server-derived R2 keys and rejects oversized content-lengths', async () => {
    const ok = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/octet-stream',
          'Content-Length': '4',
        },
        body: 'home',
      },
      runtimeBindings
    );

    expect(ok.status).toBe(200);
    expect(r2.put).toHaveBeenCalledWith(
      'test-snapshots/chat-1/home.tar',
      expect.anything(),
      expect.objectContaining({ httpMetadata: { contentType: 'application/x-tar' } })
    );

    const tooLarge = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/wip?chatSessionId=chat-1',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Length': '1025',
        },
        body: 'wip',
      },
      runtimeBindings
    );
    expect(tooLarge.status).toBe(400);
  });

  it('rejects node-scoped callback tokens before snapshot service access', async () => {
    mocks.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'WS_1',
      type: 'callback',
      scope: 'node',
    });

    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/prepare',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chatSessionId: 'chat-1' }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(403);
    expect(mocks.prepareSessionSnapshot).not.toHaveBeenCalled();
  });

  it('rejects artifact uploads without an authoritative Content-Length', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer callback-token' },
        body: 'home',
      },
      runtimeBindings
    );
    expect(res.status).toBe(400);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('derives completion sizes from R2 and rejects manifest identity mismatches', async () => {
    r2.head.mockImplementation(async (key: string) =>
      key.endsWith('home.tar') ? { size: 4 } : key.endsWith('wip.bundle') ? { size: 3 } : null
    );
    const body = {
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      runtime: 'cf-container',
      status: 'available',
      degradation: 'none',
      baseCommit: 'abc123',
      artifactSizes: { homeBytes: 999, wipBytes: 999 },
      manifest: {
        version: 1,
        chatSessionId: 'chat-1',
        workspaceId: 'WS_1',
        agentSessionId: 'agent-session-1',
        acpSessionId: 'acp-session-1',
        agentType: 'openai-codex',
        status: 'available',
        degradation: 'none',
        skipped: [],
        artifacts: { home: { sizeBytes: 4 }, wip: { sizeBytes: 3 } },
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    };
    const ok = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      runtimeBindings
    );
    expect(ok.status).toBe(200);
    expect(mocks.completeSessionSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      runtimeBindings,
      expect.objectContaining({ artifactSizes: { homeBytes: 4, wipBytes: 3 } })
    );

    const mismatch = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, manifest: { ...body.manifest, workspaceId: 'WS_OTHER' } }),
      },
      runtimeBindings
    );
    expect(mismatch.status).toBe(400);

    const sessionMismatch = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          manifest: { ...body.manifest, agentSessionId: 'agent-session-other' },
        }),
      },
      runtimeBindings
    );
    expect(sessionMismatch.status).toBe(400);

    const incompleteHarness = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          manifest: { ...body.manifest, agentType: undefined },
        }),
      },
      runtimeBindings
    );
    expect(incompleteHarness.status).toBe(400);
  });
});
