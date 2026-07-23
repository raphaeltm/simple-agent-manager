/**
 * Miniflare worker tests for the deployment environment config service.
 *
 * Exercises the real service against a real D1 binding and real AES-256-GCM
 * encryption. The most important invariant under test is the secret/build
 * boundary documented in app-deployments.md:
 *
 *   - Variables (isSecret=false) are stored in plaintext and are available to
 *     BOTH the build path and the deployment-node apply path.
 *   - Secrets (isSecret=true) are encrypted at rest, returned as `value: null`
 *     in the API response, decrypted only for the deployment-node apply path,
 *     and MUST NEVER be exposed to the build path.
 *
 * If `loadDeploymentBuildInterpolationEnv` ever leaked secret values, a release
 * built on a SAM build node could embed secrets into image tags, build args, or
 * other build-control fields. This file is the regression guard for that.
 */
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { ulid } from '../../src/lib/ulid';
import {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentInterpolationEnv,
  upsertDeploymentEnvironmentConfigVar,
} from '../../src/services/deployment-environment-config';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const PREFIX = `decfg-${Date.now()}`;
const USER_ID = `${PREFIX}-user`;
const PROJECT_ID = `${PREFIX}-proj`;
const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';

let db: ReturnType<typeof drizzle<typeof schema>>;

async function makeEnvironment(name: string): Promise<string> {
  const id = `${PREFIX}-env-${name}`;
  await env.DATABASE.prepare(
    `INSERT INTO deployment_environments (id, project_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`
  )
    .bind(id, PROJECT_ID, name)
    .run();
  return id;
}

beforeAll(async () => {
  db = drizzle(env.DATABASE, { schema });

  const installationId = `-installation`;
  await seedUser(USER_ID, { githubId: '880001', email: `@example.com`, name: 'Cfg User' });
  await seedInstallation(installationId, USER_ID, {
    installationIdValue: `installation-`,
    accountName: `account-`,
  });
  await seedProject(PROJECT_ID, USER_ID, installationId, {
    name: 'decfg-project',
    repository: 'test-owner/test-repo',
  });
});

describe('buildDeploymentEnvironmentConfigResponse', () => {
  it('returns variable values in plaintext and hides secret values, with correct counts', async () => {
    const envId = await makeEnvironment('response-shape');

    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'NODE_ENV',
      value: 'production',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'PUBLIC_APP_DOMAIN',
      value: 'app.example.com',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'DATABASE_URL',
      value: 'postgres://user:s3cr3tpassword@db/app',
      isSecret: true,
      encryptionKey: ENCRYPTION_KEY,
    });

    const response = await buildDeploymentEnvironmentConfigResponse(db, envId);

    expect(response.variableCount).toBe(2);
    expect(response.secretCount).toBe(1);
    expect(response.updatedAt).not.toBeNull();

    const byKey = Object.fromEntries(response.envVars.map((v) => [v.key, v]));

    // Variables: plaintext value visible, editable.
    expect(byKey.NODE_ENV).toMatchObject({ value: 'production', isSecret: false, hasValue: true });
    expect(byKey.PUBLIC_APP_DOMAIN).toMatchObject({
      value: 'app.example.com',
      isSecret: false,
      hasValue: true,
    });

    // Secret: value is null in the response (write-only), but presence is signalled.
    expect(byKey.DATABASE_URL.isSecret).toBe(true);
    expect(byKey.DATABASE_URL.value).toBeNull();
    expect(byKey.DATABASE_URL.hasValue).toBe(true);

    // The secret plaintext must never appear anywhere in the serialized response.
    expect(JSON.stringify(response)).not.toContain('s3cr3tpassword');
  });

  it('returns an empty config with null updatedAt for a fresh environment', async () => {
    const envId = await makeEnvironment('empty');
    const response = await buildDeploymentEnvironmentConfigResponse(db, envId);
    expect(response.envVars).toEqual([]);
    expect(response.variableCount).toBe(0);
    expect(response.secretCount).toBe(0);
    expect(response.updatedAt).toBeNull();
  });
});

