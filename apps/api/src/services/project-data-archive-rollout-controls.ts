import type { Env } from '../env';
import {
  PROJECT_DATA_ARCHIVE_JOURNAL_STATES,
  PROJECT_DATA_ARCHIVE_LOCATION_STATES,
  type ProjectDataArchiveJournalState,
  type ProjectDataArchiveLocationState,
} from '../project-data-archive/contract';

const DEFAULT_ARCHIVE_ROLLOUT_LIST_LIMIT = 25;
const DEFAULT_ARCHIVE_ROLLOUT_LIST_LIMIT_MAX = 100;
const DEFAULT_ARCHIVE_MANUAL_CANARY_MAX_SESSIONS = 5;
const DEFAULT_ARCHIVE_MANUAL_CANARY_MAX_WALL_TIME_MS = 15_000;

type ArchiveCircuitBreakerState = 'closed' | 'open' | 'frozen';

type ArchiveRolloutFilters = {
  projectId?: string;
  sessionId?: string;
  limit?: number;
};

type RawCountRow = {
  project_id: unknown;
  state: unknown;
  count: unknown;
  oldest_updated_at: unknown;
  newest_updated_at: unknown;
};

type RawBreakerRow = {
  project_id: unknown;
  state: unknown;
  reason: unknown;
  opened_at: unknown;
  updated_at: unknown;
};

type RawLocationRow = {
  project_id: unknown;
  session_id: unknown;
  location_state: unknown;
  owner_kind: unknown;
  owner_name: unknown;
  generation: unknown;
  migration_id: unknown;
  source_owner_name: unknown;
  target_owner_name: unknown;
  target_aggregate_sha256: unknown;
  routing_schema_version: unknown;
  published_at: unknown;
  updated_at: unknown;
};

type RawMigrationRow = {
  migration_id: unknown;
  project_id: unknown;
  session_id: unknown;
  state: unknown;
  source_owner_name: unknown;
  target_owner_name: unknown;
  target_generation: unknown;
  lease_owner: unknown;
  lease_epoch: unknown;
  lease_expires_at: unknown;
  attempt_count: unknown;
  error_code: unknown;
  error_message: unknown;
  candidate_at: unknown;
  frozen_at: unknown;
  poisoned_at: unknown;
  published_at: unknown;
  updated_at: unknown;
  location_state: unknown;
  breaker_state: unknown;
  breaker_reason: unknown;
};

export type ProjectDataArchiveRolloutStateCount = {
  projectId: string;
  state: string;
  count: number;
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
};

export type ProjectDataArchiveRolloutBreaker = {
  projectId: string;
  state: ArchiveCircuitBreakerState;
  reason: string | null;
  openedAt: number | null;
  updatedAt: number;
};

export type ProjectDataArchiveRolloutLocation = {
  projectId: string;
  sessionId: string;
  locationState: ProjectDataArchiveLocationState;
  ownerKind: string;
  ownerName: string;
  generation: number;
  migrationId: string | null;
  sourceOwnerName: string | null;
  targetOwnerName: string | null;
  targetAggregateSha256: string | null;
  routingSchemaVersion: number;
  publishedAt: number | null;
  updatedAt: number;
};

export type ProjectDataArchiveRolloutMigration = {
  migrationId: string;
  projectId: string;
  sessionId: string;
  state: ProjectDataArchiveJournalState;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  candidateAt: number | null;
  frozenAt: number | null;
  poisonedAt: number | null;
  publishedAt: number | null;
  updatedAt: number;
  locationState: ProjectDataArchiveLocationState | null;
  breakerState: ArchiveCircuitBreakerState | null;
  breakerReason: string | null;
};

