/**
 * File Library service — CRUD operations for per-project encrypted files.
 *
 * Files are encrypted with envelope encryption (DEK per file) and stored in R2.
 * Metadata (filename, tags, ownership) is stored in D1.
 */

import type {
  DirectoryEntry,
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
  validateDirectoryPath,
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

export function getMaxFilenameLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_FILENAME_LENGTH, LIBRARY_DEFAULTS.MAX_FILENAME_LENGTH);
}

export function getDownloadTimeoutMs(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_DOWNLOAD_TIMEOUT_MS, LIBRARY_DEFAULTS.DOWNLOAD_TIMEOUT_MS);
}

export function getKeyVersion(env: Env): string {
  return env.LIBRARY_KEY_VERSION ?? '1';
}

function getListDefaultPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_DEFAULT_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE);
}

export function getListMaxPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_MAX_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE);
}

export function getMaxDirectoryDepth(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORY_DEPTH, LIBRARY_DEFAULTS.MAX_DIRECTORY_DEPTH);
}

export function getMaxDirectoryPathLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORY_PATH_LENGTH, LIBRARY_DEFAULTS.MAX_DIRECTORY_PATH_LENGTH);
}

export function getMaxDirectoriesPerProject(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORIES_PER_PROJECT, LIBRARY_DEFAULTS.MAX_DIRECTORIES_PER_PROJECT);
}