describe('upsert / delete lifecycle', () => {
  it('inserts then updates the same key in place (no duplicate row)', async () => {
    const envId = await makeEnvironment('upsert');

    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'LOG_LEVEL',
      value: 'info',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'LOG_LEVEL',
      value: 'debug',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });

    const response = await buildDeploymentEnvironmentConfigResponse(db, envId);
    const logLevel = response.envVars.filter((v) => v.key === 'LOG_LEVEL');
    expect(logLevel).toHaveLength(1);
    expect(logLevel[0].value).toBe('debug');
  });

  it('promotes a variable to a secret on update (value becomes encrypted + hidden)', async () => {
    const envId = await makeEnvironment('promote');

    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'API_TOKEN',
      value: 'plain-at-first',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'API_TOKEN',
      value: 'now-a-real-secret-value',
      isSecret: true,
      encryptionKey: ENCRYPTION_KEY,
    });

    const response = await buildDeploymentEnvironmentConfigResponse(db, envId);
    const apiToken = response.envVars.find((v) => v.key === 'API_TOKEN');
    expect(apiToken?.isSecret).toBe(true);
    expect(apiToken?.value).toBeNull();

    // The encrypted-at-rest value must not be the plaintext.
    const rows = await db
      .select()
      .from(schema.deploymentEnvironmentConfigVars)
      .where(eq(schema.deploymentEnvironmentConfigVars.environmentId, envId));
    const stored = rows.find((r) => r.envKey === 'API_TOKEN');
    expect(stored?.storedValue).not.toBe('now-a-real-secret-value');
    expect(stored?.valueIv).not.toBeNull();
  });

  it('deletes a key', async () => {
    const envId = await makeEnvironment('delete');
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'TEMP',
      value: 'x',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await deleteDeploymentEnvironmentConfigVar(db, envId, 'TEMP');
    const response = await buildDeploymentEnvironmentConfigResponse(db, envId);
    expect(response.envVars.find((v) => v.key === 'TEMP')).toBeUndefined();
  });
});

describe('interpolation env resolution (build vs runtime boundary)', () => {
  async function seedMixed(envId: string) {
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'PUBLIC_APP_DOMAIN',
      value: 'app.example.com',
      isSecret: false,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'DATABASE_URL',
      value: 'postgres://user:topsecretvalue@db/app',
      isSecret: true,
      encryptionKey: ENCRYPTION_KEY,
    });
    await upsertDeploymentEnvironmentConfigVar(db, {
      environmentId: envId,
      envKey: 'STRIPE_KEY',
      value: 'sk_live_anotherbigsecret',
      isSecret: true,
      encryptionKey: ENCRYPTION_KEY,
    });
  }

  it('runtime resolution decrypts secrets AND includes plain variables', async () => {
    const envId = await makeEnvironment('runtime');
    await seedMixed(envId);

    const resolved = await loadDeploymentInterpolationEnv(db, envId, ENCRYPTION_KEY);

    // Plain variable present.
    expect(resolved.values.PUBLIC_APP_DOMAIN).toBe('app.example.com');
    // Secrets decrypted and present for the deployment-node apply path.
    expect(resolved.values.DATABASE_URL).toBe('postgres://user:topsecretvalue@db/app');
    expect(resolved.values.STRIPE_KEY).toBe('sk_live_anotherbigsecret');

    expect(resolved.plainKeys.sort()).toEqual(['PUBLIC_APP_DOMAIN']);
    expect(resolved.secretKeys.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(resolved.totalBytes).toBeGreaterThan(0);
  });

  it('build resolution EXCLUDES secret values but still lists secret keys', async () => {
    const envId = await makeEnvironment('build');
    await seedMixed(envId);

    const resolved = await loadDeploymentBuildInterpolationEnv(db, envId);

    // Plain variables ARE available to the build path.
    expect(resolved.values.PUBLIC_APP_DOMAIN).toBe('app.example.com');

    // Secret values are NEVER materialized for the build path.
    expect(resolved.values.DATABASE_URL).toBeUndefined();
    expect(resolved.values.STRIPE_KEY).toBeUndefined();
    expect(Object.keys(resolved.values)).toEqual(['PUBLIC_APP_DOMAIN']);

    // No secret plaintext leaks into byte accounting payload either.
    expect(JSON.stringify(resolved)).not.toContain('topsecretvalue');
    expect(JSON.stringify(resolved)).not.toContain('anotherbigsecret');

    // But the key names are reported so callers know secrets exist.
    expect(resolved.secretKeys.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(resolved.plainKeys.sort()).toEqual(['PUBLIC_APP_DOMAIN']);
  });

  it('rejects a corrupt secret row that is missing its IV at runtime resolution', async () => {
    const envId = await makeEnvironment('corrupt');
    // Manually seed a secret row with NULL iv to simulate corruption.
    await env.DATABASE.prepare(
      `INSERT INTO deployment_environment_config_vars
       (id, environment_id, env_key, stored_value, value_iv, is_secret, created_at, updated_at)
       VALUES (?, ?, 'BROKEN', 'not-real-ciphertext', NULL, 1, datetime('now'), datetime('now'))`
    )
      .bind(ulid(), envId)
      .run();

    await expect(loadDeploymentInterpolationEnv(db, envId, ENCRYPTION_KEY)).rejects.toThrow(
      /missing an IV/
    );
  });
});
