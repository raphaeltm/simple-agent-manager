/**
 * File Library service — CRUD operations for per-project encrypted files.
 *
 * Files are encrypted with envelope encryption (DEK per file) and stored in R2.
 * Metadata (filename, tags, ownership) is stored in D1.
 */

import type {
  FileEncryptionMetadata,
  FileStatus,
  FileTagSource,
  FileUploadSource,
  ListFilesRequest,
  ListFilesResponse,
  ProjectFile,
  ProjectFileTag,
  UpdateTagsRequest,
} from '@simple-agent-manager/shared';
import {
  buildLibraryR2Key,
  LIBRARY_DEFAULTS,
  LIBRARY_FILENAME_PATTERN,
  LIBRARY_TAG_PATTERN,
} from '@simple-agent-manager/shared';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import {
  decryptFile,
  encryptFile,
  metadataToR2CustomMetadata,
  r2CustomMetadataToMetadata,
} from './file-encryption';

// ---------------------------------------------------------------------------
// Config helpers (all limits configurable per constitution Principle XI)
// ---------------------------------------------------------------------------

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function getUploadMaxBytes(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_UPLOAD_MAX_BYTES, LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES);
}

export function getMaxFilesPerProject(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_FILES_PER_PROJECT, LIBRARY_DEFAULTS.MAX_FILES_PER_PROJECT);
}

export function getMaxTagsPerFile(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_TAGS_PER_FILE, LIBRARY_DEFAULTS.MAX_TAGS_PER_FILE);
}

export function getMaxTagLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_TAG_LENGTH, LIBRARY_DEFAULTS.MAX_TAG_LENGTH);
}

export function getDownloadTimeoutMs(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_DOWNLOAD_TIMEOUT_MS, LIBRARY_DEFAULTS.DOWNLOAD_TIMEOUT_MS);
}

function getListDefaultPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_DEFAULT_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE);
}

function getListMaxPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_MAX_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

export function validateTag(tag: string, env: Env): void {
  const maxLen = getMaxTagLength(env);
  if (tag.length === 0 || tag.length > maxLen) {
    throw errors.badRequest(`Tag must be 1-${maxLen} characters`);
  }
  if (!LIBRARY_TAG_PATTERN.test(tag)) {
    throw errors.badRequest(`Tag "${tag}" must be lowercase alphanumeric with hyphens`);
  }
}

export function validateFilename(filename: string): void {
  if (!filename || filename.length > 255) {
    throw errors.badRequest('Filename must be 1-255 characters');
  }
  if (!LIBRARY_FILENAME_PATTERN.test(filename)) {
    throw errors.badRequest('Filename contains invalid characters');
  }
}

// ---------------------------------------------------------------------------
// Row → API type mapping
// ---------------------------------------------------------------------------

