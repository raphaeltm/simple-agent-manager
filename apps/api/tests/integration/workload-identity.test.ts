import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createLocalJWKSet, exportPKCS8, exportSPKI, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const remote = vi.hoisted(() => ({
  session: vi.fn(),
  acp: vi.fn(),
  getAcp: vi.fn(),
  proxy: vi.fn(),
}));
vi.mock('../../src/services/project-data', () => ({
  getSession: remote.session,
  listAcpSessions: remote.acp,
  getAcpSession: remote.getAcp,
}));
vi.mock('../../src/routes/mcp/workspace-tools', () => ({ proxySecretExecOnVm: remote.proxy }));
import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { registerChatWorkloadIdentityRoute } from '../../src/routes/chat-workload-identity';
import { handleSecretExec } from '../../src/routes/mcp/secret-exec-tools';
import type { McpTokenData } from '../../src/services/mcp-token';
import { getWorkloadIdentityMetadata } from '../../src/services/workload-identity-context';
import { getWorkloadJWKS } from '../../src/services/workload-identity-token';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
let sqlite: Database.Database;
let env: Env;
const actor: McpTokenData = {
  projectId: 'project',
  userId: 'user',
  workspaceId: 'ws',
  agentSessionId: 'runtime',
  chatSessionId: 'chat',
  taskId: 'task',
  createdAt: 'now',
};
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.platformSettings,
    schema.platformCredentials,
    schema.workspaces,
    schema.agentSessions,
    schema.agentProfiles,
    schema.skills,
    schema.projects,
    schema.users,
    schema.tasks,
    schema.taskSubmissionCheckpoints,
    schema.triggers,
    schema.projectMembers,
    schema.projectRuntimeEnvVars,
    schema.profileRuntimeEnvVars,
    schema.skillRuntimeEnvVars,
  ]);
  sqlite.exec(`
 INSERT INTO users(id,name,status) VALUES('user','Example User','active');
 INSERT INTO project_members(project_id,user_id,role,status) VALUES('project','user','owner','active');
 INSERT INTO projects(id,user_id,name) VALUES('project','user','Example Project');
 INSERT INTO workspaces(id,user_id,project_id) VALUES('ws','user','project');
 INSERT INTO agent_profiles(id,project_id,user_id,name) VALUES('profile','project','user','Current Profile');
 INSERT INTO agent_sessions(id,workspace_id,user_id,status,agent_profile_id,agent_type) VALUES('runtime','ws','user','running','profile','openai-codex');
 INSERT INTO tasks(id,project_id,user_id,workspace_id,chat_session_id,title,triggered_by,trigger_id,trigger_execution_id,agent_profile_hint) VALUES('task','project','user','ws','chat','Do work','webhook','trigger','execution','wrong-profile-hint');
 INSERT INTO triggers(id,project_id,name) VALUES('trigger','project','Release trigger');
 INSERT INTO task_submission_checkpoints(task_id,project_id,user_id,chat_session_id,source_kind,source_id,source_execution_id,accepted_snapshot_json) VALUES('task','project','user','chat','trigger','trigger','execution','{"source":{"displayName":"Release trigger"},"prompt":"NEVER_EXPOSE"}');
 `);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
  remote.session.mockResolvedValue({
    id: 'chat',
    workspaceId: 'ws',
    taskId: 'task',
    topic: 'Session topic',
    createdByUserId: 'user',
  });
  remote.getAcp.mockResolvedValue({
    id: 'runtime',
    chatSessionId: 'chat',
    workspaceId: 'ws',
    status: 'running',
  });
  remote.acp.mockResolvedValue({
    sessions: [{ id: 'runtime', chatSessionId: 'chat', workspaceId: 'ws', status: 'running' }],
    total: 1,
  });
});
afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});
describe('authoritative workload identity', () => {
  it('uses actual runtime profile and verified trigger origin, with only allowlisted labels', async () => {
    const result = await getWorkloadIdentityMetadata(env, 'project', 'chat', actor);
    expect(result.claims).toMatchObject({
      project_id: 'project',
      user_id: 'user',
      agent_profile_id: 'profile',
      agent_profile_name: 'Current Profile',
      chat_session_id: 'chat',
      agent_session_id: 'runtime',
      trigger_id: 'trigger',
      trigger_execution_id: 'execution',
      automation_type: 'trigger',
      automation_id: 'trigger',
      automation_name: 'Release trigger',
    });
    expect(JSON.stringify(result)).not.toContain('NEVER_EXPOSE');
    expect(JSON.stringify(result)).not.toContain('wrong-profile-hint');
  });
  it.each(['schedule', 'standing_watch', 'workflow'])(
    'includes canonical %s provenance without guessing from prompts',
    async (kind) => {
      sqlite
        .prepare(
          'UPDATE task_submission_checkpoints SET source_kind=?,source_id=?,source_execution_id=?'
        )
        .run(kind, 'source', 'run');
      sqlite.exec('UPDATE tasks SET trigger_id=NULL,trigger_execution_id=NULL');
      const { claims } = await getWorkloadIdentityMetadata(env, 'project', 'chat', actor);
      expect(claims).toMatchObject({
        automation_type: kind,
        automation_id: 'source',
        automation_execution_id: 'run',
      });
      expect(claims.trigger_id).toBeUndefined();
    }
  );
  it('omits absent automation/profile rather than inheriting defaults or fabricating origin', async () => {
    sqlite.exec(
      'DELETE FROM task_submission_checkpoints; UPDATE tasks SET trigger_id=NULL,trigger_execution_id=NULL; UPDATE agent_sessions SET agent_profile_id=NULL'
    );
    const { claims } = await getWorkloadIdentityMetadata(env, 'project', 'chat', actor);
    expect(claims.agent_profile_id).toBeUndefined();
    expect(claims.automation_id).toBeUndefined();
  });
  it('allows an owned global profile but not another user’s global profile', async () => {
    sqlite.exec('UPDATE agent_profiles SET project_id=NULL');
    expect(
      (await getWorkloadIdentityMetadata(env, 'project', 'chat', actor)).claims.agent_profile_id
    ).toBe('profile');
    sqlite.exec("UPDATE agent_profiles SET user_id='other'");
    await expect(getWorkloadIdentityMetadata(env, 'project', 'chat', actor)).rejects.toThrow();
  });
  it.each([
    'userId',
    'projectId',
    'workspaceId',
    'agentSessionId',
    'chatSessionId',
    'taskId',
  ] as const)('rejects mismatched authenticated %s', async (key) => {
    await expect(
      getWorkloadIdentityMetadata(env, 'project', 'chat', { ...actor, [key]: 'other' })
    ).rejects.toThrow();
  });
  it.each([
    "UPDATE tasks SET project_id='other'",
    "UPDATE tasks SET user_id='other'",
    "UPDATE tasks SET workspace_id='other'",
    "UPDATE tasks SET chat_session_id='other'",
    "UPDATE agent_sessions SET status='stopped'",
    "UPDATE users SET status='suspended'",
    "UPDATE project_members SET role='viewer'",
  ])('fails closed when canonical authority changes: %s', async (sql) => {
    sqlite.exec(sql);
    await expect(getWorkloadIdentityMetadata(env, 'project', 'chat', actor)).rejects.toThrow();
  });
  it('preserves historical trigger ID after deletion without inventing a current name', async () => {
    sqlite.exec('DELETE FROM triggers');
    const { claims } = await getWorkloadIdentityMetadata(env, 'project', 'chat', actor);
    expect(claims.trigger_id).toBe('trigger');
    expect(claims.trigger_name).toBeUndefined();
  });
});

