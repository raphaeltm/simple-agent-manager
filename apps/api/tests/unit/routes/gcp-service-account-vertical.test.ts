import {
  DEFAULT_GCP_COMPUTE_API_BASE_URL,
  DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { gcpRoutes } from '../../../src/routes/gcp';
import { decrypt } from '../../../src/services/encryption';
import { parseGcpCredential } from '../../../src/services/provider-credentials';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'vertical-user',
}));

const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';
let privateKey: string;

function setupDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    [
      'CREATE TABLE platform_settings (',
      '  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT',
      ');',
      'CREATE TABLE credentials (',
      '  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, provider TEXT NOT NULL,',
      '  credential_type TEXT NOT NULL, agent_type TEXT, credential_kind TEXT NOT NULL,',
      '  is_active INTEGER NOT NULL, encrypted_token TEXT NOT NULL, iv TEXT NOT NULL,',
      '  created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
      ');',
      'CREATE TABLE cc_credentials (',
      '  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,',
      '  encrypted_token TEXT NOT NULL, iv TEXT NOT NULL, is_active INTEGER NOT NULL,',
      '  created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
      ');',
      'CREATE TABLE cc_configurations (',
      '  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,',
      '  consumer_kind TEXT NOT NULL, consumer_target TEXT NOT NULL, credential_id TEXT,',
      '  settings_json TEXT, is_active INTEGER NOT NULL, created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ');',
      'CREATE TABLE cc_attachments (',
      '  id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL, consumer_kind TEXT NOT NULL,',
      '  consumer_target TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT,',
      '  is_active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
      ');',
    ].join('\n')
  );
  return sqlite;
}

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    namespace: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
      list: vi.fn(async (options: { prefix?: string }) => ({
        keys: Array.from(values.keys())
          .filter((name) => !options.prefix || name.startsWith(options.prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: '',
        cacheStatus: null,
      })),
    } as unknown as KVNamespace,
  };
}

function serviceAccountJson(privateKeyId: string): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'sam-test-project',
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: 'sam-vm@sam-test-project.iam.gserviceaccount.com',
    token_uri: 'https://attacker.invalid/collect',
  });
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/gcp', gcpRoutes);
  return app;
}

function saveRequest(privateKeyId: string) {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceAccountJson: serviceAccountJson(privateKeyId),
      defaultZone: 'us-central1-a',
    }),
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
});

describe('GCP service-account route vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let kv: ReturnType<typeof createKv>;
  let computeAllowed: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = setupDatabase();
    kv = createKv();
    computeAllowed = true;
    fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: 'vertical-short-lived-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      if (
        url ===
        DEFAULT_GCP_COMPUTE_API_BASE_URL + '/projects/sam-test-project/zones/us-central1-a'
      ) {
        return new Response('{}', { status: computeAllowed ? 200 : 403 });
      }
      throw new Error('Unexpected external request: ' + url + ' ' + String(init?.method));
    });
    vi.stubGlobal('fetch', fetchMock);
    env = {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY,
      KV: kv.namespace,
    } as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });

  it('validates externally and atomically persists encrypted legacy and composable copies', async () => {
    const response = await createApp().request(
      '/api/gcp/service-account',
      saveRequest('vertical-key-id'),
      env
    );

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(privateKey);
    expect(responseText).not.toContain('vertical-short-lived-token');
    expect(responseText).not.toContain('attacker.invalid');
    expect(JSON.parse(responseText)).toMatchObject({
      success: true,
      credential: {
        provider: 'gcp',
        gcp: {
          authType: 'service-account-key',
          privateKeyId: 'vertical-key-id',
          gcpProjectId: 'sam-test-project',
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL);
    const tokenBody = tokenInit.body as URLSearchParams;
    expect(tokenBody.get('assertion')).toBeTruthy();
    expect(String(tokenBody)).not.toContain('attacker.invalid');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      DEFAULT_GCP_COMPUTE_API_BASE_URL + '/projects/sam-test-project/zones/us-central1-a'
    );

    const legacy = sqlite
      .prepare('SELECT encrypted_token AS encryptedToken, iv FROM credentials')
      .get() as { encryptedToken: string; iv: string };
    const stored = parseGcpCredential(
      await decrypt(legacy.encryptedToken, legacy.iv, ENCRYPTION_KEY)
    );
    expect(stored).toMatchObject({
      authType: 'service-account-key',
      privateKeyId: 'vertical-key-id',
      privateKey,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM credentials').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM cc_credentials').get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM cc_configurations').get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM cc_attachments').get()).toEqual({
      count: 1,
    });
    expect(Array.from(kv.values.values())).toEqual(['vertical-short-lived-token']);
  });

  it('preserves the prior encrypted snapshot when Compute verification rejects a rotation', async () => {
    const first = await createApp().request(
      '/api/gcp/service-account',
      saveRequest('working-key-id'),
      env
    );
    expect(first.status).toBe(200);
    const before = sqlite
      .prepare('SELECT encrypted_token AS encryptedToken, iv FROM credentials')
      .get();

    computeAllowed = false;
    const rejected = await createApp().request(
      '/api/gcp/service-account',
      saveRequest('rejected-key-id'),
      env
    );

    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(privateKey);
    expect(
      sqlite.prepare('SELECT encrypted_token AS encryptedToken, iv FROM credentials').get()
    ).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM cc_credentials').get()).toEqual({
      count: 1,
    });
  });
});
