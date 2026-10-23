import Database from 'better-sqlite3';
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { verifyCallbackToken, verifyTerminalToken } from '../../../src/services/jwt';
import {
  getWorkloadJWKS,
  signWorkloadIdentityToken,
} from '../../../src/services/workload-identity-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let env: Env;
let sqlite: Database.Database;
const claims = {
  project_id: 'project',
  user_id: 'user',
  chat_session_id: 'chat',
  agent_session_id: 'runtime',
  workspace_id: 'workspace',
  agent_profile_id: 'profile',
};
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = {
    BASE_DOMAIN: 'example.test',
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(keys.publicKey),
  } as Env;
});
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.platformSettings, schema.platformCredentials]);
  env = { ...env, DATABASE: createSqliteD1(sqlite) };
});
afterEach(() => sqlite.close());
describe('workload identity JWTs', () => {
  it('verifies through published JWKS with bounded lifetime, stable subject and unique token ID', async () => {
    const first = await signWorkloadIdentityToken(env, claims, 'vault.example');
    const second = await signWorkloadIdentityToken(env, claims, 'vault.example');
    const { payload } = await jwtVerify(first, createLocalJWKSet(await getWorkloadJWKS(env)), {
      issuer: 'https://api.example.test/oidc',
      audience: 'vault.example',
    });
    expect(payload).toMatchObject({
      ...claims,
      type: 'workload-identity',
      sub: 'project:project:user:user:profile:profile',
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.jti).not.toBe(decodeJwt(second).jti);
    expect(decodeProtectedHeader(first).kid).not.toMatch(/^key-\d{4}-\d{2}$/);
    await expect(
      jwtVerify(first, createLocalJWKSet(await getWorkloadJWKS(env)), { audience: 'other' })
    ).rejects.toThrow();
    await expect(
      jwtVerify(first, createLocalJWKSet(await getWorkloadJWKS(env)), {
        currentDate: new Date((payload.exp! + 1) * 1000),
      })
    ).rejects.toThrow();
  });
  it.each([
    'workspace-terminal',
    'workspace-callback',
    'node-management',
    'port-access',
    'local-forward',
    '',
    ' bad ',
  ])('rejects reserved/invalid audience %s', async (audience) => {
    await expect(signWorkloadIdentityToken(env, claims, audience)).rejects.toThrow();
  });
  it('cannot authenticate at internal SAM verifiers', async () => {
    const token = await signWorkloadIdentityToken(env, claims, 'external-service');
    await expect(verifyCallbackToken(token, env)).rejects.toThrow();
    await expect(verifyTerminalToken(token, env)).rejects.toThrow();
  });
  it('honors the persisted runtime lifetime override', async () => {
    sqlite
      .prepare(
        "INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,'2026-10-23T00:00:00Z')"
      )
      .run('operations.workloadIdentityTokenTtlSeconds', '120');
    const payload = decodeJwt(await signWorkloadIdentityToken(env, claims, 'external-service'));
    expect(payload.exp! - payload.iat!).toBe(120);
  });
  it('fails closed when settings cannot be read', async () => {
    sqlite.exec('DROP TABLE platform_settings');
    await expect(signWorkloadIdentityToken(env, claims, 'external-service')).rejects.toThrow();
  });
  it.each(['0', '-1', 'Infinity', 'abc', '301x', '86400'])(
    'fails closed on invalid persisted lifetime %s',
    async (value) => {
      sqlite
        .prepare(
          "INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,'2026-10-23T00:00:00Z')"
        )
        .run('operations.workloadIdentityTokenTtlSeconds', value);
      await expect(signWorkloadIdentityToken(env, claims, 'external-service')).rejects.toThrow();
    }
  );
  it('rejects the external issuer even with the correct internal audience and claims', async () => {
    const token = await new SignJWT({ workspace: 'workspace', type: 'terminal' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.example.test/oidc')
      .setSubject('user')
      .setAudience('workspace-terminal')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256'));
    await expect(verifyTerminalToken(token, env)).rejects.toMatchObject({ claim: 'iss' });
  });
});
