/**
 * Self-hosted ENCRYPTION_KEY / BetterAuth rotation, Worker side, on a real SQL engine
 * (better-sqlite3 behind the D1 shim, schema from the drizzle definitions): every stored
 * credential kind is written under the old key, the real control endpoint is driven with signed
 * requests the way `pnpm selfhost:secrets rotate` drives it, and the values are read back
 * through the app's own readers with the read fallback switched off, so a value that was not
 * really re-encrypted cannot pass.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { betterAuthSymmetricKey } from '../../../src/lib/better-auth-secrets';
import {
  handleKeyRotationRequest,
  type KeyRotationEnv,
} from '../../../src/selfhost/key-rotation/control';
import {
  KEY_ROTATION_AUTH_HEADER,
  KEY_ROTATION_PATH,
  signKeyRotationRequest,
} from '../../../src/selfhost/key-rotation/control-auth';
import {
  D1_LOCATIONS,
  NOT_ROTATED_IV_COLUMNS,
} from '../../../src/selfhost/key-rotation/d1-locations';
import { previousKeyPairs, roleKeys } from '../../../src/selfhost/key-rotation/keys';
import { conditionalWriteProblem } from '../../../src/selfhost/key-rotation/library-conditional';
import { getDecryptedAgentKey } from '../../../src/services/agent-key-resolution';
import {
  decrypt,
  decryptWithKeyOnly,
  encrypt,
  generateEncryptionKey,
} from '../../../src/services/encryption';
import { setPreviousEncryptionKeys } from '../../../src/services/encryption-key-fallback';
import {
  decryptFile,
  encryptFile,
  metadataToR2CustomMetadata,
  r2CustomMetadataToMetadata,
} from '../../../src/services/file-encryption';
import {
  resolveRuntimeEnvRows,
  resolveRuntimeFileRows,
} from '../../../src/services/profile-runtime-assets';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { ConditionalR2 } from '../../helpers/conditional-r2';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const OLD = generateEncryptionKey();
const NEW = generateEncryptionKey();
const CONTROL = 'c'.repeat(64);
const ALL_TABLES = Object.values(schema).filter((t): t is SQLiteTable => is(t, SQLiteTable));

let sqlite: Database.Database;
let d1: D1Database;
let bucket: ConditionalR2;
let env: KeyRotationEnv;

const one = <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).get(...params) as T;

async function seal(plaintext: string, key = OLD) {
  return await encrypt(plaintext, key);
}

async function call(body: Record<string, unknown>, options: { key?: string; at?: number } = {}) {
  const text = JSON.stringify(body);
  const request = new Request(`https://api.example.com${KEY_ROTATION_PATH}`, {
    method: 'POST',
    headers: {
      [KEY_ROTATION_AUTH_HEADER]: await signKeyRotationRequest(
        options.key ?? CONTROL,
        text,
        options.at
      ),
    },
    body: text,
  });
  const response = await handleKeyRotationRequest(request, env);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Every D1 location, page after page, as the CLI does; returns the summed counts. */
async function passAll(mode: 'migrate' | 'verify', limit = 200) {
  const totals = {
    current: 0,
    migrated: 0,
    previous: 0,
    unreadable: 0,
    unreadableRows: [] as any[],
  };
  for (const location of D1_LOCATIONS) {
    let cursor: string | null = null;
    for (;;) {
      const { status, body } = await call({
        op: 'pass',
        target: 'd1',
        location: location.name,
        mode,
        cursor,
        limit,
      });
      expect(status, JSON.stringify(body)).toBe(200);
      for (const k of ['current', 'migrated', 'previous', 'unreadable'] as const)
        totals[k] += body[k];
      totals.unreadableRows.push(...body.unreadableRows);
      cursor = body.nextCursor;
      if (body.done) break;
    }
  }
  return totals;
}

