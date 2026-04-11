/**
 * File Library directory operations — move files and list directories.
 */

import type { DirectoryEntry, FileStatus, FileUploadSource, ProjectFile } from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { and, eq, like, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../index';
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
