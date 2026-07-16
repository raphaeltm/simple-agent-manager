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

/** Stored env-var row shape shared by the profile and skill runtime tables. */
interface StoredEnvVarRow {
  envKey: string;
  storedValue: string;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Stored file row shape shared by the profile and skill runtime tables. */
interface StoredFileRow {
  filePath: string;
  storedContent: string;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map stored env-var/file rows to the API config response. Secret values are
 * redacted (`null`) but `hasValue` stays true so the UI can render a masked
 * placeholder. Shared by the profile and skill config builders.
 */
function toRuntimeConfigResponse(
  envRows: StoredEnvVarRow[],
  fileRows: StoredFileRow[]
): ProjectRuntimeConfigResponse {
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

export async function requireProjectScopedProfile(
  db: Db,
  projectId: string,
  profileId: string
): Promise<schema.AgentProfileRow> {
  const rows = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        eq(schema.agentProfiles.projectId, projectId)
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
  _userId: string
): Promise<ProjectRuntimeConfigResponse> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select()
      .from(schema.profileRuntimeEnvVars)
      .where(eq(schema.profileRuntimeEnvVars.profileId, profileId))
      .orderBy(schema.profileRuntimeEnvVars.envKey),
    db
      .select()
      .from(schema.profileRuntimeFiles)
      .where(eq(schema.profileRuntimeFiles.profileId, profileId))
      .orderBy(schema.profileRuntimeFiles.filePath),
  ]);

  return toRuntimeConfigResponse(envRows, fileRows);
}

export async function buildSkillRuntimeConfigResponse(
  db: Db,
  skillId: string,
  _userId: string
): Promise<ProjectRuntimeConfigResponse> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select()
      .from(schema.skillRuntimeEnvVars)
      .where(eq(schema.skillRuntimeEnvVars.skillId, skillId))
      .orderBy(schema.skillRuntimeEnvVars.envKey),
    db
      .select()
      .from(schema.skillRuntimeFiles)
      .where(eq(schema.skillRuntimeFiles.skillId, skillId))
      .orderBy(schema.skillRuntimeFiles.filePath),
  ]);

  return toRuntimeConfigResponse(envRows, fileRows);
}

export function mergeRuntimeAssetRows(
  projectAssets: RuntimeAssetRows,
  profileAssets: RuntimeAssetRows,
  skillAssets: RuntimeAssetRows = { envVars: [], files: [] }
): RuntimeAssetRows {
  const envVarsByKey = new Map<string, WorkspaceRuntimeEnvVar>();
  for (const envVar of projectAssets.envVars) {
    envVarsByKey.set(envVar.key, envVar);
  }
  for (const envVar of profileAssets.envVars) {
    envVarsByKey.set(envVar.key, envVar);
  }
  for (const envVar of skillAssets.envVars) {
    envVarsByKey.set(envVar.key, envVar);
  }

  const filesByPath = new Map<string, WorkspaceRuntimeFile>();
  for (const file of projectAssets.files) {
    filesByPath.set(file.path, file);
  }
  for (const file of profileAssets.files) {
    filesByPath.set(file.path, file);
  }
  for (const file of skillAssets.files) {
    filesByPath.set(file.path, file);
  }

  return {
    envVars: [...envVarsByKey.values()],
    files: [...filesByPath.values()],
  };
}

export async function requireProjectScopedSkill(
  db: Db,
  projectId: string,
  skillId: string
): Promise<schema.SkillRow> {
  const rows = await db
    .select()
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.id, skillId),
        eq(schema.skills.projectId, projectId)
      )
    )
    .limit(1);

  const skill = rows[0];
  if (!skill) {
    throw errors.notFound('Skill');
  }

  return skill;
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
  _userId: string,
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
      .where(eq(schema.profileRuntimeEnvVars.profileId, profileId)),
    db
      .select({
        path: schema.profileRuntimeFiles.filePath,
        storedContent: schema.profileRuntimeFiles.storedContent,
        contentIv: schema.profileRuntimeFiles.contentIv,
        isSecret: schema.profileRuntimeFiles.isSecret,
      })
      .from(schema.profileRuntimeFiles)
      .where(eq(schema.profileRuntimeFiles.profileId, profileId)),
  ]);

  return {
    envVars: await resolveRuntimeEnvRows(envRows, encryptionKey),
    files: await resolveRuntimeFileRows(fileRows, encryptionKey),
  };
}

export async function getSkillRuntimeAssets(
  db: Db,
  skillId: string,
  _userId: string,
  encryptionKey: string
): Promise<RuntimeAssetRows> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select({
        key: schema.skillRuntimeEnvVars.envKey,
        storedValue: schema.skillRuntimeEnvVars.storedValue,
        valueIv: schema.skillRuntimeEnvVars.valueIv,
        isSecret: schema.skillRuntimeEnvVars.isSecret,
      })
      .from(schema.skillRuntimeEnvVars)
      .where(eq(schema.skillRuntimeEnvVars.skillId, skillId)),
    db
      .select({
        path: schema.skillRuntimeFiles.filePath,
        storedContent: schema.skillRuntimeFiles.storedContent,
        contentIv: schema.skillRuntimeFiles.contentIv,
        isSecret: schema.skillRuntimeFiles.isSecret,
      })
      .from(schema.skillRuntimeFiles)
      .where(eq(schema.skillRuntimeFiles.skillId, skillId)),
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
        eq(schema.profileRuntimeEnvVars.envKey, input.envKey)
      )
    )
    .limit(1);

  await assertProfileEnvVarLimit(db, input.profileId, input.maxCount, Boolean(existingRows[0]));
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
  _userId: string,
  envKey: string
): Promise<void> {
  await db
    .delete(schema.profileRuntimeEnvVars)
    .where(
      and(
        eq(schema.profileRuntimeEnvVars.profileId, profileId),
        eq(schema.profileRuntimeEnvVars.envKey, envKey)
      )
    );
}