async function seedEverything() {
  const agent = await seal('sk-agent-secret');
  const cloud = await seal('hetzner-token');
  const platform = await seal('platform-token');
  sqlite
    .prepare(`INSERT INTO users (id, email, status) VALUES ('u1', 'u1@example.com', 'active')`)
    .run();
  const insertCredential = sqlite.prepare(
    `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type, credential_kind, is_active, encrypted_token, iv)
     VALUES (?, 'u1', NULL, ?, ?, ?, 'api-key', 1, ?, ?)`
  );
  insertCredential.run(
    'c-agent',
    'anthropic',
    'agent-api-key',
    'claude-code',
    agent.ciphertext,
    agent.iv
  );
  insertCredential.run('c-cloud', 'hetzner', 'cloud-provider', null, cloud.ciphertext, cloud.iv);
  // Capacity-anchor sentinel (default-capacity-source-credentials.ts): no ciphertext at all.
  insertCredential.run('c-anchor', 'hetzner', 'capacity-source', null, '', '');
  // Undecryptable under any key: reported, never written.
  insertCredential.run(
    'c-broken',
    'hetzner',
    'cloud-provider',
    null,
    btoa('x'.repeat(40)),
    btoa('y'.repeat(12))
  );
  // Mirror: byte-identical pair in cc_credentials.
  sqlite
    .prepare(`INSERT INTO cc_credentials (id, encrypted_token, iv) VALUES ('cc-cloud', ?, ?)`)
    .run(cloud.ciphertext, cloud.iv);
  sqlite
    .prepare(`INSERT INTO platform_credentials (id, encrypted_token, iv) VALUES ('p1', ?, ?)`)
    .run(platform.ciphertext, platform.iv);
  // A node provisioned with the cloud credential pins its ciphertext fingerprint.
  sqlite
    .prepare(`INSERT INTO nodes (id, placement_credential_fingerprint) VALUES ('n1', ?)`)
    .run(await fingerprintEncryptedProviderCredential(cloud.ciphertext, cloud.iv));
  for (const table of ['project', 'profile', 'skill']) {
    const value = await seal(`${table}-env-secret`);
    const file = await seal(`${table}-file-secret`);
    sqlite
      .prepare(
        `INSERT INTO ${table}_runtime_env_vars (id, env_key, stored_value, value_iv, is_secret) VALUES (?, 'TOKEN', ?, ?, 1)`
      )
      .run(`${table}-v1`, value.ciphertext, value.iv);
    sqlite
      .prepare(
        `INSERT INTO ${table}_runtime_env_vars (id, env_key, stored_value, value_iv, is_secret) VALUES (?, 'PLAIN', 'visible', NULL, 0)`
      )
      .run(`${table}-v2`);
    sqlite
      .prepare(
        `INSERT INTO ${table}_runtime_files (id, file_path, stored_content, content_iv, is_secret) VALUES (?, '/x', ?, ?, 1)`
      )
      .run(`${table}-f1`, file.ciphertext, file.iv);
  }
  const deploySecret = await seal('deploy-secret');
  sqlite
    .prepare(`INSERT INTO deployment_secrets (id, encrypted_value, iv) VALUES ('d1', ?, ?)`)
    .run(deploySecret.ciphertext, deploySecret.iv);
  const config = await seal('config-secret');
  sqlite
    .prepare(
      `INSERT INTO deployment_environment_config_vars (id, stored_value, value_iv, is_secret) VALUES ('e1', ?, ?, 1)`
    )
    .run(config.ciphertext, config.iv);
  const [url, token, headers] = await Promise.all([
    seal('https://mcp.example.com'),
    seal('mcp-token'),
    seal('[]'),
  ]);
  sqlite
    .prepare(
      `INSERT INTO mcp_connections (id, encrypted_url, url_iv, encrypted_token, token_iv, encrypted_headers, headers_iv) VALUES ('m1', ?, ?, ?, ?, ?, ?)`
    )
    .run(url.ciphertext, url.iv, token.ciphertext, token.iv, headers.ciphertext, headers.iv);
}

/** Every ciphertext value in the registry, as (location, id, column, ciphertext, iv). */
function allValues() {
  const values: Array<{
    location: string;
    id: string;
    column: string;
    ciphertext: string;
    iv: string;
  }> = [];
  for (const location of D1_LOCATIONS) {
    for (const pair of location.pairs) {
      for (const row of sqlite
        .prepare(`SELECT id, ${pair.ciphertext} AS c, ${pair.iv} AS v FROM ${location.table}`)
        .all() as any[]) {
        if (row.c && row.v)
          values.push({
            location: location.name,
            id: row.id,
            column: pair.ciphertext,
            ciphertext: row.c,
            iv: row.v,
          });
      }
    }
  }
  return values;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, ALL_TABLES);
  d1 = createSqliteD1(sqlite);
  bucket = new ConditionalR2();
  env = {
    DATABASE: d1,
    R2: bucket.asBucket(),
    ENCRYPTION_KEY: NEW,
    ENCRYPTION_KEY_PREVIOUS: OLD,
    SAM_KEY_ROTATION_CONTROL_KEY: CONTROL,
  };
});

