import {
  GCP_CREDENTIAL_VERSION,
  type GcpServiceAccountKeyCredential,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { decrypt } from '../../../src/services/encryption';
import {
  deleteUserGcpCredential,
  replaceUserGcpCredential,
} from '../../../src/services/gcp-credential-store';
import { parseGcpCredential } from '../../../src/services/provider-credentials';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';
const USER_ID = 'user-gcp-store';

function credential(privateKeyId: string): GcpServiceAccountKeyCredential {
  return {
    version: GCP_CREDENTIAL_VERSION,
    provider: 'gcp',
    authType: 'service-account-key',
    gcpProjectId: 'gcp-project-1',
    serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
    privateKeyId,
    privateKey: `-----BEGIN PRIVATE KEY-----
${privateKeyId}-private-material
-----END PRIVATE KEY-----`,
    defaultZone: 'us-central1-a',
  };
}

function setupDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      agent_type TEXT,
      credential_kind TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cc_credentials (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cc_configurations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      consumer_kind TEXT NOT NULL,
      consumer_target TEXT NOT NULL,
      credential_id TEXT,
      settings_json TEXT,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cc_attachments (
      id TEXT PRIMARY KEY,
      configuration_id TEXT NOT NULL,
      consumer_kind TEXT NOT NULL,
      consumer_target TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

function snapshot(sqlite: Database.Database) {
  return {
    legacy: sqlite
      .prepare('SELECT user_id, provider, encrypted_token, iv FROM credentials ORDER BY id')
      .all(),
    credentials: sqlite
      .prepare('SELECT owner_id, kind, encrypted_token, iv FROM cc_credentials ORDER BY id')
      .all(),
    configurations: sqlite
      .prepare(
        'SELECT owner_id, consumer_kind, consumer_target, credential_id, settings_json FROM cc_configurations ORDER BY id'
      )
      .all(),
    attachments: sqlite
      .prepare(
        'SELECT configuration_id, consumer_kind, consumer_target, user_id, project_id FROM cc_attachments ORDER BY id'
      )
      .all(),
  };
}

describe('GCP credential atomic store', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = setupDatabase();
    env = {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY,
    } as Env;
  });

  it('rotates legacy and composable copies together and makes old ciphertext unreachable', async () => {
    await replaceUserGcpCredential(env, USER_ID, credential('old-key-id'));

    const oldLegacy = sqlite
      .prepare('SELECT encrypted_token AS encryptedToken FROM credentials')
      .get() as { encryptedToken: string };
    const first = snapshot(sqlite);
    expect(first.legacy).toHaveLength(1);
    expect(first.credentials).toHaveLength(1);
    expect(first.configurations).toHaveLength(1);
    expect(first.attachments).toHaveLength(1);
    expect(first.credentials[0]).toMatchObject({
      encrypted_token: oldLegacy.encryptedToken,
    });

    await replaceUserGcpCredential(env, USER_ID, credential('new-key-id'));

    const rotated = snapshot(sqlite);
    expect(rotated.legacy).toHaveLength(1);
    expect(rotated.credentials).toHaveLength(1);
    expect(rotated.configurations).toHaveLength(1);
    expect(rotated.attachments).toHaveLength(1);
    expect(rotated.legacy[0]).not.toMatchObject({
      encrypted_token: oldLegacy.encryptedToken,
    });
    expect(rotated.credentials[0]).not.toMatchObject({
      encrypted_token: oldLegacy.encryptedToken,
    });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
         FROM (
           SELECT encrypted_token FROM credentials
           UNION ALL
           SELECT encrypted_token FROM cc_credentials
         )
         WHERE encrypted_token = ?`
        )
        .get(oldLegacy.encryptedToken)
    ).toMatchObject({ count: 0 });

    await deleteUserGcpCredential(env, USER_ID);
    expect(snapshot(sqlite)).toEqual({
      legacy: [],
      credentials: [],
      configurations: [],
      attachments: [],
    });
  });

  it('keeps only the final managed copy when replacements begin concurrently', async () => {
    await Promise.all([
      replaceUserGcpCredential(env, USER_ID, credential('concurrent-key-a')),
      replaceUserGcpCredential(env, USER_ID, credential('concurrent-key-b')),
    ]);

    const stored = snapshot(sqlite);
    expect(stored.legacy).toHaveLength(1);
    expect(stored.credentials).toHaveLength(1);
    expect(stored.configurations).toHaveLength(1);
    expect(stored.attachments).toHaveLength(1);

    const graph = sqlite.prepare(
      `SELECT
         legacy.encrypted_token AS legacyCiphertext,
         legacy.iv AS legacyIv,
         composable.id AS credentialId,
         composable.encrypted_token AS composableCiphertext,
         composable.iv AS composableIv,
         configuration.id AS configurationId,
         configuration.credential_id AS configurationCredentialId,
         attachment.configuration_id AS attachmentConfigurationId
       FROM credentials legacy
       JOIN cc_configurations configuration ON configuration.owner_id = legacy.user_id
       JOIN cc_credentials composable ON composable.id = configuration.credential_id
       JOIN cc_attachments attachment ON attachment.configuration_id = configuration.id
       WHERE legacy.user_id = ?`
    ).get(USER_ID) as {
      legacyCiphertext: string;
      legacyIv: string;
      credentialId: string;
      composableCiphertext: string;
      composableIv: string;
      configurationId: string;
      configurationCredentialId: string;
      attachmentConfigurationId: string;
    };
    expect(graph.configurationCredentialId).toBe(graph.credentialId);
    expect(graph.attachmentConfigurationId).toBe(graph.configurationId);
    expect(graph.composableCiphertext).toBe(graph.legacyCiphertext);
    expect(graph.composableIv).toBe(graph.legacyIv);
    const decrypted = await decrypt(graph.legacyCiphertext, graph.legacyIv, ENCRYPTION_KEY);
    expect(parseGcpCredential(decrypted).privateKeyId).toMatch(/^concurrent-key-[ab]$/);
  });

  it('preserves a user-managed GCP configuration and attachment during replacement', async () => {
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (
         id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
       ) VALUES ('manual-credential', ?, 'Manual GCP', 'cloud-provider', 'ciphertext', 'iv', 1, 'now', 'now')`
      )
      .run(USER_ID);
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (
         id, owner_id, name, consumer_kind, consumer_target, credential_id,
         settings_json, is_active, created_at, updated_at
       ) VALUES ('manual-configuration', ?, 'Manual GCP', 'compute', 'gcp',
         'manual-credential', NULL, 1, 'now', 'now')`
      )
      .run(USER_ID);
    sqlite
      .prepare(
        `INSERT INTO cc_attachments (
         id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
         is_active, created_at, updated_at
       ) VALUES ('manual-attachment', 'manual-configuration', 'compute', 'gcp', ?, NULL, 1, 'now', 'now')`
      )
      .run(USER_ID);

    await replaceUserGcpCredential(env, USER_ID, credential('managed-key'));

    expect(
      sqlite.prepare(`SELECT id FROM cc_credentials WHERE id = 'manual-credential'`).get()
    ).toMatchObject({ id: 'manual-credential' });
    expect(
      sqlite.prepare(`SELECT id FROM cc_configurations WHERE id = 'manual-configuration'`).get()
    ).toMatchObject({ id: 'manual-configuration' });
    expect(
      sqlite.prepare(`SELECT id FROM cc_attachments WHERE id = 'manual-attachment'`).get()
    ).toMatchObject({ id: 'manual-attachment' });
    expect(snapshot(sqlite).attachments).toHaveLength(2);
  });

  it('rolls back every deletion when a replacement batch fails', async () => {
    await replaceUserGcpCredential(env, USER_ID, credential('working-key-id'));
    const before = snapshot(sqlite);

    sqlite.exec(`
      CREATE TRIGGER reject_gcp_rotation
      BEFORE INSERT ON credentials
      BEGIN
        SELECT RAISE(ABORT, 'forced replacement failure');
      END;
    `);

    await expect(
      replaceUserGcpCredential(env, USER_ID, credential('rejected-key-id'))
    ).rejects.toThrow('forced replacement failure');

    expect(snapshot(sqlite)).toEqual(before);
  });

  it('fails closed when the D1 batch primitive is unavailable', async () => {
    const unavailableEnv = {
      ...env,
      DATABASE: {
        prepare: env.DATABASE.prepare.bind(env.DATABASE),
      } as unknown as D1Database,
    } as Env;

    await expect(
      replaceUserGcpCredential(unavailableEnv, USER_ID, credential('new-key-id'))
    ).rejects.toThrow('Atomic credential replacement is unavailable');
  });
});
