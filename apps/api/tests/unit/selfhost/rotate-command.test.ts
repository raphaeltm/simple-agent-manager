/**
 * `pnpm selfhost:secrets rotate` end to end in one process: the real orchestrator
 * (scripts/selfhost/rotate-run.ts) over real sealed bundles with the real file key provider, and
 * a "Worker" that is the real Worker-side code run with whatever bundle was last deployed: the
 * key-rotation control endpoint and passes over a real SQLite database, getJWKS and
 * verifyCallbackToken, the gateway secret check, the decrypt read fallback. Only the box
 * plumbing is simulated: "deploy" means the Worker now runs with the newest bundle.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sealSecrets } from '../../../../../deploy/selfhost/key-agent/bundle.ts';
import { createKeyProvider } from '../../../../../deploy/selfhost/key-agent/providers.ts';
import {
  renderGatewayEnv,
  resolveTunnelSettings,
} from '../../../../../scripts/selfhost/box-settings';
import { KEY_CHOICE_FORMAT, writeKeyChoice } from '../../../../../scripts/selfhost/key-choice';
import {
  ensureKeyServiceFiles,
  generateAgentSigningKey,
  keyServiceSettings,
  listBundles,
} from '../../../../../scripts/selfhost/key-service';
import { completePlatformKeys } from '../../../../../scripts/selfhost/platform-keys';
import type { RotateDeps } from '../../../../../scripts/selfhost/rotate-apply';
import { runRotate } from '../../../../../scripts/selfhost/rotate-run';
import { openRotationStore, readJournal } from '../../../../../scripts/selfhost/rotate-store';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  handleKeyRotationRequest,
  type KeyRotationEnv,
} from '../../../src/selfhost/key-rotation/control';
import {
  KEY_ROTATION_AUTH_HEADER,
  KEY_ROTATION_PATH,
  signKeyRotationRequest,
} from '../../../src/selfhost/key-rotation/control-auth';
import { previousKeyPairs } from '../../../src/selfhost/key-rotation/keys';
import { getDecryptedAgentKey } from '../../../src/services/agent-key-resolution';
import { decryptWithKeyOnly, encrypt } from '../../../src/services/encryption';
import { setPreviousEncryptionKeys } from '../../../src/services/encryption-key-fallback';
import { signNodeCallbackToken } from '../../../src/services/jwt';
import { getJWKS, verifyCallbackToken } from '../../../src/services/jwt-verify';
import { isAcceptedGatewaySecret } from '../../../src/services/node-reverse-tunnel-config';
import { ConditionalR2 } from '../../helpers/conditional-r2';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ALL_TABLES = Object.values(schema).filter((t): t is SQLiteTable => is(t, SQLiteTable));
const BOX = { SAM_DOMAIN: 'example.com', CELLD_BUCKET: 's3://fleet/celld' };
const HOUR = 3600_000;

let stateDir: string;
let sqlite: Database.Database;
let d1: D1Database;
let deployed: Record<string, string>;
let clock: number;
let healthy: () => boolean;
let restarts: string[];
let controlHook: ((body: Record<string, unknown>) => Promise<void>) | null;
let logs: string[];
/** Worker settings beyond the bundle (vars a deploy would set). */
let workerVars: Record<string, string>;

const store = () => openRotationStore(BOX, stateDir);
const head = async () => (await store().head()).secrets;
const workerEnv = () =>
  ({
    ...deployed,
    ...workerVars,
    BASE_DOMAIN: 'example.com',
    DATABASE: d1,
    R2: new ConditionalR2().asBucket(),
  }) as unknown as Env & KeyRotationEnv;

