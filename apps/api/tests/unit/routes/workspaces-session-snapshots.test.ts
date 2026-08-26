import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { createRouteTestApp } from './route-test-app';

const mocks = vi.hoisted(() => ({
  completeSessionSnapshot: vi.fn(),
  ensureSessionSnapshotUploadRelay: vi.fn(),
  generateSessionSnapshotDirectUploadUrl: vi.fn(),
  getRestorableSessionSnapshot: vi.fn(),
  prepareSessionSnapshot: vi.fn(),
  recordSessionSnapshotArtifactAuthorization: vi.fn(),
  recordSessionSnapshotCaptureFailure: vi.fn(),
  recordSessionSnapshotProgress: vi.fn(),
  recordSessionSnapshotRestoreResult: vi.fn(),
  resolveSessionSnapshotUploadTargets: vi.fn(),
  sessionSnapshotDirectUploadAvailable: vi.fn(),
  verifyCallbackToken: vi.fn(),
  verifySessionSnapshotRelayAuthorization: vi.fn(),
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
    recordSessionSnapshotArtifactAuthorization: mocks.recordSessionSnapshotArtifactAuthorization,
    recordSessionSnapshotCaptureFailure: mocks.recordSessionSnapshotCaptureFailure,
    recordSessionSnapshotProgress: mocks.recordSessionSnapshotProgress,
    recordSessionSnapshotRestoreResult: mocks.recordSessionSnapshotRestoreResult,
  };
});
vi.mock('../../../src/services/session-snapshot-direct-upload', () => ({
  generateSessionSnapshotDirectUploadUrl: mocks.generateSessionSnapshotDirectUploadUrl,
  sessionSnapshotDirectUploadAvailable: mocks.sessionSnapshotDirectUploadAvailable,
}));
vi.mock('../../../src/services/session-snapshot-upload-relay', () => ({
  ensureSessionSnapshotUploadRelay: mocks.ensureSessionSnapshotUploadRelay,
  resolveSessionSnapshotUploadTargets: mocks.resolveSessionSnapshotUploadTargets,
  SESSION_SNAPSHOT_RELAY_AUTHORIZATION_HEADER: 'X-SAM-Relay-Authorization',
  SESSION_SNAPSHOT_RELAY_NODE_ID_HEADER: 'X-SAM-Relay-Node-ID',
  verifySessionSnapshotRelayAuthorization: mocks.verifySessionSnapshotRelayAuthorization,
}));

function makeDb(
  workspace: Record<string, unknown>,
  authorization: Record<string, unknown> | null = {
    generation: 'generation-1',
    authorizedHomeBytes: 4,
    authorizedHomeSha256: HOME_SHA256,
    authorizedWipBytes: 3,
    authorizedWipSha256: WIP_SHA256,
  }
) {
  return {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => {
        const isWorkspaceGuard = !!selection && Object.hasOwn(selection, 'nodeStatus');
        const query = {
          leftJoin: vi.fn(() => query),
          where: vi.fn(() => ({
            limit: vi.fn(async () => [workspace]),
            get: vi.fn(async () => (isWorkspaceGuard ? workspace : authorization)),
          })),
        };
        return query;
      }),
    })),
  };
}

