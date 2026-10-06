import type {
  AdminNodeSummary,
  PlatformErrorLevel,
  PlatformErrorSource,
} from '@simple-agent-manager/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { rateLimit } from '../../middleware/rate-limit';
import {
  AdminLogQuerySchema,
  jsonValidator,
  RunDebugDiagnosisSchema,
  SaveDebugDiagnosisIdeaSchema,
} from '../../schemas';
import {
  createDebugDiagnosisRun,
  getDebugDiagnosisRun,
  listDebugDiagnoses,
  retryDebugDiagnosisRun,
  saveDebugDiagnosisAsIdea,
} from '../../services/debug-agent';
import {
  cancelDiagnosisRunner,
  listDiagnosisEvents,
  startDiagnosisRunner,
} from '../../services/diagnosis-runner';
import {
  getDiagnosticArtifactForDownload,
  getDiagnosticIncidentByErrorId,
  getDiagnosticIncidentsByErrorIds,
  getDiagnosticIncidentsByNodeId,
} from '../../services/diagnostic-incidents';
import {
  CfApiError,
  getErrorTrends,
  getHealthSummary,
  getLogQueryRateLimit,
  queryCloudflareLogs,
  queryErrors,
} from '../../services/observability';
import { runPlatformFeedbackTriage } from '../../services/platform-feedback-triage';

/**
 * Admin observability sub-router (spec 023) — mounted by the parent admin
 * router at /observability, which already enforces requireAuth() +
 * requireApproved() + requireSuperadmin() on every request.
 */
export const adminObservabilityRoutes = new Hono<{ Bindings: Env }>();


const VALID_ERROR_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);
const VALID_ERROR_LEVELS = new Set<string>(['error', 'warn', 'info']);
const DEFAULT_ADMIN_OBSERVABILITY_NODE_LIMIT = 50;
const DEFAULT_ADMIN_OBSERVABILITY_NODE_MAX_LIMIT = 100;
const DEFAULT_ADMIN_OBSERVABILITY_DESTROYED_NODE_RETENTION_HOURS = 24;
const DEFAULT_ADMIN_OBSERVABILITY_NODE_INCIDENT_LIMIT = 50;
const DEFAULT_ADMIN_OBSERVABILITY_NODE_INCIDENT_MAX_LIMIT = 50;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedLimit(
  raw: string | undefined,
  configuredDefault: number,
  configuredMax: number,
  label: string
): number {
  if (!raw) return Math.min(configuredDefault, configuredMax);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > configuredMax) {
    throw errors.badRequest(`${label} must be between 1 and ${configuredMax}`);
  }
  return parsed;
}

function parseErrorTimestamp(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw errors.badRequest(`${label} must be an epoch millisecond timestamp or ISO 8601 date`);
  }
  return timestamp;
}

/**
 * GET /api/admin/observability/errors - Query platform errors
 *
 * Query params: source, level, search, startTime, endTime, nodeId, workspaceId,
 * taskId, sessionId, userId, limit, cursor
 */
adminObservabilityRoutes.get('/errors', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({ errors: [], cursor: null, hasMore: false, total: 0 });
  }

  const source = c.req.query('source');
  const level = c.req.query('level');
  const search = c.req.query('search');
  const startTime = c.req.query('startTime');
  const endTime = c.req.query('endTime');
  const limitParam = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const nodeId = c.req.query('nodeId');
  const workspaceId = c.req.query('workspaceId');
  const taskId = c.req.query('taskId');
  const sessionId = c.req.query('sessionId');
  const userId = c.req.query('userId');

  // Validate source
  if (source && source !== 'all' && !VALID_ERROR_SOURCES.has(source)) {
    throw errors.badRequest(`Invalid source: ${source}. Must be one of: client, vm-agent, api`);
  }

  // Validate level
  if (level && level !== 'all' && !VALID_ERROR_LEVELS.has(level)) {
    throw errors.badRequest(`Invalid level: ${level}. Must be one of: error, warn, info`);
  }

  // Validate limit
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
    throw errors.badRequest('limit must be between 1 and 200');
  }

  const result = await queryErrors(c.env.OBSERVABILITY_DATABASE, {
    source: source && source !== 'all' ? (source as PlatformErrorSource) : undefined,
    level: level && level !== 'all' ? (level as PlatformErrorLevel) : undefined,
    search: search || undefined,
    startTime: parseErrorTimestamp(startTime, 'startTime'),
    endTime: parseErrorTimestamp(endTime, 'endTime'),
    nodeId: nodeId || undefined,
    workspaceId: workspaceId || undefined,
    taskId: taskId || undefined,
    sessionId: sessionId || undefined,
    userId: userId || undefined,
    limit,
    cursor: cursor || undefined,
  });
  const incidents = await getDiagnosticIncidentsByErrorIds(
    c.env,
    result.errors.map((error) => error.id)
  );
  return c.json({
    ...result,
    errors: result.errors.map((error) => ({
      ...error,
      incident: incidents.get(error.id) ?? null,
    })),
  });
});

