/**
 * Deployment environment observability routes: logs, containers and metrics, read from the
 * environment's deployment node through the node agent. Split from `deployment-environments.ts`
 * (file size limit), which registers them in the same place as before.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
} from '../services/node-agent-diagnostics';

type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

function parseLastMetrics(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Result of resolving the deployment node backing an environment, used by the
 * node-proxy GET routes (logs/containers/metrics). Each route maps these
 * variants to its own response shape; the lookup and ownership checks are
 * shared here. Throws `notFound` when the environment itself does not exist.
 */
type ResolvedDeploymentNode =
  | { kind: 'no_node' }
  | {
      kind: 'unavailable';
      nodeId: string;
      reason: 'node_not_running' | 'node_not_found';
      lastMetrics: string | null;
    }
  | { kind: 'ready'; nodeId: string; lastMetrics: string | null };

async function resolveDeploymentNode(
  db: DeploymentDb,
  projectId: string,
  envId: string
): Promise<ResolvedDeploymentNode> {
  const envRows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  const environment = envRows[0];
  if (!environment) {
    throw errors.notFound('Deployment environment');
  }

  if (!environment.nodeId) {
    return { kind: 'no_node' };
  }

  const nodeRows = await db
    .select({
      id: schema.nodes.id,
      status: schema.nodes.status,
      lastMetrics: schema.nodes.lastMetrics,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, environment.nodeId))
    .limit(1);

  const node = nodeRows[0];
  if (!node || node.status !== 'running') {
    return {
      kind: 'unavailable',
      nodeId: environment.nodeId,
      reason: node ? 'node_not_running' : 'node_not_found',
      lastMetrics: node ? node.lastMetrics : null,
    };
  }

  return { kind: 'ready', nodeId: node.id, lastMetrics: node.lastMetrics };
}

type ReadyDeploymentNode = Extract<ResolvedDeploymentNode, { kind: 'ready' }>;
type NotReadyDeploymentNode = Exclude<ResolvedDeploymentNode, { kind: 'ready' }>;

/**
 * Shared driver for the node-proxy GET routes (logs/containers/metrics). Runs
 * the common ownership + node-resolution preamble, then delegates response
 * shaping to per-route builders. The not-ready, success, and error response
 * bodies differ per route, so each route supplies its own builders; the
 * preamble, error logging, and try/catch wrapping are shared here.
 */
async function handleNodeProxyRoute(
  c: Context<{ Bindings: Env }, '/:projectId/environments/:envId'>,
  event: string,
  builders: {
    notReady: (resolved: NotReadyDeploymentNode) => unknown;
    fetch: (nodeId: string, userId: string) => Promise<unknown>;
    onSuccess: (result: unknown, resolved: ReadyDeploymentNode) => unknown;
    onError: (resolved: ReadyDeploymentNode) => unknown;
  }
): Promise<Response> {
  const projectId = c.req.param('projectId');
  const envId = c.req.param('envId');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'deployment:read');

  const resolved = await resolveDeploymentNode(db, projectId, envId);
  if (resolved.kind !== 'ready') {
    return c.json(builders.notReady(resolved));
  }

  try {
    const result = await builders.fetch(resolved.nodeId, userId);
    return c.json(builders.onSuccess(result, resolved));
  } catch (err) {
    log.warn(event, {
      projectId,
      envId,
      nodeId: resolved.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(builders.onError(resolved));
  }
}

export function registerDeploymentEnvironmentObservabilityRoutes(
  deploymentEnvironmentRoutes: Hono<{ Bindings: Env }>
): void {
  /**
   * GET /api/projects/:projectId/environments/:envId/logs
   * Read deployment-node logs via the existing node-agent log proxy.
   */
  deploymentEnvironmentRoutes.get(
    '/:projectId/environments/:envId/logs',
    requireAuth(),
    requireApproved(),
    (c) =>
      handleNodeProxyRoute(c, 'deployment_environment.logs_unavailable', {
        notReady: (resolved) => ({
          entries: [],
          nextCursor: null,
          hasMore: false,
          source: 'deployment-node',
          nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
          unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
        }),
        fetch: (nodeId, userId) =>
          getNodeLogsFromNode(nodeId, c.env, userId, new URL(c.req.url).searchParams.toString()),
        onSuccess: (result, resolved) => ({
          ...(typeof result === 'object' && result !== null ? result : { entries: [] }),
          source: 'deployment-node',
          nodeId: resolved.nodeId,
        }),
        onError: (resolved) => ({
          entries: [],
          nextCursor: null,
          hasMore: false,
          source: 'deployment-node',
          nodeId: resolved.nodeId,
          unavailableReason: 'node_agent_unreachable',
        }),
      })
  );

  /**
   * GET /api/projects/:projectId/environments/:envId/containers
   * List deployment-node containers for log filtering.
   */
  deploymentEnvironmentRoutes.get(
    '/:projectId/environments/:envId/containers',
    requireAuth(),
    requireApproved(),
    (c) =>
      handleNodeProxyRoute(c, 'deployment_environment.containers_unavailable', {
        notReady: (resolved) => ({
          containers: [],
          nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
          unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
        }),
        fetch: (nodeId, userId) => listNodeContainersFromNode(nodeId, c.env, userId),
        onSuccess: (result, resolved) => ({
          ...(typeof result === 'object' && result !== null ? result : { containers: [] }),
          nodeId: resolved.nodeId,
        }),
        onError: (resolved) => ({
          containers: [],
          nodeId: resolved.nodeId,
          unavailableReason: 'node_agent_unreachable',
        }),
      })
  );

  /**
   * GET /api/projects/:projectId/environments/:envId/metrics
   * Read deployment-node system and container metrics.
   */
  deploymentEnvironmentRoutes.get(
    '/:projectId/environments/:envId/metrics',
    requireAuth(),
    requireApproved(),
    (c) =>
      handleNodeProxyRoute(c, 'deployment_environment.metrics_unavailable', {
        notReady: (resolved) => ({
          systemInfo: null,
          nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
          fallbackMetrics:
            resolved.kind === 'unavailable' ? parseLastMetrics(resolved.lastMetrics) : null,
          unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
        }),
        fetch: (nodeId, userId) => getNodeSystemInfoFromNode(nodeId, c.env, userId),
        onSuccess: (result, resolved) => ({
          systemInfo: result,
          nodeId: resolved.nodeId,
          fallbackMetrics: parseLastMetrics(resolved.lastMetrics),
        }),
        onError: (resolved) => ({
          systemInfo: null,
          nodeId: resolved.nodeId,
          fallbackMetrics: parseLastMetrics(resolved.lastMetrics),
          unavailableReason: 'node_agent_unreachable',
        }),
      })
  );
}
