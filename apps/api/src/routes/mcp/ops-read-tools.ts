/**
 * Read-only Operations fleet tools: anomalies, nodes, session story, timeline, platform errors
 * and Worker logs. Each is a thin adapter over a `services/fleet-ops/*` operation and runs
 * through `runOpsReadTool` (gate + audit + untrusted envelope).
 */
import type { PlatformErrorLevel, PlatformErrorSource } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import {
  checkRateLimit,
  createRateLimitKey,
  getCurrentWindowStart,
} from '../../middleware/rate-limit';
import { untrustedTextBlock } from '../../operations/untrusted-text';
import {
  ANOMALY_CLASSES,
  type AnomalyClass,
  findAnomalies,
} from '../../services/fleet-ops/anomalies';
import { OPS_ENTITY_TYPES, type OpsEntityType } from '../../services/fleet-ops/entity-graph';
import { getFleetNode, listFleetNodes } from '../../services/fleet-ops/nodes';
import { getSessionStory } from '../../services/fleet-ops/session-story';
import { buildTimeline } from '../../services/fleet-ops/timeline';
import { operatorNodeAccess } from '../../services/node-diagnostics-access';
import { getLogQueryRateLimit, queryErrors } from '../../services/observability';
import {
  queryWorkerLogs,
  WORKER_LOG_LEVELS,
  WORKER_LOG_RATE_KEY_PREFIX,
  WORKER_LOG_RATE_WINDOW_SECONDS,
} from '../../services/worker-log-query';
import type { JsonRpcResponse, McpTokenData } from './_helpers';
import {
  OpsToolInputError,
  optionalEnum,
  optionalLimit,
  optionalString,
  optionalTime,
  requiredString,
  runOpsReadTool,
} from './ops-tool-runner';

type Handler = (
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
) => Promise<JsonRpcResponse>;

const ERROR_SOURCES = ['client', 'vm-agent', 'api'] as const;
const ERROR_LEVELS = ['error', 'warn', 'info'] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** One free-text field, capped and fenced in its own untrusted envelope. */
function bounded(kind: string, text: unknown, max: number): string {
  return untrustedTextBlock({
    kind,
    text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
    maxLength: max,
  }).text;
}

export const handleOpsFindAnomalies: Handler = (requestId, params, tokenData, env) => {
  const requested = Array.isArray(params.classes) ? params.classes : [];
  return runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_find_anomalies', targetType: 'installation' },
    async ({ settings }) => {
      const classes = requested.map((value) => {
        if (typeof value !== 'string' || !(ANOMALY_CLASSES as readonly string[]).includes(value)) {
          throw new OpsToolInputError(`classes must contain only: ${ANOMALY_CLASSES.join(', ')}`);
        }
        return value as AnomalyClass;
      });
      const report = await findAnomalies(env, settings, { classes });
      return {
        result: { ...report },
        detail: { findings: report.classes.reduce((sum, c) => sum + c.returned, 0) },
      };
    }
  );
};

export const handleOpsListNodes: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_list_nodes', targetType: 'installation' },
    async ({ settings }) => {
      const result = await listFleetNodes(env, {
        status: optionalString(params, 'status', 32) ?? null,
        userId: optionalString(params, 'userId', 128) ?? null,
        includeDeleted: params.includeDeleted === true,
        limit: optionalLimit(params, 'limit', settings.listMaxRows) ?? settings.listMaxRows,
      });
      return { result: { ...result }, detail: { returned: result.returned, total: result.total } };
    }
  );

export const handleOpsGetNode: Handler = (requestId, params, tokenData, env) => {
  const nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
  return runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_get_node', targetType: 'node', targetId: nodeId || null },
    async ({ settings }) => {
      const id = requiredString(params, 'nodeId', 128);
      const result = await getFleetNode(env, id, settings.listMaxRows);
      if (!result) throw new OpsToolInputError(`Node ${id} not found`);
      return { result: { ...result } };
    }
  );
};

function entityTypeParam(params: Record<string, unknown>): OpsEntityType | null {
  return optionalEnum(params, 'entityType', OPS_ENTITY_TYPES) ?? null;
}

export const handleOpsGetSessionStory: Handler = (requestId, params, tokenData, env) => {
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  return runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_get_session_story', targetType: 'entity', targetId: id || null },
    async ({ settings }) => {
      const entityType = entityTypeParam(params);
      if (entityType === 'node') {
        throw new OpsToolInputError('ops_get_session_story takes a task, session or workspace ID');
      }
      const story = await getSessionStory(env, {
        id: requiredString(params, 'id', 128),
        entityType,
        rowCap: settings.entityGraphRowCap,
        textMaxLength: settings.textFieldMaxLength * 4,
      });
      return { result: { ...story } };
    }
  );
};