export async function upsertSkillRuntimeEnvVar(
  db: Db,
  input: {
    skillId: string;
    userId: string;
    envKey: string;
    value: string;
    isSecret: boolean;
    maxCount: number;
    encryptionKey: string;
  }
): Promise<void> {
  const existingRows = await db
    .select({ id: schema.skillRuntimeEnvVars.id })
    .from(schema.skillRuntimeEnvVars)
    .where(
      and(
        eq(schema.skillRuntimeEnvVars.skillId, input.skillId),
        eq(schema.skillRuntimeEnvVars.envKey, input.envKey)
      )
    )
    .limit(1);

  await assertSkillEnvVarLimit(db, input.skillId, input.maxCount, Boolean(existingRows[0]));
  const stored = input.isSecret
    ? await encrypt(input.value, input.encryptionKey)
    : { ciphertext: input.value, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.skillRuntimeEnvVars)
      .set({ storedValue: stored.ciphertext, valueIv: stored.iv, isSecret: input.isSecret, updatedAt: now })
      .where(eq(schema.skillRuntimeEnvVars.id, existingRows[0].id));
    return;
  }

  await db.insert(schema.skillRuntimeEnvVars).values({
    id: ulid(),
    skillId: input.skillId,
    userId: input.userId,
    envKey: input.envKey,
    storedValue: stored.ciphertext,
    valueIv: stored.iv,
    isSecret: input.isSecret,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteSkillRuntimeEnvVar(
  db: Db,
  skillId: string,
  _userId: string,
  envKey: string
): Promise<void> {
  await db
    .delete(schema.skillRuntimeEnvVars)
    .where(
      and(
        eq(schema.skillRuntimeEnvVars.skillId, skillId),
        eq(schema.skillRuntimeEnvVars.envKey, envKey)
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
        eq(schema.profileRuntimeFiles.filePath, input.path)
      )
    )
    .limit(1);

  await assertProfileFileLimit(db, input.profileId, input.maxCount, Boolean(existingRows[0]));
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
  _userId: string,
  path: string
): Promise<void> {
  await db
    .delete(schema.profileRuntimeFiles)
    .where(
      and(
        eq(schema.profileRuntimeFiles.profileId, profileId),
        eq(schema.profileRuntimeFiles.filePath, path)
      )
    );
}

export async function upsertSkillRuntimeFile(
  db: Db,
  input: {
    skillId: string;
    userId: string;
    path: string;
    content: string;
    isSecret: boolean;
    maxCount: number;
    encryptionKey: string;
  }
): Promise<void> {
  const existingRows = await db
    .select({ id: schema.skillRuntimeFiles.id })
    .from(schema.skillRuntimeFiles)
    .where(
      and(
        eq(schema.skillRuntimeFiles.skillId, input.skillId),
        eq(schema.skillRuntimeFiles.filePath, input.path)
      )
    )
    .limit(1);

  await assertSkillFileLimit(db, input.skillId, input.maxCount, Boolean(existingRows[0]));
  const stored = input.isSecret
    ? await encrypt(input.content, input.encryptionKey)
    : { ciphertext: input.content, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.skillRuntimeFiles)
      .set({ storedContent: stored.ciphertext, contentIv: stored.iv, isSecret: input.isSecret, updatedAt: now })
      .where(eq(schema.skillRuntimeFiles.id, existingRows[0].id));
    return;
  }

  await db.insert(schema.skillRuntimeFiles).values({
    id: ulid(),
    skillId: input.skillId,
    userId: input.userId,
    filePath: input.path,
    storedContent: stored.ciphertext,
    contentIv: stored.iv,
    isSecret: input.isSecret,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteSkillRuntimeFile(
  db: Db,
  skillId: string,
  _userId: string,
  path: string
): Promise<void> {
  await db
    .delete(schema.skillRuntimeFiles)
    .where(
      and(
        eq(schema.skillRuntimeFiles.skillId, skillId),
        eq(schema.skillRuntimeFiles.filePath, path)
      )
    );
}

async function assertProfileEnvVarLimit(
  db: Db,
  profileId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;

  const countRows = await db
    .select({ count: count() })
    .from(schema.profileRuntimeEnvVars)
    .where(eq(schema.profileRuntimeEnvVars.profileId, profileId));

  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime env vars allowed per profile`);
  }
}

async function assertProfileFileLimit(
  db: Db,
  profileId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;

  const countRows = await db
    .select({ count: count() })
    .from(schema.profileRuntimeFiles)
    .where(eq(schema.profileRuntimeFiles.profileId, profileId));

  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime files allowed per profile`);
  }
}

async function assertSkillEnvVarLimit(
  db: Db,
  skillId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;
  const countRows = await db
    .select({ count: count() })
    .from(schema.skillRuntimeEnvVars)
    .where(eq(schema.skillRuntimeEnvVars.skillId, skillId));
  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime env vars allowed per skill`);
  }
}

async function assertSkillFileLimit(
  db: Db,
  skillId: string,
  maxCount: number,
  alreadyExists: boolean
): Promise<void> {
  if (alreadyExists) return;
  const countRows = await db
    .select({ count: count() })
    .from(schema.skillRuntimeFiles)
    .where(eq(schema.skillRuntimeFiles.skillId, skillId));
  if ((countRows[0]?.count ?? 0) >= maxCount) {
    throw errors.badRequest(`Maximum ${maxCount} runtime files allowed per skill`);
  }
}