const HOME_SHA256 = '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942';
const WIP_SHA256 = '32e4caaf6344aea2380a7f150312f351897e2dc23de446b4e9c418298d1cbc97';

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)).buffer;
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
    status: 'running',
    nodeStatus: 'running',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (drizzle as any).mockReturnValue(makeDb(workspace));
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'WS_1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.sessionSnapshotDirectUploadAvailable.mockReturnValue(true);
    mocks.generateSessionSnapshotDirectUploadUrl.mockResolvedValue(
      'https://account.r2.cloudflarestorage.com/test-snapshots/upload'
    );
    mocks.verifySessionSnapshotRelayAuthorization.mockResolvedValue(undefined);
    mocks.recordSessionSnapshotArtifactAuthorization.mockResolvedValue(true);
    mocks.recordSessionSnapshotCaptureFailure.mockResolvedValue(true);
    mocks.recordSessionSnapshotProgress.mockResolvedValue(true);
    mocks.resolveSessionSnapshotUploadTargets.mockImplementation(
      async (_env: Env, input: { directUploadSupported: boolean }) => ({
        upload: input.directUploadSupported
          ? {
              home: '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-1',
              wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip?chatSessionId=chat-1&generation=generation-1',
            }
          : {
              home: 'https://relay.example.test/legacy-home',
              wip: 'https://relay.example.test/legacy-wip',
            },
        directUpload: {
          home: '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=generation-1',
          wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip/upload-url?chatSessionId=chat-1&generation=generation-1',
        },
        needsRelayProvisioning: false,
      })
    );
    mocks.prepareSessionSnapshot.mockResolvedValue({
      snapshotId: 'snapshot-1',
      generation: 'generation-1',
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
        home: 'test-snapshots/chat-1/generation-1/home.tar',
        wip: 'test-snapshots/chat-1/generation-1/wip.bundle',
        manifest: 'test-snapshots/chat-1/generation-1/manifest.json',
      },
    });

    app = createRouteTestApp('/api/workspaces', workspacesRoutes);
  });

  it('routes a legacy agent upload through a current same-user relay', async () => {
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
      generation: 'generation-1',
      upload: {
        home: 'https://relay.example.test/legacy-home',
        wip: 'https://relay.example.test/legacy-wip',
      },
      directUpload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=generation-1',
        wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip/upload-url?chatSessionId=chat-1&generation=generation-1',
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
    expect(mocks.resolveSessionSnapshotUploadTargets).toHaveBeenCalledWith(
      runtimeBindings,
      expect.objectContaining({ userId: 'user-1', directUploadSupported: false })
    );
  });

  it('returns 410 and does not prepare a snapshot when the callback workspace is stopped', async () => {
    (drizzle as any).mockReturnValue(makeDb({ ...workspace, status: 'stopped' }));

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

    expect(res.status).toBe(410);
    expect(mocks.prepareSessionSnapshot).not.toHaveBeenCalled();
  });

  it('does not provision a relay when the agent advertises direct uploads', async () => {
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
          runtime: 'vm',
          directUploadSupported: true,
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      upload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-1',
      },
      directUpload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=generation-1',
      },
    });
    expect(mocks.resolveSessionSnapshotUploadTargets).toHaveBeenCalledWith(
      runtimeBindings,
      expect.objectContaining({ directUploadSupported: true })
    );
    expect(mocks.ensureSessionSnapshotUploadRelay).not.toHaveBeenCalled();
  });

  it('records vm-agent snapshot progress for the current capture generation', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/progress',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          generation: 'generation-1',
          step: 'home-walk',
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(204);
    expect(mocks.recordSessionSnapshotProgress).toHaveBeenCalledWith(expect.anything(), {
      chatSessionId: 'chat-1',
      generation: 'generation-1',
    });
  });

  it('rejects snapshot progress for a stale capture generation', async () => {
    mocks.recordSessionSnapshotProgress.mockResolvedValueOnce(false);
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/progress',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          generation: 'generation-old',
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(409);
  });

  it('records vm-agent snapshot failure for the current capture generation', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/failure',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          generation: 'generation-1',
          error: 'snapshot control plane returned HTTP 400: checksum mismatch',
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(204);
    expect(mocks.recordSessionSnapshotCaptureFailure).toHaveBeenCalledWith(
      expect.anything(),
      runtimeBindings,
      {
        chatSessionId: 'chat-1',
        generation: 'generation-1',
        error: 'snapshot control plane returned HTTP 400: checksum mismatch',
      }
    );
  });

  it('rejects snapshot failure for a stale capture generation', async () => {
    mocks.recordSessionSnapshotCaptureFailure.mockResolvedValueOnce(false);
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/failure',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          generation: 'generation-old',
          error: 'capture failed',
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(409);
  });

  it('offloads one relay replacement when a legacy node has no current peer', async () => {
    mocks.resolveSessionSnapshotUploadTargets.mockResolvedValueOnce({
      upload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home',
        wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip',
      },
      directUpload: {
        home: '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url',
        wip: '/api/workspaces/WS_1/session-snapshot/artifacts/wip/upload-url',
      },
      needsRelayProvisioning: true,
    });
    mocks.ensureSessionSnapshotUploadRelay.mockResolvedValue(undefined);
    const waits: Promise<unknown>[] = [];
    const request = new Request(
      'https://api.example.test/api/workspaces/WS_1/session-snapshot/prepare',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chatSessionId: 'chat-1', runtime: 'vm' }),
      }
    );

    const res = await app.fetch(request, runtimeBindings, {
      waitUntil: (promise) => waits.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(mocks.ensureSessionSnapshotUploadRelay).toHaveBeenCalledWith(runtimeBindings, {
      userId: 'user-1',
      sourceNodeId: 'node-1',
      projectId: 'project-1',
    });
    expect(waits).toHaveLength(1);
  });

  it('authorizes a checksum-bound direct R2 upload for the current capture', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=generation-1',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sizeBytes: 777, sha256: HOME_SHA256, checksumHeader: true }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      uploadUrl: 'https://account.r2.cloudflarestorage.com/test-snapshots/upload',
    });
    expect(mocks.generateSessionSnapshotDirectUploadUrl).toHaveBeenCalledWith(runtimeBindings, {
      key: 'test-snapshots/chat-1/generation-1/home.tar',
      sizeBytes: 777,
      sha256: HOME_SHA256,
      contentType: 'application/x-tar',
      checksumHeader: true,
    });
    expect(mocks.recordSessionSnapshotArtifactAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      {
        chatSessionId: 'chat-1',
        generation: 'generation-1',
        artifact: 'home',
        sizeBytes: 777,
        sha256: HOME_SHA256,
      }
    );
    expect(mocks.verifySessionSnapshotRelayAuthorization).toHaveBeenCalledWith(
      runtimeBindings,
      'user-1',
      undefined,
      undefined
    );
  });

  it('verifies the current relay node independently from the workspace bearer', async () => {
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=generation-1',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer workspace-token',
          'Content-Type': 'application/json',
          'X-SAM-Relay-Node-ID': 'relay-node',
          'X-SAM-Relay-Authorization': 'Bearer relay-node-token',
        },
        body: JSON.stringify({ sizeBytes: 777, sha256: HOME_SHA256 }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    expect(mocks.verifySessionSnapshotRelayAuthorization).toHaveBeenCalledWith(
      runtimeBindings,
      'user-1',
      'relay-node',
      'Bearer relay-node-token'
    );
  });

  it('uploads artifacts to server-derived R2 keys and rejects oversized content-lengths', async () => {
    const ok = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-1',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Type': 'application/octet-stream',
          'Content-Length': '4',
          'X-SAM-Content-SHA256': HOME_SHA256,
        },
        body: 'home',
      },
      runtimeBindings
    );

    expect(ok.status).toBe(200);
    expect(r2.put).toHaveBeenCalledWith(
      'test-snapshots/chat-1/generation-1/home.tar',
      expect.anything(),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/x-tar' },
        sha256: HOME_SHA256,
      })
    );

    const tooLarge = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/wip?chatSessionId=chat-1&generation=generation-1',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Length': '1025',
          'X-SAM-Content-SHA256': WIP_SHA256,
        },
        body: 'wip',
      },
      runtimeBindings
    );
    expect(tooLarge.status).toBe(400);

    const staleGeneration = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-old',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer callback-token',
          'Content-Length': '4',
          'X-SAM-Content-SHA256': HOME_SHA256,
        },
        body: 'home',
      },
      runtimeBindings
    );
    expect(staleGeneration.status).toBe(409);

    const missingHash = await app.request(
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-1',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer callback-token', 'Content-Length': '4' },
        body: 'home',
      },
      runtimeBindings
    );
    expect(missingHash.status).toBe(400);
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
      '/api/workspaces/WS_1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=generation-1',
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
      key.endsWith('home.tar')
        ? { size: 4, checksums: { sha256: checksumBytes(HOME_SHA256) } }
        : key.endsWith('wip.bundle')
          ? { size: 3, checksums: { sha256: checksumBytes(WIP_SHA256) } }
          : null
    );
    const body = {
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      generation: 'generation-1',
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
        artifacts: {
          home: { sizeBytes: 4, sha256: HOME_SHA256 },
          wip: { sizeBytes: 3, sha256: WIP_SHA256 },
        },
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

    for (const degradation of [
      'wip-skipped',
      'entries-skipped',
      'agent-context-skipped',
    ] as const) {
      const degraded = await app.request(
        '/api/workspaces/WS_1/session-snapshot/complete',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...body,
            status: 'degraded',
            degradation,
            manifest: { ...body.manifest, status: 'degraded', degradation },
          }),
        },
        runtimeBindings
      );
      expect(degraded.status, degradation).toBe(200);
    }

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

    const checksumMismatch = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          manifest: {
            ...body.manifest,
            artifacts: {
              ...body.manifest.artifacts,
              home: { sizeBytes: 4, sha256: WIP_SHA256 },
            },
          },
        }),
      },
      runtimeBindings
    );
    expect(checksumMismatch.status).toBe(400);

    const lifecycleMismatch = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          status: 'degraded',
          degradation: 'entries-skipped',
        }),
      },
      runtimeBindings
    );
    expect(lifecycleMismatch.status).toBe(400);
  });

  it('accepts direct-upload artifacts with absent R2 checksum when authorization matches', async () => {
    r2.head.mockImplementation(async (key: string) =>
      key.endsWith('home.tar') ? { size: 4, checksums: {} } : null
    );
    const body = {
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      generation: 'generation-1',
      runtime: 'vm',
      status: 'available',
      degradation: 'none',
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
        artifacts: {
          home: { sizeBytes: 4, sha256: HOME_SHA256 },
        },
        createdAt: '2026-08-16T00:00:00.000Z',
      },
    };

    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    expect(mocks.completeSessionSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      runtimeBindings,
      expect.objectContaining({
        artifactSizes: { homeBytes: 4 },
        artifactSha256: { homeSha256: HOME_SHA256 },
      })
    );
  });

  it('rejects absent R2 checksum distinctly when no authorization was recorded', async () => {
    (drizzle as any).mockReturnValueOnce(
      makeDb(workspace, {
        generation: 'generation-1',
        authorizedHomeBytes: null,
        authorizedHomeSha256: null,
      })
    );
    r2.head.mockImplementation(async (key: string) =>
      key.endsWith('home.tar') ? { size: 4, checksums: {} } : null
    );
    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatSessionId: 'chat-1',
          agentSessionId: 'agent-session-1',
          generation: 'generation-1',
          runtime: 'vm',
          status: 'available',
          degradation: 'none',
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
            artifacts: {
              home: { sizeBytes: 4, sha256: HOME_SHA256 },
            },
            createdAt: '2026-08-16T00:00:00.000Z',
          },
        }),
      },
      runtimeBindings
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      message:
        'Snapshot home SHA-256 is absent from upload and no authorized checksum was recorded',
    });
    expect(mocks.completeSessionSnapshot).not.toHaveBeenCalled();
  });

  it('normalizes only generated OpenCode symlink omissions after checksum verification', async () => {
    r2.head.mockImplementation(async (key: string) => ({
      size: key.endsWith('home.tar') ? 4 : 3,
      checksums: {
        sha256: checksumBytes(key.endsWith('home.tar') ? HOME_SHA256 : WIP_SHA256),
      },
    }));
    const body = {
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      generation: 'generation-1',
      runtime: 'vm',
      status: 'degraded',
      degradation: 'entries-skipped',
      baseCommit: 'abc123',
      manifest: {
        version: 1,
        chatSessionId: 'chat-1',
        workspaceId: 'WS_1',
        agentSessionId: 'agent-session-1',
        acpSessionId: 'acp-session-1',
        agentType: 'opencode',
        status: 'degraded',
        degradation: 'entries-skipped',
        skipped: [
          {
            path: '~/.config/opencode/node_modules/.bin/yaml',
            reason: 'unsupported home entry type',
            sizeBytes: 15,
          },
        ],
        artifacts: {
          home: { sizeBytes: 4, sha256: HOME_SHA256 },
          wip: { sizeBytes: 3, sha256: WIP_SHA256 },
        },
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    };

    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      runtimeBindings
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'available', degradation: 'none' });
    expect(mocks.completeSessionSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      runtimeBindings,
      expect.objectContaining({
        status: 'available',
        degradation: 'none',
        manifest: expect.objectContaining({
          status: 'available',
          degradation: 'none',
          skipped: [],
        }),
      })
    );

    r2.head.mockClear();
    mocks.completeSessionSnapshot.mockClear();
    const unrelatedSkip = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          manifest: {
            ...body.manifest,
            skipped: [{ path: '~/.ssh/id_ed25519', reason: 'unsupported home entry type' }],
          },
        }),
      },
      runtimeBindings
    );
    expect(unrelatedSkip.status).toBe(200);
    expect(mocks.completeSessionSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      runtimeBindings,
      expect.objectContaining({ status: 'degraded', degradation: 'entries-skipped' })
    );
  });

  it('rejects a manifest missing a required field with a clean 400 before touching R2', async () => {
    const body = {
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-session-1',
      generation: 'generation-1',
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
        // `skipped` intentionally omitted — required by SessionSnapshotManifest
        artifacts: {
          home: { sizeBytes: 4, sha256: HOME_SHA256 },
          wip: { sizeBytes: 3, sha256: WIP_SHA256 },
        },
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    };

    const res = await app.request(
      '/api/workspaces/WS_1/session-snapshot/complete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      runtimeBindings
    );

    expect(res.status).toBe(400);
    expect(r2.head).not.toHaveBeenCalled();
    expect(mocks.completeSessionSnapshot).not.toHaveBeenCalled();
  });
});
