/**
 * Sources for `ops_timeline`. Each source turns one store into time-stamped events for an
 * entity graph. Add a source by appending it to `DEFAULT_TIMELINE_SOURCES`; `buildTimeline`
 * (./timeline.ts) runs every source in isolation, merges and caps the result.
 *
 * Free text written by users, agents or node processes goes in `text`, never `summary`;
 * `buildTimeline` neutralizes and length-caps it as untrusted data.
 */
import type { Env } from '../../env';
import { getBootLogs } from '../boot-log';
import { listNodeEventsOnNode } from '../node-agent';
import { type NodeAccess, runNodeDiagnostic } from '../node-diagnostics-access';
import { listActivityEvents } from '../project-data';
import type { EntityGraph, OpsEntityType } from './entity-graph';

export interface TimelineScope {
  readonly entityType: OpsEntityType;
  readonly entityId: string;
  readonly projectId: string | null;
  readonly taskIds: readonly string[];
  readonly chatSessionIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly sinceMs: number;
  readonly untilMs: number;
  /** The resolved rows, so sources need not re-read them. */
  readonly graph: EntityGraph;
  /** Gated operator access, for sources that call node agents. */
  readonly nodeAccess: NodeAccess;
}

export interface TimelineEvent {
  readonly at: string;
  readonly source: string;
  readonly kind: string;
  readonly summary: string;
  readonly ids: Readonly<Record<string, string | null>>;
  /** Untrusted free text (log line, error message, event payload). */
  readonly text?: string;
}

export interface TimelineSource {
  readonly name: string;
  collect(env: Env, scope: TimelineScope, limit: number): Promise<TimelineEvent[]>;
}

type Row = Record<string, unknown>;

/** D1 mixes `CURRENT_TIMESTAMP` text and ISO strings; epoch numbers come from DO/observability. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function inWindow(scope: TimelineScope, ms: number | null): ms is number {
  return ms !== null && ms >= scope.sinceMs && ms <= scope.untilMs;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** Lifecycle timestamps already on the resolved D1 rows. */
const recordSource: TimelineSource = {
  name: 'records',
  async collect(_env, scope, limit) {
    const events: TimelineEvent[] = [];
    const push = (
      row: Row,
      column: string,
      kind: string,
      summary: string,
      ids: Record<string, string | null>
    ) => {
      const ms = toEpochMs(row[column]);
      if (inWindow(scope, ms)) {
        events.push({ at: new Date(ms).toISOString(), source: 'records', kind, summary, ids });
      }
    };
    for (const t of scope.graph.tasks) {
      const ids = { taskId: str(t.id), chatSessionId: str(t.chat_session_id) };
      push(t, 'created_at', 'task.created', `Task created (${str(t.task_mode) ?? 'task'})`, ids);
      push(t, 'started_at', 'task.started', 'Task started', ids);
      push(t, 'completed_at', 'task.ended', `Task ended as ${str(t.status)}`, ids);
    }
    for (const w of scope.graph.workspaces) {
      const ids = { workspaceId: str(w.id), nodeId: str(w.node_id) };
      push(w, 'created_at', 'workspace.created', 'Workspace created', ids);
      push(w, 'dispatched_at', 'workspace.dispatched', 'Workspace dispatched to node', ids);
      push(
        w,
        'stop_runtime_confirmed_at',
        'workspace.stop_confirmed',
        'Runtime stop confirmed',
        ids
      );
      push(
        w,
        'runtime_deletion_confirmed_at',
        'workspace.deletion_confirmed',
        'Runtime deletion confirmed',
        ids
      );
      push(
        w,
        'updated_at',
        'workspace.last_update',
        `Workspace last updated (status ${str(w.status)})`,
        ids
      );
    }
    for (const s of scope.graph.snapshots) {
      const ids = { snapshotId: str(s.id), chatSessionId: str(s.chat_session_id) };
      push(s, 'created_at', 'snapshot.created', 'Session snapshot created', ids);
      push(s, 'sleep_episode_started_at', 'snapshot.sleep_started', 'Sleep episode started', ids);
      push(s, 'sleeping_at', 'snapshot.sleeping', 'Session went to sleep', ids);
      push(
        s,
        'restored_at',
        'snapshot.restored',
        `Restore ${str(s.restore_status) ?? 'finished'}`,
        ids
      );
      push(s, 'recovery_failed_at', 'snapshot.recovery_failed', 'Wake/recovery failed', ids);
    }
    for (const a of scope.graph.agentSessions) {
      const ids = { agentSessionId: str(a.id), workspaceId: str(a.workspace_id) };
      push(
        a,
        'created_at',
        'agent_session.created',
        `Agent session created (${str(a.agent_type)})`,
        ids
      );
      push(a, 'stopped_at', 'agent_session.stopped', 'Agent session stopped', ids);
      push(a, 'suspended_at', 'agent_session.suspended', 'Agent session suspended', ids);
    }
    for (const n of scope.graph.nodes) {
      const ids = { nodeId: str(n.id) };
      push(
        n,
        'created_at',
        'node.created',
        `Node created (${str(n.cloud_provider) ?? 'unknown'})`,
        ids
      );
      push(n, 'warm_since', 'node.warm', 'Node entered warm pool', ids);
      push(n, 'last_heartbeat_at', 'node.last_heartbeat', 'Last node heartbeat', ids);
    }
    return events.slice(-limit);
  },
};

