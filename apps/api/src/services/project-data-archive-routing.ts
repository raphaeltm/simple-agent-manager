import type { Env } from '../env';
import {
  PROJECT_DATA_ARCHIVE_DEFAULT_SHARD_COUNT,
  PROJECT_DATA_ARCHIVE_JOURNAL_STATES,
  PROJECT_DATA_ARCHIVE_LOCATION_STATES,
  PROJECT_DATA_ARCHIVE_OWNER_KINDS,
  PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
  type ProjectDataArchiveJournalState,
  type ProjectDataArchiveLocation,
  type ProjectDataArchiveLocationState,
  type ProjectDataArchiveOwnerKind,
  type ProjectDataArchiveOwnerRef,
} from '../project-data-archive/contract';

export class ProjectDataArchiveRoutingError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_ROUTING_UNSAFE';

  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectDataArchiveRoutingError';
  }
}

export class ProjectDataArchiveJournalError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_JOURNAL_UNSAFE';

  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectDataArchiveJournalError';
  }
}

type RawLocationRow = {
  project_id?: unknown;
  session_id?: unknown;
  location_state?: unknown;
  owner_kind?: unknown;
  owner_name?: unknown;
  generation?: unknown;
  migration_id?: unknown;
  target_aggregate_sha256?: unknown;
  routing_schema_version?: unknown;
};

type RawJournalRow = {
  state?: unknown;
  lease_epoch?: unknown;
};

export function isProjectDataArchiveLocationState(
  value: unknown
): value is ProjectDataArchiveLocationState {
  return (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_LOCATION_STATES.includes(value as ProjectDataArchiveLocationState)
  );
}

export function isProjectDataArchiveOwnerKind(
  value: unknown
): value is ProjectDataArchiveOwnerKind {
  return (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_OWNER_KINDS.includes(value as ProjectDataArchiveOwnerKind)
  );
}

export function isProjectDataArchiveJournalState(
  value: unknown
): value is ProjectDataArchiveJournalState {
  return (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_JOURNAL_STATES.includes(value as ProjectDataArchiveJournalState)
  );
}

function parseGeneration(value: unknown, reason: string): number {
  const generation =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new ProjectDataArchiveRoutingError(reason, `Invalid ProjectData archive generation`);
  }
  return generation;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stableShardIndex(input: string, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

export function resolveArchiveShardCount(env: Env): number {
  const parsed = Number.parseInt(env.PROJECT_DATA_ARCHIVE_SHARD_COUNT ?? '', 10);
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 4096) return parsed;
  return PROJECT_DATA_ARCHIVE_DEFAULT_SHARD_COUNT;
}

export function rootProjectDataOwner(projectId: string): ProjectDataArchiveOwnerRef {
  return {
    kind: 'root',
    projectId,
    ownerName: projectId,
    generation: 0,
  };
}

export function archiveShardProjectDataOwner(
  env: Env,
  projectId: string,
  sessionId: string,
  generation: number
): ProjectDataArchiveOwnerRef {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new ProjectDataArchiveRoutingError(
      'invalid_archive_generation',
      'Archive shard owner generation must be a positive integer'
    );
  }
  const shardCount = resolveArchiveShardCount(env);
  const shard = stableShardIndex(`${projectId}:${sessionId}`, shardCount);
  return {
    kind: 'archive_shard',
    projectId,
    ownerName: `${projectId}:archive:g${generation}:s${shard}`,
    generation,
  };
}