function rowToProjectFile(row: schema.ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    projectId: row.projectId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    description: row.description,
    uploadedBy: row.uploadedBy,
    uploadSource: row.uploadSource as FileUploadSource,
    uploadSessionId: row.uploadSessionId,
    uploadTaskId: row.uploadTaskId,
    replacedAt: row.replacedAt,
    replacedBy: row.replacedBy,
    status: row.status as FileStatus,
    r2Key: row.r2Key,
    extractedTextPreview: row.extractedTextPreview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTag(row: schema.ProjectFileTagRow): ProjectFileTag {
  return {
    fileId: row.fileId,
    tag: row.tag,
    tagSource: row.tagSource as FileTagSource,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadFileOptions {
  description?: string;
  tags?: string[];
  uploadSource?: FileUploadSource;
  uploadSessionId?: string;
  uploadTaskId?: string;
  tagSource?: FileTagSource;
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
  data: ArrayBuffer,
  options: UploadFileOptions = {}
): Promise<ProjectFile & { tags: ProjectFileTag[] }> {
  validateFilename(filename);

  // Check file size limit
  const maxBytes = getUploadMaxBytes(env);
  if (data.byteLength > maxBytes) {
    throw errors.badRequest(`File exceeds maximum size of ${maxBytes} bytes`);
  }

  // Check project file count limit
  const maxFiles = getMaxFilesPerProject(env);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.projectId, projectId));
  const currentCount = countResult[0]?.count ?? 0;
  if (currentCount >= maxFiles) {
    throw errors.badRequest(`Project has reached the maximum of ${maxFiles} files`);
  }

  // Check for duplicate filename
  const existing = await db
    .select({ id: schema.projectFiles.id })
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.projectId, projectId),
        eq(schema.projectFiles.filename, filename)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    throw errors.conflict(`File "${filename}" already exists in this project. Use replace to update it.`);
  }

  // Validate tags
  const tags = options.tags ?? [];
  const maxTags = getMaxTagsPerFile(env);
  if (tags.length > maxTags) {
    throw errors.badRequest(`Maximum ${maxTags} tags per file`);
  }
  for (const tag of tags) {
    validateTag(tag, env);
  }

  // Encrypt file data
  const { ciphertext, metadata } = await encryptFile(data, encryptionKey);

  const fileId = ulid();
  const r2Key = buildLibraryR2Key(projectId, fileId, filename);
  const now = new Date().toISOString();

  // Store encrypted data in R2 with encryption metadata
  await r2.put(r2Key, ciphertext, {
    customMetadata: metadataToR2CustomMetadata(metadata),
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  // Insert D1 metadata
  const fileRow: schema.NewProjectFile = {
    id: fileId,
    projectId,
    filename,
    mimeType,
    sizeBytes: data.byteLength,
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

  // Insert tags
  const tagRows: ProjectFileTag[] = [];
  if (tags.length > 0) {
    const tagSource = options.tagSource ?? (options.uploadSource === 'agent' ? 'agent' : 'user');
    const tagInserts = tags.map((tag) => ({
      fileId,
      tag,
      tagSource,
    }));
    await db.insert(schema.projectFileTags).values(tagInserts);
    tagRows.push(...tagInserts.map((t) => ({ fileId: t.fileId, tag: t.tag, tagSource: t.tagSource as FileTagSource })));
  }

  log.info('file_library_upload', { projectId, fileId, filename, sizeBytes: data.byteLength });

  return { ...rowToProjectFile(fileRow as schema.ProjectFileRow), tags: tagRows };
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

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
  data: ArrayBuffer,
  options: { description?: string } = {}
): Promise<ProjectFile> {
  // Fetch existing file
  const existing = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);
  if (!existing[0]) {
    throw errors.notFound('File');
  }

  // Check file size
  const maxBytes = getUploadMaxBytes(env);
  if (data.byteLength > maxBytes) {
    throw errors.badRequest(`File exceeds maximum size of ${maxBytes} bytes`);
  }

  // Encrypt new content
  const { ciphertext, metadata } = await encryptFile(data, encryptionKey);

  const oldR2Key = existing[0].r2Key;
  const newR2Key = buildLibraryR2Key(projectId, fileId, filename);
  const now = new Date().toISOString();

  // Upload new encrypted data to R2
  await r2.put(newR2Key, ciphertext, {
    customMetadata: metadataToR2CustomMetadata(metadata),
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  // Delete old R2 object if key changed (filename change)
  if (oldR2Key !== newR2Key) {
    await r2.delete(oldR2Key);
  }

  // Update D1
  await db
    .update(schema.projectFiles)
    .set({
      filename,
      mimeType,
      sizeBytes: data.byteLength,
      description: options.description !== undefined ? options.description : existing[0].description,
      replacedAt: now,
      replacedBy: userId,
      r2Key: newR2Key,
      updatedAt: now,
    })
    .where(eq(schema.projectFiles.id, fileId));

  log.info('file_library_replace', { projectId, fileId, filename, sizeBytes: data.byteLength });

  const updated = await db
    .select()
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.id, fileId))
    .limit(1);

  return rowToProjectFile(updated[0]!);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listFiles(
  db: AppDb,
  env: Env,
  projectId: string,
  filters: ListFilesRequest = {}
): Promise<ListFilesResponse> {
  const pageSize = Math.min(
    filters.limit ?? getListDefaultPageSize(env),
    getListMaxPageSize(env)
  );

  // Build conditions
  const conditions = [eq(schema.projectFiles.projectId, projectId)];

  if (filters.status) {
    conditions.push(eq(schema.projectFiles.status, filters.status));
  }
  if (filters.uploadSource) {
    conditions.push(eq(schema.projectFiles.uploadSource, filters.uploadSource));
  }
  if (filters.mimeType) {
    conditions.push(like(schema.projectFiles.mimeType, `${filters.mimeType}%`));
  }
  if (filters.search) {
    conditions.push(like(schema.projectFiles.filename, `%${filters.search}%`));
  }
  if (filters.cursor) {
    // Cursor-based pagination: files after the cursor ID (by createdAt/id)
    conditions.push(sql`${schema.projectFiles.id} > ${filters.cursor}`);
  }

  // Determine sort
  const sortField = filters.sortBy ?? 'createdAt';
  const sortDir = filters.sortOrder ?? 'desc';
  const sortColumn = {
    filename: schema.projectFiles.filename,
    createdAt: schema.projectFiles.createdAt,
    updatedAt: schema.projectFiles.updatedAt,
    sizeBytes: schema.projectFiles.sizeBytes,
  }[sortField];
  const orderFn = sortDir === 'asc' ? asc : desc;

  // Query files
  const filesQuery = db
    .select()
    .from(schema.projectFiles)
    .where(and(...conditions))
    .orderBy(orderFn(sortColumn))
    .limit(pageSize + 1); // +1 to detect next page

  const files = await filesQuery;

  // Check for tag filter — post-filter if tags specified
  let filteredFiles = files;
  if (filters.tags && filters.tags.length > 0) {
    const fileIds = files.map((f) => f.id);
    if (fileIds.length > 0) {
      const tagMatches = await db
        .select()
        .from(schema.projectFileTags)
        .where(
          and(
            inArray(schema.projectFileTags.fileId, fileIds),
            inArray(schema.projectFileTags.tag, filters.tags)
          )
        );
      // Group by fileId, count distinct matching tags
      const tagCountByFile = new Map<string, Set<string>>();
      for (const row of tagMatches) {
        const set = tagCountByFile.get(row.fileId) ?? new Set();
        set.add(row.tag);
        tagCountByFile.set(row.fileId, set);
      }
      // Keep only files that have ALL requested tags
      filteredFiles = files.filter((f) => {
        const matchedTags = tagCountByFile.get(f.id);
        return matchedTags && matchedTags.size >= filters.tags!.length;
      });
    }
  }

  // Determine pagination
  const hasMore = filteredFiles.length > pageSize;
  const resultFiles = hasMore ? filteredFiles.slice(0, pageSize) : filteredFiles;
  const nextCursor = hasMore ? resultFiles[resultFiles.length - 1]?.id ?? null : null;

  // Fetch tags for result files
  const resultFileIds = resultFiles.map((f) => f.id);
  let allTags: schema.ProjectFileTagRow[] = [];
  if (resultFileIds.length > 0) {
    allTags = await db
      .select()
      .from(schema.projectFileTags)
      .where(inArray(schema.projectFileTags.fileId, resultFileIds));
  }

  const tagsByFile = new Map<string, ProjectFileTag[]>();
  for (const tag of allTags) {
    const list = tagsByFile.get(tag.fileId) ?? [];
    list.push(rowToTag(tag));
    tagsByFile.set(tag.fileId, list);
  }

  // Total count (without pagination)
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.projectId, projectId));
  const total = totalResult[0]?.count ?? 0;

  return {
    files: resultFiles.map((f) => ({
      ...rowToProjectFile(f),
      tags: tagsByFile.get(f.id) ?? [],
    })),
    cursor: nextCursor,
    total,
  };
}

