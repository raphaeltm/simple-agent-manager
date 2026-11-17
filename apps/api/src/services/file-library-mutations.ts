import type {
  FileTagSource,
  FileUploadSource,
  ProjectFile,
  ProjectFileTag,
} from '@simple-agent-manager/shared';
import { buildLibraryR2Key } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import {
  type EncryptableFileData,
  encryptFileStream,
  metadataToR2CustomMetadata,
} from './file-encryption';
import {
  getEncryptionChunkBytes,
  getKeyVersion,
  getMaxDirectoriesPerProject,
  getMaxFilesPerProject,
  getMaxTagsPerFile,
  getMaxTotalBytesPerProject,
  getUploadMaxBytes,
  validateDirectory,
  validateFilename,
  validateTag,
} from './file-library-config';
import { rowToProjectFile } from './file-library-mappers';

function fileDataSize(data: EncryptableFileData): number {
  return data instanceof ArrayBuffer ? data.byteLength : data.size;
}

export interface UploadFileOptions {
  description?: string;
  tags?: string[];
  uploadSource?: FileUploadSource;
  uploadSessionId?: string;
  uploadTaskId?: string;
  tagSource?: FileTagSource;
  /** Directory to upload into (default: '/'). Will be validated and normalized. */
  directory?: string;
}

export async function uploadFile(
  db: AppDb,
  r2: R2Bucket,
  encryptionKey: string,
  env: Env,
  projectId: string,
  userId: string,
  filename: string,
  mimeType: string,
  data: EncryptableFileData,
  options: UploadFileOptions = {}
): Promise<ProjectFile & { tags: ProjectFileTag[] }> {
  validateFilename(filename, env);
  const sizeBytes = fileDataSize(data);
  const directory = options.directory ? validateDirectory(options.directory, env) : '/';
  const maxBytes = getUploadMaxBytes(env);
  if (sizeBytes > maxBytes) {
    throw errors.badRequest(`File exceeds maximum size of ${maxBytes} bytes`);
  }

  const maxFiles = getMaxFilesPerProject(env);
  const maxTotalBytes = getMaxTotalBytesPerProject(env);
  const usageResult = await db
    .select({ count: sql<number>`count(*)`, totalBytes: sql<number>`coalesce(sum(size_bytes), 0)` })
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.projectId, projectId));
  const currentCount = usageResult[0]?.count ?? 0;
  const currentTotalBytes = usageResult[0]?.totalBytes ?? 0;
  if (currentCount >= maxFiles) {
    throw errors.badRequest(`Project has reached the maximum of ${maxFiles} files`);
  }
  const maxTotalMB = Math.round(maxTotalBytes / (1024 * 1024));
  if (currentTotalBytes + sizeBytes > maxTotalBytes) {
    const usedMB = Math.round(currentTotalBytes / (1024 * 1024));
    throw errors.badRequest(
      `Project library would exceed the ${maxTotalMB} MB storage limit (currently using ${usedMB} MB)`
    );
  }

  if (directory !== '/') {
    const maxDirs = getMaxDirectoriesPerProject(env);
    const existingDirs = await db
      .select({ directory: schema.projectFiles.directory })
      .from(schema.projectFiles)
      .where(eq(schema.projectFiles.projectId, projectId))
      .groupBy(schema.projectFiles.directory);
    const isNewDirectory = !existingDirs.some((d) => d.directory === directory);
    if (isNewDirectory && existingDirs.length >= maxDirs) {
      throw errors.badRequest(`Project has reached the maximum of ${maxDirs} directories`);
    }
  }

  const existing = await db
    .select({ id: schema.projectFiles.id })
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.projectId, projectId),
        eq(schema.projectFiles.directory, directory),
        eq(schema.projectFiles.filename, filename)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    throw errors.conflict(
      `File "${filename}" already exists in directory "${directory}". Use replace to update it.`
    );
  }

  const tags = options.tags ?? [];
  const maxTags = getMaxTagsPerFile(env);
  if (tags.length > maxTags) {
    throw errors.badRequest(`Maximum ${maxTags} tags per file`);
  }
  for (const tag of tags) validateTag(tag, env);

  const { ciphertext, completion, metadata } = await encryptFileStream(
    data,
    encryptionKey,
    getEncryptionChunkBytes(env),
    getKeyVersion(env)
  );
  const fileId = ulid();
  const r2Key = buildLibraryR2Key(projectId, fileId);
  const now = new Date().toISOString();
  await Promise.all([
    r2.put(r2Key, ciphertext, {
      customMetadata: metadataToR2CustomMetadata(metadata),
      httpMetadata: { contentType: 'application/octet-stream' },
    }),
    completion,
  ]);

  const fileRow: schema.NewProjectFile = {
    id: fileId,
    projectId,
    filename,
    directory,
    mimeType,
    sizeBytes,
    description: options.description ?? null,
    uploadedBy: userId,
    uploadSource: options.uploadSource ?? 'user',
    uploadSessionId: options.uploadSessionId ?? null,
    uploadTaskId: options.uploadTaskId ?? null,
    status: 'ready',
    r2Key,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.projectFiles).values(fileRow);

  const tagRows: ProjectFileTag[] = [];
  if (tags.length > 0) {
    const tagSource = options.tagSource ?? (options.uploadSource === 'agent' ? 'agent' : 'user');
    const tagInserts = tags.map((tag) => ({ fileId, tag, tagSource }));
    await db.insert(schema.projectFileTags).values(tagInserts);
    tagRows.push(
      ...tagInserts.map((tag) => ({
        fileId: tag.fileId,
        tag: tag.tag,
        tagSource: tag.tagSource as FileTagSource,
      }))
    );
  }

  log.info('file_library_upload', { projectId, fileId, filename, sizeBytes });
  return { ...rowToProjectFile(fileRow as schema.ProjectFileRow), tags: tagRows };
}

export async function replaceFile(
  db: AppDb,
  r2: R2Bucket,
  encryptionKey: string,
  env: Env,
  projectId: string,
  fileId: string,
  userId: string,
  filename: string,
  mimeType: string,
  data: EncryptableFileData,
  options: { description?: string } = {}
): Promise<ProjectFile> {
  const sizeBytes = fileDataSize(data);
  const maxBytes = getUploadMaxBytes(env);
  if (sizeBytes > maxBytes) {
    throw errors.badRequest(`File exceeds maximum size of ${maxBytes} bytes`);
  }

  const existing = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);
  if (!existing[0]) throw errors.notFound('File');

  const { ciphertext, completion, metadata } = await encryptFileStream(
    data,
    encryptionKey,
    getEncryptionChunkBytes(env),
    getKeyVersion(env)
  );
  const r2Key = buildLibraryR2Key(projectId, fileId);
  const now = new Date().toISOString();
  await Promise.all([
    r2.put(r2Key, ciphertext, {
      customMetadata: metadataToR2CustomMetadata(metadata),
      httpMetadata: { contentType: 'application/octet-stream' },
    }),
    completion,
  ]);

  await db
    .update(schema.projectFiles)
    .set({
      filename,
      mimeType,
      sizeBytes,
      description:
        options.description !== undefined ? options.description : existing[0].description,
      replacedAt: now,
      replacedBy: userId,
      r2Key,
      updatedAt: now,
    })
    .where(eq(schema.projectFiles.id, fileId));
  log.info('file_library_replace', { projectId, fileId, filename, sizeBytes });

  const updated = await db
    .select()
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.id, fileId))
    .limit(1);
  const updatedRow = updated[0];
  if (!updatedRow) throw errors.internal('File metadata disappeared after replace');
  return rowToProjectFile(updatedRow);
}