afterEach(() => {
  setPreviousEncryptionKeys(new Map());
  sqlite.close();
});

describe('the D1 location registry', () => {
  it('names every iv column in the schema (a new encrypted column must be added here)', () => {
    const covered = new Set(D1_LOCATIONS.flatMap((l) => l.pairs.map((p) => `${l.table}.${p.iv}`)));
    const found: string[] = [];
    for (const table of ALL_TABLES) {
      const config = (table as any)[Symbol.for('drizzle:Name')] as string;
      for (const column of Object.values(
        (table as any)[Symbol.for('drizzle:Columns')] as Record<string, { name: string }>
      )) {
        if (/(^|_)iv$/.test(column.name)) found.push(`${config}.${column.name}`);
      }
    }
    // A broken scan would make this vacuous.
    expect(found.length).toBeGreaterThanOrEqual(14);
    expect(found.filter((name) => !covered.has(name) && !(name in NOT_ROTATED_IV_COLUMNS))).toEqual(
      []
    );
  });
});

describe('ENCRYPTION_KEY rotation over D1', () => {
  it('re-encrypts every stored credential kind, keeps the broken row untouched, and the app reads them with the new key alone', async () => {
    await seedEverything();
    const broken = one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-broken'`);
    const before = await passAll('verify');
    expect(before.unreadable).toBe(1);
    expect(before.unreadableRows).toEqual([
      { location: 'credentials', id: 'c-broken', column: 'encrypted_token' },
    ]);
    expect(
      before.previous,
      JSON.stringify(allValues().map((v) => v.location + '/' + v.id + '.' + v.column))
    ).toBe(15);

    const migrated = await passAll('migrate');
    expect(migrated.migrated).toBe(before.previous - 1); // the mirror moved with its primary
    const after = await passAll('verify');
    expect(after.previous).toBe(0);
    expect(after.unreadable).toBe(1);
    expect(one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-broken'`)).toEqual(
      broken
    );
    expect(one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-anchor'`)).toEqual({
      encrypted_token: '',
      iv: '',
    });

    // Every value opens under the new key alone.
    for (const value of allValues()) {
      if (value.id === 'c-broken') continue;
      await expect(
        decryptWithKeyOnly(value.ciphertext, value.iv, NEW),
        `${value.location}/${value.id}`
      ).resolves.toBeTypeOf('string');
      await expect(decryptWithKeyOnly(value.ciphertext, value.iv, OLD)).rejects.toThrow();
    }

    // Through the app's real readers, with the rotation fallback switched off.
    setPreviousEncryptionKeys(new Map());
    const db = drizzle(d1, { schema });
    const agentKey = await getDecryptedAgentKey(db, 'u1', 'claude-code', NEW);
    expect(agentKey?.credential).toBe('sk-agent-secret');
    const envRows = sqlite
      .prepare(
        `SELECT env_key AS key, stored_value AS storedValue, value_iv AS valueIv, is_secret AS isSecret FROM profile_runtime_env_vars ORDER BY id`
      )
      .all() as any[];
    const resolved = await resolveRuntimeEnvRows(
      envRows.map((r) => ({ ...r, isSecret: r.isSecret === 1 })),
      NEW,
      new Set(['TOKEN'])
    );
    expect(resolved.map((r) => r.value)).toEqual(['profile-env-secret', 'visible']);
    const fileRows = sqlite
      .prepare(
        `SELECT file_path AS path, stored_content AS storedContent, content_iv AS contentIv, is_secret AS isSecret FROM skill_runtime_files`
      )
      .all() as any[];
    expect(
      (
        await resolveRuntimeFileRows(
          fileRows.map((r) => ({ ...r, isSecret: true })),
          NEW
        )
      )[0]?.content
    ).toBe('skill-file-secret');
  });

  it('rewrites mirror copies with the identical pair and remaps the node fingerprint, so teardown still recognises the account', async () => {
    await seedEverything();
    await passAll('migrate');
    const primary = one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-cloud'`);
    const mirror = one<any>(`SELECT encrypted_token, iv FROM cc_credentials WHERE id = 'cc-cloud'`);
    expect(mirror).toEqual(primary);
    expect(await decryptWithKeyOnly(primary.encrypted_token, primary.iv, NEW)).toBe(
      'hetzner-token'
    );
    expect(
      one<any>(`SELECT placement_credential_fingerprint AS fp FROM nodes WHERE id = 'n1'`).fp
    ).toBe(await fingerprintEncryptedProviderCredential(primary.encrypted_token, primary.iv));
  });

  it('resumes an interrupted pass from its cursor without losing or double-writing a value', async () => {
    await seedEverything();
    // One row per page, and stop after the first page of `credentials`.
    const first = await call({
      op: 'pass',
      target: 'd1',
      location: 'credentials',
      mode: 'migrate',
      cursor: null,
      limit: 1,
    });
    expect(first.body).toMatchObject({ done: false, migrated: 1, nextCursor: 'c-agent' });
    // "Crash", then a new run continues from the saved cursor; a replay of the same page is harmless.
    const replay = await call({
      op: 'pass',
      target: 'd1',
      location: 'credentials',
      mode: 'migrate',
      cursor: null,
      limit: 1,
    });
    expect(replay.body).toMatchObject({ migrated: 0, current: 1 });
    await passAll('migrate', 2);
    const after = await passAll('verify');
    expect(after.previous).toBe(0);
    expect(
      await decryptWithKeyOnly(
        ...(Object.values(
          one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id='c-agent'`)
        ) as [string, string]),
        NEW
      )
    ).toBe('sk-agent-secret');
  });

  it('never overwrites a value a user saved while the page ran (compare-and-set)', async () => {
    await seedEverything();
    const saved = await seal('saved-by-user', NEW);
    const originalBatch = d1.batch.bind(d1);
    let raced = false;
    (d1 as any).batch = async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        sqlite
          .prepare(`UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = 'c-agent'`)
          .run(saved.ciphertext, saved.iv);
      }
      return await originalBatch(statements);
    };
    const page = await call({
      op: 'pass',
      target: 'd1',
      location: 'credentials',
      mode: 'migrate',
      cursor: null,
      limit: 1,
    });
    expect(page.body).toMatchObject({ migrated: 0, previous: 1 });
    const row = one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-agent'`);
    expect(await decryptWithKeyOnly(row.encrypted_token, row.iv, NEW)).toBe('saved-by-user');
  });

  it('leaves the mirror and the node fingerprint alone when a user save wins the race on the primary', async () => {
    // Review V1 L1: c-cloud has a cc_credentials mirror and a node pinning its fingerprint. The
    // mirror and node UPDATEs run only if the primary now holds the new pair (holdsNew), so a
    // lost compare-and-set on the primary must leave both exactly as they were.
    await seedEverything();
    const mirrorBefore = one<any>(
      `SELECT encrypted_token, iv FROM cc_credentials WHERE id = 'cc-cloud'`
    );
    const fingerprintBefore = one<any>(
      `SELECT placement_credential_fingerprint AS fp FROM nodes WHERE id = 'n1'`
    ).fp;
    const saved = await seal('hetzner-token-saved-by-user', NEW);
    const originalBatch = d1.batch.bind(d1);
    let batches = 0;
    (d1 as any).batch = async (statements: D1PreparedStatement[]) => {
      batches += 1;
      // The user's save lands between the page's read and its write batch.
      sqlite
        .prepare(`UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = 'c-cloud'`)
        .run(saved.ciphertext, saved.iv);
      return await originalBatch(statements);
    };
    const page = await call({
      op: 'pass',
      target: 'd1',
      location: 'credentials',
      mode: 'migrate',
      cursor: 'c-broken', // the page holds c-cloud alone
      limit: 1,
    });
    expect(batches).toBe(1); // liveness: the write batch ran
    expect(page.body).toMatchObject({ migrated: 0, previous: 1 });
    expect(
      one<any>(`SELECT encrypted_token, iv FROM cc_credentials WHERE id = 'cc-cloud'`)
    ).toEqual(mirrorBefore);
    expect(
      one<any>(`SELECT placement_credential_fingerprint AS fp FROM nodes WHERE id = 'n1'`).fp
    ).toBe(fingerprintBefore);
    // The user's value is the one stored.
    const row = one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-cloud'`);
    expect(await decryptWithKeyOnly(row.encrypted_token, row.iv, NEW)).toBe(
      'hetzner-token-saved-by-user'
    );
  });

  it('moves the mirror and the fingerprint with the primary when nothing races (control)', async () => {
    await seedEverything();
    const page = await call({
      op: 'pass',
      target: 'd1',
      location: 'credentials',
      mode: 'migrate',
      cursor: 'c-broken',
      limit: 1,
    });
    expect(page.body).toMatchObject({ migrated: 1 });
    const primary = one<any>(`SELECT encrypted_token, iv FROM credentials WHERE id = 'c-cloud'`);
    expect(
      one<any>(`SELECT encrypted_token, iv FROM cc_credentials WHERE id = 'cc-cloud'`)
    ).toEqual(primary);
    expect(
      one<any>(`SELECT placement_credential_fingerprint AS fp FROM nodes WHERE id = 'n1'`).fp
    ).toBe(await fingerprintEncryptedProviderCredential(primary.encrypted_token, primary.iv));
  });

  it('serves the old key as a read fallback only while a previous key is registered', async () => {
    const old = await seal('still-old');
    setPreviousEncryptionKeys(previousKeyPairs(env));
    expect(await decrypt(old.ciphertext, old.iv, NEW)).toBe('still-old');
    setPreviousEncryptionKeys(new Map());
    await expect(decrypt(old.ciphertext, old.iv, NEW)).rejects.toThrow();
  });
});

describe('purpose-specific key overrides', () => {
  it('rotating only LIBRARY_ENCRYPTION_KEY moves library files and leaves every credential alone', async () => {
    const libraryOld = generateEncryptionKey();
    const libraryNew = generateEncryptionKey();
    const credential = await seal('stays-under-encryption-key', OLD);
    sqlite
      .prepare(`INSERT INTO credentials (id, encrypted_token, iv) VALUES ('c1', ?, ?)`)
      .run(credential.ciphertext, credential.iv);
    const { ciphertext, metadata } = await encryptFile(
      new TextEncoder().encode('library').buffer as ArrayBuffer,
      libraryOld
    );
    bucket.set('library/p1/f1', ciphertext, metadataToR2CustomMetadata(metadata));
    env = {
      ...env,
      ENCRYPTION_KEY: OLD,
      ENCRYPTION_KEY_PREVIOUS: undefined,
      LIBRARY_ENCRYPTION_KEY: libraryNew,
      LIBRARY_ENCRYPTION_KEY_PREVIOUS: libraryOld,
    };
    expect((await call({ op: 'status' })).body.roles).toEqual({
      credential: false,
      'credential-nullish': false,
      library: true,
    });
    const migrate = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor: null });
    expect(migrate.body).toMatchObject({ migrated: 1 });
    const stored = bucket.object('library/p1/f1')!;
    const plain = await decryptFile(
      stored.body,
      r2CustomMetadataToMetadata(stored.customMetadata),
      libraryNew
    );
    expect(new TextDecoder().decode(plain)).toBe('library');
    // The credential role is not rotating: every D1 value reads as current and nothing is written.
    const verify = await passAll('verify');
    expect(verify).toMatchObject({ previous: 0, unreadable: 0, current: 1 });
    expect(
      one<any>(`SELECT encrypted_token FROM credentials WHERE id = 'c1'`).encrypted_token
    ).toBe(credential.ciphertext);
  });

  it('rotating a CREDENTIAL_ENCRYPTION_KEY override moves the credential tables, not the library', async () => {
    const credentialOld = generateEncryptionKey();
    const credentialNew = generateEncryptionKey();
    const value = await seal('credential-secret', credentialOld);
    sqlite
      .prepare(`INSERT INTO credentials (id, encrypted_token, iv) VALUES ('c1', ?, ?)`)
      .run(value.ciphertext, value.iv);
    const deploySecret = await seal('deploy-secret', credentialOld);
    sqlite
      .prepare(`INSERT INTO deployment_secrets (id, encrypted_value, iv) VALUES ('d1', ?, ?)`)
      .run(deploySecret.ciphertext, deploySecret.iv);
    env = {
      ...env,
      ENCRYPTION_KEY: OLD,
      ENCRYPTION_KEY_PREVIOUS: undefined,
      CREDENTIAL_ENCRYPTION_KEY: credentialNew,
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: credentialOld,
    };
    expect((await call({ op: 'status' })).body.roles).toEqual({
      credential: true,
      'credential-nullish': true,
      library: false,
    });
    await passAll('migrate');
    expect(await passAll('verify')).toMatchObject({ previous: 0, unreadable: 0, current: 2 });
    const row = one<any>(`SELECT encrypted_token AS c, iv FROM credentials WHERE id = 'c1'`);
    expect(await decryptWithKeyOnly(row.c, row.iv, credentialNew)).toBe('credential-secret');
    const deploy = one<any>(
      `SELECT encrypted_value AS c, iv FROM deployment_secrets WHERE id = 'd1'`
    );
    expect(await decryptWithKeyOnly(deploy.c, deploy.iv, credentialNew)).toBe('deploy-secret');
  });

  it('mirrors the app resolvers exactly, including || versus ?? on an empty override', () => {
    const empty = { ENCRYPTION_KEY: NEW, CREDENTIAL_ENCRYPTION_KEY: '' };
    // getCredentialEncryptionKey uses ||; deployment-secrets.ts uses ?? (an empty string wins).
    expect(roleKeys('credential', empty).current).toBe(NEW);
    expect(roleKeys('credential-nullish', empty).current).toBe('');
    expect(roleKeys('library', { ENCRYPTION_KEY: NEW }).current).toBe(NEW);
    expect(roleKeys('credential', { ENCRYPTION_KEY: NEW, ENCRYPTION_KEY_PREVIOUS: OLD })).toEqual({
      current: NEW,
      previous: OLD,
    });
    // An override that is set keeps its role out of an ENCRYPTION_KEY rotation.
    expect(
      roleKeys('credential', {
        ENCRYPTION_KEY: NEW,
        ENCRYPTION_KEY_PREVIOUS: OLD,
        CREDENTIAL_ENCRYPTION_KEY: 'override',
      }).previous
    ).toBeNull();
  });
});

