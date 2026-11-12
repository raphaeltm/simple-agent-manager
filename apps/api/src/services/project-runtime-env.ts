/**
 * The one write path for project runtime environment variables. The manual project settings
 * route and agent secret-request fulfilment (`runtime-secret-requests.ts`) both call it, so key
 * validation, size and count limits, encryption and provenance are applied the same way.
 */
import { and, count, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { byteLength, PROJECT_ENV_KEY_PATTERN } from '../routes/projects/_helpers';
import { encrypt } from './encryption';
import { getRuntimeLimits } from './limits';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface UpsertProjectRuntimeEnvVarInput {
  projectId: string;
  actorUserId: string;
  envKey: string;
  value: string;
  isSecret: boolean;
  /**
   * Epoch ms after which the value must not be used. Manual writes pass null: a person setting a
   * value by hand makes it a permanent, manually managed value again.
   */
  expiresAt: number | null;
  /** The request that supplied this value, or null for a manual write. */
  secretRequestId: string | null;
}

export function assertProjectRuntimeEnvKey(envKey: string | undefined): string {
  const key = envKey?.trim();
  if (!key || !PROJECT_ENV_KEY_PATTERN.test(key)) {
    throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
  }
  return key;
}

/**
 * Opaque identity of one stored value: a SHA-256 over its write time, IV and stored bytes. Two
 * writes in the same millisecond still differ (different IV or bytes), and the digest reveals
 * neither the ciphertext nor a plaintext value. Shown to the card so a replace confirms exactly
 * the value the person saw.
 */
export async function runtimeEnvValueVersion(row: {
  updatedAt: string;
  valueIv: string | null;
  storedValue: string;
}): Promise<string> {
  const input = new TextEncoder().encode(
    `${row.updatedAt}\u0000${row.valueIv ?? ''}\u0000${row.storedValue}`
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The existing row for a key, or null. */
export async function findProjectRuntimeEnvVar(db: Db, projectId: string, envKey: string) {
  const rows = await db
    .select({
      id: schema.projectRuntimeEnvVars.id,
      isSecret: schema.projectRuntimeEnvVars.isSecret,
      expiresAt: schema.projectRuntimeEnvVars.expiresAt,
      secretRequestId: schema.projectRuntimeEnvVars.secretRequestId,
      updatedAt: schema.projectRuntimeEnvVars.updatedAt,
      valueIv: schema.projectRuntimeEnvVars.valueIv,
      // Server-side only (version fingerprint and the replace guard); never put in a response.
      storedValue: schema.projectRuntimeEnvVars.storedValue,
    })
    .from(schema.projectRuntimeEnvVars)
    .where(
      and(
        eq(schema.projectRuntimeEnvVars.projectId, projectId),
        eq(schema.projectRuntimeEnvVars.envKey, envKey)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface PreparedProjectRuntimeEnvWrite {
  envKey: string;
  stored: { ciphertext: string; iv: string | null };
  existing: Awaited<ReturnType<typeof findProjectRuntimeEnvVar>>;
}

/**
 * Validates one write against the key pattern and the size and count limits, then encrypts the
 * value when it is a secret. Every writer calls this before writing, so the manual route and
 * request fulfilment apply identical rules. Never logs the value.
 */
export async function prepareProjectRuntimeEnvWrite(
  db: Db,
  env: Env,
  input: Pick<UpsertProjectRuntimeEnvVarInput, 'projectId' | 'envKey' | 'value' | 'isSecret'>
): Promise<PreparedProjectRuntimeEnvWrite> {
  const envKey = assertProjectRuntimeEnvKey(input.envKey);
  const limits = getRuntimeLimits(env);
  if (byteLength(input.value) > limits.maxProjectRuntimeEnvValueBytes) {
    throw errors.badRequest(
      `value exceeds max size of ${limits.maxProjectRuntimeEnvValueBytes} bytes`
    );
  }

  const [existing, countRows] = await Promise.all([
    findProjectRuntimeEnvVar(db, input.projectId, envKey),
    db
      .select({ count: count() })
      .from(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, input.projectId)),
  ]);
  if (!existing && (countRows[0]?.count ?? 0) >= limits.maxProjectRuntimeEnvVarsPerProject) {
    throw errors.badRequest(
      `Maximum ${limits.maxProjectRuntimeEnvVarsPerProject} runtime env vars allowed per project`
    );
  }

  const stored = input.isSecret
    ? await encrypt(input.value, getCredentialEncryptionKey(env))
    : { ciphertext: input.value, iv: null };
  return { envKey, stored, existing };
}

/** Writes one variable; returns whether an existing value was replaced. Never logs the value. */
export async function upsertProjectRuntimeEnvVar(
  db: Db,
  env: Env,
  input: UpsertProjectRuntimeEnvVarInput
): Promise<{ replaced: boolean }> {
  const { envKey, stored, existing } = await prepareProjectRuntimeEnvWrite(db, env, input);
  const now = new Date().toISOString();
  // Every field is written on update, including the two provenance columns: a manual write
  // clears an earlier request's expiry and provenance (`.claude/rules/73`).
  const values = {
    storedValue: stored.ciphertext,
    valueIv: stored.iv,
    isSecret: input.isSecret,
    expiresAt: input.expiresAt,
    secretRequestId: input.secretRequestId,
    updatedAt: now,
  };
  // One upsert on the unique (project, key) index covers both cases, including a row inserted or
  // deleted by someone else between the read above and this write.
  await db
    .insert(schema.projectRuntimeEnvVars)
    .values({
      id: ulid(),
      projectId: input.projectId,
      userId: input.actorUserId,
      envKey,
      createdAt: now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.projectRuntimeEnvVars.projectId, schema.projectRuntimeEnvVars.envKey],
      set: values,
    });
  return { replaced: Boolean(existing) };
}