/** Validate a directory path using configurable env limits. Throws on invalid. Returns normalized path. */
export function validateDirectory(directory: string, env: Env): string {
  return validateDirectoryPath(directory, getMaxDirectoryDepth(env), getMaxDirectoryPathLength(env));
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

export function validateFilename(filename: string, env: Env): void {
  const maxLen = getMaxFilenameLength(env);
  if (!filename || filename.length > maxLen) {
    throw errors.badRequest(`Filename must be 1-${maxLen} characters`);
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
    directory: row.directory,
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
  data: ArrayBuffer,
  options: UploadFileOptions = {}
): Promise<ProjectFile & { tags: ProjectFileTag[] }> {
  validateFilename(filename, env);

  // Validate and normalize directory
  const directory = options.directory ? validateDirectory(options.directory, env) : '/';

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

  // Check directory count limit (only when uploading to a new directory)
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

  // Check for duplicate filename in the same directory
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
    throw errors.conflict(`File "${filename}" already exists in directory "${directory}". Use replace to update it.`);
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
  const { ciphertext, metadata } = await encryptFile(data, encryptionKey, getKeyVersion(env));

  const fileId = ulid();
  const r2Key = buildLibraryR2Key(projectId, fileId);
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
    directory,
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
  const { ciphertext, metadata } = await encryptFile(data, encryptionKey, getKeyVersion(env));

  const r2Key = buildLibraryR2Key(projectId, fileId);
  const now = new Date().toISOString();

  // Upload new encrypted data to R2 (overwrites existing object — key is stable)
  await r2.put(r2Key, ciphertext, {
    customMetadata: metadataToR2CustomMetadata(metadata),
    httpMetadata: { contentType: 'application/octet-stream' },
  });

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
      r2Key: r2Key,
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

  // Directory filtering
  if (filters.directory) {
    if (filters.recursive) {
      // Include files in this directory and all subdirectories
      const escapedDir = filters.directory.replace(/[%_]/g, '\\$&');
      conditions.push(like(schema.projectFiles.directory, `${escapedDir}%`));
    } else {
      // Only files directly in this directory
      conditions.push(eq(schema.projectFiles.directory, filters.directory));
    }
  } else if (!filters.recursive && !filters.search) {
    // Default: show only root-level files (unless searching or recursive)
    conditions.push(eq(schema.projectFiles.directory, '/'));
  }

  if (filters.status) {
    conditions.push(eq(schema.projectFiles.status, filters.status));
  }
  if (filters.uploadSource) {
    conditions.push(eq(schema.projectFiles.uploadSource, filters.uploadSource));
  }
  if (filters.mimeType) {
    const escapedMime = filters.mimeType.replace(/[%_]/g, '\\$&');
    conditions.push(like(schema.projectFiles.mimeType, `${escapedMime}%`));
  }
  if (filters.search) {
    // Escape LIKE wildcards to prevent pattern abuse
    const escaped = filters.search.replace(/[%_]/g, '\\$&');
    conditions.push(like(schema.projectFiles.filename, `%${escaped}%`));
  }
  if (filters.cursor) {
    // Cursor pagination only works correctly with ID/createdAt ordering (ULIDs are time-sorted)
    if (filters.sortBy && filters.sortBy !== 'createdAt') {
      throw errors.badRequest('Cursor pagination is only supported with sortBy=createdAt or default sort');
    }
    conditions.push(sql`${schema.projectFiles.id} > ${filters.cursor}`);
  }

  // Validate and determine sort
  const VALID_SORT_FIELDS = ['filename', 'createdAt', 'updatedAt', 'sizeBytes'] as const;
  if (filters.sortBy && !VALID_SORT_FIELDS.includes(filters.sortBy as (typeof VALID_SORT_FIELDS)[number])) {
    throw errors.badRequest(`Invalid sortBy value: ${filters.sortBy}`);
  }
  const sortField = filters.sortBy ?? 'createdAt';
  const sortDir = filters.sortOrder ?? 'desc';
  const sortColumn = {
    filename: schema.projectFiles.filename,
    createdAt: schema.projectFiles.createdAt,
    updatedAt: schema.projectFiles.updatedAt,
    sizeBytes: schema.projectFiles.sizeBytes,
  }[sortField];
  const orderFn = sortDir === 'asc' ? asc : desc;

  // Push tag filter into SQL for correct pagination
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(
      sql`${schema.projectFiles.id} IN (
        SELECT ${schema.projectFileTags.fileId} FROM ${schema.projectFileTags}
        WHERE ${schema.projectFileTags.tag} IN (${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)})
        GROUP BY ${schema.projectFileTags.fileId}
        HAVING COUNT(DISTINCT ${schema.projectFileTags.tag}) = ${filters.tags.length}
      )`
    );
  }

  // Query files
  const files = await db
    .select()
    .from(schema.projectFiles)
    .where(and(...conditions))
    .orderBy(orderFn(sortColumn))
    .limit(pageSize + 1); // +1 to detect next page

  // Determine pagination
  const hasMore = files.length > pageSize;
  const resultFiles = hasMore ? files.slice(0, pageSize) : files;
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

  // Total count — same filters as main query but without cursor condition
  const countConds = [eq(schema.projectFiles.projectId, projectId)];
  // Mirror directory filtering for count
  if (filters.directory) {
    if (filters.recursive) {
      const escapedDir = filters.directory.replace(/[%_]/g, '\\$&');
      countConds.push(like(schema.projectFiles.directory, `${escapedDir}%`));
    } else {
      countConds.push(eq(schema.projectFiles.directory, filters.directory));
    }
  } else if (!filters.recursive && !filters.search) {
    countConds.push(eq(schema.projectFiles.directory, '/'));
  }
  if (filters.status) countConds.push(eq(schema.projectFiles.status, filters.status));
  if (filters.uploadSource) countConds.push(eq(schema.projectFiles.uploadSource, filters.uploadSource));
  if (filters.mimeType) {
    const escapedMime = filters.mimeType.replace(/[%_]/g, '\\$&');
    countConds.push(like(schema.projectFiles.mimeType, `${escapedMime}%`));
  }
  if (filters.search) {
    const escaped = filters.search.replace(/[%_]/g, '\\$&');
    countConds.push(like(schema.projectFiles.filename, `%${escaped}%`));
  }
  if (filters.tags && filters.tags.length > 0) {
    countConds.push(
      sql`${schema.projectFiles.id} IN (
        SELECT ${schema.projectFileTags.fileId} FROM ${schema.projectFileTags}
        WHERE ${schema.projectFileTags.tag} IN (${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)})
        GROUP BY ${schema.projectFileTags.fileId}
        HAVING COUNT(DISTINCT ${schema.projectFileTags.tag}) = ${filters.tags.length}
      )`
    );
  }
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.projectFiles)
    .where(and(...countConds));
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

  // Delete D1 first (safer order — orphaned R2 objects are benign, orphaned D1 rows are errors)
  // Explicitly delete tags since D1 may not have PRAGMA foreign_keys = ON
  await db.delete(schema.projectFileTags).where(eq(schema.projectFileTags.fileId, fileId));
  await db.delete(schema.projectFiles).where(eq(schema.projectFiles.id, fileId));

  // Then delete R2 object (best-effort)
  await r2.delete(rows[0].r2Key);

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

// ---------------------------------------------------------------------------
// Move file (change directory and/or filename)
// ---------------------------------------------------------------------------

export async function moveFile(
  db: AppDb,
  env: Env,
  projectId: string,
  fileId: string,
  move: { directory?: string; filename?: string }
): Promise<ProjectFile> {
  // Fetch existing
  const rows = await db
    .select()
    .from(schema.projectFiles)
    .where(and(eq(schema.projectFiles.id, fileId), eq(schema.projectFiles.projectId, projectId)))
    .limit(1);
  if (!rows[0]) {
    throw errors.notFound('File');
  }

  const existing = rows[0];
  const newDirectory = move.directory ? validateDirectory(move.directory, env) : existing.directory;
  const newFilename = move.filename ?? existing.filename;

  if (move.filename) {
    validateFilename(newFilename, env);
  }

  // Check no change
  if (newDirectory === existing.directory && newFilename === existing.filename) {
    return rowToProjectFile(existing);
  }

  // Check for collision at destination
  const collision = await db
    .select({ id: schema.projectFiles.id })
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.projectId, projectId),
        eq(schema.projectFiles.directory, newDirectory),
        eq(schema.projectFiles.filename, newFilename)
      )
    )
    .limit(1);
  if (collision.length > 0 && collision[0]!.id !== fileId) {
    throw errors.conflict(`File "${newFilename}" already exists in directory "${newDirectory}"`);
  }

  const now = new Date().toISOString();
  await db
    .update(schema.projectFiles)
    .set({ directory: newDirectory, filename: newFilename, updatedAt: now })
    .where(eq(schema.projectFiles.id, fileId));

  log.info('file_library_move', {
    projectId,
    fileId,
    fromDir: existing.directory,
    toDir: newDirectory,
    fromFilename: existing.filename,
    toFilename: newFilename,
  });

  const updated = await db
    .select()
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.id, fileId))
    .limit(1);
  return rowToProjectFile(updated[0]!);
}