adminObservabilityRoutes.get('/errors/:errorId/incident', async (c) => {
  const incident = await getDiagnosticIncidentByErrorId(c.env, c.req.param('errorId'));
  if (!incident) throw errors.notFound('Diagnostic incident');
  return c.json({ incident });
});

/** Bounded cross-tenant node health summaries for post-mortem observability. */
adminObservabilityRoutes.get('/nodes', async (c) => {
  const maxLimit = Math.min(
    positiveInteger(
      c.env.OBSERVABILITY_ADMIN_NODES_MAX_LIMIT,
      DEFAULT_ADMIN_OBSERVABILITY_NODE_MAX_LIMIT
    ),
    DEFAULT_ADMIN_OBSERVABILITY_NODE_MAX_LIMIT
  );
  const defaultLimit = positiveInteger(
    c.env.OBSERVABILITY_ADMIN_NODES_DEFAULT_LIMIT,
    DEFAULT_ADMIN_OBSERVABILITY_NODE_LIMIT
  );
  const limit = boundedLimit(c.req.query('limit'), defaultLimit, maxLimit, 'limit');
  const destroyedRetentionHours = positiveInteger(
    c.env.OBSERVABILITY_DESTROYED_NODE_RETENTION_HOURS,
    DEFAULT_ADMIN_OBSERVABILITY_DESTROYED_NODE_RETENTION_HOURS
  );
  const destroyedCutoff = new Date(
    Date.now() - destroyedRetentionHours * 60 * 60 * 1000
  ).toISOString();
  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select({
      id: schema.nodes.id,
      name: schema.nodes.name,
      status: schema.nodes.status,
      healthStatus: schema.nodes.healthStatus,
      lastHeartbeatAt: schema.nodes.lastHeartbeatAt,
      provider: schema.nodes.cloudProvider,
      nodeClass: schema.nodes.nodeClass,
      vmAgentBuild: schema.nodes.agentVersion,
      errorMessage: schema.nodes.errorMessage,
      createdAt: schema.nodes.createdAt,
    })
    .from(schema.nodes)
    .where(
      sql`${schema.nodes.status} <> 'destroyed'
          OR datetime(${schema.nodes.updatedAt}) >= datetime(${destroyedCutoff})`
    )
    .orderBy(
      sql`CASE WHEN ${schema.nodes.lastHeartbeatAt} IS NULL THEN 1 ELSE 0 END`,
      sql`datetime(${schema.nodes.lastHeartbeatAt}) DESC`
    )
    .limit(limit);
  return c.json({ nodes: rows satisfies AdminNodeSummary[] });
});

/** Diagnostic evidence remains queryable after the node itself stops or is destroyed. */
adminObservabilityRoutes.get('/nodes/:nodeId/incidents', async (c) => {
  const maxLimit = Math.min(
    positiveInteger(
      c.env.OBSERVABILITY_NODE_INCIDENTS_MAX_LIMIT,
      DEFAULT_ADMIN_OBSERVABILITY_NODE_INCIDENT_MAX_LIMIT
    ),
    DEFAULT_ADMIN_OBSERVABILITY_NODE_INCIDENT_MAX_LIMIT
  );
  const defaultLimit = positiveInteger(
    c.env.OBSERVABILITY_NODE_INCIDENTS_DEFAULT_LIMIT,
    DEFAULT_ADMIN_OBSERVABILITY_NODE_INCIDENT_LIMIT
  );
  const limit = boundedLimit(c.req.query('limit'), defaultLimit, maxLimit, 'limit');
  const incidents = await getDiagnosticIncidentsByNodeId(c.env, c.req.param('nodeId'), limit);
  return c.json({ incidents });
});

