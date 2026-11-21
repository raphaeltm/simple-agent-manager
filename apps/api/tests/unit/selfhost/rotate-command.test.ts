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
import { generateAgentSigningKey } from '../../../../../scripts/selfhost/key-seal';
import {
  bundleStoreFor,
  ensureKeyServiceFiles,
  keyServiceSettings,
  listBundles,
} from '../../../../../scripts/selfhost/key-service';
import { completeSealedPlatformKeys } from '../../../../../scripts/selfhost/platform-keys';
import type { RotateDeps } from '../../../../../scripts/selfhost/rotate-apply';
import { formatRotationStatus } from '../../../../../scripts/selfhost/rotate-report';
import { drainMinutes, runRotate } from '../../../../../scripts/selfhost/rotate-run';
import {
  openRotationStore,
  readJournal,
  rotationDir,
  writeJournal,
} from '../../../../../scripts/selfhost/rotate-store';
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
import { isAcceptedGatewaySecret } from '../../../src/selfhost/reverse-tunnel/config';
import { getDecryptedAgentKey } from '../../../src/services/agent-key-resolution';
import { decryptWithKeyOnly, encrypt } from '../../../src/services/encryption';
import {
  enableSelfHostRotationScope,
  resetSelfHostRotationScopeForTests,
  setPreviousEncryptionKeys,
} from '../../../src/services/encryption-key-fallback';
import { signNodeCallbackToken } from '../../../src/services/jwt';
import { getJWKS, verifyCallbackToken } from '../../../src/services/jwt-verify';
import { ConditionalR2 } from '../../helpers/conditional-r2';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// These tests model a self-hosted box: the celld wrapper turns the rotation scope on
// (selfhost/runtime-secrets.ts registerRotationKeys). Cloudflare, where it stays off, is covered
// by tests/unit/services/rotation-scope-cloudflare.test.ts.
beforeEach(() => enableSelfHostRotationScope());
afterEach(() => resetSelfHostRotationScopeForTests());

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
let sleeps: number[] = [];
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
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
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
  // The lease table exists only on a self-host box (self-host migration, not the shared schema).
  sqlite.exec(
    readFileSync(
      new URL(
        '../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  sqlite
    .prepare(`INSERT INTO users (id, email, status) VALUES ('u1', 'u1@example.com', 'active')`)
    .run();
  d1 = createSqliteD1(sqlite);
  clock = Date.now();
  healthy = () => true;
  restarts = [];
  controlHook = null;
  logs = [];
  sleeps = [];
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
  await ensureKeyServiceFiles(settings);
  const secrets = {
    ...completeSealedPlatformKeys(stateDir, {}, 'test', 'init').keys,
    SAM_KEY_AGENT_SIGNING_KEY: generateAgentSigningKey(),
  };
  const bundle = await sealSecrets(secrets, createKeyProvider(settings.hostEnv), {
    installationId: secrets.SAM_INSTALLATION_ID,
  });
  await settings.bundles.write(bundle);
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
    const before = (await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId);
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
    expect((await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId)).toEqual(before);
  });

  it('creates nothing on disk, not even the rotation directory (box round R9/R11)', async () => {
    const tree = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? [`${e.name}/`, ...tree(join(dir, e.name)).map((f) => `${e.name}/${f}`)]
          : [e.name]
      );
    const before = tree(stateDir);
    expect(await runRotate(input({ all: true, dryRun: true }), deps())).toBeNull();
    expect(existsSync(join(stateDir, 'key-agent', 'rotation'))).toBe(false);
    expect(tree(stateDir)).toEqual(before);
  });

  it('refuses --dry-run with --resume instead of running the recorded steps without the lock (security review M1)', async () => {
    healthy = () => !logs.some((l) => l.startsWith('reseal:'));
    await expect(runRotate(input({ names: ['vapid-keys'] }), deps())).rejects.toThrow();
    const before = JSON.stringify(readJournal(stateDir));
    const bundles = (await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId);
    healthy = () => true;
    await expect(runRotate(input({ resume: true, dryRun: true }), deps())).rejects.toThrow(
      /--dry-run previews a new rotation/
    );
    expect(JSON.stringify(readJournal(stateDir))).toBe(before);
    expect((await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId)).toEqual(bundles);
    // Control: the real resume still finishes it.
    await runRotate(input({ resume: true }), deps());
    expect(readJournal(stateDir)).toBeNull();
  });

  it('with a JWT overlap of 0 says the old key is removed in this run (hard cut)', async () => {
    await runRotate(input({ names: ['jwt-keys'], jwtOverlapHours: 0, dryRun: true }), deps());
    const text = logs.join('\n');
    expect(text).toContain('hard cut');
    expect(text).toContain('removed in this run');
    expect(text).not.toContain('after the 0 h overlap');
    logs = [];
    await runRotate(input({ names: ['jwt-keys'], dryRun: true }), deps());
    // 90% of the default 24 h callback-token lifetime, plus 1 h.
    expect(logs.join('\n')).toContain('after the 23 h overlap');
  });

  it('derives the JWT overlap from the deployed callback-token lifetime (Codex P1)', async () => {
    const current = await store().head();
    const bundle = await store().seal({
      ...current.secrets,
      CALLBACK_TOKEN_EXPIRY_MS: String(48 * HOUR),
    });
    await store().write(bundle);
    await runRotate(input({ names: ['jwt-keys'] }), deps());
    // A 48 h token renewed as late as 90% of its life: 43.2 h, rounded up, plus 1 h.
    expect(readJournal(stateDir)?.options?.jwtOverlapHours).toBe(45);
    const step = readJournal(stateDir)?.steps['jwt-keys'];
    expect(Date.parse(step?.waitUntil ?? '') - clock).toBe(45 * HOUR);
  });

  it('names the bundles the run will remove (the box keeps the newest 3)', async () => {
    const existing = (await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId);
    await runRotate(input({ all: true, dryRun: true }), deps());
    const text = logs.join('\n');
    expect(text).toMatch(/keeps only the newest 3/);
    for (const id of existing) expect(text).toContain(id);
  });
});