function deps(): RotateDeps {
  return {
    log: (line) => logs.push(line),
    now: () => clock,
    backup: () => join(stateDir, 'backup-marker'),
    deploy: async () => {
      deployed = await head();
      // What the celld wrapper does for every request: register the bundle's previous keys.
      setPreviousEncryptionKeys(previousKeyPairs(workerEnv()));
    },
    adoptAndCheck: async () => {
      const ok = healthy();
      return { healthy: ok, detail: ok ? 'HTTP 200' : 'HTTP 503' };
    },
    restartGatewayConsumers: async () => {
      restarts.push(readFileSync(join(stateDir, 'gateway.env'), 'utf8'));
    },
    control: async (key, body) => {
      if (controlHook) await controlHook(body);
      const text = JSON.stringify(body);
      const response = await handleKeyRotationRequest(
        new Request(`https://api.example.com${KEY_ROTATION_PATH}`, {
          method: 'POST',
          headers: { [KEY_ROTATION_AUTH_HEADER]: await signKeyRotationRequest(key, text) },
          body: text,
        }),
        workerEnv()
      );
      if (!response.ok) throw new Error(`control answered ${response.status}`);
      return await response.json();
    },
    getJson: async (path) => {
      if (path === '/.well-known/jwks.json')
        return { status: 200, body: await getJWKS(workerEnv()) };
      if (path === '/api/config/vapid-public-key')
        return { status: 200, body: { publicKey: deployed.VAPID_PUBLIC_KEY } };
      return { status: 404, body: null };
    },
    probeGateway: async (secret) => (isAcceptedGatewaySecret(workerEnv(), secret) ? 200 : 401),
  };
}

const input = (extra: Partial<Parameters<typeof runRotate>[0]> = {}) => ({
  box: BOX,
  stateDir,
  names: [] as string[],
  all: false,
  dryRun: false,
  resume: false,
  skipBackup: false,
  ...extra,
});