adminObservabilityRoutes.get(
  '/errors/:errorId/incident/artifacts/:artifactId/download',
  async (c) => {
    const errorId = c.req.param('errorId');
    const artifactId = c.req.param('artifactId');
    const { row, object } = await getDiagnosticArtifactForDownload(c.env, errorId, artifactId);
    log.info('diagnostic_incident.admin_download', {
      errorId,
      incidentId: row.incident_id,
      artifactId,
      requestedBy: getUserId(c),
      sizeBytes: row.actual_bytes,
    });
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${row.id}.tar.gz"`,
      'Content-Type': row.content_type,
      'X-Content-Type-Options': 'nosniff',
    });
    if (row.actual_bytes !== null) headers.set('Content-Length', String(row.actual_bytes));
    return new Response(object.body, { headers });
  }
);

/**
 * GET /api/admin/observability/health - Platform health summary
 */
adminObservabilityRoutes.get('/health', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({
      activeNodes: 0,
      activeWorkspaces: 0,
      inProgressTasks: 0,
      errorCount24h: 0,
      timestamp: new Date().toISOString(),
    });
  }

  const result = await getHealthSummary(c.env.DATABASE, c.env.OBSERVABILITY_DATABASE);
  return c.json(result);
});

/**
 * GET /api/admin/observability/trends - Error trends over time
 *
 * Query params: range (1h|24h|7d|30d)
 */
adminObservabilityRoutes.get('/trends', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({ range: '24h', interval: '1h', buckets: [] });
  }

  const range = c.req.query('range') || '24h';
  const validRanges = new Set(['1h', '24h', '7d', '30d']);
  if (!validRanges.has(range)) {
    throw errors.badRequest(`Invalid range: ${range}. Must be one of: 1h, 24h, 7d, 30d`);
  }

  const result = await getErrorTrends(c.env.OBSERVABILITY_DATABASE, range);
  return c.json(result);
});

/**
 * POST /api/admin/observability/logs/query - Query Cloudflare Workers Observability API
 *
 * Body: { timeRange: { start, end }, levels?, search?, limit?, cursor? }
 */
adminObservabilityRoutes.post(
  '/logs/query',
  // Per-admin KV-based rate limiting (1-minute window)
  async (c, next) => {
    const limiter = rateLimit({
      limit: getLogQueryRateLimit(c.env),
      keyPrefix: 'cf-log-query',
      windowSeconds: 60,
    });
    return limiter(c, next);
  },
  jsonValidator(AdminLogQuerySchema),
  async (c) => {
    if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
      throw errors.badRequest(
        'Cloudflare API credentials not configured. Set CF_API_TOKEN and CF_ACCOUNT_ID.'
      );
    }

    const body = c.req.valid('json');

    // Validate dates
    const startDate = new Date(body.timeRange.start);
    const endDate = new Date(body.timeRange.end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw errors.badRequest('timeRange start and end must be valid ISO 8601 dates');
    }

    // Validate levels
    if (body.levels) {
      const validLogLevels = new Set(['error', 'warn', 'info', 'debug', 'log']);
      for (const level of body.levels) {
        if (!validLogLevels.has(level)) {
          throw errors.badRequest(
            `Invalid level: ${level}. Must be one of: error, warn, info, debug, log`
          );
        }
      }
    }

    // Validate limit
    if (body.limit !== undefined && (body.limit < 1 || body.limit > 500)) {
      throw errors.badRequest('limit must be between 1 and 500');
    }

    try {
      const result = await queryCloudflareLogs({
        cfApiToken: c.env.CF_API_TOKEN,
        cfAccountId: c.env.CF_ACCOUNT_ID,
        timeRange: { start: body.timeRange.start, end: body.timeRange.end },
        levels: body.levels ?? undefined,
        search: body.search || undefined,
        limit: body.limit,
        cursor: body.cursor || undefined,
        queryId: body.queryId || undefined,
        scriptName: body.scriptName || undefined,
      });

      return c.json(result);
    } catch (err) {
      if (err instanceof CfApiError) {
        return c.json({ error: 'CF_API_ERROR', message: err.message }, 502);
      }
      throw err;
    }
  }
);