export type ProjectDataArchiveRolloutState = {
  filters: {
    projectId: string | null;
    sessionId: string | null;
    limit: number;
  };
  config: {
    globalCronEnabled: boolean;
    manualCanaryMaxSessions: number;
    manualCanaryMaxWallTimeMs: number;
  };
  migrationStateCounts: ProjectDataArchiveRolloutStateCount[];
  locationStateCounts: ProjectDataArchiveRolloutStateCount[];
  circuitBreakers: ProjectDataArchiveRolloutBreaker[];
  recentMigrations: ProjectDataArchiveRolloutMigration[];
  locations: ProjectDataArchiveRolloutLocation[];
};

export type ProjectDataArchiveProjectControlResult = {
  projectId: string;
  state: ArchiveCircuitBreakerState;
  reason: string;
  frozenMigrations: number;
  frozenLocations: number;
  updatedAt: number;
  note: string | null;
};

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isSafeInteger(parsed) && parsed >= min) return Math.min(parsed, max);
  return fallback;
}

export function getProjectDataArchiveRolloutListConfig(env: Env): {
  defaultLimit: number;
  maxLimit: number;
} {
  const maxLimit = envInt(
    env.PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_MAX,
    DEFAULT_ARCHIVE_ROLLOUT_LIST_LIMIT_MAX,
    1,
    500
  );
  const configuredDefault = envInt(
    env.PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_DEFAULT,
    DEFAULT_ARCHIVE_ROLLOUT_LIST_LIMIT,
    1,
    maxLimit
  );
  return {
    defaultLimit: Math.min(configuredDefault, maxLimit),
    maxLimit,
  };
}

export function getProjectDataArchiveManualCanaryConfig(env: Env): {
  maxSessions: number;
  maxWallTimeMs: number;
} {
  return {
    maxSessions: envInt(
      env.PROJECT_DATA_ARCHIVE_MANUAL_CANARY_MAX_SESSIONS,
      DEFAULT_ARCHIVE_MANUAL_CANARY_MAX_SESSIONS,
      1,
      50
    ),
    maxWallTimeMs: envInt(
      env.PROJECT_DATA_ARCHIVE_MANUAL_CANARY_MAX_WALL_TIME_MS,
      DEFAULT_ARCHIVE_MANUAL_CANARY_MAX_WALL_TIME_MS,
      1,
      60_000
    ),
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ProjectData archive rollout row: ${field}`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ProjectData archive rollout row: ${field}`);
  }
  return value;
}

function isJournalState(value: unknown): value is ProjectDataArchiveJournalState {
  return (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_JOURNAL_STATES.includes(value as ProjectDataArchiveJournalState)
  );
}

function isLocationState(value: unknown): value is ProjectDataArchiveLocationState {
  return (
    typeof value === 'string' &&
    PROJECT_DATA_ARCHIVE_LOCATION_STATES.includes(value as ProjectDataArchiveLocationState)
  );
}

function isBreakerState(value: unknown): value is ArchiveCircuitBreakerState {
  return value === 'closed' || value === 'open' || value === 'frozen';
}

function mapCountRow(row: RawCountRow): ProjectDataArchiveRolloutStateCount {
  return {
    projectId: requiredString(row.project_id, 'project_id'),
    state: requiredString(row.state, 'state'),
    count: requiredNumber(row.count, 'count'),
    oldestUpdatedAt: optionalNumber(row.oldest_updated_at),
    newestUpdatedAt: optionalNumber(row.newest_updated_at),
  };
}

function mapBreakerRow(row: RawBreakerRow): ProjectDataArchiveRolloutBreaker {
  if (!isBreakerState(row.state)) {
    throw new Error('Invalid ProjectData archive circuit-breaker state');
  }
  return {
    projectId: requiredString(row.project_id, 'project_id'),
    state: row.state,
    reason: optionalString(row.reason),
    openedAt: optionalNumber(row.opened_at),
    updatedAt: requiredNumber(row.updated_at, 'updated_at'),
  };
}

