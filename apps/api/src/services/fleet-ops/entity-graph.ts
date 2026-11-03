/**
 * Resolves one task, chat session, workspace or node ID into the D1 rows around it, across
 * every user of the installation. `ops_get_session_story` and `ops_timeline` both start here,
 * so they agree on which records belong to an entity.
 *
 * Bounded: each table read is capped at `rowCap` rows (most recent first) and reports when
 * the cap cut it (`.claude/rules/65`).
 */
import type { Env } from '../../env';
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';

export const OPS_ENTITY_TYPES = ['task', 'session', 'workspace', 'node'] as const;
export type OpsEntityType = (typeof OPS_ENTITY_TYPES)[number];

type Row = Record<string, unknown>;

export interface EntityGraph {
  readonly entityType: OpsEntityType;
  readonly entityId: string;
  readonly found: boolean;
  readonly projectId: string | null;
  readonly taskIds: readonly string[];
  readonly chatSessionIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly tasks: readonly Row[];
  readonly workspaces: readonly Row[];
  readonly agentSessions: readonly Row[];
  readonly snapshots: readonly Row[];
  readonly nodes: readonly Row[];
  /** Tables whose read hit `rowCap`; more rows exist than were returned. */
  readonly capped: readonly string[];
}

const TASK_COLUMNS = `id, project_id, user_id, chat_session_id, workspace_id, parent_task_id,
  recovery_source_task_id, superseded_by_task_id, title, status, execution_step, task_mode,
  scheduler_state, admission_state, admission_reason, started_at, completed_at,
  terminal_reason, error_message, output_branch,
  output_pr_url, auto_provisioned_node_id, created_at, updated_at`;

const WORKSPACE_COLUMNS = `id, node_id, project_id, user_id, chat_session_id, status,
  vm_size, vm_location, workspace_profile, last_activity_at, dispatched_at,
  runtime_deletion_confirmed_at, stop_runtime_confirmed_at, eviction_finalized_at,
  error_message, created_at, updated_at`;

const SNAPSHOT_COLUMNS = `id, project_id, workspace_id, node_id, user_id, chat_session_id,
  agent_session_id, runtime, status, degradation, expires_at, restore_status, restored_at,
  sleeping_at, recovery_status, recovery_task_id, recovery_workspace_id, recovery_attempts,
  recovery_failed_at, sleep_status, sleep_after, sleep_attempts, sleep_claimed_at,
  sleep_stopping_since, sleep_episode_started_at, sleep_episode_failures,
  restore_message, capture_error, sleep_error, recovery_error, created_at, updated_at`;

const AGENT_SESSION_COLUMNS = `id, workspace_id, user_id, status, agent_type, agent_profile_id,
  agent_credential_source, agent_provider_mode, skill_id, stopped_at, suspended_at,
  error_message, created_at, updated_at`;

const NODE_COLUMNS = `id, user_id, name, status, health_status, cloud_provider, vm_size,
  vm_location, node_role, node_class, runtime, last_heartbeat_at, heartbeat_stale_after_seconds,
  warm_since, agent_version, cleanup_blocked_since, cleanup_blocked_reason, created_at, updated_at`;

/** Free-text columns on the rows above. Callers must fence them as untrusted before output. */
export const ENTITY_TEXT_COLUMNS = [
  'error_message',
  'restore_message',
  'capture_error',
  'sleep_error',
  'recovery_error',
] as const;

/**
 * Most IDs of one kind a single statement binds. Four ID lists plus three window/limit binds
 * stay under `D1_MAX_BOUND_PARAMETERS`; `capIds` reports when it cut a list.
 */
export const OPS_ID_LIST_CAP = Math.floor((D1_MAX_BOUND_PARAMETERS - 4) / 4);