describe('the control endpoint', () => {
  it('does not exist without a control key in the bundle', async () => {
    env.SAM_KEY_ROTATION_CONTROL_KEY = undefined;
    expect((await call({ op: 'status' })).status).toBe(404);
  });

  it('refuses a wrong key, a stale timestamp and an unsigned request', async () => {
    expect((await call({ op: 'status' }, { key: 'd'.repeat(64) })).status).toBe(401);
    expect((await call({ op: 'status' }, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    const unsigned = await handleKeyRotationRequest(
      new Request(`https://api.example.com${KEY_ROTATION_PATH}`, {
        method: 'POST',
        body: '{"op":"status"}',
      }),
      env
    );
    expect(unsigned.status).toBe(401);
    // Control: the right key works and reports which roles rotate.
    const ok = await call({ op: 'status' });
    expect(ok.status).toBe(200);
    expect(ok.body.roles).toEqual({ credential: true, 'credential-nullish': true, library: true });
  });

  it('refuses a body other than the one signed', async () => {
    const signed = '{"op":"status"}';
    const sent = '{"op":"pass","target":"library","mode":"migrate"}';
    const response = await handleKeyRotationRequest(
      new Request(`https://api.example.com${KEY_ROTATION_PATH}`, {
        method: 'POST',
        headers: { [KEY_ROTATION_AUTH_HEADER]: await signKeyRotationRequest(CONTROL, signed) },
        body: sent,
      }),
      env
    );
    expect(response.status).toBe(401);
  });

  it('stops reading a chunked body without Content-Length once it passes the cap (review V1 L5)', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(32));
      },
    });
    const request = new Request(`https://api.example.com${KEY_ROTATION_PATH}`, {
      method: 'POST',
      headers: { [KEY_ROTATION_AUTH_HEADER]: await signKeyRotationRequest(CONTROL, '{}') },
      body: endless,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await handleKeyRotationRequest(request, env);
    expect(response.status).toBe(413);
    // 4 KiB cap in 1 KiB chunks: it stopped after a handful, not after the whole stream.
    expect(pulled).toBeLessThan(10);
  });
});

