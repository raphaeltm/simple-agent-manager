/**
 * Self-hosted RS256 JWT key rotation with a bounded overlap window.
 *
 * Real jose, real generated RSA key pairs. "Before rotation" tokens are minted by the real signers
 * running with the previous key pair as the current key, exactly as an install signed them before
 * it rotated.
 */
import Database from 'better-sqlite3';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  getJWKS,
  signCallbackToken,
  signLocalForwardToken,
  signPortAccessToken,
  signTerminalToken,
  verifyCallbackToken,
  verifyLocalForwardToken,
  verifyPortAccessToken,
  verifyTerminalToken,
} from '../../../src/services/jwt';
import {
  activePreviousJwtKey,
  LEGACY_JWT_KEY_ID,
  parsePreviousJwtKeyUntil,
} from '../../../src/services/jwt-keys';
import { verifyPlatformJwt } from '../../../src/services/jwt-verify';
import {
  getWorkloadJWKS,
  signWorkloadIdentityToken,
} from '../../../src/services/workload-identity-token';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

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

const BASE_DOMAIN = 'example.test';
const ISSUER = `https://api.${BASE_DOMAIN}`;
const HOUR_MS = 60 * 60 * 1000;
const NEW_KID = 'sam-2026-11-13';

let current: PemPair;
let previous: PemPair;
let unrelated: PemPair;
let sqlite: Database.Database;
let database: D1Database;

beforeAll(async () => {
  [current, previous, unrelated] = await Promise.all([pemPair(), pemPair(), pemPair()]);
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  database = createSqliteD1(sqlite);
});

afterEach(() => sqlite.close());

function keyEnv(pair: PemPair, extra: Partial<Env> = {}): Env {
  return {
    DATABASE: database,
    BASE_DOMAIN,
    JWT_PRIVATE_KEY: pair.privateKey,
    JWT_PUBLIC_KEY: pair.publicKey,
    ...extra,
  } as unknown as Env;
}

/** The install before it rotated: the previous pair is the current key, no rotation variables. */
function beforeRotationEnv(): Env {
  return keyEnv(previous);
}

/** The install after it rotated, with the previous public key retained until `until`. */
function rotatedEnv(until: string | undefined, extra: Partial<Env> = {}): Env {
  return keyEnv(current, {
    JWT_KEY_ID: NEW_KID,
    JWT_PUBLIC_KEY_PREVIOUS: previous.publicKey,
    ...(until === undefined ? {} : { JWT_PUBLIC_KEY_PREVIOUS_UNTIL: until }),
    ...extra,
  });
}

const inOneHour = () => new Date(Date.now() + HOUR_MS).toISOString();
const oneHourAgo = () => new Date(Date.now() - HOUR_MS).toISOString();

interface VerifierCase {
  name: string;
  sign: (env: Env) => Promise<string>;
  verify: (token: string, env: Env) => Promise<unknown>;
  accepted: Record<string, unknown>;
  /** How this verifier reports a token it does not trust. */
  refusal: Record<string, unknown>;
}

