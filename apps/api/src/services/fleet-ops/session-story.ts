/**
 * `ops_get_session_story`: one joined record for a task, chat session or workspace ID.
 *
 * Structured fields are IDs, statuses and timestamps. Every free-text value (error messages,
 * boot log lines, the ProjectData session record, which carries topics and prompts) is
 * returned inside an untrusted-data envelope (`operations/untrusted-text.ts`).
 *
 * Reads: the entity graph (4-6 D1), ProjectData session + state + ACP sessions for the primary
 * chat session (3 DO RPCs), the primary workspace's boot log (1 DO) and deletion state (1 DO),
 * related platform errors (1 observability D1).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { untrustedTextBlock } from '../../operations/untrusted-text';
import { getBootLogs } from '../boot-log';
import { getWorkspaceDeletionAttemptState } from '../node-lifecycle';
import { getSession, getSessionState, listAcpSessions } from '../project-data';
import {
  anyIdIn,
  ENTITY_TEXT_COLUMNS,
  type EntityGraph,
  type OpsEntityType,
  resolveEntityGraph,
} from './entity-graph';

type Row = Record<string, unknown>;

export interface SessionStoryRequest {
  readonly id: string;
  readonly entityType: Exclude<OpsEntityType, 'node'> | null;
  readonly rowCap: number;
  readonly textMaxLength: number;
}

/** Splits a row into structured fields and the free-text fields it carried. */
/** Free text a user or agent wrote: error columns plus task titles. */
const STORY_TEXT_COLUMNS: readonly string[] = [...ENTITY_TEXT_COLUMNS, 'title'];

function splitRow(row: Row, label: string, texts: string[]): Row {
  const structured: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (STORY_TEXT_COLUMNS.includes(key)) {
      if (typeof value === 'string' && value)
        texts.push(`[${label} ${String(row.id)} ${key}] ${value}`);
      structured[`has_${key}`] = typeof value === 'string' && value.length > 0;
    } else {
      structured[key] = value;
    }
  }
  return structured;
}

/** Each read is isolated: a failure costs only its own section and is reported in `readFailures`. */
async function settle<T>(
  label: string,
  failures: Record<string, string>,
  read: () => Promise<T>
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('fleet_ops.session_story_read_failed', { read: label, error: message });
    failures[label] = message;
    return null;
  }
}

function primaryChatSessionId(graph: EntityGraph): string | null {
  if (graph.entityType === 'session') return graph.entityId;
  if (graph.entityType === 'workspace') {
    // The workspace's own link wins: a retry can relink it to a newer chat session.
    const own = graph.workspaces.find((w) => w.id === graph.entityId)?.chat_session_id;
    if (typeof own === 'string' && own) return own;
  }
  const fromTask = graph.tasks.find((t) => t.id === graph.entityId)?.chat_session_id;
  if (typeof fromTask === 'string' && fromTask) return fromTask;
  return graph.chatSessionIds[0] ?? null;
}

/**
 * The workspace the story centres on: the one asked for, else the task's own workspace, else
 * the most recently created related workspace. Every related workspace is still returned.
 */
function primaryWorkspace(graph: EntityGraph): Row | null {
  if (graph.entityType === 'workspace') {
    return graph.workspaces.find((w) => w.id === graph.entityId) ?? null;
  }
  const taskWorkspace = graph.tasks.find((t) => t.id === graph.entityId)?.workspace_id;
  return graph.workspaces.find((w) => w.id === taskWorkspace) ?? graph.workspaces[0] ?? null;
}

/**
 * Errors tied to this story's tasks, workspaces or chat sessions. Node-level errors are left out
 * on purpose: a node hosts other users' sessions too (read them with `ops_timeline` on the node
 * or `ops_search_errors` with `nodeId`).
 */