const taskStatusSource: TimelineSource = {
  name: 'task_status_events',
  async collect(env, scope, limit) {
    if (scope.taskIds.length === 0) return [];
    const rows = await env.DATABASE.prepare(
      `SELECT task_id, from_status, to_status, actor_type, reason, created_at
       FROM task_status_events
       WHERE task_id IN (${placeholders(scope.taskIds)})
         AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)
       ORDER BY julianday(created_at) DESC, id DESC
       LIMIT ?`
    )
      .bind(
        ...scope.taskIds,
        new Date(scope.sinceMs).toISOString(),
        new Date(scope.untilMs).toISOString(),
        limit
      )
      .all<Row>();
    return (rows.results ?? []).flatMap((row): TimelineEvent[] => {
      const ms = toEpochMs(row.created_at);
      if (ms === null) return [];
      return [
        {
          at: new Date(ms).toISOString(),
          source: 'task_status_events',
          kind: 'task.status',
          summary: `Task ${str(row.from_status) ?? 'new'} → ${str(row.to_status)} by ${str(row.actor_type)}`,
          ids: { taskId: str(row.task_id) },
          ...(str(row.reason) ? { text: String(row.reason) } : {}),
        },
      ];
    });
  },
};

const platformErrorSource: TimelineSource = {
  name: 'platform_errors',
  async collect(env, scope, limit) {
    const clauses: [string, readonly string[]][] = [
      ['task_id', scope.taskIds],
      ['workspace_id', scope.workspaceIds],
      ['node_id', scope.nodeIds],
      ['session_id', scope.chatSessionIds],
    ];
    const used = clauses.filter(([, values]) => values.length > 0);
    if (used.length === 0) return [];
    const rows = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT id, source, level, message, task_id, workspace_id, node_id, session_id, timestamp
       FROM platform_errors
       WHERE (${used.map(([col, values]) => `${col} IN (${placeholders(values)})`).join(' OR ')})
         AND timestamp BETWEEN ? AND ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    )
      .bind(...used.flatMap(([, values]) => [...values]), scope.sinceMs, scope.untilMs, limit)
      .all<Row>();
    return (rows.results ?? []).map((row) => ({
      at: new Date(Number(row.timestamp)).toISOString(),
      source: 'platform_errors',
      kind: `error.${str(row.level) ?? 'error'}`,
      summary: `${str(row.source) ?? 'unknown'} ${str(row.level) ?? 'error'} (platform error ${str(row.id)})`,
      ids: {
        errorId: str(row.id),
        taskId: str(row.task_id),
        workspaceId: str(row.workspace_id),
        nodeId: str(row.node_id),
      },
      text: String(row.message ?? ''),
    }));
  },
};

const nodeHealthSource: TimelineSource = {
  name: 'node_health_events',
  async collect(env, scope, limit) {
    if (scope.nodeIds.length === 0) return [];
    const rows = await env.DATABASE.prepare(
      `SELECT node_id, event, reason, created_at FROM node_health_events
       WHERE node_id IN (${placeholders(scope.nodeIds)})
         AND julianday(created_at) BETWEEN julianday(?) AND julianday(?)
       ORDER BY julianday(created_at) DESC, rowid DESC
       LIMIT ?`
    )
      .bind(
        ...scope.nodeIds,
        new Date(scope.sinceMs).toISOString(),
        new Date(scope.untilMs).toISOString(),
        limit
      )
      .all<Row>();
    return (rows.results ?? []).flatMap((row): TimelineEvent[] => {
      const ms = toEpochMs(row.created_at);
      if (ms === null) return [];
      return [
        {
          at: new Date(ms).toISOString(),
          source: 'node_health_events',
          kind: `node.health.${str(row.event) ?? 'event'}`,
          summary: `Node health ${str(row.event)}: ${str(row.reason) ?? ''}`.trim(),
          ids: { nodeId: str(row.node_id) },
        },
      ];
    });
  },
};