async function seedCredential(id: string, plaintext: string, key: string) {
  const sealed = await encrypt(plaintext, key);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO credentials (id, user_id, provider, credential_type, agent_type, credential_kind, is_active, encrypted_token, iv)
       VALUES (?, 'u1', 'anthropic', 'agent-api-key', ?, 'api-key', 1, ?, ?)`
    )
    .run(id, id === 'c-agent' ? 'claude-code' : null, sealed.ciphertext, sealed.iv);
}

const credential = (id: string) =>
  sqlite.prepare(`SELECT encrypted_token AS c, iv FROM credentials WHERE id = ?`).get(id) as {
    c: string;
    iv: string;
  };

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'sam-rotate-'));
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, ALL_TABLES);
  sqlite
    .prepare(`INSERT INTO users (id, email, status) VALUES ('u1', 'u1@example.com', 'active')`)
    .run();
  d1 = createSqliteD1(sqlite);
  clock = Date.now();
  healthy = () => true;
  restarts = [];
  controlHook = null;
  logs = [];
  workerVars = {};
  writeKeyChoice(stateDir, {
    format: KEY_CHOICE_FORMAT,
    provider: 'file',
    settings: {},
    reason: 'test',
    source: 'auto',
    chosenAt: new Date(clock).toISOString(),
  });
  const settings = keyServiceSettings({ SAM_KEY_PROVIDER: 'file' }, stateDir)!;
  ensureKeyServiceFiles(settings);
  const secrets = {
    ...completePlatformKeys({}).keys,
    SAM_KEY_AGENT_SIGNING_KEY: generateAgentSigningKey(),
  };
  const bundle = await sealSecrets(secrets, createKeyProvider(settings.hostEnv), {
    installationId: secrets.SAM_INSTALLATION_ID,
  });
  writeFileSync(join(settings.bundleDir, `${bundle.bundleId}.json`), JSON.stringify(bundle), {
    mode: 0o600,
  });
  writeFileSync(
    join(stateDir, 'gateway.env'),
    renderGatewayEnv(secrets.REVERSE_TUNNEL_GATEWAY_SECRET, resolveTunnelSettings({})),
    { mode: 0o600 }
  );
  deployed = secrets;
  setPreviousEncryptionKeys(new Map());
});

afterEach(() => {
  setPreviousEncryptionKeys(new Map());
  vi.useRealTimers();
  sqlite.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('rotate --dry-run', () => {
  it('prints the plan and the user impact per key, and changes nothing', async () => {
    const before = listBundles(join(stateDir, 'key-agent', 'bundles')).map((b) => b.bundleId);
    expect(await runRotate(input({ all: true, dryRun: true }), deps())).toBeNull();
    const text = logs.join('\n');
    for (const name of [
      'encryption-key',
      'jwt-keys',
      'gateway-secret',
      'vapid-keys',
      'better-auth-secret',
    ]) {
      expect(text).toContain(`. ${name}:`);
    }
    expect(text).toContain('users notice:');
    expect(text).toContain('GitHub App secret and private key');
    expect(readJournal(stateDir)).toBeNull();
    expect(listBundles(join(stateDir, 'key-agent', 'bundles')).map((b) => b.bundleId)).toEqual(
      before
    );
  });
});

describe('rotate encryption-key', () => {
  it('re-encrypts stored credentials, waits for unreachable values to expire, then retires the old key', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    await seedCredential('c-agent', 'sk-agent', old);
    sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, provider, encrypted_token, iv) VALUES ('c-broken', 'u1', 'x', ?, ?)`
      )
      .run(btoa('z'.repeat(32)), btoa('i'.repeat(12)));
    // A reverse-tunnel node provisioned before the rotation (credential derived from the old key).
    sqlite
      .prepare(
        `INSERT INTO node_reverse_tunnel_leases (id, node_id, user_id, runtime_incarnation_id, port, credential_hash, status, created_at, updated_at)
         VALUES ('lease-old', 'n-old', 'u1', 'inc', 20001, 'h', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    await runRotate(input({ names: ['encryption-key'] }), deps());
    const mid = await head();
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('waiting');
    expect(mid.ENCRYPTION_KEY_PREVIOUS).toBe(old);
    expect(mid.ENCRYPTION_KEY).not.toBe(old);
    // TOKEN_HASH_KEY is pinned to the old value on purpose (API token lookups keep working).
    expect(mid.TOKEN_HASH_KEY).toBe(old);
    // BETTER_AUTH_SECRET was unset, so the old key signed every session: the run chains
    // better-auth-secret, which replaces the pinned value at once (review V1 M2).
    const journal = readJournal(stateDir);
    expect(journal?.keys).toEqual(['encryption-key', 'better-auth-secret']);
    expect(journal?.steps['encryption-key']?.signInSecretPinned).toBe(true);
    expect(journal?.steps['better-auth-secret']?.phase).toBe('done');
    expect(mid.BETTER_AUTH_SECRET).toBeTruthy();
    expect(mid.BETTER_AUTH_SECRET).not.toBe(old);
    expect(mid.BETTER_AUTH_SECRET_PREVIOUS).toBeUndefined();
    expect(
      await decryptWithKeyOnly(
        credential('c-agent').c,
        credential('c-agent').iv,
        mid.ENCRYPTION_KEY!
      )
    ).toBe('sk-agent');

    // Too early: nothing changes.
    await runRotate(input({ resume: true }), deps());
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBe(old);

    clock += 6 * HOUR;
    await runRotate(input({ resume: true }), deps());
    const done = await head();
    expect(done.ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    expect(done.SAM_KEY_ROTATION_CONTROL_KEY).toBeUndefined();
    expect(readJournal(stateDir)).toBeNull(); // archived
    // The app reads the credential with the new key alone (fallback cleared by the last deploy).
    const key = await getDecryptedAgentKey(
      drizzle(d1, { schema }),
      'u1',
      'claude-code',
      done.ENCRYPTION_KEY!
    );
    expect(key?.credential).toBe('sk-agent');
    // The broken row was reported, never written.
    expect(credential('c-broken').c).toBe(btoa('z'.repeat(32)));
    expect(logs.join('\n')).toContain('credentials/c-broken.encrypted_token');
    // The node whose tunnel credential is still derived from the old key is named, not hidden.
    expect(logs.join('\n')).toContain('1 reverse-tunnel node(s) created before the switch');
    // The old key is still in the sealed snapshot until the operator deletes it.
    const journalDir = join(stateDir, 'key-agent', 'rotation');
    const id = readFileSync(join(journalDir, readdir(journalDir)[0]!, 'journal.json'), 'utf8');
    expect(JSON.parse(id).steps['encryption-key'].phase).toBe('done');
  });

  it('resumes after an interruption in the middle of the migration and loses nothing', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    for (let i = 0; i < 5; i += 1) await seedCredential(`c-${i}`, `secret-${i}`, old);
    let calls = 0;
    controlHook = async (body) => {
      if (body.mode === 'migrate' && ++calls === 2) throw new Error('box lost power');
    };
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      'box lost power'
    );
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('migrating');
    controlHook = null;
    await runRotate(input({ resume: true }), deps());
    clock += 6 * HOUR;
    await runRotate(input({ resume: true }), deps());
    const current = (await head()).ENCRYPTION_KEY!;
    for (let i = 0; i < 5; i += 1) {
      expect(
        await decryptWithKeyOnly(credential(`c-${i}`).c, credential(`c-${i}`).iv, current)
      ).toBe(`secret-${i}`);
    }
  });

  it('migrates a value written under the old key after verification before it retires the old key', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    await seedCredential('c-agent', 'sk-agent', old);
    await runRotate(input({ names: ['encryption-key'] }), deps());
    // Something the passes never saw writes under the old key (a restore, an unknown writer).
    await seedCredential('c-late', 'late-secret', old);
    clock += 6 * HOUR;
    await runRotate(input({ resume: true }), deps());
    const current = (await head()).ENCRYPTION_KEY!;
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    expect(await decryptWithKeyOnly(credential('c-late').c, credential('c-late').iv, current)).toBe(
      'late-secret'
    );
  });

  it('rolls back when verification keeps failing: the old key is current again and every value reads under it', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    await seedCredential('c-agent', 'sk-agent', old);
    let reverse = false;
    // An unknown writer keeps putting old-key ciphertext back while the forward migration runs.
    controlHook = async (body) => {
      if (
        !reverse &&
        body.mode === 'verify' &&
        readJournal(stateDir)?.steps['encryption-key']?.reverse
      )
        reverse = true;
      if (!reverse && body.mode === 'verify') await seedCredential('c-agent', 'sk-agent', old);
    };
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      /rolled back/
    );
    const after = await head();
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('rolled-back');
    expect(after.ENCRYPTION_KEY).toBe(old);
    expect(after.ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    expect(await decryptWithKeyOnly(credential('c-agent').c, credential('c-agent').iv, old)).toBe(
      'sk-agent'
    );
  });

  it('refuses while secrets.env would lay a plaintext copy over the bundle', async () => {
    writeFileSync(join(stateDir, 'secrets.env'), 'ENCRYPTION_KEY=plaintext-copy\n', {
      mode: 0o600,
    });
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      /secrets.env sets ENCRYPTION_KEY/
    );
    expect(readJournal(stateDir)).toBeNull();
  });
});

describe('rotate --all', () => {
  it('replaces every key in order, keeps every stored value readable, and finishes on resume', async () => {
    const { symmetricEncrypt, symmetricDecrypt } = await import('better-auth/crypto');
    const before = await head();
    await seedCredential('c-agent', 'sk-agent', before.ENCRYPTION_KEY!);
    sqlite
      .prepare(`INSERT INTO accounts (id, access_token) VALUES ('a1', ?)`)
      .run(await symmetricEncrypt({ key: before.ENCRYPTION_KEY!, data: 'gho_x' }));
    await runRotate(input({ all: true }), deps());
    const journal = readJournal(stateDir)!;
    expect(journal.keys).toEqual([
      'agent-signing-key',
      'preview-signing-key',
      'deploy-signing-keys',
      'vapid-keys',
      'gateway-secret',
      'encryption-key',
      'better-auth-secret',
      'jwt-keys',
    ]);
    expect(journal.steps['encryption-key']?.phase).toBe('waiting');
    expect(journal.steps['better-auth-secret']?.phase).toBe('done');
    expect(journal.steps['jwt-keys']?.phase).toBe('waiting');
    expect(journal.steps['gateway-secret']?.phase).toBe('done');

    clock += 14 * HOUR;
    await runRotate(input({ resume: true }), deps());
    expect(readJournal(stateDir)).toBeNull();
    const after = await head();
    for (const name of [
      'SAM_KEY_AGENT_SIGNING_KEY',
      'PREVIEW_SIGNING_KEY',
      'DEPLOY_SIGNING_PRIVATE_KEY',
      'VAPID_PRIVATE_KEY',
      'REVERSE_TUNNEL_GATEWAY_SECRET',
      'ENCRYPTION_KEY',
      'JWT_PRIVATE_KEY',
    ]) {
      expect(after[name], name).not.toBe(before[name]);
    }
    // BetterAuth was pinned to the old ENCRYPTION_KEY first, then rotated away from it.
    expect(after.BETTER_AUTH_SECRET).not.toBe(before.ENCRYPTION_KEY);
    for (const transitional of [
      'ENCRYPTION_KEY_PREVIOUS',
      'BETTER_AUTH_SECRET_PREVIOUS',
      'JWT_PUBLIC_KEY_PREVIOUS',
      'REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE',
      'SAM_KEY_ROTATION_CONTROL_KEY',
    ]) {
      expect(after[transitional], transitional).toBeUndefined();
    }
    // The lookup-hash key stays the old value on purpose (API tokens keep matching).
    expect(after.TOKEN_HASH_KEY).toBe(before.ENCRYPTION_KEY);
    expect(restarts).toHaveLength(1);
    const key = await getDecryptedAgentKey(
      drizzle(d1, { schema }),
      'u1',
      'claude-code',
      after.ENCRYPTION_KEY!
    );
    expect(key?.credential).toBe('sk-agent');
    const token = (sqlite.prepare(`SELECT access_token AS t FROM accounts`).get() as { t: string })
      .t;
    const version = Number(after.BETTER_AUTH_SECRET_VERSION);
    expect(
      await symmetricDecrypt({
        key: { keys: new Map([[version, after.BETTER_AUTH_SECRET!]]), currentVersion: version },
        data: token,
      })
    ).toBe('gho_x');
    expect(logs.join('\n')).toContain('Done. The bundle was resealed');
  });
});

describe('the rotation lock', () => {
  it('refuses a second run while one is live, and takes over a lock left by a crash', async () => {
    const lockDir = join(stateDir, 'key-agent', 'rotation');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), String(process.pid)); // a live process (this one)
    await expect(runRotate(input({ names: ['preview-signing-key'] }), deps())).rejects.toThrow(
      /another pnpm selfhost:secrets rotate is running/
    );
    writeFileSync(join(lockDir, 'lock'), '999999999'); // no such process: a crashed run
    await runRotate(input({ names: ['preview-signing-key'] }), deps());
    expect(existsSync(join(lockDir, 'lock'))).toBe(false);
  });
});

describe('rotate jwt-keys', () => {
  it('accepts tokens signed with the old key during the overlap, refuses them after it, and finishes on resume', async () => {
    clock = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const oldEnv = { ...deployed, BASE_DOMAIN: 'example.com' } as unknown as Env;
    const oldToken = await signNodeCallbackToken('node-1', oldEnv, { callbackGeneration: null });
    await runRotate(input({ names: ['jwt-keys'], jwtOverlapHours: 25 }), deps());
    expect(readJournal(stateDir)?.steps['jwt-keys']?.phase).toBe('waiting');
    // Published alone: VM agents never trust the old key; only the Worker accepts it for callbacks.
    expect((await getJWKS(workerEnv())).keys).toHaveLength(1);
    await expect(verifyCallbackToken(oldToken, workerEnv())).resolves.toMatchObject({
      workspace: 'node-1',
    });
    const newToken = await signNodeCallbackToken('node-1', workerEnv(), {
      callbackGeneration: null,
    });
    await expect(verifyCallbackToken(newToken, workerEnv())).resolves.toMatchObject({
      workspace: 'node-1',
    });

    // Past the overlap the Worker stops accepting the old key on its own (bounded, even unfinished).
    clock += 26 * HOUR;
    vi.setSystemTime(clock);
    await expect(verifyCallbackToken(oldToken, workerEnv())).rejects.toThrow();
    await runRotate(input({ resume: true }), deps());
    expect((await head()).JWT_PUBLIC_KEY_PREVIOUS).toBeUndefined();
    expect((await getJWKS(workerEnv())).keys).toHaveLength(1);
  });
});

describe('rotate gateway-secret', () => {
  it('restarts the consumers once with the new value while the Worker accepts both, then accepts only the new one', async () => {
    const old = deployed.REVERSE_TUNNEL_GATEWAY_SECRET!;
    await runRotate(input({ names: ['gateway-secret'] }), deps());
    const now = deployed.REVERSE_TUNNEL_GATEWAY_SECRET!;
    expect(now).not.toBe(old);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toContain(`REVERSE_TUNNEL_GATEWAY_SECRET=${now}`);
    expect(isAcceptedGatewaySecret(workerEnv(), now)).toBe(true);
    expect(isAcceptedGatewaySecret(workerEnv(), old)).toBe(false);
    expect(deployed.REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE).toBeUndefined();
    // gateway.env is byte-for-byte what the deploy renders, so the next deploy does not stop.
    expect(readFileSync(join(stateDir, 'gateway.env'), 'utf8')).toBe(
      renderGatewayEnv(now, resolveTunnelSettings({}))
    );
  });
});

describe('rotate swap keys', () => {
  it('rolls a key back when the new version is not healthy', async () => {
    const old = deployed.VAPID_PUBLIC_KEY;
    let checks = 0;
    healthy = () => ++checks !== 2; // only the deploy with the new key is unhealthy
    await expect(runRotate(input({ names: ['vapid-keys'] }), deps())).rejects.toThrow(
      /rolled back/
    );
    healthy = () => true;
    expect((await head()).VAPID_PUBLIC_KEY).toBe(old);
    expect(readJournal(stateDir)?.steps['vapid-keys']?.phase).toBe('rolled-back');
  });

  it('replaces the VAPID pair and the agent signing key, and the Worker serves the new public key', async () => {
    const before = await head();
    await runRotate(input({ names: ['vapid-keys', 'agent-signing-key'] }), deps());
    const after = await head();
    expect(after.VAPID_PUBLIC_KEY).not.toBe(before.VAPID_PUBLIC_KEY);
    expect(after.SAM_KEY_AGENT_SIGNING_KEY).not.toBe(before.SAM_KEY_AGENT_SIGNING_KEY);
    expect(after.ENCRYPTION_KEY).toBe(before.ENCRYPTION_KEY);
    expect(deployed.VAPID_PUBLIC_KEY).toBe(after.VAPID_PUBLIC_KEY);
    // The snapshot keeps the old values, sealed.
    const journal = readFileSync(
      join(
        stateDir,
        'key-agent',
        'rotation',
        readdir(join(stateDir, 'key-agent', 'rotation'))[0]!,
        'journal.json'
      ),
      'utf8'
    );
    const id = JSON.parse(journal).id as string;
    const snapshot = await store().readSnapshot(id, 'vapid-keys');
    expect(snapshot.VAPID_PUBLIC_KEY).toBe(before.VAPID_PUBLIC_KEY);
  });
});

describe('rotate encryption-key: the wait for values outside D1 and R2 (review V1 L4)', () => {
  const waitMinutes = () => {
    const step = readJournal(stateDir)?.steps['encryption-key'];
    return (Date.parse(step?.waitUntil ?? '') - Date.parse(step?.switchedAt ?? '')) / 60_000;
  };

  it('waits as long as the Worker says a pending interaction can live when that was raised', async () => {
    workerVars = { ACP_INTERACTION_MAX_DEADLINE_MS: String(10 * HOUR) };
    await runRotate(input({ names: ['encryption-key'] }), deps());
    // 10 h deadline + 1 h sensitive purge + 15 min margin.
    expect(waitMinutes()).toBe(11 * 60 + 15);
    clock += 6 * HOUR; // past the default wait: not yet
    await runRotate(input({ resume: true }), deps());
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBeDefined();
  });

  it('keeps the default floor when the Worker uses the defaults (control)', async () => {
    await runRotate(input({ names: ['encryption-key'] }), deps());
    expect(waitMinutes()).toBe(5 * 60 + 15);
  });

  it('an explicit --stored-lifetime-minutes wins', async () => {
    workerVars = { ACP_INTERACTION_MAX_DEADLINE_MS: String(10 * HOUR) };
    await runRotate(input({ names: ['encryption-key'], storedLifetimeMinutes: 30 }), deps());
    expect(waitMinutes()).toBe(30);
  });
});

describe('rotate better-auth-secret', () => {
  it('moves stored OAuth tokens to the new versioned secret and ends with no previous secret', async () => {
    const { symmetricEncrypt, symmetricDecrypt } = await import('better-auth/crypto');
    const old = deployed.ENCRYPTION_KEY!; // unset BETTER_AUTH_SECRET falls back to it
    sqlite
      .prepare(`INSERT INTO accounts (id, access_token) VALUES ('a1', ?)`)
      .run(await symmetricEncrypt({ key: old, data: 'gho_x' }));
    await runRotate(input({ names: ['better-auth-secret'] }), deps());
    const after = await head();
    expect(after.BETTER_AUTH_SECRET_VERSION).toBe('1');
    expect(after.BETTER_AUTH_SECRET_PREVIOUS).toBeUndefined();
    const stored = (sqlite.prepare(`SELECT access_token AS t FROM accounts`).get() as { t: string })
      .t;
    const key = { keys: new Map([[1, after.BETTER_AUTH_SECRET!]]), currentVersion: 1 };
    expect(await symmetricDecrypt({ key, data: stored })).toBe('gho_x');
  });
});

/** Archived rotation directories (each holds its journal). */
function readdir(dir: string): string[] {
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'journal.json')));
}