// ---------------------------------------------------------------------------
// List directories
// ---------------------------------------------------------------------------

export async function listDirectories(
  db: AppDb,
  projectId: string,
  parentDirectory: string = '/',
  env?: Env,
): Promise<DirectoryEntry[]> {
  // Query all distinct directories that start with the parent path
  const escapedParent = parentDirectory.replace(/[%_]/g, '\\$&');
  const maxDirs = env ? getMaxDirectoriesPerProject(env) : LIBRARY_DEFAULTS.MAX_DIRECTORIES_PER_PROJECT;
  const allDirs = await db
    .select({
      directory: schema.projectFiles.directory,
      count: sql<number>`count(*)`,
    })
    .from(schema.projectFiles)
    .where(
      and(
        eq(schema.projectFiles.projectId, projectId),
        like(schema.projectFiles.directory, `${escapedParent}%`)
      )
    )
    .groupBy(schema.projectFiles.directory)
    .limit(maxDirs + 1);

  // Extract immediate children of parentDirectory
  const childDirs = new Map<string, number>();
  const parentDepth = parentDirectory === '/' ? 0 : parentDirectory.split('/').filter(Boolean).length;

  for (const row of allDirs) {
    const segments = row.directory.split('/').filter(Boolean);
    // Only consider directories that are deeper than parent
    if (segments.length <= parentDepth) continue;

    // Build the immediate child path
    const childSegments = segments.slice(0, parentDepth + 1);
    const childPath = '/' + childSegments.join('/') + '/';

    const current = childDirs.get(childPath) ?? 0;
    // Only count files directly in this directory (not subdirectories)
    if (row.directory === childPath) {
      childDirs.set(childPath, current + row.count);
    } else {
      // Ensure the entry exists even if no files are directly in it
      if (!childDirs.has(childPath)) {
        childDirs.set(childPath, 0);
      }
    }
  }

  return Array.from(childDirs.entries())
    .map(([path, fileCount]) => {
      const segments = path.split('/').filter(Boolean);
      return {
        path,
        name: segments[segments.length - 1]!,
        fileCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
