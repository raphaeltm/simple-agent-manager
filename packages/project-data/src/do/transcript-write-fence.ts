import { PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES, type ProjectDataArchiveSourceIntentState } from '../archive/contract';

export const PROJECT_DATA_TRANSCRIPT_WRITE_FENCED = 'PROJECT_DATA_TRANSCRIPT_WRITE_FENCED';

export class ProjectDataTranscriptWriteFencedError extends Error {
  readonly code = PROJECT_DATA_TRANSCRIPT_WRITE_FENCED;

  constructor(
    readonly sessionId: string,
    readonly operation: string,
    readonly archiveState: ProjectDataArchiveSourceIntentState
  ) {
    super(
      `ProjectData transcript write ${operation} for session ${sessionId} is fenced by archive source intent ${archiveState}`
    );
    this.name = 'ProjectDataTranscriptWriteFencedError';
  }
}

function parseArchiveSourceIntentState(value: unknown): ProjectDataArchiveSourceIntentState | null {
  return typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES.includes(value as ProjectDataArchiveSourceIntentState)
    ? (value as ProjectDataArchiveSourceIntentState)
    : null;
}

export function assertTranscriptWriteAllowed(
  sql: SqlStorage,
  sessionId: string,
  operation: string
): void {
  let row: Record<string, unknown> | undefined;
  try {
    row = sql
      .exec(
        `SELECT state
         FROM project_data_archive_source_intents
         WHERE session_id = ?
           AND state != 'rehome_exported'
         LIMIT 1`,
        sessionId
      )
      .toArray()[0];
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return;
    throw error;
  }
  const state = parseArchiveSourceIntentState(row?.state);
  if (state) throw new ProjectDataTranscriptWriteFencedError(sessionId, operation, state);
}