describe('library files', () => {
  async function storeFile(key: string, text: string, kek = OLD) {
    const { ciphertext, metadata } = await encryptFile(
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      kek
    );
    bucket.set(key, ciphertext, metadataToR2CustomMetadata(metadata), {
      contentType: 'text/plain',
    });
  }

  it('re-wraps every file key under the new KEK, body untouched, readable with the new key alone', async () => {
    await storeFile('library/p1/f1', 'first file');
    await storeFile('library/p1/f2', 'second file');
    bucket.set('library/p1/plain', new ArrayBuffer(3), {}); // not an encrypted object: left alone
    const bodyBefore = bucket.object('library/p1/f1')?.body;
    for (let cursor: string | null = null, done = false; !done;) {
      const page = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor, limit: 1 });
      cursor = page.body.nextCursor;
      done = page.body.done;
    }
    const verify = await call({ op: 'pass', target: 'library', mode: 'verify', cursor: null });
    expect(verify.body).toMatchObject({ previous: 0, unreadable: 0, current: 2 });
    for (const [key, text] of [
      ['library/p1/f1', 'first file'],
      ['library/p1/f2', 'second file'],
    ] as const) {
      const stored = bucket.object(key)!;
      expect(stored.httpMetadata.contentType).toBe('text/plain');
      const plain = await decryptFile(
        stored.body,
        r2CustomMetadataToMetadata(stored.customMetadata),
        NEW
      );
      expect(new TextDecoder().decode(plain)).toBe(text);
    }
    expect(new Uint8Array(bucket.object('library/p1/f1')!.body)).toEqual(
      new Uint8Array(bodyBefore!)
    );
  });

  it('does not overwrite a file replaced while it was being re-wrapped', async () => {
    await storeFile('library/p1/f1', 'old content');
    const replacement = await encryptFile(
      new TextEncoder().encode('replaced by the user').buffer as ArrayBuffer,
      NEW
    );
    // The user's replace lands between the rotation's read and its conditional put.
    bucket.beforePut = (key) => {
      if (!key.startsWith('library/')) return; // the pass's conditional-write check comes first
      bucket.beforePut = null;
      bucket.set(key, replacement.ciphertext, metadataToR2CustomMetadata(replacement.metadata));
    };
    const result = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor: null });
    expect(result.body).toMatchObject({ migrated: 0, previous: 1 });
    const stored = bucket.object('library/p1/f1')!;
    const plain = await decryptFile(
      stored.body,
      r2CustomMetadataToMetadata(stored.customMetadata),
      NEW
    );
    expect(new TextDecoder().decode(plain)).toBe('replaced by the user');
    // The next verify sees the replacement under the new key.
    const verify = await call({ op: 'pass', target: 'library', mode: 'verify', cursor: null });
    expect(verify.body).toMatchObject({ previous: 0, current: 1 });
  });
});