export function capIds(values: readonly string[]): string[] {
  return values.slice(0, OPS_ID_LIST_CAP);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function strings(rows: readonly Row[], column: string): string[] {
  return rows.map((row) => row[column]).filter((v): v is string => typeof v === 'string' && !!v);
}

function unique(...lists: (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

/** `col IN (...)` for each non-empty list, OR-ed; `0` (no rows) when every list is empty. */
function anyIn(clauses: [string, readonly string[]][]): { sql: string; binds: string[] } {
  const parts = clauses
    .map(([column, values]): [string, string[]] => [column, capIds(values)])
    .filter(([, values]) => values.length > 0);
  if (parts.length === 0) return { sql: '0', binds: [] };
  return {
    sql: parts.map(([column, values]) => `${column} IN (${placeholders(values)})`).join(' OR '),
    binds: parts.flatMap(([, values]) => [...values]),
  };
}

async function select(
  env: Env,
  table: string,
  columns: string,
  where: { sql: string; binds: string[] },
  order: string,
  rowCap: number,
  capped: string[]
): Promise<Row[]> {
  if (where.sql === '0') return [];
  const rows = await env.DATABASE.prepare(
    `SELECT ${columns} FROM ${table} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`
  )
    .bind(...where.binds, rowCap + 1)
    .all<Row>();
  const results = rows.results ?? [];
  if (results.length > rowCap) capped.push(table);
  return results.slice(0, rowCap);
}

/** With `entityType` omitted, the ID is tried as a task, workspace, node, then chat session. */
export async function resolveEntityGraph(
  env: Env,
  entityId: string,
  entityType: OpsEntityType | null,
  rowCap: number
): Promise<EntityGraph> {
  const type = entityType ?? (await detectEntityType(env, entityId));
  const capped: string[] = [];
  const seed = {
    taskIds: type === 'task' ? [entityId] : [],
    chatSessionIds: type === 'session' ? [entityId] : [],
    workspaceIds: type === 'workspace' ? [entityId] : [],
    nodeIds: type === 'node' ? [entityId] : [],
  };

  // A node's story is its workspaces, not every task that ever ran on them.
  const tasks =
    type === 'node'
      ? []
      : await select(
          env,
          'tasks',
          TASK_COLUMNS,
          anyIn([
            ['id', seed.taskIds],
            ['recovery_source_task_id', seed.taskIds],
            ['workspace_id', seed.workspaceIds],
            ['chat_session_id', seed.chatSessionIds],
          ]),
          'created_at DESC, id ASC',
          rowCap,
          capped
        );
  const chatFromTasks = unique(seed.chatSessionIds, strings(tasks, 'chat_session_id'));
  const workspaces = await select(
    env,
    'workspaces',
    WORKSPACE_COLUMNS,
    anyIn([
      ['id', unique(seed.workspaceIds, strings(tasks, 'workspace_id'))],
      ['chat_session_id', type === 'node' ? [] : chatFromTasks],
      ['node_id', seed.nodeIds],
    ]),
    'created_at DESC, id ASC',
    rowCap,
    capped
  );
  const workspaceIds = unique(
    seed.workspaceIds,
    strings(tasks, 'workspace_id'),
    strings(workspaces, 'id')
  );
  const chatSessionIds = unique(
    chatFromTasks,
    type === 'node' ? [] : strings(workspaces, 'chat_session_id')
  );
  const [snapshots, agentSessions] = await Promise.all([
    select(
      env,
      'session_snapshots',
      SNAPSHOT_COLUMNS,
      anyIn([
        ['chat_session_id', chatSessionIds],
        ['workspace_id', workspaceIds],
      ]),
      'updated_at DESC, id ASC',
      rowCap,
      capped
    ),
    select(
      env,
      'agent_sessions',
      AGENT_SESSION_COLUMNS,
      anyIn([['workspace_id', workspaceIds]]),
      'created_at DESC, id ASC',
      rowCap,
      capped
    ),
  ]);
  const nodeIds = unique(
    seed.nodeIds,
    strings(workspaces, 'node_id'),
    strings(snapshots, 'node_id')
  );
  const nodes = await select(
    env,
    'nodes',
    NODE_COLUMNS,
    anyIn([['id', nodeIds]]),
    'created_at DESC, id ASC',
    rowCap,
    capped
  );
  const projectId =
    strings(tasks, 'project_id')[0] ??
    strings(workspaces, 'project_id')[0] ??
    strings(snapshots, 'project_id')[0] ??
    null;
  const ids = {
    taskIds: unique(seed.taskIds, strings(tasks, 'id')),
    chatSessionIds: unique(chatSessionIds, strings(snapshots, 'chat_session_id')),
    workspaceIds,
    nodeIds,
  };
  for (const [name, list] of Object.entries(ids)) {
    if (list.length > OPS_ID_LIST_CAP) capped.push(name);
  }
  const found =
    tasks.length + workspaces.length + snapshots.length + nodes.length + agentSessions.length > 0;

  return {
    entityType: type,
    entityId,
    found,
    projectId,
    taskIds: capIds(ids.taskIds),
    chatSessionIds: capIds(ids.chatSessionIds),
    workspaceIds: capIds(ids.workspaceIds),
    nodeIds: capIds(ids.nodeIds),
    tasks,
    workspaces,
    agentSessions,
    snapshots,
    nodes,
    capped,
  };
}

async function detectEntityType(env: Env, id: string): Promise<OpsEntityType> {
  const row = await env.DATABASE.prepare(
    `SELECT CASE
       WHEN EXISTS (SELECT 1 FROM tasks WHERE id = ?1) THEN 'task'
       WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = ?1) THEN 'workspace'
       WHEN EXISTS (SELECT 1 FROM nodes WHERE id = ?1) THEN 'node'
       ELSE 'session' END AS kind`
  )
    .bind(id)
    .first<{ kind: string }>();
  const kind = row?.kind;
  return (OPS_ENTITY_TYPES as readonly string[]).includes(kind ?? '')
    ? (kind as OpsEntityType)
    : 'session';
}