export const handleOpsTimeline: Handler = (requestId, params, tokenData, env) => {
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  return runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_timeline', targetType: 'entity', targetId: id || null },
    async ({ grant, settings }) => {
      const result = await buildTimeline(env, {
        entityId: requiredString(params, 'id', 128),
        entityType: entityTypeParam(params),
        sinceMs: optionalTime(params, 'since'),
        untilMs: optionalTime(params, 'until'),
        defaultWindowMs: settings.timelineDefaultWindowHours * HOUR_MS,
        fanoutLimit: settings.timelineFanoutLimit,
        limit:
          optionalLimit(params, 'limit', settings.timelineMaxEvents) ?? settings.timelineMaxEvents,
        perSourceLimit: settings.timelinePerSourceLimit,
        graphRowCap: settings.entityGraphRowCap,
        textMaxLength: settings.textFieldMaxLength,
        nodeAccess: operatorNodeAccess(grant),
      });
      return {
        result: { ...result },
        detail: { events: result.events.length, truncated: result.truncated },
      };
    }
  );
};

export const handleOpsSearchErrors: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_search_errors', targetType: 'installation' },
    async ({ settings }) => {
      const result = await queryErrors(env.OBSERVABILITY_DATABASE, {
        source: optionalEnum(params, 'source', ERROR_SOURCES) as PlatformErrorSource | undefined,
        level: optionalEnum(params, 'level', ERROR_LEVELS) as PlatformErrorLevel | undefined,
        search: optionalString(params, 'contains', 500),
        startTime: optionalTime(params, 'since'),
        endTime: optionalTime(params, 'until'),
        nodeId: optionalString(params, 'nodeId', 128),
        workspaceId: optionalString(params, 'workspaceId', 128),
        taskId: optionalString(params, 'taskId', 128),
        sessionId: optionalString(params, 'sessionId', 128),
        userId: optionalString(params, 'userId', 128),
        limit: optionalLimit(params, 'limit', settings.listMaxRows) ?? 50,
        cursor: optionalString(params, 'cursor', 64),
      });
      const max = settings.textFieldMaxLength;
      return {
        result: {
          total: result.total,
          hasMore: result.hasMore,
          cursor: result.cursor,
          errors: result.errors.map((e) => ({
            id: e.id,
            source: e.source,
            level: e.level,
            at: e.timestamp,
            userId: e.userId,
            nodeId: e.nodeId,
            workspaceId: e.workspaceId,
            taskId: e.taskId,
            sessionId: e.sessionId,
            message: bounded('error message', e.message, max),
            context: e.context ? bounded('error context', e.context, max) : null,
            hasStack: Boolean(e.stack),
          })),
        },
        detail: { returned: result.errors.length, total: result.total },
      };
    }
  );

export const handleOpsQueryWorkerLogs: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_query_worker_logs', targetType: 'installation' },
    async ({ grant, settings }) => {
      // Same per-user bucket as Admin → Logs, so the two surfaces share one quota.
      const window = getCurrentWindowStart(WORKER_LOG_RATE_WINDOW_SECONDS);
      const limit = getLogQueryRateLimit(env);
      const rate = await checkRateLimit(
        env.KV,
        createRateLimitKey(WORKER_LOG_RATE_KEY_PREFIX, grant.userId, window),
        limit,
        WORKER_LOG_RATE_WINDOW_SECONDS
      );
      if (!rate.allowed) {
        throw new OpsToolInputError(
          `Worker log query rate limit reached (${limit} per minute); retry after ${new Date(rate.resetAt * 1000).toISOString()}`
        );
      }
      const until = optionalTime(params, 'until') ?? Date.now();
      const since =
        optionalTime(params, 'since') ?? until - settings.workerLogDefaultWindowMinutes * MINUTE_MS;
      const levels = Array.isArray(params.levels) ? params.levels : [];
      for (const level of levels) {
        if (
          typeof level !== 'string' ||
          !(WORKER_LOG_LEVELS as readonly string[]).includes(level)
        ) {
          throw new OpsToolInputError(`levels must contain only: ${WORKER_LOG_LEVELS.join(', ')}`);
        }
      }
      const result = await queryWorkerLogs(env, {
        timeRange: { start: new Date(since).toISOString(), end: new Date(until).toISOString() },
        levels: levels as string[],
        search: optionalString(params, 'contains', 500),
        limit: optionalLimit(params, 'limit', settings.listMaxRows) ?? 50,
        cursor: optionalString(params, 'cursor', 512),
        queryId: optionalString(params, 'queryId', 128),
        scriptName: optionalString(params, 'scriptName', 64),
      });
      const max = settings.textFieldMaxLength;
      return {
        result: {
          queryId: result.queryId,
          cursor: result.cursor,
          hasMore: result.hasMore,
          logs: result.logs.map((entry) => ({
            at: entry.timestamp,
            level: entry.level,
            event: entry.event,
            invocationId: entry.invocationId,
            message: bounded('worker log message', entry.message, max),
            details: bounded('worker log details', entry.details, max),
          })),
        },
        detail: { returned: result.logs.length },
      };
    }
  );