function mapLocationRow(row: RawLocationRow): ProjectDataArchiveRolloutLocation {
  if (!isLocationState(row.location_state)) {
    throw new Error('Invalid ProjectData archive location state');
  }
  return {
    projectId: requiredString(row.project_id, 'project_id'),
    sessionId: requiredString(row.session_id, 'session_id'),
    locationState: row.location_state,
    ownerKind: requiredString(row.owner_kind, 'owner_kind'),
    ownerName: requiredString(row.owner_name, 'owner_name'),
    generation: requiredNumber(row.generation, 'generation'),
    migrationId: optionalString(row.migration_id),
    sourceOwnerName: optionalString(row.source_owner_name),
    targetOwnerName: optionalString(row.target_owner_name),
    targetAggregateSha256: optionalString(row.target_aggregate_sha256),
    routingSchemaVersion: requiredNumber(row.routing_schema_version, 'routing_schema_version'),
    publishedAt: optionalNumber(row.published_at),
    updatedAt: requiredNumber(row.updated_at, 'updated_at'),
  };
}

function mapMigrationRow(row: RawMigrationRow): ProjectDataArchiveRolloutMigration {
  if (!isJournalState(row.state)) {
    throw new Error('Invalid ProjectData archive migration state');
  }
  if (row.location_state !== null && !isLocationState(row.location_state)) {
    throw new Error('Invalid ProjectData archive migration location state');
  }
  if (row.breaker_state !== null && !isBreakerState(row.breaker_state)) {
    throw new Error('Invalid ProjectData archive migration circuit-breaker state');
  }
  return {
    migrationId: requiredString(row.migration_id, 'migration_id'),
    projectId: requiredString(row.project_id, 'project_id'),
    sessionId: requiredString(row.session_id, 'session_id'),
    state: row.state,
    sourceOwnerName: requiredString(row.source_owner_name, 'source_owner_name'),
    targetOwnerName: requiredString(row.target_owner_name, 'target_owner_name'),
    targetGeneration: requiredNumber(row.target_generation, 'target_generation'),
    leaseOwner: optionalString(row.lease_owner),
    leaseEpoch: requiredNumber(row.lease_epoch, 'lease_epoch'),
    leaseExpiresAt: optionalNumber(row.lease_expires_at),
    attemptCount: requiredNumber(row.attempt_count, 'attempt_count'),
    errorCode: optionalString(row.error_code),
    errorMessage: optionalString(row.error_message),
    candidateAt: optionalNumber(row.candidate_at),
    frozenAt: optionalNumber(row.frozen_at),
    poisonedAt: optionalNumber(row.poisoned_at),
    publishedAt: optionalNumber(row.published_at),
    updatedAt: requiredNumber(row.updated_at, 'updated_at'),
    locationState: row.location_state,
    breakerState: row.breaker_state,
    breakerReason: optionalString(row.breaker_reason),
  };
}