function parseLocationRow(
  projectId: string,
  sessionId: string,
  row: RawLocationRow
): ProjectDataArchiveLocation {
  if (row.project_id !== projectId || row.session_id !== sessionId) {
    throw new ProjectDataArchiveRoutingError(
      'location_identity_mismatch',
      'ProjectData archive location identity mismatch'
    );
  }
  if (!isProjectDataArchiveLocationState(row.location_state)) {
    throw new ProjectDataArchiveRoutingError(
      'unknown_location_state',
      'ProjectData archive location has an unknown state'
    );
  }
  if (!isProjectDataArchiveOwnerKind(row.owner_kind)) {
    throw new ProjectDataArchiveRoutingError(
      'unknown_owner_kind',
      'ProjectData archive location has an unknown owner kind'
    );
  }
  if (typeof row.owner_name !== 'string' || row.owner_name.length === 0) {
    throw new ProjectDataArchiveRoutingError(
      'missing_owner_name',
      'ProjectData archive location is missing an owner name'
    );
  }
  const generation = parseGeneration(row.generation, 'invalid_location_generation');
  const routingSchemaVersion = parseGeneration(
    row.routing_schema_version ?? PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
    'invalid_location_routing_schema_version'
  );
  if (routingSchemaVersion !== PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION) {
    throw new ProjectDataArchiveRoutingError(
      'unsupported_routing_schema_version',
      'ProjectData archive location requires an unsupported routing schema version'
    );
  }

  if (row.location_state === 'root') {
    const root = rootProjectDataOwner(projectId);
    if (row.owner_kind !== root.kind || row.owner_name !== root.ownerName || generation !== 0) {
      throw new ProjectDataArchiveRoutingError(
        'ambiguous_root_location',
        'ProjectData archive root location is ambiguous'
      );
    }
  } else if (row.owner_kind !== 'archive_shard' || generation <= 0) {
    throw new ProjectDataArchiveRoutingError(
      'ambiguous_archive_location',
      'ProjectData archive non-root location is ambiguous'
    );
  }

  if (row.location_state === 'archive_shard' && !optionalString(row.migration_id)) {
    throw new ProjectDataArchiveRoutingError(
      'published_location_missing_migration',
      'ProjectData archive published location is missing migration identity'
    );
  }

  return {
    state: row.location_state,
    kind: row.owner_kind,
    projectId,
    sessionId,
    ownerName: row.owner_name,
    generation,
    migrationId: optionalString(row.migration_id),
    targetAggregateSha256: optionalString(row.target_aggregate_sha256),
    routingSchemaVersion,
  };
}