describe('library files: a store that does not honour conditional writes (review V1 M1)', () => {
  async function storeFile(key: string, text: string, kek = OLD) {
    const { ciphertext, metadata } = await encryptFile(
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      kek
    );
    bucket.set(key, ciphertext, metadataToR2CustomMetadata(metadata));
  }

  it.each([
    ['get', /get returned a body for a stale etagMatches/],
    ['put', /put wrote over a newer object/],
  ] as const)(
    'refuses to re-wrap anything when the store ignores onlyIf on %s',
    async (op, reason) => {
      await storeFile('library/p1/f1', 'old content');
      const before = bucket.object('library/p1/f1')!;
      bucket.ignoreOnlyIf = { [op]: true };
      const result = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor: null });
      expect(result.status).toBe(500);
      expect(result.body.message).toMatch(/does not honour conditional writes/);
      expect(result.body.message).toMatch(reason);
      // Nothing written, and the scratch object is gone.
      expect(bucket.object('library/p1/f1')).toEqual(before);
      expect(bucket.keys()).toEqual(['library/p1/f1']);
    }
  );

  it('a store that honours both: the check passes and leaves no scratch object (control)', async () => {
    await storeFile('library/p1/f1', 'old content');
    const result = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor: null });
    expect(result.body).toMatchObject({ migrated: 1, previous: 0, unreadable: 0 });
    expect(bucket.keys()).toEqual(['library/p1/f1']);
  });

  it('overlapping checks use their own scratch objects and both pass', async () => {
    const [a, b] = await Promise.all([
      conditionalWriteProblem(bucket.asBucket()),
      conditionalWriteProblem(bucket.asBucket()),
    ]);
    expect([a, b]).toEqual([null, null]);
    expect(bucket.keys()).toEqual([]);
  });

  it('verify does not run the write check (it writes nothing)', async () => {
    await storeFile('library/p1/f1', 'content');
    bucket.ignoreOnlyIf = { get: true, put: true };
    const verify = await call({ op: 'pass', target: 'library', mode: 'verify', cursor: null });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ previous: 1, unreadable: 0 });
  });
});

