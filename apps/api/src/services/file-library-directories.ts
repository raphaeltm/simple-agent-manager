/**
 * File Library directory operations — move files and list directories.
 */

import type {
  DirectoryEntry,
  FileStatus,
  FileUploadSource,
  ProjectFile,
} from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { and, eq, like, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import {
  getMaxDirectoriesPerProject,
  validateDirectory,
  validateFilename,
} from './file-library-config';

// ---------------------------------------------------------------------------
// Row → API type (duplicated from file-library.ts to avoid circular imports)
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
  const collisionRow = collision[0];
  if (collisionRow && collisionRow.id !== fileId) {
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
  const updatedRow = updated[0];
  if (!updatedRow) {
    throw new Error(`File ${fileId} disappeared after being moved`);
  }
  return rowToProjectFile(updatedRow);
}

// ---------------------------------------------------------------------------
// List directories
// ---------------------------------------------------------------------------

export async function listDirectories(
  db: AppDb,
  projectId: string,
  parentDirectory: string = '/',
  env?: Env,
  search?: string
): Promise<DirectoryEntry[]> {
  // When searching, query ALL directories in the project (not just children of parentDirectory)
  const useParent = search ? '/' : parentDirectory;
  const escapedParent = useParent.replace(/[%_]/g, '\\$&');
  const maxDirs = env
    ? getMaxDirectoriesPerProject(env)
    : LIBRARY_DEFAULTS.MAX_DIRECTORIES_PER_PROJECT;
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

  // When searching, collect all unique directory paths and filter by name match
  if (search) {
    const searchLower = search.toLowerCase();
    const matchedDirs = new Map<string, number>();

    for (const row of allDirs) {
      const segments = row.directory.split('/').filter(Boolean);
      // Check each segment for a match — include the directory if any segment matches
      const matches = segments.some((seg) => seg.toLowerCase().includes(searchLower));
      if (matches) {
        const current = matchedDirs.get(row.directory) ?? 0;
        matchedDirs.set(row.directory, current + row.count);
      }
    }

    return Array.from(matchedDirs.entries())
      .flatMap(([path, fileCount]) => {
        const segments = path.split('/').filter(Boolean);
        const name = segments.at(-1);
        if (name === undefined) {
          // Every path in matchedDirs matched a non-empty segment search, so
          // this should never happen — skip defensively rather than surface
          // a corrupt entry.
          log.warn('file_library_list_directories.invalid_search_path_skipped', {
            projectId,
            path,
          });
          return [];
        }
        return [{ path, name, fileCount }];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Extract immediate children of parentDirectory (non-search path)
  const childDirs = new Map<string, number>();
  const parentDepth = useParent === '/' ? 0 : useParent.split('/').filter(Boolean).length;

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
    .flatMap(([path, fileCount]) => {
      const segments = path.split('/').filter(Boolean);
      const name = segments.at(-1);
      if (name === undefined) {
        // childPath is always built from at least one non-empty segment
        // (segments.length > parentDepth >= 0 was checked above), so this
        // should never happen — skip defensively rather than surface a
        // corrupt entry.
        log.warn('file_library_list_directories.invalid_child_path_skipped', {
          projectId,
          path,
        });
        return [];
      }
      return [{ path, name, fileCount }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
