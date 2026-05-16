import type {
  ProjectRuntimeConfigResponse,
  WorkspaceRuntimeEnvVar,
  WorkspaceRuntimeFile,
} from '@simple-agent-manager/shared';
import { and, count, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { decrypt, encrypt } from './encryption';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface RuntimeAssetRows {
  envVars: WorkspaceRuntimeEnvVar[];
  files: WorkspaceRuntimeFile[];
}

export async function requireOwnedProjectScopedProfile(
  db: Db,
  projectId: string,
  profileId: string,
  userId: string
): Promise<schema.AgentProfileRow> {
  const rows = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        eq(schema.agentProfiles.projectId, projectId),
        eq(schema.agentProfiles.userId, userId)
      )
    )
    .limit(1);

  const profile = rows[0];
  if (!profile) {
    throw errors.notFound('Agent profile');
  }

  return profile;
}

export async function buildProfileRuntimeConfigResponse(
  db: Db,
  profileId: string,
  userId: string
): Promise<ProjectRuntimeConfigResponse> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select()
      .from(schema.profileRuntimeEnvVars)
      .where(
        and(
          eq(schema.profileRuntimeEnvVars.profileId, profileId),
          eq(schema.profileRuntimeEnvVars.userId, userId)
        )
      )
      .orderBy(schema.profileRuntimeEnvVars.envKey),
    db
      .select()
      .from(schema.profileRuntimeFiles)
      .where(
        and(
          eq(schema.profileRuntimeFiles.profileId, profileId),
          eq(schema.profileRuntimeFiles.userId, userId)
        )
      )
      .orderBy(schema.profileRuntimeFiles.filePath),
  ]);

  return {
    envVars: envRows.map((row) => ({
      key: row.envKey,
      value: row.isSecret ? null : row.storedValue,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    files: fileRows.map((row) => ({
      path: row.filePath,
      content: row.isSecret ? null : row.storedContent,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}

export function mergeRuntimeAssetRows(
  projectAssets: RuntimeAssetRows,
  profileAssets: RuntimeAssetRows
): RuntimeAssetRows {
  const envVarsByKey = new Map<string, WorkspaceRuntimeEnvVar>();
  for (const envVar of projectAssets.envVars) {
    envVarsByKey.set(envVar.key, envVar);
  }
  for (const envVar of profileAssets.envVars) {
    envVarsByKey.set(envVar.key, envVar);
  }

  const filesByPath = new Map<string, WorkspaceRuntimeFile>();
  for (const file of projectAssets.files) {
    filesByPath.set(file.path, file);
  }
  for (const file of profileAssets.files) {
    filesByPath.set(file.path, file);
  }

  return {
    envVars: [...envVarsByKey.values()],
    files: [...filesByPath.values()],
  };
}

export async function resolveRuntimeEnvRows(
  rows: Array<{ key: string; storedValue: string; valueIv: string | null; isSecret: boolean }>,
  encryptionKey: string
): Promise<WorkspaceRuntimeEnvVar[]> {
  return Promise.all(rows.map(async (row) => ({
    key: row.key,
    value: row.isSecret
      ? await decrypt(row.storedValue, row.valueIv ?? '', encryptionKey)
      : row.storedValue,
    isSecret: row.isSecret,
  })));
}

export async function resolveRuntimeFileRows(
  rows: Array<{ path: string; storedContent: string; contentIv: string | null; isSecret: boolean }>,
  encryptionKey: string
): Promise<WorkspaceRuntimeFile[]> {
  return Promise.all(rows.map(async (row) => ({
    path: row.path,
    content: row.isSecret
      ? await decrypt(row.storedContent, row.contentIv ?? '', encryptionKey)
      : row.storedContent,
    isSecret: row.isSecret,
  })));
}

export async function getProfileRuntimeAssets(
  db: Db,
  profileId: string,
  userId: string,
  encryptionKey: string
): Promise<RuntimeAssetRows> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select({
        key: schema.profileRuntimeEnvVars.envKey,
        storedValue: schema.profileRuntimeEnvVars.storedValue,
        valueIv: schema.profileRuntimeEnvVars.valueIv,
        isSecret: schema.profileRuntimeEnvVars.isSecret,
      })
      .from(schema.profileRuntimeEnvVars)
      .where(
        and(
          eq(schema.profileRuntimeEnvVars.profileId, profileId),
          eq(schema.profileRuntimeEnvVars.userId, userId)
        )
      ),
    db
      .select({
        path: schema.profileRuntimeFiles.filePath,
        storedContent: schema.profileRuntimeFiles.storedContent,
        contentIv: schema.profileRuntimeFiles.contentIv,
        isSecret: schema.profileRuntimeFiles.isSecret,
      })
      .from(schema.profileRuntimeFiles)
      .where(
        and(
          eq(schema.profileRuntimeFiles.profileId, profileId),
          eq(schema.profileRuntimeFiles.userId, userId)
        )
      ),
  ]);

  return {
    envVars: await resolveRuntimeEnvRows(envRows, encryptionKey),
    files: await resolveRuntimeFileRows(fileRows, encryptionKey),
  };
}

export async function upsertProfileRuntimeEnvVar(
  db: Db,
  input: {
    profileId: string;
    userId: string;
    envKey: string;
    value: string;
    isSecret: boolean;
    maxCount: number;
    encryptionKey: string;
  }
): Promise<void> {
  const existingRows = await db
    .select({ id: schema.profileRuntimeEnvVars.id })
    .from(schema.profileRuntimeEnvVars)
    .where(
      and(
        eq(schema.profileRuntimeEnvVars.profileId, input.profileId),
        eq(schema.profileRuntimeEnvVars.userId, input.userId),
        eq(schema.profileRuntimeEnvVars.envKey, input.envKey)
      )
    )
    .limit(1);

  await assertProfileEnvVarLimit(db, input.profileId, input.userId, input.maxCount, Boolean(existingRows[0]));
  const stored = input.isSecret
    ? await encrypt(input.value, input.encryptionKey)
    : { ciphertext: input.value, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.profileRuntimeEnvVars)
      .set({ storedValue: stored.ciphertext, valueIv: stored.iv, isSecret: input.isSecret, updatedAt: now })
      .where(eq(schema.profileRuntimeEnvVars.id, existingRows[0].id));
    return;
  }

  await db.insert(schema.profileRuntimeEnvVars).values({
    id: ulid(),
    profileId: input.profileId,
    userId: input.userId,
    envKey: input.envKey,
    storedValue: stored.ciphertext,
    valueIv: stored.iv,
    isSecret: input.isSecret,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteProfileRuntimeEnvVar(
  db: Db,
  profileId: string,
  userId: string,
  envKey: string
): Promise<void> {
  await db
    .delete(schema.profileRuntimeEnvVars)
    .where(
      and(
        eq(schema.profileRuntimeEnvVars.profileId, profileId),
        eq(schema.profileRuntimeEnvVars.userId, userId),
        eq(schema.profileRuntimeEnvVars.envKey, envKey)
      )
    );
}

export async function upsertProfileRuntimeFile(
  db: Db,
  input: {
    profileId: string;
    userId: string;
    path: string;
    content: string;
    isSecret: boolean;
    maxCount: number;
    encryptionKey: string;
  }
): Promise<void> {
  const existingRows = await db
    .select({ id: schema.profileRuntimeFiles.id })
    .from(schema.profileRuntimeFiles)
    .where(
      and(
        eq(schema.profileRuntimeFiles.profileId, input.profileId),
        eq(schema.profileRuntimeFiles.userId, input.userId),
        eq(schema.profileRuntimeFiles.filePath, input.path)
      )
    )
    .limit(1);

  await assertProfileFileLimit(db, input.profileId, input.userId, input.maxCount, Boolean(existingRows[0]));
  const stored = input.isSecret
    ? await encrypt(input.content, input.encryptionKey)
    : { ciphertext: input.content, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.profileRuntimeFiles)
      .set({ storedContent: stored.ciphertext, contentIv: stored.iv, isSecret: input.isSecret, updatedAt: now })
      .where(eq(schema.profileRuntimeFiles.id, existingRows[0].id));
    return;
  }

  await db.insert(schema.profileRuntimeFiles).values({
    id: ulid(),
    profileId: input.profileId,
    userId: input.userId,
    filePath: input.path,
    storedContent: stored.ciphertext,
    contentIv: stored.iv,
    isSecret: input.isSecret,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteProfileRuntimeFile(
  db: Db,
  profileId: string,
  userId: string,
  path: string
): Promise<void> {
  await db
    .delete(schema.profileRuntimeFiles)
    .where(
      and(
        eq(schema.profileRuntimeFiles.profileId, profileId),
        eq(schema.profileRuntimeFiles.userId, userId),
        eq(schema.profileRuntimeFiles.filePath, path)
      )
    );
}

async function assertProfileEnvVarLimit(
  db: Db,
  profileId: string,
  userId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;

  const countRows = await db
    .select({ count: count() })
    .from(schema.profileRuntimeEnvVars)
    .where(
      and(
        eq(schema.profileRuntimeEnvVars.profileId, profileId),
        eq(schema.profileRuntimeEnvVars.userId, userId)
      )
    );

  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime env vars allowed per profile`);
  }
}

async function assertProfileFileLimit(
  db: Db,
  profileId: string,
  userId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;

  const countRows = await db
    .select({ count: count() })
    .from(schema.profileRuntimeFiles)
    .where(
      and(
        eq(schema.profileRuntimeFiles.profileId, profileId),
        eq(schema.profileRuntimeFiles.userId, userId)
      )
    );

  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime files allowed per profile`);
  }
}
