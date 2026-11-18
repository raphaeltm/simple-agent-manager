import { D1_MAX_BOUND_PARAMETERS } from '@simple-agent-manager/worker-core';

export type ArchiveSearchDocument = {
  projectionId: string;
  documentId: string;
  role: string;
  content: string;
  createdAt: number;
};

// Six bound columns per document; no reserved binds. This is a statement/memory
// bound inside one atomic chunk commit, never a per-attempt work limit.
export const ARCHIVE_SEARCH_INSERT_BATCH_ROWS = Math.floor(D1_MAX_BOUND_PARAMETERS / 6);

/**
 * Amortize the AUTOINCREMENT sqlite_sequence write across a bounded insert.
 * The caller owns the transaction containing documents, FTS, projection progress
 * and the chunk receipt. Hashing stays in source order, independent of RETURNING
 * order. Existing identities still take the original conflict-validation path.
 */
export function insertArchiveSearchDocumentBatch(
  sql: SqlStorage,
  sessionId: string,
  documents: readonly ArchiveSearchDocument[],
  validateExisting: (document: ArchiveSearchDocument) => void
): void {
  for (let offset = 0; offset < documents.length; offset += ARCHIVE_SEARCH_INSERT_BATCH_ROWS) {
    const batch = documents.slice(offset, offset + ARCHIVE_SEARCH_INSERT_BATCH_ROWS);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const inserted = sql
      .exec<{ rowid: number; projection_id: string }>(
        `INSERT OR IGNORE INTO project_data_archive_search_documents
       (projection_id, document_id, session_id, role, content, created_at)
       VALUES ${placeholders} RETURNING rowid, projection_id`,
        ...batch.flatMap((document) => [
          document.projectionId,
          document.documentId,
          sessionId,
          document.role,
          document.content,
          document.createdAt,
        ])
      )
      .toArray();
    const rowids = new Map(inserted.map((row) => [row.projection_id, row.rowid]));
    const indexRows: Array<{ rowid: number; content: string }> = [];
    for (const document of batch) {
      const rowid = rowids.get(document.projectionId);
      if (rowid === undefined) {
        validateExisting(document);
      } else {
        // A duplicate identity later in this batch must still be validated.
        rowids.delete(document.projectionId);
        indexRows.push({ rowid, content: document.content });
      }
    }
    if (indexRows.length) {
      const placeholders = indexRows.map(() => '(?, ?)').join(', ');
      sql.exec(
        `INSERT INTO project_data_archive_search_documents_fts(rowid, content)
       VALUES ${placeholders}`,
        ...indexRows.flatMap((row) => [row.rowid, row.content])
      );
    }
  }
}