function filterSql(filters: ArchiveRolloutFilters, alias: string): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.projectId) {
    clauses.push(`${alias}.project_id = ?`);
    params.push(filters.projectId);
  }
  if (filters.sessionId) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(filters.sessionId);
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export async function getProjectDataArchiveRolloutState(
  env: Env,
  filters: ArchiveRolloutFilters = {}
): Promise<ProjectDataArchiveRolloutState> {
  const limitConfig = getProjectDataArchiveRolloutListConfig(env);
  const limit = Math.max(1, Math.min(filters.limit ?? limitConfig.defaultLimit, limitConfig.maxLimit));
  const migrationFilter = filterSql(filters, 'm');
  const locationFilter = filterSql(filters, 'loc');
  const breakerFilter = filters.projectId ? 'WHERE breaker.project_id = ?' : '';
  const breakerParams = filters.projectId ? [filters.projectId] : [];

  const [migrationCounts, locationCounts, breakers, migrations, locations] = await Promise.all([
    env.DATABASE.prepare(
      `SELECT m.project_id, m.state, COUNT(*) AS count,
              MIN(m.updated_at) AS oldest_updated_at,
              MAX(m.updated_at) AS newest_updated_at
       FROM project_data_archive_migrations m
       ${migrationFilter.sql}
       GROUP BY m.project_id, m.state
       ORDER BY m.project_id ASC, m.state ASC
       LIMIT ?`
    )
      .bind(...migrationFilter.params, limit)
      .all<RawCountRow>(),
    env.DATABASE.prepare(
      `SELECT loc.project_id, loc.location_state AS state, COUNT(*) AS count,
              MIN(loc.updated_at) AS oldest_updated_at,
              MAX(loc.updated_at) AS newest_updated_at
       FROM project_data_session_locations loc
       ${locationFilter.sql}
       GROUP BY loc.project_id, loc.location_state
       ORDER BY loc.project_id ASC, loc.location_state ASC
       LIMIT ?`
    )
      .bind(...locationFilter.params, limit)
      .all<RawCountRow>(),
    env.DATABASE.prepare(
      `SELECT breaker.project_id, breaker.state, breaker.reason, breaker.opened_at, breaker.updated_at
       FROM project_data_archive_circuit_breakers breaker
       ${breakerFilter}
       ORDER BY breaker.updated_at DESC
       LIMIT ?`
    )
      .bind(...breakerParams, limit)
      .all<RawBreakerRow>(),
    env.DATABASE.prepare(
      `SELECT m.migration_id, m.project_id, m.session_id, m.state, m.source_owner_name,
              m.target_owner_name, m.target_generation, m.lease_owner, m.lease_epoch,
              m.lease_expires_at, m.attempt_count, m.error_code, m.error_message,
              m.candidate_at, m.frozen_at, m.poisoned_at, m.published_at, m.updated_at,
              loc.location_state, breaker.state AS breaker_state, breaker.reason AS breaker_reason
       FROM project_data_archive_migrations m
       LEFT JOIN project_data_session_locations loc
         ON loc.project_id = m.project_id AND loc.session_id = m.session_id
       LEFT JOIN project_data_archive_circuit_breakers breaker
         ON breaker.project_id = m.project_id
       ${migrationFilter.sql}
       ORDER BY m.updated_at DESC, m.migration_id ASC
       LIMIT ?`
    )
      .bind(...migrationFilter.params, limit)
      .all<RawMigrationRow>(),
    env.DATABASE.prepare(
      `SELECT loc.project_id, loc.session_id, loc.location_state, loc.owner_kind,
              loc.owner_name, loc.generation, loc.migration_id, loc.source_owner_name,
              loc.target_owner_name, loc.target_aggregate_sha256, loc.routing_schema_version,
              loc.published_at, loc.updated_at
       FROM project_data_session_locations loc
       ${locationFilter.sql}
       ORDER BY loc.updated_at DESC, loc.session_id ASC
       LIMIT ?`
    )
      .bind(...locationFilter.params, limit)
      .all<RawLocationRow>(),
  ]);
  const manualCanaryConfig = getProjectDataArchiveManualCanaryConfig(env);

  return {
    filters: {
      projectId: filters.projectId ?? null,
      sessionId: filters.sessionId ?? null,
      limit,
    },
    config: {
      globalCronEnabled: env.PROJECT_DATA_ARCHIVE_SHARDING_ENABLED === 'true',
      manualCanaryMaxSessions: manualCanaryConfig.maxSessions,
      manualCanaryMaxWallTimeMs: manualCanaryConfig.maxWallTimeMs,
    },
    migrationStateCounts: (migrationCounts.results ?? []).map(mapCountRow),
    locationStateCounts: (locationCounts.results ?? []).map(mapCountRow),
    circuitBreakers: (breakers.results ?? []).map(mapBreakerRow),
    recentMigrations: (migrations.results ?? []).map(mapMigrationRow),
    locations: (locations.results ?? []).map(mapLocationRow),
  };
}