export async function resolveProjectDataSessionLocation(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<ProjectDataArchiveLocation> {
  let row: RawLocationRow | null;
  try {
    row = await env.DATABASE.prepare(
      `SELECT project_id, session_id, location_state, owner_kind, owner_name, generation,
              migration_id, target_aggregate_sha256, routing_schema_version
       FROM project_data_session_locations
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, sessionId)
      .first<RawLocationRow>();
  } catch (error) {
    throw new ProjectDataArchiveRoutingError(
      'location_read_failed',
      `ProjectData archive location read failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!row) {
    const root = rootProjectDataOwner(projectId);
    return {
      ...root,
      state: 'root',
      sessionId,
      migrationId: null,
      targetAggregateSha256: null,
      routingSchemaVersion: PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
    };
  }
  return parseLocationRow(projectId, sessionId, row);
}

export async function resolveExactReadOwner(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<ProjectDataArchiveLocation> {
  const location = await resolveProjectDataSessionLocation(env, projectId, sessionId);
  if (location.state === 'root' || location.state === 'archive_shard') return location;
  throw new ProjectDataArchiveRoutingError(
    'exact_read_owner_not_publishable',
    `ProjectData archive exact read for session ${sessionId} is fenced by ${location.state}`
  );
}

export async function assertExactWriteAllowed(
  env: Env,
  projectId: string,
  sessionId: string,
  operation: string
): Promise<void> {
  const location = await resolveProjectDataSessionLocation(env, projectId, sessionId);
  if (location.state === 'root') return;
  throw new ProjectDataArchiveRoutingError(
    'exact_write_owner_not_root',
    `ProjectData ${operation} for session ${sessionId} is fenced by archive state ${location.state}`
  );
}

export const PROJECT_DATA_ARCHIVE_STATE_TRANSITIONS: Record<
  ProjectDataArchiveJournalState,
  readonly ProjectDataArchiveJournalState[]
> = {
  candidate: ['leased', 'failed', 'poisoned', 'frozen'],
  leased: ['intent_prepared', 'failed', 'poisoned', 'frozen'],
  intent_prepared: ['target_prepared', 'copying', 'failed', 'poisoned', 'frozen'],
  target_prepared: ['copying', 'failed', 'poisoned', 'frozen'],
  copying: ['copying', 'target_sealed', 'failed', 'poisoned', 'frozen'],
  target_sealed: ['recovery_manifest_persisted', 'failed', 'poisoned', 'frozen'],
  recovery_manifest_persisted: ['source_deleted', 'failed', 'poisoned', 'frozen'],
  source_deleted: ['published', 'source_deleted', 'failed', 'poisoned', 'frozen'],
  published: ['published'],
  failed: ['leased', 'poisoned', 'frozen'],
  poisoned: ['frozen'],
  frozen: ['frozen'],
};

export function assertArchiveJournalTransition(
  from: ProjectDataArchiveJournalState,
  to: ProjectDataArchiveJournalState
): void {
  if (!PROJECT_DATA_ARCHIVE_STATE_TRANSITIONS[from]?.includes(to)) {
    throw new ProjectDataArchiveJournalError(
      'invalid_state_transition',
      `Invalid ProjectData archive journal transition ${from} -> ${to}`
    );
  }
}

export async function readArchiveJournalState(
  env: Env,
  migrationId: string
): Promise<ProjectDataArchiveJournalState | null> {
  const row = await env.DATABASE.prepare(
    'SELECT state FROM project_data_archive_migrations WHERE migration_id = ?'
  )
    .bind(migrationId)
    .first<RawJournalRow>();
  if (!row) return null;
  if (!isProjectDataArchiveJournalState(row.state)) {
    throw new ProjectDataArchiveJournalError(
      'unknown_state',
      'ProjectData archive journal row has an unknown state'
    );
  }
  return row.state;
}

export async function casArchiveJournalState(
  env: Env,
  input: {
    migrationId: string;
    from: ProjectDataArchiveJournalState;
    to: ProjectDataArchiveJournalState;
    now: number;
    fields?: Partial<{
      sourceIntentToken: string | null;
      terminalVersionSha256: string | null;
      targetAggregateSha256: string | null;
      r2ManifestKey: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  }
): Promise<boolean> {
  assertArchiveJournalTransition(input.from, input.to);
  const fieldAssignments: string[] = ['state = ?', 'updated_at = ?'];
  const values: unknown[] = [input.to, input.now];
  const fieldMap = [
    ['sourceIntentToken', 'source_intent_token'],
    ['terminalVersionSha256', 'terminal_version_sha256'],
    ['targetAggregateSha256', 'target_aggregate_sha256'],
    ['r2ManifestKey', 'r2_manifest_key'],
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message'],
  ] as const;
  for (const [key, column] of fieldMap) {
    if (input.fields && Object.prototype.hasOwnProperty.call(input.fields, key)) {
      fieldAssignments.push(`${column} = ?`);
      values.push(input.fields[key]);
    }
  }
  const timestampColumn = `${input.to}_at`;
  if (
    [
      'candidate_at',
      'intent_prepared_at',
      'target_prepared_at',
      'target_sealed_at',
      'recovery_manifest_persisted_at',
      'source_deleted_at',
      'published_at',
      'poisoned_at',
      'frozen_at',
    ].includes(timestampColumn)
  ) {
    fieldAssignments.push(`${timestampColumn} = COALESCE(${timestampColumn}, ?)`);
    values.push(input.now);
  } else if (input.to === 'copying') {
    fieldAssignments.push('copying_started_at = COALESCE(copying_started_at, ?)');
    values.push(input.now);
  }

  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET ${fieldAssignments.join(', ')}
     WHERE migration_id = ? AND state = ?`
  )
    .bind(...values, input.migrationId, input.from)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function hasProjectDataArchiveNonRootPointers(env: Env): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS present
     FROM project_data_session_locations
     WHERE location_state != 'root'
     LIMIT 1`
  ).first<{ present: number }>();
  return row?.present === 1;
}