async function relatedErrors(env: Env, graph: EntityGraph, limit: number): Promise<Row[]> {
  const where = anyIdIn([
    ['task_id', graph.taskIds],
    ['workspace_id', graph.workspaceIds],
    ['session_id', graph.chatSessionIds],
  ]);
  if (where.binds.length === 0) return [];
  const rows = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, source, level, message, task_id, workspace_id, node_id, session_id, timestamp
     FROM platform_errors
     WHERE ${where.sql}
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`
  )
    .bind(...where.binds, limit)
    .all<Row>();
  return rows.results ?? [];
}

export async function getSessionStory(env: Env, request: SessionStoryRequest) {
  const graph = await resolveEntityGraph(env, request.id, request.entityType, request.rowCap);
  if (graph.entityType === 'node') {
    return { found: false as const, reason: 'The ID is a node; use ops_get_node or ops_timeline.' };
  }
  if (!graph.found) {
    return { found: false as const, entityType: graph.entityType, entityId: request.id };
  }

  const texts: string[] = [];
  const failures: Record<string, string> = {};
  const chatSessionId = primaryChatSessionId(graph);
  const workspace = primaryWorkspace(graph);
  const workspaceId = typeof workspace?.id === 'string' ? workspace.id : null;
  const nodeId = typeof workspace?.node_id === 'string' ? workspace.node_id : null;
  const projectId = graph.projectId;

  const [chatSession, sessionState, acpSessions, bootLog, deletionState, errors] =
    await Promise.all([
      projectId && chatSessionId
        ? settle('chat_session', failures, () => getSession(env, projectId, chatSessionId))
        : null,
      projectId && chatSessionId
        ? settle('session_state', failures, () => getSessionState(env, projectId, chatSessionId))
        : null,
      projectId && chatSessionId
        ? settle('acp_sessions', failures, () =>
            listAcpSessions(env, projectId, { chatSessionId, limit: request.rowCap })
          )
        : null,
      workspaceId
        ? settle('boot_log', failures, () => getBootLogs(env.KV, workspaceId, env))
        : null,
      workspaceId && nodeId
        ? settle('deletion_state', failures, () =>
            getWorkspaceDeletionAttemptState(env, nodeId, workspaceId)
          )
        : null,
      settle('platform_errors', failures, () => relatedErrors(env, graph, request.rowCap)),
    ]);

  const tasks = graph.tasks.map((row) => splitRow(row, 'task', texts));
  const workspaces = graph.workspaces.map((row) => splitRow(row, 'workspace', texts));
  const agentSessions = graph.agentSessions.map((row) => splitRow(row, 'agent_session', texts));
  const snapshots = graph.snapshots.map((row) => splitRow(row, 'snapshot', texts));

  const errorRows = errors ?? [];
  for (const row of errorRows) {
    texts.push(
      `[platform_error ${String(row.id)} ${String(row.level)}] ${String(row.message ?? '')}`
    );
  }
  const bootEntries = bootLog ?? [];
  const bootText = bootEntries
    .map(
      (e) => `${e.timestamp} ${e.step} ${e.status}: ${e.message}${e.detail ? ` — ${e.detail}` : ''}`
    )
    .join('\n');

  return {
    found: true as const,
    entityType: graph.entityType,
    entityId: graph.entityId,
    projectId,
    primary: { chatSessionId, workspaceId, nodeId },
    tasks,
    workspaces,
    agentSessions,
    snapshots,
    nodes: graph.nodes,
    deletionState: deletionState ?? null,
    platformErrors: errorRows.map((row) => ({
      id: row.id,
      source: row.source,
      level: row.level,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      nodeId: row.node_id,
      sessionId: row.session_id,
      at: typeof row.timestamp === 'number' ? new Date(row.timestamp).toISOString() : null,
    })),
    capped: graph.capped,
    readFailures: failures,
    recordedText: untrustedTextBlock({
      kind: 'recorded errors',
      text: texts.join('\n'),
      maxLength: request.textMaxLength,
    }),
    bootLog: untrustedTextBlock({
      kind: 'boot log',
      text: bootText,
      maxLength: request.textMaxLength,
    }),
    projectData: untrustedTextBlock({
      kind: 'project data session',
      text: JSON.stringify({ chatSession, sessionState, acpSessions }, null, 1),
      maxLength: request.textMaxLength * 4,
    }),
  };
}