export async function listProjectDataArchiveProblemMigrations(
  env: Env,
  filters: ArchiveRolloutFilters = {}
): Promise<ProjectDataArchiveRolloutMigration[]> {
  const limitConfig = getProjectDataArchiveRolloutListConfig(env);
  const limit = Math.max(1, Math.min(filters.limit ?? limitConfig.defaultLimit, limitConfig.maxLimit));
  const scoped = filterSql(filters, 'm');
  const prefix = scoped.sql ? `${scoped.sql} AND` : 'WHERE';
  const rows = await env.DATABASE.prepare(
    `SELECT m.migration_id, m.project_id, m.session_id, m.state, m.source_owner_name,
            m.target_owner_name, m.target_generation, m.lease_owner, m.lease_epoch,
            m.lease_expires_at, m.attempt_count, m.error_code, m.error_message,
            m.candidate_at, m.frozen_at, m.poisoned_at, m.published_at, m.updated_at,
            loc.location_state, breaker.state AS breaker_state, breaker.reason AS breaker_reason
     FROM project_data_archive_migrations m
     LEFT JOIN project_data_session_locations loc
       ON loc.project_id = m.project_id AND loc.session_id = m.session_id
     LEFT JOIN project_data_archive_circuit_breakers breaker
       ON breaker.project_id = m.project_id
     ${prefix} (m.state IN ('failed', 'poisoned', 'frozen') OR loc.location_state = 'frozen')
     ORDER BY m.updated_at ASC, m.migration_id ASC
     LIMIT ?`
  )
    .bind(...scoped.params, limit)
    .all<RawMigrationRow>();
  return (rows.results ?? []).map(mapMigrationRow);
}

export async function setProjectDataArchiveCircuitBreaker(
  env: Env,
  input: {
    projectId: string;
    state: ArchiveCircuitBreakerState;
    reason: string;
    now?: number;
  }
): Promise<ProjectDataArchiveProjectControlResult> {
  const now = input.now ?? Date.now();
  await env.DATABASE.prepare(
    `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       state = excluded.state,
       reason = excluded.reason,
       opened_at = excluded.opened_at,
       updated_at = excluded.updated_at`
  )
    .bind(input.projectId, input.state, input.reason, input.state === 'closed' ? null : now, now)
    .run();

  return {
    projectId: input.projectId,
    state: input.state,
    reason: input.reason,
    frozenMigrations: 0,
    frozenLocations: 0,
    updatedAt: now,
    note:
      input.state === 'closed'
        ? 'Circuit breaker closed for future archive work; existing frozen migrations and frozen locations remain frozen until copy-back/rehome or a follow-up operator action resolves them.'
        : null,
  };
}

export async function freezeProjectDataArchiveProject(
  env: Env,
  input: {
    projectId: string;
    reason: string;
    now?: number;
  }
): Promise<ProjectDataArchiveProjectControlResult> {
  const now = input.now ?? Date.now();
  const migrationResult = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'frozen',
         error_code = 'operator_project_frozen',
         error_message = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         frozen_at = COALESCE(frozen_at, ?),
         updated_at = ?
     WHERE project_id = ?
       AND state NOT IN ('source_deleted', 'published', 'poisoned', 'frozen')`
  )
    .bind(input.reason, now, now, input.projectId)
    .run();
  const locationResult = await env.DATABASE.prepare(
    `UPDATE project_data_session_locations
     SET location_state = 'frozen',
         updated_at = ?
     WHERE project_id = ?
       AND location_state = 'migrating'`
  )
    .bind(now, input.projectId)
    .run();
  await setProjectDataArchiveCircuitBreaker(env, {
    projectId: input.projectId,
    state: 'frozen',
    reason: input.reason,
    now,
  });

  return {
    projectId: input.projectId,
    state: 'frozen',
    reason: input.reason,
    frozenMigrations: migrationResult.meta.changes ?? 0,
    frozenLocations: locationResult.meta.changes ?? 0,
    updatedAt: now,
    note: null,
  };
}
