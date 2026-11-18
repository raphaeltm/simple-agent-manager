/**
 * Project library deletes. D1 rows go first (an orphaned R2 object is benign, an orphaned D1
 * row is an error), then the R2 objects, best-effort.
 */
import { and, eq, inArray } from 'drizzle-orm';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';

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

  // Explicitly delete tags since D1 may not have PRAGMA foreign_keys = ON
  await db.delete(schema.projectFileTags).where(eq(schema.projectFileTags.fileId, fileId));
  await db.delete(schema.projectFiles).where(eq(schema.projectFiles.id, fileId));

  await r2.delete(rows[0].r2Key);

  log.info('file_library_delete', { projectId, fileId, filename: rows[0].filename });
}

/**
 * Deletes many files of one project in a fixed number of round trips: one lookup, one R2
 * delete, one tag delete and one file delete. IDs from another project are ignored. The caller
 * keeps `fileIds` under D1's bound-parameter limit. Returns the IDs actually deleted.
 *
 * Unlike `deleteFile`, the R2 objects go first: this serves retention purges, where a row left
 * behind by a failed R2 call is what lets the next run retry. If the row deletes then fail, the
 * rows point at objects that are already gone and the next run deletes them.
 */
export async function deleteFiles(
  db: AppDb,
  r2: R2Bucket,
  projectId: string,
  fileIds: readonly string[]
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const files = schema.projectFiles;
  const rows = await db
    .select({ id: files.id, r2Key: files.r2Key })
    .from(files)
    .where(and(eq(files.projectId, projectId), inArray(files.id, [...fileIds])));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  await r2.delete(rows.map((row) => row.r2Key));
  await db.delete(schema.projectFileTags).where(inArray(schema.projectFileTags.fileId, ids));
  await db.delete(files).where(and(eq(files.projectId, projectId), inArray(files.id, ids)));

  log.info('file_library_delete_many', { projectId, deleted: ids.length });
  return ids;
}