describe('library files: a body that does not match its data key (review V1 M1)', () => {
  async function encrypted(text: string, kek: string) {
    return await encryptFile(new TextEncoder().encode(text).buffer as ArrayBuffer, kek);
  }

  it('verify reports a current-key file whose body is another file’s as unreadable', async () => {
    const a = await encrypted('file a', NEW);
    const b = await encrypted('file b', NEW);
    // a's wrapped key (opens under the current KEK) over b's body: the case a lost race could
    // leave if a store returned the replaced body. The wrapped-key check alone says "current".
    bucket.set('library/p1/a', b.ciphertext, metadataToR2CustomMetadata(a.metadata));
    bucket.set('library/p1/b', b.ciphertext, metadataToR2CustomMetadata(b.metadata));
    const verify = await call({ op: 'pass', target: 'library', mode: 'verify', cursor: null });
    expect(verify.body).toMatchObject({ current: 1, unreadable: 1, previous: 0 });
    expect(verify.body.unreadableRows).toEqual([
      { location: 'library_files', id: 'library/p1/a', column: 'body' },
    ]);
  });

  it('migrate never re-wraps a key over a body it does not open, and reports it', async () => {
    const a = await encrypted('file a', OLD);
    const b = await encrypted('file b', OLD);
    bucket.set('library/p1/a', b.ciphertext, metadataToR2CustomMetadata(a.metadata));
    const before = bucket.object('library/p1/a')!;
    const migrate = await call({ op: 'pass', target: 'library', mode: 'migrate', cursor: null });
    expect(migrate.body).toMatchObject({ migrated: 0, unreadable: 1 });
    expect(bucket.object('library/p1/a')).toEqual(before);
    // The baseline verify reports it the same way, so it never blocks the rotation.
    const verify = await call({ op: 'pass', target: 'library', mode: 'verify', cursor: null });
    expect(verify.body).toMatchObject({ unreadable: 1, previous: 0 });
  });
});

