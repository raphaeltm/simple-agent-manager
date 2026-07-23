export { AdminLogs } from '../../src/durable-objects/admin-logs';
export { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';
export { ProjectAgent } from '../../src/durable-objects/project-agent';
export { ProjectData } from '../../src/durable-objects/project-data';
export { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
export { SamSession } from '../../src/durable-objects/sam-session';
export { TaskRunner } from '../../src/durable-objects/task-runner';
export { TrialCounter } from '../../src/durable-objects/trial-counter';
export { TrialEventBus } from '../../src/durable-objects/trial-event-bus';
export { TrialOrchestrator } from '../../src/durable-objects/trial-orchestrator';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from '../../src/env';
import { resolveCredentialedCorsOrigin } from '../../src/lib/cors-origin';
import { AppError } from '../../src/middleware/error';
import { adminCcBackfillRoutes } from '../../src/routes/admin-cc-backfill';
import { aiProxyAnthropicRoutes } from '../../src/routes/ai-proxy-anthropic';
import { ccRoutes } from '../../src/routes/composable-credentials';
import { credentialsRoutes } from '../../src/routes/credentials';
import { deployReleaseCallbackRoute } from '../../src/routes/deploy-release-callback';
import { deploymentEnvironmentConfigRoutes } from '../../src/routes/deployment-environment-config';
import { deploymentEnvironmentRoutes } from '../../src/routes/deployment-environments';
import { deploymentReleaseEventsCallbackRoute } from '../../src/routes/deployment-release-events-callback';
import { deploymentReleaseRoutes } from '../../src/routes/deployment-releases';
import { deploymentSecretRoutes } from '../../src/routes/deployment-secrets';
import { deploymentVolumeRoutes } from '../../src/routes/deployment-volumes';
import { mcpRoutes } from '../../src/routes/mcp';
import { nodeLifecycleRoutes } from '../../src/routes/node-lifecycle';
import { nodesRoutes } from '../../src/routes/nodes';
import { projectDeploymentRoutes } from '../../src/routes/project-deployment';
import { projectsRoutes } from '../../src/routes/projects';
import { nodeAcpHeartbeatRoute } from '../../src/routes/projects/node-acp-heartbeat';
import { resolutionStatusRoute } from '../../src/routes/resolution-status';
import { terminalRoutes } from '../../src/routes/terminal';
import { trialRoutes } from '../../src/routes/trial';
import { trialOnboardingRoutes } from '../../src/routes/trial/index';
import { workspacesRoutes } from '../../src/routes/workspaces';

const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  if (error instanceof AppError) return c.json(error.toJSON(), error.statusCode as never);
  return c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
});
app.use(
  '*',
  cors({
    origin: (origin, c) => resolveCredentialedCorsOrigin(origin, c.env?.BASE_DOMAIN),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.get('/health', (c) => {
  const healthy = !!(
    c.env.DATABASE &&
    c.env.KV &&
    c.env.PROJECT_DATA &&
    c.env.NODE_LIFECYCLE &&
    c.env.TASK_RUNNER
  );
  return c.json(
    { status: healthy ? 'healthy' : 'degraded', timestamp: new Date().toISOString() },
    healthy ? 200 : 503
  );
});
app.route('/api/credentials', resolutionStatusRoute);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/cc', ccRoutes);
app.route('/api/admin/cc-backfill', adminCcBackfillRoutes);
app.route('/api/nodes', deployReleaseCallbackRoute);
app.route('/api/nodes', deploymentReleaseEventsCallbackRoute);
app.route('/api/nodes', nodesRoutes);
app.route('/api/nodes', nodeLifecycleRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', projectsRoutes);
app.route('/api/projects', projectDeploymentRoutes);
app.route('/api/projects', deploymentEnvironmentRoutes);
app.route('/api/projects', deploymentEnvironmentConfigRoutes);
app.route('/api/projects', deploymentReleaseRoutes);
app.route('/api/projects', deploymentSecretRoutes);
app.route('/api/projects', deploymentVolumeRoutes);
app.route('/api', trialRoutes);
app.route('/api/trial', trialOnboardingRoutes);
app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
app.route('/mcp', mcpRoutes);
app.notFound((c) => c.json({ error: 'NOT_FOUND', message: 'Endpoint not found' }, 404));

export default { fetch: app.fetch };
