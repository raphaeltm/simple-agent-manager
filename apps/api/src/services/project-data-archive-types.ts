/**
 * Shared contracts for ProjectData terminal archive placement.
 *
 * Active-session direct ownership is deliberately represented in the type seam
 * but is not routable in this bridge. Encountering it fails closed.
 */

export const ARCHIVE_JOURNAL_STATES = [
  'planned',
  'copying',
  'sealed',
  'source_deleted',
  'archived',
  'frozen',
  'failed',
] as const;

export type ProjectDataArchiveJournalState = (typeof ARCHIVE_JOURNAL_STATES)[number];
export type ProjectDataOwnerKind = 'root' | 'archive_shard' | 'direct_session';
export type ProjectDataLocationState = 'root' | 'migrating' | 'archive_shard' | 'direct_session';

export interface ProjectDataOwnerRef {
  kind: ProjectDataOwnerKind;
  name: string;
  generation: number;
}

export interface ProjectDataOwnerLocation {
  projectId: string;
  sessionId: string;
  state: ProjectDataLocationState;
  owner: ProjectDataOwnerRef;
  migrationId: string | null;
}

export class ProjectDataArchiveRoutingError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_ROUTING_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectDataArchiveRoutingError';
  }
}

export class ProjectDataArchiveFenceError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_FENCE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectDataArchiveFenceError';
  }
}

export class ProjectDataArchiveEligibilityError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_INELIGIBLE';

  constructor(readonly reason: string) {
    super(`ProjectData session is not archive-eligible: ${reason}`);
    this.name = 'ProjectDataArchiveEligibilityError';
  }
}

export const PROJECT_DATA_ARCHIVE_ROUTING_VERSION = 1;
export const DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS = 128;
export const DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_DATA_ARCHIVE_CHUNK_BYTES = 24 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES = 1;
export const DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP = 8;
export const DEFAULT_PROJECT_DATA_ARCHIVE_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_RETRY_BASE_MS = 5 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_CIRCUIT_FAILURES = 3;
export const DEFAULT_PROJECT_DATA_ARCHIVE_CIRCUIT_OPEN_MS = 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SHARD_COUNT = 16;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS = 7;
export const DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX = 'project-data/archive-sharding';
export const DEFAULT_PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO = 0.7;
export const DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT = 25;
export const DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT = 1_000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT = 100;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT = 256;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT = 7;
export const MAX_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT = 25;
export const MAX_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT = 1_000;
export const MAX_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT = 100;
export const MAX_PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT = 256;
export const MAX_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT = 7;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS = 20_000;
export const MAX_PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS = 30_000;
export const DEFAULT_PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS = 30;
export const MAX_PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS = 30;
export const DEFAULT_PROJECT_DATA_ARCHIVE_COPY_EXPANSION_RATIO = 2;
export const DEFAULT_PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS = 2_000;
export const MAX_PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS = 10_000;

export interface ProjectDataArchiveShardingEnv {
  PROJECT_DATA_ARCHIVE_SHARDING_ENABLED?: string;
  PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP?: string;
  PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT?: string;
  PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS?: string;
  PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT?: string;
  PROJECT_DATA_ARCHIVE_CHUNK_MAX_BYTES?: string;
  PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP?: string;
  PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT?: string;
  PROJECT_DATA_ARCHIVE_LEASE_MS?: string;
  PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS?: string;
  PROJECT_DATA_ARCHIVE_RETRY_BASE_MS?: string;
  PROJECT_DATA_ARCHIVE_RETRY_MAX_MS?: string;
  PROJECT_DATA_ARCHIVE_CIRCUIT_FAILURES?: string;
  PROJECT_DATA_ARCHIVE_CIRCUIT_OPEN_MS?: string;
  PROJECT_DATA_ARCHIVE_SHARD_COUNT?: string;
  PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT?: string;
  PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS?: string;
  PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT?: string;
  PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS?: string;
  PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS?: string;
  PROJECT_DATA_ARCHIVE_COPY_EXPANSION_RATIO?: string;
  PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS?: string;
  PROJECT_DATA_ARCHIVE_R2_PREFIX?: string;
  PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO?: string;
  PROJECT_DATA_ARCHIVE_ROUTING_VERSION?: string;
}

export interface ProjectDataArchiveShardingConfig {
  enabled: boolean;
  maxCandidatesPerSweep: number;
  chunkMaxRows: number;
  chunkMaxBytes: number;
  maxChunksPerSweep: number;
  leaseMs: number;
  terminalGraceMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  circuitFailures: number;
  circuitOpenMs: number;
  shardCount: number;
  searchMaxOwners: number;
  sweepMaxWallMs: number;
  sweepMaxIoOps: number;
  copyExpansionRatio: number;
  errorMaxChars: number;
  recoveryR2Prefix: string;
  rootCopyMaxRatio: number;
  routingVersion: number;
}

