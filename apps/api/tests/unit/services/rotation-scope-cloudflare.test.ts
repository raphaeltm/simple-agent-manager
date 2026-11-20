/**
 * Cloudflare behaviour does not change with the self-host platform-key rotation.
 *
 * The rotation's read fallbacks live in shared code (encryption.ts, file-encryption.ts,
 * jwt-keys.ts, better-auth-secrets.ts) but are honoured only inside the self-host rotation scope,
 * which only the celld wrapper (selfhost/runtime-secrets.ts registerRotationKeys) turns on. These
 * tests give a Cloudflare env EVERY rotation variable (`*_PREVIOUS`, `JWT_KEY_ID`,
 * `BETTER_AUTH_SECRET_VERSION`) and assert each fallback stays off, through the real Cloudflare
 * entry (`src/index.ts`) where a request can reach it. Each block has a self-host control proving
 * the same input DOES enable the fallback once the celld wrapper ran, so a test cannot pass
 * because the fallback is broken outright.
 */
import Database from 'better-sqlite3';
import { decodeProtectedHeader, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { betterAuthSecretOptions } from '../../../src/lib/better-auth-secrets';
import { withRuntimeSecrets } from '../../../src/selfhost/runtime-secrets';
import { decrypt, encrypt } from '../../../src/services/encryption';
import {
  previousEncryptionKeyFor,
  resetSelfHostRotationScopeForTests,
  selfHostRotationScopeEnabled,
  setPreviousEncryptionKeys,
} from '../../../src/services/encryption-key-fallback';
import { decryptFile, encryptFile } from '../../../src/services/file-encryption';
import {
  shouldRefreshCallbackToken,
  signCallbackToken,
  verifyCallbackToken,
  verifyPublishJobClaims,
} from '../../../src/services/jwt';
import { LEGACY_JWT_KEY_ID } from '../../../src/services/jwt-keys';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }), {
  virtual: true,
});
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

const cloudflareWorker = await import('../../../src/index');

const BASE_DOMAIN = 'rotation-scope.example.test';
const HOUR_MS = 3600_000;

function aesKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

interface PemPair {
  privateKey: string;
  publicKey: string;
}

async function pemPair(): Promise<PemPair> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  return {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  };
}

let oldJwt: PemPair;
let newJwt: PemPair;
const OLD_AES = aesKey();
const NEW_AES = aesKey();
let sqlite: Database.Database;
let database: D1Database;

beforeAll(async () => {
  [oldJwt, newJwt] = await Promise.all([pemPair(), pemPair()]);
});

beforeEach(() => {
  resetSelfHostRotationScopeForTests();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  database = createSqliteD1(sqlite);
});

afterEach(() => {
  resetSelfHostRotationScopeForTests();
  sqlite.close();
});

