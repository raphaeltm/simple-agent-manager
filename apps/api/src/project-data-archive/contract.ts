export const PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION = 1;

export const PROJECT_DATA_ARCHIVE_LOCATION_STATES = [
  'root',
  'migrating',
  'archive_shard',
  'frozen',
] as const;

export type ProjectDataArchiveLocationState = (typeof PROJECT_DATA_ARCHIVE_LOCATION_STATES)[number];

export const PROJECT_DATA_ARCHIVE_OWNER_KINDS = ['root', 'archive_shard'] as const;

export type ProjectDataArchiveOwnerKind = (typeof PROJECT_DATA_ARCHIVE_OWNER_KINDS)[number];

export const PROJECT_DATA_ARCHIVE_JOURNAL_STATES = [
  'candidate',
  'leased',
  'intent_prepared',
  'target_prepared',
  'copying',
  'target_sealed',
  'recovery_manifest_persisted',
  'source_deleted',
  'published',
  'failed',
  'poisoned',
  'frozen',
] as const;

export type ProjectDataArchiveJournalState = (typeof PROJECT_DATA_ARCHIVE_JOURNAL_STATES)[number];

export const PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES = [
  'intent_prepared',
  'target_prepared',
  'copying',
  'target_sealed',
  'recovery_manifest_persisted',
  'source_deleted',
  'rehome_exported',
] as const;

export type ProjectDataArchiveSourceIntentState =
  (typeof PROJECT_DATA_ARCHIVE_SOURCE_INTENT_STATES)[number];

export const PROJECT_DATA_ARCHIVE_TARGET_STATES = [
  'prepared',
  'copying',
  'sealed',
  'published',
  'rehome_exported',
] as const;

export type ProjectDataArchiveTargetState = (typeof PROJECT_DATA_ARCHIVE_TARGET_STATES)[number];

export const PROJECT_DATA_ARCHIVE_TABLES = [
  'chat_messages',
  'chat_messages_grouped',
  'tool_payload_archives',
] as const;

export type ProjectDataArchiveTableName = (typeof PROJECT_DATA_ARCHIVE_TABLES)[number];

export const PROJECT_DATA_ARCHIVE_SURFACE_INVENTORY = [
  'chat_sessions-root-anchor',
  'chat_messages-exact-transcript-read-write',
  'chat_messages_grouped-search-materialization',
  'chat_messages_grouped_fts-search-index-rebuilt-in-target',
  'tool_payload_archives-r2-ledger',
  'tool_payload_cleanup_attempts-eligibility-fence',
  'session_state-current-plan-and-activity-fence',
  'session_summaries-d1-last-message-summary-anchor',
  'workspace_activity-liveness-fence',
  'acp_sessions-liveness-fence',
  'idle_cleanup_schedule-liveness-fence',
  'task_wait_subscriptions-wake-fence',
  'comment_threads-no-cascade-deletion-fence',
  'comment_replies-no-cascade-deletion-fence',
  'message-count-dedup-sequence-source-of-truth',
  'project-wide-search-explicit-partial-plane',
] as const;

export type ProjectDataArchiveSurface = (typeof PROJECT_DATA_ARCHIVE_SURFACE_INVENTORY)[number];

export const PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES = 32 * 1024 * 1024;
export const PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
export const PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS = 500;
export const PROJECT_DATA_ARCHIVE_DEFAULT_SHARD_COUNT = 128;
export const PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_PROJECTS = 1;
/**
 * Hard ceiling on sessions one sweep tick may journal. The primary throttle is
 * `PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_MESSAGE_BUDGET`; this only bounds the number of
 * `migrating` fences a single tick can open.
 */
export const PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_SESSIONS = 10;
/**
 * Cumulative `session_summaries.message_count` a sweep tick may select as NEW candidates.
 * Candidates are ordered largest-first, so this budgets bytes moved per tick by proxy;
 * a single session larger than the budget is still selected on its own.
 */
export const PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_MESSAGE_BUDGET = 20_000;
export const PROJECT_DATA_ARCHIVE_MAX_SWEEP_MESSAGE_BUDGET = 5_000_000;
/**
 * Rows read per statement while streaming a session's terminal-version hash.
 * Bounds Durable Object memory by page size instead of session size.
 */
export const PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS = 500;
export const PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS = 10_000;
export const PROJECT_DATA_ARCHIVE_DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const PROJECT_DATA_ARCHIVE_DEFAULT_WALL_TIME_MS = 5_000;
export const PROJECT_DATA_ARCHIVE_DEFAULT_R2_PREFIX = 'project-data/session-archives';
export const PROJECT_DATA_ARCHIVE_DEFAULT_SEARCH_MAX_OWNERS = 4;
export const PROJECT_DATA_ARCHIVE_MAX_SEARCH_OWNERS = 64;

export type ProjectDataArchiveOwnerRef = {
  kind: ProjectDataArchiveOwnerKind;
  projectId: string;
  ownerName: string;
  generation: number;
};

export type ProjectDataArchiveLocation = ProjectDataArchiveOwnerRef & {
  state: ProjectDataArchiveLocationState;
  sessionId: string;
  migrationId: string | null;
  targetAggregateSha256: string | null;
  routingSchemaVersion: number;
};

export type ProjectDataArchiveRowValue = string | number | null;
export type ProjectDataArchiveRow = Record<string, ProjectDataArchiveRowValue>;

export type ProjectDataArchiveExactReadInput = {
  projectId: string;
  sessionId: string;
  ownerName: string;
  generation: number;
  migrationId: string | null;
};

export type ProjectDataArchiveChunk = {
  migrationId: string;
  projectId: string;
  sessionId: string;
  sourceOwnerName: string;
  targetOwnerName: string;
  targetGeneration: number;
  tableName: ProjectDataArchiveTableName;
  ordinal: number;
  rows: ProjectDataArchiveRow[];
  rowIds: string[];
  cursor: string | null;
  hasMore: boolean;
  rowCount: number;
  byteCount: number;
  sha256: string;
};