const SIGNATURE_REFUSAL = { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' };

const verifiers: VerifierCase[] = [
  {
    name: 'verifyCallbackToken',
    sign: (env) => signCallbackToken('ws-1', env, { callbackGeneration: null }),
    verify: (token, env) => verifyCallbackToken(token, env, { expectedScope: 'workspace' }),
    accepted: { workspace: 'ws-1', type: 'callback', scope: 'workspace' },
    refusal: { statusCode: 401, error: 'UNAUTHORIZED' },
  },
  {
    name: 'verifyTerminalToken',
    sign: async (env) => (await signTerminalToken('user-1', 'ws-1', env)).token,
    verify: verifyTerminalToken,
    accepted: { workspace: 'ws-1', subject: 'user-1' },
    refusal: SIGNATURE_REFUSAL,
  },
  {
    name: 'verifyPortAccessToken',
    sign: (env) => signPortAccessToken('user-1', 'ws-1', 3000, env),
    verify: verifyPortAccessToken,
    accepted: { workspace: 'ws-1', port: 3000, subject: 'user-1' },
    refusal: SIGNATURE_REFUSAL,
  },
  {
    name: 'verifyLocalForwardToken',
    sign: async (env) =>
      (
        await signLocalForwardToken(
          {
            userId: 'user-1',
            workspaceId: 'ws-1',
            nodeId: 'node-1',
            remotePort: 3000,
            mode: 'http',
            localAuthority: '127.0.0.1:3000',
          },
          env
        )
      ).token,
    verify: verifyLocalForwardToken,
    accepted: { userId: 'user-1', workspaceId: 'ws-1', nodeId: 'node-1', remotePort: 3000 },
    refusal: SIGNATURE_REFUSAL,
  },
];

describe('activePreviousJwtKey', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const env = (extra: Partial<Env>) =>
    ({ JWT_PUBLIC_KEY_PREVIOUS: 'PEM', ...extra }) as unknown as Env;

  it('is active strictly before UNTIL and carries the configured kid', () => {
    expect(
      activePreviousJwtKey(
        env({ JWT_PUBLIC_KEY_PREVIOUS_UNTIL: '2026-11-14T00:00:00Z', JWT_PREVIOUS_KEY_ID: 'old' }),
        now
      )
    ).toEqual({ publicKeyPem: 'PEM', kid: 'old', untilMs: Date.parse('2026-11-14T00:00:00Z') });
  });

  it('defaults the previous kid to the legacy key-YYYY-MM value', () => {
    expect(
      activePreviousJwtKey(env({ JWT_PUBLIC_KEY_PREVIOUS_UNTIL: '2026-11-14T00:00:00+02:00' }), now)
        ?.kid
    ).toBe(LEGACY_JWT_KEY_ID);
  });

  it('is inactive at and after UNTIL', () => {
    expect(
      activePreviousJwtKey(env({ JWT_PUBLIC_KEY_PREVIOUS_UNTIL: '2026-11-13T12:00:00Z' }), now)
    ).toBeNull();
    expect(
      activePreviousJwtKey(env({ JWT_PUBLIC_KEY_PREVIOUS_UNTIL: '2026-11-13T11:59:59Z' }), now)
    ).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['garbage', 'not-a-date'],
    ['date only', '2026-12-01'],
    ['no offset (local time)', '2026-12-01T00:00:00'],
    ['impossible date', '2026-13-45T00:00:00Z'],
    ['free-form date', 'December 1, 2026'],
  ])('fails closed when UNTIL is %s', (_label, until) => {
    expect(parsePreviousJwtKeyUntil(until)).toBeNull();
    expect(
      activePreviousJwtKey(
        env(until === undefined ? {} : { JWT_PUBLIC_KEY_PREVIOUS_UNTIL: until }),
        now
      )
    ).toBeNull();
  });

  it('is inactive without a previous key even when UNTIL is valid', () => {
    expect(
      activePreviousJwtKey(
        { JWT_PUBLIC_KEY_PREVIOUS_UNTIL: '2026-11-14T00:00:00Z' } as unknown as Env,
        now
      )
    ).toBeNull();
  });
});

describe.each(verifiers)('$name across a key rotation', (verifier) => {
  it('accepts a token the previous key signed while the window is open', async () => {
    const token = await verifier.sign(beforeRotationEnv());
    await expect(verifier.verify(token, rotatedEnv(inOneHour()))).resolves.toMatchObject(
      verifier.accepted
    );
  });

  it('accepts a token the current key signs (liveness of the current path)', async () => {
    const env = rotatedEnv(inOneHour());
    await expect(verifier.verify(await verifier.sign(env), env)).resolves.toMatchObject(
      verifier.accepted
    );
  });

  it('refuses a previous-key token once UNTIL has passed', async () => {
    const token = await verifier.sign(beforeRotationEnv());
    await expect(verifier.verify(token, rotatedEnv(oneHourAgo()))).rejects.toMatchObject(
      verifier.refusal
    );
  });

  it('refuses a previous-key token when UNTIL is absent', async () => {
    const token = await verifier.sign(beforeRotationEnv());
    await expect(verifier.verify(token, rotatedEnv(undefined))).rejects.toMatchObject(
      verifier.refusal
    );
  });

  it('refuses a previous-key token when UNTIL is garbage', async () => {
    const token = await verifier.sign(beforeRotationEnv());
    await expect(verifier.verify(token, rotatedEnv('next tuesday'))).rejects.toMatchObject(
      verifier.refusal
    );
  });

  it('refuses a token signed by an unrelated key even while the window is open', async () => {
    const token = await verifier.sign(keyEnv(unrelated));
    await expect(verifier.verify(token, rotatedEnv(inOneHour()))).rejects.toMatchObject(
      verifier.refusal
    );
  });

  it('refuses a previous-key token whose previous public key is malformed', async () => {
    const token = await verifier.sign(beforeRotationEnv());
    const env = rotatedEnv(inOneHour(), { JWT_PUBLIC_KEY_PREVIOUS: 'not a pem' });
    await expect(verifier.verify(token, env)).rejects.toMatchObject(verifier.refusal);
  });
});