/** A Cloudflare Worker env after an operator set every rotation variable by hand. */
function cloudflareEnvWithEveryRotationVar(): Env {
  return {
    DATABASE: database,
    BASE_DOMAIN,
    ENCRYPTION_KEY: NEW_AES,
    ENCRYPTION_KEY_PREVIOUS: OLD_AES,
    CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: OLD_AES,
    LIBRARY_ENCRYPTION_KEY_PREVIOUS: OLD_AES,
    JWT_PRIVATE_KEY: newJwt.privateKey,
    JWT_PUBLIC_KEY: newJwt.publicKey,
    JWT_KEY_ID: 'rotated-kid',
    JWT_PUBLIC_KEY_PREVIOUS: oldJwt.publicKey,
    JWT_PREVIOUS_KEY_ID: LEGACY_JWT_KEY_ID,
    JWT_PUBLIC_KEY_PREVIOUS_UNTIL: new Date(Date.now() + HOUR_MS).toISOString(),
    BETTER_AUTH_SECRET: 'new-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_SECRET_VERSION: '2',
    BETTER_AUTH_SECRET_PREVIOUS: 'old-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_SECRET_PREVIOUS_VERSION: '1',
  } as unknown as Env;
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

/** The same env reaching the self-host celld wrapper, which turns the scope on. */
function selfHostEnv(): Env {
  return withRuntimeSecrets(cloudflareEnvWithEveryRotationVar(), {});
}

describe('the Cloudflare Worker entry with every rotation variable set', () => {
  it('serves a request without turning the rotation scope on, and publishes the legacy kid', async () => {
    const env = cloudflareEnvWithEveryRotationVar();
    const response = await cloudflareWorker.default.fetch(
      new Request(`https://api.${BASE_DOMAIN}/.well-known/jwks.json`),
      env as never,
      ctx
    );
    // Liveness: the real entry answered from the real route.
    expect(response.status).toBe(200);
    const jwks = (await response.json()) as { keys: Array<{ kid: string }> };
    expect(jwks.keys.map((k) => k.kid)).toEqual([LEGACY_JWT_KEY_ID]);
    expect(selfHostRotationScopeEnabled()).toBe(false);
    expect(previousEncryptionKeyFor(NEW_AES)).toBeUndefined();
  });

  it('control: the celld wrapper turns the scope on and registers the previous AES key', () => {
    selfHostEnv();
    expect(selfHostRotationScopeEnabled()).toBe(true);
    expect(previousEncryptionKeyFor(NEW_AES)).toBe(OLD_AES);
  });
});

describe('AES read fallback (encryption.ts, file-encryption.ts)', () => {
  it('never decrypts with a previous key on Cloudflare, even if one was registered', async () => {
    const old = await encrypt('stored credential', OLD_AES);
    // Registering alone must not be enough: the scope gate is what keeps Cloudflare unchanged.
    setPreviousEncryptionKeys(new Map([[NEW_AES, OLD_AES]]));
    await expect(decrypt(old.ciphertext, old.iv, NEW_AES)).rejects.toThrow();

    const file = await encryptFile(new TextEncoder().encode('library file'), OLD_AES);
    await expect(decryptFile(file.ciphertext, file.metadata, NEW_AES)).rejects.toThrow();
  });

  it('control: inside the self-host scope the previous key decrypts both', async () => {
    const old = await encrypt('stored credential', OLD_AES);
    const file = await encryptFile(new TextEncoder().encode('library file'), OLD_AES);
    selfHostEnv();
    await expect(decrypt(old.ciphertext, old.iv, NEW_AES)).resolves.toBe('stored credential');
    expect(
      new TextDecoder().decode(await decryptFile(file.ciphertext, file.metadata, NEW_AES))
    ).toBe('library file');
  });
});

describe('JWT previous key and key id (jwt-keys.ts)', () => {
  async function oldKeyCallbackToken(): Promise<string> {
    const before = {
      DATABASE: database,
      BASE_DOMAIN,
      JWT_PRIVATE_KEY: oldJwt.privateKey,
      JWT_PUBLIC_KEY: oldJwt.publicKey,
    } as unknown as Env;
    return await signCallbackToken('ws-1', before, { callbackGeneration: null });
  }

  it('refuses a callback token signed with JWT_PUBLIC_KEY_PREVIOUS on Cloudflare', async () => {
    const token = await oldKeyCallbackToken();
    await expect(
      verifyCallbackToken(token, cloudflareEnvWithEveryRotationVar(), {
        expectedScope: 'workspace',
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('control: inside the self-host scope the same token is accepted in the window', async () => {
    const token = await oldKeyCallbackToken();
    await expect(
      verifyCallbackToken(token, selfHostEnv(), { expectedScope: 'workspace' })
    ).resolves.toMatchObject({ workspace: 'ws-1' });
  });

  it('signs with the legacy kid and keeps the refresh schedule on Cloudflare', async () => {
    const env = cloudflareEnvWithEveryRotationVar();
    const token = await signCallbackToken('ws-1', env, { callbackGeneration: null });
    expect(decodeProtectedHeader(token).kid).toBe(LEGACY_JWT_KEY_ID);
    // A fresh token under the legacy kid is not due for refresh (JWT_KEY_ID is ignored).
    expect(shouldRefreshCallbackToken(token, env)).toBe(false);
  });

  it('control: inside the self-host scope JWT_KEY_ID names the kid and forces a refresh of others', async () => {
    const env = selfHostEnv();
    const token = await signCallbackToken('ws-1', env, { callbackGeneration: null });
    expect(decodeProtectedHeader(token).kid).toBe('rotated-kid');
    expect(shouldRefreshCallbackToken(await oldKeyCallbackToken(), env)).toBe(true);
  });
});

describe('BetterAuth versioned secrets (better-auth-secrets.ts)', () => {
  it('passes BetterAuth only the current secret on Cloudflare, exactly as before', () => {
    expect(betterAuthSecretOptions(cloudflareEnvWithEveryRotationVar())).toEqual({
      secret: 'new-better-auth-secret-0123456789abcdef',
    });
  });

  it('control: inside the self-host scope the previous secret is kept', () => {
    const options = betterAuthSecretOptions(selfHostEnv());
    expect(options.secrets?.map((s) => s.version)).toEqual([2, 1]);
  });
});

describe('a misconfigured JWT_PUBLIC_KEY stays a server fault (as on main)', () => {
  it('is not turned into a 401 by the callback or publish-job verifiers', async () => {
    const token = await signCallbackToken('ws-1', cloudflareEnvWithEveryRotationVar(), {
      callbackGeneration: null,
    });
    const broken = { ...cloudflareEnvWithEveryRotationVar(), JWT_PUBLIC_KEY: 'not a pem' } as Env;
    const callback = await verifyCallbackToken(token, broken).catch((error: unknown) => error);
    const publishJob = await verifyPublishJobClaims(broken, token).catch((error: unknown) => error);
    for (const error of [callback, publishJob]) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { statusCode?: number }).statusCode).toBeUndefined();
    }
  });
});

