import type * as v from 'valibot';

import type { ProjectCommentThreadCandidate } from './comment-contracts';
import { parseRow } from './row-schemas';

type ProjectCandidateRow = {
  id: string;
  updated_at: number;
  estimated_bytes: number;
};

type WarningLogger = {
  warn: (event: string, data: Record<string, unknown>) => void;
};

function rowId(row: unknown): string | null {
  const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return typeof record.id === 'string' ? record.id : null;
}

export function parseProjectCommentThreadCandidates(
  rows: unknown[],
  schema: v.GenericSchema<unknown, ProjectCandidateRow>,
  context: string,
  log: WarningLogger,
  warningEvent: string
): ProjectCommentThreadCandidate[] {
  const candidates: ProjectCommentThreadCandidate[] = [];
  for (const row of rows) {
    try {
      const parsed = parseRow(schema, row, context);
      candidates.push({
        id: parsed.id,
        updatedAt: parsed.updated_at,
        estimatedBytes: Math.max(0, parsed.estimated_bytes),
      });
    } catch (err) {
      log.warn(warningEvent, {
        rowId: rowId(row),
        error: String(err),
      });
    }
  }
  return candidates;
}

export function restoreThreadOrder<TThread extends { id: string }>(
  threadIds: readonly string[],
  hydrated: readonly TThread[]
): TThread[] {
  const byId = new Map(hydrated.map((thread) => [thread.id, thread]));
  return threadIds.flatMap((id) => {
    const thread = byId.get(id);
    return thread ? [thread] : [];
  });
}