adminObservabilityRoutes.get('/debug/projects', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const projects = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .orderBy(schema.projects.name)
    .limit(200);
  return c.json({ projects });
});

adminObservabilityRoutes.get('/diagnoses', async (c) => {
  const result = await listDebugDiagnoses(c.env, {
    errorId: c.req.query('errorId'),
    startTime: c.req.query('startTime'),
    endTime: c.req.query('endTime'),
  });
  return c.json(result);
});

adminObservabilityRoutes.post('/diagnoses', jsonValidator(RunDebugDiagnosisSchema), async (c) => {
  const body = c.req.valid('json');
  if (
    (!body.errorId && (!body.startTime || !body.endTime)) ||
    (body.errorId && (body.startTime || body.endTime))
  ) {
    throw errors.badRequest('Provide either errorId or a startTime/endTime window');
  }
  try {
    const run = await createDebugDiagnosisRun(c.env, getUserId(c), body);
    await startDiagnosisRunner(c.env, run.id);
    return c.json({ run }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Diagnosis failed';
    if (message.includes('budget') || message.includes('token ceiling')) {
      return c.json({ error: 'DEBUG_BUDGET_EXHAUSTED', message }, 429);
    }
    if (message.includes('not found') || message.includes('window'))
      throw errors.badRequest(message);
    throw err;
  }
});

adminObservabilityRoutes.get('/diagnosis-runs/:runId', async (c) => {
  const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
  if (!run) throw errors.notFound('Diagnosis run not found');
  const cursor = Number(c.req.query('cursor') ?? 0);
  const eventResult = await listDiagnosisEvents(
    c.env,
    run.id,
    Number.isFinite(cursor) && cursor >= 0 ? cursor : 0
  );
  return c.json({ run, ...eventResult });
});

adminObservabilityRoutes.get('/diagnosis-runs/:runId/events', async (c) => {
  const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
  if (!run) throw errors.notFound('Diagnosis run not found');
  const cursor = Number(c.req.query('cursor') ?? 0);
  return c.json(
    await listDiagnosisEvents(c.env, run.id, Number.isFinite(cursor) && cursor >= 0 ? cursor : 0)
  );
});

adminObservabilityRoutes.post('/diagnosis-runs/:runId/cancel', async (c) => {
  const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
  if (!run) throw errors.notFound('Diagnosis run not found');
  await cancelDiagnosisRunner(c.env, run.id);
  return c.json({ accepted: true }, 202);
});

adminObservabilityRoutes.post('/diagnosis-runs/:runId/retry', async (c) => {
  const run = await retryDebugDiagnosisRun(c.env, c.req.param('runId'), getUserId(c));
  await startDiagnosisRunner(c.env, run.id);
  return c.json({ run }, 202);
});

adminObservabilityRoutes.post(
  '/diagnoses/:diagnosisId/idea',
  jsonValidator(SaveDebugDiagnosisIdeaSchema),
  async (c) => {
    const body = c.req.valid('json');
    if (!body.projectId?.trim()) throw errors.badRequest('projectId is required');
    const result = await saveDebugDiagnosisAsIdea(
      c.env,
      c.req.param('diagnosisId'),
      body.projectId,
      getUserId(c),
      body.title
    );
    return c.json(result, 201);
  }
);

adminObservabilityRoutes.post('/feedback-triage', async (c) => {
  const result = await runPlatformFeedbackTriage(c.env, 'manual');
  return c.json({ result });
});

/**
 * GET /api/admin/observability/logs/stream - WebSocket upgrade for real-time log stream
 *
 * Auth is validated on the HTTP upgrade request. The WebSocket connection is
 * forwarded to the AdminLogs DO singleton for hibernatable handling.
 */
adminObservabilityRoutes.get('/logs/stream', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    throw errors.badRequest('WebSocket upgrade required');
  }

  // Forward the upgrade request to the AdminLogs DO singleton
  const doId = c.env.ADMIN_LOGS.idFromName('admin-logs');
  const doStub = c.env.ADMIN_LOGS.get(doId);

  // Rewrite the URL path to /ws for the DO handler
  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/ws';

  return doStub.fetch(new Request(doUrl.toString(), c.req.raw));
});

