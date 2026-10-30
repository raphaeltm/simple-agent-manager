import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runClaudeSetupToken } from '../../../scripts/claude-setup-token.mjs';
import type { Env } from '../../../src/env';
import { agentCredentialSetupSessionsRoutes } from '../../../src/routes/agent-credential-setup-sessions';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));

vi.mock('../../../src/services/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/sandbox')>();
  return {
    ...actual,
    getSandboxInstance: vi.fn(),
    destroySandboxInstance: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../../src/services/setup-session-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/setup-session-pool')>();
  return {
    ...actual,
    leaseSetupSlot: vi.fn().mockResolvedValue({ granted: true, leaseId: 'lease-project' }),
    releaseSetupSlot: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../../src/services/agent-credential-save', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/agent-credential-save')>();
  return { ...actual, saveAgentCredentialForUser: vi.fn() };
});

const { CredentialSetupSession } =
  await import('../../../src/durable-objects/credential-setup-session');
const { getSandboxInstance } = await import('../../../src/services/sandbox');
const { saveAgentCredentialForUser } = await import('../../../src/services/agent-credential-save');

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'owner-user',
}));

afterEach(() => vi.unstubAllEnvs());

function setupDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    `CREATE TABLE agent_credential_setup_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      scope TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      credential_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      pool_lease_id TEXT,
      expires_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  return sqlite;
}

function createDoContext() {
  let row: Record<string, unknown> | undefined;
  let details: Record<string, unknown> | undefined;
  const sql = {
    exec: vi.fn((query: string, ...args: unknown[]) => {
      const normalized = query.trim().toLowerCase();
      if (normalized.startsWith('create table')) return { toArray: () => [] };
      if (normalized.includes('insert or replace into setup_session')) {
        const [
          id,
          userId,
          projectId,
          scope,
          agentType,
          credentialKind,
          provider,
          agentName,
          poolLeaseId,
          codexHome,
          expiresAt,
          capturePollMs,
        ] = args;
        row = {
          id,
          user_id: userId,
          project_id: projectId,
          scope,
          agent_type: agentType,
          credential_kind: credentialKind,
          provider,
          agent_name: agentName,
          status: 'provisioning',
          pool_lease_id: poolLeaseId,
          codex_home: codexHome,
          expires_at: expiresAt,
          capture_poll_ms: capturePollMs,
          error_code: null,
          error_message: null,
          completed_at: null,
        };
      } else if (normalized.includes('insert or replace into device_auth_details')) {
        details = { verification_url: args[0], user_code: args[1] };
      } else if (normalized.includes('delete from device_auth_details')) {
        details = undefined;
      } else if (normalized.includes('update setup_session') && row) {
        row = {
          ...row,
          status: args[0],
          error_code: args[1] ?? null,
          error_message: args[2] ?? null,
          completed_at: args[3] ?? row.completed_at,
        };
      }
      if (normalized.includes('select * from setup_session')) {
        return { toArray: () => (row ? [{ ...row }] : []) };
      }
      if (normalized.includes('select verification_url, user_code')) {
        return { toArray: () => (details ? [{ ...details }] : []) };
      }
      return { toArray: () => [] };
    }),
  };
  return {
    storage: {
      sql,
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    },
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<unknown>) => callback()),
  };
}

describe('native Codex setup route vertical slice', () => {
  it('carries owned D1 session state through the DO boundary without persisting device details', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token',
          'waiting_for_user', ?, 'lease-1', ?, ?, ?)`
      )
      .run(
        'session-1',
        'owner-user',
        'session-1',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );

    const getState = vi.fn().mockResolvedValue({
      id: 'session-1',
      status: 'waiting_for_user',
      expiresAt: Date.now() + 60_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-1' })),
        get: vi.fn(() => ({ getState })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: 'not_found' }, status as 404 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request('/api/agent-credential-setup-sessions/session-1', {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'session-1',
      status: 'waiting_for_user',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    expect(getState).toHaveBeenCalledOnce();
    const persisted = sqlite
      .prepare('SELECT * FROM agent_credential_setup_sessions WHERE id = ?')
      .get('session-1') as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain('auth.openai.com');
    expect(JSON.stringify(persisted)).not.toContain('ABCD-EFGH');
  });

  it('does not cross the DO boundary for a session owned by another user', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token',
          'waiting_for_user', ?, 'lease-2', ?, ?, ?)`
      )
      .run(
        'session-other',
        'other-user',
        'session-other',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );
    const getState = vi.fn();
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-other' })),
        get: vi.fn(() => ({ getState })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: 'not_found' }, status as 404 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request(
      '/api/agent-credential-setup-sessions/session-other',
      {},
      env
    );

    expect(response.status).toBe(404);
    expect(env.CREDENTIAL_SETUP_SESSION.idFromName).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it.each(['completed', 'process_exited', 'code_rejected'])(
    'runs route → DO → driver → %s without leaking credentials',
    async (outcome) => {
      const sqlite = setupDatabase();
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'claude-code', 'oauth-token',
          'waiting_for_user', ?, 'lease-claude', ?, ?, ?)`
        )
        .run(
          'session-claude',
          'owner-user',
          'session-claude',
          new Date(Date.now() + 60_000).toISOString(),
          now,
          now
        );

      const code = 'abc123#state456';
      const token = `sk-ant-oat${'V'.repeat(48)}`;
      const home = '/tmp/claude-route-vertical';
      vi.stubEnv('CLAUDE_CONFIG_DIR', home);
      const files = new Map<string, string>();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
      });
      const writes: string[] = [];
      child.stdin.on('data', (chunk) => writes.push(chunk.toString()));
      const ready = runClaudeSetupToken({
        statePath: `${home}/device-auth-state.json`,
        credentialPath: `${home}/claude-oauth-token.txt`,
        verificationCodePath: `${home}/verification-code.txt`,
        spawnProcess: () => child,
        writeState: async (state) => {
          files.set(`${home}/device-auth-state.json`, JSON.stringify(state));
        },
        writeCredential: async (value) => {
          files.set(`${home}/claude-oauth-token.txt`, value);
        },
        readVerificationCode: async (path) => {
          if (!files.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
          return files.get(path)!;
        },
        deleteVerificationCode: async (path) => {
          files.delete(path);
        },
        verificationCodePollMs: 1,
        verificationEnterDelayMs: 1,
      });
      child.stdout.write(
        'Open https://claude.com/cai/oauth/authorize?client_id=test&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge&code_challenge_method=S256&state=state456\n'
      );
      await ready;
      const sandbox = {
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: vi.fn(async (path: string, value: string) => {
          files.set(path, value);
        }),
        exists: vi.fn(async (path: string) => ({ exists: files.has(path) })),
        readFile: vi.fn(async (path: string) => ({ content: files.get(path) ?? '' })),
      };
      vi.mocked(saveAgentCredentialForUser).mockClear();
      vi.mocked(getSandboxInstance).mockResolvedValue(sandbox as never);
      vi.mocked(saveAgentCredentialForUser).mockResolvedValue({
        created: true,
        createdAt: now,
        updatedAt: now,
      });
      const env = {
        DATABASE: createSqliteD1(sqlite),
        KV: { get: vi.fn().mockResolvedValue(null) },
      } as unknown as Env;
      const setupSession = new CredentialSetupSession(createDoContext() as never, env);
      await Promise.resolve();
      await setupSession.create({
        id: 'session-claude',
        userId: 'owner-user',
        projectId: null,
        scope: 'user',
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        provider: 'anthropic',
        agentName: 'Claude Code',
        poolLeaseId: 'lease-claude',
        setupHome: '/tmp/claude-route-vertical',
        ttlMs: 60_000,
        capturePollMs: 10,
      });
      await setupSession.alarm();
      await setupSession.alarm();
      Object.assign(env, {
        CREDENTIAL_SETUP_SESSION: {
          idFromName: vi.fn(() => ({ toString: () => 'do-session-claude' })),
          get: vi.fn(() => setupSession),
        },
      });
      const app = new Hono<{ Bindings: Env }>();
      app.onError((error, c) => {
        const status = 'statusCode' in error ? Number(error.statusCode) : 500;
        return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
      });
      app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

      const response = await app.request(
        '/api/agent-credential-setup-sessions/session-claude/verification-code',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: ` abc123 #state456\n` }),
        },
        env
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: 'session-claude',
        status: 'exchanging',
        agentType: 'claude-code',
      });
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        '/tmp/claude-route-vertical/verification-code.txt',
        code
      );
      const persisted = sqlite
        .prepare('SELECT * FROM agent_credential_setup_sessions WHERE id = ?')
        .get('session-claude') as Record<string, unknown>;
      expect(JSON.stringify(persisted)).not.toContain(code);

      await vi.waitFor(() => expect(writes).toEqual([code, '\r']));
      if (outcome === 'code_rejected')
        child.stdout.write('OAuth error: Request failed with status code 400\n');
      child.emit('exit', outcome === 'completed' ? 0 : 1, null);
      if (outcome === 'completed') child.stdout.write(`Your token: ${token}`);
      child.emit('close');
      await vi.waitFor(() =>
        expect(JSON.parse(files.get(`${home}/device-auth-state.json`)!).status).toBe(
          outcome === 'completed' ? 'completed' : 'failed'
        )
      );
      await setupSession.alarm();
      if (outcome === 'completed') {
        expect(saveAgentCredentialForUser).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'owner-user',
            agentType: 'claude-code',
            credential: token,
          })
        );
      } else expect(saveAgentCredentialForUser).not.toHaveBeenCalled();
      const completedResponse = await app.request(
        '/api/agent-credential-setup-sessions/session-claude',
        {},
        env
      );
      expect(completedResponse.status).toBe(200);
      const result = await completedResponse.json();
      expect(result).toMatchObject(
        outcome === 'completed' ? { status: 'completed' } : { status: 'failed', errorCode: outcome }
      );
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain(token);
      const finalRow = sqlite
        .prepare('SELECT * FROM agent_credential_setup_sessions WHERE id = ?')
        .get('session-claude');
      expect(JSON.stringify(finalRow)).not.toContain(code);
      expect(JSON.stringify(finalRow)).not.toContain(token);
    }
  );

  it.each(
    (['claude-code', 'openai-codex'] as const).flatMap((agentType) =>
      (['allowed', 'revoked', 'deleted'] as const).map((permission) => ({ agentType, permission }))
    )
  )(
    'captures $agentType only with current project permission ($permission)',
    async ({ agentType, permission }) => {
      const sqlite = new Database(':memory:');
      const migrations = new URL('../../../src/db/migrations/', import.meta.url);
      for (const name of readdirSync(migrations)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
      }
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec(`INSERT INTO users (id, github_id, email, name, created_at, updated_at) VALUES ('owner-user','github-owner','owner@test.com','Owner',0,0);
        INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,created_by,created_at,updated_at) VALUES ('project-a','owner-user','Project','project','installation','org/repo','owner-user','now','now');
        INSERT INTO project_members (project_id,user_id,role,status,created_at,updated_at) VALUES ('project-a','owner-user','owner','active','now','now');`);
      const encryptionKey = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';
      const env = {
        DATABASE: createSqliteD1(sqlite),
        ENCRYPTION_KEY: encryptionKey,
        KV: { get: vi.fn().mockResolvedValue(null) },
      } as unknown as Env;
      const actual = await vi.importActual<
        typeof import('../../../src/services/agent-credential-save')
      >('../../../src/services/agent-credential-save');
      const credential = (label: string) =>
        agentType === 'claude-code'
          ? `sk-ant-oat${label.repeat(48)}`
          : JSON.stringify({
              tokens: { access_token: label, refresh_token: label, account_id: label },
            });
      const metadata = {
        env,
        userId: 'owner-user',
        agentType,
        credentialKind: 'oauth-token' as const,
        provider: agentType === 'claude-code' ? 'anthropic' : 'openai',
        agentName: agentType,
        autoActivate: true,
      };
      await actual.saveAgentCredentialForUser({ ...metadata, credential: credential('P') });
      const personalBefore = sqlite
        .prepare('SELECT * FROM credentials WHERE project_id IS NULL')
        .all();
      const personalAttachmentBefore = sqlite
        .prepare('SELECT * FROM cc_attachments WHERE project_id IS NULL')
        .all();
      vi.mocked(saveAgentCredentialForUser).mockImplementation(actual.saveAgentCredentialForUser);
      const files = new Map<string, string>();
      const sandbox = {
        writeFile: vi.fn(async (path: string, content: string) => {
          files.set(path, content);
        }),
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        exists: vi.fn(async (path: string) => ({ exists: files.has(path) })),
        readFile: vi.fn(async (path: string) => ({ content: files.get(path) ?? '' })),
      };
      vi.mocked(getSandboxInstance).mockResolvedValue(sandbox as never);
      const session = new CredentialSetupSession(createDoContext() as never, env);
      await Promise.resolve();
      Object.assign(env, {
        SANDBOX: {},
        SETUP_SESSION_POOL: {},
        CREDENTIAL_SETUP_SESSION: { idFromName: vi.fn((id) => id), get: vi.fn(() => session) },
      });
      const app = new Hono<{ Bindings: Env }>();
      app.onError((error, c) => c.json({ error: error.message }, 500));
      app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
      const response = await app.request(
        '/api/agent-credential-setup-sessions/project',
        {
          method: 'POST',
          body: JSON.stringify({ agentType, projectId: 'project-a' }),
        },
        env
      );
      expect(response.status).toBe(201);
      const created = (await response.json()) as { id: string };
      const home = `/root/.${agentType === 'claude-code' ? 'claude' : 'codex'}-setup-${created.id}`;
      await session.alarm();
      files.set(`${home}/device-auth-state.json`, JSON.stringify({ status: 'completed' }));
      files.set(
        `${home}/${agentType === 'claude-code' ? 'claude-oauth-token.txt' : 'auth.json'}`,
        credential('Q')
      );
      if (permission === 'revoked')
        sqlite.exec("UPDATE project_members SET role='viewer' WHERE project_id='project-a'");
      if (permission === 'deleted') sqlite.exec("DELETE FROM projects WHERE id='project-a'");
      await session.alarm();
      if (permission !== 'allowed') {
        expect(await session.getState()).toMatchObject({
          status: 'failed',
          errorCode: 'capture_save_failed',
        });
        expect(
          sqlite.prepare('SELECT * FROM credentials WHERE project_id IS NOT NULL').all()
        ).toHaveLength(0);
        expect(
          sqlite.prepare('SELECT * FROM cc_attachments WHERE project_id IS NOT NULL').all()
        ).toHaveLength(0);
        expect(sqlite.prepare('SELECT * FROM credentials WHERE project_id IS NULL').all()).toEqual(
          personalBefore
        );
        return;
      }
      expect((await session.getState()).status).toBe('completed');
      const projectLegacy = sqlite
        .prepare('SELECT * FROM credentials WHERE project_id = ?')
        .get('project-a') as { encrypted_token: string; iv: string; is_active: number };
      const projectCC = sqlite
        .prepare(
          `SELECT c.encrypted_token,c.iv,a.is_active FROM cc_credentials c JOIN cc_configurations cfg ON cfg.credential_id=c.id JOIN cc_attachments a ON a.configuration_id=cfg.id WHERE a.project_id='project-a' AND a.consumer_target=?`
        )
        .get(agentType) as { encrypted_token: string; iv: string; is_active: number };
      const { decrypt } = await import('../../../src/services/encryption');
      for (const saved of [projectLegacy, projectCC]) {
        expect(saved.is_active).toBe(1);
        expect(saved.encrypted_token).not.toContain(credential('Q'));
        expect(await decrypt(saved.encrypted_token, saved.iv, encryptionKey)).toBe(credential('Q'));
      }
      expect(sqlite.prepare('SELECT * FROM credentials WHERE project_id IS NULL').all()).toEqual(
        personalBefore
      );
      expect(sqlite.prepare('SELECT * FROM cc_attachments WHERE project_id IS NULL').all()).toEqual(
        personalAttachmentBefore
      );
    }
  );

  it('passes code shape validation to the DO boundary for authoritative validation', async () => {
    const sqlite = setupDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agent_credential_setup_sessions
         (id, user_id, project_id, scope, agent_type, credential_kind, status,
          sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'user', 'claude-code', 'oauth-token',
          'waiting_for_user', ?, 'lease-claude', ?, ?, ?)`
      )
      .run(
        'session-bad-token',
        'owner-user',
        'session-bad-token',
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      );

    const submitVerificationCode = vi.fn().mockResolvedValue({
      id: 'session-bad-token',
      status: 'exchanging',
      expiresAt: Date.now() + 60_000,
      errorCode: null,
      errorMessage: null,
      verificationUrl: 'https://claude.ai/oauth/device',
      userCode: null,
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      CREDENTIAL_SETUP_SESSION: {
        idFromName: vi.fn(() => ({ toString: () => 'do-session-bad-token' })),
        get: vi.fn(() => ({ submitVerificationCode })),
      },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const status = 'statusCode' in error ? Number(error.statusCode) : 500;
      return c.json({ error: error.message }, status as 400 | 404 | 409 | 500);
    });
    app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);

    const response = await app.request(
      '/api/agent-credential-setup-sessions/session-bad-token/verification-code',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'invalid code!' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(submitVerificationCode).toHaveBeenCalledWith('invalid code!');
  });
});
