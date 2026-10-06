import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

// The real Sandbox SDK is not available under Miniflare/vitest (see the
// pre-existing admin-sandbox-routes.test.ts guard-only tests), so the whole
// services/sandbox module is replaced here with hoisted mocks. This lets the
// tests exercise the real route/jsonValidator/handler code while stubbing
// only the SDK boundary.
const sandboxMocks = vi.hoisted(() => ({
  getSandboxConfig: vi.fn(),
  requireSandbox: vi.fn(),
  getSandboxInstance: vi.fn(),
}));

vi.mock('../../../src/services/sandbox', () => sandboxMocks);

const { adminSandboxRoutes } = await import('../../../src/routes/admin-sandbox');

describe('admin sandbox routes', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let fakeSandbox: {
    exec: ReturnType<typeof vi.fn>;
    gitCheckout: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    createBackup: ReturnType<typeof vi.fn>;
    restoreBackup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // assertNotCredentialSetupSandbox queries agent_credential_setup_sessions
    // directly; materialize the whole schema so that raw SQL succeeds.
    createAllSchemaTables(sqlite, schema);

    fakeSandbox = {
      exec: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, success: true }),
      gitCheckout: vi.fn().mockResolvedValue({}),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue({ content: 'file-contents' }),
      exists: vi.fn().mockResolvedValue({ exists: true }),
      createBackup: vi.fn().mockResolvedValue({ id: 'backup-1', dir: '/workspace' }),
      restoreBackup: vi.fn().mockResolvedValue({ success: true }),
    };

    sandboxMocks.getSandboxConfig.mockReturnValue({
      enabled: true,
      execTimeoutMs: 30_000,
      gitTimeoutMs: 120_000,
      sleepAfter: '10m',
    });
    sandboxMocks.requireSandbox.mockImplementation(() => undefined);
    sandboxMocks.getSandboxInstance.mockResolvedValue(fakeSandbox);

    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin/sandbox', adminSandboxRoutes);
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  function bindings(): Env {
    return { DATABASE: createSqliteD1(sqlite) } as Env;
  }

  describe('POST /exec', () => {
    it('accepts a valid command and executes it', async () => {
      const res = await app.request(
        '/api/admin/sandbox/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'ls -la' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { stdout: string; sandboxId: string };
      expect(body.stdout).toBe('ok');
      expect(body.sandboxId).toBe('sam-prototype');
      expect(fakeSandbox.exec).toHaveBeenCalledWith('ls -la', { timeout: 30_000 });
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/sandbox/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
      expect(fakeSandbox.exec).not.toHaveBeenCalled();
    });

    it('preserves the handler-produced message when command is missing', async () => {
      const res = await app.request(
        '/api/admin/sandbox/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('command is required and must be a string');
    });

    it('preserves the handler-produced message when command is the wrong type', async () => {
      const res = await app.request(
        '/api/admin/sandbox/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 42 }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('command is required and must be a string');
    });

    it('defaults sandboxId to sam-prototype when omitted (unchanged edge case)', async () => {
      const res = await app.request(
        '/api/admin/sandbox/exec',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'echo hi' }),
        },
        bindings()
      );

      const body = (await res.json()) as { sandboxId: string };
      expect(body.sandboxId).toBe('sam-prototype');
    });
  });

  describe('POST /git-checkout', () => {
    it('accepts a valid repoUrl and clones it', async () => {
      const res = await app.request(
        '/api/admin/sandbox/git-checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoUrl: 'https://github.com/org/repo',
            branch: 'main',
            depth: 1,
          }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.gitCheckout).toHaveBeenCalledWith('https://github.com/org/repo', {
        branch: 'main',
        targetDir: '/workspace',
        depth: 1,
      });
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/sandbox/git-checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
    });

    it('preserves the handler-produced message when repoUrl is missing', async () => {
      const res = await app.request(
        '/api/admin/sandbox/git-checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('repoUrl is required and must be a string');
    });

    it('defaults depth to 1 when omitted (unchanged edge case)', async () => {
      const res = await app.request(
        '/api/admin/sandbox/git-checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl: 'https://github.com/org/repo' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.gitCheckout).toHaveBeenCalledWith('https://github.com/org/repo', {
        branch: undefined,
        targetDir: '/workspace',
        depth: 1,
      });
    });
  });

  describe('POST /files', () => {
    it('writes a file for a valid write action', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', path: '/tmp/x.txt', content: 'hello' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.writeFile).toHaveBeenCalledWith('/tmp/x.txt', 'hello');
    });

    it('reads a file for a valid read action', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', path: '/tmp/x.txt' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string };
      expect(body.content).toBe('file-contents');
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
    });

    it('preserves the handler-produced message when path is missing', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read' }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('action and path are required');
    });

    it('preserves the handler-produced message when content is missing for write', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write', path: '/tmp/x.txt' }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('content is required for write action');
    });

    it('falls through to the catch-all message for any non-matching action, including non-string values (unchanged edge case)', async () => {
      const res = await app.request(
        '/api/admin/sandbox/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 5, path: '/tmp/x.txt' }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('action must be read, write, or exists');
    });
  });

  describe('POST /backup', () => {
    it('creates a backup for a valid create action', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', dir: '/workspace' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.createBackup).toHaveBeenCalledWith({
        dir: '/workspace',
        name: 'sam-prototype-backup',
      });
    });

    it('restores a backup for a valid restore action', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'restore',
            backupId: 'backup-1',
            backupDir: '/workspace',
          }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.restoreBackup).toHaveBeenCalledWith({
        id: 'backup-1',
        dir: '/workspace',
      });
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
    });

    it('preserves the handler-produced message when action is missing', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('action is required');
    });

    it('preserves the handler-produced message when backupId is missing for restore', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore' }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('backupId is required for restore action');
    });

    it('defaults dir to /workspace when omitted for create (unchanged edge case)', async () => {
      const res = await app.request(
        '/api/admin/sandbox/backup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create' }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      expect(fakeSandbox.createBackup).toHaveBeenCalledWith({
        dir: '/workspace',
        name: 'sam-prototype-backup',
      });
    });
  });
});
