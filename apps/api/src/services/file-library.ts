/**
 * File Library service — CRUD operations for per-project encrypted files.
 *
 * Files are encrypted with envelope encryption (DEK per file) and stored in R2.
 * Metadata (filename, tags, ownership) is stored in D1.
 *
 * Config/validation helpers: ./file-library-config.ts
 * Directory operations (move, listDirectories): ./file-library-directories.ts
 */

import type {
  FileEncryptionMetadata,
  FileTagSource,
  ListFilesRequest,
  ListFilesResponse,
  ProjectFile,
  ProjectFileTag,
  UpdateTagsRequest,
} from '@simple-agent-manager/shared';
import { buildLibraryR2Key } from '@simple-agent-manager/shared';
import { and, asc, desc, eq, inArray, like, notLike, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { chunk } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import {
  decryptFile,
  r2CustomMetadataToMetadata,
} from './file-encryption';
import {
  getListMaxPageSize,
  getMaxTagsPerFile,
  getTagQueryBatchSize,
  validateDirectory,
  validateFilename,
  validateTag,
} from './file-library-config';
import { rowToProjectFile, rowToTag } from './file-library-mappers';

// Re-export config, validation, and directory functions for consumers
export {
  getDownloadTimeoutMs,
  getEncryptionChunkBytes,
  getKeyVersion,
  getListMaxPageSize,
  getMaxDirectoriesPerProject,
  getMaxDirectoryDepth,
  getMaxDirectoryPathLength,
  getMaxFilenameLength,
  getMaxFilesPerProject,
  getMaxTagLength,
  getMaxTagsPerFile,
  getMultipartBodyMaxBytes,
  getProjectDeleteCleanupBatchSize,
  getTagQueryBatchSize,
  getUploadMaxBytes,
  resolvePageSize,
  validateDirectory,
  validateFilename,
  validateTag,
} from './file-library-config';
export { listDirectories, moveFile } from './file-library-directories';
export { replaceFile, uploadFile } from './file-library-mutations';
export type { UploadFileOptions } from './file-library-mutations';

export interface ProjectLibraryObjectCleanupStats {
  prefix: string;
  listedObjects: number;
  deletedObjects: number;
}

/** Build the canonical project-owned R2 prefix and reject hierarchy injection. */
export function buildProjectLibraryR2Prefix(projectId: string): string {
  if (!projectId || projectId.includes('/')) {
    throw new Error('Project ID is not safe for a library R2 prefix');
  }
  return buildLibraryR2Key(projectId, '');
}

/**
 * Build the exact D1 statements used by project deletion. Tags must be selected
 * through project_files because project_file_tags intentionally has no project_id.
 */
export function buildProjectLibraryDeleteStatements(db: AppDb, projectId: string) {
  const projectFileIds = db
    .select({ id: schema.projectFiles.id })
    .from(schema.projectFiles)
    .where(eq(schema.projectFiles.projectId, projectId));

  return [
    db.delete(schema.projectFileTags).where(inArray(schema.projectFileTags.fileId, projectFileIds)),
    db.delete(schema.projectFiles).where(eq(schema.projectFiles.projectId, projectId)),
  ];
}

/** List and delete only one project's canonical library prefix. */
export async function deleteProjectLibraryObjects(
  r2: R2Bucket,
  projectId: string,
  batchSize: number
): Promise<ProjectLibraryObjectCleanupStats> {
  const prefix = buildProjectLibraryR2Prefix(projectId);
  const stats: ProjectLibraryObjectCleanupStats = {
    prefix,
    listedObjects: 0,
    deletedObjects: 0,
  };
  let cursor: string | undefined;

  do {
    const page = await r2.list({ prefix, cursor, limit: batchSize });
    const keys = page.objects.map((object) => object.key);
    stats.listedObjects += keys.length;

    // Defence in depth: never trust a storage adapter that returns keys outside the
    // requested tenant prefix. Abort before deleting any key from that page.
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new Error('R2 returned an object outside the requested project library prefix');
    }

    if (keys.length > 0) {
      await r2.delete(keys);
      stats.deletedObjects += keys.length;
    }

    if (page.truncated && !page.cursor) {
      throw new Error('R2 returned a truncated project library listing without a cursor');
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return stats;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function getListDefaultPageSize(env: Env): number {
  const val = env.LIBRARY_LIST_DEFAULT_PAGE_SIZE;
  if (!val) return 50;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? 50 : parsed;
}

export async function listFiles(
  db: AppDb,
  env: Env,
  projectId: string,
  filters: ListFilesRequest = {},
  /** Hide every file whose directory starts with this prefix (restricted directories). */
  options: { excludeDirectoryPrefix?: string } = {}
): Promise<ListFilesResponse> {
  const pageSize = Math.min(filters.limit ?? getListDefaultPageSize(env), getListMaxPageSize(env));

  // Build conditions
  const conditions = [eq(schema.projectFiles.projectId, projectId)];
  if (options.excludeDirectoryPrefix) {
    const escaped = options.excludeDirectoryPrefix.replace(/[%_]/g, '\\$&');
    conditions.push(notLike(schema.projectFiles.directory, `${escaped}%`));
  }

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
      throw errors.badRequest(
        'Cursor pagination is only supported with sortBy=createdAt or default sort'
      );
    }
    conditions.push(sql`${schema.projectFiles.id} > ${filters.cursor}`);
  }

  // Validate and determine sort
  const VALID_SORT_FIELDS = ['filename', 'createdAt', 'updatedAt', 'sizeBytes'] as const;
  if (
    filters.sortBy &&
    !VALID_SORT_FIELDS.includes(filters.sortBy as (typeof VALID_SORT_FIELDS)[number])
  ) {
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
        WHERE ${schema.projectFileTags.tag} IN (${sql.join(
          filters.tags.map((t) => sql`${t}`),
          sql`, `
        )})
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
  const nextCursor = hasMore ? (resultFiles[resultFiles.length - 1]?.id ?? null) : null;

  // Fetch tags for result files
  const resultFileIds = resultFiles.map((f) => f.id);
  const allTags: schema.ProjectFileTagRow[] = [];
  if (resultFileIds.length > 0) {
    const tagQueryBatchSize = getTagQueryBatchSize(env);
    for (const batch of chunk(resultFileIds, tagQueryBatchSize)) {
      const batchTags = await db
        .select()
        .from(schema.projectFileTags)
        .where(inArray(schema.projectFileTags.fileId, batch));
      allTags.push(...batchTags);
    }
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
  if (filters.uploadSource)
    countConds.push(eq(schema.projectFiles.uploadSource, filters.uploadSource));
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
        WHERE ${schema.projectFileTags.tag} IN (${sql.join(
          filters.tags.map((t) => sql`${t}`),
          sql`, `
        )})
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

export { deleteFile, deleteFiles } from './file-library-delete';

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
      await db
        .insert(schema.projectFileTags)
        .values(newTags.map((tag) => ({ fileId, tag, tagSource })));
    }
  }

  // Return updated tags
  const updatedTags = await db
    .select()
    .from(schema.projectFileTags)
    .where(eq(schema.projectFileTags.fileId, fileId));

  return updatedTags.map(rowToTag);
}