describe('rotate --status', () => {
  it('shows a reseal that was sealed but not confirmed deployed (box round R11)', async () => {
    let checks = 0;
    // Every check healthy except the one after the final reseal's deploy.
    healthy = () => {
      checks += 1;
      return !logs.some((l) => l.startsWith('reseal:')) || checks < 0;
    };
    await expect(runRotate(input({ names: ['vapid-keys'] }), deps())).rejects.toThrow(
      /not healthy/
    );
    const staged = readJournal(stateDir)?.steps.reseal;
    expect(staged?.phase).toBe('staging');
    const status = formatRotationStatus(stateDir).join('\n');
    expect(status).toContain(`reseal: staging`);
    expect(status).toContain(staged?.stagedBundleId ?? 'missing');
    expect(status).toContain('rotate --resume');
    healthy = () => true;
    await runRotate(input({ resume: true }), deps());
    expect(formatRotationStatus(stateDir)).toEqual(['no rotation in progress']);
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
    // better-auth-secret and runs it first, so the switch never pins the old key (review V1 M2).
    const journal = readJournal(stateDir);
    expect(journal?.keys).toEqual(['better-auth-secret', 'encryption-key']);
    expect(journal?.steps['encryption-key']?.signInSecretPinned).toBeUndefined();
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

    // A lease request that started on the old deployment commits during the drain (Codex P1).
    const switchedAt = Date.parse(readJournal(stateDir)!.steps['encryption-key']!.switchedAt!);
    const inDrain = new Date(switchedAt + 60_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO node_reverse_tunnel_leases (id, node_id, user_id, runtime_incarnation_id, port, credential_hash, status, created_at, updated_at)
         VALUES ('lease-drain', 'n-drain', 'u1', 'inc', 20002, 'h', 'active', ?, ?)`
      )
      .run(inDrain, inDrain);
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
    expect(logs.join('\n')).toContain(
      '2 reverse-tunnel node(s) created before the switch or during its drain'
    );
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
      // The encryption key's own pages (the chained sign-in step runs its pass first).
      if (body.mode === 'migrate' && body.target === 'd1' && ++calls === 2)
        throw new Error('box lost power');
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

  it('resumes an interrupted verify pass of the recorded round instead of starting a new round (Codex P2)', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    for (let i = 0; i < 3; i += 1) await seedCredential(`c-${i}`, `secret-${i}`, old);
    let migratedD1 = false;
    let thrown = false;
    controlHook = async (body) => {
      if (body.target !== 'd1') return;
      if (body.mode === 'migrate') migratedD1 = true;
      // The first verify page after round 1's migrate: the box stops mid-verify.
      if (body.mode === 'verify' && migratedD1 && !thrown) {
        thrown = true;
        throw new Error('box lost power during verify');
      }
    };
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      'box lost power during verify'
    );
    const stopped = readJournal(stateDir)?.steps['encryption-key'];
    expect(stopped?.migrateRounds).toBe(1);
    expect(stopped?.pass).toContain('verify:1');
    controlHook = null;
    logs = [];
    await runRotate(input({ resume: true }), deps());
    // Round 1's verify finished; no extra migrate round was started and nothing rolled back.
    expect(logs.some((line) => line.includes('round 2'))).toBe(false);
    expect(logs.some((line) => line.includes('FAILED'))).toBe(false);
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('waiting');
    const current = (await head()).ENCRYPTION_KEY!;
    for (let i = 0; i < 3; i += 1) {
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

  it('drains a rollback from its reverse deployment, not from the forward switch (Codex P1)', async () => {
    const old = deployed.ENCRYPTION_KEY!;
    await seedCredential('c-agent', 'sk-agent', old);
    let reverse = false;
    controlHook = async (body) => {
      if (
        !reverse &&
        body.mode === 'verify' &&
        readJournal(stateDir)?.steps['encryption-key']?.reverse
      )
        reverse = true;
      if (!reverse && body.mode === 'verify') {
        await seedCredential('c-agent', 'sk-agent', old);
        clock += 10 * 60_000; // the forward migration outlasts the drain
      }
    };
    // The rollback keeps the new value readable for the drain plus the stored-value lifetime.
    await runRotate(input({ names: ['encryption-key'] }), deps());
    expect(readJournal(stateDir)?.steps['encryption-key']?.reverse).toBe(true);
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('waiting');
    controlHook = null;
    clock += 6 * HOUR;
    await expect(runRotate(input({ resume: true }), deps())).rejects.toThrow(/rolled back/);
    const step = readJournal(stateDir)?.steps['encryption-key'];
    expect(step?.phase).toBe('rolled-back');
    expect(Date.parse(step?.waitUntil ?? '') - Date.parse(step?.reverseSwitchedAt ?? '')).toBe(
      (drainMinutes({}) + 5 * 60 + 16) * 60_000
    );
    expect(Date.parse(step?.reverseSwitchedAt ?? '')).toBeGreaterThan(
      Date.parse(step?.switchedAt ?? '') + drainMinutes({}) * 60_000
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
    // The rollback keeps the new value readable for the drain plus the stored-value lifetime.
    await runRotate(input({ names: ['encryption-key'] }), deps());
    expect(readJournal(stateDir)?.steps['encryption-key']?.reverse).toBe(true);
    expect(readJournal(stateDir)?.steps['encryption-key']?.phase).toBe('waiting');
    controlHook = null;
    clock += 6 * HOUR;
    await expect(runRotate(input({ resume: true }), deps())).rejects.toThrow(/rolled back/);
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

describe('rotate: which sealed bundles it removed', () => {
  it('lists the pre-rotation bundles the newest-3 rule removed in the summary and the journal', async () => {
    const existing = (await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId);
    const journal = await runRotate(input({ names: ['vapid-keys', 'agent-signing-key'] }), deps());
    const remaining = (await listBundles(bundleStoreFor(stateDir))).map((b) => b.bundleId);
    for (const id of existing) expect(remaining).not.toContain(id);
    expect(journal?.removedBundles).toEqual(expect.arrayContaining(existing));
    const text = logs.join('\n');
    expect(text).toMatch(new RegExp(`Removed sealed bundles[^\\n]*${existing[0]}`));
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
      // BETTER_AUTH_SECRET was unset: the sign-in secret moves before the key it fell back to.
      'better-auth-secret',
      'encryption-key',
      'jwt-keys',
    ]);
    expect(journal.steps['encryption-key']?.phase).toBe('waiting');
    expect(journal.steps['better-auth-secret']?.phase).toBe('done');
    expect(journal.steps['jwt-keys']?.phase).toBe('waiting');
    expect(journal.steps['gateway-secret']?.phase).toBe('done');

    clock += 24 * HOUR; // past the default JWT overlap (23 h) and the encryption-key wait
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

  it('takes over a stale lock only exclusively (Codex P2)', async () => {
    const lockDir = join(stateDir, 'key-agent', 'rotation');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), '999999999'); // a crashed run
    // Another run is in the middle of taking the same stale lock over.
    writeFileSync(join(lockDir, 'lock.takeover'), '');
    await expect(runRotate(input({ names: ['preview-signing-key'] }), deps())).rejects.toThrow(
      /taking over a stale lock/
    );
    // Neither the stale lock nor the other run's takeover was touched.
    expect(readFileSync(join(lockDir, 'lock'), 'utf8')).toBe('999999999');
    expect(existsSync(join(lockDir, 'lock.takeover'))).toBe(true);
  });
});

describe('rotate jwt-keys', () => {
  it('does not retire the old key when a run stopped before the overlap deadline was recorded (Codex P1)', async () => {
    clock = Date.now();
    await runRotate(input({ names: ['jwt-keys'], jwtOverlapHours: 25 }), deps());
    const journal = readJournal(stateDir)!;
    const step = journal.steps['jwt-keys']!;
    expect(step.phase).toBe('waiting');
    const recorded = step.waitUntil;
    // The state a stop leaves between the overlap deploy and the deadline save.
    delete step.waitUntil;
    writeJournal(stateDir, journal);
    await runRotate(input({ resume: true }), deps());
    // Still in the overlap: the previous key is kept and the deadline is recorded again.
    expect((await head()).JWT_PUBLIC_KEY_PREVIOUS).toBeDefined();
    expect(readJournal(stateDir)?.steps['jwt-keys']?.phase).toBe('waiting');
    expect(readJournal(stateDir)?.steps['jwt-keys']?.waitUntil).toBe(recorded);
  });

  it('counts the overlap from the resume when a run died between sealing and deploying (Codex P1)', async () => {
    clock = Date.now();
    const oldKey = deployed.JWT_PUBLIC_KEY;
    // The process dies inside the overlap deploy: the bundle is sealed and recorded, never deployed.
    const dying = { ...deps(), deploy: () => new Promise<void>(() => {}) };
    void runRotate(input({ names: ['jwt-keys'], jwtOverlapHours: 25 }), dying);
    await vi.waitFor(() =>
      expect(readJournal(stateDir)?.steps['jwt-keys']?.stagedFor).toBe('waiting')
    );
    const staged = await head();
    rmSync(join(stateDir, 'key-agent', 'rotation', 'lock'), { force: true });

    clock += 30 * HOUR; // offline past the deadline sealed into the staged bundle
    await runRotate(input({ resume: true }), deps());
    const after = await head();
    const step = readJournal(stateDir)?.steps['jwt-keys'];
    expect(step?.phase).toBe('waiting');
    // The old key is still the accepted previous key, with the overlap counted from the resume.
    expect(after.JWT_PUBLIC_KEY_PREVIOUS).toBe(oldKey);
    expect(Date.parse(step!.waitUntil!)).toBe(clock + 25 * HOUR);
    // The staged key pair was kept (it may already have signed tokens).
    expect(after.JWT_PUBLIC_KEY).toBe(staged.JWT_PUBLIC_KEY);
    expect(Date.parse(after.JWT_PUBLIC_KEY_PREVIOUS_UNTIL!)).toBe(clock + 25 * HOUR);
  });

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
  it('does not count a 5xx from the authenticated plugin path as acceptance (Codex P2)', async () => {
    const old = deployed.REVERSE_TUNNEL_GATEWAY_SECRET!;
    const failing = deps();
    // The Worker authenticates the new secret but its plugin path then fails.
    failing.probeGateway = async (secret) =>
      isAcceptedGatewaySecret(workerEnv(), secret) ? (secret === old ? 200 : 500) : 401;
    await expect(runRotate(input({ names: ['gateway-secret'] }), failing)).rejects.toThrow(
      /rolled back/
    );
    expect(readJournal(stateDir)?.steps['gateway-secret']?.error).toMatch(/HTTP 500/);
    expect(deployed.REVERSE_TUNNEL_GATEWAY_SECRET).toBe(old);
  });

  it('finishes the rollback on resume when restoring the consumers failed (Codex P1)', async () => {
    const old = deployed.REVERSE_TUNNEL_GATEWAY_SECRET!;
    const failing = deps();
    // After the switch the Worker seems to still accept the old secret: the step fails.
    failing.probeGateway = async (secret) =>
      secret === old && restarts.length > 0
        ? 200
        : isAcceptedGatewaySecret(workerEnv(), secret)
          ? 200
          : 401;
    // ...and restarting the consumers back onto the old secret fails too.
    failing.restartGatewayConsumers = async () => {
      restarts.push(readFileSync(join(stateDir, 'gateway.env'), 'utf8'));
      if (restarts.length > 1) throw new Error('systemctl restart frps failed');
    };
    await expect(runRotate(input({ names: ['gateway-secret'] }), failing)).rejects.toThrow(
      /systemctl restart frps failed/
    );
    expect(readJournal(stateDir)?.steps['gateway-secret']?.phase).not.toBe('rolled-back');
    restarts = [];
    await expect(runRotate(input({ resume: true }), deps())).rejects.toThrow(/rolled back/);
    // The resume restored gateway.env and the Worker to the old secret instead of marking it done,
    // and restarted the consumers even though gateway.env already held the old value (Codex P1).
    expect(restarts.at(-1)).toContain(`REVERSE_TUNNEL_GATEWAY_SECRET=${old}`);
    expect(readJournal(stateDir)?.steps['gateway-secret']?.phase).toBe('rolled-back');
    expect(deployed.REVERSE_TUNNEL_GATEWAY_SECRET).toBe(old);
    expect(readFileSync(join(stateDir, 'gateway.env'), 'utf8')).toContain(
      `REVERSE_TUNNEL_GATEWAY_SECRET=${old}`
    );
  });

  it('leaves the step pending when it fails before its snapshot exists (Codex P2)', async () => {
    const old = deployed.REVERSE_TUNNEL_GATEWAY_SECRET!;
    const failing = deps();
    // Just before the step starts, make its snapshot directory impossible to create.
    failing.log = (line) => {
      logs.push(line);
      const id = readJournal(stateDir)?.id;
      if (line.startsWith('gateway-secret (') && id)
        writeFileSync(join(rotationDir(stateDir), id), '');
    };
    await expect(runRotate(input({ names: ['gateway-secret'] }), failing)).rejects.toThrow();
    const stopped = readJournal(stateDir)!;
    expect(stopped.steps['gateway-secret']?.phase).toBe('pending');
    expect(stopped.steps['gateway-secret']?.error).toBeUndefined();
    rmSync(join(rotationDir(stateDir), stopped.id), { force: true });
    await runRotate(input({ resume: true }), deps());
    // Control: the resume ran the whole rotation.
    expect(readJournal(stateDir)).toBeNull();
    expect(deployed.REVERSE_TUNNEL_GATEWAY_SECRET).not.toBe(old);
  });

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
    // The resume finishes the run (reseal) but still fails: the key was never replaced (Codex P1).
    await expect(runRotate(input({ resume: true }), deps())).rejects.toThrow(
      /vapid-keys: rolled back, not replaced/
    );
    expect(readJournal(stateDir)).toBeNull(); // the run is closed, not left in progress
    expect((await head()).VAPID_PUBLIC_KEY).toBe(old);
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

describe('rotate encryption-key with a purpose key of the same value (Codex P1)', () => {
  async function withCredentialKeyEqualToRoot() {
    const current = await store().head();
    await store().write(
      await store().seal({
        ...current.secrets,
        CREDENTIAL_ENCRYPTION_KEY: current.secrets.ENCRYPTION_KEY!,
      })
    );
  }

  it('refuses to rotate encryption-key alone, since the old value would stay in use', async () => {
    await withCredentialKeyEqualToRoot();
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      /CREDENTIAL_ENCRYPTION_KEY holds the same value as ENCRYPTION_KEY/
    );
    expect(readJournal(stateDir)).toBeNull();
  });

  it('refuses to rotate one purpose key alone while its sibling holds the same value (Codex P1)', async () => {
    const current = await store().head();
    await store().write(
      await store().seal({
        ...current.secrets,
        CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(43) + '=',
        LIBRARY_ENCRYPTION_KEY: 'c'.repeat(43) + '=',
      })
    );
    await expect(
      runRotate(input({ names: ['credential-encryption-key'], dryRun: true }), deps())
    ).rejects.toThrow(/LIBRARY_ENCRYPTION_KEY holds the same value as CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('rotates encryption-key alone when both purpose keys have their own values (Codex P1)', async () => {
    const current = await store().head();
    await store().write(
      await store().seal({
        ...current.secrets,
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        LIBRARY_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      })
    );
    await runRotate(input({ names: ['encryption-key'] }), deps());
    // No stored row resolves through ENCRYPTION_KEY: an expiry-only rotation, not a stuck one.
    const step = readJournal(stateDir)?.steps['encryption-key'];
    expect(step?.phase).toBe('waiting');
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBe(current.secrets.ENCRYPTION_KEY);
    clock += 6 * HOUR;
    await runRotate(input({ resume: true }), deps());
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });

  it('accepts both in one run (control)', async () => {
    await withCredentialKeyEqualToRoot();
    await runRotate(
      input({ names: ['encryption-key', 'credential-encryption-key'], dryRun: true }),
      deps()
    );
    expect(logs.join('\n')).toContain('credential-encryption-key');
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
    // 10 h deadline + 1 min URL deadline margin + 1 h sensitive purge + 15 min margin.
    expect(waitMinutes()).toBe(drainMinutes({}) + 11 * 60 + 16);
    clock += 6 * HOUR; // past the default wait: not yet
    await runRotate(input({ resume: true }), deps());
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBeDefined();
  });

  it('keeps the default floor when the Worker uses the defaults (control)', async () => {
    await runRotate(input({ names: ['encryption-key'] }), deps());
    expect(waitMinutes()).toBe(drainMinutes({}) + 5 * 60 + 16);
  });

  it('stops instead of guessing when the Worker cannot report the lifetime', async () => {
    controlHook = async (body) => {
      if (body.purpose === 'stored-lifetime') throw new Error('status unavailable');
    };
    await expect(runRotate(input({ names: ['encryption-key'] }), deps())).rejects.toThrow(
      /did not report how long values outside D1\/R2 live/
    );
    expect(readJournal(stateDir)?.steps['encryption-key']?.waitUntil).toBeUndefined();
    controlHook = null;
    await runRotate(input({ resume: true }), deps());
    expect(waitMinutes()).toBe(drainMinutes({}) + 5 * 60 + 16);
  });

  it('a resume keeps the --stored-lifetime-minutes the run started with (Codex P1)', async () => {
    // The run stops mid-migration, before the wait is computed; the resume passes no flag.
    await seedCredential('c-opt', 'secret-opt', deployed.ENCRYPTION_KEY!);
    controlHook = async (body) => {
      if (body.mode === 'migrate' && body.target === 'd1') throw new Error('box lost power');
    };
    await expect(
      runRotate(input({ names: ['encryption-key'], storedLifetimeMinutes: 600 }), deps())
    ).rejects.toThrow();
    controlHook = null;
    await runRotate(input({ resume: true }), deps());
    expect(waitMinutes()).toBe(drainMinutes({}) + 600);
    clock += 6 * HOUR; // past the default wait, inside the requested one: the old key stays
    await runRotate(input({ resume: true }), deps());
    expect((await head()).ENCRYPTION_KEY_PREVIOUS).toBeDefined();
  });

  it('refuses a resume that passes a different timing flag than the run started with', async () => {
    await runRotate(input({ names: ['encryption-key'], storedLifetimeMinutes: 600 }), deps());
    await expect(
      runRotate(input({ resume: true, storedLifetimeMinutes: 30 }), deps())
    ).rejects.toThrow(/started with --stored-lifetime-minutes 600/);
    // The same value is accepted.
    await runRotate(input({ resume: true, storedLifetimeMinutes: 600 }), deps());
  });

  it('an explicit --stored-lifetime-minutes wins', async () => {
    workerVars = { ACP_INTERACTION_MAX_DEADLINE_MS: String(10 * HOUR) };
    await runRotate(input({ names: ['encryption-key'], storedLifetimeMinutes: 30 }), deps());
    expect(waitMinutes()).toBe(drainMinutes({}) + 30);
  });
});

describe('rotate better-auth-secret', () => {
  it('keeps the old secret until requests on the previous version have drained (Codex P1)', async () => {
    await runRotate(input({ names: ['better-auth-secret'] }), deps());
    const step = readJournal(stateDir)?.steps['better-auth-secret'] ?? null;
    // Finished in this run (the drain is waited out in-process), but never before the drain.
    expect(readJournal(stateDir)).toBeNull();
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
      drainMinutes({}) * 60_000 - 1000
    );
    expect(step).toBeNull();
    expect((await head()).BETTER_AUTH_SECRET_PREVIOUS).toBeUndefined();
  });

  it('without an in-process wait, stops in waiting with the old secret still readable (control)', async () => {
    const noSleep = deps();
    delete noSleep.sleep;
    await runRotate(input({ names: ['better-auth-secret'] }), noSleep);
    const step = readJournal(stateDir)?.steps['better-auth-secret'];
    expect(step?.phase).toBe('waiting');
    expect(Date.parse(step?.waitUntil ?? '') - Date.parse(step?.switchedAt ?? '')).toBe(
      drainMinutes({}) * 60_000
    );
    expect((await head()).BETTER_AUTH_SECRET_PREVIOUS).toBeDefined();
  });

  it('a resume keeps the drain the run started with (Codex P1)', async () => {
    const { symmetricEncrypt } = await import('better-auth/crypto');
    sqlite
      .prepare(`INSERT INTO accounts (id, access_token) VALUES ('a1', ?)`)
      .run(await symmetricEncrypt({ key: deployed.ENCRYPTION_KEY!, data: 'gho_x' }));
    // The run stops mid-migration, before the drain's end is recorded.
    controlHook = async (body) => {
      if (body.mode === 'migrate') throw new Error('box lost power');
    };
    await expect(runRotate(input({ names: ['better-auth-secret'] }), deps())).rejects.toThrow(
      'box lost power'
    );
    expect(readJournal(stateDir)?.options?.drainMinutes).toBe(drainMinutes({}));
    controlHook = null;
    // The operator lowers the budget before resuming: the recorded drain still applies.
    const noSleep = deps();
    delete noSleep.sleep;
    await runRotate(
      { ...input({ resume: true }), box: { ...BOX, CELLD_HANDLER_BUDGET_S: '30' } },
      noSleep
    );
    const step = readJournal(stateDir)?.steps['better-auth-secret'];
    expect(Date.parse(step?.waitUntil ?? '') - Date.parse(step?.switchedAt ?? '')).toBe(
      drainMinutes({}) * 60_000
    );
  });

  it('derives the drain from the box CELLD_HANDLER_BUDGET_S', () => {
    expect(drainMinutes({})).toBe(6);
    expect(drainMinutes({ CELLD_HANDLER_BUDGET_S: '900' })).toBe(16);
  });

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

  it('a rollback of a later rotation restores the old secret under its own version (Codex P1)', async () => {
    const { symmetricEncrypt, symmetricDecrypt } = await import('better-auth/crypto');
    sqlite
      .prepare(`INSERT INTO accounts (id, access_token) VALUES ('a1', ?)`)
      .run(await symmetricEncrypt({ key: deployed.ENCRYPTION_KEY!, data: 'gho_x' }));
    await runRotate(input({ names: ['better-auth-secret'] }), deps());
    const v1 = await head();
    expect(v1.BETTER_AUTH_SECRET_VERSION).toBe('1');
    const keyV1 = { keys: new Map([[1, v1.BETTER_AUTH_SECRET!]]), currentVersion: 1 };
    // During the second rotation's forward migration, a writer keeps adding version-1 tokens.
    let reverse = false;
    controlHook = async (body) => {
      if (readJournal(stateDir)?.steps['better-auth-secret']?.reverse) reverse = true;
      if (!reverse && body.mode === 'verify') {
        sqlite
          .prepare(`INSERT OR REPLACE INTO accounts (id, access_token) VALUES ('a2', ?)`)
          .run(await symmetricEncrypt({ key: keyV1, data: 'gho_late' }));
      }
    };
    await expect(runRotate(input({ names: ['better-auth-secret'] }), deps())).rejects.toThrow(
      /rolled back/
    );
    const after = await head();
    // Back where it started: the original secret under its original version, nothing previous.
    expect(after.BETTER_AUTH_SECRET).toBe(v1.BETTER_AUTH_SECRET);
    expect(after.BETTER_AUTH_SECRET_VERSION).toBe('1');
    expect(after.BETTER_AUTH_SECRET_PREVIOUS).toBeUndefined();
    for (const id of ['a1', 'a2']) {
      const row = sqlite.prepare(`SELECT access_token AS t FROM accounts WHERE id = ?`).get(id) as {
        t: string;
      };
      await expect(symmetricDecrypt({ key: keyV1, data: row.t })).resolves.toMatch(/^gho_/);
    }
  });
});

/** Archived rotation directories (each holds its journal). */
function readdir(dir: string): string[] {
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'journal.json')));
}
