import type { DeploymentEnvironmentConfigResponse } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { decrypt, encrypt } from './encryption';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const textEncoder = new TextEncoder();

export interface DeploymentInterpolationEnv {
  values: Record<string, string>;
  plainKeys: string[];
  secretKeys: string[];
  configUpdatedAt: string | null;
  totalBytes: number;
}

export async function loadDeploymentEnvironmentConfigRows(
  db: Db,
  environmentId: string
): Promise<schema.DeploymentEnvironmentConfigVarRow[]> {
  return db
    .select()
    .from(schema.deploymentEnvironmentConfigVars)
    .where(eq(schema.deploymentEnvironmentConfigVars.environmentId, environmentId))
    .orderBy(schema.deploymentEnvironmentConfigVars.envKey);
}

export async function buildDeploymentEnvironmentConfigResponse(
  db: Db,
  environmentId: string
): Promise<DeploymentEnvironmentConfigResponse> {
  const [envRows, configRows] = await Promise.all([
    db
      .select({ configUpdatedAt: schema.deploymentEnvironments.configUpdatedAt })
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, environmentId))
      .limit(1),
    loadDeploymentEnvironmentConfigRows(db, environmentId),
  ]);

  const envVars: DeploymentEnvironmentConfigResponse['envVars'] = configRows.map((row) => ({
    key: row.envKey,
    value: row.isSecret ? null : row.storedValue,
    isSecret: row.isSecret,
    hasValue: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return {
    envVars,
    updatedAt: envRows[0]?.configUpdatedAt ?? null,
    variableCount: envVars.filter((item) => !item.isSecret).length,
    secretCount: envVars.filter((item) => item.isSecret).length,
  };
}

export async function touchDeploymentConfigUpdatedAt(db: Db, environmentId: string): Promise<string> {
  const now = new Date().toISOString();
  await db
    .update(schema.deploymentEnvironments)
    .set({ configUpdatedAt: now, updatedAt: now })
    .where(eq(schema.deploymentEnvironments.id, environmentId));
  return now;
}

export async function upsertDeploymentEnvironmentConfigVar(
  db: Db,
  input: {
    environmentId: string;
    envKey: string;
    value: string;
    isSecret: boolean;
    encryptionKey: string;
  }
): Promise<void> {
  const existingRows = await db
    .select({ id: schema.deploymentEnvironmentConfigVars.id })
    .from(schema.deploymentEnvironmentConfigVars)
    .where(
      and(
        eq(schema.deploymentEnvironmentConfigVars.environmentId, input.environmentId),
        eq(schema.deploymentEnvironmentConfigVars.envKey, input.envKey)
      )
    )
    .limit(1);

  const stored = input.isSecret
    ? await encrypt(input.value, input.encryptionKey)
    : { ciphertext: input.value, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.deploymentEnvironmentConfigVars)
      .set({
        storedValue: stored.ciphertext,
        valueIv: stored.iv,
        isSecret: input.isSecret,
        updatedAt: now,
      })
      .where(eq(schema.deploymentEnvironmentConfigVars.id, existingRows[0].id));
    await touchDeploymentConfigUpdatedAt(db, input.environmentId);
    return;
  }

  await db.insert(schema.deploymentEnvironmentConfigVars).values({
    id: ulid(),
    environmentId: input.environmentId,
    envKey: input.envKey,
    storedValue: stored.ciphertext,
    valueIv: stored.iv,
    isSecret: input.isSecret,
    createdAt: now,
    updatedAt: now,
  });
  await touchDeploymentConfigUpdatedAt(db, input.environmentId);
}

export async function deleteDeploymentEnvironmentConfigVar(
  db: Db,
  environmentId: string,
  envKey: string
): Promise<void> {
  await db
    .delete(schema.deploymentEnvironmentConfigVars)
    .where(
      and(
        eq(schema.deploymentEnvironmentConfigVars.environmentId, environmentId),
        eq(schema.deploymentEnvironmentConfigVars.envKey, envKey)
      )
    );
  await touchDeploymentConfigUpdatedAt(db, environmentId);
}

function envPairByteLength(key: string, value: string): number {
  return textEncoder.encode(`${key}=${value}`).length + 1;
}

async function resolveConfigRows(
  rows: schema.DeploymentEnvironmentConfigVarRow[],
  encryptionKey: string,
  includeSecrets: boolean
): Promise<Omit<DeploymentInterpolationEnv, 'configUpdatedAt'>> {
  const values: Record<string, string> = {};
  const plainKeys: string[] = [];
  const secretKeys: string[] = [];
  let totalBytes = 0;

  for (const row of rows) {
    if (row.isSecret) {
      secretKeys.push(row.envKey);
      if (!includeSecrets) continue;
      if (!row.valueIv) {
        throw new Error(`Deployment config secret ${row.envKey} is missing an IV`);
      }
      const decrypted = await decrypt(row.storedValue, row.valueIv, encryptionKey);
      values[row.envKey] = decrypted;
      totalBytes += envPairByteLength(row.envKey, decrypted);
    } else {
      plainKeys.push(row.envKey);
      values[row.envKey] = row.storedValue;
      totalBytes += envPairByteLength(row.envKey, row.storedValue);
    }
  }

  return { values, plainKeys, secretKeys, totalBytes };
}

export async function loadDeploymentInterpolationEnv(
  db: Db,
  environmentId: string,
  encryptionKey: string
): Promise<DeploymentInterpolationEnv> {
  const rows = await loadDeploymentEnvironmentConfigRows(db, environmentId);
  const resolved = await resolveConfigRows(rows, encryptionKey, true);
  return { ...resolved, configUpdatedAt: null };
}

export async function loadDeploymentBuildInterpolationEnv(
  db: Db,
  environmentId: string
): Promise<DeploymentInterpolationEnv> {
  const rows = await loadDeploymentEnvironmentConfigRows(db, environmentId);
  const resolved = await resolveConfigRows(rows, '', false);
  return { ...resolved, configUpdatedAt: null };
}
