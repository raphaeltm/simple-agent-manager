import {
  PROJECT_DATA_ARCHIVE_ROUTING_VERSION,
  ProjectDataArchiveRoutingError,
  type ProjectDataOwnerLocation,
} from './project-data-archive-types';

export interface ProjectDataOwnerLocationRow {
  project_id: string;
  session_id: string;
  state: string;
  owner_kind: string;
  owner_name: string;
  generation: number | null;
  migration_id: string | null;
  routing_version: number;
}

function isLocationRow(value: unknown): value is ProjectDataOwnerLocationRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.project_id === 'string' &&
    typeof row.session_id === 'string' &&
    typeof row.state === 'string' &&
    typeof row.owner_kind === 'string' &&
    typeof row.owner_name === 'string' &&
    (typeof row.generation === 'number' || row.generation === null) &&
    (typeof row.migration_id === 'string' || row.migration_id === null) &&
    typeof row.routing_version === 'number'
  );
}

/** Parse only a stable exact-read location. Transitional/unknown states reject. */
export function parseProjectDataOwnerLocationRow(value: unknown): ProjectDataOwnerLocation {
  if (!isLocationRow(value)) {
    throw new ProjectDataArchiveRoutingError('Malformed ProjectData owner location');
  }
  const generation = value.generation;
  if (generation === null || !Number.isInteger(generation) || generation < 0) {
    throw new ProjectDataArchiveRoutingError('ProjectData owner generation is missing or invalid');
  }
  if (value.routing_version !== PROJECT_DATA_ARCHIVE_ROUTING_VERSION) {
    throw new ProjectDataArchiveRoutingError('Unsupported ProjectData routing version');
  }

  if (value.state === 'migrating') {
    throw new ProjectDataArchiveRoutingError('ProjectData session migration is in progress');
  }
  if (value.state === 'direct_session' || value.owner_kind === 'direct_session') {
    throw new ProjectDataArchiveRoutingError('Direct SessionData ownership is not supported');
  }
  if (value.state === 'root') {
    if (
      value.owner_kind !== 'root' ||
      value.owner_name !== value.project_id ||
      generation !== 0 ||
      value.migration_id !== null
    ) {
      throw new ProjectDataArchiveRoutingError('Ambiguous ProjectData root owner location');
    }
    return {
      projectId: value.project_id,
      sessionId: value.session_id,
      state: 'root',
      owner: { kind: 'root', name: value.owner_name, generation },
      migrationId: null,
    };
  }
  if (value.state === 'archive_shard') {
    const archivePrefix = `project-data-archive:${value.project_id}:`;
    const shardSuffix = value.owner_name.startsWith(archivePrefix)
      ? value.owner_name.slice(archivePrefix.length)
      : '';
    if (
      value.owner_kind !== 'archive_shard' ||
      !/^(0|[1-9][0-9]*)$/.test(shardSuffix) ||
      generation < 1 ||
      !value.migration_id
    ) {
      throw new ProjectDataArchiveRoutingError('Ambiguous ProjectData archive owner location');
    }
    return {
      projectId: value.project_id,
      sessionId: value.session_id,
      state: 'archive_shard',
      owner: { kind: 'archive_shard', name: value.owner_name, generation },
      migrationId: value.migration_id,
    };
  }
  throw new ProjectDataArchiveRoutingError(`Unknown ProjectData owner state: ${value.state}`);
}

export function resolveLegacyOrExactOwnerLocation(
  projectId: string,
  sessionId: string,
  row: unknown | null
): ProjectDataOwnerLocation {
  if (row === null) {
    // Successful absence means this pre-bridge session has never left its
    // deterministic root owner. Lookup errors never reach this branch.
    return {
      projectId,
      sessionId,
      state: 'root',
      owner: { kind: 'root', name: projectId, generation: 0 },
      migrationId: null,
    };
  }
  const parsed = parseProjectDataOwnerLocationRow(row);
  if (parsed.projectId !== projectId || parsed.sessionId !== sessionId) {
    throw new ProjectDataArchiveRoutingError('ProjectData owner location identity mismatch');
  }
  return parsed;
}

export async function resolveProjectDataOwnerLocation(
  database: D1Database,
  projectId: string,
  sessionId: string
): Promise<ProjectDataOwnerLocation> {
  let row: ProjectDataOwnerLocationRow | null;
  try {
    row = await database
      .prepare(
        `SELECT project_id, session_id, state, owner_kind, owner_name, generation, migration_id, routing_version
           FROM project_data_session_locations
          WHERE project_id = ? AND session_id = ?`
      )
      .bind(projectId, sessionId)
      .first<ProjectDataOwnerLocationRow>();
  } catch (error) {
    throw new ProjectDataArchiveRoutingError(
      `ProjectData owner location lookup failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return resolveLegacyOrExactOwnerLocation(projectId, sessionId, row);
}

export async function assertProjectDataSessionWriteAllowed(
  database: D1Database,
  projectId: string,
  sessionId: string
): Promise<void> {
  const location = await resolveProjectDataOwnerLocation(database, projectId, sessionId);
  if (location.state !== 'root' || location.owner.generation !== 0) {
    throw new ProjectDataArchiveRoutingError('Archived ProjectData sessions are immutable');
  }
}