// ---------------------------------------------------------------------------
// Get single file metadata
// ---------------------------------------------------------------------------

export async function getFile(
  db: AppDb,
  projectId: string,
  fileId: string
): Promise<{ file: ProjectFile; tags: ProjectFileTag[] }> {
  const rows = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);

  if (!rows[0]) {
    throw errors.notFound('File');
  }

  const tags = await db
    .select()
    .from(schema.projectFileTags)
    .where(eq(schema.projectFileTags.fileId, fileId));

  return {
    file: rowToProjectFile(rows[0]),
    tags: tags.map(rowToTag),
  };
}

// ---------------------------------------------------------------------------
// Download (decrypt + return)
// ---------------------------------------------------------------------------

export async function downloadFile(
  db: AppDb,
  r2: R2Bucket,
  encryptionKey: string,
  projectId: string,
  fileId: string
): Promise<{ data: ArrayBuffer; file: ProjectFile; metadata: FileEncryptionMetadata }> {
  const rows = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);

  if (!rows[0]) {
    throw errors.notFound('File');
  }

  const fileRow = rows[0];

  // Fetch from R2
  const r2Object = await r2.get(fileRow.r2Key);
  if (!r2Object) {
    log.error('file_library_r2_missing', { projectId, fileId, r2Key: fileRow.r2Key });
    throw errors.internal('File data not found in storage');
  }

  // Read encryption metadata from R2 custom metadata
  const encMeta = r2CustomMetadataToMetadata(r2Object.customMetadata ?? {});

  // Decrypt
  const ciphertext = await r2Object.arrayBuffer();
  const plaintext = await decryptFile(ciphertext, encMeta, encryptionKey);

  return {
    data: plaintext,
    file: rowToProjectFile(fileRow),
    metadata: encMeta,
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(
  db: AppDb,
  r2: R2Bucket,
  projectId: string,
  fileId: string
): Promise<void> {
  const rows = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);

  if (!rows[0]) {
    throw errors.notFound('File');
  }

  // Delete R2 object
  await r2.delete(rows[0].r2Key);

  // Tags are cascade-deleted by FK
  await db.delete(schema.projectFiles).where(eq(schema.projectFiles.id, fileId));

  log.info('file_library_delete', { projectId, fileId, filename: rows[0].filename });
}

