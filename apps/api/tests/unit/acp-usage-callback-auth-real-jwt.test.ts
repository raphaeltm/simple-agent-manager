import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAcpUsageCallback } from '../../src/services/acp-usage-callback-handler';
import { signCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import { createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/project-data', () => ({
  admitProjectEvent: vi.fn(async () => ({
    outcome: 'created',
    event: { id: 'event-1' },
    matches: [],
  })),
  getAcpSession: vi.fn(),
}));

vi.mock('../../src/services/acp-activity-callback-flush', () => ({
  assertAcpActivityCallbackResourcesActive: vi.fn(async () => undefined),
}));

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const [testPrivateKey, testPublicKey] = await Promise.all([
  exportPKCS8(privateKey),
  exportSPKI(publicKey),
]);

type TestEnv = {
  DATABASE: D1Database;
  KV: KVNamespace;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  BASE_DOMAIN: string;
  CREDENTIAL_LIMIT_WARNING_PERCENT?: string;
  CREDENTIAL_LIMIT_CRITICAL_PERCENT?: string;
};

function migrationPath(name: string): string {
  return join(process.cwd(), 'src/db/migrations', name);
}

function createCredentialD1() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      chat_session_id TEXT,
      node_id TEXT,
      status TEXT
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      user_id TEXT,
      status TEXT,
      agent_type TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  sqlite.exec(readFileSync(migrationPath('0144_project_event_source_outbox.sql'), 'utf8'));
  sqlite.exec(readFileSync(migrationPath('0145_credential_limit_windows.sql'), 'utf8'));
  sqlite.exec(readFileSync(migrationPath('0146_credential_limit_event_admissions.sql'), 'utf8'));
  sqlite.exec(
    readFileSync(migrationPath('0148_project_event_source_outbox_durability.sql'), 'utf8')
  );
  sqlite.prepare('INSERT INTO users (id) VALUES (?)').run('user-1');
  sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run('project-1');
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, user_id, chat_session_id, node_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run('workspace-1', 'project-1', 'user-1', 'chat-1', 'node-1', 'running');
  sqlite
    .prepare(
      `INSERT INTO agent_sessions (
        id, workspace_id, user_id, status, agent_type, created_at, updated_at,
        agent_credential_source, agent_credential_reference, agent_credential_provider,
        agent_provider_mode, agent_credential_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'session-1',
      'workspace-1',
      'user-1',
      'running',
      'claude-code',
      '2026-09-07T00:00:00Z',
      '2026-09-07T00:00:00Z',
      'user',
      'cc_credentials:cred-1',
      'anthropic',
      'direct',
      1
    );
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    JWT_PRIVATE_KEY: testPrivateKey,
    JWT_PUBLIC_KEY: testPublicKey,
    BASE_DOMAIN: 'example.com',
    CREDENTIAL_LIMIT_WARNING_PERCENT: '75',
    CREDENTIAL_LIMIT_CRITICAL_PERCENT: '90',
  } as TestEnv;
  return { sqlite, env };
}

function makeContext(env: TestEnv, token: string) {
  const responseHeaders = new Headers();
  return {
    env,
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
    },
    header: (name: string, value: string) => {
      responseHeaders.set(name, value);
    },
    body: (body: BodyInit | null, status?: number) =>
      new Response(body, { status, headers: new Headers(responseHeaders) }),
    json: (body: unknown, status?: number) => {
      const headers = new Headers(responseHeaders);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(body), { status, headers });
    },
  } as never;
}

function seedProjectData() {
  vi.mocked(projectDataService.getAcpSession).mockResolvedValue({
    id: 'session-1',
    chatSessionId: 'chat-1',
    workspaceId: 'workspace-1',
    nodeId: 'node-1',
    acpSdkSessionId: 'sdk-1',
    status: 'running',
    agentType: 'claude-code',
  } as never);
}

describe('ACP usage callback real JWT authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
    vi.mocked(projectDataService.getAcpSession).mockReset();
    vi.mocked(projectDataService.admitProjectEvent).mockReset();
    vi.mocked(projectDataService.admitProjectEvent).mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-1' },
      matches: [],
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a real signed workspace callback token and rejects a forged workspace token', async () => {
    const { sqlite, env } = createCredentialD1();
    seedProjectData();
    const validToken = await signCallbackToken('workspace-1', env as never);

    await expect(
      handleAcpUsageCallback(makeContext(env, validToken), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          agentType: 'claude-code',
          credentialGeneration: 1,
          rateLimits: [
            {
              windowType: 'claude.five_hour',
              status: 'allowed_warning',
              utilizationPercent: 82,
              observedAt: Date.now(),
            },
          ],
        },
      })
    ).resolves.toMatchObject({ status: 204 });
    expect(projectDataService.admitProjectEvent).toHaveBeenCalledTimes(1);

    vi.mocked(projectDataService.admitProjectEvent).mockClear();
    const otherWorkspaceToken = await signCallbackToken('workspace-2', env as never);
    await expect(
      handleAcpUsageCallback(makeContext(env, otherWorkspaceToken), {
        projectId: 'project-1',
        sessionId: 'session-1',
        body: {
          nodeId: 'node-1',
          agentType: 'claude-code',
          credentialGeneration: 1,
          rateLimits: [
            {
              windowType: 'claude.five_hour',
              status: 'allowed_warning',
              utilizationPercent: 83,
              observedAt: Date.now() + 1,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(projectDataService.admitProjectEvent).not.toHaveBeenCalled();
    sqlite.close();
  });
});