function positiveInt(value: string | undefined, fallback: number, maximum?: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return maximum === undefined ? resolved : Math.min(resolved, maximum);
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

function minimumOneNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function resolveArchiveShardingConfig(
  env: ProjectDataArchiveShardingEnv
): ProjectDataArchiveShardingConfig {
  const maxCandidatesHardLimit = positiveInt(
    env.PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT,
    DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT,
    MAX_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT
  );
  const chunkMaxRowsHardLimit = positiveInt(
    env.PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT,
    DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT,
    MAX_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT
  );
  const maxChunksHardLimit = positiveInt(
    env.PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT,
    DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT,
    MAX_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT
  );
  const shardCountHardLimit = positiveInt(
    env.PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT,
    DEFAULT_PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT,
    MAX_PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT
  );
  const searchMaxOwnersHardLimit = positiveInt(
    env.PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT,
    DEFAULT_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT,
    MAX_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT
  );
  const retryBaseMs = positiveInt(
    env.PROJECT_DATA_ARCHIVE_RETRY_BASE_MS,
    DEFAULT_PROJECT_DATA_ARCHIVE_RETRY_BASE_MS
  );
  const retryMaxMs = Math.max(
    retryBaseMs,
    positiveInt(env.PROJECT_DATA_ARCHIVE_RETRY_MAX_MS, DEFAULT_PROJECT_DATA_ARCHIVE_RETRY_MAX_MS)
  );
  const routingVersion = positiveInt(
    env.PROJECT_DATA_ARCHIVE_ROUTING_VERSION,
    PROJECT_DATA_ARCHIVE_ROUTING_VERSION
  );
  if (routingVersion !== PROJECT_DATA_ARCHIVE_ROUTING_VERSION) {
    throw new ProjectDataArchiveRoutingError('Unsupported configured ProjectData routing version');
  }
  return {
    // Exact opt-in. Missing, malformed, and every value except "true" are off.
    enabled: env.PROJECT_DATA_ARCHIVE_SHARDING_ENABLED === 'true',
    maxCandidatesPerSweep: positiveInt(
      env.PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP,
      DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CANDIDATES,
      maxCandidatesHardLimit
    ),
    chunkMaxRows: positiveInt(
      env.PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS,
      DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS,
      chunkMaxRowsHardLimit
    ),
    chunkMaxBytes: positiveInt(
      env.PROJECT_DATA_ARCHIVE_CHUNK_MAX_BYTES,
      DEFAULT_PROJECT_DATA_ARCHIVE_CHUNK_MAX_BYTES,
      MAX_PROJECT_DATA_ARCHIVE_CHUNK_BYTES
    ),
    maxChunksPerSweep: positiveInt(
      env.PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP,
      DEFAULT_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP,
      maxChunksHardLimit
    ),
    leaseMs: positiveInt(env.PROJECT_DATA_ARCHIVE_LEASE_MS, DEFAULT_PROJECT_DATA_ARCHIVE_LEASE_MS),
    terminalGraceMs: positiveInt(
      env.PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS,
      DEFAULT_PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS
    ),
    retryBaseMs,
    retryMaxMs,
    circuitFailures: positiveInt(
      env.PROJECT_DATA_ARCHIVE_CIRCUIT_FAILURES,
      DEFAULT_PROJECT_DATA_ARCHIVE_CIRCUIT_FAILURES
    ),
    circuitOpenMs: positiveInt(
      env.PROJECT_DATA_ARCHIVE_CIRCUIT_OPEN_MS,
      DEFAULT_PROJECT_DATA_ARCHIVE_CIRCUIT_OPEN_MS
    ),
    shardCount: positiveInt(
      env.PROJECT_DATA_ARCHIVE_SHARD_COUNT,
      DEFAULT_PROJECT_DATA_ARCHIVE_SHARD_COUNT,
      shardCountHardLimit
    ),
    searchMaxOwners: positiveInt(
      env.PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS,
      DEFAULT_PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS,
      searchMaxOwnersHardLimit
    ),
    sweepMaxWallMs: positiveInt(
      env.PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS,
      DEFAULT_PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS,
      MAX_PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS
    ),
    sweepMaxIoOps: positiveInt(
      env.PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS,
      DEFAULT_PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS,
      MAX_PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS
    ),
    copyExpansionRatio: minimumOneNumber(
      env.PROJECT_DATA_ARCHIVE_COPY_EXPANSION_RATIO,
      DEFAULT_PROJECT_DATA_ARCHIVE_COPY_EXPANSION_RATIO
    ),
    errorMaxChars: positiveInt(
      env.PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS,
      DEFAULT_PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS,
      MAX_PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS
    ),
    recoveryR2Prefix: resolveRecoveryR2Prefix(env.PROJECT_DATA_ARCHIVE_R2_PREFIX),
    rootCopyMaxRatio: ratio(
      env.PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO,
      DEFAULT_PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO
    ),
    routingVersion,
  };
}

function resolveRecoveryR2Prefix(value: string | undefined): string {
  const prefix = value?.replace(/^\/+|\/+$/g, '') || DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX;
  const segments = prefix.split('/');
  if (
    segments.length < 2 ||
    segments[0] !== 'project-data' ||
    segments.some((segment) => !segment || segment === '..' || !/^[a-zA-Z0-9._-]+$/.test(segment))
  ) {
    throw new ProjectDataArchiveRoutingError(
      'ProjectData archive recovery prefix must be a safe private project-data namespace'
    );
  }
  return segments.join('/');
}

export function buildArchiveShardOwnerName(projectId: string, shard: number): string {
  if (!projectId || !Number.isInteger(shard) || shard < 0) {
    throw new ProjectDataArchiveRoutingError('Invalid archive shard owner identity');
  }
  return `project-data-archive:${projectId}:${shard}`;
}

export function buildDirectSessionOwnerName(projectId: string, sessionId: string): string {
  if (!projectId || !sessionId) {
    throw new ProjectDataArchiveRoutingError('Invalid direct session owner identity');
  }
  return `project-data-session:${projectId}:${sessionId}`;
}