/** At most this many chat sessions, workspaces or nodes get a per-entity fan-out read. */
export const TIMELINE_FANOUT_LIMIT = 3;

const activitySource: TimelineSource = {
  name: 'activity_events',
  async collect(env, scope, limit) {
    if (!scope.projectId) return [];
    const projectId = scope.projectId;
    const pages = await Promise.all(
      scope.chatSessionIds
        .slice(0, TIMELINE_FANOUT_LIMIT)
        .map((sessionId) =>
          listActivityEvents(env, projectId, null, limit, scope.untilMs + 1, sessionId)
        )
    );
    return pages.flatMap((page) =>
      page.events.flatMap((event): TimelineEvent[] => {
        const ms = toEpochMs(event.created_at);
        if (!inWindow(scope, ms)) return [];
        return [
          {
            at: new Date(ms).toISOString(),
            source: 'activity_events',
            kind: `activity.${str(event.event_type) ?? 'event'}`,
            summary: `Activity ${str(event.event_type)} by ${str(event.actor_type) ?? 'unknown'}`,
            ids: {
              chatSessionId: str(event.session_id),
              taskId: str(event.task_id),
              workspaceId: str(event.workspace_id),
            },
            ...(typeof event.payload === 'string' && event.payload ? { text: event.payload } : {}),
          },
        ];
      })
    );
  },
};

const bootLogSource: TimelineSource = {
  name: 'boot_log',
  async collect(env, scope, limit) {
    const logs = await Promise.all(
      scope.workspaceIds
        .slice(0, TIMELINE_FANOUT_LIMIT)
        .map(async (workspaceId) => ({
          workspaceId,
          entries: await getBootLogs(env.KV, workspaceId, env),
        }))
    );
    return logs
      .flatMap(({ workspaceId, entries }) =>
        entries.flatMap((entry): TimelineEvent[] => {
          const ms = toEpochMs(entry.timestamp);
          if (!inWindow(scope, ms)) return [];
          return [
            {
              at: new Date(ms).toISOString(),
              source: 'boot_log',
              kind: `boot.${entry.status}`,
              summary: `Boot step ${entry.step} ${entry.status}`,
              ids: { workspaceId },
              text: [entry.message, entry.detail].filter(Boolean).join('\n'),
            },
          ];
        })
      )
      .slice(-limit);
  },
};

/** Live VM agent events; only reachable while the node is running. */
const nodeAgentEventSource: TimelineSource = {
  name: 'node_agent_events',
  async collect(env, scope, limit) {
    const nodes = scope.graph.nodes
      .filter((n) => n.status === 'running')
      .slice(0, TIMELINE_FANOUT_LIMIT);
    const pages = await Promise.all(
      nodes.map(async (node) => {
        const outcome = await runNodeDiagnostic(
          { id: String(node.id), status: 'running' },
          scope.nodeAccess,
          (nodeId, userId) => listNodeEventsOnNode(nodeId, env, userId, limit)
        );
        return {
          nodeId: String(node.id),
          events: outcome.status === 'ok' ? outcome.value.events : [],
        };
      })
    );
    return pages.flatMap(({ nodeId, events }) =>
      events.flatMap((raw): TimelineEvent[] => {
        if (typeof raw !== 'object' || raw === null) return [];
        const event = raw as Row;
        const ms = toEpochMs(event.createdAt);
        if (!inWindow(scope, ms)) return [];
        return [
          {
            at: new Date(ms).toISOString(),
            source: 'node_agent_events',
            kind: `node.event.${str(event.type) ?? str(event.level) ?? 'event'}`,
            summary: `Node agent event ${str(event.type) ?? ''}`.trim(),
            ids: { nodeId, workspaceId: str(event.workspaceId) },
            text: str(event.message) ?? JSON.stringify(event),
          },
        ];
      })
    );
  },
};

export const DEFAULT_TIMELINE_SOURCES: readonly TimelineSource[] = [
  recordSource,
  taskStatusSource,
  activitySource,
  platformErrorSource,
  nodeHealthSource,
  bootLogSource,
  nodeAgentEventSource,
];
