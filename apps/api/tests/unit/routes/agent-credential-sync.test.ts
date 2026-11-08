/**
 * Behavioral tests for the POST /workspaces/:id/agent-credential-sync endpoint.
 *
 * The full workspaces router is mounted (so callback-vs-session auth ordering is
 * exercised) over a real SQLite engine with real encryption. Pin-aware selection
 * (project and profile pins, account identity) is covered end to end in
 * `tests/integration/codex-run-credential-refresh.test.ts`.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { decrypt, encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'test-user-id',
  getAuth: () => ({ userId: 'test-user-id' }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-123', type: 'callback', scope: 'workspace' }),
  signCallbackToken: vi.fn(),
}));

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const codexAuth = (generation: number) =>
  JSON.stringify({
    tokens: { access_token: `jwt-${generation}`, refresh_token: `rt-${generation}` },
  });

describe('POST /workspaces/:id/agent-credential-sync', () => {
  let app: Hono<{ Bindings: Env }>;
  let sqlite: Database.Database;
  let env: Env;

  const validBody = {
    agentType: 'openai-codex',
    credentialKind: 'oauth-token',
    credential: codexAuth(2),
  };

  function postSync(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  async function seedLegacy(
    id: string,
    plaintext: string,
    opts: { projectId?: string | null; active?: boolean } = {}
  ) {
    const { ciphertext, iv } = await encrypt(plaintext, ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type,
           credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
         VALUES (?, 'user-1', ?, 'openai-codex', 'agent-api-key', 'openai-codex', 'oauth-token', ?, ?, ?, 'old', 'old')`
      )
      .run(id, opts.projectId ?? null, opts.active === false ? 0 : 1, ciphertext, iv);
  }

  async function secretOf(id: string): Promise<string> {
    const row = sqlite
      .prepare(`SELECT encrypted_token AS t, iv FROM credentials WHERE id = ?`)
      .get(id) as { t: string; iv: string };
    return decrypt(row.t, row.iv, ENCRYPTION_KEY);
  }

  function seedWorkspace(opts: { status?: string; projectId?: string | null } = {}) {
    sqlite
      .prepare(`INSERT INTO nodes (id, user_id, status) VALUES ('node-1', 'user-1', 'running')`)
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, user_id, node_id, project_id, status)
         VALUES ('ws-123', 'user-1', 'node-1', ?, ?)`
      )
      .run(opts.projectId ?? null, opts.status ?? 'running');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY,
      JWT_PUBLIC_KEY: 'test-public-key',
    } as unknown as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json(
          { error: appError.error, message: appError.message },
          appError.statusCode as 400 | 401 | 403 | 404 | 410 | 500
        );
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/workspaces', workspacesRoutes);
  });

  afterEach(() => sqlite.close());

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
        },
        body: 'not-json',
      },
      env
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('valid JSON');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await postSync({ agentType: 'openai-codex' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('credential');
  });

  it('returns 400 for invalid agentType', async () => {
    const res = await postSync({ ...validBody, agentType: 'bad-agent' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid agentType');
  });

  it('returns 400 for invalid credentialKind', async () => {
    const res = await postSync({ ...validBody, credentialKind: 'bad-kind' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('credentialKind');
  });

  it('returns 410 when callback workspace resource does not exist', async () => {
    const res = await postSync(validBody);
    expect(res.status).toBe(410);
  });

  it('returns 410 when callback workspace is stopped', async () => {
    seedWorkspace({ status: 'stopped' });
    await seedLegacy('cred-user', codexAuth(1));

    const res = await postSync(validBody);
    expect(res.status).toBe(410);
    expect(await secretOf('cred-user')).toBe(codexAuth(1));
  });

  it('returns credential_not_found when no matching credential exists', async () => {
    seedWorkspace();

    const res = await postSync(validBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, reason: 'credential_not_found' });
  });

  it('returns updated:false when credential is unchanged', async () => {
    seedWorkspace();
    await seedLegacy('cred-user', codexAuth(2));

    const res = await postSync(validBody);
    expect(await res.json()).toEqual({ success: true, updated: false });
  });

  it('re-encrypts into the same row and returns updated:true when credential has changed', async () => {
    seedWorkspace();
    await seedLegacy('cred-user', codexAuth(1));

    const res = await postSync(validBody);
    expect(await res.json()).toEqual({ success: true, updated: true });
    expect(await secretOf('cred-user')).toBe(codexAuth(2));
  });

  it('does not fall back to user-scoped credential when a project-scoped row exists but is inactive', async () => {
    seedWorkspace({ projectId: 'proj-1' });
    await seedLegacy('cred-project', codexAuth(1), { projectId: 'proj-1', active: false });
    await seedLegacy('cred-user', codexAuth(1));

    const res = await postSync(validBody);
    expect(await res.json()).toEqual({ success: false, reason: 'credential_not_found' });
    expect(await secretOf('cred-user')).toBe(codexAuth(1));
    expect(await secretOf('cred-project')).toBe(codexAuth(1));
  });

  it('falls back to user-scoped credential when the workspace project has no project-scoped row', async () => {
    seedWorkspace({ projectId: 'proj-1' });
    await seedLegacy('cred-user', codexAuth(1));

    const res = await postSync(validBody);
    expect(await res.json()).toEqual({ success: true, updated: true });
    expect(await secretOf('cred-user')).toBe(codexAuth(2));
  });

  it('rejects oversized payloads', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
          'Content-Length': '100000',
        },
        body: JSON.stringify(validBody),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Payload exceeds');
  });
});