describe('workload identity transport boundaries', () => {
  it('executes through real resolver and signer with no stored secrets and returns no JWT', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    env.JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
    env.JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
    remote.proxy.mockResolvedValue({
      jobId: 'job',
      status: 'completed',
      stdout: 'verified',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      redacted: false,
      truncated: false,
      execution: {
        containerId: 'container',
        user: 'node',
        cwd: '/workspace',
        environmentMode: 'placeholder',
      },
    });
    const result = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: [], oidc: { audience: 'vault' } },
      actor,
      env,
      'start'
    );
    expect(result.error).toBeUndefined();
    const payload = remote.proxy.mock.calls[0]![4];
    expect(payload.secretNames).toEqual(['SAM_OIDC_TOKEN']);
    const injected = payload.managedEnv.find(
      (entry: { key: string }) => entry.key === 'SAM_OIDC_TOKEN'
    );
    expect(injected.isSecret).toBe(true);
    const verified = await jwtVerify(
      injected.value,
      createLocalJWKSet(await getWorkloadJWKS(env)),
      { issuer: 'https://api.example.test/oidc', audience: 'vault' }
    );
    expect(verified.payload).toMatchObject({
      user_id: 'user',
      agent_profile_id: 'profile',
      trigger_id: 'trigger',
    });
    expect(JSON.stringify(result)).not.toContain(injected.value);
  });
  it('preview route enforces project membership and returns metadata without minting', async () => {
    // Middleware establishes a test principal; the route uses the real project access check.
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      if (c.req.header('x-test-user'))
        c.set('auth', {
          user: {
            id: c.req.header('x-test-user')!,
            email: 'test@example.test',
            name: 'Test',
            avatarUrl: null,
            role: 'user',
            status: 'active',
          },
          session: { id: null, token: null, expiresAt: new Date() },
        });
      await next();
    });
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json({ error: error.code }, error.statusCode)
        : c.json({ error: 'unexpected' }, 500)
    );
    const routes = new Hono<{ Bindings: Env }>();
    registerChatWorkloadIdentityRoute(routes);
    app.route('/api/projects/:projectId/sessions', routes);
    const url = 'https://api.example.test/api/projects/project/sessions/chat/workload-identity';
    expect((await app.request(url, {}, env)).status).toBe(401);
    expect((await app.request(url, { headers: { 'x-test-user': 'outsider' } }, env)).status).toBe(
      404
    );
    const result = await app.request(url, { headers: { 'x-test-user': 'user' } }, env);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    expect(body).toMatchObject({
      issuer: 'https://api.example.test/oidc',
      claims: { user_id: 'user' },
    });
    expect(body).not.toHaveProperty('token');
    // Env has no private signing key: successful preview proves it did not sign.
  });
});