describe('BetterAuth secret rotation over accounts', () => {
  it('moves legacy tokens to a versioned envelope under the new secret; a broken token is reported and kept', async () => {
    const oldSecret = 'old-better-auth-secret-0123456789abcdef';
    const newSecret = 'new-better-auth-secret-0123456789abcdef';
    const legacy = await symmetricEncrypt({ key: oldSecret, data: 'gho_access' });
    const legacyRefresh = await symmetricEncrypt({ key: oldSecret, data: 'ghr_refresh' });
    sqlite
      .prepare(`INSERT INTO accounts (id, access_token, refresh_token) VALUES ('a1', ?, ?)`)
      .run(legacy, legacyRefresh);
    sqlite.prepare(`INSERT INTO accounts (id, access_token) VALUES ('a2', 'not-a-token')`).run();
    sqlite.prepare(`INSERT INTO accounts (id, access_token) VALUES ('a3', NULL)`).run();
    Object.assign(env, {
      BETTER_AUTH_SECRET: newSecret,
      BETTER_AUTH_SECRET_VERSION: '1',
      BETTER_AUTH_SECRET_PREVIOUS: oldSecret,
    });
    const migrate = await call({
      op: 'pass',
      target: 'better-auth',
      mode: 'migrate',
      cursor: null,
    });
    expect(migrate.body).toMatchObject({ migrated: 2, unreadable: 1 });
    const verify = await call({ op: 'pass', target: 'better-auth', mode: 'verify', cursor: null });
    expect(verify.body).toMatchObject({ previous: 0, unreadable: 1, current: 2 });
    expect(one<any>(`SELECT access_token FROM accounts WHERE id = 'a2'`).access_token).toBe(
      'not-a-token'
    );
    // The configuration after the rotation, without the previous secret, reads both tokens.
    const finalKey = betterAuthSymmetricKey({
      ENCRYPTION_KEY: NEW,
      BETTER_AUTH_SECRET: newSecret,
      BETTER_AUTH_SECRET_VERSION: '1',
    });
    const row = one<any>(`SELECT access_token, refresh_token FROM accounts WHERE id = 'a1'`);
    expect(row.access_token.startsWith('$ba$1$')).toBe(true);
    expect(await symmetricDecrypt({ key: finalKey, data: row.access_token })).toBe('gho_access');
    expect(await symmetricDecrypt({ key: finalKey, data: row.refresh_token })).toBe('ghr_refresh');
  });
});
