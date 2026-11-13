/**
 * A ProjectData archive circuit breaker opening, as the archive sweep observes it. The sweep
 * reports each opening to the worker's operator alert (`ProjectDataPorts.operations`).
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

export interface ProjectDataArchiveBreakerOpening {
  projectId: string;
  /** The migration whose poisoning opened the breaker; it identifies this opening. */
  migrationId: string;
  reason: string;
  message: string | null;
  openedAt: number;
}

/**
 * Whether the breaker was closed, or had no row, before the write that opened it. `result` is the
 * `SELECT state` that runs just before the breaker upsert in the same D1 batch. An unreadable
 * result counts as closed: a duplicate alert costs less than a breaker that opened silently.
 */
export function breakerWasClosedBeforeOpening(result: D1Result | undefined): boolean {
  const row = result?.results?.[0];
  if (row === undefined) return true;
  return !isJsonRecord(row) || typeof row.state !== 'string' || row.state === 'closed';
}