describe('claim checks on the previous-key path', () => {
  async function previousKeyToken(build: (jwt: SignJWT) => SignJWT): Promise<string> {
    const jwt = new SignJWT({ workspace: 'ws-1', port: 3000 })
      .setProtectedHeader({ alg: 'RS256', kid: LEGACY_JWT_KEY_ID })
      .setSubject('user-1')
      .setIssuedAt();
    return build(jwt).sign(await importPKCS8(previous.privateKey, 'RS256'));
  }

  it('refuses a wrong audience: a previous-key terminal token is not a port-access token', async () => {
    const token = (await signTerminalToken('user-1', 'ws-1', beforeRotationEnv())).token;
    await expect(verifyPortAccessToken(token, rotatedEnv(inOneHour()))).rejects.toMatchObject({
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
      claim: 'aud',
    });
  });

  it('refuses a wrong audience on the callback verifier with 401', async () => {
    const token = (await signTerminalToken('user-1', 'ws-1', beforeRotationEnv())).token;
    await expect(verifyCallbackToken(token, rotatedEnv(inOneHour()))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('refuses a wrong issuer', async () => {
    const token = await previousKeyToken((jwt) =>
      jwt.setIssuer('https://api.other.test').setAudience('port-access').setExpirationTime('5m')
    );
    await expect(verifyPortAccessToken(token, rotatedEnv(inOneHour()))).rejects.toMatchObject({
      claim: 'iss',
    });
  });

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const token = await previousKeyToken((jwt) =>
      jwt
        .setIssuer(ISSUER)
        .setAudience('port-access')
        .setIssuedAt(past)
        .setExpirationTime(past + 60)
    );
    await expect(verifyPortAccessToken(token, rotatedEnv(inOneHour()))).rejects.toMatchObject({
      code: 'ERR_JWT_EXPIRED',
    });
  });

  it('control: the same hand-built token with valid claims is accepted', async () => {
    const token = await previousKeyToken((jwt) =>
      jwt.setIssuer(ISSUER).setAudience('port-access').setExpirationTime('5m')
    );
    await expect(verifyPortAccessToken(token, rotatedEnv(inOneHour()))).resolves.toMatchObject({
      workspace: 'ws-1',
      port: 3000,
    });
  });

  it('verifyPlatformJwt honours the window at the instant it is given', async () => {
    const token = (await signTerminalToken('user-1', 'ws-1', beforeRotationEnv())).token;
    const until = Date.now() + HOUR_MS;
    const env = rotatedEnv(new Date(until).toISOString());
    const options = { issuer: ISSUER, audience: 'workspace-terminal' };
    await expect(verifyPlatformJwt(token, env, options, until - 1)).resolves.toBeDefined();
    await expect(verifyPlatformJwt(token, env, options, until)).rejects.toMatchObject(
      SIGNATURE_REFUSAL
    );
  });
});

describe('/.well-known/jwks.json', () => {
  it('with no rotation variables: one key, kid key-YYYY-MM, signed tokens carry it', async () => {
    const env = keyEnv(current);
    const now = new Date();
    const expectedKid = `key-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(LEGACY_JWT_KEY_ID).toBe(expectedKid);
    expect(await getJWKS(env)).toEqual({
      keys: [
        {
          ...(await exportJWK(await importSPKI(current.publicKey, 'RS256'))),
          kid: expectedKid,
          use: 'sig',
          alg: 'RS256',
        },
      ],
    });
    const token = await signCallbackToken('ws-1', env, { callbackGeneration: null });
    expect(decodeProtectedHeader(token).kid).toBe(expectedKid);
    expect(decodeProtectedHeader((await signTerminalToken('u', 'ws-1', env)).token).kid).toBe(
      expectedKid
    );
  });

  it('signs and publishes the current key under JWT_KEY_ID when set', async () => {
    const env = keyEnv(current, { JWT_KEY_ID: NEW_KID });
    const { keys } = await getJWKS(env);
    expect(keys.map((key) => key.kid)).toEqual([NEW_KID]);
    const token = await signPortAccessToken('user-1', 'ws-1', 3000, env);
    expect(decodeProtectedHeader(token).kid).toBe(NEW_KID);
  });

  it('publishes both kids during the window, and VM-agent-style kid lookup verifies old and new tokens', async () => {
    const env = rotatedEnv(inOneHour());
    const jwks = await getJWKS(env);
    expect(jwks.keys.map((key) => key.kid)).toEqual([NEW_KID, LEGACY_JWT_KEY_ID]);
    expect(new Set(jwks.keys.map((key) => key.kid)).size).toBe(2);

    const keySet = createLocalJWKSet(jwks);
    const oldToken = (await signTerminalToken('user-1', 'ws-1', beforeRotationEnv())).token;
    const newToken = (await signTerminalToken('user-1', 'ws-1', env)).token;
    expect(decodeProtectedHeader(oldToken).kid).toBe(LEGACY_JWT_KEY_ID);
    expect(decodeProtectedHeader(newToken).kid).toBe(NEW_KID);
    await expect(jwtVerify(oldToken, keySet, { issuer: ISSUER })).resolves.toBeDefined();
    await expect(jwtVerify(newToken, keySet, { issuer: ISSUER })).resolves.toBeDefined();
  });

  it('publishes the previous key under JWT_PREVIOUS_KEY_ID when set', async () => {
    const { keys } = await getJWKS(rotatedEnv(inOneHour(), { JWT_PREVIOUS_KEY_ID: 'key-2026-10' }));
    expect(keys.map((key) => key.kid)).toEqual([NEW_KID, 'key-2026-10']);
  });

  it('publishes only the current key after UNTIL', async () => {
    const { keys } = await getJWKS(rotatedEnv(oneHourAgo()));
    expect(keys.map((key) => key.kid)).toEqual([NEW_KID]);
  });

  it('publishes only the current key when the two kids would collide', async () => {
    const env = keyEnv(current, {
      JWT_PUBLIC_KEY_PREVIOUS: previous.publicKey,
      JWT_PUBLIC_KEY_PREVIOUS_UNTIL: inOneHour(),
    });
    const { keys } = await getJWKS(env);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kid: LEGACY_JWT_KEY_ID,
      n: (await exportJWK(await importSPKI(current.publicKey, 'RS256'))).n,
    });
  });

  it('still serves the current key when the previous key is malformed', async () => {
    const { keys } = await getJWKS(rotatedEnv(inOneHour(), { JWT_PUBLIC_KEY_PREVIOUS: 'bad' }));
    expect(keys.map((key) => key.kid)).toEqual([NEW_KID]);
  });
});

describe('/oidc/.well-known/jwks.json', () => {
  const claims = {
    project_id: 'project',
    user_id: 'user',
    chat_session_id: 'chat',
    agent_session_id: 'runtime',
    workspace_id: 'workspace',
    agent_profile_id: 'profile',
  };

  it('with no rotation variables: one key', async () => {
    expect((await getWorkloadJWKS(keyEnv(current))).keys).toHaveLength(1);
  });

  it('publishes the previous thumbprint kid during the window and verifies a pre-rotation token', async () => {
    const env = rotatedEnv(inOneHour());
    const jwks = await getWorkloadJWKS(env);
    const [currentEntry, previousEntry] = jwks.keys;
    expect(jwks.keys).toHaveLength(2);
    expect(currentEntry?.kid).toBe((await getWorkloadJWKS(keyEnv(current))).keys[0]?.kid);
    expect(previousEntry?.kid).toBe((await getWorkloadJWKS(beforeRotationEnv())).keys[0]?.kid);
    expect(currentEntry?.kid).not.toBe(previousEntry?.kid);

    const keySet = createLocalJWKSet(jwks);
    const oldToken = await signWorkloadIdentityToken(beforeRotationEnv(), claims, 'vault.example');
    const newToken = await signWorkloadIdentityToken(env, claims, 'vault.example');
    expect(decodeProtectedHeader(newToken).kid).toBe(currentEntry?.kid);
    await expect(jwtVerify(oldToken, keySet, { audience: 'vault.example' })).resolves.toBeDefined();
    await expect(jwtVerify(newToken, keySet, { audience: 'vault.example' })).resolves.toBeDefined();
  });

  it('publishes only the current key after UNTIL or when UNTIL is absent', async () => {
    expect((await getWorkloadJWKS(rotatedEnv(oneHourAgo()))).keys).toHaveLength(1);
    expect((await getWorkloadJWKS(rotatedEnv(undefined))).keys).toHaveLength(1);
  });
});