// ---------------------------------------------------------------------------
// Tag management
// ---------------------------------------------------------------------------

export async function updateTags(
  db: AppDb,
  env: Env,
  projectId: string,
  fileId: string,
  request: UpdateTagsRequest,
  tagSource: FileTagSource = 'user'
): Promise<ProjectFileTag[]> {
  // Verify file exists and belongs to project
  const rows = await db
    .select({ id: schema.projectFiles.id })
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);

  if (!rows[0]) {
    throw errors.notFound('File');
  }

  // Remove tags
  if (request.remove && request.remove.length > 0) {
    await db
      .delete(schema.projectFileTags)
      .where(
        and(
          eq(schema.projectFileTags.fileId, fileId),
          inArray(schema.projectFileTags.tag, request.remove)
        )
      );
  }

  // Add tags (validate first)
  if (request.add && request.add.length > 0) {
    for (const tag of request.add) {
      validateTag(tag, env);
    }

    // Check total tag count after addition
    const existingTags = await db
      .select()
      .from(schema.projectFileTags)
      .where(eq(schema.projectFileTags.fileId, fileId));

    const existingSet = new Set(existingTags.map((t) => t.tag));
    const newTags = request.add.filter((t) => !existingSet.has(t));
    const maxTags = getMaxTagsPerFile(env);

    if (existingTags.length + newTags.length > maxTags) {
      throw errors.badRequest(`File would exceed maximum of ${maxTags} tags`);
    }

    if (newTags.length > 0) {
      await db.insert(schema.projectFileTags).values(
        newTags.map((tag) => ({ fileId, tag, tagSource }))
      );
    }
  }

  // Return updated tags
  const updatedTags = await db
    .select()
    .from(schema.projectFileTags)
    .where(eq(schema.projectFileTags.fileId, fileId));

  return updatedTags.map(rowToTag);
}
