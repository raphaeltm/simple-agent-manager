/**
 * Tests for Shannon security assessment HIGH/CRITICAL vulnerability fixes.
 *
 * Each describe block corresponds to a specific finding from the assessment.
 * Tests verify that exploit payloads are rejected by the fixes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { projectsRoutes } from '../../../src/routes/projects';

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  encrypt: vi.fn(),
  getAcpSession: vi.fn(),
  updateAcpSessionHeartbeat: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  requireSuperadmin: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: { id: 'user-1', role: 'superadmin', status: 'active', email: 'test@test.com', name: 'Test', avatarUrl: null },
    session: { id: 'sess-1', expiresAt: new Date() },
  }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: mocks.encrypt,
}));
// project-data.ts uses named exports imported as `import * as projectDataService`
vi.mock('../../../src/services/project-data', () => ({
  getAcpSession: mocks.getAcpSession,
  updateAcpSessionHeartbeat: mocks.updateAcpSessionHeartbeat,
  createAcpSession: vi.fn(),
  transitionAcpSession: vi.fn(),
  listAcpSessions: vi.fn(),
  forkAcpSession: vi.fn(),
  getAcpSessionLineage: vi.fn(),
}));

describe('Shannon Security Fixes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;
  let limitResponses: any[];
  let orderByResponses: any[];
  const mockEnv = {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'test-key',
    KV: {} as any,
    PROJECT_DATA: {} as any,
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    orderByResponses = [];

    const queryBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
      orderBy: vi.fn(() => Promise.resolve(orderByResponses.shift() ?? [])),
    };

    mockDB = {
      select: vi.fn().mockReturnValue(queryBuilder),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };

    (drizzle as any).mockReturnValue(mockDB);

    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      installationId: 'inst-1',
      repository: 'acme/repo',
      defaultBranch: 'main',
    });
    mocks.encrypt.mockResolvedValue({ ciphertext: 'enc-value', iv: 'enc-iv' });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectsRoutes);
  });

  // ---- INJ-VULN-03: Arbitrary File Write via Runtime Files API ----

  describe('INJ-VULN-03: Runtime file path restrictions', () => {
    const postFile = (path: string) =>
      app.request('/api/projects/proj-1/runtime/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: 'test content', isSecret: false }),
      }, mockEnv);

    it('allows /etc/cron.d/ paths (devcontainer sandbox)', async () => {
      orderByResponses.push([], []);
      const res = await postFile('/etc/cron.d/backdoor');
      // Absolute paths are now allowed since files are injected into sandboxed devcontainers
      expect(res.status).not.toBe(400);
    });

    it('allows /etc/profile.d/ paths (devcontainer sandbox)', async () => {
      orderByResponses.push([], []);
      const res = await postFile('/etc/profile.d/backdoor.sh');
      expect(res.status).not.toBe(400);
    });

    it('allows /usr/ paths (devcontainer sandbox)', async () => {
      orderByResponses.push([], []);
      const res = await postFile('/usr/local/bin/evil');
      expect(res.status).not.toBe(400);
    });

    it('allows /var/ paths (devcontainer sandbox)', async () => {
      orderByResponses.push([], []);
      const res = await postFile('/var/spool/cron/root');
      expect(res.status).not.toBe(400);
    });

    it('rejects ~/.ssh/authorized_keys (SSH key injection)', async () => {
      const res = await postFile('~/.ssh/authorized_keys');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('not allowed for security reasons');
    });

    it('rejects ~/.ssh/authorized_keys2', async () => {
      const res = await postFile('~/.ssh/authorized_keys2');
      expect(res.status).toBe(400);
    });

    it('rejects ~/.ssh/rc', async () => {
      const res = await postFile('~/.ssh/rc');
      expect(res.status).toBe(400);
    });

    it('allows /home/node/ paths', async () => {
      // Set up orderByResponses for the response builder
      orderByResponses.push([], []);
      const res = await postFile('/home/node/.npmrc');
      // Should not be 400 (path validation passed)
      expect(res.status).not.toBe(400);
    });

    it('allows relative paths', async () => {
      orderByResponses.push([], []);
      const res = await postFile('.env.local');
      expect(res.status).not.toBe(400);
    });

    it('allows safe ~ paths like ~/.ssh/config', async () => {
      orderByResponses.push([], []);
      const res = await postFile('~/.ssh/config');
      expect(res.status).not.toBe(400);
    });

    it('allows ~/.npmrc', async () => {
      orderByResponses.push([], []);
      const res = await postFile('~/.npmrc');
      expect(res.status).not.toBe(400);
    });
  });

  // ---- AUTH-VULN-05: ACP Session Heartbeat Bypass ----

  describe('AUTH-VULN-05: ACP heartbeat node verification', () => {
    it('rejects heartbeat with mismatched nodeId', async () => {
      mocks.getAcpSession.mockResolvedValue({
        id: 'session-1',
        nodeId: 'real-node-id',
        projectId: 'proj-1',
        status: 'running',
      });

      const res = await app.request(
        '/api/projects/proj-1/acp-sessions/session-1/heartbeat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'attacker-node-id' }),
        },
        mockEnv,
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.message).toContain('Node identity verification failed');
    });

    it('returns 404 for non-existent session', async () => {
      mocks.getAcpSession.mockResolvedValue(null);

      const res = await app.request(
        '/api/projects/proj-1/acp-sessions/fake-session/heartbeat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'some-node' }),
        },
        mockEnv,
      );

      expect(res.status).toBe(404);
    });

    it('allows heartbeat with correct nodeId', async () => {
      mocks.getAcpSession.mockResolvedValue({
        id: 'session-1',
        nodeId: 'correct-node',
        projectId: 'proj-1',
        status: 'running',
      });
      mocks.updateAcpSessionHeartbeat.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/projects/proj-1/acp-sessions/session-1/heartbeat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'correct-node' }),
        },
        mockEnv,
      );

      expect(res.status).toBe(204);
    });
  });
});
